MORX — BOT DE COMUNIDAD DISCORD
================================

IMPORTANTE
- No compartas tu token de Discord. Si se expone, resetealo en Discord Developer Portal.
- El bot usa Discord.js v14 y Node.js 20 o superior.
- Los canales de logs ya existen, pero necesitas poner sus IDs reales en config.js.
  El nombre de un canal no basta para enviar logs a él.
- La bienvenida/despedida y el banner social se personalizan en config.js.

INSTALACIÓN EN WINDOWS
1. Instala Node.js LTS desde https://nodejs.org/
2. Extrae esta carpeta, por ejemplo en Escritorio\Morx-Bot.
3. Entra en la carpeta, copia .env.example y renombra la copia a .env.
4. Abre .env y añade:
   DISCORD_TOKEN=TOKEN_PRIVADO_DEL_BOT
   CLIENT_ID=ID_DE_LA_APLICACION
   GUILD_ID=1330315556313632929
5. Abre CMD dentro de la carpeta y ejecuta:
   npm install
   npm run deploy
   npm start

CONFIGURACIÓN DE DISCORD DEVELOPER PORTAL
- Activa Server Members Intent.
- Activa Message Content Intent.
- Añade el bot al servidor con permisos adecuados.
- Permisos recomendados: View Channels, Send Messages, Embed Links, Read Message History,
  Manage Messages, Moderate Members, Manage Roles, Kick Members, Ban Members, View Audit Log,
  Manage Guild (para funciones de invitaciones).
- Pon el rol de Morx por encima de los roles que deba administrar, pero no por encima del dueño.
- Nunca des permisos que no necesite si puedes evitarlo.

CONFIGURAR LOS LOGS
En config.js rellena channels.logs con los IDs:
roles, voices, messages, channels, joins, leaves, bans, general, invites, server, sapphire.
Si prefieres un solo canal para todos los logs, coloca el mismo ID en general; las categorías
sin ID usarán general como destino alternativo.
El código no adivina los IDs de la captura; cópialos con clic derecho > Copiar ID.

PERSONALIZAR BIENVENIDA, DESPEDIDA Y REDES
En config.js edita:
welcome.message, welcome.imageUrl
goodbye.message, goodbye.imageUrl
social.title, social.description, social.bannerUrl
Puedes usar {user}, {username} y {server} en los mensajes.
Después reinicia el bot. Para publicar el panel de redes usa /socialpanel.
Para ajustar el contador, usa /setcounter numero:<último número correcto>.

CONTADOR Y RESTAURACIÓN DE ROLES
- El bot guarda el estado en data/state.json.
- No borres esa carpeta mientras existan restauraciones pendientes.
- La restauración sobrevive a reinicios normales.
- Discord no permite gestionar roles administrados por integraciones ni roles iguales/superiores
  al rol del bot. Esos roles no pueden ser retirados/restaurados por el bot.
- El bot conserva siempre el rol de comunidad configurado.
- Asegúrate de que el bot tenga Manage Roles y Moderate Members.

LIMITACIONES IMPORTANTES
- Discord no siempre informa de forma exacta qué invitación fue usada; depende de permisos,
  invitaciones temporales y eventos concurrentes.
- Para que el registro de mensajes funcione, activa Message Content Intent.
- Los logs de auditoría pueden requerir View Audit Log para identificar quién realizó cambios.
- Los archivos adjuntos de fotos/videos se clasifican por MIME y extensión; algunos enlaces
  externos o archivos sin extensión pueden necesitar ajustes.
- Los comandos se registran como comandos de servidor para que aparezcan más rápido.

SOLUCIÓN DE PROBLEMAS
- Si no aparecen comandos: revisa CLIENT_ID/GUILD_ID y vuelve a ejecutar npm run deploy.
- Si el bot está online pero no borra archivos: revisa Manage Messages y los intents.
- Si no restaura roles: revisa Manage Roles y jerarquía del bot.
- Si no manda logs: comprueba que los IDs en config.js sean correctos y que pueda ver/escribir
  en esos canales.


IMÁGENES YA CONFIGURADAS
- assets/bienvenidos.png: imagen enviada al entrar un miembro.
- assets/adios.png: imagen enviada cuando un miembro sale.
- assets/redes-sociales.png: banner adjunto al comando /socialpanel.
Las imágenes se adjuntan desde la carpeta assets; no necesitas subirlas a una web.
