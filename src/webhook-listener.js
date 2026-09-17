#!/usr/bin/env node
/**
 * Local Telegram webhook listener — generic front for a Grok Bot agent.
 * Binds 127.0.0.1:8787 only. Never logs token, webhook secret, or wake URL/key.
 *
 * Flow: validate secret → whitelist → spool → typing keepalive → agent wake.
 * Non-whitelisted updates: 200 to Telegram, do NOT spool, do NOT wake.
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
} from './paths.js';
import { readToken, sendChatAction } from './telegram-api.js';
import {
  ensureWhitelistFile,
  isAllowed,
  isWhitelistEmpty,
  bootstrapChatIdIfStart,
  addChatId,
  loadWhitelist,
} from './whitelist.js';
import { wakeAgent } from './agent-wake.js';

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

function main() {
  ensureDirs();
  ensureWhitelistFile();
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

main();
