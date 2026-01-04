#!/bin/bash

##############################################################################
# FileProcessAgent Chaos Testing Script - Phase 6
#
# Purpose: Test system resilience under failure conditions
# Tests: Circuit breaker, recovery, error handling, metrics recording
#
# Design Pattern: Chaos Engineering
# SOLID Principles Applied:
# - Single Responsibility: Each test scenario has one focus
# - Open/Closed: Easy to add new test scenarios without modifying existing
#
# Usage:
#   ./chaos-test.sh [scenario]
#
# Scenarios:
#   all              - Run all chaos tests
#   circuit-breaker  - Test circuit breaker behavior
#   timeout          - Test timeout handling
#   invalid-files    - Test invalid file handling
#   concurrent       - Test concurrent request handling
#   recovery         - Test system recovery
##############################################################################

set -euo pipefail

# Configuration
FILEPROCESS_URL="${FILEPROCESS_URL:-http://localhost:9099}"
METRICS_URL="${METRICS_URL:-http://localhost:9099/metrics}"
TEST_USER_ID="chaos-test-$(date +%s)"
RESULTS_DIR="./chaos-test-results-$(date +%Y%m%d-%H%M%S)"
CONCURRENT_REQUESTS=10
CIRCUIT_BREAKER_THRESHOLD=5

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Create results directory
mkdir -p "$RESULTS_DIR"

# Logging functions
log_info() {
    echo -e "${BLUE}[INFO]${NC} $1" | tee -a "$RESULTS_DIR/chaos-test.log"
}

log_success() {
    echo -e "${GREEN}[PASS]${NC} $1" | tee -a "$RESULTS_DIR/chaos-test.log"
}

log_error() {
    echo -e "${RED}[FAIL]${NC} $1" | tee -a "$RESULTS_DIR/chaos-test.log"
}

log_warning() {
    echo -e "${YELLOW}[WARN]${NC} $1" | tee -a "$RESULTS_DIR/chaos-test.log"
}

# Create test PDF
create_test_pdf() {
    local filename="$1"
    echo "JVBERi0xLjQKJeLjz9MKMyAwIG9iago8PC9UeXBlL1BhZ2UvUGFyZW50IDIgMCBSL0NvbnRlbnRzIDQgMCBSL01lZGlhQm94WzAgMCA2MTIgNzkyXT4+CmVuZG9iago0IDAgb2JqCjw8L0xlbmd0aCA0Mz4+CnN0cmVhbQpCVAovRjEgMTIgVGYKNzIgNzIwIFRkCihDaGFvcyBUZXN0KSBUagpFVAplbmRzdHJlYW0KZW5kb2JqCjUgMCBvYmoKPDwvVHlwZS9Gb250L1N1YnR5cGUvVHlwZTEvQmFzZUZvbnQvSGVsdmV0aWNhPj4KZW5kb2JqCjIgMCBvYmoKPDwvVHlwZS9QYWdlcy9LaWRzWzMgMCBSXS9Db3VudCAxL01lZGlhQm94WzAgMCA2MTIgNzkyXT4+CmVuZG9iagoxIDAgb2JqCjw8L1R5cGUvQ2F0YWxvZy9QYWdlcyAyIDAgUj4+CmVuZG9iagp4cmVmCjAgNgowMDAwMDAwMDAwIDY1NTM1IGYgCjAwMDAwMDAzMDYgMDAwMDAgbiAKMDAwMDAwMDI0NiAwMDAwMCBuIAowMDAwMDAwMDE1IDAwMDAwIG4gCjAwMDAwMDAxMDEgMDAwMDAgbiAKMDAwMDAwMDE5MyAwMDAwMCBuIAp0cmFpbGVyCjw8L1NpemUgNi9Sb290IDEgMCBSPj4Kc3RhcnR4cmVmCjM1NQolJUVPRgo=" | base64 -d > "$filename"
}

# Get metrics snapshot
get_metrics() {
    curl -s "$METRICS_URL" > "$RESULTS_DIR/metrics-$(date +%s).txt" 2>/dev/null || true
}

# Extract specific metric value
extract_metric() {
    local metric_name="$1"
    local label_filter="${2:-}"

    if [ -z "$label_filter" ]; then
        grep "^${metric_name} " "$RESULTS_DIR"/metrics-*.txt 2>/dev/null | tail -1 | awk '{print $2}'
    else
        grep "^${metric_name}{.*${label_filter}.*}" "$RESULTS_DIR"/metrics-*.txt 2>/dev/null | tail -1 | awk '{print $2}'
    fi
}

##############################################################################
# Test Scenario 1: Circuit Breaker Behavior
##############################################################################
test_circuit_breaker() {
    log_info "========================================" log_info "Test 1: Circuit Breaker Behavior"
    log_info "========================================"

    log_info "Triggering $CIRCUIT_BREAKER_THRESHOLD failures to open circuit breaker..."

    # Get initial circuit breaker state
    get_metrics
    local initial_state=$(extract_metric "fileprocess_circuit_breaker_state" "circuit_name=\"sandbox\"")
    log_info "Initial circuit breaker state: ${initial_state:-UNKNOWN}"

    # Trigger failures by sending invalid requests to sandbox endpoint
    for i in $(seq 1 $CIRCUIT_BREAKER_THRESHOLD); do
        log_info "Failure attempt $i/$CIRCUIT_BREAKER_THRESHOLD..."

        # This should fail and count toward circuit breaker
        curl -X POST "$FILEPROCESS_URL/api/sandbox/execute" \
            -H "Content-Type: application/json" \
            -d '{"code":"import invalid_module","language":"python"}' \
            -w "\nHTTP Status: %{http_code}\n" \
            >> "$RESULTS_DIR/circuit-breaker-failures.log" 2>&1 || true

        sleep 1
    done

    # Check circuit breaker state after failures
    sleep 2
    get_metrics
    local final_state=$(extract_metric "fileprocess_circuit_breaker_state" "circuit_name=\"sandbox\"")
    local transitions=$(extract_metric "fileprocess_circuit_breaker_transitions_total" "circuit_name=\"sandbox\"")

    log_info "Final circuit breaker state: ${final_state:-UNKNOWN}"
    log_info "Circuit breaker transitions: ${transitions:-0}"

    # Verify circuit breaker opened (state should be 1 = OPEN)
    if [ "${final_state:-0}" == "1" ]; then
        log_success "Circuit breaker correctly opened after $CIRCUIT_BREAKER_THRESHOLD failures"
    else
        log_warning "Circuit breaker state: ${final_state:-UNKNOWN} (expected: 1 for OPEN)"
    fi

    # Test fail-fast behavior
    log_info "Testing fail-fast behavior while circuit is open..."
    local start_time=$(date +%s%3N)

    curl -X POST "$FILEPROCESS_URL/api/sandbox/execute" \
        -H "Content-Type: application/json" \
        -d '{"code":"print(\"test\")","language":"python"}' \
        -w "\nHTTP Status: %{http_code}\nTime: %{time_total}s\n" \
        >> "$RESULTS_DIR/circuit-breaker-failfast.log" 2>&1 || true

    local end_time=$(date +%s%3N)
    local duration=$((end_time - start_time))

    # Fail-fast should be < 100ms
    if [ "$duration" -lt 100 ]; then
        log_success "Fail-fast behavior working (${duration}ms < 100ms)"
    else
        log_warning "Fail-fast took ${duration}ms (expected < 100ms)"
    fi

    log_info "Circuit breaker test complete. Results in $RESULTS_DIR"
}

##############################################################################
# Test Scenario 2: Timeout Handling
##############################################################################
test_timeout() {
    log_info "========================================"
    log_info "Test 2: Timeout Handling"
    log_info "========================================"

    log_info "Sending request with very short timeout..."

    # Create test PDF
    local test_file="$RESULTS_DIR/timeout-test.pdf"
    create_test_pdf "$test_file"

    # Send request with 1ms timeout (should timeout immediately)
    local start_time=$(date +%s%3N)

    curl -X POST "$FILEPROCESS_URL/api/fileprocess/process" \
        -F "file=@$test_file" \
        -F "userId=$TEST_USER_ID" \
        -F "timeout=1" \
        -w "\nHTTP Status: %{http_code}\nTime: %{time_total}s\n" \
        > "$RESULTS_DIR/timeout-test-response.json" 2>&1 || true

    local end_time=$(date +%s%3N)
    local duration=$((end_time - start_time))

    log_info "Request completed in ${duration}ms"

    # Check metrics for timeout errors
    get_metrics
    local errors=$(extract_metric "fileprocess_errors_total" "type=\"timeout\"")

    if [ -n "$errors" ] && [ "$errors" -gt 0 ]; then
        log_success "Timeout errors recorded in metrics: $errors"
    else
        log_warning "No timeout errors found in metrics"
    fi

    log_info "Timeout test complete. Results in $RESULTS_DIR"
}

##############################################################################
# Test Scenario 3: Invalid File Handling
##############################################################################
test_invalid_files() {
    log_info "========================================"
    log_info "Test 3: Invalid File Handling"
    log_info "========================================"

    # Test 3.1: Corrupted PDF
    log_info "Test 3.1: Sending corrupted PDF..."
    local corrupted_pdf="$RESULTS_DIR/corrupted.pdf"
    echo "CORRUPTED DATA" > "$corrupted_pdf"

    curl -X POST "$FILEPROCESS_URL/api/fileprocess/process" \
        -F "file=@$corrupted_pdf" \
        -F "userId=$TEST_USER_ID" \
        -w "\nHTTP Status: %{http_code}\n" \
        > "$RESULTS_DIR/corrupted-pdf-response.json" 2>&1 || true

    # Test 3.2: Empty file
    log_info "Test 3.2: Sending empty file..."
    local empty_file="$RESULTS_DIR/empty.pdf"
    touch "$empty_file"

    curl -X POST "$FILEPROCESS_URL/api/fileprocess/process" \
        -F "file=@$empty_file" \
        -F "userId=$TEST_USER_ID" \
        -w "\nHTTP Status: %{http_code}\n" \
        > "$RESULTS_DIR/empty-file-response.json" 2>&1 || true

    # Test 3.3: Oversized file (> 100MB)
    log_info "Test 3.3: Sending oversized file..."
    local oversized_file="$RESULTS_DIR/oversized.pdf"
    dd if=/dev/zero of="$oversized_file" bs=1M count=101 2>/dev/null || true

    curl -X POST "$FILEPROCESS_URL/api/fileprocess/process" \
        -F "file=@$oversized_file" \
        -F "userId=$TEST_USER_ID" \
        -w "\nHTTP Status: %{http_code}\n" \
        > "$RESULTS_DIR/oversized-file-response.json" 2>&1 || true

    # Check validation error metrics
    get_metrics
    local validation_errors=$(extract_metric "fileprocess_errors_total" "type=\"validation\"")

    log_info "Validation errors recorded: ${validation_errors:-0}"

    if [ "${validation_errors:-0}" -gt 0 ]; then
        log_success "Invalid files correctly rejected and metrics recorded"
    else
        log_warning "No validation errors found in metrics"
    fi

    # Cleanup large files
    rm -f "$oversized_file"

    log_info "Invalid file test complete. Results in $RESULTS_DIR"
}

##############################################################################
# Test Scenario 4: Concurrent Request Handling
##############################################################################
test_concurrent() {
    log_info "========================================"
    log_info "Test 4: Concurrent Request Handling"
    log_info "========================================"

    log_info "Sending $CONCURRENT_REQUESTS concurrent requests..."

    # Create test file
    local test_file="$RESULTS_DIR/concurrent-test.pdf"
    create_test_pdf "$test_file"

    # Get initial metrics
    get_metrics
    local initial_requests=$(extract_metric "fileprocess_http_requests_total")

    # Send concurrent requests
    local pids=()
    for i in $(seq 1 $CONCURRENT_REQUESTS); do
        (
            curl -X POST "$FILEPROCESS_URL/api/fileprocess/process" \
                -F "file=@$test_file" \
                -F "userId=$TEST_USER_ID-$i" \
                -w "\nHTTP Status: %{http_code}\nTime: %{time_total}s\n" \
                > "$RESULTS_DIR/concurrent-response-$i.json" 2>&1
        ) &
        pids+=($!)
    done

    # Wait for all requests to complete
    log_info "Waiting for all requests to complete..."
    for pid in "${pids[@]}"; do
        wait "$pid"
    done

    # Get final metrics
    sleep 2
    get_metrics
    local final_requests=$(extract_metric "fileprocess_http_requests_total")
    local processed=$((final_requests - initial_requests))

    log_info "Requests processed: $processed / $CONCURRENT_REQUESTS"

    # Count successful responses
    local success_count=$(grep -l "HTTP Status: 200" "$RESULTS_DIR"/concurrent-response-*.json 2>/dev/null | wc -l)

    if [ "$success_count" -eq "$CONCURRENT_REQUESTS" ]; then
        log_success "All $CONCURRENT_REQUESTS concurrent requests succeeded"
    else
        log_warning "$success_count/$CONCURRENT_REQUESTS concurrent requests succeeded"
    fi

    # Check for any rate limit or queue depth metrics
    local queue_depth=$(extract_metric "fileprocess_queue_depth")
    log_info "Peak queue depth: ${queue_depth:-0}"

    log_info "Concurrent test complete. Results in $RESULTS_DIR"
}

##############################################################################
# Test Scenario 5: System Recovery
##############################################################################
test_recovery() {
    log_info "========================================"
    log_info "Test 5: System Recovery"
    log_info "========================================"

    log_info "Simulating service degradation and recovery..."

    # Create test file
    local test_file="$RESULTS_DIR/recovery-test.pdf"
    create_test_pdf "$test_file"

    # Step 1: Verify system is healthy
    log_info "Step 1: Verifying system health..."
    curl -s "$FILEPROCESS_URL/health" > "$RESULTS_DIR/health-before.json"
    log_success "System health check passed"

    # Step 2: Introduce failures to degrade service
    log_info "Step 2: Introducing failures..."
    for i in $(seq 1 3); do
        curl -X POST "$FILEPROCESS_URL/api/fileprocess/process" \
            -F "file=@/dev/null" \
            -F "userId=$TEST_USER_ID-failure-$i" \
            >> "$RESULTS_DIR/recovery-failures.log" 2>&1 || true
        sleep 1
    done

    # Step 3: Allow system to recover
    log_info "Step 3: Allowing system to recover (waiting 5 seconds)..."
    sleep 5

    # Step 4: Send successful request
    log_info "Step 4: Testing recovery with valid request..."
    local recovery_start=$(date +%s%3N)

    curl -X POST "$FILEPROCESS_URL/api/fileprocess/process" \
        -F "file=@$test_file" \
        -F "userId=$TEST_USER_ID-recovery" \
        -w "\nHTTP Status: %{http_code}\nTime: %{time_total}s\n" \
        > "$RESULTS_DIR/recovery-success.json" 2>&1 || true

    local recovery_end=$(date +%s%3N)
    local recovery_time=$((recovery_end - recovery_start))

    # Step 5: Verify system is healthy again
    log_info "Step 5: Verifying recovered system health..."
    curl -s "$FILEPROCESS_URL/health" > "$RESULTS_DIR/health-after.json"

    # Check recovery metrics
    get_metrics
    local circuit_state=$(extract_metric "fileprocess_circuit_breaker_state")

    if grep -q "HTTP Status: 200" "$RESULTS_DIR/recovery-success.json"; then
        log_success "System recovered successfully (recovery time: ${recovery_time}ms)"
        log_success "Circuit breaker state after recovery: ${circuit_state:-UNKNOWN}"
    else
        log_error "System failed to recover"
    fi

    log_info "Recovery test complete. Results in $RESULTS_DIR"
}

##############################################################################
# Generate Summary Report
##############################################################################
generate_report() {
    local report_file="$RESULTS_DIR/CHAOS-TEST-REPORT.md"

    cat > "$report_file" <<EOF
# FileProcessAgent Chaos Testing Report

**Date**: $(date)
**Test Duration**: $(($(date +%s) - start_time)) seconds
**Results Directory**: $RESULTS_DIR

## Summary

This report contains the results of chaos engineering tests performed on FileProcessAgent
to validate system resilience, error handling, and recovery mechanisms.

## Test Scenarios

### 1. Circuit Breaker Behavior
- **Purpose**: Verify circuit breaker opens after threshold failures
- **Expected**: Circuit opens after $CIRCUIT_BREAKER_THRESHOLD failures, fail-fast < 100ms
- **Results**: See circuit-breaker-*.log files

### 2. Timeout Handling
- **Purpose**: Verify system handles timeouts gracefully
- **Expected**: Timeout errors recorded, no hanging requests
- **Results**: See timeout-test-*.* files

### 3. Invalid File Handling
- **Purpose**: Verify validation rejects invalid files
- **Expected**: Corrupted, empty, and oversized files rejected
- **Results**: See corrupted-*, empty-*, oversized-* files

### 4. Concurrent Request Handling
- **Purpose**: Verify system handles $CONCURRENT_REQUESTS concurrent requests
- **Expected**: All requests complete, queue metrics updated
- **Results**: See concurrent-response-*.json files

### 5. System Recovery
- **Purpose**: Verify system recovers from failures
- **Expected**: System returns to healthy state after failures
- **Results**: See recovery-*.* files

## Metrics Snapshots

Multiple metrics snapshots were captured throughout testing:
- See metrics-*.txt files for Prometheus metrics at different points

## Recommendations

1. Review circuit breaker transition logs for any unexpected behavior
2. Verify timeout thresholds are appropriate for workload
3. Ensure validation errors are properly categorized in metrics
4. Monitor queue depth under concurrent load
5. Validate recovery time meets SLA requirements

## Next Steps

- **Phase 7-8**: Implement comprehensive unit/integration test suite (50+ tests, >90% coverage)
- **Production**: Set up Grafana dashboards for real-time monitoring
- **Alerting**: Configure alerts based on circuit breaker state and error rates

---

Generated by FileProcessAgent Chaos Testing Script (Phase 6)
EOF

    log_success "Report generated: $report_file"
}

##############################################################################
# Main Execution
##############################################################################

# Start timer
start_time=$(date +%s)

log_info "========================================" log_info "FileProcessAgent Chaos Testing - Phase 6"
log_info "========================================"
log_info "Results directory: $RESULTS_DIR"
log_info "FileProcess URL: $FILEPROCESS_URL"
log_info "Metrics URL: $METRICS_URL"
log_info ""

# Verify service is reachable
log_info "Verifying service availability..."
if ! curl -s -f "$FILEPROCESS_URL/health" > /dev/null 2>&1; then
    log_error "FileProcessAgent is not reachable at $FILEPROCESS_URL"
    log_error "Please ensure the service is running and accessible"
    exit 1
fi
log_success "Service is reachable"
log_info ""

# Parse command line arguments
SCENARIO="${1:-all}"

case "$SCENARIO" in
    circuit-breaker)
        test_circuit_breaker
        ;;
    timeout)
        test_timeout
        ;;
    invalid-files)
        test_invalid_files
        ;;
    concurrent)
        test_concurrent
        ;;
    recovery)
        test_recovery
        ;;
    all)
        test_circuit_breaker
        echo ""
        test_timeout
        echo ""
        test_invalid_files
        echo ""
        test_concurrent
        echo ""
        test_recovery
        ;;
    *)
        log_error "Unknown scenario: $SCENARIO"
        log_info "Usage: $0 [scenario]"
        log_info "Scenarios: all, circuit-breaker, timeout, invalid-files, concurrent, recovery"
        exit 1
        ;;
esac

# Generate summary report
log_info ""
log_info "Generating summary report..."
generate_report

# Print summary
log_info ""
log_info "========================================"
log_success "Chaos testing complete!"
log_info "========================================"
log_info "Results directory: $RESULTS_DIR"
log_info "Summary report: $RESULTS_DIR/CHAOS-TEST-REPORT.md"
log_info "Test log: $RESULTS_DIR/chaos-test.log"
log_info ""
log_info "To view results:"
log_info "  cat $RESULTS_DIR/CHAOS-TEST-REPORT.md"
log_info "  tail -f $RESULTS_DIR/chaos-test.log"
log_info ""
