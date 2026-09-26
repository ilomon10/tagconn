# syntax=docker/dockerfile:1
#
# tagconn web image: build the Vite/React/Phaser app, serve the static
# output with nginx (also proxies /api and /socket.io to the server).
#
# Build from the repo root:
#   docker build -f docker/web.Dockerfile -t tagconn-web .

# Pinned: Node 24.21 crashes in better-sqlite3 statement finalizers (see docs/decisions.md #24).
ARG NODE_IMAGE=node:24.16-bookworm-slim
ARG PNPM_VERSION=11.20.0

# ---------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS base
ARG PNPM_VERSION
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable && corepack prepare pnpm@${PNPM_VERSION} --activate

# ---------------------------------------------------------------------------
# Only the manifests needed to resolve the dependency graph, for cache
# efficiency: source changes elsewhere never invalidate `pnpm install`.
FROM base AS deps
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/server/package.json apps/server/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/shared/package.json packages/shared/package.json
COPY packages/hook/package.json packages/hook/package.json
COPY packages/agent-templates/package.json packages/agent-templates/package.json
COPY packages/tsconfig/package.json packages/tsconfig/package.json
RUN pnpm install --frozen-lockfile

# ---------------------------------------------------------------------------
FROM deps AS build
WORKDIR /app
COPY . .
RUN pnpm --filter @tagconn/web build

# ---------------------------------------------------------------------------
FROM nginx:alpine AS run
COPY --from=build /app/apps/web/dist /usr/share/nginx/html
COPY docker/nginx.conf /etc/nginx/nginx.conf

EXPOSE 4318
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -qO- http://127.0.0.1:4318/ >/dev/null 2>&1 || exit 1

CMD ["nginx", "-g", "daemon off;"]
