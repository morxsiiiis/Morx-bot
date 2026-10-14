require("dotenv").config();

module.exports = {
  token: process.env.DISCORD_TOKEN,
  clientId: process.env.CLIENT_ID,
  guildId: process.env.GUILD_ID || "1330315556313632929",

  // Canales principales
  channels: {
    images: "1433011417782685706",
    clips: "1330315557043568725",
    counter: "1477233017272668253",
    welcome: "1330315556817207422",
    goodbye: "1330315556817207426",
    social: "1501324495191801946",

    // Pon aquí los ID de tus canales ya creados.
    // El nombre que aparece en Discord no basta para que el bot sepa dónde enviar.
  logs: {
    roles: "1432146794258890942",
    voices: "1457756105752051742",
    messages: "1457758656668897375",
    channels: "1457757268991934474",
    joins: "1457757936746107118",
    leaves: "1457757994900000930",
    bans: "1457757740003754087",
    general: "1330315557370593460",
    invites: "1457757456729112782",
    server: "1457758182477922356",
    sapphire: ""
}
  },

  roles: {
    community: "1330315556313632937",
    moderator: "1484174758361956393"
  },

  counter: {
    // Déjalo en 0 si quieres empezar desde 1.
    startingNumber: 0,
    timeoutMs: 2 * 60 * 1000
  },

  welcome: {
    // Adjunta tus imágenes al bot o pega URL directas cuando las tengas.
    imageUrl: "assets/bienvenidos.png",
    message: "¡Bienvenido/a {user} a **{server}**! 💗"
  },

  goodbye: {
    imageUrl: "assets/adios.png",
    message: "¡{username} ha salido de **{server}**. ¡Te esperamos de vuelta! 💗"
  },

  social: {
    bannerUrl: "assets/redes-sociales.png",
    title: "💗 Redes sociales de Morx",
    description: "Síguenos en nuestras redes:\n\n📸 Instagram: [Añade tu enlace](https://example.com)\n🎵 TikTok: [Añade tu enlace](https://example.com)\n▶️ YouTube: [Añade tu enlace](https://example.com)\n🟢 Kick: [Añade tu enlace](https://example.com)"
  },

  colors: {
    primary: 0xFF69B4,
    dark: 0x171219
  },

  // Evita que el bot modifique roles superiores/iguales a su rol más alto.
  moderation: {
    requireModeratorRole: true
  }
};
