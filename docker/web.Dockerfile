# syntax=docker/dockerfile:1
#
# tagconn web image: build the Vite/React/Phaser app, serve the static
# output with nginx (also proxies /api and /socket.io to the server).
#
# Build from the repo root:
#   docker build -f docker/web.Dockerfile -t tagconn-web .

# Pinned to the latest verified 24.x: better-sqlite3 13.x (N-API rewrite) no
# longer hits the assertion from docs/decisions.md #24 (see #26 for the retest).
ARG NODE_IMAGE=node:24.21.0-bookworm-slim
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
# Only the web app and its workspace deps: the server's native modules (better-sqlite3) would need a
# compiler toolchain this image doesn't have and the static build never uses them.
RUN pnpm install --frozen-lockfile --filter "@tagconn/web..."

# ---------------------------------------------------------------------------
FROM deps AS build
WORKDIR /app
COPY . .
# pnpm 11 would otherwise re-install the whole workspace (verify-deps-before-run) and pull the server's
# native deps back in; the filtered install above already has everything the web build needs.
RUN pnpm --config.verify-deps-before-run=false --filter @tagconn/web build

# ---------------------------------------------------------------------------
FROM nginx:alpine AS run
COPY --from=build /app/apps/web/dist /usr/share/nginx/html
COPY docker/nginx.conf /etc/nginx/nginx.conf

EXPOSE 4318
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -qO- http://127.0.0.1:4318/ >/dev/null 2>&1 || exit 1

CMD ["nginx", "-g", "daemon off;"]
