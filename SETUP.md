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

Flow: Telegram → public relay (cloudflared / smee) → `127.0.0.1:<port>` listener → durable spool under **this agent’s** `TELEGRAM_MCP_DATA_DIR` → debounced POST to Grok Bot **webhook routine** → agent drains spool with MCP `tg_*` tools → replies on Telegram.

---

### Prerequisites

**One BotFather bot per Grok Bot.** Never reuse another agent’s Telegram bot `@username`, BotFather token, wake URL/key, `public-url`, or whitelist. Create a **new** bot with BotFather for this agent. If you see some other agent’s Telegram `@username` in chat history, memory, or an example, that is **not** yours — ignore it and use only the `@username` returned by `npm run smoke` for **this** token.

**Per-agent data dir (required on a shared box):**

- Set `TELEGRAM_MCP_DATA_DIR` to `~/.local/telegram-mcp/agents/<this-agent-id>` for the supervisor, listener, smoke scripts, and MCP `env`.
- Assign a **unique** `TELEGRAM_WEBHOOK_PORT` (write it to `$TELEGRAM_MCP_DATA_DIR/port`). Do not share a port with another agent or with system tunnels.
- The shared root `~/.local/telegram-mcp/` may hold only a README warning — **never** use `~/.local/telegram-mcp/token` as the live store (sibling agents can overwrite it). Scrub any leftover live `token` / `whitelist.json` / `webhook-secret` / `public-url` / `agent-wake-*` from the shared root into quarantine; live config belongs only under `agents/<id>/`.
- Sibling agents must **not** read or write another agent’s dir.

Helpers:

```bash
eval "$(bash scripts/agent-env.sh <this-agent-id>)"
bash scripts/print-tenant.sh   # bot @username + port only
```

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


### Per-tenant config checklist (required)

Under `$TELEGRAM_MCP_DATA_DIR` each agent must have **its own** copies of:

| File | Must be unique per agent? |
|------|---------------------------|
| `token` | Yes — own BotFather bot |
| `whitelist.json` | Yes — own allowed chats |
| `config.json` | Per-tenant (default `group_require_mention: true`) |
| `webhook-secret` | Yes — mint with `openssl rand -hex 32` |
| `public-url` | Yes — own tunnel/channel (reuse within tenant only) |
| `agent-wake-url` / `agent-wake-key` | Yes — own Grok Bot **webhook routine** (never copy another agent’s) |
| `port` | Yes — unique listen port |

**Forbidden:** copying wake credentials (`agent-wake-url` / `agent-wake-key`) from another agent — that wakes the **wrong** Grok Bot on your Telegram traffic. Copying `whitelist.json` makes you answer their chats. Each tenant **MUST** mint/own its `whitelist.json`, `webhook-secret`, `public-url`, wake URL/key, and `port`.

### Do / Don't

**DO:**

- Keep the local listener on `127.0.0.1:<this-agent-port>` as the **Telegram front**.
- Use a Grok Bot **webhook routine** only as *agent wake* (listener POSTs to it **after** spooling).
- Store secrets under `$TELEGRAM_MCP_DATA_DIR/*` with mode `0600`; never print token / secret / URL / key in chat.
- Prefer **secret-request** for BotFather token and wake URL / key.
- Pass `TELEGRAM_MCP_DATA_DIR` and `TELEGRAM_WEBHOOK_PORT` in **AddMcpServer** `env`.

**DON'T:**

- Point Telegram `setWebhook` at the Grok Bot webhook URL.
- Create a cron “spool drain” (use webhook wake + debounce).
- Call `getUpdates` while a webhook is set.
- Reuse another Grok Bot’s BotFather bot, token, `@username`, wake credentials, whitelist, DATA_DIR, or port (each agent gets its own).
- Store the live token only in shared `~/.local/telegram-mcp/token`.
- Read or write another agent’s `~/.local/telegram-mcp/agents/<other-id>/`.
- Create a **new** smee channel on every supervisor restart (reuse saved `public-url`).
- Append `/telegram-webhook` onto smee.io channel URLs (Telegram gets 404). Correct: **smee channel root** → `smee-forward` → `http://127.0.0.1:<port>/telegram-webhook`.
- Wake once per message in a burst (debounce ~2s per chat; one agent run drains the whole spool; **at most one reply per batch**).

---

### Step-by-step setup

Numbered. Copy-paste where safe. Never echo secret file contents.

1. **Clone or copy this repo onto the box** (e.g. `/workspace/telegram-mcp`). Then:

   ```bash
   cd /workspace/telegram-mcp
   npm install
   ```

2. **Create this agent’s data dir and choose a free port.** Resolve `<this-agent-id>` from the Grok Bot agent id on this box.

   ```bash
   AGENT_ID="<this-agent-id>"
   export TELEGRAM_MCP_DATA_DIR="$HOME/.local/telegram-mcp/agents/$AGENT_ID"
   mkdir -p "$TELEGRAM_MCP_DATA_DIR"/{spool/done,logs}
   chmod 700 "$TELEGRAM_MCP_DATA_DIR" "$TELEGRAM_MCP_DATA_DIR/spool"
   # pick a free port (example 8788+) — must not collide with siblings or system services
   echo "<free-port>" > "$TELEGRAM_MCP_DATA_DIR/port"
   chmod 600 "$TELEGRAM_MCP_DATA_DIR/port"
   export TELEGRAM_WEBHOOK_PORT="$(tr -d ' \n' < "$TELEGRAM_MCP_DATA_DIR/port")"
   ```

   Optional: `eval "$(bash scripts/agent-env.sh "$AGENT_ID")"`.

3. **Ask the user for the BotFather token via secret-request.** Write it (mode `0600`):

   ```bash
   # write token from secret-request into the file — do not echo the value
   chmod 600 "$TELEGRAM_MCP_DATA_DIR/token"
   ```

   Or set `TELEGRAM_BOT_TOKEN` in the environment for this session only.

4. **Smoke the bot identity** (with DATA_DIR exported):

   ```bash
   npm run smoke
   ```

   Note the `@username`. Tell the user the `@username` and ask them to open the bot in Telegram (do not invent a chat id).

5. **Register the MCP stdio connector.** Confirm with the user first (`AddMcpServer`):

   - command: `node`
   - args: `["/absolute/path/to/telegram-mcp/src/mcp-server.js"]`  
     (resolve the real absolute path on this box; do not guess)
   - **env (required on a shared box):**
     - `TELEGRAM_MCP_DATA_DIR=/home/box/.local/telegram-mcp/agents/<this-agent-id>`
     - `TELEGRAM_WEBHOOK_PORT=<port>`

   Then set connector instructions (paste from **MCP instructions** below): generic Telegram interface; whitelist; no `getUpdates` in webhook mode; never print secrets; stay quiet in Grok Bot after a Telegram reply.

6. **Create Grok Bot routine “Telegram inbound”** with trigger `{ "type": "webhook" }` and the anti-spam drain prompt (paste from **Routine prompt** below).

7. **Ask the user to open the routine field links** and paste values via secret-request:

   - Webhook URL → `$TELEGRAM_MCP_DATA_DIR/agent-wake-url` (0600)
   - Webhook key → `$TELEGRAM_MCP_DATA_DIR/agent-wake-key` (0600)

   Grok Bot’s routine panel exposes deep links shaped like:

   `grokbot://app/v1/sidebar?target=webhook-url&automation=<folder>`

   (and the matching key field). Folder / automation id comes from the routine create result — use that id; do not invent one.

8. **Start the supervisor** (detached), with env set:

   ```bash
   export TELEGRAM_MCP_DATA_DIR="$HOME/.local/telegram-mcp/agents/<this-agent-id>"
   export TELEGRAM_WEBHOOK_PORT="$(tr -d ' \n' < "$TELEGRAM_MCP_DATA_DIR/port")"
   mkdir -p "$TELEGRAM_MCP_DATA_DIR/logs"
   nohup bash scripts/supervisor.sh >>"$TELEGRAM_MCP_DATA_DIR/logs/supervisor.log" 2>&1 &
   ```

   Behavior to expect (do not print URLs):

   - Uses only this agent’s DATA_DIR (does not touch sibling dirs).
   - Tries cloudflared; on “Failed to resolve host” (or similar) falls back to smee.
   - Reuses existing smee `public-url` when present.
   - Calls `setWebhook` with `secret_token`; for smee uses **channel root URL only**.

9. **Confirm health (redacted only):**

   ```bash
   curl -fsS "http://127.0.0.1:${TELEGRAM_WEBHOOK_PORT}/healthz"
   npm run set-webhook
   node scripts/check-wake-config.js
   bash scripts/print-tenant.sh
   ```

   Expect: `ok`; set-webhook JSON with host only (no full URL); check-wake yes/no fields only.

10. **Bootstrap whitelist:** user sends `/start` in Telegram → empty whitelist auto-adds that `chat_id` → wake fires (debounced) → agent drains spool and replies once. Optionally add their username via `tg_whitelist_add`.

11. **Group mention gate (default on):** `$DATA_DIR/config.json` with `{ "group_require_mention": true }` (minted if missing). In groups/supergroups the bot ignores messages unless @mentioned, replied-to, or `/cmd@botUsername`. Private chats unchanged. Toggle via `tg_config_set` or edit the file. **MCP connector names must stay unique** per agent.

12. **Prove end-to-end:** user sends a short message; agent replies **on Telegram**; stay quiet in the Grok Bot app chat unless something is blocked or needs a decision.

---

### Runtime files table

**Required:** `TELEGRAM_MCP_DATA_DIR=~/.local/telegram-mcp/agents/<agent-id>`.  
Port: `TELEGRAM_WEBHOOK_PORT` or `$DATA_DIR/port` (fallback `8787`).  
Shared `~/.local/telegram-mcp/token` is **not** the live store. All secrets mode `0600`. Never commit.

| Path | Purpose |
|------|---------|
| `token` | BotFather bot token (or use `TELEGRAM_BOT_TOKEN`) |
| `port` | Listener port for this tenant |
| `webhook-secret` | Telegram `secret_token` / `X-Telegram-Bot-Api-Secret-Token` (minted if missing) |
| `public-url` | Public HTTPS base for `setWebhook` (cloudflared or smee channel root) |
| `whitelist.json` | Allowed `chat_ids` / `usernames` |
| `config.json` | `{ "group_require_mention": true }` (default on; groups need @bot ping) |
| `agent-wake-url` | Grok Bot webhook routine URL |
| `agent-wake-key` | Wake sender key / secret |
| `agent-wake-header` | Optional header mode (`both` default) |
| `bot-username` | Cached `@username` from smoke |
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
| `tg_config_get` | Read `group_require_mention` |
| `tg_config_set` | `{ group_require_mention: boolean }` |

---

### Troubleshooting

| Symptom | Fix |
|---------|-----|
| Telegram `last_error` **404** on smee | Webhook URL must be the **smee channel root**, not `…/telegram-webhook`. `smee-forward` maps channel root → local `/telegram-webhook`. |
| Spam / multiple replies | Ensure debounce in `src/agent-wake.js` (~2s per chat) **and** the routine anti-spam prompt (≤1 reply per batch). |
| Empty spool after user message | Check tunnel/supervisor still running; `tg_webhook_info` / `getWebhookInfo` `last_error_*`; `$DATA_DIR/logs/listener.log`. |
| Group message ignored | Default `group_require_mention: true` — bot only accepts @mentions, replies to bot, or `/cmd@bot`. Check `rejected (not mentioned)` in listener.log, or `tg_config_set` / edit `config.json`. |
| `getUpdates` **409** | Webhook is set — do not poll; use spool + wake. |
| Wake not firing | `node scripts/check-wake-config.js` (yes/no only); listener wake POST logs without secrets. |
| Wrong bot / missing token | Confirm `TELEGRAM_MCP_DATA_DIR` points at **this** agent’s dir; never the shared root live token. |
| Port in use | Choose another free port; update `$DATA_DIR/port` and MCP `TELEGRAM_WEBHOOK_PORT`; restart supervisor. |

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
- Config: tg_config_get / tg_config_set for group_require_mention (default true: in groups only accept direct @mentions / replies / /cmd@bot). Or edit config.json.
- MCP connector display names must be unique per agent (never reuse another bot's connector name).
- This connector must run with TELEGRAM_MCP_DATA_DIR set to this agent's agents/<id> directory (never the shared root live token).
```

---

## Handoff

When another agent is told “setup telegram for me as per this repo”, **follow this file end-to-end**. Keep architecture details in `README.md`; keep operational playbook here.
