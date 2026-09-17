#!/usr/bin/env node
/**
 * Local Telegram webhook listener — generic front for a Grok Bot agent.
 * Binds 127.0.0.1:8787 only. Never logs token, webhook secret, or wake URL/key.
 *
 * Flow: validate secret → whitelist → group mention gate → spool → typing → wake.
 * Non-whitelisted / non-mentioned (groups): 200 to Telegram, do NOT spool, do NOT wake.
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  DATA_DIR,
  WEBHOOK_SECRET_PATH,
  SPOOL_DIR,
  SPOOL_DONE_DIR,
  LISTENER_HOST,
  LISTENER_PORT,
  WEBHOOK_PATH,
  TOKEN_PATH,
  BOT_USERNAME_PATH,
} from './paths.js';
import { readToken, sendChatAction, getMe } from './telegram-api.js';
import {
  ensureWhitelistFile,
  isAllowed,
  isWhitelistEmpty,
  bootstrapChatIdIfStart,
  addChatId,
  loadWhitelist,
} from './whitelist.js';
import { ensureConfigFile, loadConfig } from './config.js';
import { isDirectGroupPing } from './group-gate.js';
import { wakeAgent } from './agent-wake.js';

/** Cached bot identity for group mention gate (filled at startup). */
let cachedBotUsername = '';
let cachedBotId = null;

const BODY_LIMIT = 1024 * 1024; // ~1MB
const TYPING_INTERVAL_MS = 4000;
const TYPING_MAX_MS = 2 * 60 * 1000;

function ensureDirs() {
  fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
  fs.mkdirSync(SPOOL_DIR, { recursive: true, mode: 0o700 });
  fs.mkdirSync(SPOOL_DONE_DIR, { recursive: true, mode: 0o700 });
}

/**
 * Load or mint webhook secret (0600). Refuse empty.
 */
function loadOrMintSecret() {
  let secret = '';
  try {
    secret = fs.readFileSync(WEBHOOK_SECRET_PATH, 'utf8').trim();
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  if (!secret) {
    secret = crypto.randomBytes(32).toString('hex');
    fs.writeFileSync(WEBHOOK_SECRET_PATH, secret + '\n', { mode: 0o600 });
    fs.chmodSync(WEBHOOK_SECRET_PATH, 0o600);
    console.error('[webhook] minted webhook-secret (0600)');
  }
  if (!secret) {
    console.error('[webhook] webhook secret empty; refusing to start');
    process.exit(1);
  }
  return secret;
}

function safeEqualSecret(expected, provided) {
  if (typeof provided !== 'string' || provided.length === 0) return false;
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(provided, 'utf8');
  if (a.length !== b.length) {
    crypto.timingSafeEqual(a, a);
    return false;
  }
  return crypto.timingSafeEqual(a, b);
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(Object.assign(new Error('body too large'), { code: 'BODY_TOO_LARGE' }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function atomicWriteJson(destPath, obj) {
  const dir = path.dirname(destPath);
  const tmp = path.join(dir, `.${path.basename(destPath)}.${process.pid}.${Date.now()}.tmp`);
  const data = JSON.stringify(obj);
  fs.writeFileSync(tmp, data, { mode: 0o600 });
  try {
    fs.renameSync(tmp, destPath);
  } catch (err) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* ignore */
    }
    throw err;
  }
}

/** Active typing keepalives keyed by update_id */
const typingTimers = new Map();

function stopTyping(updateId) {
  const entry = typingTimers.get(String(updateId));
  if (!entry) return;
  clearInterval(entry.interval);
  typingTimers.delete(String(updateId));
}

function startTypingKeepalive(updateId, chatId) {
  const key = String(updateId);
  if (typingTimers.has(key)) return;
  const spoolPath = path.join(SPOOL_DIR, `${key}.json`);
  const started = Date.now();

  const tick = async () => {
    if (!fs.existsSync(spoolPath) || Date.now() - started >= TYPING_MAX_MS) {
      stopTyping(key);
      return;
    }
    try {
      await sendChatAction(chatId, 'typing');
    } catch {
      // ignore transient API errors during keepalive
    }
  };

  tick();
  const interval = setInterval(tick, TYPING_INTERVAL_MS);
  typingTimers.set(key, { interval, chatId });
}

function extractChatId(update) {
  const msg = update.message || update.edited_message || update.channel_post;
  if (msg?.chat?.id != null) return String(msg.chat.id);
  if (update.callback_query?.message?.chat?.id != null) {
    return String(update.callback_query.message.chat.id);
  }
  return null;
}

function extractChatType(update) {
  const msg = update.message || update.edited_message || update.channel_post;
  if (msg?.chat?.type) return msg.chat.type;
  if (update.callback_query?.message?.chat?.type) {
    return update.callback_query.message.chat.type;
  }
  return null;
}

/**
 * Load bot username from bot-username file or getMe; cache username + id.
 * Strips leading @. Never logs token.
 */
async function resolveBotIdentity() {
  let fromFile = '';
  try {
    fromFile = fs.readFileSync(BOT_USERNAME_PATH, 'utf8').trim().replace(/^@/, '');
  } catch (err) {
    if (err && err.code !== 'ENOENT') {
      console.error('[webhook] bot-username read error (non-fatal)');
    }
  }

  try {
    const me = await getMe();
    cachedBotId = me?.id != null ? Number(me.id) : null;
    const fromApi = typeof me?.username === 'string' ? me.username.replace(/^@/, '') : '';
    cachedBotUsername = fromApi || fromFile || '';
    if (cachedBotUsername) {
      try {
        fs.writeFileSync(BOT_USERNAME_PATH, `@${cachedBotUsername}\n`, { mode: 0o600 });
        fs.chmodSync(BOT_USERNAME_PATH, 0o600);
      } catch {
        /* ignore cache write failures */
      }
    }
    console.error(
      '[webhook] bot identity cached username=%s id=%s',
      cachedBotUsername ? `@${cachedBotUsername}` : '(none)',
      cachedBotId != null ? String(cachedBotId) : '(none)'
    );
  } catch (err) {
    cachedBotUsername = fromFile || '';
    cachedBotId = null;
    console.error(
      '[webhook] getMe failed at startup; using file username=%s (text_mention/reply-id checks limited)',
      cachedBotUsername ? `@${cachedBotUsername}` : '(none)'
    );
  }
}

function hasText(update) {
  const msg = update.message || update.edited_message || update.channel_post;
  return Boolean(msg?.text || msg?.caption);
}

async function handleTelegramWebhook(req, res, secret) {
  const header = req.headers['x-telegram-bot-api-secret-token'];
  if (!safeEqualSecret(secret, header)) {
    res.writeHead(401, { 'Content-Type': 'text/plain' });
    res.end('unauthorized');
    return;
  }

  let buf;
  try {
    buf = await readBody(req, BODY_LIMIT);
  } catch (err) {
    if (err.code === 'BODY_TOO_LARGE') {
      res.writeHead(413, { 'Content-Type': 'text/plain' });
      res.end('payload too large');
      return;
    }
    res.writeHead(400, { 'Content-Type': 'text/plain' });
    res.end('bad request');
    return;
  }

  let update;
  try {
    update = JSON.parse(buf.toString('utf8'));
  } catch {
    res.writeHead(400, { 'Content-Type': 'text/plain' });
    res.end('invalid json');
    return;
  }

  if (update == null || typeof update !== 'object' || update.update_id == null) {
    res.writeHead(400, { 'Content-Type': 'text/plain' });
    res.end('missing update_id');
    return;
  }

  const updateId = String(update.update_id);
  const chatId = extractChatId(update);
  const texty = hasText(update);

  // Whitelist (with optional bootstrap on empty + private /start)
  let wl = loadWhitelist();
  if (isWhitelistEmpty(wl)) {
    const bootId = bootstrapChatIdIfStart(update);
    if (bootId != null) {
      const result = addChatId(bootId);
      wl = { chat_ids: result.chat_ids, usernames: result.usernames };
      console.error(
        '[webhook] bootstrap: empty whitelist + private /start → added chat_id'
      );
    }
  }

  if (!isAllowed(update, wl)) {
    console.error(
      '[webhook] rejected (not whitelisted) update_id=%s chat_id=%s has_text=%s',
      updateId,
      chatId ?? 'none',
      texty
    );
    // Still 200 so Telegram does not retry; do not spool or wake
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('ok');
    return;
  }

  // Group mention gate (default on): only direct pings in groups/supergroups
  const chatType = extractChatType(update);
  const cfg = loadConfig();
  if (
    (chatType === 'group' || chatType === 'supergroup') &&
    cfg.group_require_mention
  ) {
    if (!isDirectGroupPing(update, cachedBotUsername, cachedBotId)) {
      console.error(
        '[webhook] rejected (not mentioned) update_id=%s chat_id=%s chat_type=%s has_text=%s',
        updateId,
        chatId ?? 'none',
        chatType,
        texty
      );
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('ok');
      return;
    }
  }

  const dest = path.join(SPOOL_DIR, `${updateId}.json`);
  let wrote = false;
  if (!fs.existsSync(dest)) {
    try {
      atomicWriteJson(dest, update);
      wrote = true;
    } catch (err) {
      console.error('[webhook] spool write failed update_id=%s', updateId);
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end('spool write failed');
      return;
    }
  }

  console.error(
    '[webhook] update_id=%s chat_id=%s has_text=%s spooled=%s',
    updateId,
    chatId ?? 'none',
    texty,
    wrote || 'idempotent'
  );

  // Durable spool first → 200 to Telegram (wake failure must not block this)
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('ok');

  if (chatId) {
    startTypingKeepalive(updateId, chatId);
  }

  // Instant wake (fire-and-forget; errors logged without secrets)
  wakeAgent(update).catch(() => {
    /* already logged inside wakeAgent */
  });
}

async function main() {
  ensureDirs();
  ensureWhitelistFile();
  ensureConfigFile();
  const secret = loadOrMintSecret();

  try {
    readToken();
  } catch (err) {
    console.error('[webhook] token unavailable:', err instanceof Error ? err.message : String(err));
    process.exit(1);
  }

  if (!fs.existsSync(TOKEN_PATH)) {
    console.error('[webhook] token file missing');
    process.exit(1);
  }

  await resolveBotIdentity();

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', `http://${LISTENER_HOST}:${LISTENER_PORT}`);

    if (req.method === 'GET' && url.pathname === '/healthz') {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('ok');
      return;
    }

    if (req.method === 'POST' && url.pathname === WEBHOOK_PATH) {
      try {
        await handleTelegramWebhook(req, res, secret);
      } catch (err) {
        console.error('[webhook] handler error');
        if (!res.headersSent) {
          res.writeHead(500, { 'Content-Type': 'text/plain' });
          res.end('error');
        }
      }
      return;
    }

    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('not found');
  });

  server.listen(LISTENER_PORT, LISTENER_HOST, () => {
    console.error(
      '[webhook] listening on %s:%s (path %s)',
      LISTENER_HOST,
      LISTENER_PORT,
      WEBHOOK_PATH
    );
  });

  const shutdown = () => {
    for (const key of [...typingTimers.keys()]) stopTyping(key);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error('[webhook] startup failed:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
