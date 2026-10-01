# ---- Builder: install dependencies and compile TypeScript ----
FROM node:22-bookworm AS builder

# better-sqlite3 needs a compiler toolchain if no prebuilt binary matches.
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists

WORKDIR /app

# Workspace metadata first, so dependency install is cached in its own layer.
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/api/package.json apps/api/

RUN npm ci --workspace @mediflow/shared --workspace @mediflow/api --include-workspace-root=false

COPY tsconfig.base.json ./
COPY packages/shared packages/shared
COPY apps/api apps/api

RUN npm run build --workspace @mediflow/shared \
  && npm run build --workspace @mediflow/api

# ---- Runner: production-only image ----
FROM node:22-bookworm-slim AS runner

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8080 \
    DATABASE_FILE=/data/mediflow.db

WORKDIR /app

COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/api/package.json apps/api/

# Production dependencies only. better-sqlite3 ships prebuilt binaries for
# debian/node22; if the install ever needs compiling, extend this stage with
# the same toolchain as the builder.
RUN npm ci --omit=dev --workspace @mediflow/shared --workspace @mediflow/api --include-workspace-root=false

COPY --from=builder /app/packages/shared/dist packages/shared/dist
COPY --from=builder /app/apps/api/dist apps/api/dist

# SQLite lives on a mounted volume in production (/data). Cloud Run mounts a
# persistent volume here; on a plain VM bind-mount a host directory instead.
VOLUME ["/data"]

EXPOSE 8080

CMD ["node", "apps/api/dist/index.js"]
