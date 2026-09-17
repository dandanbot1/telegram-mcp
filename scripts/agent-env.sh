#!/usr/bin/env bash
# Print export lines for a telegram-mcp tenant (agent).
# Usage: eval "$(bash scripts/agent-env.sh <agent-id>)"
# Never prints tokens, secrets, or public URLs.
set -euo pipefail

AGENT_ID="${1:-}"
if [[ -z "$AGENT_ID" ]]; then
  echo "usage: $0 <agent-id>" >&2
  exit 2
fi

# Reject path traversal / absolute paths
if [[ "$AGENT_ID" == *"/"* || "$AGENT_ID" == *".."* || "$AGENT_ID" == /* ]]; then
  echo "invalid agent-id" >&2
  exit 2
fi

ROOT="${TELEGRAM_MCP_ROOT:-$HOME/.local/telegram-mcp}"
DATA_DIR="$ROOT/agents/$AGENT_ID"

if [[ ! -d "$DATA_DIR" ]]; then
  echo "agent data dir missing: $DATA_DIR" >&2
  exit 1
fi

PORT=""
if [[ -n "${TELEGRAM_WEBHOOK_PORT:-}" ]]; then
  PORT="$TELEGRAM_WEBHOOK_PORT"
elif [[ -s "$DATA_DIR/port" ]]; then
  PORT="$(tr -d ' \n' < "$DATA_DIR/port" || true)"
fi
if [[ -z "$PORT" ]]; then
  PORT="8787"
fi

printf 'export TELEGRAM_MCP_DATA_DIR=%q\n' "$DATA_DIR"
printf 'export TELEGRAM_WEBHOOK_PORT=%q\n' "$PORT"
