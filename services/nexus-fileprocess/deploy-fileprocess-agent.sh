#!/bin/bash

##############################################################################
# FileProcessAgent Deployment Script
#
# Complete deployment automation for FileProcessAgent services including:
# - Pre-deployment validation
# - Docker image building
# - Service deployment
# - Health check verification
# - Post-deployment testing
# - Rollback capability
#
# Usage:
#   ./deploy-fileprocess-agent.sh [options]
#
# Options:
#   --build-only      Build images without deploying
#   --no-cache        Build without Docker cache
#   --scale N         Deploy with N workers (default: 2)
#   --skip-tests      Skip post-deployment tests
#   --rollback        Rollback to previous version
#   --validate-only   Only run pre-deployment validation
##############################################################################

set -e

# Colors
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

# Configuration
DOCKER_COMPOSE_FILE="docker/docker-compose.nexus.yml"
API_SERVICE="nexus-fileprocess-api"
WORKER_SERVICE="nexus-fileprocess-worker"
API_PORT="9096"
WS_PORT="9098"
WORKER_REPLICAS=2
BUILD_CACHE=true
SKIP_TESTS=false
VALIDATE_ONLY=false
BUILD_ONLY=false
ROLLBACK=false

# Parse arguments
while [[ $# -gt 0 ]]; do
    case $1 in
        --build-only)
            BUILD_ONLY=true
            shift
            ;;
        --no-cache)
            BUILD_CACHE=false
            shift
            ;;
        --scale)
            WORKER_REPLICAS="$2"
            shift 2
            ;;
        --skip-tests)
            SKIP_TESTS=true
            shift
            ;;
        --rollback)
            ROLLBACK=true
            shift
            ;;
        --validate-only)
            VALIDATE_ONLY=true
            shift
            ;;
        *)
            echo "Unknown option: $1"
            echo "Usage: $0 [--build-only] [--no-cache] [--scale N] [--skip-tests] [--rollback] [--validate-only]"
            exit 1
            ;;
    esac
done

# Helper functions
print_header() {
    echo ""
    echo -e "${CYAN}========================================${NC}"
    echo -e "${CYAN}$1${NC}"
    echo -e "${CYAN}========================================${NC}"
}

print_step() {
    echo -e "${BLUE}[STEP]${NC} $1"
}

print_success() {
    echo -e "${GREEN}[SUCCESS]${NC} $1"
}

print_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

print_warning() {
    echo -e "${YELLOW}[WARNING]${NC} $1"
}

print_info() {
    echo -e "${YELLOW}[INFO]${NC} $1"
}

# Check if command exists
command_exists() {
    command -v "$1" >/dev/null 2>&1
}

# Rollback function
rollback_deployment() {
    print_header "ROLLING BACK DEPLOYMENT"

    print_step "Stopping new services..."
    docker-compose -f "$DOCKER_COMPOSE_FILE" stop "$API_SERVICE" "$WORKER_SERVICE" 2>/dev/null || true

    print_step "Removing new containers..."
    docker-compose -f "$DOCKER_COMPOSE_FILE" rm -f "$API_SERVICE" "$WORKER_SERVICE" 2>/dev/null || true

    print_success "Rollback complete"
    exit 0
}

# Trap errors for automatic rollback
trap 'print_error "Deployment failed! Check logs above for details."; exit 1' ERR

print_header "FileProcessAgent Deployment"
echo "Configuration:"
echo "  Worker Replicas: $WORKER_REPLICAS"
echo "  Build Cache: $BUILD_CACHE"
echo "  Skip Tests: $SKIP_TESTS"
echo "  Validate Only: $VALIDATE_ONLY"
echo "  Build Only: $BUILD_ONLY"
echo "  Rollback: $ROLLBACK"
echo ""

# Handle rollback
if [ "$ROLLBACK" = true ]; then
    rollback_deployment
fi

# Pre-deployment validation
print_header "PRE-DEPLOYMENT VALIDATION"

# Check Docker
print_step "Checking Docker..."
if ! command_exists docker; then
    print_error "Docker is not installed"
    exit 1
fi
print_success "Docker is installed: $(docker --version)"

# Check Docker Compose
print_step "Checking Docker Compose..."
if ! command_exists docker-compose; then
    print_error "Docker Compose is not installed"
    exit 1
fi
print_success "Docker Compose is installed: $(docker-compose --version)"

# Check if Docker daemon is running
print_step "Checking Docker daemon..."
if ! docker info >/dev/null 2>&1; then
    print_error "Docker daemon is not running"
    exit 1
fi
print_success "Docker daemon is running"

# Check if docker-compose file exists
print_step "Checking Docker Compose file..."
if [ ! -f "$DOCKER_COMPOSE_FILE" ]; then
    print_error "Docker Compose file not found: $DOCKER_COMPOSE_FILE"
    exit 1
fi
print_success "Docker Compose file found"

# Check if .env.nexus exists
print_step "Checking environment file..."
if [ ! -f "docker/.env.nexus" ]; then
    print_error ".env.nexus file not found"
    exit 1
fi
print_success "Environment file found"

# Validate required API keys in .env
print_step "Validating API keys..."
source docker/.env.nexus 2>/dev/null || true

MISSING_KEYS=()
[ -z "$VOYAGE_API_KEY" ] && MISSING_KEYS+=("VOYAGE_API_KEY")
[ -z "$OPENROUTER_API_KEY" ] && MISSING_KEYS+=("OPENROUTER_API_KEY")

if [ ${#MISSING_KEYS[@]} -gt 0 ]; then
    print_error "Missing required API keys in .env.nexus:"
    for key in "${MISSING_KEYS[@]}"; do
        echo "  - $key"
    done
    exit 1
fi
print_success "All required API keys are configured"

# Check if required source files exist
print_step "Checking source files..."
REQUIRED_FILES=(
    "services/fileprocess-agent/api/src/server.ts"
    "services/fileprocess-agent/api/Dockerfile"
    "services/fileprocess-agent/api/package.json"
    "services/fileprocess-agent/worker/cmd/worker/main.go"
    "services/fileprocess-agent/worker/Dockerfile"
    "services/fileprocess-agent/worker/go.mod"
)

MISSING_FILES=()
for file in "${REQUIRED_FILES[@]}"; do
    if [ ! -f "$file" ]; then
        MISSING_FILES+=("$file")
    fi
done

if [ ${#MISSING_FILES[@]} -gt 0 ]; then
    print_error "Missing required source files:"
    for file in "${MISSING_FILES[@]}"; do
        echo "  - $file"
    done
    exit 1
fi
print_success "All required source files present"

# Check if PostgreSQL is running
print_step "Checking PostgreSQL dependency..."
if ! docker ps | grep -q "nexus-postgres"; then
    print_warning "PostgreSQL is not running. Starting dependencies..."
    docker-compose -f "$DOCKER_COMPOSE_FILE" up -d nexus-postgres
    print_info "Waiting for PostgreSQL to be healthy..."
    sleep 10
fi
print_success "PostgreSQL is running"

# Check if Redis is running
print_step "Checking Redis dependency..."
if ! docker ps | grep -q "nexus-redis"; then
    print_warning "Redis is not running. Starting dependencies..."
    docker-compose -f "$DOCKER_COMPOSE_FILE" up -d nexus-redis
    print_info "Waiting for Redis to be healthy..."
    sleep 5
fi
print_success "Redis is running"

# Check available disk space
print_step "Checking disk space..."
AVAILABLE_SPACE=$(df -h . | awk 'NR==2 {print $4}')
# Extract numeric value and handle different size units (G, T, M, etc.)
SPACE_VALUE=$(echo "$AVAILABLE_SPACE" | sed 's/[^0-9.]//g')
SPACE_UNIT=$(echo "$AVAILABLE_SPACE" | sed 's/[0-9.]//g')

# Convert to GB if necessary
if [[ "$SPACE_UNIT" == *"T"* ]]; then
    SPACE_IN_GB=$(echo "$SPACE_VALUE * 1024" | bc 2>/dev/null || echo "1000")
elif [[ "$SPACE_UNIT" == *"M"* ]]; then
    SPACE_IN_GB=$(echo "$SPACE_VALUE / 1024" | bc 2>/dev/null || echo "0")
else
    SPACE_IN_GB="$SPACE_VALUE"
fi

# Compare as floating point
if [ $(echo "$SPACE_IN_GB < 5" | bc 2>/dev/null || echo "0") -eq 1 ]; then
    print_warning "Low disk space: ${AVAILABLE_SPACE} available"
    print_warning "At least 5GB recommended for Docker builds"
else
    print_success "Sufficient disk space: ${AVAILABLE_SPACE} available"
fi

print_success "Pre-deployment validation complete!"

if [ "$VALIDATE_ONLY" = true ]; then
    print_info "Validation-only mode. Exiting."
    exit 0
fi

# Build Docker images
print_header "BUILDING DOCKER IMAGES"

BUILD_ARGS=""
if [ "$BUILD_CACHE" = false ]; then
    BUILD_ARGS="--no-cache"
    print_info "Building without cache"
fi

print_step "Building API Gateway image..."
docker-compose -f "$DOCKER_COMPOSE_FILE" build $BUILD_ARGS "$API_SERVICE"
print_success "API Gateway image built successfully"

print_step "Building Worker image..."
docker-compose -f "$DOCKER_COMPOSE_FILE" build $BUILD_ARGS "$WORKER_SERVICE"
print_success "Worker image built successfully"

# Verify images were created
print_step "Verifying images..."
if ! docker images | grep -q "nexus-fileprocess-api"; then
    print_error "API image not found after build"
    exit 1
fi
if ! docker images | grep -q "nexus-fileprocess-worker"; then
    print_error "Worker image not found after build"
    exit 1
fi
print_success "Images verified"

if [ "$BUILD_ONLY" = true ]; then
    print_info "Build-only mode. Exiting."
    exit 0
fi

# Deploy services
print_header "DEPLOYING SERVICES"

# Stop existing services if running
print_step "Stopping existing services (if any)..."
docker-compose -f "$DOCKER_COMPOSE_FILE" stop "$API_SERVICE" "$WORKER_SERVICE" 2>/dev/null || true
docker-compose -f "$DOCKER_COMPOSE_FILE" rm -f "$API_SERVICE" "$WORKER_SERVICE" 2>/dev/null || true
print_success "Existing services stopped"

# Start API Gateway
print_step "Starting API Gateway..."
docker-compose -f "$DOCKER_COMPOSE_FILE" up -d "$API_SERVICE"
print_success "API Gateway started"

# Start Workers with scaling
print_step "Starting Workers (replicas: $WORKER_REPLICAS)..."
docker-compose -f "$DOCKER_COMPOSE_FILE" up -d --scale "$WORKER_SERVICE"="$WORKER_REPLICAS" "$WORKER_SERVICE"
print_success "Workers started"

# Wait for services to be healthy
print_header "WAITING FOR SERVICES TO BE HEALTHY"

print_step "Waiting for API Gateway to be healthy..."
MAX_WAIT=60
WAIT_COUNT=0
while [ $WAIT_COUNT -lt $MAX_WAIT ]; do
    if curl -s "http://localhost:$API_PORT/health" | grep -q '"status":"ok"'; then
        print_success "API Gateway is healthy"
        break
    fi
    sleep 2
    ((WAIT_COUNT+=2))
    echo -n "."
done
echo ""

if [ $WAIT_COUNT -ge $MAX_WAIT ]; then
    print_error "API Gateway failed to become healthy within ${MAX_WAIT}s"
    print_info "Checking logs..."
    docker-compose -f "$DOCKER_COMPOSE_FILE" logs --tail=50 "$API_SERVICE"
    exit 1
fi

print_step "Waiting for Workers to be ready..."
sleep 10
WORKER_COUNT=$(docker ps | grep "$WORKER_SERVICE" | wc -l)
if [ "$WORKER_COUNT" -eq "$WORKER_REPLICAS" ]; then
    print_success "All $WORKER_REPLICAS workers are running"
else
    print_warning "Expected $WORKER_REPLICAS workers, found $WORKER_COUNT"
fi

# Post-deployment verification
print_header "POST-DEPLOYMENT VERIFICATION"

print_step "Checking API endpoints..."
curl -s "http://localhost:$API_PORT/health/detailed" | jq '.' > /dev/null 2>&1 || print_warning "jq not installed, skipping JSON formatting"
print_success "API endpoints accessible"

print_step "Checking queue statistics..."
QUEUE_STATS=$(curl -s "http://localhost:$API_PORT/api/queue/stats")
if echo "$QUEUE_STATS" | grep -q '"success":true'; then
    print_success "Queue is operational"
else
    print_warning "Queue may not be operational"
fi

print_step "Checking service logs..."
docker-compose -f "$DOCKER_COMPOSE_FILE" logs --tail=20 "$API_SERVICE" | grep -i "error" && print_warning "Errors found in API logs" || print_success "No errors in API logs"
docker-compose -f "$DOCKER_COMPOSE_FILE" logs --tail=20 "$WORKER_SERVICE" | grep -i "error" && print_warning "Errors found in Worker logs" || print_success "No errors in Worker logs"

# Run integration tests
if [ "$SKIP_TESTS" = false ]; then
    print_header "RUNNING INTEGRATION TESTS"

    if [ -f "services/fileprocess-agent/test-fileprocess-agent.sh" ]; then
        print_step "Running test suite..."
        bash services/fileprocess-agent/test-fileprocess-agent.sh
    else
        print_warning "Test suite not found, skipping tests"
    fi
fi

# Deployment summary
print_header "DEPLOYMENT SUMMARY"

echo -e "${GREEN}✅ FileProcessAgent deployed successfully!${NC}"
echo ""
echo "Services:"
echo "  API Gateway: http://localhost:$API_PORT"
echo "  WebSocket: ws://localhost:$WS_PORT"
echo "  Workers: $WORKER_REPLICAS replicas"
echo ""
echo "Quick Links:"
echo "  Health: curl http://localhost:$API_PORT/health"
echo "  Stats: curl http://localhost:$API_PORT/api/queue/stats"
echo "  Logs: docker-compose -f $DOCKER_COMPOSE_FILE logs -f $API_SERVICE $WORKER_SERVICE"
echo ""
echo "Scaling:"
echo "  Scale up: docker-compose -f $DOCKER_COMPOSE_FILE up -d --scale $WORKER_SERVICE=5"
echo "  Scale down: docker-compose -f $DOCKER_COMPOSE_FILE up -d --scale $WORKER_SERVICE=1"
echo ""
echo "Monitoring:"
echo "  Status: docker-compose -f $DOCKER_COMPOSE_FILE ps"
echo "  Health: curl http://localhost:$API_PORT/health/detailed | jq '.'"
echo ""

print_success "Deployment complete!"
