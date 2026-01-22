# FileProcessAgent API Gateway Dockerfile
#
# Multi-stage build that compiles TypeScript during Docker build.
# No pre-built dist directory required.
#
# Build: docker build --build-arg CACHE_BUST=$(date +%s) -t adverant/fileprocess-agent-api:latest -f services/nexus-fileprocess/api/Dockerfile .
# Run: docker run -p 8096:8096 -p 8098:8098 --env-file .env.nexus adverant/fileprocess-agent-api:latest

# Cache-busting argument
ARG CACHE_BUST=unknown

# =============================================================================
# STAGE 1: Build
# =============================================================================
FROM --platform=linux/amd64 node:20-alpine AS builder

WORKDIR /build

# Copy package files
COPY services/nexus-fileprocess/api/package.json ./package.original.json
COPY services/nexus-fileprocess/api/tsconfig.json ./tsconfig.json

# Copy workspace package for build
COPY packages/nexus-telemetry/dist /tmp/nexus-telemetry/dist/
COPY packages/nexus-telemetry/package.json /tmp/nexus-telemetry/

# Remove workspace dependency from package.json (add manually after install)
# Also remove the package-lock.json workspace references by not using it
RUN cat package.original.json | \
    sed '/"@adverant\/nexus-telemetry":/d' > package.json

# Install ALL dependencies (including dev deps for build)
# Skip package-lock.json as it has workspace references that break in Docker
RUN npm install --legacy-peer-deps && \
    npm cache clean --force

# Copy nexus-telemetry into node_modules
RUN mkdir -p /build/node_modules/@adverant/nexus-telemetry && \
    cp -r /tmp/nexus-telemetry/* /build/node_modules/@adverant/nexus-telemetry/

# Copy source code
COPY services/nexus-fileprocess/api/src ./src

# Build TypeScript
RUN npm run build

# =============================================================================
# STAGE 2: Production
# =============================================================================
FROM --platform=linux/amd64 node:20-alpine

# Validate CACHE_BUST
ARG CACHE_BUST
RUN if [ "$CACHE_BUST" = "unknown" ]; then \
      echo ""; \
      echo "WARNING: CACHE_BUST not set - build may use cached layers"; \
      echo "For production, use: docker build --build-arg CACHE_BUST=\$(date +%s) ..."; \
      echo ""; \
    fi

# Create non-root user
RUN addgroup -g 1001 -S nodejs && \
    adduser -S nodejs -u 1001

# Set working directory
WORKDIR /app

# Copy package.json (modified to exclude workspace dep)
COPY --from=builder /build/package.json ./

# Install production dependencies only
RUN npm install --omit=dev && \
    npm cache clean --force

# Copy nexus-telemetry from builder
COPY --from=builder /build/node_modules/@adverant/nexus-telemetry ./node_modules/@adverant/nexus-telemetry

# Copy compiled dist from builder
COPY --from=builder --chown=nodejs:nodejs /build/dist ./dist

# Copy database migrations (CRITICAL: Required for DatabaseMigrator)
COPY --chown=nodejs:nodejs services/nexus-fileprocess/database ./database

# Set ownership
RUN chown -R nodejs:nodejs /app

# Switch to non-root user
USER nodejs

# Expose ports
EXPOSE 8096
EXPOSE 8098

# Health check
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD node -e "require('http').get('http://localhost:8096/health', (r) => {process.exit(r.statusCode === 200 ? 0 : 1)})"

# Start the server (using node directly for signal handling)
CMD ["node", "dist/server.js"]
