#!/usr/bin/env node
/**
 * One-shot getMe smoke test. Prints ONLY @username and id. Never prints token.
 * Writes username to bot-username (0600).
 */
import fs from 'node:fs';
import { getMe } from '../src/telegram-api.js';
import { BOT_USERNAME_PATH, DATA_DIR } from '../src/paths.js';

async function main() {
  const me = await getMe();
  const username = me.username ? `@${me.username}` : '(no-username)';
  const id = me.id;
  console.log(`${username} ${id}`);

  fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
  fs.writeFileSync(BOT_USERNAME_PATH, `${username}\n`, { mode: 0o600 });
  try {
    fs.chmodSync(BOT_USERNAME_PATH, 0o600);
  } catch {
    /* ignore */
  }
}

main().catch((err) => {
  console.error('smoke-get-me failed:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
