#!/bin/sh
# Start Shioaji Python bridge (internal) + Node API (public).
set -e

BRIDGE_PORT="${SHIOAJI_BRIDGE_PORT:-18080}"
export SHIOAJI_BRIDGE_URL="${SHIOAJI_BRIDGE_URL:-http://127.0.0.1:${BRIDGE_PORT}}"

if [ -n "${SHIOAJI_API_KEY:-}" ] && [ -n "${SHIOAJI_SECRET_KEY:-}" ]; then
  echo "starting shioaji-bridge on ${BRIDGE_PORT}..."
  cd /app/shioaji-bridge
  python3 -m uvicorn app:app --host 127.0.0.1 --port "${BRIDGE_PORT}" &
  BRIDGE_PID=$!
  # wait until health responds (max ~45s)
  i=0
  while [ "$i" -lt 45 ]; do
    if curl -fsS "http://127.0.0.1:${BRIDGE_PORT}/health" >/dev/null 2>&1; then
      echo "shioaji-bridge ready"
      break
    fi
    i=$((i + 1))
    sleep 1
  done
  cd /app/server
else
  echo "SHIOAJI keys not set — bridge skipped"
fi

exec npx tsx src/index.ts
