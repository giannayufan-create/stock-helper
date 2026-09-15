# Combined SPA + Fastify API + Shioaji Python bridge (永豐行情)
FROM node:22-bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 python3-pip python3-venv curl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Frontend deps
COPY package.json package-lock.json* pnpm-lock.yaml* ./
RUN if [ -f package-lock.json ]; then npm ci; else npm install; fi

# Server deps
COPY server/package.json server/package-lock.json* ./server/
RUN cd server && if [ -f package-lock.json ]; then npm ci; else npm install; fi

# Shioaji bridge deps
COPY shioaji-bridge/requirements.txt ./shioaji-bridge/
RUN pip3 install --break-system-packages -r shioaji-bridge/requirements.txt

# Source
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
