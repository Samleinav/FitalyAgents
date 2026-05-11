FROM node:22-bookworm-slim

WORKDIR /app
RUN corepack enable pnpm
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates python3 make g++ pkg-config libvips-dev \
  && rm -rf /var/lib/apt/lists/*

COPY . .

RUN pnpm install --frozen-lockfile
RUN pnpm --filter fitalyagents build
RUN pnpm --filter @fitalyagents/dispatcher build
RUN pnpm --filter store-runtime build

EXPOSE 3000

ENV STORE_CONFIG_PATH=/app/apps/store-runtime/store.config.redis.json

CMD ["node", "apps/store-runtime/dist/main.js"]
