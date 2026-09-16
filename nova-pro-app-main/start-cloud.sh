#!/bin/sh
# Start Shioaji Python bridge (internal) + Node API (public).
set -e

echo "=== start-cloud.sh v2 (no npx) marker=${START_CLOUD_MARKER:-unset} ==="
echo "cwd=$(pwd) node=$(node -v 2>/dev/null || echo missing)"
# If you still see npm warn exec ... tsx in Render logs, the service is NOT
# running this script (Docker Command override). Fix Dashboard → Docker Command.

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
else
  echo "SHIOAJI keys not set — bridge skipped"
fi

cd /app/server

# Never use npx — it can run a bare tsx without server node_modules (fastify missing).
if [ ! -d ./node_modules/fastify ]; then
  echo "FATAL: ./node_modules/fastify missing — Docker image did not install server deps"
  echo "Listing ./node_modules (first 80):"
  ls -la ./node_modules 2>/dev/null | head -80 || true
  exit 1
fi
if [ ! -x ./node_modules/.bin/tsx ] && [ ! -f ./node_modules/tsx/dist/cli.mjs ]; then
  echo "FATAL: local tsx binary missing under ./node_modules"
  ls -la ./node_modules/.bin 2>/dev/null | head -40 || true
  exit 1
fi

echo "starting Node API with LOCAL tsx (fastify present)"
# Prefer direct local binary path — immune to npm/npx PATH tricks.
if [ -x ./node_modules/.bin/tsx ]; then
  exec ./node_modules/.bin/tsx src/index.ts
fi
exec node ./node_modules/tsx/dist/cli.mjs src/index.ts
