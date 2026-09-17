# telegram-mcp

Generic **Telegram interface for a Grok Bot agent**: whitelist-only inbound, durable spool, instant wake webhook, and MCP tools for replies.

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
   └─ POST agent wake  →  Grok Bot webhook routine URL
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
  "chat_ids": [123456789],
  "usernames": ["someuser"]
}
```

- `chat_ids` — numeric Telegram chat ids
- `usernames` — without `@`, case-insensitive match on `message.from.username` or `chat.username`
- **Empty whitelist = deny all**, except optional **bootstrap**: if the whitelist is empty **and** a private `/start` arrives, that `chat_id` is auto-added and persisted
- On listener start, if `whitelist.json` is missing **or** empty, a legacy `allowed-chat-id` file (if present) is migrated into `chat_ids`

Manage via MCP: `tg_whitelist_list` / `tg_whitelist_add` / `tg_whitelist_remove`, or:

```bash
node scripts/capture-chat-id-from-spool.js   # also writes whitelist
```

## Instant wake (Grok Bot)

After a **whitelisted** update is durably spooled:

1. Start typing keepalive (existing)
2. If wake URL + key are present, `POST` JSON:
   ```json
   { "source": "telegram-mcp", "update_id": N, "chat_id": …, "text_preview": "…" }
   ```
3. Wake failure is logged **without secrets**; Telegram still gets **200** after spool
4. If wake URL/key missing, log once that instant wake is not configured (still spool)

### Setup (paste once from the Grok Bot routine panel)

```bash
# Write URL and key with mode 0600 (never commit; never echo values)
printf '%s\n' 'https://…' > ~/.local/telegram-mcp/agent-wake-url
printf '%s\n' 'your-sender-key' > ~/.local/telegram-mcp/agent-wake-key
chmod 600 ~/.local/telegram-mcp/agent-wake-{url,key}
```

Optional header override file (or env `AGENT_WAKE_HEADER`):

```bash
# default when missing: send BOTH
#   Authorization: Bearer <key>
#   X-Webhook-Secret: <key>
printf 'both\n' > ~/.local/telegram-mcp/agent-wake-header   # optional
chmod 600 ~/.local/telegram-mcp/agent-wake-header
```

Check without printing secrets:

```bash
npm run check-wake
# → agent-wake-url: yes/no, agent-wake-key: yes/no, header-mode, instant-wake
```

## Runtime files (not in git)

Default data dir: `~/.local/telegram-mcp/` (`TELEGRAM_MCP_DATA_DIR` overrides).

| Path | Purpose |
|------|---------|
| `token` | Bot token (0600). Or `TELEGRAM_BOT_TOKEN`. |
| `webhook-secret` | Telegram `X-Telegram-Bot-Api-Secret-Token` (0600; minted if missing). |
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

Keeps listener, public front, and `setWebhook` healthy:

```bash
npm run supervisor
# detached:
nohup bash scripts/supervisor.sh >>~/.local/telegram-mcp/logs/supervisor.log 2>&1 &
```

On start it kills old PIDs, ensures webhook-secret, restarts the listener, then cloudflared (or smee.io fallback) + `setWebhook`.

## MCP registration

```json
{
  "mcpServers": {
    "telegram": {
      "command": "node",
      "args": ["/path/to/telegram-mcp/src/mcp-server.js"]
    }
  }
}
```

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
- Whitelist: spool → typing every **4s** (max **2 min**) → agent wake

## Caveats

- **Webhook vs getUpdates**: mutually exclusive. Use webhook + spool + wake in production.
- **Secrets**: logs use `update_id`, `chat_id`, `has_text`, wake status codes only.
- **cloudflared** optional; otherwise smee via `smee-forward.js` (URL kept out of `ps`).

## License

MIT (private package by default).
