# syntax=docker/dockerfile:1

# ---- Dependencies ------------------------------------------------------------
# better-sqlite3 is a native module. npm normally downloads a prebuilt binary;
# the build tools are the fallback when none matches the server (e.g. ARM hosts).
FROM node:22-bookworm-slim AS deps
WORKDIR /app
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

# ---- Runtime -----------------------------------------------------------------
FROM node:22-bookworm-slim
# tini: PID 1 that forwards SIGTERM and reaps the cron child processes
# gosu: drop from root to the "node" user after fixing volume permissions
RUN apt-get update \
  && apt-get install -y --no-install-recommends tini gosu tzdata \
  && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production \
    TZ=Europe/Berlin \
    PORT=8787 \
    CONFIG_PATH=/app/config.yaml \
    DB_PATH=/data/music-scraper.sqlite \
    REPORTS_DIR=/data/reports

WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json schema.sql config.yaml ./
COPY src ./src
COPY public ./public
COPY docker/entrypoint.sh /usr/local/bin/entrypoint.sh
# Strip CRLF in case the build context comes from a Windows checkout (core.autocrlf=true).
RUN sed -i 's/\r$//' /usr/local/bin/entrypoint.sh \
  && chmod +x /usr/local/bin/entrypoint.sh \
  && mkdir -p /data/reports \
  && chown -R node:node /data

EXPOSE 8787

# /api/health is exempt from Basic Auth. Node's built-in fetch avoids installing curl.
# Short interval: Coolify's Traefik does not route to a container until its first check has passed.
HEALTHCHECK --interval=10s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 8787) + '/api/health').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"

ENTRYPOINT ["tini", "--", "/usr/local/bin/entrypoint.sh"]
CMD ["node", "src/cli.js", "api"]
