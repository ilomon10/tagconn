# syntax=docker/dockerfile:1
#
# tagconn server image. Multi-stage build:
#   base  -> pnpm via corepack, build tooling for native deps (better-sqlite3)
#   deps  -> full workspace install (cached by manifests only)
#   build -> compile @tagconn/server (tsup) + produce a self-contained prod
#            deploy dir (dist + prod-only node_modules, native build matches
#            this image's glibc/arch because it's built here, not on the host)
#   run   -> slim runtime, non-root, healthcheck
#
# Build from the repo root:
#   docker build -f docker/server.Dockerfile -t tagconn-server .

ARG NODE_IMAGE=node:24-bookworm-slim
ARG PNPM_VERSION=11.20.0

# ---------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS base
ARG PNPM_VERSION
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable && corepack prepare pnpm@${PNPM_VERSION} --activate
# Build tools for native modules (better-sqlite3) in case no prebuilt binary
# matches this platform/arch. Kept out of the final runtime stage.
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

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
# Full source: tsup bundles @tagconn/shared from TS source (no separate
# build step for that package), and roles/skills are plain files.
COPY . .
RUN pnpm --filter @tagconn/server build
# Self-contained prod artifact: dist + production-only node_modules with the
# workspace deps (@tagconn/shared, @tagconn/agent-templates) resolved in.
# pnpm v10+ requires --legacy for non-injected workspaces (no
# dependenciesMeta.injected set on these packages).
RUN pnpm --filter @tagconn/server deploy --prod --legacy /out

# ---------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS run
ENV NODE_ENV=production
ENV OFFICE_STORAGE__DB_PATH=/data/office.db
ENV OFFICE_TEMPLATES_DIR=/app/templates
WORKDIR /app

COPY --from=build /out ./
COPY packages/agent-templates/roles ./templates/roles

# Writable data dir for SQLite; owned by the default `node` user (uid/gid
# 1000 in the upstream image) so it also works when docker-compose overrides
# the container user to the host UID/GID (the common 1000:1000 case). Only
# /data is chowned - app code under /app stays root-owned (read-only to the
# runtime user) so a compromised process can't rewrite its own code.
RUN mkdir -p /data && chown -R node:node /data
USER node

EXPOSE 4317
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:4317/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/main.js"]
