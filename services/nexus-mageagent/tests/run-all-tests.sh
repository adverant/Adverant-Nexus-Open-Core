#!/bin/bash

# MageAgent Comprehensive Test Suite Runner
# Executes all tests with real APIs and generates detailed reports

set -e

echo "========================================"
echo "MageAgent Comprehensive Test Suite"
echo "========================================"
echo "Starting at: $(date)"
echo ""

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Test results directory
RESULTS_DIR="test-results-$(date +%Y%m%d-%H%M%S)"
mkdir -p "$RESULTS_DIR"

# Summary file
SUMMARY_FILE="$RESULTS_DIR/test-summary.md"

# Initialize summary
cat > "$SUMMARY_FILE" << EOF
# MageAgent Test Execution Report

**Generated**: $(date)
**Environment**: Production (Real APIs)
**Test Mode**: NO MOCK DATA - All Real Services

## Executive Summary

This report contains the comprehensive test results for the MageAgent service, including:
- Unit tests with real API calls
- Integration tests with live services
- End-to-end workflow validation
- WebSocket streaming tests
- Chaos engineering resilience tests
- Performance and load testing
- Security penetration testing

---

## Test Execution Results

EOF

# Function to run test suite
run_test_suite() {
    local suite_name=$1
    local test_pattern=$2
    local timeout=$3

    echo -e "${BLUE}Running $suite_name...${NC}"

    local start_time=$(date +%s)
    local output_file="$RESULTS_DIR/${suite_name}-output.txt"
    local coverage_file="$RESULTS_DIR/${suite_name}-coverage.json"

    # Run tests with coverage
    if npm test -- "$test_pattern" \
        --coverage \
        --coverageReporters=json \
        --coverageDirectory="$RESULTS_DIR" \
        --testTimeout="$timeout" \
        --verbose \
        --no-cache \
        > "$output_file" 2>&1; then

        local status="${GREEN}✓ PASSED${NC}"
        local exit_code=0
    else
        local status="${RED}✗ FAILED${NC}"
        local exit_code=1
    fi

    local end_time=$(date +%s)
    local duration=$((end_time - start_time))

    # Extract test counts
    local total=$(grep -E "(PASS|FAIL)" "$output_file" | wc -l || echo "0")
    local passed=$(grep "PASS" "$output_file" | wc -l || echo "0")
    local failed=$(grep "FAIL" "$output_file" | wc -l || echo "0")

    echo -e "$status - Duration: ${duration}s, Tests: $total (Passed: $passed, Failed: $failed)"

    # Update summary
    cat >> "$SUMMARY_FILE" << EOF

### $suite_name

- **Status**: $([ $exit_code -eq 0 ] && echo "✅ Passed" || echo "❌ Failed")
- **Duration**: ${duration} seconds
- **Tests Run**: $total
- **Passed**: $passed
- **Failed**: $failed
- **Output**: [View Full Output](./${suite_name}-output.txt)

EOF

    # Extract key findings
    if [ -f "$output_file" ]; then
        echo "#### Key Findings:" >> "$SUMMARY_FILE"
        echo '```' >> "$SUMMARY_FILE"
        grep -E "(Performance|Throughput|Latency|Memory|Security)" "$output_file" | head -10 >> "$SUMMARY_FILE" || true
        echo '```' >> "$SUMMARY_FILE"
    fi

    return $exit_code
}

# Test execution plan
declare -A test_suites=(
    ["1.Unit-OpenRouterClient"]="tests/unit/clients/openrouter-client.test.ts|300000"
    ["2.Unit-GraphRAGClient"]="tests/unit/clients/graphrag-client.test.ts|300000"
    ["3.Unit-DatabaseManager"]="tests/unit/database/database-manager.test.ts|600000"
    ["4.Integration-Orchestrator"]="tests/integration/orchestration/orchestrator.test.ts|900000"
    ["5.Integration-WebSocket"]="tests/integration/websocket/websocket-streaming.test.ts|600000"
    ["6.E2E-Workflows"]="tests/e2e/complete-workflow.test.ts|1200000"
    ["7.Chaos-Engineering"]="tests/chaos/resilience.test.ts|1800000"
    ["8.Performance-Load"]="tests/performance/load-testing.test.ts|2400000"
    ["9.Security-Penetration"]="tests/security/penetration.test.ts|1200000"
)

# Check environment variables
echo -e "${YELLOW}Checking environment...${NC}"
if [ -z "$OPENROUTER_API_KEY" ]; then
    echo -e "${RED}ERROR: OPENROUTER_API_KEY not set${NC}"
    exit 1
fi

# Ensure test database schema exists
echo -e "${YELLOW}Preparing test database...${NC}"
psql -h localhost -U "$POSTGRES_USER" -d "$POSTGRES_DATABASE" -c "CREATE SCHEMA IF NOT EXISTS mageagent_test;" 2>/dev/null || true

# Run all test suites
total_suites=${#test_suites[@]}
passed_suites=0
failed_suites=0

echo ""
echo -e "${YELLOW}Running $total_suites test suites...${NC}"
echo ""

for suite in $(echo "${!test_suites[@]}" | tr ' ' '\n' | sort); do
    IFS='|' read -r pattern timeout <<< "${test_suites[$suite]}"

    if run_test_suite "$suite" "$pattern" "$timeout"; then
        ((passed_suites++))
    else
        ((failed_suites++))
    fi

    echo ""
done

# Generate coverage report
echo -e "${BLUE}Generating coverage report...${NC}"
if [ -f "$RESULTS_DIR/coverage-final.json" ]; then
    npx nyc report \
        --reporter=html \
        --reporter=text \
        --report-dir="$RESULTS_DIR/coverage" \
        --temp-dir="$RESULTS_DIR" \
        > "$RESULTS_DIR/coverage-summary.txt" 2>&1 || true

    # Add coverage to summary
    cat >> "$SUMMARY_FILE" << EOF

---

## Code Coverage

$(cat "$RESULTS_DIR/coverage-summary.txt" 2>/dev/null || echo "Coverage report not available")

[View HTML Report](./coverage/index.html)

EOF
fi

# Generate performance metrics
echo -e "${BLUE}Analyzing performance metrics...${NC}"
cat >> "$SUMMARY_FILE" << EOF

---

## Performance Metrics Summary

### Response Time Distribution
EOF

# Extract performance data from test outputs
for output in "$RESULTS_DIR"/*-output.txt; do
    if grep -q "latency\|response time\|throughput" "$output" 2>/dev/null; then
        suite_name=$(basename "$output" -output.txt)
        echo "#### $suite_name" >> "$SUMMARY_FILE"
        echo '```' >> "$SUMMARY_FILE"
        grep -E "avg.*ms|p[0-9]+.*ms|throughput.*req/s" "$output" | head -5 >> "$SUMMARY_FILE" || true
        echo '```' >> "$SUMMARY_FILE"
    fi
done

# Security findings
echo -e "${BLUE}Compiling security findings...${NC}"
cat >> "$SUMMARY_FILE" << EOF

---

## Security Assessment

### Vulnerabilities Tested
EOF

if [ -f "$RESULTS_DIR/9.Security-Penetration-output.txt" ]; then
    echo '```' >> "$SUMMARY_FILE"
    grep -E "(blocked|prevented|protected|validated)" "$RESULTS_DIR/9.Security-Penetration-output.txt" | sort | uniq | head -20 >> "$SUMMARY_FILE" || true
    echo '```' >> "$SUMMARY_FILE"
fi

# Final summary
cat >> "$SUMMARY_FILE" << EOF

---

## Overall Results

- **Total Test Suites**: $total_suites
- **Passed Suites**: $passed_suites ✅
- **Failed Suites**: $failed_suites ❌
- **Success Rate**: $(awk "BEGIN {printf \"%.1f\", $passed_suites/$total_suites*100}")%
- **Total Duration**: $(date -d@$SECONDS -u +%H:%M:%S)

### Recommendations

EOF

# Add recommendations based on results
if [ $failed_suites -eq 0 ]; then
    cat >> "$SUMMARY_FILE" << EOF
1. ✅ **All tests passed** - System is ready for production deployment
2. Continue monitoring performance metrics in production
3. Schedule regular security audits
4. Maintain test coverage above 80%
EOF
else
    cat >> "$SUMMARY_FILE" << EOF
1. ⚠️ **$failed_suites test suites failed** - Review failures before deployment
2. Focus on fixing critical failures first
3. Re-run failed tests after fixes
4. Consider implementing additional error handling
EOF
fi

# Add GraphRAG integration status
cat >> "$SUMMARY_FILE" << EOF

### GraphRAG Integration Status

EOF

if grep -q "GraphRAG.*available\|GraphRAG.*connected" "$RESULTS_DIR"/*-output.txt 2>/dev/null; then
    echo "✅ GraphRAG service integration validated" >> "$SUMMARY_FILE"
else
    echo "⚠️ GraphRAG service may not be fully available - system operates in degraded mode" >> "$SUMMARY_FILE"
fi

cat >> "$SUMMARY_FILE" << EOF

---

**Report Generated**: $(date)
**Test Framework**: Jest with Real API Integration
**Environment**: MageAgent Production Test Suite

EOF

# Create HTML report
echo -e "${BLUE}Generating HTML report...${NC}"
pandoc "$SUMMARY_FILE" \
    -f markdown \
    -t html \
    --standalone \
    --toc \
    --toc-depth=3 \
    --css=https://cdn.jsdelivr.net/npm/github-markdown-css/github-markdown.min.css \
    -o "$RESULTS_DIR/test-report.html" 2>/dev/null || true

# Final output
echo ""
echo "========================================"
echo -e "${GREEN}Test Execution Complete!${NC}"
echo "========================================"
echo ""
echo "Summary:"
echo "- Total Suites: $total_suites"
echo "- Passed: $passed_suites"
echo "- Failed: $failed_suites"
echo "- Duration: $(date -d@$SECONDS -u +%H:%M:%S)"
echo ""
echo "Reports generated in: $RESULTS_DIR/"
echo "- Summary: $SUMMARY_FILE"
echo "- HTML Report: $RESULTS_DIR/test-report.html"
echo "- Coverage: $RESULTS_DIR/coverage/index.html"
echo ""

# Exit with appropriate code
if [ $failed_suites -gt 0 ]; then
    echo -e "${RED}Some tests failed. Please review the reports.${NC}"
    exit 1
else
    echo -e "${GREEN}All tests passed successfully!${NC}"
    exit 0
fi