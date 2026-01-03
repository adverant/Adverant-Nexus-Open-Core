#!/bin/sh
set -e

# MageAgent Docker Entrypoint Script
# Based on GraphRAG's successful deployment pattern

echo "Starting MageAgent service..."
echo "Environment: ${NODE_ENV}"
echo "Port: ${PORT}"
echo "WebSocket: Socket.IO on same port"

# Function to check service connectivity
check_service() {
    local service_name=$1
    local host=$2
    local port=$3
    local retries=15
    
    echo "Checking $service_name connection at $host:$port..."
    
    while [ $retries -gt 0 ]; do
        if nc -zv "$host" "$port" 2>&1 | grep -q succeeded; then
            echo "✓ $service_name is ready!"
            return 0
        else
            echo "Waiting for $service_name... ($retries attempts remaining)"
            retries=$((retries-1))
            sleep 2
        fi
    done
    
    echo "WARNING: $service_name not ready after 30 seconds at $host:$port"
    return 1
}

# Wait for critical services
if [ -n "$POSTGRES_HOST" ]; then
    check_service "PostgreSQL" "$POSTGRES_HOST" "${POSTGRES_PORT:-5432}" || {
        echo "ERROR: PostgreSQL is required but not available"
        exit 1
    }
fi

# Check other services (non-critical)
if [ -n "$REDIS_HOST" ]; then
    check_service "Redis" "$REDIS_HOST" "${REDIS_PORT:-6379}" || true
fi

if [ -n "$NEO4J_HOST" ]; then
    check_service "Neo4j" "$NEO4J_HOST" "${NEO4J_PORT:-7687}" || true
fi

if [ -n "$QDRANT_HOST" ]; then
    check_service "Qdrant" "$QDRANT_HOST" "${QDRANT_PORT:-6333}" || true
fi

# Check mem-agent service
if [ -n "$MEM_AGENT_ENDPOINT" ]; then
    # Extract host and port from URL
    MEM_AGENT_HOST=$(echo "$MEM_AGENT_ENDPOINT" | sed -E 's|https?://([^:/]+).*|\1|')
    MEM_AGENT_PORT=$(echo "$MEM_AGENT_ENDPOINT" | sed -E 's|.*:([0-9]+).*|\1|' || echo "8080")
    check_service "mem-agent" "$MEM_AGENT_HOST" "$MEM_AGENT_PORT" || true
fi

# Validate OpenRouter API key (Fail Fast - no silent failures)
if [ -z "$OPENROUTER_API_KEY" ] || [ "$OPENROUTER_API_KEY" = "dummy-key-for-startup" ]; then
    echo "========================================" >&2
    echo "FATAL ERROR: OPENROUTER_API_KEY not set" >&2
    echo "========================================" >&2
    echo "This service requires a valid OpenRouter API key." >&2
    echo "" >&2
    echo "Fix: Ensure docker/docker-compose.nexus.yml includes:" >&2
    echo "  env_file:" >&2
    echo "    - .env.nexus" >&2
    echo "" >&2
    echo "And .env.nexus contains:" >&2
    echo "  OPENROUTER_API_KEY=sk-or-v1-..." >&2
    echo "========================================" >&2
    exit 1
fi

echo "OpenRouter API key configured: ${OPENROUTER_API_KEY:0:10}..."

# Ensure directories exist
mkdir -p /var/log/mageagent /tmp/mageagent

# Validate and log memory configuration
# CRITICAL: Default to 4096MB to prevent heap exhaustion crashes
HEAP_SIZE_MB=${MAX_OLD_SPACE_SIZE:-4096}
echo "========================================"
echo "Memory Configuration Validation:"
echo "- Configured Heap Size: ${HEAP_SIZE_MB} MB"
echo "- 80% Warning Threshold: $((HEAP_SIZE_MB * 80 / 100)) MB"
echo "- Previous Issues: Crashed at 1532MB with 1536MB limit"
echo "- Recommended Minimum: 4096MB for orchestration workloads"

if [ "$HEAP_SIZE_MB" -lt 4096 ]; then
    echo "WARNING: Heap size ${HEAP_SIZE_MB}MB is below recommended 4096MB"
    echo "WARNING: May experience crashes during complex orchestration tasks"
fi
echo "========================================"

# Log startup information
echo "MageAgent Service Configuration:"
echo "- Mode: PRODUCTION (NO MOCK DATA)"
echo "- Port: ${PORT:-8080}"
echo "- OpenRouter: ${OPENROUTER_BASE_URL:-https://openrouter.ai/api/v1}"
echo "- Databases: Connected to vibe-data namespace"
echo "- WebSocket: Socket.IO enabled"
echo "========================================"

# Handle different run modes
case "${RUN_MODE:-server}" in
    "server")
        echo "Starting MageAgent orchestration server..."
        echo "Using tsx runtime for TypeScript execution"
        # CRITICAL FIX: Actually pass memory settings to Node.js via NODE_OPTIONS
        # Previous bug: Logged the args but didn't pass them, causing OOM at 2GB heap
        export NODE_OPTIONS="--max-old-space-size=${HEAP_SIZE_MB} --expose-gc"
        echo "NODE_OPTIONS: ${NODE_OPTIONS}"
        exec npx tsx --tsconfig tsconfig.json src/index.ts
        ;;
    "worker")
        echo "Starting MageAgent worker node..."
        echo "Using tsx runtime for TypeScript execution"
        # Workers can use less memory (still higher than previous default)
        WORKER_HEAP=$((HEAP_SIZE_MB / 2))
        # CRITICAL FIX: Actually pass memory settings to Node.js via NODE_OPTIONS
        export NODE_OPTIONS="--max-old-space-size=${WORKER_HEAP} --expose-gc"
        echo "NODE_OPTIONS: ${NODE_OPTIONS}"
        exec npx tsx --tsconfig tsconfig.json src/worker.ts
        ;;
    *)
        echo "ERROR: Unknown RUN_MODE: ${RUN_MODE}"
        exit 1
        ;;
esac
