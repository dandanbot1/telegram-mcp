#!/usr/bin/env node
/**
 * Send a photo via Bot API sendPhoto.
 * PHOTO (HTTPS URL or local path) is required from env.
 * CHAT_ID from env, else first whitelist / legacy allowed-chat-id.
 * Never prints token or chat id.
 */
import fs from 'node:fs';
import { sendPhoto } from '../src/telegram-api.js';
import { ALLOWED_CHAT_ID_PATH } from '../src/paths.js';
import { ensureWhitelistFile, loadWhitelist } from '../src/whitelist.js';

async function main() {
  const photo = (process.env.PHOTO || '').trim();
  if (!photo) {
    throw new Error('Set PHOTO to an HTTPS URL or absolute local file path');
  }

  ensureWhitelistFile();
  const wl = loadWhitelist();
  let chatId = (process.env.CHAT_ID || '').trim() || null;

  if (!chatId) {
    chatId = wl.chat_ids[0] != null ? String(wl.chat_ids[0]) : null;
  }
  if (!chatId) {
    try {
      chatId = fs.readFileSync(ALLOWED_CHAT_ID_PATH, 'utf8').trim() || null;
    } catch {
      chatId = null;
    }
  }
  if (!chatId) {
    throw new Error(
      'No CHAT_ID and no whitelisted chat_id (and no legacy allowed-chat-id)'
    );
  }

  const caption = (process.env.CAPTION || '').trim() || undefined;
  const parseMode = (process.env.PARSE_MODE || '').trim() || undefined;

  const result = await sendPhoto(chatId, { photo, caption, parseMode });
  console.log(
    JSON.stringify({
      ok: true,
      message_id: result?.message_id ?? null,
      chat_type: result?.chat?.type ?? null,
    })
  );
}

main().catch((err) => {
  console.error(
    'send-prove-photo failed:',
    err instanceof Error ? err.message : String(err)
  );
  process.exit(1);
});
