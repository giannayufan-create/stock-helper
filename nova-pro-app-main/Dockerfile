# Combined SPA + Fastify API + Shioaji Python bridge (永豐行情)
FROM node:22-bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 python3-pip python3-venv python3-dev \
      gcc g++ make curl ca-certificates \
      libssl-dev libffi-dev \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Frontend deps (root is pnpm)
COPY package.json package-lock.json* pnpm-lock.yaml* ./
RUN if [ -f pnpm-lock.yaml ]; then \
      npm install -g pnpm@9.15.9 && pnpm install --frozen-lockfile; \
    elif [ -f package-lock.json ]; then npm ci; \
    else npm install; fi

# Shioaji bridge deps — fail the image build if import breaks
COPY shioaji-bridge/requirements.txt ./shioaji-bridge/
RUN pip3 install --break-system-packages --upgrade pip \
    && pip3 install --break-system-packages -r shioaji-bridge/requirements.txt \
    && python3 -c "import shioaji, fastapi, uvicorn; print('shioaji', shioaji.__version__)"

# Full source (server/node_modules is dockerignored)
COPY . .

# Guard: image must never ship a start script that calls npx tsx
RUN grep -n "npx tsx" /app/start-cloud.sh && \
      (echo "FATAL: start-cloud.sh still contains npx tsx" && exit 1) || \
      echo "start-cloud.sh ok (no npx tsx)"
RUN grep -q "start-cloud.sh v2" /app/start-cloud.sh \
    && echo "start-cloud marker ok"

# Install server deps AFTER COPY so nothing can wipe/replace them later
WORKDIR /app/server
RUN rm -rf node_modules \
    && npm install \
    && test -d node_modules/fastify \
    && test -f node_modules/tsx/package.json \
    && test -x node_modules/.bin/tsx -o -f node_modules/tsx/dist/cli.mjs \
    && node -e "require('fastify'); require('tsx/package.json'); console.log('server deps ok')"

WORKDIR /app
ENV VITE_API_BASE=
RUN npm run build

RUN chmod +x /app/start-cloud.sh

ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=8080
ENV SHIOAJI_BRIDGE_PORT=18080
ENV SHIOAJI_BRIDGE_URL=http://127.0.0.1:18080
ENV SHIOAJI_PRODUCTION=true
ENV START_CLOUD_MARKER=v2-no-npx
EXPOSE 8080

WORKDIR /app/server
# Absolute script path — do not rely on dashboard "Docker Command" defaults
CMD ["/bin/sh", "/app/start-cloud.sh"]
