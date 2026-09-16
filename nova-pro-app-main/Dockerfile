# Combined SPA + Fastify API + Shioaji Python bridge (永豐行情)
FROM node:22-bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 python3-pip python3-venv python3-dev \
      gcc g++ make curl ca-certificates \
      libssl-dev libffi-dev \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Frontend deps (root is pnpm; prefer lockfile when present, else npm install)
COPY package.json package-lock.json* pnpm-lock.yaml* ./
RUN if [ -f package-lock.json ]; then npm ci; \
    elif [ -f pnpm-lock.yaml ]; then npm install -g pnpm@9.15.9 && pnpm install --frozen-lockfile; \
    else npm install; fi

# Server deps — NEVER reuse a broken lock that points at ../node_modules/.pnpm
# (local pnpm hoist lockfiles break Docker npm ci and leave fastify missing at runtime)
COPY server/package.json ./server/
WORKDIR /app/server
# Install ALL declared deps (include tsx). Do not rely on broken package-lock
# that linked to host pnpm paths — that left fastify missing at runtime.
RUN npm install \
    && test -d node_modules/fastify \
    && test -f node_modules/tsx/package.json \
    && node -e "require('fastify'); require('tsx/package.json'); console.log('server deps ok')"

WORKDIR /app

# Shioaji bridge deps — fail the image build if import breaks
COPY shioaji-bridge/requirements.txt ./shioaji-bridge/
RUN pip3 install --break-system-packages --upgrade pip \
    && pip3 install --break-system-packages -r shioaji-bridge/requirements.txt \
    && python3 -c "import shioaji, fastapi, uvicorn; print('shioaji', shioaji.__version__)"

# Source (node_modules excluded via .dockerignore)
COPY . .

# Build SPA (relative /api — same origin when Fastify serves dist)
ENV VITE_API_BASE=
RUN npm run build

RUN chmod +x /app/start-cloud.sh

ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=8080
ENV SHIOAJI_BRIDGE_PORT=18080
ENV SHIOAJI_BRIDGE_URL=http://127.0.0.1:18080
ENV SHIOAJI_PRODUCTION=true
EXPOSE 8080

WORKDIR /app/server
CMD ["/app/start-cloud.sh"]
