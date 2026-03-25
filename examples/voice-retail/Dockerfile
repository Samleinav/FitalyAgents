# ── Stage 1: build ───────────────────────────────────────────────────────────
FROM node:20-alpine AS builder

WORKDIR /app

# Install pnpm
RUN corepack enable && corepack prepare pnpm@9.15.4 --activate

# Copy workspace manifests
COPY package.json pnpm-workspace.yaml turbo.json ./
COPY packages/core/package.json          ./packages/core/
COPY packages/asynctools/package.json    ./packages/asynctools/
COPY packages/dispatcher/package.json    ./packages/dispatcher/
COPY examples/voice-retail/package.json  ./examples/voice-retail/

# Install all deps (workspace)
RUN pnpm install --frozen-lockfile

# Copy source
COPY packages/  ./packages/
COPY examples/voice-retail/  ./examples/voice-retail/

# Build packages (core → asynctools → dispatcher)
RUN pnpm --filter fitalyagents build
RUN pnpm --filter asynctools build 2>/dev/null || true
RUN pnpm --filter dispatcher build 2>/dev/null || true

# Compile service.ts
RUN pnpm --filter voice-retail-example exec tsc \
      --target ES2022 \
      --module NodeNext \
      --moduleResolution NodeNext \
      --outDir examples/voice-retail/dist \
      --rootDir examples/voice-retail/src \
      --skipLibCheck \
      examples/voice-retail/src/service.ts

# ── Stage 2: runtime ──────────────────────────────────────────────────────────
FROM node:20-alpine AS runtime

WORKDIR /app

RUN corepack enable && corepack prepare pnpm@9.15.4 --activate

# Copy workspace manifests (runtime deps only)
COPY package.json pnpm-workspace.yaml ./
COPY packages/core/package.json          ./packages/core/
COPY packages/asynctools/package.json    ./packages/asynctools/
COPY packages/dispatcher/package.json    ./packages/dispatcher/
COPY examples/voice-retail/package.json  ./examples/voice-retail/

# Install production deps only
RUN pnpm install --frozen-lockfile --prod

# Copy built artifacts
COPY --from=builder /app/packages/core/dist/         ./packages/core/dist/
COPY --from=builder /app/packages/asynctools/dist/   ./packages/asynctools/dist/
COPY --from=builder /app/packages/dispatcher/dist/   ./packages/dispatcher/dist/
COPY --from=builder /app/examples/voice-retail/dist/ ./examples/voice-retail/dist/

ENV NODE_ENV=production

CMD ["node", "examples/voice-retail/dist/service.js"]
