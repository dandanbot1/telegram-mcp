# telegram-mcp

Generic **Telegram interface for a Grok Bot agent**: whitelist-only inbound, durable spool, instant wake webhook, and MCP tools for replies.

## Agent setup (start here)

**Playbook for agents:** [SETUP.md](./SETUP.md)

If you are a Grok Bot told to *“setup telegram for me as per https://github.com/dandanbot1/telegram-mcp”*, open **SETUP.md** and execute it. Do not improvise a cron drain or point Telegram at the Grok webhook. **Use a new BotFather bot for this agent** — never copy another agent’s `@username` or token from memory or chat history.

Highlights the playbook encodes:

- Local listener `127.0.0.1:8787` is the Telegram front; Grok Bot webhook is **wake-only**.
- **Debounce** ~2s per chat (`src/agent-wake.js`) so one agent run drains the whole spool (≤1 reply per batch).
- **smee URL rule:** setWebhook uses the **smee channel root only** — never append `/telegram-webhook` (that causes Telegram 404). `smee-forward` maps channel → `http://127.0.0.1:8787/telegram-webhook`.

## Architecture

```
Telegram
   │  HTTPS webhook (setWebhook → public relay ONLY)
   ▼
public HTTPS relay (cloudflared / smee.io)
   │
   ▼
127.0.0.1:8787  webhook-listener   ← Telegram front (local)
   │
   ├─ secret-token check
   ├─ whitelist check  (non-whitelist → 200, no spool, no wake)
   ├─ atomic spool write  ~/.local/telegram-mcp/spool/<update_id>.json
   ├─ typing keepalive
   └─ POST agent wake (debounced ~2s/chat)  →  Grok Bot webhook routine
                              │
                              ▼
                         Grok Bot agent
                              │  MCP: tg_list_spool / tg_ack_spool / tg_send_message / …
                              ▼
                         Telegram reply
```

**Important:** Do **not** point Telegram `setWebhook` at the Grok Bot webhook. The local listener remains the Telegram front; the Grok wake URL is a separate private call after spool.

## Whitelist

File: `~/.local/telegram-mcp/whitelist.json` (mode `0600`):

```json
{
  "chat_ids": [],
  "usernames": []
}
```

- `chat_ids` — numeric Telegram chat ids
- `usernames` — without `@`, case-insensitive
- **Empty whitelist = deny all**, except optional **bootstrap**: if empty **and** a private `/start` arrives, that `chat_id` is auto-added
- Legacy `allowed-chat-id` migrates into `chat_ids` on listener start when whitelist is missing/empty

MCP: `tg_whitelist_list` / `tg_whitelist_add` / `tg_whitelist_remove`

## Instant wake (Grok Bot)

After a **whitelisted** update is durably spooled:

1. Start typing keepalive
2. Debounce ~2s per chat, then `POST` a small JSON payload to the wake URL (auth via key headers)
3. Wake failure is logged **without secrets**; Telegram still gets **200** after spool
4. If wake URL/key missing, log once that instant wake is not configured (still spool)

Check without printing secrets:

```bash
npm run check-wake
# → agent-wake-url: yes/no, agent-wake-key: yes/no, header-mode, instant-wake
```

Write URL/key via secret-request into `~/.local/telegram-mcp/agent-wake-{url,key}` (0600). See [SETUP.md](./SETUP.md).

## Runtime files (not in git)

Default data dir: `~/.local/telegram-mcp/` (`TELEGRAM_MCP_DATA_DIR` overrides).

| Path | Purpose |
|------|---------|
| `token` | Bot token (0600). Or `TELEGRAM_BOT_TOKEN`. |
| `webhook-secret` | Telegram `secret_token` / `X-Telegram-Bot-Api-Secret-Token` (0600; minted if missing). |
| `public-url` | Public HTTPS base for `setWebhook` (0600). |
| `whitelist.json` | Allowed chat ids / usernames (0600). |
| `allowed-chat-id` | Legacy single id; migrated into whitelist. |
| `agent-wake-url` | Grok Bot webhook routine URL (0600). |
| `agent-wake-key` | Wake sender key / secret (0600). |
| `agent-wake-header` | Optional header mode (0600). |
| `spool/*.json` | Pending inbound updates (whitelisted only). |
| `spool/done/` | Acknowledged updates. |
| `*.pid` / `logs/` | Supervisor state. |

**Never commit** tokens, secrets, URLs, whitelist contents, or spool.

## Install

```bash
cd /path/to/telegram-mcp
npm install
```

## Supervisor

```bash
npm run supervisor
# detached:
nohup bash scripts/supervisor.sh >>~/.local/telegram-mcp/logs/supervisor.log 2>&1 &
```

On start: kill old PIDs, ensure webhook-secret, restart listener, then cloudflared (or **reuse** saved smee `public-url`) + `setWebhook`.

## MCP registration

```json
{
  "mcpServers": {
    "telegram": {
      "command": "node",
      "args": ["/absolute/path/to/telegram-mcp/src/mcp-server.js"]
    }
  }
}
```

Paste connector instructions from [SETUP.md](./SETUP.md#mcp-instructions-paste).

### Tools

| Tool | Role |
|------|------|
| `tg_get_me` | Bot identity |
| `tg_send_message` | Send text |
| `tg_send_chat_action` | Default `typing` |
| `tg_list_spool` | Pending spool summaries |
| `tg_ack_spool` | Move spool → `spool/done/` |
| `tg_webhook_info` | Redacted webhook + `/healthz` + wake configured? |
| `tg_get_updates` | **Setup only** — not with webhook |
| `tg_whitelist_list` | List whitelist (no secrets) |
| `tg_whitelist_add` | `{ chat_id?, username? }` |
| `tg_whitelist_remove` | `{ chat_id?, username? }` |

## Listener details

- Binds `127.0.0.1:8787` only
- `GET /healthz` → `ok`
- `POST /telegram-webhook`; 401 if secret wrong
- Body limit ~1MB; atomic spool; idempotent
- Non-whitelist: 200, **no spool**, **no wake**
- Whitelist: spool → typing every **4s** (max **2 min**) → **debounced** agent wake

## Caveats

- **Webhook vs getUpdates**: mutually exclusive. Use webhook + spool + wake in production.
- **Secrets**: logs use `update_id`, status codes, hosts — never tokens/URLs/keys.
- **cloudflared** optional; smee via `smee-forward.js` (channel root only for Telegram).
- **Debounce**: do not wake once per message in a burst; one run drains the spool.

## License

MIT (private package by default).
