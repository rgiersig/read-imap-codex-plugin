#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pluginRoot = path.resolve(__dirname, "..");

function loadConfig() {
  const envConfig = process.env.READ_IMAP_CONFIG;
  if (envConfig && !fs.existsSync(envConfig)) {
    return parseEnvConfig(envConfig);
  }

  const configPath = envConfig || path.join(pluginRoot, "config.local.json");
  if (!fs.existsSync(configPath)) {
    throw new Error(`Missing IMAP config. Copy config.example.json to config.local.json or set READ_IMAP_CONFIG. Looked at: ${configPath}`);
  }
  return JSON.parse(fs.readFileSync(configPath, "utf8"));
}

function parseBoolean(value, defaultValue) {
  if (value === undefined) return defaultValue;
  if (/^(1|true|yes|on)$/i.test(value)) return true;
  if (/^(0|false|no|off)$/i.test(value)) return false;
  throw new Error(`Invalid boolean value in READ_IMAP_CONFIG: ${value}`);
}

function parseNumber(value, fieldName) {
  if (value === undefined) return undefined;
  const number = Number(value);
  if (!Number.isFinite(number)) {
    throw new Error(`Invalid numeric value for ${fieldName} in READ_IMAP_CONFIG: ${value}`);
  }
  return number;
}

function decodeConfigPart(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function deriveEmailAddress(user, host) {
  if (!user || !host) return null;
  return user.includes("@") ? user : `${user}@${host}`;
}

function parseEnvConfig(value) {
  const [authorityAndPath, queryString] = String(value).split("?", 2);
  const [authority, ...pathParts] = authorityAndPath.split("/");
  const atIndex = authority.lastIndexOf("@");
  const hashIndex = authority.indexOf("#");
  if (hashIndex <= 0 || atIndex <= hashIndex + 1 || atIndex === authority.length - 1) {
    throw new Error("Invalid READ_IMAP_CONFIG. Expected user#pass@host, optionally with :port, /mailbox, and ?secure=false&maxMessages=20&defaultSinceDays=7.");
  }

  const user = decodeConfigPart(authority.slice(0, hashIndex));
  const pass = decodeConfigPart(authority.slice(hashIndex + 1, atIndex));
  const hostAndPort = authority.slice(atIndex + 1);
  const bracketedHost = hostAndPort.match(/^\[([^\]]+)\](?::(\d+))?$/);
  const plainHost = hostAndPort.match(/^([^:]+)(?::(\d+))?$/);
  const hostMatch = bracketedHost || plainHost;
  if (!hostMatch) {
    throw new Error(`Invalid host in READ_IMAP_CONFIG: ${hostAndPort}`);
  }

  const params = new URLSearchParams(queryString || "");
  const mailboxPath = pathParts.join("/");
  const mailbox = params.get("mailbox") || (mailboxPath ? decodeConfigPart(mailboxPath) : "INBOX");
  const port = parseNumber(params.get("port") ?? hostMatch[2], "port") ?? 993;

  const host = decodeConfigPart(hostMatch[1]);
  const emailAddress = deriveEmailAddress(user, host);

  return {
    host,
    port,
    secure: parseBoolean(params.get("secure") ?? undefined, true),
    auth: { user, pass },
    emailAddress,
    mailbox,
    maxMessages: parseNumber(params.get("maxMessages") ?? undefined, "maxMessages") ?? 20,
    defaultSinceDays: parseNumber(params.get("defaultSinceDays") ?? undefined, "defaultSinceDays") ?? 7
  };
}

function normalizeText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function normalizeBodyText(value) {
  return String(value || "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .trim();
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

function extractAllLinks(text) {
  const urlPattern = /https?:\/\/[^\s"'<>\])]+/gi;
  const links = new Set();
  for (const match of String(text || "").matchAll(urlPattern)) {
    links.add(match[0].replace(/[.,;:!?]+$/g, ""));
  }
  return [...links];
}

function parsedMessageToResult(msg, parsed) {
  const htmlText = normalizeBodyText(htmlToText(parsed.html));
  const textBody = normalizeBodyText(parsed.text || htmlText);
  const htmlBody = parsed.html ? String(parsed.html) : null;
  const from = normalizeText(parsed.from?.text || msg.envelope?.from?.map((x) => x.address).join(", "));
  const to = normalizeText(parsed.to?.text || msg.envelope?.to?.map((x) => x.address).join(", "));
  const subject = normalizeText(parsed.subject || msg.envelope?.subject);
  const bodyForLinks = `${parsed.text || ""}\n${parsed.html || ""}`;

  return {
    uid: msg.uid,
    date: parsed.date?.toISOString?.() || null,
    from,
    to,
    subject,
    bodyText: textBody,
    bodyHtml: htmlBody,
    htmlAsText: htmlText,
    links: extractAllLinks(bodyForLinks),
    attachments: (parsed.attachments || []).map((attachment) => ({
      filename: attachment.filename || null,
      contentType: attachment.contentType || null,
      size: attachment.size || 0
    }))
  };
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

async function readRecentMessages(args = {}) {
  return withMailbox(async (client, config) => {
    const sinceDays = Number(args.sinceDays ?? config.defaultSinceDays ?? 7);
    const since = new Date(Date.now() - sinceDays * 24 * 60 * 60 * 1000);
    const maxMessages = Math.min(Number(args.maxMessages ?? config.maxMessages ?? 20), 100);
    const search = { since };
    if (args.fromDomain) search.from = String(args.fromDomain);
    const uids = await client.search(search, { uid: true });
    const candidateCount = args.query ? Math.max(maxMessages * 5, maxMessages) : maxMessages;
    const newest = uids.slice(-candidateCount).reverse();
    const messages = [];

    for await (const msg of client.fetch(newest, { uid: true, envelope: true, source: true })) {
      const parsed = await simpleParser(msg.source);
      const result = parsedMessageToResult(msg, parsed);
      if (args.query) {
        const haystack = `${result.subject}\n${result.from}\n${result.to}\n${result.bodyText}\n${result.htmlAsText}\n${result.bodyHtml || ""}`.toLowerCase();
        if (!haystack.includes(String(args.query).toLowerCase())) continue;
      }
      messages.push(result);
      if (messages.length >= maxMessages) break;
    }

    messages.sort((a, b) => (b.uid || 0) - (a.uid || 0));
    return { mailbox: config.mailbox || "INBOX", count: messages.length, messages };
  });
}

async function getConfiguredEmailAddress() {
  const config = loadConfig();
  const emailAddress = config.emailAddress || deriveEmailAddress(config.auth?.user, config.host);
  if (!emailAddress) {
    throw new Error("Unable to derive configured email address from READ_IMAP_CONFIG or config.");
  }
  return {
    emailAddress,
    source: process.env.READ_IMAP_CONFIG && !fs.existsSync(process.env.READ_IMAP_CONFIG) ? "READ_IMAP_CONFIG" : "config"
  };
}

const tools = [
  {
    name: "get_configured_email_address",
    description: "Return the configured mailbox email address derived from READ_IMAP_CONFIG or config. Read-only and does not expose the password.",
    inputSchema: {
      type: "object",
      properties: {}
    }
  },
  {
    name: "read_recent_messages",
    description: "Read recent IMAP messages newest-first and return full parsed message bodies for agent-side extraction. Read-only.",
    inputSchema: {
      type: "object",
      properties: {
        sinceDays: { type: "number", description: "How many days back to search. Default comes from config." },
        maxMessages: { type: "number", description: "Maximum messages to return, capped at 100." },
        fromDomain: { type: "string", description: "Optional sender/domain filter." },
        query: { type: "string", description: "Optional text that must occur in sender, recipient, subject, or body." }
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
      const toolHandlers = {
        get_configured_email_address: getConfiguredEmailAddress,
        read_recent_messages: readRecentMessages
      };
      const handler = toolHandlers[params?.name];
      if (!handler) throw new Error(`Unknown tool: ${params?.name}`);
      const data = await handler(params.arguments || {});
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
