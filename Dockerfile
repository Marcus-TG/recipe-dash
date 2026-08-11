# --- build stage ---
FROM node:26-bookworm-slim AS build
WORKDIR /app
# Toolchain in case better-sqlite3 has no prebuilt binary for this platform
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ \
 && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci
# Force the native build even if npm's script policy skipped install scripts
RUN npm rebuild better-sqlite3
COPY . .
RUN npm run build \
 && npm prune --omit=dev

# --- runtime stage ---
FROM node:26-bookworm-slim
ENV NODE_ENV=production PORT=3000 DATA_DIR=/data
# wget is only for the Docker healthcheck
RUN apt-get update \
 && apt-get install -y --no-install-recommends wget \
 && rm -rf /var/lib/apt/lists/* \
 && mkdir -p /data && chown node:node /data
WORKDIR /app
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/drizzle ./drizzle
COPY --chown=node:node package.json ./
USER node
EXPOSE 3000
VOLUME /data
CMD ["node", "dist/server/index.js"]
