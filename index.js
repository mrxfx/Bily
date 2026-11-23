"use strict";
/**
 * index.js — WhatsApp AI chatbot (Baileys + Groq).
 * No settings here: everything comes from ./config
 */

const fs = require("fs");
const path = require("path");
const readline = require("readline");
const pino = require("pino");
const baileys = require("@whiskeysockets/baileys");
const config = require("./config");

const makeWASocket = baileys.default || baileys.makeWASocket;
const {
  useMultiFileAuthState,
  DisconnectReason,
  Browsers,
  fetchLatestBaileysVersion,
} = baileys;
const { section, row, header } = config;

// ═════════════════════ STATE ═════════════════════
const startedAt = Date.now();
const SESSION_PATH = path.join(__dirname, config.SESSION_DIR);
const state = { autoReply: !!config.AUTO_REPLY }; // changed by .autoreply
const history = {}; // { chatJid: [{role, content}, ...] }
const lastAsk = new Map(); // sender number -> last AI request time
const sentIds = new Set(); // ids of messages the bot sent (avoid loops)
let sock = null;
let reconnectTimer = null;
let announced = false;

const BUSY = "AI is busy, try again in a moment 🙏";

// ═════════════════════ HELPERS ═════════════════════
const clean = (v) => String(v || "").replace(/\D/g, "");
const numOf = (jid) => String(jid || "").split("@")[0].split(":")[0];
const OWNER = clean(config.OWNER_NUMBER);
const botNumber = () => numOf(sock && sock.user && sock.user.id);
const onOff = () => (state.autoReply ? "ON" : "OFF");

function fmtUptime(ms) {
  let s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400); s %= 86400;
  const h = Math.floor(s / 3600); s %= 3600;
  const m = Math.floor(s / 60); s %= 60;
  return `${d}d ${h}h ${m}m ${s}s`;
}
const uptime = () => fmtUptime(Date.now() - startedAt);

/** Unwrap ephemeral / view-once wrappers */
function unwrap(m) {
  let cur = m;
  for (let i = 0; i < 4 && cur; i++) {
    const inner =
      (cur.ephemeralMessage && cur.ephemeralMessage.message) ||
      (cur.viewOnceMessage && cur.viewOnceMessage.message) ||
      (cur.viewOnceMessageV2 && cur.viewOnceMessageV2.message) ||
      (cur.documentWithCaptionMessage && cur.documentWithCaptionMessage.message);
    if (!inner) break;
    cur = inner;
  }
  return cur || {};
}

function getText(m) {
  const u = unwrap(m);
  return (
    u.conversation ||
    (u.extendedTextMessage && u.extendedTextMessage.text) ||
    (u.imageMessage && u.imageMessage.caption) ||
    (u.videoMessage && u.videoMessage.caption) ||
    ""
  );
}

function getContext(m) {
  const u = unwrap(m);
  for (const v of Object.values(u)) {
    if (v && typeof v === "object" && v.contextInfo) return v.contextInfo;
  }
  return null;
}

/** True when the message is a reply to one of the bot's own messages */
function isReplyToBot(msg) {
  const ci = getContext(msg.message);
  if (!ci) return false;
  if (ci.stanzaId && sentIds.has(ci.stanzaId)) return true;
  const me = botNumber();
  return !!me && numOf(ci.participant) === me;
}

function rememberSent(id) {
  sentIds.add(id);
  if (sentIds.size > 300) sentIds.delete(sentIds.values().next().value);
}

/** Send a message and remember its id */
async function send(jid, content, quoted) {
  const res = await sock.sendMessage(jid, content, quoted ? { quoted } : undefined);
  if (res && res.key && res.key.id) rememberSent(res.key.id);
  return res;
}

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), ms)),
  ]);
}

// ═════════════════════ AI (Groq via proxy) ═════════════════════
async function askGroq(messages) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 20000); // 20 second timeout
  try {
    const res = await fetch(config.GROQ_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.GROQ_API_KEY}`,
      },
      body: JSON.stringify({
        model: config.GROQ_MODEL,
        reasoning_effort: config.REASONING_EFFORT,
        messages,
        max_tokens: 600,
      }),
      signal: ctrl.signal,
    });
    const raw = await res.text();
    if (!res.ok) {
      console.error(`[AI] HTTP ${res.status}: ${raw.slice(0, 500)}`);
      return null;
    }
    let data;
    try {
      data = JSON.parse(raw);
    } catch (e) {
      console.error(`[AI] Invalid JSON (HTTP ${res.status}): ${raw.slice(0, 500)}`);
      return null;
    }
    const answer =
      data && data.choices && data.choices[0] && data.choices[0].message
        ? data.choices[0].message.content
        : "";
    if (!answer || !String(answer).trim()) {
      console.error(`[AI] Empty answer (HTTP ${res.status}): ${raw.slice(0, 500)}`);
      return null;
    }
    return String(answer).trim();
  } catch (e) {
    console.error("[AI] Request failed:", e.name === "AbortError" ? "timeout (20s)" : e.message);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Handles cooldown, history, typing presence and the reply */
async function answerAI(c, question, explicit) {
  question = String(question || "").trim().slice(0, 2000);
  if (!question) return;

  // Per-user cooldown (owner is exempt)
  if (!c.isOwner) {
    const wait = config.COOLDOWN_SECONDS - (Date.now() - (lastAsk.get(c.sender) || 0)) / 1000;
    if (wait > 0) {
      if (explicit) await c.reply(section("⏳", "Cooldown", [row("Wait", `${Math.ceil(wait)}s`)]));
      return;
    }
  }
  if (lastAsk.size > 500) lastAsk.clear();
  lastAsk.set(c.sender, Date.now());

  const past = history[c.jid] || [];
  const messages = [
    { role: "system", content: config.SYSTEM_PROMPT },
    ...past.slice(-config.MAX_HISTORY),
    { role: "user", content: question },
  ];

  // "typing..." while waiting (refreshed every 8 seconds)
  const typing = (p) => sock.sendPresenceUpdate(p, c.jid).catch(() => {});
  typing("composing");
  const timer = setInterval(() => typing("composing"), 8000);
  let answer = null;
  try {
    answer = await askGroq(messages);
  } finally {
    clearInterval(timer);
    typing("paused");
  }

  if (!answer) return c.reply(BUSY);
  if (answer.length > 1500) answer = answer.slice(0, 1500) + "…";

  history[c.jid] = [
    ...past,
    { role: "user", content: question },
    { role: "assistant", content: answer },
  ].slice(-config.MAX_HISTORY);

  return c.reply(answer);
}

// ═════════════════════ MENU ═════════════════════
function infoSection() {
  return section("👑", "Bot Info", [
    row("Owner", config.CREATOR_NAME),
    row("Prefix", config.PREFIX),
    row("Mode", String(config.MODE).toUpperCase()),
    row("AI Reply", onOff()),
    row("Status", "Online 🟢"),
    row("Uptime", uptime()),
  ]);
}

/** Built automatically from the `commands` object */
function buildMenu() {
  const groups = {};
  for (const [name, cmd] of Object.entries(commands)) {
    if (!groups[cmd.cat]) groups[cmd.cat] = [];
    groups[cmd.cat].push(`✦ ${config.PREFIX}${name} : ${cmd.desc}`);
  }
  const sections = Object.entries(groups).map(([cat, lines]) => {
    const title = config.CATEGORIES[cat] || `📦 ${cat}`;
    const icon = title.split(" ")[0];
    return section(icon, title.split(" ").slice(1).join(" ") || cat, lines);
  });
  return { head: header(), info: infoSection(), rest: sections.join("\n\n") };
}

async function sendMenu(c) {
  const { head, info, rest } = buildMenu();
  const full = `${head}\n\n${info}\n\n${rest}`;
  if (config.BOT_IMAGE) {
    try {
      if (full.length <= 1000) {
        await send(c.jid, { image: { url: config.BOT_IMAGE }, caption: full }, c.msg);
      } else {
        // Image captions are short: header on the image, sections as text
        await send(c.jid, { image: { url: config.BOT_IMAGE }, caption: head }, c.msg);
        await send(c.jid, { text: `${info}\n\n${rest}` }, c.msg);
      }
      return;
    } catch (e) {
      console.error("[MENU] Image failed, using text:", e.message);
    }
  }
  await send(c.jid, { text: full }, c.msg); // plain-text fallback
}

// ═════════════════════ COMMANDS ═════════════════════
// To add a command, add one entry: name: { cat, desc, run: async (c) => {...} }
// c = { msg, jid, sender, args, isOwner, isGroup, reply(text) }
const commands = {
  menu: {
    cat: "general",
    desc: "Show this menu",
    run: (c) => sendMenu(c),
  },
  ai: {
    cat: "ai",
    desc: "Ask the AI a question",
    run: async (c) => {
      if (!c.args) {
        return c.reply(
          section("🤖", "Usage", [`✦ ${config.PREFIX}ai <your question>`])
        );
      }
      return answerAI(c, c.args, true);
    },
  },
  reset: {
    cat: "ai",
    desc: "Clear this chat's AI memory",
    run: async (c) => {
      delete history[c.jid];
      return c.reply(section("🧹", "Reset", [row("Memory", "Cleared ✅")]));
    },
  },
  autoreply: {
    cat: "owner",
    desc: "Turn AI auto reply on/off",
    run: async (c) => {
      if (!c.isOwner) {
        return c.reply(section("🚫", "Owner Only", [row("Access", "Denied")]));
      }
      const arg = c.args.toLowerCase();
      if (arg === "on" || arg === "off") {
        state.autoReply = arg === "on";
      } else {
        return c.reply(
          section("🤖", "Auto Reply", [
            row("Now", onOff()),
            `✦ Use: ${config.PREFIX}autoreply on / off`,
          ])
        );
      }
      return c.reply(section("🤖", "Auto Reply", [row("AI Reply", onOff())]));
    },
  },
  about: {
    cat: "general",
    desc: "About this bot",
    run: (c) =>
      c.reply(
        section("ℹ️", "About", [
          row("Bot", config.BOT_NAME),
          row("AI", config.AI_NAME),
          row("Creator", config.CREATOR_NAME),
          row("Info", config.CREATOR_INFO),
          row("Version", config.VERSION),
        ])
      ),
  },
  ping: {
    cat: "general",
    desc: "Check bot speed",
    run: (c) => {
      let ms = Date.now() - Number(c.msg.messageTimestamp) * 1000;
      if (!Number.isFinite(ms) || ms < 0) ms = 0;
      return c.reply(section("🏓", "Pong", [row("Speed", `${ms} ms`)]));
    },
  },
  alive: {
    cat: "general",
    desc: "Check if the bot is online",
    run: (c) =>
      c.reply(
        section("💚", "Alive", [
          row("Bot", config.BOT_NAME),
          row("Status", "Online 🟢"),
          row("Uptime", uptime()),
        ])
      ),
  },
  owner: {
    cat: "general",
    desc: "Contact the owner",
    run: (c) => {
      const lines = [row("Name", config.CREATOR_NAME)];
      if (OWNER) lines.push(row("Contact", `wa.me/${OWNER}`));
      return c.reply(section("👑", "Owner", lines));
    },
  },
  runtime: {
    cat: "general",
    desc: "How long the bot has been running",
    run: (c) => c.reply(section("⏱️", "Runtime", [row("Uptime", uptime())])),
  },
  time: {
    cat: "general",
    desc: "Current date and time",
    run: (c) => {
      const now = new Date();
      let date, time;
      try {
        date = new Intl.DateTimeFormat("en-GB", {
          timeZone: config.TIMEZONE,
          weekday: "long",
          day: "numeric",
          month: "long",
          year: "numeric",
        }).format(now);
        time = new Intl.DateTimeFormat("en-GB", {
          timeZone: config.TIMEZONE,
          hour: "2-digit",
          minute: "2-digit",
          second: "2-digit",
          hour12: true,
        }).format(now);
      } catch (e) {
        date = now.toUTCString();
        time = "UTC";
      }
      return c.reply(
        section("🕒", "Time", [
          row("Date", date),
          row("Time", time),
          row("Zone", config.TIMEZONE),
        ])
      );
    },
  },
};

// ═════════════════════ MESSAGE HANDLER ═════════════════════
async function handleMessage(msg) {
  if (!msg.message) return;
  const jid = msg.key.remoteJid;
  // Ignore status broadcasts, newsletters and other broadcast lists
  if (!jid || jid === "status@broadcast" || jid.endsWith("@newsletter") || jid.endsWith("@broadcast")) return;
  // Ignore the bot's own replies (prevents loops)
  if (msg.key.id && sentIds.has(msg.key.id)) return;

  const text = getText(msg.message).trim();
  if (!text) return;

  const fromMe = !!msg.key.fromMe;
  const isGroup = jid.endsWith("@g.us");
  const me = botNumber();
  const sender = fromMe ? me : numOf(isGroup ? msg.key.participant : jid);
  // Owner = the connected account itself, or OWNER_NUMBER
  const isOwner = fromMe || (!!me && sender === me) || (!!OWNER && sender === OWNER);

  // PRIVATE mode = owner only
  if (String(config.MODE).toUpperCase() === "PRIVATE" && !isOwner) return;

  const c = {
    msg,
    jid,
    sender,
    isOwner,
    isGroup,
    args: "",
    reply: (t) => send(jid, { text: t }, msg),
  };

  // 1) Commands
  if (text.startsWith(config.PREFIX)) {
    const m = text.slice(config.PREFIX.length).match(/^(\S+)\s*([\s\S]*)$/);
    if (!m) return;
    const cmd = commands[m[1].toLowerCase()];
    if (!cmd) return; // unknown command: stay silent
    c.args = m[2].trim();
    await cmd.run(c);
    return;
  }

  // 2) Auto reply (never to the connected account's own plain messages)
  if (fromMe || !state.autoReply) return;
  // In groups: only when someone replies to one of the bot's messages
  if (isGroup && !isReplyToBot(msg)) return;
  await answerAI(c, text, false);
}

// ═════════════════════ CONNECTION ═════════════════════
function scheduleStart(ms) {
  if (reconnectTimer) return; // one pending restart at a time
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    start().catch((e) => {
      console.error("[START] Failed:", e && e.message ? e.message : e);
      scheduleStart(5000);
    });
  }, ms);
}

function endSocket(s, why) {
  try {
    s.end(new Error(why || "restart"));
  } catch (e) {
    /* ignore */
  }
}

/** Fallback only when PAIR_NUMBER is empty */
function askNumber() {
  return new Promise((resolve) => {
    let done = false;
    let timer = null;
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const finish = (v) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { rl.close(); } catch (e) { /* ignore */ }
      resolve(v);
    };
    timer = setTimeout(() => finish(null), 60000);
    rl.on("close", () => finish(null));
    rl.question("Enter the WhatsApp number to link (country code, no + or spaces): ", (ans) =>
      finish(clean(ans) || null)
    );
  });
}

/** Ask WhatsApp for a pairing code ~3 seconds after the socket is created */
function requestPairing(s, authState) {
  setTimeout(async () => {
    if (s !== sock || authState.creds.registered) return;
    try {
      let number = clean(config.PAIR_NUMBER);
      if (!number) {
        number = await askNumber();
        if (!number) {
          console.log("[PAIR] No number received. Set PAIR_NUMBER in config.js. Retrying in 15 seconds...");
          scheduleStart(15000);
          endSocket(s, "no pair number");
          return;
        }
      }
      const raw = await s.requestPairingCode(number);
      const code = String(raw).match(/.{1,4}/g).join("-");
      console.log("\n╭─────────────────────────────╮");
      console.log(`   PAIRING CODE:  ${code}`);
      console.log("╰─────────────────────────────╯");
      console.log("1. Open WhatsApp on the phone you want to link");
      console.log("2. Tap Settings > Linked devices > Link a device");
      console.log("3. Tap \"Link with phone number instead\"");
      console.log(`4. Type the code ${code}\n`);
    } catch (e) {
      console.error("[PAIR] Could not get a pairing code:", e.message);
      endSocket(s, "pairing failed"); // closes the socket, so it retries
    }
  }, 3000);
}

async function announceOwner() {
  if (announced) return;
  announced = true;
  if (!OWNER) return;
  try {
    await send(
      `${OWNER}@s.whatsapp.net`,
      {
        text: section("✅", "Connected", [
          row("Bot", config.BOT_NAME),
          row("Status", "Online 🟢"),
          row("Prefix", config.PREFIX),
          row("Mode", String(config.MODE).toUpperCase()),
          row("AI Reply", onOff()),
        ]),
      }
    );
  } catch (e) {
    console.error("[OWNER] Could not send the connected message:", e.message);
  }
}

async function start() {
  const { state: authState, saveCreds } = await useMultiFileAuthState(SESSION_PATH);

  // Latest WhatsApp Web version (falls back to Baileys' built-in one)
  let version;
  try {
    ({ version } = await withTimeout(fetchLatestBaileysVersion(), 5000));
  } catch (e) {
    version = undefined;
  }

  const s = makeWASocket({
    ...(version ? { version } : {}),
    auth: authState,
    logger: pino({ level: "silent" }),
    browser: Browsers.ubuntu("Chrome"),
    syncFullHistory: false,
    markOnlineOnConnect: false,
    generateHighQualityLinkPreview: false,
    getMessage: async () => undefined, // no message store (saves RAM)
    shouldIgnoreJid: (j) => j === "status@broadcast" || String(j).endsWith("@newsletter"),
  });
  sock = s;

  s.ev.on("creds.update", saveCreds);

  s.ev.on("connection.update", (u) => {
    if (s !== sock) return; // ignore events from an old socket
    const { connection, lastDisconnect } = u;

    if (connection === "open") {
      console.log("[BOT] Connected ✅");
      announceOwner();
    }

    if (connection === "close") {
      const code =
        lastDisconnect && lastDisconnect.error && lastDisconnect.error.output
          ? lastDisconnect.error.output.statusCode
          : undefined;
      console.log(`[BOT] Connection closed (code: ${code === undefined ? "none" : code})`);

      if (code === DisconnectReason.loggedOut) {
        // Logged out from the phone: wipe the session and pair again
        console.log("[BOT] Logged out. Deleting session and pairing again...");
        try {
          fs.rmSync(SESSION_PATH, { recursive: true, force: true });
        } catch (e) {
          console.error("[BOT] Could not delete session:", e.message);
        }
        announced = false;
        scheduleStart(2000);
      } else {
        scheduleStart(code === DisconnectReason.restartRequired ? 500 : 3000);
      }
    }
  });

  s.ev.on("messages.upsert", async ({ messages, type }) => {
    if (type !== "notify") return;
    for (const msg of messages) {
      try {
        await handleMessage(msg);
      } catch (e) {
        console.error("[MSG] Error:", e && e.message ? e.message : e);
      }
    }
  });

  if (!authState.creds.registered) requestPairing(s, authState);
}

// ═════════════════════ NEVER GO OFFLINE ═════════════════════
process.on("uncaughtException", (e) => console.error("[uncaughtException]", e));
process.on("unhandledRejection", (e) => console.error("[unhandledRejection]", e));
setInterval(() => {}, 60 * 1000); // keep-alive

if (!config.GROQ_API_KEY) {
  console.error("[CONFIG] GROQ_API_KEY is empty in config.js. The AI will not answer until you add it.");
}

start().catch((e) => {
  console.error("[START] Failed:", e && e.message ? e.message : e);
  scheduleStart(5000);
});
