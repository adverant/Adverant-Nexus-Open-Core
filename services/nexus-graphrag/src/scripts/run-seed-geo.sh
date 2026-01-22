#!/bin/bash
# Run geo data seeding script on the GraphRAG service
# This script can be run locally or on the server

set -e

echo "=== GraphRAG Geo Data Seeding ==="
echo ""

# Check if we're running inside the GraphRAG container or on the host
if [ -f "/.dockerenv" ]; then
    echo "Running inside Docker container"
    SCRIPT_DIR="/app/src/scripts"
else
    echo "Running on host - will execute via docker exec"
    CONTAINER_NAME="nexus-graphrag-1"

    # Check if container is running
    if ! docker ps --format '{{.Names}}' | grep -q "^${CONTAINER_NAME}$"; then
        echo "Error: Container ${CONTAINER_NAME} is not running"
        echo "Please start the GraphRAG service first"
        exit 1
    fi

    echo "Executing seed script inside container ${CONTAINER_NAME}..."
    docker exec -it ${CONTAINER_NAME} npx ts-node /app/src/scripts/seed-geo-data.ts
    exit $?
fi

# If running inside container
cd /app
npx ts-node src/scripts/seed-geo-data.ts
