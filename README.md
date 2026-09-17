# telegram-mcp

Generic **Telegram interface for a Grok Bot agent**: whitelist-only inbound, durable spool, instant wake webhook, and MCP tools for replies.

## Agent setup (start here)

**Playbook for agents:** [SETUP.md](./SETUP.md)

If you are a Grok Bot told to *“setup telegram for me as per https://github.com/dandanbot1/telegram-mcp”*, open **SETUP.md** and execute it. Do not improvise a cron drain or point Telegram at the Grok webhook. **Use a new BotFather bot for this agent** — never copy another agent’s `@username` or token from memory or chat history.

Highlights the playbook encodes:

- **Per-agent data dir** (`TELEGRAM_MCP_DATA_DIR`) and a **unique listener port** — required on a shared Grok Bot box.
- Local listener `127.0.0.1:<port>` is the Telegram front; Grok Bot webhook is **wake-only**.
- **Debounce** ~2s per chat (`src/agent-wake.js`) so one agent run drains the whole spool (≤1 reply per batch).
- **smee URL rule:** setWebhook uses the **smee channel root only** — never append `/telegram-webhook` (that causes Telegram 404). `smee-forward` maps channel → `http://127.0.0.1:<port>/telegram-webhook`.

## Multi-tenancy (shared box)

On a shared Grok Bot box, **each agent is a separate tenant**:

| Concern | Rule |
|---------|------|
| Data dir | `TELEGRAM_MCP_DATA_DIR=~/.local/telegram-mcp/agents/<agent-id>` (**required**) |
| Port | Unique `TELEGRAM_WEBHOOK_PORT` (or `agents/<id>/port` file); never share one port |
| Per-tenant secrets | **MUST** each have own `token`, `whitelist.json`, `webhook-secret`, `public-url`, `agent-wake-url`, `agent-wake-key`, and `port` under that DATA_DIR |
| Wake credentials | **Forbidden** to copy `agent-wake-url` / `agent-wake-key` from another agent (wakes the wrong Grok Bot) |
| Shared root | `~/.local/telegram-mcp/` may hold only a README warning — **not** live token/whitelist/wake/public-url/webhook-secret for any agent |
| Isolation | Sibling agents must **not** read or write another agent’s dir |
| BotFather | **One BotFather bot per Grok Bot** — never reuse another agent’s bot |
| MCP connector name | **Unique** display name per agent (never reuse another bot’s connector name) |
| `config.json` | Per-tenant; default `group_require_mention: true` |

Helpers:

```bash
# Print export lines for this agent
eval "$(bash scripts/agent-env.sh <agent-id>)"

# List tenants (bot @username + port only; no secrets)
bash scripts/print-tenant.sh
```

## Architecture

```
Telegram
   │  HTTPS webhook (setWebhook → public relay ONLY)
   ▼
public HTTPS relay (cloudflared / smee.io)
   │
   ▼
127.0.0.1:<port>  webhook-listener   ← Telegram front (local, per agent)
   │
   ├─ secret-token check
   ├─ whitelist check  (non-whitelist → 200, no spool, no wake)
   ├─ group mention gate (default on: groups need @bot / reply / /cmd@bot)
   ├─ atomic spool write  $TELEGRAM_MCP_DATA_DIR/spool/<update_id>.json
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

File: `$TELEGRAM_MCP_DATA_DIR/whitelist.json` (mode `0600`):

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

## Config (`config.json`)

File: `$TELEGRAM_MCP_DATA_DIR/config.json` (mode `0600`):

```json
{
  "group_require_mention": true
}
```

- **Default when missing:** `group_require_mention: true` (minted on listener start).
- When `true`, in **group** / **supergroup** chats the listener accepts only **direct pings**:
  1. `mention` / `text_mention` of this bot, or
  2. plain text/caption containing `@botUsername` (case-insensitive), or
  3. reply to a message from this bot, or
  4. `/cmd@botUsername` (`bot_command` addressed to this bot)
- Non-pings: **200**, log `rejected (not mentioned)`, **no spool**, **no wake**.
- **Private chats:** unchanged (whitelist only).
- Helper: `isDirectGroupPing(update, botUsername, botId)` in `src/group-gate.js`.

MCP: `tg_config_get` / `tg_config_set` (or edit the file). Listener re-reads config per update.

## Instant wake (Grok Bot)

After a **whitelisted** update is durably spooled:

1. Start typing keepalive
2. Debounce ~2s per chat, then `POST` a small JSON payload to the wake URL (auth via key headers)
3. Wake failure is logged **without secrets**; Telegram still gets **200** after spool
4. If wake URL/key missing, log once that instant wake is not configured (still spool)

Check without printing secrets:

```bash
# with TELEGRAM_MCP_DATA_DIR set for this agent
npm run check-wake
# → agent-wake-url: yes/no, agent-wake-key: yes/no, header-mode, instant-wake
```

Write URL/key via secret-request into `$TELEGRAM_MCP_DATA_DIR/agent-wake-{url,key}` (0600). See [SETUP.md](./SETUP.md).

## Runtime files (not in git)

**Required on a shared box:** set `TELEGRAM_MCP_DATA_DIR` to `~/.local/telegram-mcp/agents/<agent-id>`.  
Do **not** use the shared `~/.local/telegram-mcp/token` as the live store.

Port resolution for the listener: `TELEGRAM_WEBHOOK_PORT` env → `$DATA_DIR/port` file → fallback `8787`.

| Path | Purpose |
|------|---------|
| `token` | Bot token (0600). Or `TELEGRAM_BOT_TOKEN`. |
| `port` | Optional listener port for this tenant (plain integer). |
| `webhook-secret` | Telegram secret token (0600; minted if missing). |
| `public-url` | Public HTTPS base for `setWebhook` (0600). |
| `whitelist.json` | Allowed chat ids / usernames (0600). |
| `config.json` | Tenant flags e.g. `group_require_mention` (0600; default true). |
| `allowed-chat-id` | Legacy single id; migrated into whitelist. |
| `agent-wake-url` | Grok Bot webhook routine URL (0600). |
| `agent-wake-key` | Wake sender key / secret (0600). |
| `agent-wake-header` | Optional header mode (0600). |
| `bot-username` | Cached `@username` from smoke (0600). |
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
eval "$(bash scripts/agent-env.sh <agent-id>)"
npm run supervisor
# detached:
mkdir -p "$TELEGRAM_MCP_DATA_DIR/logs"
nohup bash scripts/supervisor.sh >>"$TELEGRAM_MCP_DATA_DIR/logs/supervisor.log" 2>&1 &
```

On start: kill old PIDs **for this DATA_DIR only**, ensure webhook-secret, restart listener on this agent’s port, then cloudflared (or **reuse** saved smee `public-url`) + `setWebhook`. Does not touch sibling agents’ directories.

## MCP registration

`AddMcpServer` **must** pass per-agent env (stdio connector):

```json
{
  "mcpServers": {
    "telegram": {
      "command": "node",
      "args": ["/absolute/path/to/telegram-mcp/src/mcp-server.js"],
      "env": {
        "TELEGRAM_MCP_DATA_DIR": "/home/box/.local/telegram-mcp/agents/<agent-id>",
        "TELEGRAM_WEBHOOK_PORT": "<port>"
      }
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
| `tg_config_get` | Read `config.json` (`group_require_mention`) |
| `tg_config_set` | `{ group_require_mention: boolean }` |

## Listener details

- Binds `127.0.0.1:<TELEGRAM_WEBHOOK_PORT>` only (from env, `$DATA_DIR/port`, or `8787`)
- `GET /healthz` → `ok`
- `POST /telegram-webhook`; 401 if secret wrong
- Body limit ~1MB; atomic spool; idempotent
- Non-whitelist: 200, **no spool**, **no wake**
- Group non-mention (when `group_require_mention`): 200, **no spool**, **no wake**
- Whitelist (+ direct ping in groups): spool → typing every **4s** (max **2 min**) → **debounced** agent wake

## Caveats

- **Webhook vs getUpdates**: mutually exclusive. Use webhook + spool + wake in production.
- **Secrets**: logs use `update_id`, status codes, hosts — never tokens/URLs/keys.
- **cloudflared** optional; smee via `smee-forward.js` (channel root only for Telegram).
- **Debounce**: do not wake once per message in a burst; one run drains the spool.
- **Shared box**: never point two agents at the same DATA_DIR or the same port.

## License

MIT (private package by default).
