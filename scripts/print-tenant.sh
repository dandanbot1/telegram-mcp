#!/usr/bin/env bash
# List telegram-mcp tenants (agents/*/bot-username + ports). No secrets.
set -euo pipefail

ROOT="${TELEGRAM_MCP_ROOT:-$HOME/.local/telegram-mcp}"
AGENTS_DIR="$ROOT/agents"

printf '%-40s %-28s %s\n' "AGENT_ID" "BOT" "PORT"

if [[ ! -d "$AGENTS_DIR" ]]; then
  echo "(no agents dir at $AGENTS_DIR)" >&2
  exit 0
fi

shopt -s nullglob
for dir in "$AGENTS_DIR"/*; do
  [[ -d "$dir" ]] || continue
  id="$(basename "$dir")"
  bot="(none)"
  if [[ -s "$dir/bot-username" ]]; then
    bot="$(tr -d ' \n' < "$dir/bot-username" || true)"
  fi
  port="(unset)"
  if [[ -s "$dir/port" ]]; then
    port="$(tr -d ' \n' < "$dir/port" || true)"
  fi
  printf '%-40s %-28s %s\n' "$id" "$bot" "$port"
done
