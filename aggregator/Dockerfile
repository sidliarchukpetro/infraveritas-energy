# syntax=docker/dockerfile:1.7
#
# InfraVeritas Energy aggregator — production container.
#
# Two-stage build:
#   1. builder: installs all deps (incl. devDeps for tsc), compiles src/ → dist/
#   2. runtime: copies dist/ + circuits/ + prod-only node_modules, runs as `node` user
#
# bb.js (Aztec) ships WASM, not native bindings — node:20-slim (glibc) is the
# safe choice. Alpine (musl) is smaller but risks edge incompatibilities with
# downstream native deps; 150MB savings not worth the operational risk.
#
# Build:   docker build -t infraveritas-aggregator:dev .
# Run:     docker run --rm -p 3000:3000 infraveritas-aggregator:dev
# Health:  curl localhost:3000/health

# ─── Builder ───────────────────────────────────────────────────────────────
FROM node:20-slim AS builder

WORKDIR /app

# Install all deps (incl. devDeps — needed for tsc compile step)
COPY package.json package-lock.json ./
RUN npm ci

# Copy build config + source
COPY tsconfig.json tsconfig.build.json ./
COPY src/ ./src/

# Compile TypeScript → dist/
RUN npx tsc -p tsconfig.build.json

# ─── Runtime ───────────────────────────────────────────────────────────────
FROM node:20-slim AS runtime

WORKDIR /app

ENV NODE_ENV=production \
    PORT=3000 \
    HOST=0.0.0.0

# Install ONLY production deps (no tsx, vitest, typescript, etc.)
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# Copy compiled output and circuit artifact
COPY --from=builder /app/dist ./dist
COPY circuits/ ./circuits/

# OCI image metadata
LABEL org.opencontainers.image.title="InfraVeritas Energy Aggregator" \
      org.opencontainers.image.description="ZK proof aggregator for IoT energy submissions" \
      org.opencontainers.image.source="https://github.com/sidliarchukpetro/infraveritas-energy" \
      org.opencontainers.image.licenses="Apache-2.0"

# Run as non-root (node:20-slim ships with `node` user uid 1000)
USER node

EXPOSE 3000

# Self-contained Node-based health check (no curl/wget needed in image)
HEALTHCHECK --interval=30s --timeout=10s --start-period=30s --retries=3 \
  CMD node -e "require('http').get('http://localhost:3000/health',(r)=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

CMD ["node", "dist/main.js"]
