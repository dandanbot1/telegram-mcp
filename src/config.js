/**
 * Tenant config for telegram-mcp.
 * File: $TELEGRAM_MCP_DATA_DIR/config.json (mode 0600)
 *
 * Shape:
 *   { "group_require_mention": true }
 *
 * Default when missing: group_require_mention: true
 * (in groups/supergroups, only accept direct pings by default)
 */
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, CONFIG_PATH } from './paths.js';

export const DEFAULT_CONFIG = Object.freeze({
  group_require_mention: true,
});

function normalizeConfig(raw) {
  const out = { ...DEFAULT_CONFIG };
  if (raw && typeof raw === 'object') {
    if (typeof raw.group_require_mention === 'boolean') {
      out.group_require_mention = raw.group_require_mention;
    }
  }
  return out;
}

function writeConfig(data) {
  fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
  const normalized = normalizeConfig(data);
  const tmp = path.join(DATA_DIR, `.config.${process.pid}.${Date.now()}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify(normalized, null, 2) + '\n', {
    mode: 0o600,
  });
  try {
    fs.renameSync(tmp, CONFIG_PATH);
  } catch (err) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* ignore */
    }
    throw err;
  }
  try {
    fs.chmodSync(CONFIG_PATH, 0o600);
  } catch {
    /* ignore */
  }
  return normalized;
}

/**
 * Ensure config.json exists with defaults (0600). Idempotent.
 * @returns {{ group_require_mention: boolean }}
 */
export function ensureConfigFile() {
  if (!fs.existsSync(CONFIG_PATH)) {
    return writeConfig({ ...DEFAULT_CONFIG });
  }
  try {
    fs.chmodSync(CONFIG_PATH, 0o600);
  } catch {
    /* ignore */
  }
  return loadConfig();
}

/**
 * Load tenant config. Missing/malformed → defaults (group_require_mention: true).
 * @returns {{ group_require_mention: boolean }}
 */
export function loadConfig() {
  try {
    const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    return normalizeConfig(parsed);
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      return { ...DEFAULT_CONFIG };
    }
    // malformed → safe defaults
    return { ...DEFAULT_CONFIG };
  }
}

/**
 * Merge and persist config updates (0600).
 * @param {Partial<{ group_require_mention: boolean }>} patch
 * @returns {{ group_require_mention: boolean }}
 */
export function saveConfig(patch) {
  const current = loadConfig();
  const next = normalizeConfig({ ...current, ...(patch || {}) });
  return writeConfig(next);
}
