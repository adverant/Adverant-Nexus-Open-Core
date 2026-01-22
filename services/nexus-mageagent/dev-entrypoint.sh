#!/bin/sh
set -e

# MageAgent Development Entrypoint with Proper Memory Configuration

echo "Starting MageAgent in DEVELOPMENT mode with proper memory allocation..."
echo "Memory Configuration: --max-old-space-size=${MAX_OLD_SPACE_SIZE:-3072}"

# Export as NODE_OPTIONS for child processes
export NODE_OPTIONS="--max-old-space-size=${MAX_OLD_SPACE_SIZE:-3072} --expose-gc"

# Start with proper memory allocation
exec node \
  --max-old-space-size=${MAX_OLD_SPACE_SIZE:-3072} \
  --expose-gc \
  --inspect=0.0.0.0:9229 \
  node_modules/.bin/ts-node-dev \
  --respawn \
  --transpile-only \
  --exit-child \
  --max-memory=${MAX_OLD_SPACE_SIZE:-3072} \
  src/index.ts