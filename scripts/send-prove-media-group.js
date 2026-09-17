#!/usr/bin/env node
/**
 * Send a photo album via Bot API sendMediaGroup.
 * PHOTOS (comma-separated HTTPS URLs or local paths), or PHOTO_1 / PHOTO_2 …
 * CHAT_ID from env, else first whitelist / legacy allowed-chat-id.
 * Never prints token or chat id.
 */
import fs from 'node:fs';
import { sendMediaGroup } from '../src/telegram-api.js';
import { ALLOWED_CHAT_ID_PATH } from '../src/paths.js';
import { ensureWhitelistFile, loadWhitelist } from '../src/whitelist.js';

function collectPhotos() {
  const fromList = (process.env.PHOTOS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (fromList.length > 0) return fromList;

  const numbered = [];
  for (let i = 1; i <= 10; i++) {
    const v = (process.env[`PHOTO_${i}`] || '').trim();
    if (v) numbered.push(v);
  }
  return numbered;
}

async function main() {
  const photos = collectPhotos();
  if (photos.length < 2 || photos.length > 10) {
    throw new Error(
      'Set PHOTOS to 2–10 comma-separated HTTPS URLs or absolute paths (or PHOTO_1 / PHOTO_2 …)'
    );
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

  const result = await sendMediaGroup(chatId, {
    media: photos,
    caption,
    parseMode,
  });
  const messages = Array.isArray(result) ? result : [];
  console.log(
    JSON.stringify({
      ok: true,
      count: messages.length,
      message_ids: messages.map((m) => m.message_id ?? null),
      chat_type: messages[0]?.chat?.type ?? null,
    })
  );
}

main().catch((err) => {
  console.error(
    'send-prove-media-group failed:',
    err instanceof Error ? err.message : String(err)
  );
  process.exit(1);
});
