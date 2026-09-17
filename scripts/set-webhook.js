#!/usr/bin/env node
/**
 * setWebhook using public-url + webhook-secret + token from data dir.
 * Prints ONLY status fields — never full URL or secret.
 */
import fs from 'node:fs';
import {
  PUBLIC_URL_PATH,
  WEBHOOK_SECRET_PATH,
  WEBHOOK_PATH,
} from '../src/paths.js';
import { setWebhook, getWebhookInfo } from '../src/telegram-api.js';

function readRequired(filePath, label) {
  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf8').trim();
  } catch (err) {
    if (err.code === 'ENOENT') {
      throw new Error(`Missing ${label} at ${filePath}`);
    }
    throw err;
  }
  if (!raw) throw new Error(`${label} is empty`);
  return raw;
}

function redactInfo(info) {
  let url_host = null;
  let configured = false;
  if (info?.url) {
    configured = true;
    try {
      url_host = new URL(info.url).host;
    } catch {
      url_host = 'configured';
    }
  }
  return {
    ok: true,
    configured,
    url_host,
    has_custom_certificate: Boolean(info?.has_custom_certificate),
    pending_update_count: info?.pending_update_count ?? 0,
    last_error_message: info?.last_error_message ?? null,
    last_error_date: info?.last_error_date ?? null,
    allowed_updates: info?.allowed_updates ?? null,
  };
}

async function main() {
  const publicUrl = readRequired(PUBLIC_URL_PATH, 'public-url');
  const secret = readRequired(WEBHOOK_SECRET_PATH, 'webhook-secret');

  // Local listener path is /telegram-webhook. For tunnels that terminate at the
  // host root and forward to that path (smee.io), do NOT append the path —
  // Telegram POSTing to https://smee.io/<id>/telegram-webhook returns 404.
  // For cloudflared/other direct tunnels, append WEBHOOK_PATH.
  let url = publicUrl.replace(/\/$/, '');
  let host = '';
  try {
    host = new URL(url).host;
  } catch {
    /* ignore */
  }
  const isSmee = host === 'smee.io' || host.endsWith('.smee.io');
  if (!isSmee && !url.endsWith(WEBHOOK_PATH)) {
    url = url + WEBHOOK_PATH;
  }

  await setWebhook({
    url,
    secret_token: secret,
    allowed_updates: ['message', 'edited_message', 'callback_query'],
    drop_pending_updates: false,
  });

  const info = await getWebhookInfo();
  console.log(JSON.stringify(redactInfo(info), null, 2));
}

main().catch((err) => {
  const msg = err instanceof Error ? err.message : String(err);
  // Heuristic: resolve-host / DNS style failures for supervisor fallback
  console.error('set-webhook failed:', msg);
  if (/resolve|ENOTFOUND|getaddrinfo|Failed to resolve|host/i.test(msg)) {
    process.exit(2);
  }
  process.exit(1);
});
