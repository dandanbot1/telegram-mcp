#!/usr/bin/env bash
# Idempotently start a supervisor for every tenant under $TELEGRAM_MCP_HOME/agents/*/ (needs a 'port' file).
# Skips tenants whose supervisor is alive AND /healthz is ok. Never prints secrets.
# Usage: start-all-tenants.sh          one pass
#        start-all-tenants.sh --watch  ensure a single background loop (every 300s) re-running the pass
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HOME_DIR="${TELEGRAM_MCP_HOME:-$HOME/.local/telegram-mcp}"
INTERVAL="${TELEGRAM_MCP_WATCH_INTERVAL:-300}"

pass() {
  local d port pid
  for d in "$HOME_DIR"/agents/*/; do
    d="${d%/}"
    [[ -s "$d/port" && -s "$d/token" ]] || continue
    port="$(tr -d ' \n' < "$d/port")"
    pid="$(tr -d ' \n' < "$d/supervisor.pid" 2>/dev/null || true)"
    if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null \
       && curl -fsS -m 5 "http://127.0.0.1:${port}/healthz" >/dev/null 2>&1; then
      continue
    fi
    # supervisor dead or listener unhealthy: stop a stale supervisor, then start fresh
    [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null && { kill "$pid" 2>/dev/null; sleep 1; }
    mkdir -p "$d/logs"
    echo "[start-all $(date '+%F %T %Z')] starting tenant $(basename "$d") port $port" >> "$d/logs/supervisor.log"
    ( cd "$ROOT" && TELEGRAM_MCP_DATA_DIR="$d" TELEGRAM_WEBHOOK_PORT="$port" \
      nohup setsid bash scripts/supervisor.sh >> "$d/logs/supervisor.log" 2>&1 </dev/null & )
  done
}

if [[ "${1:-}" == "--watch" ]]; then
  PIDF="$HOME_DIR/watch.pid"
  if [[ -s "$PIDF" ]] && kill -0 "$(cat "$PIDF")" 2>/dev/null; then exit 0; fi
  (
    echo $BASHPID > "$PIDF"
    while true; do pass; sleep "$INTERVAL"; done
  ) >/dev/null 2>&1 </dev/null &
  disown 2>/dev/null || true
  exit 0
fi
pass
