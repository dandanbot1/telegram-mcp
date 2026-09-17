#!/usr/bin/env node
/**
 * Send a short prove-it message to the first whitelisted chat_id
 * (falls back to legacy allowed-chat-id). Never prints token or chat id.
 */
import fs from 'node:fs';
import { sendMessage } from '../src/telegram-api.js';
import { ALLOWED_CHAT_ID_PATH } from '../src/paths.js';
import { ensureWhitelistFile, loadWhitelist } from '../src/whitelist.js';

const TEXT =
  'Telegram inbound is almost live — reply with anything and I will echo back via the spool drain.';

async function main() {
  ensureWhitelistFile();
  const wl = loadWhitelist();
  let chatId = wl.chat_ids[0] != null ? String(wl.chat_ids[0]) : null;

  if (!chatId) {
    try {
      chatId = fs.readFileSync(ALLOWED_CHAT_ID_PATH, 'utf8').trim() || null;
    } catch {
      chatId = null;
    }
  }
  if (!chatId) {
    throw new Error('No whitelisted chat_id (and no legacy allowed-chat-id)');
  }

  const result = await sendMessage(chatId, TEXT);
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
    'send-prove-message failed:',
    err instanceof Error ? err.message : String(err)
  );
  process.exit(1);
});
