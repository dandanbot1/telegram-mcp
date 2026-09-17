# telegram-mcp

OpenClaw-shaped Telegram inbound stack: a local webhook listener that spools updates, an MCP stdio server for agents, and a supervisor that keeps the listener + public HTTPS front + `setWebhook` healthy.

## Architecture

```
Telegram ──HTTPS──► public tunnel (cloudflared or smee.io)
                         │
                         ▼
              127.0.0.1:8787 webhook-listener
                         │
                         ▼
         ~/.local/telegram-mcp/spool/<update_id>.json
                         │
         MCP tools: tg_list_spool / tg_ack_spool / tg_send_message / …
```

- **webhook-listener** binds only `127.0.0.1:8787`. Validates `X-Telegram-Bot-Api-Secret-Token`, writes updates atomically to the spool, returns 200 quickly.
- **MCP server** (stdio, official `@modelcontextprotocol/sdk`) exposes Bot API helpers and spool tools. Never returns the bot token, webhook secret, or full public URL.
- **supervisor** kills old PIDs on restart, keeps listener/tunnel/setWebhook healthy.

## Runtime files (not in git)

Default data dir: `~/.local/telegram-mcp/` (override with `TELEGRAM_MCP_DATA_DIR`).

| Path | Purpose |
|------|---------|
| `token` | Bot token (0600). Or set `TELEGRAM_BOT_TOKEN`. |
| `webhook-secret` | Secret for Telegram header validation (0600; minted if missing). |
| `public-url` | Public HTTPS base URL used for setWebhook (0600). |
| `allowed-chat-id` | Optional. If set, typing keepalive runs for that chat. |
| `bot-username` | Written by smoke script. |
| `spool/*.json` | Pending inbound updates. |
| `spool/done/` | Acknowledged updates. |
| `*.pid` / `logs/` | Supervisor state. |

**Never commit** token, webhook-secret, public-url, chat ids, or spool contents.

## Install

```bash
cd /path/to/telegram-mcp
npm install
```

## Smoke test

```bash
npm run smoke
# prints: @YourBot <numeric_id>
```

## Run supervisor

Keeps listener, public front, and webhook registration healthy:

```bash
npm run supervisor
# or
bash scripts/supervisor.sh
```

On start it:

1. Ensures `webhook-secret` exists (mints with `openssl rand -hex 32` if needed).
2. Restarts the listener (kills old PID first).
3. Tries **cloudflared** quick tunnel → `setWebhook`; on resolve-host failure falls back to **smee.io** via `scripts/smee-forward.js` (reads `public-url` from the data dir so the channel URL is not in process argv).
4. Health-loops `/healthz` and tunnel liveness.

Run under `nohup` or a process manager if you want it detached:

```bash
nohup bash scripts/supervisor.sh >>~/.local/telegram-mcp/logs/supervisor.log 2>&1 &
```

Set webhook alone (after `public-url` exists):

```bash
npm run set-webhook
```

## MCP registration

Point your MCP client at the stdio server:

```bash
node /path/to/telegram-mcp/src/mcp-server.js
```

Example Cursor / Claude-style config fragment:

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

Optional: `"env": { "TELEGRAM_BOT_TOKEN": "…" }` — prefer the token file with mode 0600.

### Tools

| Tool | Role |
|------|------|
| `tg_get_me` | Bot identity |
| `tg_send_message` | Send text (`chat_id`, `text`, optional `parse_mode`) |
| `tg_send_chat_action` | Default `typing` |
| `tg_list_spool` | Pending spool summaries (no secrets) |
| `tg_ack_spool` | Move `spool/<update_id>.json` → `spool/done/` |
| `tg_webhook_info` | Redacted getWebhookInfo + local `/healthz` |
| `tg_get_updates` | **First-time setup only** — do not use when webhook is set |

## Listener details

- `GET /healthz` → `ok`
- `POST /telegram-webhook` only; 401 if secret missing/wrong
- Body limit ~1MB; atomic spool write (temp + rename); idempotent if file exists
- Allowed chat: immediate `sendChatAction(typing)`, refresh every **4s** until spool file is gone or **2 minutes** pass

## Caveats

- **Drain latency**: after ack, Telegram-side delivery is already done; local agents should poll `tg_list_spool` on a short interval. Expect ~1 minute end-to-end slack when including tunnel + agent cycles — design prompts accordingly.
- **Typing keepalive**: only for `allowed-chat-id`; stops when the spool file is acked/removed or after 2 minutes.
- **Webhook vs getUpdates**: mutually exclusive on Telegram’s side. Use webhook + spool in production; `tg_get_updates` is for bootstrap only.
- **Secrets**: logs include `update_id`, `chat_id`, `has_text` only — never token, secret, or full public URL.
- **cloudflared**: optional; without it the supervisor uses smee.io via `smee-forward.js` (URL kept out of `ps`).


## Helper scripts

```bash
# After a private DM lands in the spool:
node scripts/capture-chat-id-from-spool.js
# → writes ~/.local/telegram-mcp/allowed-chat-id (0600); prints the numeric id

# Ask the allowed chat to reply (prove inbound path):
node scripts/send-prove-message.js
```

## License

MIT (private package by default).
