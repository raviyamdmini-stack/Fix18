const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  jidNormalizedUser,
  getContentType,
  fetchLatestBaileysVersion,
  Browsers
} = require('@whiskeysockets/baileys');

const { getBuffer, getGroupAdmins } = require('./lib/functions');
const fs = require('fs');
const P = require('pino');
const config = require('./config');
const axios = require('axios');
const { sms } = require('./lib/msg');
const { File } = require('megajs');
const express = require("express");
const prefix = '.';

const ownerNumber = ['94718461889'];

// =================== SESSION AUTH =========================
if (!fs.existsSync(__dirname + '/auth_info_baileys/creds.json')) {
  if (!config.SESSION_ID) return console.log('Please add your session to SESSION_ID env !!');
  const sessdata = config.SESSION_ID;
  const filer = File.fromURL(`https://mega.nz/file/${sessdata}`);
  filer.download((err, data) => {
    if (err) throw err;
    fs.writeFile(__dirname + '/auth_info_baileys/creds.json', data, () => {
      console.log("Session downloaded ✅");
    });
  });
}

// ================= EXPRESS SERVER ========================
const app = express();
const port = process.env.PORT || 8000;
app.get("/", (req, res) => res.send("Hey, bot started ✅"));
app.listen(port, () => console.log(`Server listening on port http://localhost:${port}`));

// ================= CONNECT TO WA ========================
async function connectToWA() {
  try {
    console.log("Connecting WhatsApp bot 🧬...");
    const { state, saveCreds } = await useMultiFileAuthState(__dirname + '/auth_info_baileys/');
    const { version } = await fetchLatestBaileysVersion();

    const conn = makeWASocket({
      logger: P({ level: 'silent' }),
      printQRInTerminal: false,
      browser: Browsers.macOS("Firefox"),
      syncFullHistory: true,
      auth: state,
      version
    });

    // =============== CONNECTION UPDATE =================
    conn.ev.on('connection.update', (update) => {
      const { connection, lastDisconnect } = update;
      if (connection === 'close') {
        if (lastDisconnect.error.output.statusCode !== DisconnectReason.loggedOut) {
          connectToWA();
        }
      } else if (connection === 'open') {
        console.log('😼 Installing plugins...');
        const path = require('path');
        try {
          fs.readdirSync("./plugins/").forEach((plugin) => {
            if (path.extname(plugin).toLowerCase() === ".js") {
              require("./plugins/" + plugin);
            }
          });
        } catch { console.log("No plugins found or folder missing"); }

        console.log('Plugins installed ✅');
        console.log('Bot connected to WhatsApp ✅');

        let up = `Bot Name connected successfully ✅\n\nPREFIX: ${prefix}`;
        ownerNumber.forEach(number => {
          conn.sendMessage(number + "@s.whatsapp.net", {
            image: { url: 'https://i.ibb.co/bHXBV08/9242c844b83f7bf9.jpg' },
            caption: up
          });
        });
      }
    });

    conn.ev.on('creds.update', saveCreds);

    // =============== MESSAGE UPDATES ===================
    conn.ev.on('messages.upsert', async (mek) => {
      mek = mek.messages[0];
      if (!mek.message) return;

      mek.message = (getContentType(mek.message) === 'ephemeralMessage') ? mek.message.ephemeralMessage.message : mek.message;

      if (mek.key && mek.key.remoteJid === 'status@broadcast' && config.AUTO_READ_STATUS === "true") {
        await conn.readMessages([mek.key]);
      }

      const m = sms(conn, mek);
      const type = getContentType(mek.message);
      const from = mek.key.remoteJid;
      const quoted = type === 'extendedTextMessage' && mek.message.extendedTextMessage.contextInfo != null
        ? mek.message.extendedTextMessage.contextInfo.quotedMessage || []
        : [];
      const body = (type === 'conversation') ? mek.message.conversation
        : (type === 'extendedTextMessage') ? mek.message.extendedTextMessage.text
        : (type === 'imageMessage' && mek.message.imageMessage.caption) ? mek.message.imageMessage.caption
        : (type === 'videoMessage' && mek.message.videoMessage.caption) ? mek.message.videoMessage.caption
        : '';
      const isCmd = body.startsWith(prefix);
      const command = isCmd ? body.slice(prefix.length).trim().split(' ')[0].toLowerCase() : '';
      const args = body.trim().split(/ +/).slice(1);
      const q = args.join(' ');
      const isGroup = from.endsWith('@g.us');
      const sender = mek.key.fromMe ? conn.user.id.split(':')[0] + '@s.whatsapp.net' : (mek.key.participant || mek.key.remoteJid);
      const senderNumber = sender.split('@')[0];
      const botNumber = conn.user.id.split(':')[0];
      const pushname = mek.pushName || 'Sin Nombre';
      const isMe = botNumber.includes(senderNumber);
      const isOwner = ownerNumber.includes(senderNumber) || isMe;
      const botNumber2 = await jidNormalizedUser(conn.user.id);
      const groupMetadata = isGroup ? await conn.groupMetadata(from).catch(() => ({})) : {};
      const groupAdmins = isGroup ? await getGroupAdmins(groupMetadata.participants) : [];
      const isBotAdmins = isGroup ? groupAdmins.includes(botNumber2) : false;
      const isAdmins = isGroup ? groupAdmins.includes(sender) : false;
      const isReact = m.message.reactionMessage ? true : false;

      const reply = (teks) => conn.sendMessage(from, { text: teks }, { quoted: mek });

      // ======= OWNER REACT =======
      if (isOwner && !isReact) m.react("💗");

      // ======= COMMAND HANDLER =======
      const events = require('./command');
      if (isCmd) {
        const cmd = events.commands.find((cmd) => cmd.pattern === command)
          || events.commands.find((cmd) => cmd.alias && cmd.alias.includes(command));
        if (cmd) {
          if (cmd.react) conn.sendMessage(from, { react: { text: cmd.react, key: mek.key } });
          try {
            cmd.function(conn, mek, m, { from, quoted, body, isCmd, command, args, q, isGroup, sender, senderNumber, botNumber2, botNumber, pushname, isMe, isOwner, groupMetadata, groupAdmins, isBotAdmins, isAdmins, reply });
          } catch (e) {
            console.error("[PLUGIN ERROR]", e);
          }
        }
      }

      // ======= EVENTS MAP =======
      events.commands.map(async (command) => {
        if (body && command.on === "body") {
          command.function(conn, mek, m, { from, quoted, body, isCmd, command, args, q, isGroup, sender, senderNumber, botNumber2, botNumber, pushname, isMe, isOwner, groupMetadata, groupAdmins, isBotAdmins, isAdmins, reply });
        } else if (mek.q && command.on === "text") {
          command.function(conn, mek, m, { from, quoted, body, isCmd, command, args, q, isGroup, sender, senderNumber, botNumber2, botNumber, pushname, isMe, isOwner, groupMetadata, groupAdmins, isBotAdmins, isAdmins, reply });
        } else if ((command.on === "image" || command.on === "photo") && mek.type === "imageMessage") {
          command.function(conn, mek, m, { from, quoted, body, isCmd, command, args, q, isGroup, sender, senderNumber, botNumber2, botNumber, pushname, isMe, isOwner, groupMetadata, groupAdmins, isBotAdmins, isAdmins, reply });
        } else if (command.on === "sticker" && mek.type === "stickerMessage") {
          command.function(conn, mek, m, { from, quoted, body, isCmd, command, args, q, isGroup, sender, senderNumber, botNumber2, botNumber, pushname, isMe, isOwner, groupMetadata, groupAdmins, isBotAdmins, isAdmins, reply });
        }
      });
    });

  } catch (err) {
    console.error("Failed to connect WhatsApp bot:", err);
  }
}

// ===== START BOT =====
setTimeout(connectToWA, 4000);
