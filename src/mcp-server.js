#!/usr/bin/env node
/**
 * Telegram MCP stdio server — generic Telegram interface for a Grok Bot agent.
 * Official @modelcontextprotocol/sdk. Never logs bot token, webhook secret,
 * wake URL/key, or full public webhook URL.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import fs from 'node:fs';
import path from 'node:path';
import {
  getMe,
  sendMessage,
  sendChatAction,
  getWebhookInfo,
  getUpdates,
} from './telegram-api.js';
import {
  SPOOL_DIR,
  SPOOL_DONE_DIR,
  HEALTHZ_URL,
} from './paths.js';
import {
  loadWhitelist,
  addChatId,
  addUsername,
  removeFromWhitelist,
  ensureWhitelistFile,
} from './whitelist.js';
import {
  ensureConfigFile,
  loadConfig,
  saveConfig,
} from './config.js';
import { getWakeConfig } from './agent-wake.js';

function textResult(obj) {
  return {
    content: [{ type: 'text', text: typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2) }],
  };
}

function errorResult(err) {
  const msg = err instanceof Error ? err.message : String(err);
  return {
    content: [{ type: 'text', text: msg }],
    isError: true,
  };
}

/**
 * Redact webhook URL for safe reporting.
 * Never return secret_token or full URL with secrets in path/query.
 */
function redactWebhookInfo(info) {
  let url_host = null;
  let configured = false;
  if (info && typeof info.url === 'string' && info.url.length > 0) {
    configured = true;
    try {
      const u = new URL(info.url);
      url_host = u.host || null;
    } catch {
      url_host = 'configured';
    }
  }
  return {
    configured,
    url_host,
    has_custom_certificate: Boolean(info?.has_custom_certificate),
    pending_update_count: info?.pending_update_count ?? 0,
    last_error_message: info?.last_error_message ?? null,
    last_error_date: info?.last_error_date ?? null,
    max_connections: info?.max_connections ?? null,
    ip_address: info?.ip_address ?? null,
    allowed_updates: info?.allowed_updates ?? null,
  };
}

function previewText(text, max = 80) {
  if (typeof text !== 'string') return null;
  const t = text.replace(/\s+/g, ' ').trim();
  if (t.length <= max) return t;
  return t.slice(0, max) + '…';
}

function listPendingSpool() {
  fs.mkdirSync(SPOOL_DIR, { recursive: true });
  fs.mkdirSync(SPOOL_DONE_DIR, { recursive: true });
  const names = fs.readdirSync(SPOOL_DIR).filter((n) => n.endsWith('.json'));
  const items = [];
  for (const name of names) {
    const full = path.join(SPOOL_DIR, name);
    let st;
    try {
      st = fs.statSync(full);
    } catch {
      continue;
    }
    if (!st.isFile()) continue;
    const updateId = name.replace(/\.json$/, '');
    let summary = { update_id: updateId, chat_id: null, text_preview: null };
    try {
      const raw = fs.readFileSync(full, 'utf8');
      const update = JSON.parse(raw);
      const msg = update.message || update.edited_message || update.channel_post;
      const chatId = msg?.chat?.id ?? update.callback_query?.message?.chat?.id ?? null;
      const text = msg?.text ?? msg?.caption ?? update.callback_query?.data ?? null;
      summary = {
        update_id: update.update_id ?? updateId,
        chat_id: chatId,
        text_preview: previewText(text),
      };
    } catch {
      // keep minimal summary
    }
    items.push(summary);
  }
  items.sort((a, b) => Number(a.update_id) - Number(b.update_id));
  return items;
}

function ackSpool(updateId) {
  const id = String(updateId);
  const src = path.join(SPOOL_DIR, `${id}.json`);
  const dest = path.join(SPOOL_DONE_DIR, `${id}.json`);
  fs.mkdirSync(SPOOL_DONE_DIR, { recursive: true });
  if (!fs.existsSync(src)) {
    throw new Error(`Spool file not found: ${id}.json`);
  }
  fs.renameSync(src, dest);
  return { acked: id, moved_to: 'spool/done/' };
}

const server = new McpServer({
  name: 'telegram-mcp',
  version: '1.1.0',
});

server.registerTool(
  'tg_get_me',
  {
    description:
      'Telegram interface for Grok Bot: call getMe. Returns bot id, username, and name. Never exposes the token.',
    inputSchema: {},
  },
  async () => {
    try {
      const me = await getMe();
      return textResult({
        id: me.id,
        is_bot: me.is_bot,
        first_name: me.first_name,
        username: me.username ? `@${me.username}` : null,
        can_join_groups: me.can_join_groups,
        can_read_all_group_messages: me.can_read_all_group_messages,
        supports_inline_queries: me.supports_inline_queries,
      });
    } catch (err) {
      return errorResult(err);
    }
  }
);

server.registerTool(
  'tg_send_message',
  {
    description:
      'Telegram interface for Grok Bot: send a text message to a chat via Bot API.',
    inputSchema: {
      chat_id: z.union([z.string(), z.number()]).describe('Telegram chat id'),
      text: z.string().describe('Message text'),
      parse_mode: z
        .enum(['HTML', 'Markdown', 'MarkdownV2'])
        .optional()
        .describe('Optional parse_mode'),
    },
  },
  async ({ chat_id, text, parse_mode }) => {
    try {
      const result = await sendMessage(chat_id, text, parse_mode);
      return textResult({
        message_id: result.message_id,
        chat_id: result.chat?.id,
        date: result.date,
      });
    } catch (err) {
      return errorResult(err);
    }
  }
);

server.registerTool(
  'tg_send_chat_action',
  {
    description:
      'Telegram interface for Grok Bot: send a chat action (default typing).',
    inputSchema: {
      chat_id: z.union([z.string(), z.number()]).describe('Telegram chat id'),
      action: z
        .string()
        .optional()
        .describe('Chat action, default "typing"'),
    },
  },
  async ({ chat_id, action }) => {
    try {
      const ok = await sendChatAction(chat_id, action || 'typing');
      return textResult({ ok });
    } catch (err) {
      return errorResult(err);
    }
  }
);

server.registerTool(
  'tg_list_spool',
  {
    description:
      'Telegram interface for Grok Bot: list pending inbound updates in spool/*.json (whitelisted only). Returns update_id + summary.',
    inputSchema: {},
  },
  async () => {
    try {
      const items = listPendingSpool();
      return textResult({ count: items.length, items });
    } catch (err) {
      return errorResult(err);
    }
  }
);

server.registerTool(
  'tg_ack_spool',
  {
    description:
      'Telegram interface for Grok Bot: acknowledge a spool item by moving spool/<update_id>.json to spool/done/.',
    inputSchema: {
      update_id: z.union([z.string(), z.number()]).describe('Telegram update_id'),
    },
  },
  async ({ update_id }) => {
    try {
      return textResult(ackSpool(update_id));
    } catch (err) {
      return errorResult(err);
    }
  }
);

server.registerTool(
  'tg_webhook_info',
  {
    description:
      'Telegram interface for Grok Bot: getWebhookInfo (redacted) plus local GET /healthz and whether instant wake is configured (yes/no only). Never returns secrets or full URLs.',
    inputSchema: {},
  },
  async () => {
    try {
      const info = await getWebhookInfo();
      let local_healthz = null;
      try {
        const res = await fetch(HEALTHZ_URL, { signal: AbortSignal.timeout(2000) });
        local_healthz = { ok: res.ok, status: res.status, body: (await res.text()).trim() };
      } catch (e) {
        local_healthz = {
          ok: false,
          error: e instanceof Error ? e.message : String(e),
        };
      }
      const wake = getWakeConfig();
      return textResult({
        telegram: redactWebhookInfo(info),
        local_healthz,
        instant_wake_configured: wake.configured,
      });
    } catch (err) {
      return errorResult(err);
    }
  }
);

server.registerTool(
  'tg_get_updates',
  {
    description:
      'Telegram interface for Grok Bot: getUpdates for first-time setup ONLY. Do not use when a webhook is set. Prefer webhook + spool + agent wake in production.',
    inputSchema: {
      offset: z.number().optional().describe('Optional offset'),
      limit: z.number().optional().describe('Optional limit (1-100)'),
      timeout: z.number().optional().describe('Long-poll timeout seconds'),
    },
  },
  async ({ offset, limit, timeout }) => {
    try {
      const params = {};
      if (offset !== undefined) params.offset = offset;
      if (limit !== undefined) params.limit = limit;
      if (timeout !== undefined) params.timeout = timeout;
      const updates = await getUpdates(params);
      const summary = (updates || []).map((u) => {
        const msg = u.message || u.edited_message;
        return {
          update_id: u.update_id,
          chat_id: msg?.chat?.id ?? null,
          text_preview: previewText(msg?.text ?? msg?.caption),
        };
      });
      return textResult({
        warning:
          'tg_get_updates is for first-time setup only; do not use when webhook is set.',
        count: summary.length,
        items: summary,
      });
    } catch (err) {
      return errorResult(err);
    }
  }
);

server.registerTool(
  'tg_whitelist_list',
  {
    description:
      'Telegram interface for Grok Bot: list whitelist chat_ids and usernames (no secrets). Empty whitelist denies all inbound (except bootstrap /start).',
    inputSchema: {},
  },
  async () => {
    try {
      ensureWhitelistFile();
      const wl = loadWhitelist();
      return textResult({
        chat_ids: wl.chat_ids,
        usernames: wl.usernames,
        empty: wl.chat_ids.length === 0 && wl.usernames.length === 0,
      });
    } catch (err) {
      return errorResult(err);
    }
  }
);

server.registerTool(
  'tg_whitelist_add',
  {
    description:
      'Telegram interface for Grok Bot: add a chat_id and/or username to the whitelist. Usernames without @; match is case-insensitive.',
    inputSchema: {
      chat_id: z.number().optional().describe('Telegram chat id (number)'),
      username: z
        .string()
        .optional()
        .describe('Telegram username without @'),
    },
  },
  async ({ chat_id, username }) => {
    try {
      if (chat_id === undefined && (username === undefined || username === '')) {
        return errorResult(new Error('Provide chat_id and/or username'));
      }
      ensureWhitelistFile();
      let result = loadWhitelist();
      const changes = [];
      if (chat_id !== undefined) {
        const r = addChatId(chat_id);
        result = { chat_ids: r.chat_ids, usernames: r.usernames };
        changes.push({ chat_id, added: r.added });
      }
      if (typeof username === 'string' && username.trim()) {
        const r = addUsername(username);
        result = { chat_ids: r.chat_ids, usernames: r.usernames };
        changes.push({ username: username.replace(/^@/, '').toLowerCase(), added: r.added });
      }
      return textResult({ ...result, changes });
    } catch (err) {
      return errorResult(err);
    }
  }
);

server.registerTool(
  'tg_whitelist_remove',
  {
    description:
      'Telegram interface for Grok Bot: remove a chat_id and/or username from the whitelist.',
    inputSchema: {
      chat_id: z.number().optional().describe('Telegram chat id (number)'),
      username: z
        .string()
        .optional()
        .describe('Telegram username without @'),
    },
  },
  async ({ chat_id, username }) => {
    try {
      if (chat_id === undefined && (username === undefined || username === '')) {
        return errorResult(new Error('Provide chat_id and/or username'));
      }
      ensureWhitelistFile();
      const result = removeFromWhitelist({ chat_id, username });
      return textResult({
        chat_ids: result.chat_ids,
        usernames: result.usernames,
        removed: result.removed,
      });
    } catch (err) {
      return errorResult(err);
    }
  }
);


server.registerTool(
  'tg_config_get',
  {
    description:
      'Telegram interface for Grok Bot: read tenant config.json (no secrets). Returns group_require_mention (default true: groups only accept direct @mentions / replies / @commands).',
    inputSchema: {},
  },
  async () => {
    try {
      ensureConfigFile();
      const cfg = loadConfig();
      return textResult({
        group_require_mention: cfg.group_require_mention,
      });
    } catch (err) {
      return errorResult(err);
    }
  }
);

server.registerTool(
  'tg_config_set',
  {
    description:
      'Telegram interface for Grok Bot: update tenant config.json. Set group_require_mention true/false (when true, group/supergroup messages must @mention or reply to the bot). Takes effect on next inbound update (no restart).',
    inputSchema: {
      group_require_mention: z
        .boolean()
        .describe(
          'If true, only direct pings in groups/supergroups are accepted'
        ),
    },
  },
  async ({ group_require_mention }) => {
    try {
      ensureConfigFile();
      const cfg = saveConfig({ group_require_mention });
      return textResult({
        group_require_mention: cfg.group_require_mention,
        updated: true,
      });
    } catch (err) {
      return errorResult(err);
    }
  }
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error('MCP server failed:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
