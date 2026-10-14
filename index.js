const fs = require("node:fs");
const path = require("node:path");
const {
  Client, GatewayIntentBits, Partials, Events, EmbedBuilder,
  PermissionsBitField, AuditLogEvent,
  // Music playback dependencies are installed through package.json.
} = require("discord.js");
const play = require("play-dl");
const {
  joinVoiceChannel, createAudioPlayer, createAudioResource,
  AudioPlayerStatus, VoiceConnectionStatus, entersState,
  NoSubscriberBehavior, StreamType
} = require("@discordjs/voice");
const config = require("./config");

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
let state = { invites: {} };
const musicQueues = new Map();
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
  if (member.permissions.has(PermissionsBitField.Flags.Administrator)) return true;
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



  await sendLog("messages", "💬 Mensaje enviado", `Autor: ${message.author.tag} (${message.author.id})\nCanal: <#${message.channelId}>\nContenido: ${safeText(message.content, 700)}\nAdjuntos: ${message.attachments.size}`);
});

client.on(Events.GuildMemberAdd, async member => {
  const ch = await client.channels.fetch(config.channels.welcome).catch(() => null);
  if (ch?.isTextBased()) {
    const embed = new EmbedBuilder().setColor(config.colors.primary)
      .setDescription(format(config.welcome.message, member, member.guild))
      .setThumbnail(member.user.displayAvatarURL({ size: 256 }));
    if (config.welcome.imageUrl) embed.setImage(config.welcome.imageUrl);
    await ch.send({ embeds: [embed] }).catch(() => {});
  }
  await sendLog("joins", "📥 Miembro nuevo", `${member.user.tag} (${member.id}) se unió al servidor.`);
});
client.on(Events.GuildMemberRemove, async member => {
  const ch = await client.channels.fetch(config.channels.goodbye).catch(() => null);
  if (ch?.isTextBased()) {
    const embed = new EmbedBuilder().setColor(config.colors.primary)
      .setDescription(format(config.goodbye.message, member, member.guild))
      .setThumbnail(member.user.displayAvatarURL({ size: 256 }));
    if (config.goodbye.imageUrl) embed.setImage(config.goodbye.imageUrl);
    await ch.send({ embeds: [embed] }).catch(() => {});
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

async function resolveTracks(input) {
  const isSpotify = /open\.spotify\.com\/(track|album|playlist|episode)/i.test(input);
  if (isSpotify) {
    const sp = await play.spotify(input);
    let items = [];
    if (sp.type === "track") items = [sp];
    else if (typeof sp.all_tracks === "function") items = await sp.all_tracks();
    else if (Array.isArray(sp.tracks)) items = sp.tracks;
    const result = [];
    for (const item of items.slice(0, 50)) {
      const title = item.name || item.title;
      const artists = (item.artists || []).map(a => a.name || a).join(" ");
      if (!title) continue;
      const found = await play.search(`${title} ${artists}`, { limit: 1, source: { youtube: "video" } });
      if (found?.[0]) result.push({ title: found[0].title || `${title} ${artists}`, url: found[0].url });
    }
    return result;
  }
  if (/youtu\.be\/|youtube\.com\//i.test(input)) {
    const info = await play.video_info(input);
    return [{ title: info.video_details.title, url: input }];
  }
  const found = await play.search(input, { limit: 1, source: { youtube: "video" } });
  return found?.[0] ? [{ title: found[0].title, url: found[0].url }] : [];
}
async function playNext(guildId) {
  const music = musicQueues.get(guildId);
  if (!music || music.player.state.status === AudioPlayerStatus.Playing || music.player.state.status === AudioPlayerStatus.Buffering) return;
  const next = music.tracks.shift();
  if (!next) { music.current = null; return; }
  music.current = next;
  try {
    const stream = await play.stream(next.url, { quality: 2 });
    const resource = createAudioResource(stream.stream, { inputType: stream.type });
    music.player.play(resource);
  } catch (err) {
    console.error(`No se pudo reproducir ${next.url}:`, err.message);
    music.current = null;
    setImmediate(() => playNext(guildId));
  }
}

client.on(Events.InteractionCreate, async interaction => {
  if (!interaction.isChatInputCommand()) return;
  const { commandName } = interaction;
  if (commandName === "socialpanel") {
    if (!isModerator(interaction.member)) return interaction.reply({ content: "No tienes permiso para usar este comando.", ephemeral: true });
    const embed = new EmbedBuilder().setColor(config.colors.primary).setTitle(config.social.title).setDescription(config.social.description);
    if (config.social.bannerUrl) embed.setImage(config.social.bannerUrl);
    await interaction.channel.send({ embeds: [embed] });
    return interaction.reply({ content: "Panel de redes sociales publicado. 💗", ephemeral: true });
  }
  // Music commands are available to members, not only moderators.
  if (["play", "skip", "stop", "pause", "resume", "queue"].includes(commandName)) {
    try {
      const guildId = interaction.guildId;
      let music = musicQueues.get(guildId);
      if (commandName === "play") {
        const voiceChannel = interaction.member?.voice?.channel;
        if (!voiceChannel) return interaction.reply({ content: "Entra primero a un canal de voz. 💗", ephemeral: true });
        const input = interaction.options.getString("enlace", true).trim();
        await interaction.deferReply();
        if (!music) {
          const connection = joinVoiceChannel({ channelId: voiceChannel.id, guildId, adapterCreator: interaction.guild.voiceAdapterCreator, selfDeaf: true });
          await entersState(connection, VoiceConnectionStatus.Ready, 20_000);
          const player = createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Pause } });
          connection.subscribe(player);
          music = { connection, player, tracks: [], current: null, textChannel: interaction.channel };
          musicQueues.set(guildId, music);
          connection.on(VoiceConnectionStatus.Disconnected, async () => {
            try { await Promise.race([entersState(connection, VoiceConnectionStatus.Signalling, 5_000), entersState(connection, VoiceConnectionStatus.Connecting, 5_000)]); }
            catch { connection.destroy(); musicQueues.delete(guildId); }
          });
          player.on(AudioPlayerStatus.Idle, () => playNext(guildId));
          player.on("error", err => { console.error("Error de audio:", err.message); playNext(guildId); });
        } else if (music.connection.joinConfig.channelId !== voiceChannel.id) {
          return interaction.editReply("Ya estoy reproduciendo música en otro canal de voz.");
        }
        const tracks = await resolveTracks(input);
        if (!tracks.length) return interaction.editReply("No pude encontrar canciones con ese enlace. Prueba un enlace público de YouTube o Spotify.");
        music.tracks.push(...tracks);
        const msg = `🎶 Añadido a la cola: **${tracks[0].title}**${tracks.length > 1 ? ` y ${tracks.length - 1} canción(es) más` : ""}.`;
        if (music.player.state.status !== AudioPlayerStatus.Playing && music.player.state.status !== AudioPlayerStatus.Buffering) await playNext(guildId);
        return interaction.editReply(msg);
      }
      if (!music) return interaction.reply({ content: "No hay música reproduciéndose ahora mismo.", ephemeral: true });
      if (commandName === "skip") { music.player.stop(true); return interaction.reply("⏭️ Canción saltada."); }
      if (commandName === "stop") { music.tracks = []; music.current = null; music.player.stop(true); music.connection.destroy(); musicQueues.delete(guildId); return interaction.reply("⏹️ Música detenida y cola borrada."); }
      if (commandName === "pause") { music.player.pause(); return interaction.reply("⏸️ Música pausada."); }
      if (commandName === "resume") { music.player.unpause(); return interaction.reply("▶️ Música reanudada."); }
      if (commandName === "queue") {
        const upcoming = music.tracks.slice(0, 10).map((t, i) => `${i + 1}. ${t.title}`).join("\n") || "No hay canciones pendientes.";
        return interaction.reply({ content: `🎶 **Ahora:** ${music.current?.title || "Preparando..."}\n\n**Cola:**\n${upcoming}`, ephemeral: true });
      }
    } catch (err) {
      console.error(`Error en /${commandName}:`, err);
      const msg = `No pude reproducir esa URL. Comprueba que el enlace sea público y que el hosting permita conexiones salientes. (${err.message})`;
      if (interaction.deferred || interaction.replied) return interaction.followUp({ content: msg, ephemeral: true }).catch(() => {});
      return interaction.reply({ content: msg, ephemeral: true }).catch(() => {});
    }
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
      if (role.managed || role.position >= botMember.roles.highest.position || role.position >= interaction.member.roles.highest.position) {
        return interaction.reply({ content: "No puedo gestionar ese rol por permisos o jerarquía.", ephemeral: true });
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
