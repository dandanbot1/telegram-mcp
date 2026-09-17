#!/usr/bin/env node
/**
 * Scan spool for the first private message; add chat id to whitelist
 * (and write legacy allowed-chat-id for compatibility). Prints ONLY the chat id number.
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  SPOOL_DIR,
  SPOOL_DONE_DIR,
  ALLOWED_CHAT_ID_PATH,
  DATA_DIR,
} from '../src/paths.js';
import { addChatId, ensureWhitelistFile } from '../src/whitelist.js';

function listJsonFiles(dir) {
  try {
    return fs
      .readdirSync(dir)
      .filter((n) => n.endsWith('.json'))
      .map((n) => path.join(dir, n));
  } catch {
    return [];
  }
}

function extractPrivateChatId(update) {
  const msg =
    update?.message ||
    update?.edited_message ||
    update?.channel_post ||
    update?.edited_channel_post ||
    null;
  if (!msg) return null;
  const chat = msg.chat;
  if (!chat || chat.type !== 'private') return null;
  if (chat.id === undefined || chat.id === null) return null;
  return String(chat.id);
}

function main() {
  ensureWhitelistFile();

  const files = [
    ...listJsonFiles(SPOOL_DIR),
    ...listJsonFiles(SPOOL_DONE_DIR),
  ].sort((a, b) => {
    try {
      return fs.statSync(a).mtimeMs - fs.statSync(b).mtimeMs;
    } catch {
      return a.localeCompare(b);
    }
  });

  let chatId = null;
  for (const file of files) {
    let update;
    try {
      update = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      continue;
    }
    chatId = extractPrivateChatId(update);
    if (chatId) break;
  }

  if (!chatId) {
    console.error('No private message found in spool');
    process.exit(1);
  }

  addChatId(chatId);

  // Also write legacy file for older helpers
  fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
  fs.writeFileSync(ALLOWED_CHAT_ID_PATH, `${chatId}\n`, { mode: 0o600 });
  try {
    fs.chmodSync(ALLOWED_CHAT_ID_PATH, 0o600);
  } catch {
    /* ignore */
  }
  console.log(chatId);
}

main();
