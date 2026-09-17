#!/usr/bin/env node
/**
 * Send a short prove-it message to allowed-chat-id.
 * Never prints token or chat id beyond success/failure.
 */
import fs from 'node:fs';
import { sendMessage } from '../src/telegram-api.js';
import { ALLOWED_CHAT_ID_PATH } from '../src/paths.js';

const TEXT =
  'Telegram inbound is almost live — reply with anything and I will echo back via the spool drain.';

async function main() {
  let chatId;
  try {
    chatId = fs.readFileSync(ALLOWED_CHAT_ID_PATH, 'utf8').trim();
  } catch (err) {
    if (err.code === 'ENOENT') {
      throw new Error(`Missing allowed-chat-id at ${ALLOWED_CHAT_ID_PATH}`);
    }
    throw err;
  }
  if (!chatId) throw new Error('allowed-chat-id is empty');

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
