#!/usr/bin/env node
/**
 * Telegram MCP stdio server (official @modelcontextprotocol/sdk).
 * Never logs bot token, webhook secret, or full public webhook URL.
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
  version: '1.0.0',
});

server.registerTool(
  'tg_get_me',
  {
    description: 'Call Telegram getMe. Returns bot id, username, and name. Never exposes the token.',
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
    description: 'Send a text message to a chat via Telegram Bot API.',
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
    description: 'Send a chat action (default typing) to indicate the bot is working.',
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
      'List pending inbound updates in spool/*.json (not done/). Returns update_id + summary only.',
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
    description: 'Acknowledge a spool item by moving spool/<update_id>.json to spool/done/.',
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
      'getWebhookInfo (redacted) plus local GET /healthz. Never returns secret_token or full URL with secrets.',
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
      return textResult({
        telegram: redactWebhookInfo(info),
        local_healthz,
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
      'getUpdates for first-time setup ONLY. Do not use when a webhook is set — Telegram will reject or starve one mode. Prefer the webhook + spool path in production.',
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

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  // stderr only; never include secrets
  console.error('MCP server failed:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
