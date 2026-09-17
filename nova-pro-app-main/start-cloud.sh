#!/bin/sh
# Start Node API first (public health), then optional Shioaji bridge in background.
# Render Free dies with 502 if we block on bridge before listen.
set -e

echo "=== start-cloud.sh v3 (node-first) marker=${START_CLOUD_MARKER:-unset} ==="
echo "cwd=$(pwd) node=$(node -v 2>/dev/null || echo missing)"

BRIDGE_PORT="${SHIOAJI_BRIDGE_PORT:-18080}"
export SHIOAJI_BRIDGE_URL="${SHIOAJI_BRIDGE_URL:-http://127.0.0.1:${BRIDGE_PORT}}"
BRIDGE_LOG=/tmp/shioaji-bridge.log

start_bridge_bg() {
  if [ -z "${SHIOAJI_API_KEY:-}" ] || [ -z "${SHIOAJI_SECRET_KEY:-}" ]; then
    echo "SHIOAJI keys not set — bridge skipped"
    return 0
  fi
  echo "starting shioaji-bridge on ${BRIDGE_PORT} (background)..."
  if ! python3 -c "import shioaji; print('shioaji', shioaji.__version__)" ; then
    echo "WARN: shioaji import failed — continuing without bridge"
    return 0
  fi
  (
    cd /app/shioaji-bridge
    python3 -m uvicorn app:app --host 127.0.0.1 --port "${BRIDGE_PORT}" >"${BRIDGE_LOG}" 2>&1
  ) &
  BRIDGE_PID=$!
  # Soft wait — never block Node listen longer than ~15s
  i=0
  while [ "$i" -lt 15 ]; do
    if ! kill -0 "${BRIDGE_PID}" 2>/dev/null; then
      echo "WARN: shioaji-bridge exited early. Log:"
      cat "${BRIDGE_LOG}" || true
      return 0
    fi
    if curl -fsS "http://127.0.0.1:${BRIDGE_PORT}/health" >/dev/null 2>&1; then
      echo "shioaji-bridge ready"
      return 0
    fi
    i=$((i + 1))
    sleep 1
  done
  echo "WARN: shioaji-bridge still starting — Node will fall back if needed"
  return 0
}

# Kick bridge first but do not fail the container on it
start_bridge_bg || true

cd /app/server

if [ ! -d ./node_modules/fastify ]; then
  echo "FATAL: ./node_modules/fastify missing — Docker image did not install server deps"
  ls -la ./node_modules 2>/dev/null | head -80 || true
  exit 1
fi
if [ ! -x ./node_modules/.bin/tsx ] && [ ! -f ./node_modules/tsx/dist/cli.mjs ]; then
  echo "FATAL: local tsx binary missing under ./node_modules"
  ls -la ./node_modules/.bin 2>/dev/null | head -40 || true
  exit 1
fi

echo "starting Node API with LOCAL tsx (fastify present)"
if [ -x ./node_modules/.bin/tsx ]; then
  exec ./node_modules/.bin/tsx src/index.ts
fi
exec node ./node_modules/tsx/dist/cli.mjs src/index.ts
