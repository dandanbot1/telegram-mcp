/**
 * Whitelist for Telegram inbound updates.
 * File: ~/.local/telegram-mcp/whitelist.json (mode 0600)
 *
 * Shape:
 *   { "chat_ids": [123456789], "usernames": ["someuser"] }
 *
 * - chat_ids: Telegram chat id numbers
 * - usernames: without @, matched case-insensitively against message.from.username
 *   or chat.username
 * - Empty whitelist = deny all (except optional bootstrap on private /start)
 * - Legacy allowed-chat-id is migrated into chat_ids when whitelist is missing
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  DATA_DIR,
  WHITELIST_PATH,
  ALLOWED_CHAT_ID_PATH,
} from './paths.js';

const EMPTY = { chat_ids: [], usernames: [] };

function normalizeWhitelist(raw) {
  const chat_ids = [];
  const usernames = [];
  if (raw && typeof raw === 'object') {
    if (Array.isArray(raw.chat_ids)) {
      for (const id of raw.chat_ids) {
        const n = Number(id);
        if (Number.isFinite(n) && !chat_ids.includes(n)) chat_ids.push(n);
      }
    }
    if (Array.isArray(raw.usernames)) {
      for (const u of raw.usernames) {
        if (typeof u !== 'string') continue;
        const cleaned = u.replace(/^@/, '').trim().toLowerCase();
        if (cleaned && !usernames.includes(cleaned)) usernames.push(cleaned);
      }
    }
  }
  return { chat_ids, usernames };
}

function writeWhitelist(data) {
  fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
  const normalized = normalizeWhitelist(data);
  const tmp = path.join(
    DATA_DIR,
    `.whitelist.${process.pid}.${Date.now()}.tmp`
  );
  fs.writeFileSync(tmp, JSON.stringify(normalized, null, 2) + '\n', {
    mode: 0o600,
  });
  try {
    fs.renameSync(tmp, WHITELIST_PATH);
  } catch (err) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* ignore */
    }
    throw err;
  }
  try {
    fs.chmodSync(WHITELIST_PATH, 0o600);
  } catch {
    /* ignore */
  }
  return normalized;
}

function readLegacyAllowedChatId() {
  try {
    const raw = fs.readFileSync(ALLOWED_CHAT_ID_PATH, 'utf8').trim();
    if (!raw) return null;
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

/**
 * Ensure whitelist.json exists (0600). Migrates legacy allowed-chat-id if
 * whitelist is missing OR present but empty. Returns the current whitelist object.
 */
export function ensureWhitelistFile() {
  fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });

  if (!fs.existsSync(WHITELIST_PATH)) {
    const legacy = readLegacyAllowedChatId();
    const initial = { chat_ids: [], usernames: [] };
    if (legacy != null) {
      initial.chat_ids.push(legacy);
      console.error(
        '[whitelist] migrated legacy allowed-chat-id into whitelist.chat_ids'
      );
    }
    return writeWhitelist(initial);
  }

  try {
    const raw = JSON.parse(fs.readFileSync(WHITELIST_PATH, 'utf8'));
    let normalized = normalizeWhitelist(raw);
    try {
      fs.chmodSync(WHITELIST_PATH, 0o600);
    } catch {
      /* ignore */
    }
    // Empty whitelist + legacy file → bootstrap from legacy
    if (
      normalized.chat_ids.length === 0 &&
      normalized.usernames.length === 0
    ) {
      const legacy = readLegacyAllowedChatId();
      if (legacy != null) {
        normalized = writeWhitelist({
          chat_ids: [legacy],
          usernames: [],
        });
        console.error(
          '[whitelist] empty whitelist bootstrapped from legacy allowed-chat-id'
        );
      }
    }
    return normalized;
  } catch (err) {
    console.error('[whitelist] failed to read whitelist.json; treating as empty');
    const legacy = readLegacyAllowedChatId();
    if (legacy != null) {
      console.error(
        '[whitelist] recovered via legacy allowed-chat-id after read failure'
      );
      return writeWhitelist({ chat_ids: [legacy], usernames: [] });
    }
    return { ...EMPTY };
  }
}

/**
 * Load whitelist (ensures file exists / migrates).
 * @returns {{ chat_ids: number[], usernames: string[] }}
 */
export function loadWhitelist() {
  return ensureWhitelistFile();
}

/**
 * Persist whitelist.
 * @param {{ chat_ids?: number[], usernames?: string[] }} data
 */
export function saveWhitelist(data) {
  return writeWhitelist(data);
}

/**
 * Add a chat id to the whitelist (idempotent).
 * @param {number|string} id
 * @returns {{ chat_ids: number[], usernames: string[], added: boolean }}
 */
export function addChatId(id) {
  const n = Number(id);
  if (!Number.isFinite(n)) {
    throw new Error(`Invalid chat_id: ${id}`);
  }
  const wl = loadWhitelist();
  const added = !wl.chat_ids.includes(n);
  if (added) {
    wl.chat_ids.push(n);
    writeWhitelist(wl);
  }
  return { ...wl, added };
}

/**
 * Add a username (without @) to the whitelist (idempotent, stored lowercase).
 * @param {string} username
 */
export function addUsername(username) {
  if (typeof username !== 'string' || !username.trim()) {
    throw new Error('username required');
  }
  const cleaned = username.replace(/^@/, '').trim().toLowerCase();
  const wl = loadWhitelist();
  const added = !wl.usernames.includes(cleaned);
  if (added) {
    wl.usernames.push(cleaned);
    writeWhitelist(wl);
  }
  return { ...wl, added };
}

/**
 * Remove chat_id and/or username from whitelist.
 */
export function removeFromWhitelist({ chat_id, username } = {}) {
  const wl = loadWhitelist();
  let removed = false;
  if (chat_id !== undefined && chat_id !== null && chat_id !== '') {
    const n = Number(chat_id);
    const before = wl.chat_ids.length;
    wl.chat_ids = wl.chat_ids.filter((x) => x !== n);
    if (wl.chat_ids.length !== before) removed = true;
  }
  if (typeof username === 'string' && username.trim()) {
    const cleaned = username.replace(/^@/, '').trim().toLowerCase();
    const before = wl.usernames.length;
    wl.usernames = wl.usernames.filter((x) => x !== cleaned);
    if (wl.usernames.length !== before) removed = true;
  }
  if (removed) writeWhitelist(wl);
  return { ...wl, removed };
}

function extractMessage(update) {
  return (
    update?.message ||
    update?.edited_message ||
    update?.channel_post ||
    update?.edited_channel_post ||
    update?.callback_query?.message ||
    null
  );
}

/**
 * Whether the update is allowed by the whitelist.
 * Empty whitelist denies all (caller may still bootstrap on /start).
 * @param {object} update
 * @param {{ chat_ids: number[], usernames: string[] }} [wl]
 */
export function isAllowed(update, wl) {
  const list = wl || loadWhitelist();
  if (!list.chat_ids.length && !list.usernames.length) {
    return false;
  }

  const msg = extractMessage(update);
  const chatId = msg?.chat?.id;
  if (chatId != null && list.chat_ids.includes(Number(chatId))) {
    return true;
  }
  // callback_query without nested message chat
  const cbChatId = update?.callback_query?.message?.chat?.id;
  if (cbChatId != null && list.chat_ids.includes(Number(cbChatId))) {
    return true;
  }

  const fromUser =
    update?.message?.from?.username ||
    update?.edited_message?.from?.username ||
    update?.callback_query?.from?.username ||
    null;
  const chatUser = msg?.chat?.username || null;
  const candidates = [fromUser, chatUser]
    .filter(Boolean)
    .map((u) => String(u).replace(/^@/, '').toLowerCase());

  for (const c of candidates) {
    if (list.usernames.includes(c)) return true;
  }
  return false;
}

/**
 * Detect private /start for bootstrap when whitelist is empty.
 * @param {object} update
 * @returns {number|null} chat id to add, or null
 */
export function bootstrapChatIdIfStart(update) {
  const msg = update?.message;
  if (!msg || msg.chat?.type !== 'private') return null;
  const text = typeof msg.text === 'string' ? msg.text.trim() : '';
  // /start or /start@BotName with optional payload
  if (!/^\/start(?:@\w+)?(?:\s|$)/i.test(text)) return null;
  if (msg.chat?.id == null) return null;
  return Number(msg.chat.id);
}

/**
 * True when whitelist has no entries.
 */
export function isWhitelistEmpty(wl) {
  const list = wl || loadWhitelist();
  return list.chat_ids.length === 0 && list.usernames.length === 0;
}
