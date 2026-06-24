#!/usr/bin/env bash
# Network smoke test — idle S0 baseline + optional WS load bots.
# Usage:
#   ./scripts/network-smoke.sh --duration 90
#   ./scripts/network-smoke.sh --duration 120 --clients 8 --max-blob-us 3000
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SERVER_BIN="$ROOT/server/bin/pirate-server"
AUTH_ENV="$ROOT/server/config/auth.env"
LOG="/tmp/pirate-network-smoke-$$.log"
DURATION=90
CLIENTS=0
MAX_BLOB_US=3500
START_SERVER=1

while [[ $# -gt 0 ]]; do
  case "$1" in
    --duration) DURATION="$2"; shift 2 ;;
    --clients) CLIENTS="$2"; shift 2 ;;
    --max-blob-us) MAX_BLOB_US="$2"; shift 2 ;;
    --no-start-server) START_SERVER=0; shift ;;
    *) echo "Unknown arg: $1"; exit 1 ;;
  esac
done

if [[ ! -x "$SERVER_BIN" ]]; then
  echo "Building server..."
  make -C "$ROOT/server"
fi

SERVER_PID=""
cleanup() {
  [[ -n "$SERVER_PID" ]] && kill "$SERVER_PID" 2>/dev/null || true
  wait "$SERVER_PID" 2>/dev/null || true
}
trap cleanup EXIT

if [[ "$START_SERVER" -eq 1 ]]; then
  if [[ -f "$AUTH_ENV" ]]; then
    set -a
    # shellcheck disable=SC1090
    source "$AUTH_ENV"
    set +a
  fi
  echo "Starting server (log: $LOG)..."
  "$SERVER_BIN" >"$LOG" 2>&1 &
  SERVER_PID=$!
  sleep 3
else
  LOG="${SMOKE_LOG:-/tmp/pirate-server.log}"
  echo "Using existing server log: $LOG"
fi

if [[ "$CLIENTS" -gt 0 ]]; then
  echo "Launching $CLIENTS load bots for ${DURATION}s..."
  node "$ROOT/server/tests/ws_load_bot.mjs" --clients "$CLIENTS" --duration "$DURATION" &
  BOT_PID=$!
fi

echo "Collecting metrics for ${DURATION}s..."
sleep "$DURATION"
[[ "${BOT_PID:-}" ]] && wait "$BOT_PID" 2>/dev/null || true

echo "--- Parsed server metrics ---"
BLOB_LAST=$(grep -o 'last_build=[0-9]*us' "$LOG" | tail -1 | grep -o '[0-9]*' || echo 0)
BLOB_MAX=$(grep -o 'max_build=[0-9]*us' "$LOG" | tail -1 | grep -o '[0-9]*' || echo 0)
TICK_OVERRUN=$(grep -c 'took [0-9]* us (budget: 33000 us)' "$LOG" 2>/dev/null || echo 0)
GS_TOTAL=$(grep 'gs payload stats' "$LOG" | tail -1 || echo "(no gs payload stats yet — rebuild server)")

echo "blob last_build: ${BLOB_LAST}us"
echo "blob max_build:  ${BLOB_MAX}us"
echo "tick overruns:   $TICK_OVERRUN"
echo "$GS_TOTAL"

FAIL=0
if [[ "$BLOB_LAST" -gt "$MAX_BLOB_US" ]]; then
  echo "FAIL: blob last_build ${BLOB_LAST}us > threshold ${MAX_BLOB_US}us"
  FAIL=1
fi

if curl -sf http://127.0.0.1:8081/api/performance >/dev/null 2>&1; then
  echo "--- Admin /api/performance ---"
  curl -s http://127.0.0.1:8081/api/performance | head -20
fi

exit $FAIL
