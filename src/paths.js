import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

/** Runtime data root (secrets, spool, pid files). Not part of the git repo. */
export const DATA_DIR =
  process.env.TELEGRAM_MCP_DATA_DIR ||
  path.join(os.homedir(), '.local', 'telegram-mcp');

/**
 * Optional per-tenant port file under DATA_DIR.
 * Used only when TELEGRAM_WEBHOOK_PORT is unset.
 */
function readPortFile() {
  try {
    const raw = fs.readFileSync(path.join(DATA_DIR, 'port'), 'utf8').trim();
    if (!raw) return undefined;
    const n = Number(raw);
    if (Number.isFinite(n) && n > 0 && n < 65536) return n;
  } catch (err) {
    if (err && err.code !== 'ENOENT') {
      /* ignore malformed/unreadable; fall through to default */
    }
  }
  return undefined;
}

export const TOKEN_PATH = path.join(DATA_DIR, 'token');
export const WEBHOOK_SECRET_PATH = path.join(DATA_DIR, 'webhook-secret');
export const PUBLIC_URL_PATH = path.join(DATA_DIR, 'public-url');
/** @deprecated Prefer WHITELIST_PATH; kept for migration. */
export const ALLOWED_CHAT_ID_PATH = path.join(DATA_DIR, 'allowed-chat-id');
export const WHITELIST_PATH = path.join(DATA_DIR, 'whitelist.json');
export const BOT_USERNAME_PATH = path.join(DATA_DIR, 'bot-username');

/** Instant wake: Grok Bot webhook routine URL + sender key (0600, not in git). */
export const AGENT_WAKE_URL_PATH = path.join(DATA_DIR, 'agent-wake-url');
export const AGENT_WAKE_KEY_PATH = path.join(DATA_DIR, 'agent-wake-key');
/** Optional header name or "both". Default dual-header when missing. */
export const AGENT_WAKE_HEADER_PATH = path.join(DATA_DIR, 'agent-wake-header');

export const SPOOL_DIR = path.join(DATA_DIR, 'spool');
export const SPOOL_DONE_DIR = path.join(SPOOL_DIR, 'done');

export const LISTENER_PID_PATH = path.join(DATA_DIR, 'listener.pid');
export const TUNNEL_PID_PATH = path.join(DATA_DIR, 'tunnel.pid');
export const SUPERVISOR_PID_PATH = path.join(DATA_DIR, 'supervisor.pid');

export const LISTENER_HOST = '127.0.0.1';
export const LISTENER_PORT = Number(
  process.env.TELEGRAM_WEBHOOK_PORT || readPortFile() || 8787
);
export const HEALTHZ_URL = `http://${LISTENER_HOST}:${LISTENER_PORT}/healthz`;
export const WEBHOOK_PATH = '/telegram-webhook';
export const LOCAL_WEBHOOK_URL = `http://${LISTENER_HOST}:${LISTENER_PORT}${WEBHOOK_PATH}`;

export const TELEGRAM_API_BASE = 'https://api.telegram.org';
