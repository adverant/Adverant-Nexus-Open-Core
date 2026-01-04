#!/bin/bash

##############################################################################
# FileProcessAgent Load Testing Runner
#
# Prepares test data and runs load testing scenarios using Artillery.
#
# Prerequisites:
# - Node.js and npm installed
# - Artillery installed: npm install -g artillery
# - FileProcessAgent services running
#
# Usage:
#   ./run-loadtest.sh [options]
#
# Options:
#   --scenario NAME      Run specific scenario (warmup/steady/ramp/spike/sustained/all)
#   --workers N          Ensure N workers before testing (default: 2)
#   --prepare-only       Only prepare test data, don't run tests
#   --skip-validation    Skip pre-test validation
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
SCENARIO="all"
WORKERS=2
PREPARE_ONLY=false
SKIP_VALIDATION=false
TEST_DATA_DIR="./test-data"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Parse arguments
while [[ $# -gt 0 ]]; do
    case $1 in
        --scenario)
            SCENARIO="$2"
            shift 2
            ;;
        --workers)
            WORKERS="$2"
            shift 2
            ;;
        --prepare-only)
            PREPARE_ONLY=true
            shift
            ;;
        --skip-validation)
            SKIP_VALIDATION=true
            shift
            ;;
        *)
            echo "Unknown option: $1"
            echo "Usage: $0 [--scenario NAME] [--workers N] [--prepare-only] [--skip-validation]"
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

print_info() {
    echo -e "${YELLOW}[INFO]${NC} $1"
}

print_header "FileProcessAgent Load Testing"
echo "Configuration:"
echo "  Scenario: $SCENARIO"
echo "  Workers: $WORKERS"
echo "  Prepare Only: $PREPARE_ONLY"
echo "  Skip Validation: $SKIP_VALIDATION"
echo ""

# Check prerequisites
if ! command -v node &> /dev/null; then
    print_error "Node.js is not installed. Install from https://nodejs.org/"
    exit 1
fi

if ! command -v artillery &> /dev/null; then
    print_error "Artillery is not installed. Install with: npm install -g artillery"
    exit 1
fi

print_success "Prerequisites check passed"

# Prepare test data
print_header "PREPARING TEST DATA"

mkdir -p "$TEST_DATA_DIR"

print_step "Generating small test document (~5KB)..."
cat > "$TEST_DATA_DIR/small-document.txt" << 'EOF'
FileProcessAgent Load Test Document - Small

This is a small test document for load testing purposes.
It contains minimal content to test basic processing speed.

Performance Metrics Table:
Metric      | Value
------------|-------
Size        | ~5KB
Complexity  | Low
OCR Tier    | Tesseract
Expected    | <2s

This document should process very quickly with minimal resource usage.
EOF
print_success "Small document generated"

print_step "Generating medium test document (~50KB)..."
cat > "$TEST_DATA_DIR/medium-document.txt" << 'EOF'
FileProcessAgent Load Test Document - Medium

Executive Summary:
This medium-sized document represents typical business content for load testing.
It includes tables, structured data, and multiple sections.

Performance Data:

Quarter | Revenue  | Expenses | Profit   | Margin
--------|----------|----------|----------|-------
Q1 2024 | $125,000 | $85,000  | $40,000  | 32%
Q2 2024 | $145,000 | $92,000  | $53,000  | 37%
Q3 2024 | $168,000 | $98,000  | $70,000  | 42%
Q4 2024 | $195,000 | $105,000 | $90,000  | 46%

Technical Specifications:

Component      | Model               | Capacity
---------------|--------------------|-----------
Processor      | Intel Xeon E5-2680 | 16 cores
Memory         | DDR4 ECC           | 128GB
Storage        | Samsung 970 Pro    | 2TB NVMe
Network        | Intel X540         | 10Gbps

Analysis:
The data shows consistent growth across all quarters with improving margins.
Q3 and Q4 demonstrated exceptional performance with margin expansion from 32% to 46%.
Investment in infrastructure paid off with 10Gbps network upgrade.

Recommendations:
1. Continue infrastructure investment trajectory
2. Scale to meet Q1 2025 projections
3. Expand team size to support growth
4. Implement advanced monitoring solutions

Performance Metrics Table:
Metric      | Value
------------|-------
Size        | ~50KB
Complexity  | Medium
OCR Tier    | Tesseract/GPT-4V
Expected    | 3-5s

This document tests typical business document processing with tables and structure.
EOF
print_success "Medium document generated"

print_step "Generating large test document (~200KB)..."
{
    echo "FileProcessAgent Load Test Document - Large"
    echo ""
    echo "COMPREHENSIVE TECHNICAL ANALYSIS REPORT"
    echo "========================================"
    echo ""

    for section in {1..15}; do
        echo "Section $section: Performance Analysis"
        echo "--------------------------------------"
        echo ""
        echo "Lorem ipsum dolor sit amet, consectetur adipiscing elit. Sed do eiusmod"
        echo "tempor incididunt ut labore et dolore magna aliqua. Ut enim ad minim"
        echo "veniam, quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea"
        echo "commodo consequat. Duis aute irure dolor in reprehenderit in voluptate"
        echo "velit esse cillum dolore eu fugiat nulla pariatur. Excepteur sint"
        echo "occaecat cupidatat non proident, sunt in culpa qui officia deserunt"
        echo "mollit anim id est laborum."
        echo ""

        echo "Performance Metrics Table $section:"
        echo "ID  | Component     | Value   | Status   | Timestamp"
        echo "----|---------------|---------|----------|-------------------"
        for row in {1..25}; do
            printf "%03d | System-$row    | %05d   | %-8s | 2024-10-22 %02d:%02d:00\n" \
                $row $(( RANDOM % 10000 )) "Active" $(( RANDOM % 24 )) $(( RANDOM % 60 ))
        done
        echo ""
    done

    echo "Performance Summary:"
    echo "Size: ~200KB | Complexity: High | Expected OCR: GPT-4V/Claude-Opus | Expected Time: 10-15s"
} > "$TEST_DATA_DIR/large-document.txt"
print_success "Large document generated"

# Create CSV for Artillery payload (if needed)
print_step "Creating Artillery payload CSV..."
cat > "$SCRIPT_DIR/test-documents.csv" << 'EOF'
filename,content
small-document.txt,Small test document for load testing
medium-document.txt,Medium business document with tables
large-document.txt,Large technical report with extensive data
EOF
print_success "Payload CSV created"

# Validation
if [ "$SKIP_VALIDATION" = false ]; then
    print_header "PRE-TEST VALIDATION"

    print_step "Checking API health..."
    HEALTH=$(curl -s "http://localhost:9096/health" || echo '{"status":"error"}')
    if ! echo "$HEALTH" | grep -q '"status":"ok"'; then
        print_error "API is not healthy. Start services first."
        exit 1
    fi
    print_success "API is healthy"

    print_step "Checking worker count..."
    ACTUAL_WORKERS=$(docker ps | grep "nexus-fileprocess-worker" | wc -l)
    if [ "$ACTUAL_WORKERS" -ne "$WORKERS" ]; then
        print_error "Expected $WORKERS workers, found $ACTUAL_WORKERS"
        print_info "Scale workers: docker-compose -f docker/docker-compose.nexus.yml up -d --scale nexus-fileprocess-worker=$WORKERS"
        exit 1
    fi
    print_success "Worker count validated: $WORKERS"

    print_step "Checking queue status..."
    QUEUE_STATS=$(curl -s "http://localhost:9096/api/queue/stats" || echo '{"success":false}')
    if ! echo "$QUEUE_STATS" | grep -q '"success":true'; then
        print_error "Queue is not operational"
        exit 1
    fi
    print_success "Queue is operational"
fi

if [ "$PREPARE_ONLY" = true ]; then
    print_info "Prepare-only mode. Test data ready at: $TEST_DATA_DIR"
    exit 0
fi

# Run load tests
print_header "RUNNING LOAD TESTS"

cd "$SCRIPT_DIR"

case $SCENARIO in
    warmup)
        print_step "Running warmup scenario (1 minute, 5 req/s)..."
        artillery run \
            --config loadtest-config.yml \
            --overrides '{"config":{"phases":[{"duration":60,"arrivalRate":5}]}}' \
            --output "loadtest-results-warmup.json"
        ;;
    steady)
        print_step "Running steady load scenario (5 minutes, 10 req/s)..."
        artillery run \
            --config loadtest-config.yml \
            --overrides '{"config":{"phases":[{"duration":300,"arrivalRate":10}]}}' \
            --output "loadtest-results-steady.json"
        ;;
    ramp)
        print_step "Running ramp-up scenario (10 minutes, 1->50 req/s)..."
        artillery run \
            --config loadtest-config.yml \
            --overrides '{"config":{"phases":[{"duration":600,"arrivalRate":1,"rampTo":50}]}}' \
            --output "loadtest-results-ramp.json"
        ;;
    spike)
        print_step "Running spike test scenario (1 minute, 100 req/s)..."
        artillery run \
            --config loadtest-config.yml \
            --overrides '{"config":{"phases":[{"duration":60,"arrivalRate":100}]}}' \
            --output "loadtest-results-spike.json"
        ;;
    sustained)
        print_step "Running sustained load scenario (30 minutes, 20 req/s)..."
        artillery run \
            --config loadtest-config.yml \
            --overrides '{"config":{"phases":[{"duration":1800,"arrivalRate":20}]}}' \
            --output "loadtest-results-sustained.json"
        ;;
    all)
        print_step "Running complete load test suite (all phases)..."
        artillery run \
            --config loadtest-config.yml \
            --output "loadtest-results-complete.json"
        ;;
    *)
        print_error "Unknown scenario: $SCENARIO"
        echo "Valid scenarios: warmup, steady, ramp, spike, sustained, all"
        exit 1
        ;;
esac

# Generate HTML report
print_header "GENERATING REPORT"

if [ -f "loadtest-results-${SCENARIO}.json" ]; then
    print_step "Converting results to HTML report..."
    artillery report "loadtest-results-${SCENARIO}.json" --output "loadtest-report-${SCENARIO}.html"
    print_success "Report generated: loadtest-report-${SCENARIO}.html"
else
    print_error "Results file not found"
fi

print_header "LOAD TEST COMPLETE"
print_success "Load testing finished successfully!"
echo ""
echo "Results:"
echo "  JSON: loadtest-results-${SCENARIO}.json"
echo "  HTML: loadtest-report-${SCENARIO}.html"
echo ""
echo "Next steps:"
echo "1. Open HTML report: open loadtest-report-${SCENARIO}.html"
echo "2. Monitor services: ./monitor-fileprocess-agent.sh"
echo "3. Check logs: docker-compose logs -f nexus-fileprocess-worker"
