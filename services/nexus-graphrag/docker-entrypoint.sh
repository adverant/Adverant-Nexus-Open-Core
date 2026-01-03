#!/bin/sh
set -e

# Enhanced GraphRAG Docker Entrypoint with Resilience
echo "Starting GraphRAG service (Enhanced)..."
echo "Environment: ${NODE_ENV}"
echo "Port: ${PORT}"

# Function to wait for service with exponential backoff
wait_for_service() {
    local host=$1
    local port=$2
    local service_name=$3
    local max_wait=${4:-60}
    local waited=0
    local delay=1

    echo "Waiting for $service_name at ${host}:${port}..."

    while [ $waited -lt $max_wait ]; do
        if nc -z "$host" "$port" 2>/dev/null; then
            echo "$service_name is ready!"
            return 0
        fi
        echo "Waiting for $service_name... ($waited/$max_wait seconds)"
        sleep $delay
        waited=$((waited + delay))
        delay=$((delay * 2))
        if [ $delay -gt 10 ]; then
            delay=10
        fi
    done

    echo "WARNING: $service_name not ready after $max_wait seconds, continuing anyway"
    return 1
}

# Wait for PostgreSQL
wait_for_service "${POSTGRES_HOST}" "${POSTGRES_PORT:-5432}" "PostgreSQL" 60

# Run migrations in safe mode
if [ "$RUN_MIGRATIONS" != "false" ]; then
    echo "Preparing database migrations..."

    # First, ensure migrations table exists
    echo "Ensuring migrations table exists..."
    npx tsx -e "
        const { Client } = require('pg');
        const client = new Client({
            host: process.env.POSTGRES_HOST,
            port: process.env.POSTGRES_PORT || 5432,
            user: process.env.POSTGRES_USER,
            password: process.env.POSTGRES_PASSWORD,
            database: process.env.POSTGRES_DATABASE || process.env.POSTGRES_DB
        });

        async function ensureMigrationsTable() {
            try {
                await client.connect();

                // Ensure graphrag schema exists
                await client.query('CREATE SCHEMA IF NOT EXISTS graphrag');

                // Create migrations table in graphrag schema
                await client.query(\`
                    CREATE TABLE IF NOT EXISTS graphrag.schema_migrations (
                        filename VARCHAR(255) PRIMARY KEY,
                        checksum VARCHAR(64) NOT NULL DEFAULT '',
                        applied_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
                        execution_time_ms INTEGER,
                        success BOOLEAN DEFAULT true,
                        error_message TEXT
                    )
                \`);

                console.log('Migrations table ready');
                process.exit(0);
            } catch (error) {
                console.error('Failed to create migrations table:', error.message);
                process.exit(1);
            } finally {
                await client.end();
            }
        }

        ensureMigrationsTable();
    " || {
        echo "WARNING: Could not ensure migrations table, will try on startup"
    }

    # Run migrations with retry
    echo "Running database migrations..."
    MIGRATION_SUCCESS=false
    for i in 1 2 3; do
        if npx tsx src/database/migration-runner.ts 2>&1; then
            echo "Database migrations completed successfully!"
            MIGRATION_SUCCESS=true
            break
        else
            echo "Migration attempt $i failed, retrying in 5s..."
            sleep 5
        fi
    done

    if [ "$MIGRATION_SUCCESS" = "false" ]; then
        echo "WARNING: Migrations failed, service will start anyway and retry later"
    fi
fi

# Wait for other services (non-blocking)
wait_for_service "${REDIS_HOST}" "${REDIS_PORT:-6379}" "Redis" 30 || true
# Extract hostname from NEO4J_URI for connection test
# Note: Neo4j on ARM64/Rosetta 2 takes ~2 minutes to start, so wait 180s (3 minutes)
NEO4J_CONN_HOST=$(echo "${NEO4J_URI:-bolt://neo4j:7687}" | sed 's|bolt://||' | cut -d: -f1)
wait_for_service "${NEO4J_CONN_HOST}" "7687" "Neo4j" 180 || true
wait_for_service "${QDRANT_HOST}" "${QDRANT_PORT:-6333}" "Qdrant" 30 || true

# Create necessary directories
mkdir -p /app/logs /app/temp

# Start the service based on run mode
case "${RUN_MODE:-api}" in
    "api")
        echo "Starting GraphRAG API server..."
        exec npx tsx src/index.ts
        ;;
    "worker")
        echo "Starting GraphRAG worker..."
        exec npx tsx src/worker.ts
        ;;
    *)
        echo "ERROR: Unknown RUN_MODE: ${RUN_MODE}"
        exit 1
        ;;
esac