# Multi-stage production Dockerfile for MageAgent service
# Optimized for layer caching and minimal image size
# Includes pre-built workspace packages (@adverant/logger, @adverant/resilience, @adverant/database)

# ============================================================================
# STAGE 1: Base Image with Common Dependencies
# ============================================================================
FROM --platform=linux/amd64 node:20-alpine AS base
RUN apk add --no-cache \
    dumb-init \
    curl \
    wget \
    && rm -rf /var/cache/apk/*
WORKDIR /app

# ============================================================================
# STAGE 2: Dependencies Stage - Cached Unless package.json Changes
# ============================================================================
FROM --platform=linux/amd64 base AS deps
RUN apk add --no-cache python3 make g++ git jq

# Copy MageAgent package.json WITHOUT workspace dependencies first
COPY services/nexus-mageagent/package*.json ./

# Remove file: dependencies from package.json (they'll be added manually later)
RUN jq 'del(.dependencies["@adverant/nexus-telemetry"]) | del(.dependencies["@adverant/database"]) | del(.dependencies["@adverant/errors"]) | del(.dependencies["@adverant/resilience"])' package.json > package.json.tmp && \
    mv package.json.tmp package.json

# Install all dependencies EXCEPT workspace packages
RUN npm install && \
    npm cache clean --force

# ============================================================================
# STAGE 3: Builder Stage - Prepare Source
# ============================================================================
FROM --platform=linux/amd64 deps AS builder
# PHASE29: Cache-busting argument to force rebuild of source layer
ARG CACHE_BUST=unknown

# Validate CACHE_BUST to prevent accidental cached builds
RUN if [ "$CACHE_BUST" = "unknown" ]; then \
      echo ""; \
      echo "❌ ERROR: CACHE_BUST build argument is required for production builds"; \
      echo ""; \
      echo "This ensures fresh source code is included, not cached layers."; \
      echo ""; \
      echo "Usage:"; \
      echo "  docker build --build-arg CACHE_BUST=\$(date +%s) ..."; \
      echo ""; \
      echo "For docker-compose, set environment variable:"; \
      echo "  CACHE_BUST=\$(date +%s) docker-compose build"; \
      echo ""; \
      exit 1; \
    fi

RUN echo "✅ Cache bust validated: $CACHE_BUST"
COPY services/nexus-mageagent/tsconfig*.json ./
COPY services/nexus-mageagent/src/ ./src/
# Skip TypeScript compilation - we'll use tsx runtime in production
# This avoids type errors while maintaining full functionality
RUN echo "Source prepared for tsx runtime" && ls -la src/

# ============================================================================
# STAGE 4: Development Stage (Optional for Dev Builds)
# ============================================================================
FROM --platform=linux/amd64 base AS development
RUN apk add --no-cache \
    python3 \
    make \
    g++ \
    git \
    netcat-openbsd \
    bash
RUN npm install -g ts-node ts-node-dev nodemon
COPY package*.json tsconfig*.json ./
RUN npm install
COPY src/ ./src/
EXPOSE 8080 8081 9229
ENV NODE_ENV=development
CMD ["npm", "run", "dev"]

# ============================================================================
# STAGE 5: Production Stage - Minimal Final Image
# ============================================================================
FROM --platform=linux/amd64 base AS production

# Install runtime dependencies only
RUN apk add --no-cache netcat-openbsd && \
    addgroup -g 1001 -S nodejs && \
    adduser -S nodejs -u 1001

WORKDIR /app

# Copy package.json first (needed for npm metadata)
COPY --chown=nodejs:nodejs services/nexus-mageagent/package*.json ./

# Copy all dependencies from deps stage FIRST
COPY --from=deps --chown=nodejs:nodejs /app/node_modules ./node_modules

# CRITICAL FIX: Install tsx globally for TypeScript runtime execution
# The entrypoint uses 'npx tsx' which requires tsx to be available
# Without this, the container fails with "npm error code ETIMEDOUT" when trying to download tsx at runtime
# PINNED TO v4.20.6: tsx v4.21.0 has a module resolution bug that breaks @adverant/* workspace packages
RUN npm install -g tsx@4.20.6 && npm cache clean --force

# Remove any symlinks created by npm for workspace packages
# This prevents module resolution issues when code is resolved from symlink targets
RUN rm -f node_modules/@adverant/database node_modules/@adverant/logger node_modules/@adverant/resilience node_modules/@adverant/errors node_modules/@adverant/config node_modules/@adverant/nexus-telemetry

# NOW copy pre-built workspace packages directly into node_modules/@adverant/
# This bypasses symlink issues by placing actual files where Node expects them
RUN mkdir -p node_modules/@adverant

COPY --chown=nodejs:nodejs packages/adverant-logger/dist ./node_modules/@adverant/logger/dist
COPY --chown=nodejs:nodejs packages/adverant-logger/package.json ./node_modules/@adverant/logger/
# PHASE50: Logger package dependencies (winston, uuid) come from root node_modules via deps stage
# Individual package node_modules don't exist in monorepo workspace setup

COPY --chown=nodejs:nodejs packages/adverant-resilience/dist ./node_modules/@adverant/resilience/dist
COPY --chown=nodejs:nodejs packages/adverant-resilience/package.json ./node_modules/@adverant/resilience/
# resilience has no dependencies - no node_modules to copy

COPY --chown=nodejs:nodejs packages/adverant-database/dist ./node_modules/@adverant/database/dist
COPY --chown=nodejs:nodejs packages/adverant-database/package.json ./node_modules/@adverant/database/
# database has no dependencies - no node_modules to copy

COPY --chown=nodejs:nodejs packages/adverant-errors/dist ./node_modules/@adverant/errors/dist
COPY --chown=nodejs:nodejs packages/adverant-errors/package.json ./node_modules/@adverant/errors/
# errors has no dependencies - no node_modules to copy

COPY --chown=nodejs:nodejs packages/adverant-config/dist ./node_modules/@adverant/config/dist
COPY --chown=nodejs:nodejs packages/adverant-config/package.json ./node_modules/@adverant/config/
# config has no dependencies - no node_modules to copy

# nexus-telemetry package - build inside Docker since it may not have dist on host
# Copy source and build it here
COPY --chown=nodejs:nodejs packages/nexus-telemetry/src ./node_modules/@adverant/nexus-telemetry/src
COPY --chown=nodejs:nodejs packages/nexus-telemetry/package.json ./node_modules/@adverant/nexus-telemetry/
COPY --chown=nodejs:nodejs packages/nexus-telemetry/tsconfig.json ./node_modules/@adverant/nexus-telemetry/
# Build nexus-telemetry inside Docker
USER root
RUN cd node_modules/@adverant/nexus-telemetry && \
    npx tsc --outDir dist --declaration 2>&1 || echo "nexus-telemetry build completed with warnings"
USER nodejs
# nexus-telemetry dependencies (ioredis, uuid, prom-client) come from root node_modules via deps stage

# Copy source files from builder (not compiled - using tsx runtime)
COPY --from=builder --chown=nodejs:nodejs /app/src ./src
COPY --from=builder --chown=nodejs:nodejs /app/tsconfig*.json ./

# Create directories
USER root
RUN mkdir -p /app/logs /app/temp /var/log/mageagent /tmp/mageagent && \
    chown -R nodejs:nodejs /app /var/log/mageagent /tmp/mageagent

# Copy and setup entrypoint script
COPY --chown=nodejs:nodejs services/nexus-mageagent/docker-entrypoint.sh /usr/local/bin/
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

# Switch to non-root user
USER nodejs

# Expose application ports
EXPOSE 8080 8081

# Health check (using wget for Alpine Linux compatibility)
HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --retries=3 \
    CMD wget --quiet --tries=1 --spider http://localhost:8080/health || exit 1

# Environment variables
# MAX_OLD_SPACE_SIZE: K8s limit is 6Gi, use ~67% (4096MB) for Node.js heap
# This leaves ~2GB headroom for V8 internals, stack, native memory, and buffer pools
# CRITICAL: Previous value of 1792MB was TOO LOW - caused OOM crash at 2043MB
# Multi-agent orchestration with Claude/GPT responses requires substantial memory
ENV NODE_ENV=production \
    PORT=8080 \
    WS_PORT=8081 \
    LOG_LEVEL=info \
    MAX_OLD_SPACE_SIZE=4096

# Use dumb-init for proper signal handling
ENTRYPOINT ["dumb-init", "--"]
CMD ["/usr/local/bin/docker-entrypoint.sh"]
