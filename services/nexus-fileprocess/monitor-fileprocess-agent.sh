#!/bin/bash

##############################################################################
# FileProcessAgent Health Monitoring Script
#
# Continuous monitoring of FileProcessAgent services with:
# - Real-time health status
# - Queue statistics
# - Worker status
# - Resource utilization
# - Error detection
# - Alert thresholds
#
# Usage:
#   ./monitor-fileprocess-agent.sh [options]
#
# Options:
#   --interval N         Polling interval in seconds (default: 5)
#   --alert-threshold N  Alert when queue waiting > N (default: 100)
#   --log-file PATH      Save monitoring log (default: none)
#   --dashboard          Show dashboard view (default)
#   --continuous         Run continuously (Ctrl+C to stop)
#   --once               Run once and exit
##############################################################################

set -e

# Colors
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
MAGENTA='\033[0;35m'
NC='\033[0m' # No Color

# Configuration
API_URL="http://localhost:9096"
INTERVAL=5
ALERT_THRESHOLD=100
LOG_FILE=""
DASHBOARD=true
CONTINUOUS=true

# Parse arguments
while [[ $# -gt 0 ]]; do
    case $1 in
        --interval)
            INTERVAL="$2"
            shift 2
            ;;
        --alert-threshold)
            ALERT_THRESHOLD="$2"
            shift 2
            ;;
        --log-file)
            LOG_FILE="$2"
            shift 2
            ;;
        --once)
            CONTINUOUS=false
            shift
            ;;
        --continuous)
            CONTINUOUS=true
            shift
            ;;
        *)
            echo "Unknown option: $1"
            echo "Usage: $0 [--interval N] [--alert-threshold N] [--log-file PATH] [--once] [--continuous]"
            exit 1
            ;;
    esac
done

# Helper functions
log_message() {
    local message="$1"
    local timestamp=$(date "+%Y-%m-%d %H:%M:%S")
    if [ -n "$LOG_FILE" ]; then
        echo "[$timestamp] $message" >> "$LOG_FILE"
    fi
}

print_colored() {
    local color=$1
    local message=$2
    echo -e "${color}${message}${NC}"
}

get_status_color() {
    local status=$1
    case $status in
        "ok"|"ready"|"healthy"|"running")
            echo "$GREEN"
            ;;
        "degraded"|"warning")
            echo "$YELLOW"
            ;;
        "error"|"unhealthy"|"failed"|"down")
            echo "$RED"
            ;;
        *)
            echo "$NC"
            ;;
    esac
}

format_number() {
    local num=$1
    if [ "$num" -ge 1000000 ]; then
        echo "$(echo "scale=1; $num / 1000000" | bc)M"
    elif [ "$num" -ge 1000 ]; then
        echo "$(echo "scale=1; $num / 1000" | bc)K"
    else
        echo "$num"
    fi
}

clear_screen() {
    if [ "$DASHBOARD" = true ]; then
        clear
    fi
}

# Check if service is accessible
check_service() {
    if ! curl -s -f "$API_URL/health" > /dev/null 2>&1; then
        print_colored "$RED" "❌ ERROR: FileProcessAgent API is not accessible at $API_URL"
        print_colored "$YELLOW" "Make sure services are running: ./deploy-fileprocess-agent.sh"
        exit 1
    fi
}

# Main monitoring loop
monitor_once() {
    local timestamp=$(date "+%Y-%m-%d %H:%M:%S")

    # Fetch data
    HEALTH=$(curl -s "$API_URL/health" 2>/dev/null || echo '{"status":"error"}')
    HEALTH_DETAILED=$(curl -s "$API_URL/health/detailed" 2>/dev/null || echo '{"service":"unknown"}')
    QUEUE_STATS=$(curl -s "$API_URL/api/queue/stats" 2>/dev/null || echo '{"success":false}')

    # Parse health status
    HEALTH_STATUS=$(echo "$HEALTH" | jq -r '.status // "error"')
    SERVICE_NAME=$(echo "$HEALTH_DETAILED" | jq -r '.service // "FileProcessAgent"')
    UPTIME=$(echo "$HEALTH_DETAILED" | jq -r '.uptime // "unknown"')

    # Parse dependencies
    REDIS_STATUS=$(echo "$HEALTH_DETAILED" | jq -r '.dependencies.redis // "unknown"')
    POSTGRES_STATUS=$(echo "$HEALTH_DETAILED" | jq -r '.dependencies.postgres // "unknown"')
    GRAPHRAG_STATUS=$(echo "$HEALTH_DETAILED" | jq -r '.dependencies.graphrag // "unknown"')
    MAGEAGENT_STATUS=$(echo "$HEALTH_DETAILED" | jq -r '.dependencies.mageagent // "unknown"')

    # Parse queue stats
    QUEUE_SUCCESS=$(echo "$QUEUE_STATS" | jq -r '.success // false')
    if [ "$QUEUE_SUCCESS" = "true" ]; then
        QUEUE_WAITING=$(echo "$QUEUE_STATS" | jq -r '.stats.waiting // 0')
        QUEUE_ACTIVE=$(echo "$QUEUE_STATS" | jq -r '.stats.active // 0')
        QUEUE_COMPLETED=$(echo "$QUEUE_STATS" | jq -r '.stats.completed // 0')
        QUEUE_FAILED=$(echo "$QUEUE_STATS" | jq -r '.stats.failed // 0')
        QUEUE_DELAYED=$(echo "$QUEUE_STATS" | jq -r '.stats.delayed // 0')
    else
        QUEUE_WAITING=0
        QUEUE_ACTIVE=0
        QUEUE_COMPLETED=0
        QUEUE_FAILED=0
        QUEUE_DELAYED=0
    fi

    # Get worker count
    WORKER_COUNT=$(docker ps --filter "name=nexus-fileprocess-worker" --format "{{.Names}}" 2>/dev/null | wc -l)

    # Get container stats
    if docker stats --no-stream > /dev/null 2>&1; then
        API_STATS=$(docker stats --no-stream --format "{{.Name}}|{{.CPUPerc}}|{{.MemUsage}}|{{.MemPerc}}" | grep "fileprocess-api" | head -1)
        WORKER_STATS=$(docker stats --no-stream --format "{{.Name}}|{{.CPUPerc}}|{{.MemUsage}}|{{.MemPerc}}" | grep "fileprocess-worker" | head -1)

        if [ -n "$API_STATS" ]; then
            API_CPU=$(echo "$API_STATS" | cut -d'|' -f2)
            API_MEM=$(echo "$API_STATS" | cut -d'|' -f3)
        else
            API_CPU="N/A"
            API_MEM="N/A"
        fi

        if [ -n "$WORKER_STATS" ]; then
            WORKER_CPU=$(echo "$WORKER_STATS" | cut -d'|' -f2)
            WORKER_MEM=$(echo "$WORKER_STATS" | cut -d'|' -f3)
        else
            WORKER_CPU="N/A"
            WORKER_MEM="N/A"
        fi
    else
        API_CPU="N/A"
        API_MEM="N/A"
        WORKER_CPU="N/A"
        WORKER_MEM="N/A"
    fi

    # Calculate throughput estimate (if queue is processing)
    if [ "$QUEUE_ACTIVE" -gt 0 ] && [ "$WORKER_COUNT" -gt 0 ]; then
        # Rough estimate: 1200 files/hour/worker = 20 files/minute/worker
        ESTIMATED_THROUGHPUT=$((WORKER_COUNT * 20))
    else
        ESTIMATED_THROUGHPUT=0
    fi

    # Display dashboard
    if [ "$DASHBOARD" = true ]; then
        clear_screen

        echo "╔════════════════════════════════════════════════════════════════════════════╗"
        echo "║               FileProcessAgent Health Monitor Dashboard                    ║"
        echo "╚════════════════════════════════════════════════════════════════════════════╝"
        echo ""
        echo "Timestamp: $timestamp"
        echo "Refresh Interval: ${INTERVAL}s | Alert Threshold: $ALERT_THRESHOLD jobs"
        echo ""

        echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
        echo "SERVICE STATUS"
        echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

        STATUS_COLOR=$(get_status_color "$HEALTH_STATUS")
        print_colored "$STATUS_COLOR" "  Service:    $SERVICE_NAME [$HEALTH_STATUS]"
        echo "  Uptime:     $UPTIME"
        echo "  Workers:    $WORKER_COUNT active"
        echo ""

        echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
        echo "DEPENDENCIES"
        echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

        REDIS_COLOR=$(get_status_color "$REDIS_STATUS")
        POSTGRES_COLOR=$(get_status_color "$POSTGRES_STATUS")
        GRAPHRAG_COLOR=$(get_status_color "$GRAPHRAG_STATUS")
        MAGEAGENT_COLOR=$(get_status_color "$MAGEAGENT_STATUS")

        print_colored "$REDIS_COLOR" "  Redis:      $REDIS_STATUS"
        print_colored "$POSTGRES_COLOR" "  PostgreSQL: $POSTGRES_STATUS"
        print_colored "$GRAPHRAG_COLOR" "  GraphRAG:   $GRAPHRAG_STATUS"
        print_colored "$MAGEAGENT_COLOR" "  MageAgent:  $MAGEAGENT_STATUS"
        echo ""

        echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
        echo "QUEUE STATISTICS"
        echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

        # Alert if waiting queue is high
        if [ "$QUEUE_WAITING" -gt "$ALERT_THRESHOLD" ]; then
            print_colored "$RED" "  ⚠️  ALERT: High queue backlog detected!"
            echo ""
        fi

        echo "  Waiting:    $(format_number $QUEUE_WAITING)"
        print_colored "$CYAN" "  Active:     $(format_number $QUEUE_ACTIVE)"
        print_colored "$GREEN" "  Completed:  $(format_number $QUEUE_COMPLETED)"
        print_colored "$RED" "  Failed:     $(format_number $QUEUE_FAILED)"
        echo "  Delayed:    $(format_number $QUEUE_DELAYED)"
        echo ""

        if [ "$ESTIMATED_THROUGHPUT" -gt 0 ]; then
            echo "  Estimated Throughput: ~${ESTIMATED_THROUGHPUT} files/minute"
            echo ""
        fi

        echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
        echo "RESOURCE UTILIZATION"
        echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

        echo "  API Gateway:"
        echo "    CPU:      $API_CPU"
        echo "    Memory:   $API_MEM"
        echo ""
        echo "  Workers:"
        echo "    CPU:      $WORKER_CPU"
        echo "    Memory:   $WORKER_MEM"
        echo ""

        echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
        echo "QUICK ACTIONS"
        echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

        echo "  Scale workers:   docker-compose -f docker/docker-compose.nexus.yml up -d --scale nexus-fileprocess-worker=N"
        echo "  View API logs:   docker-compose -f docker/docker-compose.nexus.yml logs -f nexus-fileprocess-api"
        echo "  View worker logs: docker-compose -f docker/docker-compose.nexus.yml logs -f nexus-fileprocess-worker"
        echo "  Restart service: docker-compose -f docker/docker-compose.nexus.yml restart nexus-fileprocess-api"
        echo ""

        if [ "$CONTINUOUS" = true ]; then
            print_colored "$YELLOW" "Press Ctrl+C to stop monitoring..."
        fi
    else
        # Simple text output
        echo "[$timestamp] Status: $HEALTH_STATUS | Workers: $WORKER_COUNT | Queue: W:$QUEUE_WAITING A:$QUEUE_ACTIVE C:$QUEUE_COMPLETED F:$QUEUE_FAILED"
    fi

    # Log to file
    log_message "Status=$HEALTH_STATUS Workers=$WORKER_COUNT Queue_Waiting=$QUEUE_WAITING Queue_Active=$QUEUE_ACTIVE Queue_Completed=$QUEUE_COMPLETED Queue_Failed=$QUEUE_FAILED"

    # Alerts
    if [ "$QUEUE_WAITING" -gt "$ALERT_THRESHOLD" ]; then
        log_message "ALERT: Queue waiting count ($QUEUE_WAITING) exceeds threshold ($ALERT_THRESHOLD)"
    fi

    if [ "$HEALTH_STATUS" != "ok" ]; then
        log_message "ALERT: Service health status is $HEALTH_STATUS"
    fi

    if [ "$REDIS_STATUS" != "healthy" ] && [ "$REDIS_STATUS" != "connected" ]; then
        log_message "ALERT: Redis dependency status is $REDIS_STATUS"
    fi

    if [ "$POSTGRES_STATUS" != "healthy" ] && [ "$POSTGRES_STATUS" != "connected" ]; then
        log_message "ALERT: PostgreSQL dependency status is $POSTGRES_STATUS"
    fi
}

# Graceful shutdown handler
cleanup() {
    echo ""
    print_colored "$YELLOW" "Monitoring stopped."
    if [ -n "$LOG_FILE" ]; then
        print_colored "$BLUE" "Log saved to: $LOG_FILE"
    fi
    exit 0
}

trap cleanup SIGINT SIGTERM

# Initial check
check_service

# Main loop
if [ "$CONTINUOUS" = true ]; then
    while true; do
        monitor_once
        sleep "$INTERVAL"
    done
else
    monitor_once
fi
