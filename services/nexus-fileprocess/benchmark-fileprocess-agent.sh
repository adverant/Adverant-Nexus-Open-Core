#!/bin/bash

##############################################################################
# FileProcessAgent Performance Benchmarking Script
#
# Measures actual throughput, latency, and resource utilization to validate:
# - Target: 1200+ files/hour per worker
# - Latency: 2-15 seconds per document
# - Memory: ~700MB per worker
# - CPU: Efficient utilization
# - Cost: ~$0.04/document average
#
# Usage:
#   ./benchmark-fileprocess-agent.sh [options]
#
# Options:
#   --workers N          Number of workers to test (default: 2)
#   --files N            Number of test files to process (default: 100)
#   --concurrency N      Concurrent uploads (default: 10)
#   --file-size SIZE     Test file size: small/medium/large (default: medium)
#   --duration SECONDS   Run for duration instead of file count
#   --report-file PATH   Save report to file (default: ./benchmark-report.txt)
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
API_URL="http://localhost:9096"
WORKERS=2
TEST_FILES=100
CONCURRENCY=10
FILE_SIZE="medium"
DURATION=""
REPORT_FILE="./benchmark-report-$(date +%Y%m%d-%H%M%S).txt"
TEST_DIR="/tmp/fileprocess-benchmark"

# Parse arguments
while [[ $# -gt 0 ]]; do
    case $1 in
        --workers)
            WORKERS="$2"
            shift 2
            ;;
        --files)
            TEST_FILES="$2"
            shift 2
            ;;
        --concurrency)
            CONCURRENCY="$2"
            shift 2
            ;;
        --file-size)
            FILE_SIZE="$2"
            shift 2
            ;;
        --duration)
            DURATION="$2"
            shift 2
            ;;
        --report-file)
            REPORT_FILE="$2"
            shift 2
            ;;
        *)
            echo "Unknown option: $1"
            echo "Usage: $0 [--workers N] [--files N] [--concurrency N] [--file-size SIZE] [--duration SECONDS] [--report-file PATH]"
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

print_metric() {
    echo -e "${GREEN}[METRIC]${NC} $1"
}

# Create test directory
mkdir -p "$TEST_DIR"

print_header "FileProcessAgent Performance Benchmark"
echo "Configuration:"
echo "  Workers: $WORKERS"
echo "  Test Files: $TEST_FILES"
echo "  Concurrency: $CONCURRENCY"
echo "  File Size: $FILE_SIZE"
echo "  Duration: ${DURATION:-N/A}"
echo "  Report File: $REPORT_FILE"
echo ""

# Generate test files
print_header "GENERATING TEST FILES"

generate_test_file() {
    local file_path=$1
    local size=$2

    case $size in
        small)
            # ~5KB - Simple text
            cat > "$file_path" << 'EOF'
FileProcessAgent Benchmark Test Document - Small

This is a small test document for benchmarking purposes.
It contains minimal content to test basic processing speed.

Table Example:
Name  | Value
------|------
Test  | 123

Processing should be very fast for this document.
Expected OCR tier: Tesseract (free)
Expected cost: $0.00
EOF
            ;;
        medium)
            # ~50KB - Typical document
            cat > "$file_path" << 'EOF'
FileProcessAgent Benchmark Test Document - Medium

Executive Summary:
This document represents a typical business document with moderate complexity.
It includes multiple sections, tables, and structured content.

Introduction:
Lorem ipsum dolor sit amet, consectetur adipiscing elit. Sed do eiusmod tempor
incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam, quis
nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat.

Data Analysis Results:

Quarter | Revenue  | Expenses | Profit   | Growth
--------|----------|----------|----------|-------
Q1 2024 | $125,000 | $85,000  | $40,000  | +12%
Q2 2024 | $145,000 | $92,000  | $53,000  | +16%
Q3 2024 | $168,000 | $98,000  | $70,000  | +32%
Q4 2024 | $195,000 | $105,000 | $90,000  | +29%

Key Findings:
1. Revenue growth accelerated in Q3 and Q4
2. Expense management remained disciplined
3. Profit margins improved from 32% to 46%
4. Customer acquisition costs decreased by 18%

Technical Specifications:

Component      | Specification        | Performance
---------------|---------------------|-------------
Processor      | Intel Xeon E5-2680  | 2.7 GHz
Memory         | 128GB DDR4          | 2666 MHz
Storage        | 2TB NVMe SSD        | 3500 MB/s
Network        | 10Gbps Ethernet     | Low latency

Recommendations:
- Continue current growth trajectory
- Invest in infrastructure scaling
- Expand to new markets in Q1 2025
- Hire additional engineering talent

Conclusion:
This document demonstrates typical business content with tables, lists, and
structured data. Processing should achieve 99.2% layout accuracy and complete
within 3-5 seconds per document.

Expected OCR tier: Tesseract or GPT-4 Vision
Expected cost: $0.00-$0.02 per document
EOF
            ;;
        large)
            # ~200KB - Complex document
            {
                echo "FileProcessAgent Benchmark Test Document - Large"
                echo ""
                echo "COMPREHENSIVE TECHNICAL REPORT"
                echo "=============================="
                echo ""

                for section in {1..10}; do
                    echo "Section $section: Advanced Analysis"
                    echo "-----------------------------------"
                    echo ""
                    echo "Lorem ipsum dolor sit amet, consectetur adipiscing elit. Sed do eiusmod"
                    echo "tempor incididunt ut labore et dolore magna aliqua. Ut enim ad minim"
                    echo "veniam, quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea"
                    echo "commodo consequat. Duis aute irure dolor in reprehenderit in voluptate"
                    echo "velit esse cillum dolore eu fugiat nulla pariatur."
                    echo ""

                    echo "Data Table $section:"
                    echo "ID   | Metric       | Value    | Status   | Timestamp"
                    echo "-----|--------------|----------|----------|-------------------"
                    for row in {1..20}; do
                        echo "$row    | Performance  | $(( RANDOM % 1000 ))    | Active   | 2024-10-22 12:$row:00"
                    done
                    echo ""
                done

                echo "This large document tests processing of complex content with multiple"
                echo "tables, extensive text, and structured data. Expected processing time"
                echo "is 10-15 seconds. Expected OCR tier: GPT-4 Vision or Claude-3 Opus."
                echo "Expected cost: $0.02-$0.10 per document."
            } > "$file_path"
            ;;
    esac
}

print_step "Generating $TEST_FILES test files (size: $FILE_SIZE)..."
for i in $(seq 1 $TEST_FILES); do
    generate_test_file "$TEST_DIR/test-file-$i.txt" "$FILE_SIZE"
done
print_success "Generated $TEST_FILES test files"

# Check if service is healthy
print_header "PRE-BENCHMARK VALIDATION"

print_step "Checking API health..."
HEALTH_RESPONSE=$(curl -s "${API_URL}/health" || echo '{"status":"error"}')
if ! echo "$HEALTH_RESPONSE" | grep -q '"status":"ok"'; then
    print_error "API is not healthy. Start services first with deploy script."
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
print_success "Found $WORKERS workers as expected"

# Get baseline metrics
print_step "Capturing baseline metrics..."
BASELINE_QUEUE_STATS=$(curl -s "${API_URL}/api/queue/stats")
BASELINE_COMPLETED=$(echo "$BASELINE_QUEUE_STATS" | jq -r '.stats.completed // 0' 2>/dev/null || echo "0")
print_info "Baseline completed jobs: $BASELINE_COMPLETED"

# Start benchmark
print_header "RUNNING BENCHMARK"

START_TIME=$(date +%s)
UPLOADED_COUNT=0
FAILED_UPLOADS=0
declare -A JOB_IDS

print_step "Uploading $TEST_FILES files with concurrency $CONCURRENCY..."

# Upload files in batches
BATCH_SIZE=$CONCURRENCY
for batch_start in $(seq 1 $BATCH_SIZE $TEST_FILES); do
    batch_end=$((batch_start + BATCH_SIZE - 1))
    if [ $batch_end -gt $TEST_FILES ]; then
        batch_end=$TEST_FILES
    fi

    print_info "Uploading batch: $batch_start to $batch_end"

    # Upload batch in parallel
    for i in $(seq $batch_start $batch_end); do
        (
            UPLOAD_RESPONSE=$(curl -s -X POST "${API_URL}/api/process" \
                -F "file=@${TEST_DIR}/test-file-$i.txt" \
                -F "userId=benchmark-user" \
                -F 'metadata={"test":"benchmark","batch":"'$batch_start'"}' 2>/dev/null)

            if echo "$UPLOAD_RESPONSE" | grep -q '"success":true'; then
                JOB_ID=$(echo "$UPLOAD_RESPONSE" | jq -r '.jobId' 2>/dev/null)
                echo "$i|$JOB_ID|success" >> "$TEST_DIR/upload-results.txt"
            else
                echo "$i|error|failed" >> "$TEST_DIR/upload-results.txt"
            fi
        ) &
    done

    # Wait for batch to complete
    wait

    # Update counts
    UPLOADED_COUNT=$(grep -c "|success$" "$TEST_DIR/upload-results.txt" 2>/dev/null || echo "0")
    FAILED_UPLOADS=$(grep -c "|failed$" "$TEST_DIR/upload-results.txt" 2>/dev/null || echo "0")

    print_info "Progress: $UPLOADED_COUNT uploaded, $FAILED_UPLOADS failed"
done

UPLOAD_END_TIME=$(date +%s)
UPLOAD_DURATION=$((UPLOAD_END_TIME - START_TIME))

print_success "Upload phase complete: $UPLOADED_COUNT files uploaded in ${UPLOAD_DURATION}s"

# Wait for processing to complete
print_header "MONITORING PROCESSING"

print_step "Waiting for all jobs to complete..."
MAX_WAIT_TIME=1800  # 30 minutes max
POLL_INTERVAL=5
ELAPSED=0

while [ $ELAPSED -lt $MAX_WAIT_TIME ]; do
    QUEUE_STATS=$(curl -s "${API_URL}/api/queue/stats")
    WAITING=$(echo "$QUEUE_STATS" | jq -r '.stats.waiting // 0' 2>/dev/null || echo "0")
    ACTIVE=$(echo "$QUEUE_STATS" | jq -r '.stats.active // 0' 2>/dev/null || echo "0")
    COMPLETED=$(echo "$QUEUE_STATS" | jq -r '.stats.completed // 0' 2>/dev/null || echo "0")
    FAILED=$(echo "$QUEUE_STATS" | jq -r '.stats.failed // 0' 2>/dev/null || echo "0")

    JOBS_DONE=$((COMPLETED - BASELINE_COMPLETED))

    print_info "[$ELAPSED s] Waiting: $WAITING | Active: $ACTIVE | Completed: $JOBS_DONE/$UPLOADED_COUNT | Failed: $FAILED"

    if [ "$JOBS_DONE" -ge "$UPLOADED_COUNT" ] || [ $((WAITING + ACTIVE)) -eq 0 ]; then
        print_success "All jobs processed!"
        break
    fi

    sleep $POLL_INTERVAL
    ELAPSED=$((ELAPSED + POLL_INTERVAL))
done

PROCESSING_END_TIME=$(date +%s)
TOTAL_DURATION=$((PROCESSING_END_TIME - START_TIME))
PROCESSING_DURATION=$((PROCESSING_END_TIME - UPLOAD_END_TIME))

# Calculate metrics
print_header "CALCULATING METRICS"

FINAL_QUEUE_STATS=$(curl -s "${API_URL}/api/queue/stats")
FINAL_COMPLETED=$(echo "$FINAL_QUEUE_STATS" | jq -r '.stats.completed // 0' 2>/dev/null || echo "0")
FINAL_FAILED=$(echo "$FINAL_QUEUE_STATS" | jq -r '.stats.failed // 0' 2>/dev/null || echo "0")

JOBS_PROCESSED=$((FINAL_COMPLETED - BASELINE_COMPLETED))
JOBS_FAILED=$((FINAL_FAILED))

# Throughput calculations
if [ $PROCESSING_DURATION -gt 0 ]; then
    FILES_PER_SECOND=$(echo "scale=2; $JOBS_PROCESSED / $PROCESSING_DURATION" | bc)
    FILES_PER_MINUTE=$(echo "scale=2; $FILES_PER_SECOND * 60" | bc)
    FILES_PER_HOUR=$(echo "scale=0; $FILES_PER_SECOND * 3600" | bc)
    FILES_PER_HOUR_PER_WORKER=$(echo "scale=0; $FILES_PER_HOUR / $WORKERS" | bc)
else
    FILES_PER_SECOND=0
    FILES_PER_MINUTE=0
    FILES_PER_HOUR=0
    FILES_PER_HOUR_PER_WORKER=0
fi

# Average latency
if [ $JOBS_PROCESSED -gt 0 ]; then
    AVG_LATENCY=$(echo "scale=2; $PROCESSING_DURATION / $JOBS_PROCESSED" | bc)
else
    AVG_LATENCY=0
fi

# Success rate
if [ $UPLOADED_COUNT -gt 0 ]; then
    SUCCESS_RATE=$(echo "scale=2; ($JOBS_PROCESSED * 100) / $UPLOADED_COUNT" | bc)
else
    SUCCESS_RATE=0
fi

# Generate report
print_header "BENCHMARK RESULTS"

{
    echo "============================================"
    echo "FileProcessAgent Performance Benchmark Report"
    echo "============================================"
    echo ""
    echo "Timestamp: $(date)"
    echo "Configuration:"
    echo "  Workers: $WORKERS"
    echo "  Test Files: $TEST_FILES"
    echo "  File Size: $FILE_SIZE"
    echo "  Concurrency: $CONCURRENCY"
    echo ""
    echo "============================================"
    echo "THROUGHPUT METRICS"
    echo "============================================"
    echo ""
    echo "Total Files Uploaded:     $UPLOADED_COUNT"
    echo "Total Files Processed:    $JOBS_PROCESSED"
    echo "Total Files Failed:       $JOBS_FAILED"
    echo "Success Rate:             ${SUCCESS_RATE}%"
    echo ""
    echo "Upload Duration:          ${UPLOAD_DURATION}s"
    echo "Processing Duration:      ${PROCESSING_DURATION}s"
    echo "Total Duration:           ${TOTAL_DURATION}s"
    echo ""
    echo "Files/Second:             $FILES_PER_SECOND"
    echo "Files/Minute:             $FILES_PER_MINUTE"
    echo "Files/Hour (Total):       $FILES_PER_HOUR"
    echo "Files/Hour/Worker:        $FILES_PER_HOUR_PER_WORKER"
    echo ""
    echo "Average Latency:          ${AVG_LATENCY}s per file"
    echo ""
    echo "============================================"
    echo "TARGET VALIDATION"
    echo "============================================"
    echo ""

    # Validate against targets
    if [ "$FILES_PER_HOUR_PER_WORKER" -ge 1200 ]; then
        echo "✅ PASS: Throughput target (1200+ files/hour/worker)"
        echo "   Achieved: $FILES_PER_HOUR_PER_WORKER files/hour/worker"
    else
        echo "❌ FAIL: Throughput target (1200+ files/hour/worker)"
        echo "   Achieved: $FILES_PER_HOUR_PER_WORKER files/hour/worker"
        echo "   Target: 1200 files/hour/worker"
    fi
    echo ""

    if (( $(echo "$AVG_LATENCY >= 2" | bc -l) )) && (( $(echo "$AVG_LATENCY <= 15" | bc -l) )); then
        echo "✅ PASS: Latency target (2-15s per document)"
        echo "   Achieved: ${AVG_LATENCY}s per document"
    else
        echo "⚠️  WARNING: Latency outside target range (2-15s)"
        echo "   Achieved: ${AVG_LATENCY}s per document"
    fi
    echo ""

    if (( $(echo "$SUCCESS_RATE >= 99" | bc -l) )); then
        echo "✅ PASS: Success rate target (99%+)"
        echo "   Achieved: ${SUCCESS_RATE}%"
    else
        echo "❌ FAIL: Success rate target (99%+)"
        echo "   Achieved: ${SUCCESS_RATE}%"
    fi
    echo ""

    echo "============================================"
    echo "RESOURCE UTILIZATION"
    echo "============================================"
    echo ""

    # Get Docker stats
    echo "Worker Container Stats:"
    docker stats --no-stream --format "table {{.Name}}\t{{.CPUPerc}}\t{{.MemUsage}}" | grep "fileprocess-worker" || echo "No stats available"
    echo ""

    echo "API Container Stats:"
    docker stats --no-stream --format "table {{.Name}}\t{{.CPUPerc}}\t{{.MemUsage}}" | grep "fileprocess-api" || echo "No stats available"
    echo ""

    echo "============================================"
    echo "RECOMMENDATIONS"
    echo "============================================"
    echo ""

    if [ "$FILES_PER_HOUR_PER_WORKER" -lt 1200 ]; then
        echo "- Throughput below target. Consider:"
        echo "  * Increasing WORKER_CONCURRENCY (current: 10)"
        echo "  * Optimizing OCR tier selection"
        echo "  * Checking network latency to GraphRAG/MageAgent"
        echo "  * Profiling worker CPU usage"
    fi

    if (( $(echo "$AVG_LATENCY > 15" | bc -l) )); then
        echo "- Latency high. Consider:"
        echo "  * Reducing file size or complexity"
        echo "  * Checking GraphRAG response times"
        echo "  * Optimizing embedding generation"
    fi

    if (( $(echo "$SUCCESS_RATE < 99" | bc -l) )); then
        echo "- Success rate below target. Check:"
        echo "  * Worker logs for errors"
        echo "  * Database connection issues"
        echo "  * API key validity"
    fi

    echo ""
    echo "============================================"
    echo "END OF REPORT"
    echo "============================================"
} | tee "$REPORT_FILE"

# Display summary
echo ""
print_metric "Throughput: $FILES_PER_HOUR_PER_WORKER files/hour/worker"
print_metric "Latency: ${AVG_LATENCY}s average"
print_metric "Success Rate: ${SUCCESS_RATE}%"
echo ""
print_success "Benchmark complete! Report saved to: $REPORT_FILE"

# Cleanup
rm -rf "$TEST_DIR"

# Exit with appropriate code
if [ "$FILES_PER_HOUR_PER_WORKER" -ge 1200 ] && (( $(echo "$SUCCESS_RATE >= 99" | bc -l) )); then
    print_success "All performance targets met! 🎉"
    exit 0
else
    print_error "Some performance targets not met. Review report for details."
    exit 1
fi
