#!/usr/bin/env node
/**
 * Forward smee.io events to the local webhook listener.
 * Reads the channel URL from PUBLIC_URL_PATH (or SMEE_SOURCE_URL) so the
 * URL never appears in process argv (unlike `smee --url …`).
 */
import fs from 'node:fs';
import Client from 'smee-client';
import { PUBLIC_URL_PATH, LOCAL_WEBHOOK_URL } from '../src/paths.js';

function readSource() {
  const fromEnv = process.env.SMEE_SOURCE_URL?.trim();
  if (fromEnv) return fromEnv;
  try {
    const raw = fs.readFileSync(PUBLIC_URL_PATH, 'utf8').trim();
    if (raw) return raw;
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  throw new Error(
    `Missing smee source URL (set SMEE_SOURCE_URL or write ${PUBLIC_URL_PATH})`
  );
}

const source = readSource();
const target = (process.env.SMEE_TARGET || LOCAL_WEBHOOK_URL).trim();

const client = new Client({ source, target });
client.start();

console.error('[smee-forward] started (source not printed)');
