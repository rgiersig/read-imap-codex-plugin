#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pluginRoot = path.resolve(__dirname, "..");

const REGISTRATION_WORDS = [
  "register", "registration", "verify", "verification", "confirm", "confirmation",
  "activate", "activation", "account", "login", "sign in", "signup", "sign-up",
  "code", "otp", "one-time", "einmal", "bestätigung", "bestaetigung", "registrierung"
];

function loadConfig() {
  const configPath = process.env.READ_IMAP_CONFIG || path.join(pluginRoot, "config.local.json");
  if (!fs.existsSync(configPath)) {
    throw new Error(`Missing IMAP config. Copy config.example.json to config.local.json or set READ_IMAP_CONFIG. Looked at: ${configPath}`);
  }
  return JSON.parse(fs.readFileSync(configPath, "utf8"));
}

function normalizeText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function htmlToText(html) {
  return String(html || "")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function extractLinks(text) {
  const urlPattern = /https?:\/\/[^\s"'<>\])]+/gi;
  const links = new Set();
  for (const match of String(text || "").matchAll(urlPattern)) {
    const cleaned = match[0].replace(/[.,;:!?]+$/g, "");
    if (REGISTRATION_WORDS.some((word) => cleaned.toLowerCase().includes(word))) {
      links.add(cleaned);
    }
  }
  return [...links];
}

function extractCodes(text) {
  const codes = new Set();
  const source = String(text || "");
  const patterns = [
    /(?:code|otp|pin|verification|confirm(?:ation)?|security code|bestätigungscode|bestaetigungscode)[^A-Z0-9]{0,30}([A-Z0-9]{4,10})/gi,
    /\b(\d{4,8})\b/g
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      codes.add(match[1]);
    }
  }
  return [...codes].slice(0, 20);
}

function messageLooksRelevant(message, bodyText, query) {
  const haystack = `${message.subject || ""} ${message.from || ""} ${bodyText}`.toLowerCase();
  if (query && !haystack.includes(String(query).toLowerCase())) return false;
  return REGISTRATION_WORDS.some((word) => haystack.includes(word));
}

async function withMailbox(fn) {
  const config = loadConfig();
  const client = new ImapFlow({
    host: config.host,
    port: config.port ?? 993,
    secure: config.secure !== false,
    auth: config.auth,
    logger: false
  });
  await client.connect();
  try {
    await client.mailboxOpen(config.mailbox || "INBOX", { readOnly: true });
    return await fn(client, config);
  } finally {
    await client.logout().catch(() => {});
  }
}

async function findRegistrationMessages(args = {}) {
  return withMailbox(async (client, config) => {
    const sinceDays = Number(args.sinceDays ?? config.defaultSinceDays ?? 7);
    const since = new Date(Date.now() - sinceDays * 24 * 60 * 60 * 1000);
    const maxMessages = Math.min(Number(args.maxMessages ?? config.maxMessages ?? 20), 100);
    const search = { since };
    if (args.fromDomain) search.from = String(args.fromDomain);
    const uids = await client.search(search, { uid: true });
    const newest = uids.slice(-Math.max(maxMessages * 3, maxMessages)).reverse();
    const results = [];

    for await (const msg of client.fetch(newest, { uid: true, envelope: true, source: true })) {
      const parsed = await simpleParser(msg.source);
      const htmlText = htmlToText(parsed.html);
      const text = normalizeText(`${parsed.text || ""} ${htmlText}`);
      const from = normalizeText(parsed.from?.text || msg.envelope?.from?.map((x) => x.address).join(", "));
      const subject = normalizeText(parsed.subject || msg.envelope?.subject);
      if (!messageLooksRelevant({ subject, from }, text, args.query)) continue;
      const allText = `${subject}\n${from}\n${text}`;
      results.push({
        uid: msg.uid,
        date: parsed.date?.toISOString?.() || null,
        from,
        subject,
        codes: extractCodes(allText),
        registrationLinks: extractLinks(`${parsed.html || ""}\n${parsed.text || ""}`),
        snippet: text.slice(0, 500)
      });
      if (results.length >= maxMessages) break;
    }
    return { mailbox: config.mailbox || "INBOX", count: results.length, messages: results };
  });
}

const tools = [
  {
    name: "find_registration_messages",
    description: "Read recent IMAP messages and extract likely registration or verification links and codes. Read-only.",
    inputSchema: {
      type: "object",
      properties: {
        sinceDays: { type: "number", description: "How many days back to search. Default comes from config." },
        maxMessages: { type: "number", description: "Maximum matching messages to return, capped at 100." },
        fromDomain: { type: "string", description: "Optional sender/domain filter." },
        query: { type: "string", description: "Optional text that must occur in sender, subject, or body." }
      }
    }
  }
];

function send(id, result, error) {
  const payload = error
    ? { jsonrpc: "2.0", id, error: { code: -32000, message: error.message || String(error) } }
    : { jsonrpc: "2.0", id, result };
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

async function handle(request) {
  const { id, method, params } = request;
  try {
    if (method === "initialize") {
      send(id, { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "read-imap-codex-plugin", version: "0.1.0" } });
    } else if (method === "tools/list") {
      send(id, { tools });
    } else if (method === "tools/call") {
      if (params?.name !== "find_registration_messages") throw new Error(`Unknown tool: ${params?.name}`);
      const data = await findRegistrationMessages(params.arguments || {});
      send(id, { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] });
    } else if (id !== undefined) {
      send(id, {});
    }
  } catch (error) {
    send(id, null, error);
  }
}

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on("line", (line) => {
  if (!line.trim()) return;
  try {
    handle(JSON.parse(line));
  } catch (error) {
    send(null, null, error);
  }
});
