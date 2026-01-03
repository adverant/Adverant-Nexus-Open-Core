#!/bin/bash
set -e

# GraphRAG Integration Test Script for MageAgent
echo "========================================"
echo "GraphRAG Integration Test Suite"
echo "========================================"

# Configuration
MAGEAGENT_URL="https://graphrag.adverant.ai/mageagent"
GRAPHRAG_URL="http://graphrag.vibe-system.svc.cluster.local:8080"
TEST_TIMEOUT=300  # 5 minutes

# Colors for output
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Function to print test result
print_result() {
    if [ $1 -eq 0 ]; then
        echo -e "${GREEN}✅ $2${NC}"
    else
        echo -e "${RED}❌ $2${NC}"
        return 1
    fi
}

# Function to test health endpoint
test_health_endpoint() {
    echo "1. Testing MageAgent Health Endpoint..."

    response=$(curl -s -w "\n%{http_code}" ${MAGEAGENT_URL}/health)
    http_code=$(echo "$response" | tail -n1)
    body=$(echo "$response" | head -n-1)

    if [ "$http_code" == "200" ]; then
        print_result 0 "Health endpoint returned 200 OK"
        echo "   Response: $body"

        # Check if GraphRAG is mentioned as healthy
        if echo "$body" | jq -e '.services.memAgent' > /dev/null 2>&1; then
            print_result 0 "GraphRAG connection status available"
        else
            print_result 1 "GraphRAG connection status missing"
        fi
    else
        print_result 1 "Health endpoint failed with HTTP $http_code"
        return 1
    fi
}

# Function to test memory storage via MageAgent
test_memory_storage() {
    echo -e "\n2. Testing Memory Storage via MageAgent..."

    # Create test memory
    test_id=$(date +%s)
    test_content="Test memory from integration test ${test_id}"

    payload=$(cat <<EOF
{
  "content": "${test_content}",
  "tags": ["integration-test", "mageagent", "graphrag"],
  "metadata": {
    "test_id": "${test_id}",
    "timestamp": "$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
  }
}
EOF
)

    response=$(curl -s -X POST \
        -H "Content-Type: application/json" \
        -d "$payload" \
        -w "\n%{http_code}" \
        ${MAGEAGENT_URL}/api/memory)

    http_code=$(echo "$response" | tail -n1)
    body=$(echo "$response" | head -n-1)

    if [ "$http_code" == "200" ] || [ "$http_code" == "201" ]; then
        print_result 0 "Memory stored successfully"
        echo "   Response: $body"
        STORED_MEMORY_ID=$test_id
    else
        print_result 1 "Memory storage failed with HTTP $http_code"
        echo "   Response: $body"
        return 1
    fi
}

# Function to test memory recall
test_memory_recall() {
    echo -e "\n3. Testing Memory Recall via MageAgent..."

    if [ -z "$STORED_MEMORY_ID" ]; then
        echo "   Skipping: No memory ID from previous test"
        return 1
    fi

    payload=$(cat <<EOF
{
  "query": "integration test ${STORED_MEMORY_ID}",
  "limit": 5
}
EOF
)

    response=$(curl -s -X POST \
        -H "Content-Type: application/json" \
        -d "$payload" \
        -w "\n%{http_code}" \
        ${MAGEAGENT_URL}/api/memory/search)

    http_code=$(echo "$response" | tail -n1)
    body=$(echo "$response" | head -n-1)

    if [ "$http_code" == "200" ]; then
        print_result 0 "Memory recall successful"

        # Check if our test memory was found
        if echo "$body" | grep -q "$STORED_MEMORY_ID"; then
            print_result 0 "Test memory found in recall results"
            echo "   Found matching memory"
        else
            print_result 1 "Test memory not found in recall results"
            echo "   Response: $body"
        fi
    else
        print_result 1 "Memory recall failed with HTTP $http_code"
        echo "   Response: $body"
        return 1
    fi
}

# Function to test orchestration with GraphRAG
test_orchestration() {
    echo -e "\n4. Testing Orchestration with GraphRAG Context..."

    payload=$(cat <<EOF
{
  "task": "Analyze the latest integration test results and provide insights",
  "options": {
    "useMemory": true,
    "models": ["openai/gpt-4", "anthropic/claude-3-opus-20240229"]
  }
}
EOF
)

    response=$(curl -s -X POST \
        -H "Content-Type: application/json" \
        -d "$payload" \
        -w "\n%{http_code}" \
        ${MAGEAGENT_URL}/api/orchestrate)

    http_code=$(echo "$response" | tail -n1)
    body=$(echo "$response" | head -n-1)

    if [ "$http_code" == "200" ]; then
        print_result 0 "Orchestration request successful"

        # Check if task ID was returned
        if echo "$body" | jq -e '.taskId' > /dev/null 2>&1; then
            TASK_ID=$(echo "$body" | jq -r '.taskId')
            print_result 0 "Task ID received: $TASK_ID"
        else
            print_result 1 "No task ID in response"
        fi
    else
        print_result 1 "Orchestration failed with HTTP $http_code"
        echo "   Response: $body"
        return 1
    fi
}

# Function to test WebSocket connection
test_websocket_connection() {
    echo -e "\n5. Testing WebSocket Connection..."

    # Create a simple WebSocket test using wscat if available
    if command -v wscat &> /dev/null; then
        echo "   Testing WebSocket connection to wss://graphrag.adverant.ai/mageagent/ws"

        # Create test script for wscat
        echo '{"type":"ping"}' | timeout 5 wscat -c wss://graphrag.adverant.ai/mageagent/ws &> ws_test.log

        if grep -q "Connected" ws_test.log 2>/dev/null; then
            print_result 0 "WebSocket connection established"
        else
            print_result 1 "WebSocket connection failed"
            cat ws_test.log 2>/dev/null || echo "   No connection log available"
        fi
        rm -f ws_test.log
    else
        echo -e "${YELLOW}⚠️  wscat not installed. Install with: npm install -g wscat${NC}"
        echo "   Skipping WebSocket test"
    fi
}

# Function to test agent competition
test_agent_competition() {
    echo -e "\n6. Testing Agent Competition with GraphRAG..."

    payload=$(cat <<EOF
{
  "challenge": "Create a comprehensive test report for the GraphRAG integration",
  "competitorCount": 3,
  "models": ["openai/gpt-4", "anthropic/claude-3-opus-20240229", "meta-llama/llama-3-70b-instruct"]
}
EOF
)

    response=$(curl -s -X POST \
        -H "Content-Type: application/json" \
        -d "$payload" \
        -w "\n%{http_code}" \
        ${MAGEAGENT_URL}/api/competition)

    http_code=$(echo "$response" | tail -n1)
    body=$(echo "$response" | head -n-1)

    if [ "$http_code" == "200" ]; then
        print_result 0 "Agent competition started successfully"

        # Check competition results
        if echo "$body" | jq -e '.competitionId' > /dev/null 2>&1; then
            COMPETITION_ID=$(echo "$body" | jq -r '.competitionId')
            print_result 0 "Competition ID: $COMPETITION_ID"

            if echo "$body" | jq -e '.winner' > /dev/null 2>&1; then
                WINNER=$(echo "$body" | jq -r '.winner.model // .winner.agentId')
                print_result 0 "Winner determined: $WINNER"
            fi
        else
            print_result 1 "No competition ID in response"
        fi
    else
        print_result 1 "Agent competition failed with HTTP $http_code"
        echo "   Response: $body"
        return 1
    fi
}

# Function to test pattern retrieval
test_pattern_retrieval() {
    echo -e "\n7. Testing Pattern Retrieval from GraphRAG..."

    response=$(curl -s -w "\n%{http_code}" \
        ${MAGEAGENT_URL}/api/patterns/integration-test?limit=5)

    http_code=$(echo "$response" | tail -n1)
    body=$(echo "$response" | head -n-1)

    if [ "$http_code" == "200" ]; then
        print_result 0 "Pattern retrieval successful"

        # Check if patterns were returned
        if echo "$body" | jq -e '.patterns | length' > /dev/null 2>&1; then
            pattern_count=$(echo "$body" | jq '.patterns | length')
            print_result 0 "Retrieved $pattern_count patterns"
        else
            print_result 0 "No patterns found (expected for new context)"
        fi
    else
        print_result 1 "Pattern retrieval failed with HTTP $http_code"
        echo "   Response: $body"
        return 1
    fi
}

# Function to test direct GraphRAG connectivity from MageAgent pod
test_internal_graphrag_connection() {
    echo -e "\n8. Testing Internal GraphRAG Connection..."

    # Get a pod name from mageagent deployment
    POD_NAME=$(kubectl get pods -n mage-agent -l app=mageagent -o jsonpath='{.items[0].metadata.name}' 2>/dev/null)

    if [ -z "$POD_NAME" ]; then
        echo -e "${YELLOW}⚠️  No MageAgent pod found. Skipping internal test${NC}"
        return 1
    fi

    echo "   Testing from pod: $POD_NAME"

    # Test GraphRAG connectivity from inside the pod
    kubectl exec -n mage-agent $POD_NAME -- curl -s http://graphrag.vibe-system.svc.cluster.local:8080/health > /dev/null 2>&1

    if [ $? -eq 0 ]; then
        print_result 0 "Internal GraphRAG connection successful"
    else
        print_result 1 "Internal GraphRAG connection failed"
        echo "   Checking DNS resolution..."
        kubectl exec -n mage-agent $POD_NAME -- nslookup graphrag.vibe-system.svc.cluster.local
    fi
}

# Function to run load test
test_load_handling() {
    echo -e "\n9. Testing Load Handling with Concurrent Requests..."

    echo "   Sending 10 concurrent memory recall requests..."

    # Create temporary directory for results
    mkdir -p /tmp/mageagent-load-test

    # Send concurrent requests
    for i in {1..10}; do
        (
            curl -s -X POST \
                -H "Content-Type: application/json" \
                -d '{"query":"load test","limit":5}' \
                -w "\n%{http_code}\n%{time_total}" \
                ${MAGEAGENT_URL}/api/memory/search > /tmp/mageagent-load-test/result_$i.txt
        ) &
    done

    # Wait for all requests to complete
    wait

    # Analyze results
    success_count=0
    total_time=0

    for i in {1..10}; do
        if [ -f /tmp/mageagent-load-test/result_$i.txt ]; then
            http_code=$(tail -n2 /tmp/mageagent-load-test/result_$i.txt | head -n1)
            response_time=$(tail -n1 /tmp/mageagent-load-test/result_$i.txt)

            if [ "$http_code" == "200" ]; then
                ((success_count++))
                total_time=$(echo "$total_time + $response_time" | bc)
            fi
        fi
    done

    if [ $success_count -eq 10 ]; then
        avg_time=$(echo "scale=3; $total_time / 10" | bc)
        print_result 0 "All 10 concurrent requests succeeded"
        echo "   Average response time: ${avg_time}s"
    else
        print_result 1 "Only $success_count/10 requests succeeded"
    fi

    # Cleanup
    rm -rf /tmp/mageagent-load-test
}

# Function to generate test report
generate_report() {
    echo -e "\n========================================"
    echo "Test Summary Report"
    echo "========================================"
    echo "Date: $(date)"
    echo "MageAgent URL: ${MAGEAGENT_URL}"
    echo "GraphRAG URL: ${GRAPHRAG_URL}"
    echo ""
    echo "Test Results:"
    echo "1. Health Check: ${HEALTH_TEST:-Not Run}"
    echo "2. Memory Storage: ${MEMORY_STORE_TEST:-Not Run}"
    echo "3. Memory Recall: ${MEMORY_RECALL_TEST:-Not Run}"
    echo "4. Orchestration: ${ORCHESTRATION_TEST:-Not Run}"
    echo "5. WebSocket: ${WEBSOCKET_TEST:-Not Run}"
    echo "6. Competition: ${COMPETITION_TEST:-Not Run}"
    echo "7. Pattern Retrieval: ${PATTERN_TEST:-Not Run}"
    echo "8. Internal Connection: ${INTERNAL_TEST:-Not Run}"
    echo "9. Load Handling: ${LOAD_TEST:-Not Run}"
    echo ""
    echo "Overall Status: ${OVERALL_STATUS:-Unknown}"
    echo "========================================"
}

# Main test execution
main() {
    echo "Starting GraphRAG integration tests..."
    echo "Target: ${MAGEAGENT_URL}"
    echo ""

    # Track overall status
    OVERALL_STATUS="PASSED"

    # Run tests
    if test_health_endpoint; then
        HEALTH_TEST="PASSED"
    else
        HEALTH_TEST="FAILED"
        OVERALL_STATUS="FAILED"
    fi

    if test_memory_storage; then
        MEMORY_STORE_TEST="PASSED"
    else
        MEMORY_STORE_TEST="FAILED"
        OVERALL_STATUS="FAILED"
    fi

    if test_memory_recall; then
        MEMORY_RECALL_TEST="PASSED"
    else
        MEMORY_RECALL_TEST="FAILED"
        OVERALL_STATUS="FAILED"
    fi

    if test_orchestration; then
        ORCHESTRATION_TEST="PASSED"
    else
        ORCHESTRATION_TEST="FAILED"
        OVERALL_STATUS="FAILED"
    fi

    if test_websocket_connection; then
        WEBSOCKET_TEST="PASSED"
    else
        WEBSOCKET_TEST="SKIPPED"
    fi

    if test_agent_competition; then
        COMPETITION_TEST="PASSED"
    else
        COMPETITION_TEST="FAILED"
        OVERALL_STATUS="FAILED"
    fi

    if test_pattern_retrieval; then
        PATTERN_TEST="PASSED"
    else
        PATTERN_TEST="FAILED"
        OVERALL_STATUS="FAILED"
    fi

    if test_internal_graphrag_connection; then
        INTERNAL_TEST="PASSED"
    else
        INTERNAL_TEST="FAILED"
    fi

    if test_load_handling; then
        LOAD_TEST="PASSED"
    else
        LOAD_TEST="FAILED"
    fi

    # Generate final report
    generate_report

    # Exit with appropriate code
    if [ "$OVERALL_STATUS" == "PASSED" ]; then
        exit 0
    else
        exit 1
    fi
}

# Run main function
main "$@"