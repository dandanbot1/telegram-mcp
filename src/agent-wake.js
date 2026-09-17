/**
 * Instant wake: after a whitelisted update is spooled, POST a small JSON
 * payload to the configured Grok Bot webhook routine URL.
 *
 * Config files (0600, not in git):
 *   ~/.local/telegram-mcp/agent-wake-url     — full HTTPS URL of the routine
 *   ~/.local/telegram-mcp/agent-wake-key     — sender key / secret
 *   ~/.local/telegram-mcp/agent-wake-header  — optional header mode (see below)
 *
 * Default auth header scheme (send BOTH so one sticks):
 *   Authorization: Bearer <key>
 *   X-Webhook-Secret: <key>
 *
 * Header mode resolution (first match wins):
 *   1. env AGENT_WAKE_HEADER
 *   2. file agent-wake-header (trimmed contents)
 *   3. default "both"
 *
 * Mode values:
 *   - "both" / empty / missing → Authorization Bearer + X-Webhook-Secret
 *   - "Authorization" → Bearer + still X-Webhook-Secret
 *   - "X-Webhook-Secret" / "X-Sender-Key" / "X-Webhook-Key" / other →
 *       that header with raw key PLUS Authorization: Bearer <key>
 *
 * Do not log URL or key values. Wake failure must not affect Telegram 200.
 */
import fs from 'node:fs';
import {
  AGENT_WAKE_URL_PATH,
  AGENT_WAKE_KEY_PATH,
  AGENT_WAKE_HEADER_PATH,
} from './paths.js';

let missingConfigLogged = false;

function readTrimmed(filePath) {
  try {
    const v = fs.readFileSync(filePath, 'utf8').trim();
    return v || null;
  } catch (err) {
    if (err && err.code === 'ENOENT') return null;
    return null;
  }
}

/**
 * Resolve header mode: env > file > "both".
 * @returns {string}
 */
export function resolveWakeHeaderMode() {
  const fromEnv = process.env.AGENT_WAKE_HEADER;
  if (typeof fromEnv === 'string' && fromEnv.trim()) {
    return fromEnv.trim();
  }
  const fromFile = readTrimmed(AGENT_WAKE_HEADER_PATH);
  if (fromFile) return fromFile;
  return 'both';
}

/**
 * @returns {{ url: string|null, key: string|null, configured: boolean, header_mode: string }}
 */
export function getWakeConfig() {
  const url = readTrimmed(AGENT_WAKE_URL_PATH);
  const key = readTrimmed(AGENT_WAKE_KEY_PATH);
  return {
    url,
    key,
    configured: Boolean(url && key),
    header_mode: resolveWakeHeaderMode(),
  };
}

/**
 * Build auth headers. Never log these (contain the key).
 * Default always includes Authorization Bearer + X-Webhook-Secret.
 * @param {string} key
 * @param {string} [mode]
 * @returns {Record<string, string>}
 */
export function buildWakeHeaders(key, mode) {
  const m = (mode || resolveWakeHeaderMode()).trim();
  const lower = m.toLowerCase();

  const headers = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${key}`,
    'X-Webhook-Secret': key,
  };

  if (lower && lower !== 'both' && lower !== 'authorization' && lower !== 'x-webhook-secret') {
    // Custom header name (e.g. X-Sender-Key, X-Webhook-Key) with raw key
    headers[m] = key;
  }
  return headers;
}

function textPreview(update, max = 80) {
  const msg =
    update?.message ||
    update?.edited_message ||
    update?.channel_post ||
    null;
  const text =
    msg?.text ?? msg?.caption ?? update?.callback_query?.data ?? null;
  if (typeof text !== 'string') return null;
  const t = text.replace(/\s+/g, ' ').trim();
  if (t.length <= max) return t;
  return t.slice(0, max) + '…';
}

function extractChatId(update) {
  const msg =
    update?.message ||
    update?.edited_message ||
    update?.channel_post ||
    update?.callback_query?.message;
  if (msg?.chat?.id != null) return msg.chat.id;
  return null;
}

/**
 * Fire-and-forget wake. Logs success/failure without secrets.
 * @param {object} update
 * @returns {Promise<{ woken: boolean, reason?: string }>}
 */
export async function wakeAgent(update) {
  const { url, key, configured, header_mode } = getWakeConfig();
  if (!configured) {
    if (!missingConfigLogged) {
      missingConfigLogged = true;
      console.error(
        '[agent-wake] instant wake not configured (missing agent-wake-url and/or agent-wake-key)'
      );
    }
    return { woken: false, reason: 'not_configured' };
  }

  const body = {
    source: 'telegram-mcp',
    update_id: update?.update_id ?? null,
    chat_id: extractChatId(update),
    text_preview: textPreview(update),
  };

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: buildWakeHeaders(key, header_mode),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) {
      console.error(
        '[agent-wake] wake POST failed status=%s update_id=%s',
        res.status,
        body.update_id
      );
      try {
        await res.text();
      } catch {
        /* ignore */
      }
      return { woken: false, reason: `http_${res.status}` };
    }
    console.error(
      '[agent-wake] wake ok update_id=%s status=%s',
      body.update_id,
      res.status
    );
    try {
      await res.text();
    } catch {
      /* ignore */
    }
    return { woken: true };
  } catch (err) {
    console.error(
      '[agent-wake] wake error update_id=%s: %s',
      body.update_id,
      err instanceof Error ? err.message : 'unknown'
    );
    return { woken: false, reason: 'network' };
  }
}
