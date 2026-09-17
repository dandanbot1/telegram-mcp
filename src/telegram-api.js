import fs from 'node:fs';
import { TOKEN_PATH, TELEGRAM_API_BASE } from './paths.js';

/**
 * Read bot token from env or file. Never log the token.
 * @returns {string}
 */
export function readToken() {
  const fromEnv = process.env.TELEGRAM_BOT_TOKEN;
  if (fromEnv && fromEnv.trim()) {
    return fromEnv.trim();
  }
  try {
    const raw = fs.readFileSync(TOKEN_PATH, 'utf8').trim();
    if (!raw) {
      throw new Error(`Token file is empty: ${TOKEN_PATH}`);
    }
    return raw;
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      throw new Error(
        `No TELEGRAM_BOT_TOKEN and missing token file at ${TOKEN_PATH}`
      );
    }
    throw err;
  }
}

/**
 * Call Telegram Bot API method.
 * @param {string} method
 * @param {Record<string, unknown>} [body]
 * @param {{ token?: string }} [opts]
 * @returns {Promise<any>}
 */
export async function tgApi(method, body, opts = {}) {
  const token = opts.token ?? readToken();
  const url = `${TELEGRAM_API_BASE}/bot${token}/${method}`;
  const init = {
    method: body === undefined ? 'GET' : 'POST',
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  };
  const res = await fetch(url, init);
  let data;
  try {
    data = await res.json();
  } catch {
    throw new Error(`Telegram API ${method}: non-JSON response (HTTP ${res.status})`);
  }
  if (!data.ok) {
    const desc = data.description || `HTTP ${res.status}`;
    const err = new Error(`Telegram API ${method} failed: ${desc}`);
    err.telegram = data;
    throw err;
  }
  return data.result;
}

export async function getMe() {
  return tgApi('getMe');
}

export async function sendMessage(chatId, text, parseMode) {
  const body = { chat_id: chatId, text };
  if (parseMode) body.parse_mode = parseMode;
  return tgApi('sendMessage', body);
}

export async function sendChatAction(chatId, action = 'typing') {
  return tgApi('sendChatAction', { chat_id: chatId, action });
}

export async function getWebhookInfo() {
  return tgApi('getWebhookInfo');
}

export async function setWebhook(params) {
  return tgApi('setWebhook', params);
}

export async function getUpdates(params = {}) {
  return tgApi('getUpdates', params);
}
