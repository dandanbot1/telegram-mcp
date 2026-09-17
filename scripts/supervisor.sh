#!/usr/bin/env bash
# Keep webhook listener + public tunnel + setWebhook healthy.
# Never prints token, webhook secret, or public URL contents.
# Multi-tenant: honor TELEGRAM_MCP_DATA_DIR; only touch this agent's dir/port.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DATA_DIR="${TELEGRAM_MCP_DATA_DIR:-$HOME/.local/telegram-mcp}"
export TELEGRAM_MCP_DATA_DIR="$DATA_DIR"

mkdir -p "$DATA_DIR/spool/done"
chmod 700 "$DATA_DIR" "$DATA_DIR/spool" "$DATA_DIR/spool/done" 2>/dev/null || true

# Port: env > DATA_DIR/port > 8787
if [[ -z "${TELEGRAM_WEBHOOK_PORT:-}" && -s "$DATA_DIR/port" ]]; then
  TELEGRAM_WEBHOOK_PORT="$(tr -d ' \n' < "$DATA_DIR/port" || true)"
fi
TELEGRAM_WEBHOOK_PORT="${TELEGRAM_WEBHOOK_PORT:-8787}"
export TELEGRAM_WEBHOOK_PORT
PORT="$TELEGRAM_WEBHOOK_PORT"

LISTENER_PID_FILE="$DATA_DIR/listener.pid"
TUNNEL_PID_FILE="$DATA_DIR/tunnel.pid"
SUPERVISOR_PID_FILE="$DATA_DIR/supervisor.pid"
PUBLIC_URL_FILE="$DATA_DIR/public-url"
SECRET_FILE="$DATA_DIR/webhook-secret"
HEALTHZ="http://127.0.0.1:${PORT}/healthz"
LOG_DIR="$DATA_DIR/logs"
mkdir -p "$LOG_DIR"

echo $$ > "$SUPERVISOR_PID_FILE"
chmod 600 "$SUPERVISOR_PID_FILE" 2>/dev/null || true

log() { echo "[supervisor $(date '+%Y-%m-%d %H:%M:%S %Z')] $*" >&2; }

kill_pidfile() {
  local file="$1"
  local name="$2"
  if [[ -f "$file" ]]; then
    local pid
    pid="$(tr -d ' \n' < "$file" || true)"
    if [[ -n "${pid:-}" ]] && kill -0 "$pid" 2>/dev/null; then
      log "killing $name pid=$pid"
      kill "$pid" 2>/dev/null || true
      for _ in 1 2 3 4 5; do
        kill -0 "$pid" 2>/dev/null || break
        sleep 0.2
      done
      if kill -0 "$pid" 2>/dev/null; then
        kill -9 "$pid" 2>/dev/null || true
      fi
    fi
    rm -f "$file"
  fi
  # Clear stray listeners on THIS tenant's port only (never other agents' ports)
  if [[ "$name" == "listener" ]]; then
    local p
    p="$(ss -ltnp 2>/dev/null | awk -v PORT="$PORT" 'BEGIN{pat=":" PORT "([^0-9]|$)"} $0 ~ pat {print}' | sed -n 's/.*pid=\([0-9]*\).*/\1/p' | head -1 || true)"
    if [[ -n "${p:-}" ]]; then
      log "killing stray listener on :$PORT pid=$p"
      kill "$p" 2>/dev/null || true
      sleep 0.3
      kill -9 "$p" 2>/dev/null || true
    fi
  fi
}

ensure_secret() {
  if [[ ! -s "$SECRET_FILE" ]]; then
    openssl rand -hex 32 > "$SECRET_FILE"
    chmod 600 "$SECRET_FILE"
    log "minted webhook-secret"
  else
    chmod 600 "$SECRET_FILE" 2>/dev/null || true
  fi
}

start_listener() {
  kill_pidfile "$LISTENER_PID_FILE" "listener"
  log "starting webhook listener on :$PORT (DATA_DIR set, not printed)"
  nohup env TELEGRAM_MCP_DATA_DIR="$DATA_DIR" TELEGRAM_WEBHOOK_PORT="$PORT" \
    node "$ROOT/src/webhook-listener.js" >>"$LOG_DIR/listener.log" 2>&1 &
  echo $! > "$LISTENER_PID_FILE"
  chmod 600 "$LISTENER_PID_FILE" 2>/dev/null || true
  for _ in $(seq 1 20); do
    if curl -fsS "$HEALTHZ" >/dev/null 2>&1; then
      log "listener healthy"
      return 0
    fi
    sleep 0.25
  done
  log "listener failed to become healthy"
  return 1
}

# Extract trycloudflared URL from log without printing it; write to PUBLIC_URL_FILE
start_cloudflared() {
  kill_pidfile "$TUNNEL_PID_FILE" "tunnel"
  if ! command -v cloudflared >/dev/null 2>&1; then
    log "cloudflared not installed"
    return 1
  fi
  local tlog="$LOG_DIR/tunnel.log"
  : > "$tlog"
  log "starting cloudflared quick tunnel"
  nohup cloudflared tunnel --url "http://127.0.0.1:${PORT}" --no-autoupdate \
    >>"$tlog" 2>&1 &
  echo $! > "$TUNNEL_PID_FILE"
  chmod 600 "$TUNNEL_PID_FILE" 2>/dev/null || true

  local url=""
  for _ in $(seq 1 40); do
    # Match trycloudflare.com URL from logs without echoing it
    url="$(grep -oE 'https://[a-zA-Z0-9.-]+\.trycloudflare\.com' "$tlog" 2>/dev/null | head -1 || true)"
    if [[ -n "$url" ]]; then
      printf '%s\n' "$url" > "$PUBLIC_URL_FILE"
      chmod 600 "$PUBLIC_URL_FILE"
      log "cloudflared public URL saved (contents not printed)"
      return 0
    fi
    sleep 0.5
  done
  log "cloudflared did not produce a URL in time"
  return 1
}

start_smee() {
  # Reuse existing smee public-url when present so Telegram setWebhook stays stable.
  # Only mint a new smee.io channel when none is saved yet (or force_new=1).
  local force_new="${1:-0}"
  kill_pidfile "$TUNNEL_PID_FILE" "tunnel"
  local channel=""
  if [[ "$force_new" != "1" && -s "$PUBLIC_URL_FILE" ]]; then
    channel="$(tr -d ' \n' < "$PUBLIC_URL_FILE" || true)"
    if [[ "$channel" == https://smee.io/* && "$channel" != "https://smee.io/new" ]]; then
      log "reusing existing smee channel (contents not printed)"
    else
      channel=""
    fi
  fi
  if [[ -z "$channel" ]]; then
    log "creating smee.io channel"
    channel="$(curl -fsSL -o /dev/null -w '%{url_effective}' https://smee.io/new)"
    if [[ -z "$channel" || "$channel" == "https://smee.io/new" ]]; then
      log "failed to create smee channel"
      return 1
    fi
    printf '%s\n' "$channel" > "$PUBLIC_URL_FILE"
    chmod 600 "$PUBLIC_URL_FILE"
    log "smee channel saved (contents not printed); starting smee-forward wrapper"
  else
    log "starting smee-forward wrapper for saved channel"
  fi
  unset channel
  local tlog="$LOG_DIR/tunnel.log"
  : > "$tlog"
  # Wrapper reads URL from public-url file — keeps channel out of process argv / ps
  nohup env TELEGRAM_MCP_DATA_DIR="$DATA_DIR" TELEGRAM_WEBHOOK_PORT="$PORT" \
    node "$ROOT/scripts/smee-forward.js" >>"$tlog" 2>&1 &
  echo $! > "$TUNNEL_PID_FILE"
  chmod 600 "$TUNNEL_PID_FILE" 2>/dev/null || true
  sleep 2
  if kill -0 "$(cat "$TUNNEL_PID_FILE")" 2>/dev/null; then
    log "smee-forward running"
    return 0
  fi
  log "smee-forward failed to stay up"
  return 1
}

run_set_webhook() {
  if [[ ! -s "$PUBLIC_URL_FILE" ]]; then
    log "no public-url; skip setWebhook"
    return 1
  fi
  set +e
  env TELEGRAM_MCP_DATA_DIR="$DATA_DIR" TELEGRAM_WEBHOOK_PORT="$PORT" \
    node "$ROOT/scripts/set-webhook.js"
  local rc=$?
  set -e
  if [[ $rc -eq 0 ]]; then
    log "setWebhook ok"
    return 0
  fi
  log "setWebhook failed rc=$rc"
  return $rc
}

ensure_tunnel_and_webhook() {
  # If we already have a smee public-url, reuse it (avoid rotating the Telegram webhook target).
  if [[ -s "$PUBLIC_URL_FILE" ]] && grep -q 'smee\.io/' "$PUBLIC_URL_FILE" 2>/dev/null; then
    log "existing smee public-url present; restarting forwarder + setWebhook"
    start_smee 0 || return 1
    run_set_webhook || return 1
    return 0
  fi
  # Prefer cloudflared; if setWebhook fails with resolve-host (exit 2) or cloudflared missing, use smee
  local mode="cloudflared"
  if start_cloudflared; then
    set +e
    run_set_webhook
    local rc=$?
    set -e
    if [[ $rc -eq 0 ]]; then
      return 0
    elif [[ $rc -eq 2 ]]; then
      log "setWebhook resolve-host failure; falling back to smee.io"
      mode="smee"
    else
      log "setWebhook failed; trying smee.io fallback"
      mode="smee"
    fi
  else
    mode="smee"
  fi

  if [[ "$mode" == "smee" ]]; then
    start_smee || return 1
    run_set_webhook || return 1
  fi
  return 0
}

health_loop() {
  log "entering health loop"
  while true; do
    if ! curl -fsS "$HEALTHZ" >/dev/null 2>&1; then
      log "healthz down; restarting listener"
      start_listener || true
      # re-set webhook after listener recovery (URL usually unchanged)
      run_set_webhook || true
    fi
    # tunnel liveness
    if [[ -f "$TUNNEL_PID_FILE" ]]; then
      local tpid
      tpid="$(tr -d ' \n' < "$TUNNEL_PID_FILE" || true)"
      if [[ -n "${tpid:-}" ]] && ! kill -0 "$tpid" 2>/dev/null; then
        log "tunnel dead; restarting tunnel + setWebhook"
        ensure_tunnel_and_webhook || true
      fi
    else
      log "no tunnel pid; ensuring tunnel"
      ensure_tunnel_and_webhook || true
    fi
    sleep 15
  done
}

cleanup() {
  log "supervisor shutting down"
  kill_pidfile "$LISTENER_PID_FILE" "listener"
  kill_pidfile "$TUNNEL_PID_FILE" "tunnel"
  rm -f "$SUPERVISOR_PID_FILE"
}
trap cleanup EXIT INT TERM

# --- main ---
log "DATA_DIR configured; PORT=$PORT (secrets not printed)"
ensure_secret
start_listener
ensure_tunnel_and_webhook || log "initial tunnel/webhook setup incomplete (will retry in health loop)"
health_loop
