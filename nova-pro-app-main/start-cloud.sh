#!/bin/sh
# Start Shioaji Python bridge (internal) + Node API (public).
set -e

BRIDGE_PORT="${SHIOAJI_BRIDGE_PORT:-18080}"
export SHIOAJI_BRIDGE_URL="${SHIOAJI_BRIDGE_URL:-http://127.0.0.1:${BRIDGE_PORT}}"
BRIDGE_LOG=/tmp/shioaji-bridge.log

if [ -n "${SHIOAJI_API_KEY:-}" ] && [ -n "${SHIOAJI_SECRET_KEY:-}" ]; then
  echo "starting shioaji-bridge on ${BRIDGE_PORT}..."
  if ! python3 -c "import shioaji; print('shioaji', shioaji.__version__)" ; then
    echo "FATAL: shioaji python package import failed — rebuild Docker image"
    exit 1
  fi
  cd /app/shioaji-bridge
  python3 -m uvicorn app:app --host 127.0.0.1 --port "${BRIDGE_PORT}" >"${BRIDGE_LOG}" 2>&1 &
  BRIDGE_PID=$!
  # wait until health responds (max ~60s — login can be slow)
  i=0
  ready=0
  while [ "$i" -lt 60 ]; do
    if ! kill -0 "${BRIDGE_PID}" 2>/dev/null; then
      echo "FATAL: shioaji-bridge exited early. Log:"
      cat "${BRIDGE_LOG}" || true
      exit 1
    fi
    if curl -fsS "http://127.0.0.1:${BRIDGE_PORT}/health" >/dev/null 2>&1; then
      echo "shioaji-bridge ready"
      ready=1
      break
    fi
    i=$((i + 1))
    sleep 1
  done
  if [ "$ready" -ne 1 ]; then
    echo "WARN: shioaji-bridge health timeout — continuing with Node (will fall back). Log:"
    cat "${BRIDGE_LOG}" || true
  fi
  cd /app/server
else
  echo "SHIOAJI keys not set — bridge skipped"
fi

# Bind Render $PORT ASAP (public HTTP). Bridge stays on 127.0.0.1:18080 only.
exec npx tsx src/index.ts
