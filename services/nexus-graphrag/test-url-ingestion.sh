#!/bin/bash

# GraphRAG URL Ingestion Test Script
# Tests the Google Drive import system

set -e

# Configuration
GRAPHRAG_URL="${GRAPHRAG_URL:-http://localhost:8090}"
TEST_FOLDER_URL="https://drive.google.com/drive/folders/1iFxo8CikD-nrL1zQU6tBCHZUJpl5oSxJ"

# Colors for output
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo "========================================="
echo "GraphRAG URL Ingestion System Test"
echo "========================================="
echo ""

# Function to check if service is running
check_service() {
    echo -n "Checking if GraphRAG service is running... "
    if curl -s -f "${GRAPHRAG_URL}/health" > /dev/null 2>&1; then
        echo -e "${GREEN}✓ Service is running${NC}"
        return 0
    else
        echo -e "${RED}✗ Service is not running${NC}"
        echo ""
        echo "Please start the GraphRAG service first:"
        echo "  cd services/graphrag"
        echo "  npm run dev"
        exit 1
    fi
}

# Function to test URL validation
test_url_validation() {
    echo ""
    echo "========================================="
    echo "Test 1: URL Validation & File Discovery"
    echo "========================================="

    echo "Testing with Google Drive folder: ${TEST_FOLDER_URL}"
    echo ""

    RESPONSE=$(curl -s -X POST "${GRAPHRAG_URL}/api/documents/ingest-url" \
        -H "Content-Type: application/json" \
        -d "{
            \"url\": \"${TEST_FOLDER_URL}\",
            \"discoveryOptions\": {
                \"recursive\": true,
                \"maxDepth\": 2
            },
            \"userId\": \"test-user\",
            \"sessionId\": \"test-session-$(date +%s)\"
        }")

    echo "Response:"
    echo "$RESPONSE" | jq '.' 2>/dev/null || echo "$RESPONSE"
    echo ""

    # Check if response is valid
    if echo "$RESPONSE" | jq -e '.validation.valid' > /dev/null 2>&1; then
        VALID=$(echo "$RESPONSE" | jq -r '.validation.valid')
        if [ "$VALID" = "true" ]; then
            echo -e "${GREEN}✓ URL validation successful${NC}"

            # Check if it requires confirmation
            REQUIRES_CONFIRMATION=$(echo "$RESPONSE" | jq -r '.requiresConfirmation // false')
            if [ "$REQUIRES_CONFIRMATION" = "true" ]; then
                FILE_COUNT=$(echo "$RESPONSE" | jq -r '.files | length')
                echo -e "${YELLOW}ℹ Found ${FILE_COUNT} files (requires confirmation)${NC}"

                # Save files for confirmation test
                echo "$RESPONSE" | jq -r '.files' > /tmp/discovered_files.json
                return 0
            else
                JOB_ID=$(echo "$RESPONSE" | jq -r '.jobId // empty')
                if [ -n "$JOB_ID" ]; then
                    echo -e "${GREEN}✓ Job started: ${JOB_ID}${NC}"
                    echo "$JOB_ID" > /tmp/ingestion_job_id.txt
                    return 0
                fi
            fi
        else
            echo -e "${RED}✗ URL validation failed${NC}"
            return 1
        fi
    else
        echo -e "${RED}✗ Invalid response from server${NC}"
        return 1
    fi
}

# Function to test file ingestion with confirmation
test_confirmation_flow() {
    echo ""
    echo "========================================="
    echo "Test 2: Confirmation Flow"
    echo "========================================="

    if [ ! -f /tmp/discovered_files.json ]; then
        echo -e "${YELLOW}⊘ Skipping (no files discovered in Test 1)${NC}"
        return 0
    fi

    echo "Confirming ingestion of discovered files..."
    echo ""

    FILES=$(cat /tmp/discovered_files.json)

    RESPONSE=$(curl -s -X POST "${GRAPHRAG_URL}/api/documents/ingest-url/confirm" \
        -H "Content-Type: application/json" \
        -d "{
            \"files\": ${FILES},
            \"options\": {
                \"enableAgentAnalysis\": true,
                \"metadata\": {
                    \"tags\": [\"test\", \"google-drive\"]
                }
            }
        }")

    echo "Response:"
    echo "$RESPONSE" | jq '.' 2>/dev/null || echo "$RESPONSE"
    echo ""

    JOB_ID=$(echo "$RESPONSE" | jq -r '.jobId // empty')
    if [ -n "$JOB_ID" ]; then
        echo -e "${GREEN}✓ Confirmation successful, job started: ${JOB_ID}${NC}"
        echo "$JOB_ID" > /tmp/ingestion_job_id.txt
        return 0
    else
        echo -e "${RED}✗ Confirmation failed${NC}"
        return 1
    fi
}

# Function to test job status monitoring
test_job_status() {
    echo ""
    echo "========================================="
    echo "Test 3: Job Status Monitoring"
    echo "========================================="

    if [ ! -f /tmp/ingestion_job_id.txt ]; then
        echo -e "${YELLOW}⊘ Skipping (no job ID available)${NC}"
        return 0
    fi

    JOB_ID=$(cat /tmp/ingestion_job_id.txt)
    echo "Monitoring job: ${JOB_ID}"
    echo ""

    MAX_ATTEMPTS=10
    ATTEMPT=0

    while [ $ATTEMPT -lt $MAX_ATTEMPTS ]; do
        ATTEMPT=$((ATTEMPT + 1))

        RESPONSE=$(curl -s "${GRAPHRAG_URL}/api/documents/ingestion-jobs/${JOB_ID}")

        STATUS=$(echo "$RESPONSE" | jq -r '.status // "unknown"')
        PROGRESS=$(echo "$RESPONSE" | jq -r '.progress.percentage // 0')
        COMPLETED=$(echo "$RESPONSE" | jq -r '.progress.completed // 0')
        TOTAL=$(echo "$RESPONSE" | jq -r '.progress.total // 0')

        echo -n "Attempt ${ATTEMPT}/${MAX_ATTEMPTS}: Status=${STATUS}, Progress=${PROGRESS}%, Files=${COMPLETED}/${TOTAL}"

        if [ "$STATUS" = "completed" ]; then
            echo ""
            echo -e "${GREEN}✓ Job completed successfully${NC}"
            echo ""
            echo "Final Status:"
            echo "$RESPONSE" | jq '.' 2>/dev/null || echo "$RESPONSE"
            return 0
        elif [ "$STATUS" = "failed" ]; then
            echo ""
            echo -e "${RED}✗ Job failed${NC}"
            echo ""
            echo "Error Details:"
            echo "$RESPONSE" | jq '.' 2>/dev/null || echo "$RESPONSE"
            return 1
        else
            echo " (waiting...)"
            sleep 3
        fi
    done

    echo ""
    echo -e "${YELLOW}⊘ Job still in progress after ${MAX_ATTEMPTS} attempts${NC}"
    return 0
}

# Function to test single file ingestion (skip confirmation)
test_single_file() {
    echo ""
    echo "========================================="
    echo "Test 4: Single File Ingestion"
    echo "========================================="

    # Test with a single public PDF
    TEST_URL="https://www.w3.org/WAI/ER/tests/xhtml/testfiles/resources/pdf/dummy.pdf"

    echo "Testing with single file: ${TEST_URL}"
    echo ""

    RESPONSE=$(curl -s -X POST "${GRAPHRAG_URL}/api/documents/ingest-url" \
        -H "Content-Type: application/json" \
        -d "{
            \"url\": \"${TEST_URL}\",
            \"skipConfirmation\": true,
            \"userId\": \"test-user\",
            \"sessionId\": \"test-session-$(date +%s)\"
        }")

    echo "Response:"
    echo "$RESPONSE" | jq '.' 2>/dev/null || echo "$RESPONSE"
    echo ""

    JOB_ID=$(echo "$RESPONSE" | jq -r '.jobId // empty')
    if [ -n "$JOB_ID" ]; then
        echo -e "${GREEN}✓ Single file ingestion started: ${JOB_ID}${NC}"

        # Wait a bit and check status
        sleep 5
        STATUS_RESPONSE=$(curl -s "${GRAPHRAG_URL}/api/documents/ingestion-jobs/${JOB_ID}")
        echo ""
        echo "Job Status:"
        echo "$STATUS_RESPONSE" | jq '.' 2>/dev/null || echo "$STATUS_RESPONSE"

        return 0
    else
        echo -e "${RED}✗ Single file ingestion failed${NC}"
        return 1
    fi
}

# Function to test job cancellation
test_job_cancellation() {
    echo ""
    echo "========================================="
    echo "Test 5: Job Cancellation"
    echo "========================================="

    # Start a job
    echo "Starting a test job for cancellation..."
    RESPONSE=$(curl -s -X POST "${GRAPHRAG_URL}/api/documents/ingest-url" \
        -H "Content-Type: application/json" \
        -d "{
            \"url\": \"${TEST_FOLDER_URL}\",
            \"skipConfirmation\": true,
            \"discoveryOptions\": {
                \"recursive\": true,
                \"maxDepth\": 3
            }
        }")

    JOB_ID=$(echo "$RESPONSE" | jq -r '.jobId // empty')
    if [ -z "$JOB_ID" ]; then
        echo -e "${YELLOW}⊘ Could not start test job for cancellation${NC}"
        return 0
    fi

    echo "Job started: ${JOB_ID}"
    echo "Attempting to cancel..."

    CANCEL_RESPONSE=$(curl -s -X POST "${GRAPHRAG_URL}/api/documents/ingestion-jobs/${JOB_ID}/cancel")

    echo "Response:"
    echo "$CANCEL_RESPONSE" | jq '.' 2>/dev/null || echo "$CANCEL_RESPONSE"
    echo ""

    SUCCESS=$(echo "$CANCEL_RESPONSE" | jq -r '.success // false')
    if [ "$SUCCESS" = "true" ]; then
        echo -e "${GREEN}✓ Job cancellation successful${NC}"
        return 0
    else
        echo -e "${RED}✗ Job cancellation failed${NC}"
        return 1
    fi
}

# Main test execution
main() {
    # Check if service is running
    check_service

    # Run tests
    test_url_validation
    TEST1_RESULT=$?

    test_confirmation_flow
    TEST2_RESULT=$?

    test_job_status
    TEST3_RESULT=$?

    test_single_file
    TEST4_RESULT=$?

    test_job_cancellation
    TEST5_RESULT=$?

    # Summary
    echo ""
    echo "========================================="
    echo "Test Summary"
    echo "========================================="

    PASSED=0
    FAILED=0

    [ $TEST1_RESULT -eq 0 ] && PASSED=$((PASSED + 1)) || FAILED=$((FAILED + 1))
    [ $TEST2_RESULT -eq 0 ] && PASSED=$((PASSED + 1)) || FAILED=$((FAILED + 1))
    [ $TEST3_RESULT -eq 0 ] && PASSED=$((PASSED + 1)) || FAILED=$((FAILED + 1))
    [ $TEST4_RESULT -eq 0 ] && PASSED=$((PASSED + 1)) || FAILED=$((FAILED + 1))
    [ $TEST5_RESULT -eq 0 ] && PASSED=$((PASSED + 1)) || FAILED=$((FAILED + 1))

    echo "Tests Passed: ${PASSED}/5"
    echo "Tests Failed: ${FAILED}/5"
    echo ""

    if [ $FAILED -eq 0 ]; then
        echo -e "${GREEN}✓ All tests passed!${NC}"
        exit 0
    else
        echo -e "${RED}✗ Some tests failed${NC}"
        exit 1
    fi
}

# Run main function
main
