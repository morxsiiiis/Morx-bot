const fs = require("node:fs");
const path = require("node:path");
const {
  Client, GatewayIntentBits, Partials, Events, EmbedBuilder,
  ActionRowBuilder, ButtonBuilder, ButtonStyle, PermissionsBitField, AuditLogEvent
} = require("discord.js");
const config = require("./config");
const { joinVoiceChannel, createAudioPlayer, createAudioResource, AudioPlayerStatus, VoiceConnectionStatus, entersState, NoSubscriberBehavior, StreamType } = require("@discordjs/voice");
const play = require("play-dl");

// Estado de radio por servidor: una radio activa por guild.
const radioSessions = new Map();
async function createRadioResource(url) {
  // play-dl permite URLs compatibles (por ejemplo, streams de audio y enlaces admitidos).
  const stream = await play.stream(url, { quality: 2 });
  return createAudioResource(stream.stream, { inputType: stream.type, inlineVolume: true });
}
async function startRadio(guild, voiceChannel, url, textChannel) {
  let session = radioSessions.get(guild.id);
  if (session) {
    session.url = url;
    session.voiceChannel = voiceChannel;
    session.textChannel = textChannel;
  } else {
    const player = createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Play } });
    const connection = joinVoiceChannel({
      channelId: voiceChannel.id,
      guildId: guild.id,
      adapterCreator: guild.voiceAdapterCreator,
      selfDeaf: false
    });
    session = { player, connection, url, voiceChannel, textChannel, restarting: false };
    radioSessions.set(guild.id, session);
    connection.subscribe(player);
    connection.on(VoiceConnectionStatus.Disconnected, async () => {
      try {
        await Promise.race([
          entersState(connection, VoiceConnectionStatus.Signalling, 5_000),
          entersState(connection, VoiceConnectionStatus.Connecting, 5_000)
        ]);
      } catch {
        try { connection.destroy(); } catch {}
        if (radioSessions.get(guild.id) === session) radioSessions.delete(guild.id);
      }
    });
    player.on("error", err => {
      console.error(`[RADIO] Error en ${guild.name}:`, err.message);
      restartRadio(guild.id).catch(e => console.error("[RADIO] No se pudo reiniciar:", e.message));
    });
    player.on(AudioPlayerStatus.Idle, () => {
      restartRadio(guild.id).catch(e => console.error("[RADIO] No se pudo reiniciar:", e.message));
    });
  }
  const resource = await createRadioResource(url);
  session.player.play(resource);
  return session;
}
async function restartRadio(guildId) {
  const session = radioSessions.get(guildId);
  if (!session || session.restarting) return;
  session.restarting = true;
  try {
    await new Promise(resolve => setTimeout(resolve, 1500));
    if (radioSessions.get(guildId) !== session) return;
    const resource = await createRadioResource(session.url);
    session.player.play(resource);
  } catch (e) {
    console.error("[RADIO] Error al reconectar el stream:", e.message);
  } finally {
    session.restarting = false;
  }
}

if (!config.token) {
  console.error("Falta DISCORD_TOKEN. Copia .env.example a .env y pega el token.");
  process.exit(1);
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildModeration,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildInvites,
    GatewayIntentBits.GuildMessageReactions
  ],
  partials: [Partials.Message, Partials.Channel, Partials.GuildMember, Partials.User]
});

const dataDir = path.join(__dirname, "data");
const statePath = path.join(dataDir, "state.json");
fs.mkdirSync(dataDir, { recursive: true });
let state = { lastCounter: config.counter.startingNumber, savedRoles: {}, invites: {} };
try {
  if (fs.existsSync(statePath)) state = { ...state, ...JSON.parse(fs.readFileSync(statePath, "utf8")) };
} catch (e) { console.error("No se pudo leer data/state.json:", e); }

function saveState() {
  const tmp = statePath + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, statePath);
}
function channelIdForLog(type) { return config.channels.logs[type] || ""; }
async function sendLog(type, title, description, fields = []) {
  const id = channelIdForLog(type) || channelIdForLog("general");
  if (!id) return;
  try {
    const ch = await client.channels.fetch(id);
    if (!ch || !ch.isTextBased()) return;
    const embed = new EmbedBuilder().setColor(config.colors.primary).setTitle(title)
      .setDescription(description || "Sin detalles").addFields(fields.slice(0, 25))
      .setTimestamp();
    await ch.send({ embeds: [embed] });
  } catch (e) { console.error(`No se pudo enviar log ${type}:`, e.message); }
}
function safeText(value, max = 900) { return String(value ?? "").slice(0, max) || "No especificado"; }
function isModerator(member) {
  if (!member) return false;
  // Permite usar el bot a administradores, miembros con Manage Roles,
  // o miembros que tengan el rol moderador configurado.
  if (member.permissions.has(PermissionsBitField.Flags.Administrator) ||
      member.permissions.has(PermissionsBitField.Flags.ManageRoles)) return true;
  return !config.moderation.requireModeratorRole || member.roles.cache.has(config.roles.moderator);
}
function canManageTarget(actor, target, botMember) {
  if (!actor || !target || !botMember) return false;
  if (target.id === actor.id) return false;
  if (target.id === target.guild.ownerId) return false;
  if (target.roles.highest.position >= actor.roles.highest.position && actor.id !== target.guild.ownerId) return false;
  if (target.roles.highest.position >= botMember.roles.highest.position) return false;
  return true;
}
function format(template, member, guild) {
  return template
    .replaceAll("{user}", `<@${member.id}>`)
    .replaceAll("{username}", member.user.username)
    .replaceAll("{server}", guild.name);
}

client.once(Events.ClientReady, async readyClient => {
  console.log(`💗 Morx está online como ${readyClient.user.tag}`);
  // Cache inicial de invitaciones para poder comparar usos posteriores.
  for (const guild of readyClient.guilds.cache.values()) {
    try {
      const invites = await guild.invites.fetch();
      state.invites[guild.id] = Object.fromEntries(invites.map(i => [i.code, i.uses ?? 0]));
    } catch { /* El bot puede no tener Manage Guild; invitaciones quedan limitadas. */ }
  }
  saveState();
});

client.on(Events.MessageCreate, async message => {
  if (!message.guild || message.author.bot) return;
  const ch = message.channelId;

  if (ch === config.channels.images && message.attachments.size) {
    const invalid = message.attachments.filter(a => {
      const type = (a.contentType || "").toLowerCase();
      return type.startsWith("video/") || /\.(mp4|mov|webm|mkv|avi|m4v)$/i.test(a.name || a.url);
    });
    if (invalid.size) {
      await message.delete().catch(() => {});
      const notice = await message.channel.send(`${message.author}, en este canal solo se permiten imágenes. 💗`).catch(() => null);
      if (notice) setTimeout(() => notice.delete().catch(() => {}), 6000);
    }
  }
  if (ch === config.channels.clips && message.attachments.size) {
    const invalid = message.attachments.filter(a => {
      const type = (a.contentType || "").toLowerCase();
      return type.startsWith("image/") || /\.(png|jpe?g|gif|webp|bmp|avif)$/i.test(a.name || a.url);
    });
    if (invalid.size) {
      await message.delete().catch(() => {});
      const notice = await message.channel.send(`${message.author}, en este canal solo se permiten clips o videos. 💗`).catch(() => null);
      if (notice) setTimeout(() => notice.delete().catch(() => {}), 6000);
    }
  }

  if (ch === config.channels.counter) {
    const raw = message.content.trim();
    if (!/^\d+$/.test(raw)) {
      await message.delete().catch(() => {});
      return;
    }
    const expected = Number(state.lastCounter) + 1;
    const actual = Number(raw);
    if (actual !== expected) {
      // Número incorrecto: reinicia el juego automáticamente, sin comando ni sanciones.
      state.lastCounter = 0;
      saveState();
      await message.delete().catch(() => {});
      const notice = await message.channel.send(`${message.author}, número incorrecto. 🔄 ¡El contador vuelve a **1**!`).catch(() => null);
      if (notice) setTimeout(() => notice.delete().catch(() => {}), 8000);
      return;
    }
    state.lastCounter = actual;
    saveState();
    // Marca los números correctos con una flecha.
    await message.react("➡️").catch(() => {});
  }

  await sendLog("messages", "💬 Mensaje enviado", `Autor: ${message.author.tag} (${message.author.id})\nCanal: <#${message.channelId}>\nContenido: ${safeText(message.content, 700)}\nAdjuntos: ${message.attachments.size}`);
});

async function restoreRoles(guild, userId) {
  const saved = state.savedRoles[userId];
  if (!saved || saved.guildId !== guild.id) return;
  const member = await guild.members.fetch(userId).catch(() => null);
  if (!member) { delete state.savedRoles[userId]; saveState(); return; }
  const botMember = guild.members.me;
  const validRoles = saved.roleIds.filter(id => {
    const role = guild.roles.cache.get(id);
    return role && !role.managed && role.position < botMember.roles.highest.position;
  });
  if (validRoles.length) await member.roles.add(validRoles, "Restauración de roles tras el timeout del contador").catch(err => console.error("Error restaurando roles:", err.message));
  delete state.savedRoles[userId];
  saveState();
  await sendLog("roles", "💗 Roles restaurados", `Se restauraron los roles guardados de ${member.user.tag}.`);
}
setInterval(async () => {
  for (const [userId, saved] of Object.entries(state.savedRoles)) {
    if (saved.restoreAt <= Date.now()) {
      const guild = client.guilds.cache.get(saved.guildId);
      if (guild) await restoreRoles(guild, userId);
    }
  }
}, 5000).unref();

client.on(Events.GuildMemberAdd, async member => {
  const ch = await client.channels.fetch(config.channels.welcome).catch(() => null);
  if (ch?.isTextBased()) {
    const embed = new EmbedBuilder().setColor(config.colors.primary)
      .setDescription(format(config.welcome.message, member, member.guild))
      .setThumbnail(member.user.displayAvatarURL({ size: 256 }));
    const welcomeImagePath = path.isAbsolute(config.welcome.imageUrl)
      ? config.welcome.imageUrl : path.join(__dirname, config.welcome.imageUrl);
    if (config.welcome.imageUrl && fs.existsSync(welcomeImagePath)) embed.setImage("attachment://bienvenidos.png");
    await ch.send({
      embeds: [embed],
      files: config.welcome.imageUrl && fs.existsSync(welcomeImagePath)
        ? [{ attachment: welcomeImagePath, name: "bienvenidos.png" }] : []
    }).catch(err => console.error("No se pudo enviar la bienvenida:", err.message));
  }
  await sendLog("joins", "📥 Miembro nuevo", `${member.user.tag} (${member.id}) se unió al servidor.`);
});
client.on(Events.GuildMemberRemove, async member => {
  const ch = await client.channels.fetch(config.channels.goodbye).catch(() => null);
  if (ch?.isTextBased()) {
    const embed = new EmbedBuilder().setColor(config.colors.primary)
      .setDescription(format(config.goodbye.message, member, member.guild))
      .setThumbnail(member.user.displayAvatarURL({ size: 256 }));
    const goodbyeImagePath = path.isAbsolute(config.goodbye.imageUrl)
      ? config.goodbye.imageUrl : path.join(__dirname, config.goodbye.imageUrl);
    if (config.goodbye.imageUrl && fs.existsSync(goodbyeImagePath)) embed.setImage("attachment://adios.png");
    await ch.send({
      embeds: [embed],
      files: config.goodbye.imageUrl && fs.existsSync(goodbyeImagePath)
        ? [{ attachment: goodbyeImagePath, name: "adios.png" }] : []
    }).catch(err => console.error("No se pudo enviar la despedida:", err.message));
  }
  await sendLog("leaves", "📤 Miembro salió", `${member.user.tag} (${member.id}) salió o fue expulsado. Mira los audit logs para distinguirlo.`);
});
client.on(Events.GuildBanAdd, ban => sendLog("bans", "🔨 Usuario baneado", `${ban.user.tag} (${ban.user.id})`));
client.on(Events.GuildBanRemove, ban => sendLog("bans", "🔓 Usuario desbaneado", `${ban.user.tag} (${ban.user.id})`));

client.on(Events.MessageDelete, async message => {
  if (!message.guild) return;
  await sendLog("messages", "🗑️ Mensaje eliminado", `Autor: ${message.author?.tag || "desconocido"}\nCanal: <#${message.channelId}>\nContenido guardado: ${safeText(message.content)}`);
});
client.on(Events.MessageUpdate, async (oldMessage, newMessage) => {
  if (!newMessage.guild || oldMessage.partial || newMessage.partial) return;
  if (oldMessage.content === newMessage.content) return;
  await sendLog("messages", "✏️ Mensaje editado", `Autor: ${newMessage.author?.tag || "desconocido"}\nCanal: <#${newMessage.channelId}>\nAntes: ${safeText(oldMessage.content, 400)}\nDespués: ${safeText(newMessage.content, 400)}`);
});

client.on(Events.GuildMemberUpdate, async (oldMember, newMember) => {
  const before = new Set(oldMember.roles.cache.keys());
  const after = new Set(newMember.roles.cache.keys());
  const added = [...after].filter(id => !before.has(id)).map(id => newMember.guild.roles.cache.get(id)?.name || id);
  const removed = [...before].filter(id => !after.has(id)).map(id => newMember.guild.roles.cache.get(id)?.name || id);
  if (added.length || removed.length) {
    await sendLog("roles", "🎭 Roles modificados", `Miembro: ${newMember.user.tag}\nAñadidos: ${added.join(", ") || "ninguno"}\nQuitados: ${removed.join(", ") || "ninguno"}`);
  }
  if (oldMember.communicationDisabledUntilTimestamp !== newMember.communicationDisabledUntilTimestamp) {
    await sendLog("general", "⏱️ Timeout actualizado", `${newMember.user.tag}: ${newMember.communicationDisabledUntil ? "timeout activo" : "timeout retirado"}`);
  }
});

client.on(Events.VoiceStateUpdate, async (oldState, newState) => {
  const member = newState.member || oldState.member;
  const from = oldState.channel;
  const to = newState.channel;
  if (from?.id === to?.id) return;
  await sendLog("voices", "🔊 Movimiento de voz",
    `${member?.user.tag || "Miembro"}\nAntes: ${from ? from.name : "fuera de voz"}\nAhora: ${to ? to.name : "fuera de voz"}`);
});

client.on(Events.ChannelCreate, ch => sendLog("channels", "➕ Canal creado", `${ch.name} (${ch.id})`));
client.on(Events.ChannelDelete, ch => sendLog("channels", "➖ Canal eliminado", `${ch.name} (${ch.id})`));
client.on(Events.ChannelUpdate, (oldCh, newCh) => sendLog("channels", "✏️ Canal actualizado", `${oldCh.name} → ${newCh.name} (${newCh.id})`));
client.on(Events.RoleCreate, role => sendLog("roles", "➕ Rol creado", `${role.name} (${role.id})`));
client.on(Events.RoleDelete, role => sendLog("roles", "➖ Rol eliminado", `${role.name} (${role.id})`));
client.on(Events.RoleUpdate, (oldRole, newRole) => sendLog("roles", "✏️ Rol actualizado", `${oldRole.name} → ${newRole.name} (${newRole.id})`));
client.on(Events.GuildUpdate, (oldGuild, newGuild) => sendLog("server", "⚙️ Servidor actualizado", `Nombre: ${oldGuild.name} → ${newGuild.name}`));

client.on(Events.InviteCreate, async invite => {
  await sendLog("invites", "🔗 Invitación creada", `Código: ${invite.code}\nCreador: ${invite.inviter?.tag || "desconocido"}\nCanal: ${invite.channel || "desconocido"}`);
  try {
    const invites = await invite.guild.invites.fetch();
    state.invites[invite.guild.id] = Object.fromEntries(invites.map(i => [i.code, i.uses ?? 0]));
    saveState();
  } catch {}
});
client.on(Events.GuildMemberAdd, async member => {
  try {
    const invites = await member.guild.invites.fetch();
    const current = Object.fromEntries(invites.map(i => [i.code, i.uses ?? 0]));
    const previous = state.invites[member.guild.id] || {};
    const used = invites.find(i => (i.uses ?? 0) > (previous[i.code] ?? 0));
    await sendLog("invites", "🧭 Invitación utilizada", `${member.user.tag} se unió. Invitación: ${used?.code || "no identificada"}; creador: ${used?.inviter?.tag || "no identificado"}`);
    state.invites[member.guild.id] = current;
    saveState();
  } catch {
    await sendLog("invites", "🧭 Miembro nuevo", `${member.user.tag} se unió; no se pudo identificar la invitación (permisos o invitación personalizada).`);
  }
});

client.on(Events.InteractionCreate, async interaction => {
  if (!interaction.isChatInputCommand()) return;
  const { commandName } = interaction;
  if (["radio", "radio-stop", "radio-status"].includes(commandName)) {
    if (!interaction.guild) return interaction.reply({ content: "Este comando solo funciona dentro de un servidor.", ephemeral: true });
    if (commandName === "radio-status") {
      const session = radioSessions.get(interaction.guild.id);
      return interaction.reply({ content: session ? `📻 Morx está reproduciendo radio en **${session.voiceChannel.name}**.` : "📻 No hay ninguna radio activa en este servidor.", ephemeral: true });
    }
    if (commandName === "radio-stop") {
      const session = radioSessions.get(interaction.guild.id);
      if (!session) return interaction.reply({ content: "No hay ninguna radio activa.", ephemeral: true });
      radioSessions.delete(interaction.guild.id);
      try { session.player.stop(true); } catch {}
      try { session.connection.destroy(); } catch {}
      return interaction.reply({ content: "⏹️ Radio detenida; Morx salió del canal de voz.", ephemeral: true });
    }
    const voiceChannel = interaction.member?.voice?.channel;
    if (!voiceChannel) return interaction.reply({ content: "Entra primero al canal de voz donde quieres que Morx se conecte.", ephemeral: true });
    const me = interaction.guild.members.me;
    const perms = voiceChannel.permissionsFor(me);
    if (!perms?.has(PermissionsBitField.Flags.Connect) || !perms?.has(PermissionsBitField.Flags.Speak)) {
      return interaction.reply({ content: "Necesito los permisos **Conectar** y **Hablar** en ese canal de voz.", ephemeral: true });
    }
    const url = interaction.options.getString("url", true).trim();
    if (!/^https?:\/\//i.test(url)) return interaction.reply({ content: "Pega una URL completa que empiece por https:// o http://.", ephemeral: true });
    await interaction.deferReply({ ephemeral: true });
    try {
      const session = await startRadio(interaction.guild, voiceChannel, url, interaction.channel);
      return interaction.editReply(`📻 Morx se conectó a **${session.voiceChannel.name}** y comenzó la radio. Usa **/radio-stop** para detenerla.

La reproducción depende de que la URL sea un stream compatible y de que el bot permanezca en línea.`);
    } catch (err) {
      console.error("[RADIO] No se pudo iniciar:", err);
      const session = radioSessions.get(interaction.guild.id);
      if (session && session.voiceChannel?.id === voiceChannel.id && session.player.state.status === AudioPlayerStatus.Idle) {
        // Keep session for diagnosis; no credentials or URL details are posted publicly.
      }
      return interaction.editReply("No pude reproducir esa URL. Prueba con el enlace directo de una radio/stream de audio compatible y verifica que el hosting permita conexiones salientes.");
    }
  }
  if (commandName === "socialpanel") {
    if (!isModerator(interaction.member)) return interaction.reply({ content: "No tienes permiso para usar este comando.", ephemeral: true });
    const socialLinks = {
      instagram: config.social?.links?.instagram || "https://www.instagram.com/morxsiiiis?igsh=MXBneHZ4NGJra2Jwcw==",
      tiktok: config.social?.links?.tiktok || "https://www.tiktok.com/@morxsiiis",
      kick: config.social?.links?.kick || "https://kick.com/morxsiiis"
    };
    // Generar el texto directamente con las URLs actuales evita que reaparezca "Añade tu enlace".
    const socialDescription = [
      "Sígueme en mis redes oficiales:",
      `📸 **Instagram:** [@morxsiiiis](${socialLinks.instagram})`,
      `🎵 **TikTok:** [@morxsiiis](${socialLinks.tiktok})`,
      `🟢 **Kick:** [morxsiiis](${socialLinks.kick})`
    ].join("\n");
    const embed = new EmbedBuilder().setColor(config.colors.primary).setTitle(config.social.title).setDescription(socialDescription);
    const socialImagePath = path.isAbsolute(config.social.bannerUrl)
      ? config.social.bannerUrl : path.join(__dirname, config.social.bannerUrl);
    if (config.social.bannerUrl && fs.existsSync(socialImagePath)) embed.setImage("attachment://redes-sociales.png");
    const socialButtons = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setLabel("Instagram").setStyle(ButtonStyle.Link).setURL(socialLinks.instagram),
      new ButtonBuilder().setLabel("TikTok").setStyle(ButtonStyle.Link).setURL(socialLinks.tiktok),
      new ButtonBuilder().setLabel("Kick").setStyle(ButtonStyle.Link).setURL(socialLinks.kick)
    );
    await interaction.channel.send({
      embeds: [embed],
      components: [socialButtons],
      files: config.social.bannerUrl && fs.existsSync(socialImagePath)
        ? [{ attachment: socialImagePath, name: "redes-sociales.png" }] : []
    });
    return interaction.reply({ content: "Panel de redes sociales publicado. 💗", ephemeral: true });
  }
  if (!isModerator(interaction.member)) return interaction.reply({ content: "No tienes permiso para usar comandos de moderación.", ephemeral: true });

  const targetUser = interaction.options.getUser("miembro");
  const target = targetUser ? await interaction.guild.members.fetch(targetUser.id).catch(() => null) : null;
  const reason = interaction.options.getString("razon") || `Acción realizada por ${interaction.user.tag}`;
  const botMember = interaction.guild.members.me;

  try {
    if (["kick", "ban", "timeout", "untimeout", "role"].includes(commandName)) {
      if (!target) return interaction.reply({ content: "No encontré a ese miembro en el servidor.", ephemeral: true });
      if (!canManageTarget(interaction.member, target, botMember)) {
        return interaction.reply({ content: "No puedo actuar sobre ese miembro por la jerarquía de roles.", ephemeral: true });
      }
    }
    if (commandName === "kick") {
      await target.kick(reason);
      await sendLog("bans", "👢 Miembro expulsado", `${target.user.tag}\nModerador: ${interaction.user.tag}\nMotivo: ${reason}`);
      return interaction.reply({ content: `👢 ${target.user.tag} fue expulsado.`, ephemeral: true });
    }
    if (commandName === "ban") {
      await target.ban({ reason });
      await sendLog("bans", "🔨 Miembro baneado", `${target.user.tag}\nModerador: ${interaction.user.tag}\nMotivo: ${reason}`);
      return interaction.reply({ content: `🔨 ${target.user.tag} fue baneado.`, ephemeral: true });
    }
    if (commandName === "unban") {
      const id = interaction.options.getString("usuario_id");
      await interaction.guild.members.unban(id, reason);
      await sendLog("bans", "🔓 Usuario desbaneado", `${id}\nModerador: ${interaction.user.tag}\nMotivo: ${reason}`);
      return interaction.reply({ content: `🔓 Usuario ${id} desbaneado.`, ephemeral: true });
    }
    if (commandName === "timeout") {
      const minutes = interaction.options.getInteger("minutos");
      await target.timeout(minutes * 60_000, reason);
      await sendLog("general", "⏱️ Timeout aplicado", `${target.user.tag}\nDuración: ${minutes} minutos\nModerador: ${interaction.user.tag}\nMotivo: ${reason}`);
      return interaction.reply({ content: `⏱️ Timeout aplicado a ${target.user.tag} por ${minutes} minutos.`, ephemeral: true });
    }
    if (commandName === "untimeout") {
      await target.timeout(null, reason);
      await sendLog("general", "⏱️ Timeout retirado", `${target.user.tag}\nModerador: ${interaction.user.tag}\nMotivo: ${reason}`);
      return interaction.reply({ content: `Se retiró el timeout de ${target.user.tag}.`, ephemeral: true });
    }
    if (commandName === "role") {
      const role = interaction.options.getRole("rol");
      const action = interaction.options.getString("accion");
      if (!botMember.permissions.has(PermissionsBitField.Flags.ManageRoles)) {
        return interaction.reply({ content: "Me falta el permiso **Gestionar roles**. Actívalo en mi rol del servidor.", ephemeral: true });
      }
      if (role.managed || role.position >= botMember.roles.highest.position) {
        return interaction.reply({ content: "No puedo gestionar ese rol: mueve el rol de Morx por encima del rol que quieres asignar.", ephemeral: true });
      }
      if (role.position >= interaction.member.roles.highest.position && interaction.user.id !== interaction.guild.ownerId) {
        return interaction.reply({ content: "Tu rol más alto debe estar por encima del rol que quieres administrar.", ephemeral: true });
      }
      if (role.id === config.roles.community && action === "remove") {
        return interaction.reply({ content: "El rol normal de comunidad está protegido.", ephemeral: true });
      }
      if (action === "add") await target.roles.add(role);
      else await target.roles.remove(role);
      await sendLog("roles", "🎭 Rol gestionado por comando", `${interaction.user.tag} ${action === "add" ? "añadió" : "quitó"} ${role.name} a ${target.user.tag}`);
      return interaction.reply({ content: `Rol ${action === "add" ? "añadido a" : "quitado de"} ${target.user.tag}.`, ephemeral: true });
    }
    if (commandName === "userinfo") {
      const user = targetUser || interaction.user;
      const memberInfo = target || await interaction.guild.members.fetch(user.id).catch(() => null);
      const embed = new EmbedBuilder().setColor(config.colors.primary).setTitle(`Información de ${user.tag}`)
        .setThumbnail(user.displayAvatarURL({ size: 256 }))
        .addFields(
          { name: "ID", value: user.id, inline: true },
          { name: "Cuenta creada", value: `<t:${Math.floor(user.createdTimestamp / 1000)}:F>`, inline: true },
          { name: "Entró al servidor", value: memberInfo?.joinedTimestamp ? `<t:${Math.floor(memberInfo.joinedTimestamp / 1000)}:F>` : "No disponible", inline: true },
          { name: "Roles", value: memberInfo ? safeText(memberInfo.roles.cache.filter(r => r.id !== interaction.guild.id).map(r => r.name).join(", "), 900) : "No disponible" }
        );
      return interaction.reply({ embeds: [embed], ephemeral: true });
    }
  } catch (err) {
    console.error(`Error en /${commandName}:`, err);
    const payload = { content: `No se pudo ejecutar el comando: ${err.message}`, ephemeral: true };
    if (interaction.replied || interaction.deferred) return interaction.followUp(payload).catch(() => {});
    return interaction.reply(payload).catch(() => {});
  }
});

client.on("error", console.error);
process.on("unhandledRejection", err => console.error("Unhandled rejection:", err));
client.login(config.token);
