#!/usr/bin/env node
/**
 * Print only whether wake config files exist (yes/no). Never prints values.
 */
import fs from 'node:fs';
import {
  AGENT_WAKE_URL_PATH,
  AGENT_WAKE_KEY_PATH,
  AGENT_WAKE_HEADER_PATH,
  requireTenantDataDir,
} from '../src/paths.js';
import { resolveWakeHeaderMode } from '../src/agent-wake.js';

try {
  requireTenantDataDir();
} catch (err) {
  console.error(
    'check-wake-config failed:',
    err instanceof Error ? err.message : String(err)
  );
  process.exit(1);
}

function present(p) {
  try {
    const st = fs.statSync(p);
    if (!st.isFile()) return false;
    const raw = fs.readFileSync(p, 'utf8').trim();
    return raw.length > 0;
  } catch {
    return false;
  }
}

const url = present(AGENT_WAKE_URL_PATH);
const key = present(AGENT_WAKE_KEY_PATH);
const headerFile = present(AGENT_WAKE_HEADER_PATH);
const mode = resolveWakeHeaderMode();

console.log(`agent-wake-url: ${url ? 'yes' : 'no'}`);
console.log(`agent-wake-key: ${key ? 'yes' : 'no'}`);
console.log(`agent-wake-header file: ${headerFile ? 'yes' : 'no'}`);
console.log(`header-mode: ${mode}`);
console.log(`instant-wake: ${url && key ? 'configured' : 'not configured'}`);
