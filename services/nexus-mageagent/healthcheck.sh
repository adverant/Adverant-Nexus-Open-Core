#!/bin/sh
# MageAgent Health Check Script
# Purpose: Comprehensive health check for MageAgent service
# Returns: 0 if healthy, 1 if unhealthy

set -e

# Configuration
MAX_RETRIES=3
RETRY_DELAY=2
PORT=${PORT:-8080}

# Function to check service
check_service() {
    local service_name=$1
    local host=$2
    local port=$3

    nc -z -w 2 "$host" "$port" 2>/dev/null
    return $?
}

# Function to check HTTP endpoint
check_http() {
    local url=$1
    local max_time=${2:-5}

    curl -f -s -o /dev/null -w "%{http_code}" \
         --max-time "$max_time" \
         --connect-timeout 2 \
         "$url" 2>/dev/null
}

# Main health check logic
main() {
    # Check if service is listening
    if ! check_service "MageAgent" "localhost" "$PORT"; then
        echo "ERROR: MageAgent not listening on port $PORT"
        exit 1
    fi

    # Check health endpoint
    http_status=$(check_http "http://localhost:$PORT/health" 5)

    if [ "$http_status" = "200" ] || [ "$http_status" = "204" ]; then
        echo "OK: MageAgent is healthy"
        exit 0
    elif [ "$http_status" = "503" ]; then
        # Service is starting up
        echo "STARTING: MageAgent is initializing (HTTP $http_status)"
        exit 1
    else
        echo "ERROR: MageAgent health check failed (HTTP $http_status)"
        exit 1
    fi
}

# Execute with retry logic
retry_count=0
while [ $retry_count -lt $MAX_RETRIES ]; do
    if main; then
        exit 0
    fi

    retry_count=$((retry_count + 1))
    if [ $retry_count -lt $MAX_RETRIES ]; then
        sleep $RETRY_DELAY
    fi
done

echo "ERROR: Health check failed after $MAX_RETRIES attempts"
exit 1