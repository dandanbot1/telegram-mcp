import fs from 'node:fs';
import path from 'node:path';
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
 * Parse a Telegram Bot API JSON response. Never logs the token.
 * @param {string} method
 * @param {Response} res
 * @returns {Promise<any>}
 */
async function parseTgResponse(method, res) {
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

function apiUrl(method, token) {
  return `${TELEGRAM_API_BASE}/bot${token}/${method}`;
}

/**
 * Call Telegram Bot API method (JSON body).
 * @param {string} method
 * @param {Record<string, unknown>} [body]
 * @param {{ token?: string }} [opts]
 * @returns {Promise<any>}
 */
export async function tgApi(method, body, opts = {}) {
  const token = opts.token ?? readToken();
  const url = apiUrl(method, token);
  const init = {
    method: body === undefined ? 'GET' : 'POST',
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  };
  const res = await fetch(url, init);
  return parseTgResponse(method, res);
}

/**
 * Call Telegram Bot API method with multipart/form-data (file uploads).
 * Do not set Content-Type; fetch adds the multipart boundary.
 * @param {string} method
 * @param {FormData} form
 * @param {{ token?: string }} [opts]
 * @returns {Promise<any>}
 */
export async function tgApiMultipart(method, form, opts = {}) {
  const token = opts.token ?? readToken();
  const url = apiUrl(method, token);
  const res = await fetch(url, { method: 'POST', body: form });
  return parseTgResponse(method, res);
}

function isHttpsUrl(value) {
  try {
    const u = new URL(value);
    return u.protocol === 'https:';
  } catch {
    return false;
  }
}

function photoMimeType(filePath) {
  switch (path.extname(filePath).toLowerCase()) {
    case '.png':
      return 'image/png';
    case '.gif':
      return 'image/gif';
    case '.webp':
      return 'image/webp';
    case '.jpg':
    case '.jpeg':
    default:
      return 'image/jpeg';
  }
}

export async function getMe() {
  return tgApi('getMe');
}

export async function sendMessage(chatId, text, parseMode) {
  const body = { chat_id: chatId, text };
  if (parseMode) body.parse_mode = parseMode;
  return tgApi('sendMessage', body);
}

/**
 * Send a photo via Bot API sendPhoto.
 * `photo` is an HTTPS URL (JSON) or an absolute local file path (multipart upload).
 * @param {string|number} chatId
 * @param {{ photo: string, caption?: string, parseMode?: string }} opts
 * @returns {Promise<any>}
 */
export async function sendPhoto(chatId, { photo, caption, parseMode } = {}) {
  if (photo == null || String(photo).trim() === '') {
    throw new Error('photo is required (HTTPS URL or absolute local file path)');
  }
  const photoStr = String(photo).trim();

  if (isHttpsUrl(photoStr)) {
    const body = { chat_id: chatId, photo: photoStr };
    if (caption) body.caption = caption;
    if (parseMode) body.parse_mode = parseMode;
    return tgApi('sendPhoto', body);
  }

  const absPath = photoStr;
  if (!path.isAbsolute(absPath)) {
    throw new Error(
      `Photo must be an HTTPS URL or an absolute local file path: ${absPath}`
    );
  }
  if (!fs.existsSync(absPath)) {
    throw new Error(`Photo file does not exist: ${absPath}`);
  }
  const st = fs.statSync(absPath);
  if (!st.isFile()) {
    throw new Error(`Photo path is not a file: ${absPath}`);
  }

  const buf = fs.readFileSync(absPath);
  const bytes = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  const form = new FormData();
  form.append('chat_id', String(chatId));
  form.append(
    'photo',
    new Blob([bytes], { type: photoMimeType(absPath) }),
    path.basename(absPath)
  );
  if (caption) form.append('caption', caption);
  if (parseMode) form.append('parse_mode', parseMode);
  return tgApiMultipart('sendPhoto', form);
}

/**
 * Classify a photo source as an HTTPS URL or an existing absolute local file.
 * Throws before any API call on empty / relative / missing / non-file values.
 * @param {unknown} value
 * @param {string} label
 * @returns {{ kind: 'url', url: string } | { kind: 'file', absPath: string }}
 */
function resolvePhotoSource(value, label) {
  if (value == null || String(value).trim() === '') {
    throw new Error(`${label} is required (HTTPS URL or absolute local file path)`);
  }
  const str = String(value).trim();
  if (isHttpsUrl(str)) {
    return { kind: 'url', url: str };
  }
  if (!path.isAbsolute(str)) {
    throw new Error(
      `${label} must be an HTTPS URL or an absolute local file path: ${str}`
    );
  }
  if (!fs.existsSync(str)) {
    throw new Error(`${label} file does not exist: ${str}`);
  }
  const st = fs.statSync(str);
  if (!st.isFile()) {
    throw new Error(`${label} path is not a file: ${str}`);
  }
  return { kind: 'file', absPath: str };
}

function photoBlob(absPath) {
  const buf = fs.readFileSync(absPath);
  const bytes = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  return new Blob([bytes], { type: photoMimeType(absPath) });
}

/**
 * Send 2–10 photos as an album via Bot API sendMediaGroup.
 * `media` is an array of HTTPS URL strings or absolute local file paths.
 * Optional group-level `caption` / `parseMode` apply to the first photo only
 * (Telegram album caption rule). Mix of URLs and local files is allowed.
 * All-URL albums use JSON; any local file uses multipart with attach:// names.
 * @param {string|number} chatId
 * @param {{ media: string[], caption?: string, parseMode?: string }} opts
 * @returns {Promise<any[]>} array of Message
 */
export async function sendMediaGroup(chatId, { media, caption, parseMode } = {}) {
  if (!Array.isArray(media)) {
    throw new Error(
      'media must be an array of 2–10 HTTPS URLs or absolute local file paths'
    );
  }
  if (media.length < 2 || media.length > 10) {
    throw new Error('media must contain 2–10 items (Telegram album limit)');
  }

  const items = media.map((item, i) => resolvePhotoSource(item, `media[${i}]`));
  const applyCaption = (obj, i) => {
    if (i === 0 && caption) obj.caption = caption;
    if (i === 0 && parseMode) obj.parse_mode = parseMode;
    return obj;
  };

  const allUrls = items.every((item) => item.kind === 'url');
  if (allUrls) {
    const inputMedia = items.map((item, i) =>
      applyCaption({ type: 'photo', media: item.url }, i)
    );
    return tgApi('sendMediaGroup', { chat_id: chatId, media: inputMedia });
  }

  const form = new FormData();
  form.append('chat_id', String(chatId));
  const inputMedia = items.map((item, i) => {
    if (item.kind === 'url') {
      return applyCaption({ type: 'photo', media: item.url }, i);
    }
    const attachName = `photo${i}`;
    form.append(attachName, photoBlob(item.absPath), path.basename(item.absPath));
    return applyCaption({ type: 'photo', media: `attach://${attachName}` }, i);
  });
  form.append('media', JSON.stringify(inputMedia));
  return tgApiMultipart('sendMediaGroup', form);
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
