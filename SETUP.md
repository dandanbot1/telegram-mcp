# SETUP.md — Agent playbook: Telegram side-channel for a Grok Bot

**Audience:** a Grok Bot / Cursor agent executing on the user's box.  
**Source of truth for:** “setup telegram for me as per https://github.com/dandanbot1/telegram-mcp”

Imperative steps only. **Never print secrets, tokens, wake URLs, webhook keys, or chat ids** in chat or logs.

---

### Goal

Give this Grok Bot a Telegram side-channel:

- Same agent as the app chat (not a separate bot personality).
- Whitelist-only inbound.
- Near-instant delivery via **local listener + Grok Bot webhook wake**.

This is **NOT**:

- A cron “spool drain”.
- Telegram `setWebhook` pointed at the Grok Bot webhook URL directly.

Flow: Telegram → public relay (cloudflared / smee) → `127.0.0.1:8787` listener → durable spool → debounced POST to Grok Bot **webhook routine** → agent drains spool with MCP `tg_*` tools → replies on Telegram.

---

### Prerequisites

- **Node 18+** on the box.
- User’s **own** BotFather bot token (their bot; not a shared token).
- Grok Bot can **AddMcpServer** (stdio) and **create a webhook routine**.
- Optional: `cloudflared`. If Cloudflare quick tunnels fail Telegram’s host check, **smee.io is the reliable fallback**.

---

### Naming

Default agent display name: **New Grok Bot**.

During setup:

1. Offer that default.
2. Let the user choose or suggest another name.
3. Apply via `update_state` profile when they decide.

Do **not** invent a role title or alternate persona name. Use **New Grok Bot** or whatever name they choose.


---

### Do / Don't

**DO:**

- Keep the local listener on `127.0.0.1:8787` as the **Telegram front**.
- Use a Grok Bot **webhook routine** only as *agent wake* (listener POSTs to it **after** spooling).
- Store secrets under `~/.local/telegram-mcp/*` with mode `0600`; never print token / secret / URL / key in chat.
- Prefer **secret-request** for BotFather token and wake URL / key.

**DON'T:**

- Point Telegram `setWebhook` at the Grok Bot webhook URL.
- Create a cron “spool drain” (use webhook wake + debounce).
- Call `getUpdates` while a webhook is set.
- Create a **new** smee channel on every supervisor restart (reuse saved `public-url`).
- Append `/telegram-webhook` onto smee.io channel URLs (Telegram gets 404). Correct: **smee channel root** → `smee-forward` → `http://127.0.0.1:8787/telegram-webhook`.
- Wake once per message in a burst (debounce ~2s per chat; one agent run drains the whole spool; **at most one reply per batch**).

---

### Step-by-step setup

Numbered. Copy-paste where safe. Never echo secret file contents.

1. **Clone or copy this repo onto the box** (e.g. `/workspace/telegram-mcp`). Then:

   ```bash
   cd /workspace/telegram-mcp
   npm install
   ```

2. **Ask the user for the BotFather token via secret-request.** Write it (mode `0600`):

   ```bash
   mkdir -p ~/.local/telegram-mcp
   # write token from secret-request into the file — do not echo the value
   chmod 600 ~/.local/telegram-mcp/token
   ```

   Or set `TELEGRAM_BOT_TOKEN` in the environment for this session only.

3. **Smoke the bot identity:**

   ```bash
   npm run smoke
   ```

   Note the `@username`. Tell the user the `@username` and ask them to open the bot in Telegram (do not invent a chat id).

4. **Register the MCP stdio connector.** Confirm with the user first (`AddMcpServer`):

   - command: `node`
   - args: `["/absolute/path/to/telegram-mcp/src/mcp-server.js"]`  
     (resolve the real absolute path on this box; do not guess)

   Then set connector instructions (paste from **MCP instructions** below): generic Telegram interface; whitelist; no `getUpdates` in webhook mode; never print secrets; stay quiet in Grok Bot after a Telegram reply.

5. **Create Grok Bot routine “Telegram inbound”** with trigger `{ "type": "webhook" }` and the anti-spam drain prompt (paste from **Routine prompt** below).

6. **Ask the user to open the routine field links** and paste values via secret-request:

   - Webhook URL → `~/.local/telegram-mcp/agent-wake-url` (0600)
   - Webhook key → `~/.local/telegram-mcp/agent-wake-key` (0600)

   Grok Bot’s routine panel exposes deep links shaped like:

   `grokbot://app/v1/sidebar?target=webhook-url&automation=<folder>`

   (and the matching key field). Folder / automation id comes from the routine create result — use that id; do not invent one.

7. **Start the supervisor** (detached):

   ```bash
   mkdir -p ~/.local/telegram-mcp/logs
   nohup bash scripts/supervisor.sh >>~/.local/telegram-mcp/logs/supervisor.log 2>&1 &
   ```

   Behavior to expect (do not print URLs):

   - Tries cloudflared; on “Failed to resolve host” (or similar) falls back to smee.
   - Reuses existing smee `public-url` when present.
   - Calls `setWebhook` with `secret_token`; for smee uses **channel root URL only**.

8. **Confirm health (redacted only):**

   ```bash
   curl -fsS http://127.0.0.1:8787/healthz
   npm run set-webhook
   node scripts/check-wake-config.js
   ```

   Expect: `ok`; set-webhook JSON with host only (no full URL); check-wake yes/no fields only.

9. **Bootstrap whitelist:** user sends `/start` in Telegram → empty whitelist auto-adds that `chat_id` → wake fires (debounced) → agent drains spool and replies once. Optionally add their username via `tg_whitelist_add`.

10. **Prove end-to-end:** user sends a short message; agent replies **on Telegram**; stay quiet in the Grok Bot app chat unless something is blocked or needs a decision.

---

### Runtime files table

Default data dir: `~/.local/telegram-mcp/` (`TELEGRAM_MCP_DATA_DIR` overrides). All secrets mode `0600`. Never commit.

| Path | Purpose |
|------|---------|
| `token` | BotFather bot token (or use `TELEGRAM_BOT_TOKEN`) |
| `webhook-secret` | Telegram `secret_token` / `X-Telegram-Bot-Api-Secret-Token` (minted if missing) |
| `public-url` | Public HTTPS base for `setWebhook` (cloudflared or smee channel root) |
| `whitelist.json` | Allowed `chat_ids` / `usernames` |
| `agent-wake-url` | Grok Bot webhook routine URL |
| `agent-wake-key` | Wake sender key / secret |
| `agent-wake-header` | Optional header mode (`both` default) |
| `spool/` | Pending inbound updates (whitelisted only) |
| `spool/done/` | Acknowledged updates |
| `*.pid` | Supervisor / listener / tunnel PIDs |
| `logs/` | `supervisor.log`, `listener.log`, tunnel logs |

---

### MCP tools table

| Tool | Role |
|------|------|
| `tg_get_me` | Bot identity |
| `tg_send_message` | Send text to a chat |
| `tg_send_chat_action` | Typing / other actions (default `typing`) |
| `tg_list_spool` | Pending spool summaries |
| `tg_ack_spool` | Move spool item → `spool/done/` |
| `tg_webhook_info` | Redacted webhook + `/healthz` + wake configured? |
| `tg_get_updates` | **Bootstrap only** — never while webhook is set |
| `tg_whitelist_list` | List whitelist (no secrets) |
| `tg_whitelist_add` | `{ chat_id?, username? }` |
| `tg_whitelist_remove` | `{ chat_id?, username? }` |

---

### Troubleshooting

| Symptom | Fix |
|---------|-----|
| Telegram `last_error` **404** on smee | Webhook URL must be the **smee channel root**, not `…/telegram-webhook`. `smee-forward` maps channel root → local `/telegram-webhook`. |
| Spam / multiple replies | Ensure debounce in `src/agent-wake.js` (~2s per chat) **and** the routine anti-spam prompt (≤1 reply per batch). |
| Empty spool after user message | Check tunnel/supervisor still running; `tg_webhook_info` / `getWebhookInfo` `last_error_*`; `logs/listener.log`. |
| `getUpdates` **409** | Webhook is set — do not poll; use spool + wake. |
| Wake not firing | `node scripts/check-wake-config.js` (yes/no only); listener wake POST logs without secrets. |

---

### Routine prompt (paste)

Ready-to-paste body for the **Telegram inbound** webhook routine:

```
You are waking because telegram-mcp posted to this webhook after spooling inbound Telegram updates.

Rules:
1. Use only tg_* MCP tools for Telegram. Never print tokens, wake URLs/keys, webhook secrets, full public URLs, or raw chat ids unless the user explicitly needs a redacted confirmation.
2. Call tg_list_spool. If the spool is empty, stop immediately and stay silent (no app-chat reply, no Telegram message).
3. Drain ALL pending spool items in this single run. Treat a burst as one batch.
4. Send at most ONE Telegram reply for the whole batch (summarize or answer the latest coherent ask). Prefer tg_send_chat_action typing briefly, then tg_send_message once.
5. After handling, tg_ack_spool every processed update_id.
6. Whitelist only: do not invent chat ids; reply to the chat_id from the spool summaries. If bootstrap /start just added someone, one short welcome on Telegram is enough.
7. Stay quiet in the Grok Bot app chat after a successful Telegram reply unless something is blocked or needs a user decision.
8. Never call tg_get_updates while webhook mode is active. Never create a cron drain.
```

---

### MCP instructions (paste)

Ready-to-paste **SetMcpInstructions** / connector instructions:

```
This MCP is the generic Telegram interface for this Grok Bot (whitelist-only inbound, local spool, instant wake).

- Prefer tg_list_spool / tg_ack_spool / tg_send_message / tg_send_chat_action for normal inbound work.
- tg_get_updates is bootstrap-only; never use it while a Telegram webhook is set (409 Conflict).
- Never print bot token, webhook secret, agent-wake URL/key, full public webhook URL, or unnecessary chat ids.
- After you reply on Telegram, stay quiet in the Grok Bot app chat unless blocked or needing a decision.
- Whitelist tools: tg_whitelist_list / tg_whitelist_add / tg_whitelist_remove. Empty whitelist denies all except optional private /start bootstrap.
```

---

## Handoff

When another agent is told “setup telegram for me as per this repo”, **follow this file end-to-end**. Keep architecture details in `README.md`; keep operational playbook here.
