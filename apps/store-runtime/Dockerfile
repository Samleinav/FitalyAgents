FROM node:22-bookworm-slim

WORKDIR /app
RUN corepack enable pnpm

COPY . .

RUN pnpm install --frozen-lockfile
RUN pnpm --filter fitalyagents build
RUN pnpm --filter @fitalyagents/dispatcher build
RUN pnpm --filter store-runtime build

EXPOSE 3000

ENV STORE_CONFIG_PATH=/app/apps/store-runtime/store.config.redis.json

CMD ["node", "apps/store-runtime/dist/main.js"]
