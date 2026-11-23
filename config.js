"use strict";
/**
 * config.js — ALL settings live here. Edit only the ✏️ lines.
 * (CommonJS: index.js loads this file with require("./config"))
 */

const config = {
  // ══════════ ✏️ EDIT THESE ══════════
  BOT_NAME: "MyBot", // ✏️ your bot name
  AI_NAME: "CodeBuddy", // ✏️ the AI's name
  CREATOR_NAME: "Your Name", // ✏️ your name or brand
  CREATOR_INFO: "Software developer and ethical hacker", // ✏️ short bio
  OWNER_NUMBER: "", // ✏️ your number, country code, no + or spaces
  PAIR_NUMBER: "", // ✏️ number to link, same format
  GROQ_API_KEY: "", // ✏️ free key from console.groq.com
  BOT_IMAGE: "", // ✏️ direct link to your menu image (optional)
  AI_HELPS_WITH:
    "Helping beginners learn programming: explain simply, give small examples, help fix errors step by step.",

  // ══════════ LEAVE THESE AS THEY ARE ══════════
  GROQ_URL: "https://fei-ai.vercel.app/api/groq",
  GROQ_MODEL: "openai/gpt-oss-20b",
  REASONING_EFFORT: "low",
  PREFIX: ".",
  MODE: "PUBLIC", // PUBLIC, or PRIVATE = owner only
  VERSION: "1.0.0",
  TIMEZONE: "Africa/Lagos",
  AUTO_REPLY: true, // starting value (change later with .autoreply on/off)
  MAX_HISTORY: 6,
  COOLDOWN_SECONDS: 5,
  SESSION_DIR: "session", // folder where the WhatsApp login is stored

  // Menu category titles (a command's `cat` picks one of these)
  CATEGORIES: {
    ai: "🤖 AI",
    general: "📌 General",
    owner: "👑 Owner",
  },
};

// ───────────── Small-caps helper ─────────────
const SMALL_CAPS = {
  a: "ᴀ", b: "ʙ", c: "ᴄ", d: "ᴅ", e: "ᴇ", f: "ғ", g: "ɢ", h: "ʜ", i: "ɪ",
  j: "ᴊ", k: "ᴋ", l: "ʟ", m: "ᴍ", n: "ɴ", o: "ᴏ", p: "ᴘ", q: "ǫ", r: "ʀ",
  s: "s", t: "ᴛ", u: "ᴜ", v: "ᴠ", w: "ᴡ", x: "x", y: "ʏ", z: "ᴢ",
};

/** "Bot Info" -> "ʙᴏᴛ ɪɴғᴏ" */
function smallCaps(text) {
  return String(text)
    .toLowerCase()
    .replace(/[a-z]/g, (ch) => SMALL_CAPS[ch] || ch);
}

// ───────────── Message style helpers ─────────────

/** Top-of-menu header with the bot name in small caps */
function header() {
  return (
    "╭─━─━─━─━─━─━─━─━─━─━╮\n" +
    `│  ⚡ ${smallCaps(config.BOT_NAME)} ⚡\n` +
    "╰─━─━─━─━─━─━─━─━─━─━╯"
  );
}

/** One line inside a section: "✦ ʟᴀʙᴇʟ : value" */
function row(label, value) {
  return `✦ ${smallCaps(label)} : ${value}`;
}

/** A boxed section. `lines` is an array of strings (use row() or your own). */
function section(icon, title, lines) {
  return (
    `┌───〔 ${icon} ${smallCaps(title)} 〕───┐\n` +
    lines.map((l) => `│ ${l}`).join("\n") +
    "\n└───────────────────┘"
  );
}

// ───────────── System prompt for the AI ─────────────
const SYSTEM_PROMPT = [
  `You are ${config.AI_NAME}, the AI assistant of ${config.CREATOR_NAME}.`,
  config.CREATOR_INFO ? `About ${config.CREATOR_NAME}: ${config.CREATOR_INFO}.` : "",
  `Your main job: ${config.AI_HELPS_WITH}`,
  "Style rules:",
  "- Be friendly, short and simple.",
  "- Write plain text for WhatsApp: no markdown headings or tables. For code, use WhatsApp triple backticks.",
  "- Keep every reply under about 1200 characters.",
  "- Small talk is fine. If a question is unrelated to your main job, politely steer the person back to what you help with.",
  `- If anyone asks what you are, your name, who made you, who owns you or similar, answer that you are ${config.AI_NAME}, the AI assistant of ${config.CREATOR_NAME}` +
    (config.CREATOR_INFO ? `, and you may add: ${config.CREATOR_INFO}.` : "."),
  "- Never claim to be human.",
  "- Never name the company, the model or the provider behind you. If someone sincerely asks about the technology, say you are an AI assistant powered by an AI language model.",
]
  .filter(Boolean)
  .join("\n");

module.exports = { ...config, smallCaps, header, row, section, SYSTEM_PROMPT };
