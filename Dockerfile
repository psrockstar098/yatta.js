# Dockerfile — lean production image for Yatta (Bun runtime)
#
# Build:  docker build -t yatta .
# Run:    docker run -p 4000:4000 -e NODE_ENV=production -e STORAGE_SECRET=... yatta
#
# The container writes SQLite files and uploads to ./Database and ./storage,
# so mount those as a volume to persist data across restarts.

FROM oven/bun:1.4-alpine AS base
WORKDIR /app

# ── Dependencies ──────────────────────────────────────────────────────────
FROM base AS dependencies
COPY package.json bun.lock ./
# Frozen lockfile keeps the image reproducible; --production drops devDeps.
RUN bun install --frozen-lockfile --production

# ── Production runner ─────────────────────────────────────────────────────
FROM base AS runner
ENV NODE_ENV=production
ENV PORT=4000

# Copy installed dependencies from the cached layer.
COPY --from=dependencies /app/node_modules ./node_modules

COPY core_runtime ./core_runtime
COPY src ./src
COPY package.json tsconfig.json ./

# Writable locations for the SQLite databases and local upload disk.
RUN mkdir -p /app/Database /app/storage/uploads \
    && chown -R bun:bun /app

# Drop privileges: the server never needs root.
USER bun
EXPOSE 4000

# Cluster mode spawns one process per core behind SO_REUSEPORT.
# Set YATTA_CLUSTER_MODE=false to run a single process instead.
ENV YATTA_CLUSTER_MODE=true
CMD ["sh", "-c", "if [ \"$YATTA_CLUSTER_MODE\" = \"true\" ]; then exec bun run cluster; else exec bun run start; fi"]

# ── Orchestrator health probes ────────────────────────────────────────────
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD bun --eval "fetch('http://127.0.0.1:'+(process.env.PORT||4000)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
