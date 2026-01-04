#!/bin/bash

# Cluster-Internal Functional Testing Script
# Executes progressive tests inside Kubernetes cluster to verify FileProcessAgent

set -e

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

SERVER="root@157.173.102.118"
NAMESPACE="nexus"
SERVICE_URL="http://nexus-fileprocess:9099"
TEST_POD="fileprocess-test"

echo -e "${BLUE}============================================${NC}"
echo -e "${BLUE}  FileProcessAgent Cluster-Internal Testing${NC}"
echo -e "${BLUE}  Service: ${SERVICE_URL}${NC}"
echo -e "${BLUE}============================================${NC}"

# Step 1: Create test pod
echo -e "\n${YELLOW}[STEP 1]${NC} Creating test pod with tools..."
scp test-pod.yaml ${SERVER}:/tmp/
ssh ${SERVER} "k3s kubectl apply -f /tmp/test-pod.yaml"

# Wait for pod to be ready
echo -e "${YELLOW}Waiting for pod to be ready...${NC}"
ssh ${SERVER} "k3s kubectl wait --for=condition=Ready pod/${TEST_POD} -n ${NAMESPACE} --timeout=60s" || {
  echo -e "${RED}✗ FAIL${NC} - Pod not ready after 60s"
  exit 1
}

echo -e "${GREEN}✓ Test pod ready${NC}"

# Step 2: Level 1 - Simple Text File
echo -e "\n${BLUE}============================================${NC}"
echo -e "${BLUE}  LEVEL 1: Simple Text File${NC}"
echo -e "${BLUE}============================================${NC}"

ssh ${SERVER} << 'LEVEL1'
k3s kubectl exec -n nexus fileprocess-test -- sh -c '
cat > /tmp/test.txt << EOF
Hello, FileProcessAgent!
This is a simple text file test.
Line 3
Line 4
EOF

echo "Uploading test.txt..."
RESPONSE=$(curl -s -w "\n%{http_code}" -X POST http://nexus-fileprocess:9099/api/process \
  -F "file=@/tmp/test.txt" \
  -F "userId=test-user" 2>&1)

HTTP_CODE=$(echo "$RESPONSE" | tail -1)
BODY=$(echo "$RESPONSE" | sed "$ d")

echo "HTTP Status: $HTTP_CODE"
echo "Response: $BODY"

if [ "$HTTP_CODE" = "200" ] || [ "$HTTP_CODE" = "202" ]; then
  echo "✓ PASS - Simple text file accepted"
else
  echo "✗ FAIL - HTTP $HTTP_CODE"
fi
'
LEVEL1

# Step 3: Level 2 - ZIP Archive
echo -e "\n${BLUE}============================================${NC}"
echo -e "${BLUE}  LEVEL 2: ZIP Archive Extraction${NC}"
echo -e "${BLUE}============================================${NC}"

ssh ${SERVER} << 'LEVEL2'
k3s kubectl exec -n nexus fileprocess-test -- sh -c '
mkdir -p /tmp/archive-test
echo "File 1 content" > /tmp/archive-test/file1.txt
echo "File 2 content" > /tmp/archive-test/file2.txt
echo "File 3 content" > /tmp/archive-test/file3.txt

cd /tmp && zip -q test-archive.zip archive-test/*

echo "Uploading test-archive.zip..."
RESPONSE=$(curl -s -w "\n%{http_code}" -X POST http://nexus-fileprocess:9099/api/process \
  -F "file=@/tmp/test-archive.zip" \
  -F "userId=test-user" 2>&1)

HTTP_CODE=$(echo "$RESPONSE" | tail -1)
BODY=$(echo "$RESPONSE" | sed "$ d")

echo "HTTP Status: $HTTP_CODE"
echo "Response: $BODY" | head -20

if [ "$HTTP_CODE" = "200" ] || [ "$HTTP_CODE" = "202" ]; then
  echo "✓ PASS - ZIP archive accepted"

  # Check if extraction happened
  if echo "$BODY" | grep -q "archiveFilename\|processedFiles\|totalFiles"; then
    echo "✓ PASS - Archive extraction working"
  else
    echo "⚠ WARNING - Archive accepted but extraction metadata missing"
  fi
else
  echo "✗ FAIL - HTTP $HTTP_CODE"
fi
'
LEVEL2

# Step 4: Level 3 - Unknown File Type (Mock LAS Point Cloud)
echo -e "\n${BLUE}============================================${NC}"
echo -e "${BLUE}  LEVEL 3: Unknown File Type (Mock LAS)${NC}"
echo -e "${BLUE}============================================${NC}"

ssh ${SERVER} << 'LEVEL3'
k3s kubectl exec -n nexus fileprocess-test -- sh -c '
# Create mock LAS file with proper signature
python3 << EOF
with open("/tmp/pointcloud.las", "wb") as f:
    # LAS 1.2 header
    f.write(b"LASF")  # File signature
    f.write(b"\x01\x02")  # Version 1.2
    f.write(b"\x00" * 200)  # Header padding
    # Mock point data
    f.write(b"\x00" * 1000)  # 1000 bytes of point data
EOF

echo "Uploading pointcloud.las (unknown file type)..."
RESPONSE=$(curl -s -w "\n%{http_code}" -X POST http://nexus-fileprocess:9099/api/process \
  -F "file=@/tmp/pointcloud.las" \
  -F "userId=test-user" 2>&1)

HTTP_CODE=$(echo "$RESPONSE" | tail -1)
BODY=$(echo "$RESPONSE" | sed "$ d")

echo "HTTP Status: $HTTP_CODE"
echo "Response: $BODY" | head -20

if [ "$HTTP_CODE" = "200" ] || [ "$HTTP_CODE" = "202" ]; then
  echo "✓ PASS - Unknown file type accepted (no MIME whitelist rejection)"

  # Check if routed to MageAgent
  if echo "$BODY" | grep -q "jobId\|processing"; then
    echo "✓ PASS - File queued for processing"
  fi
else
  echo "✗ FAIL - HTTP $HTTP_CODE (Unknown file type rejected - MIME whitelist still active?)"
fi
'
LEVEL3

# Step 5: Check Database for Pattern Storage
echo -e "\n${BLUE}============================================${NC}"
echo -e "${BLUE}  DATABASE CHECK: Pattern Storage${NC}"
echo -e "${BLUE}============================================${NC}"

ssh ${SERVER} << 'DBCHECK'
POSTGRES_POD=$(k3s kubectl get pods -n nexus | grep postgres | grep Running | awk '{print $1}')

echo "Checking processing_patterns table..."
k3s kubectl exec -n nexus ${POSTGRES_POD} -c postgres -- \
  psql -U unified_brain -d nexus_brain -c "SELECT COUNT(*) as pattern_count FROM fileprocess.processing_patterns;" 2>/dev/null || echo "Query failed"

echo "Checking recent processing jobs..."
k3s kubectl exec -n nexus ${POSTGRES_POD} -c postgres -- \
  psql -U unified_brain -d nexus_brain -c "SELECT COUNT(*) as job_count FROM fileprocess.processing_jobs WHERE created_at > NOW() - INTERVAL '5 minutes';" 2>/dev/null || echo "Query failed"
DBCHECK

# Step 6: Level 4 - Nested Archive (ZIP within ZIP)
echo -e "\n${BLUE}============================================${NC}"
echo -e "${BLUE}  LEVEL 4: Nested Archive (Recursive Extraction)${NC}"
echo -e "${BLUE}============================================${NC}"

ssh ${SERVER} << 'LEVEL4'
k3s kubectl exec -n nexus fileprocess-test -- sh -c '
# Create inner ZIP
mkdir -p /tmp/inner
echo "Inner file 1" > /tmp/inner/inner1.txt
echo "Inner file 2" > /tmp/inner/inner2.txt
cd /tmp && zip -q inner.zip inner/*

# Create outer ZIP containing inner ZIP
mkdir -p /tmp/outer
mv /tmp/inner.zip /tmp/outer/
echo "Outer file" > /tmp/outer/outer.txt
cd /tmp && zip -q nested.zip outer/*

echo "Uploading nested.zip (ZIP containing ZIP)..."
RESPONSE=$(curl -s -w "\n%{http_code}" -X POST http://nexus-fileprocess:9099/api/process \
  -F "file=@/tmp/nested.zip" \
  -F "userId=test-user" 2>&1)

HTTP_CODE=$(echo "$RESPONSE" | tail -1)
BODY=$(echo "$RESPONSE" | sed "$ d")

echo "HTTP Status: $HTTP_CODE"
echo "Response: $BODY" | head -30

if [ "$HTTP_CODE" = "200" ] || [ "$HTTP_CODE" = "202" ]; then
  echo "✓ PASS - Nested archive accepted"

  # Check if recursive extraction mentioned
  if echo "$BODY" | grep -q "totalFiles"; then
    echo "✓ PASS - Archive extraction initiated"
  fi
else
  echo "✗ FAIL - HTTP $HTTP_CODE"
fi
'
LEVEL4

# Step 7: Check FileProcessAgent Logs
echo -e "\n${BLUE}============================================${NC}"
echo -e "${BLUE}  LOG ANALYSIS: Recent Errors${NC}"
echo -e "${BLUE}============================================${NC}"

ssh ${SERVER} << 'LOGS'
FILEPROCESS_POD=$(k3s kubectl get pods -n nexus | grep fileprocess | grep Running | head -1 | awk '{print $1}')

echo "Recent logs (last 100 lines):"
k3s kubectl logs -n nexus ${FILEPROCESS_POD} -c fileprocess --tail=100 | grep -E "ERROR|WARN|archive|extraction|MageAgent|sandbox|pattern" || echo "No matching logs found"

echo ""
echo "Error count in last 100 lines:"
ERROR_COUNT=$(k3s kubectl logs -n nexus ${FILEPROCESS_POD} -c fileprocess --tail=100 | grep -i error | wc -l)
echo "Errors: $ERROR_COUNT"
LOGS

# Step 8: Test MageAgent Endpoint Reachability
echo -e "\n${BLUE}============================================${NC}"
echo -e "${BLUE}  MAGEAGENT INTEGRATION: Endpoint Check${NC}"
echo -e "${BLUE}============================================${NC}"

ssh ${SERVER} << 'MAGEAGENT'
k3s kubectl exec -n nexus fileprocess-test -- sh -c '
echo "Testing MageAgent endpoint reachability..."
RESPONSE=$(curl -s -w "\n%{http_code}" -X GET http://nexus-mageagent:8080/health 2>&1 || echo "Connection failed")

HTTP_CODE=$(echo "$RESPONSE" | tail -1)
BODY=$(echo "$RESPONSE" | sed "$ d")

echo "HTTP Status: $HTTP_CODE"
echo "Response: $BODY"

if [ "$HTTP_CODE" = "200" ]; then
  echo "✓ PASS - MageAgent service reachable"
else
  echo "✗ FAIL - MageAgent unreachable or unhealthy"
fi

echo ""
echo "Testing UniversalTaskExecutor endpoint..."
RESPONSE=$(curl -s -w "\n%{http_code}" -X POST http://nexus-mageagent:8080/mageagent/api/internal/orchestrate \
  -H "Content-Type: application/json" \
  -d "{\"task\": \"test\", \"input\": \"test\"}" 2>&1 || echo "Connection failed")

HTTP_CODE=$(echo "$RESPONSE" | tail -1)
echo "Orchestrate endpoint HTTP: $HTTP_CODE"
'
MAGEAGENT

# Step 9: Test Sandbox Endpoint Reachability
echo -e "\n${BLUE}============================================${NC}"
echo -e "${BLUE}  SANDBOX INTEGRATION: Endpoint Check${NC}"
echo -e "${BLUE}============================================${NC}"

ssh ${SERVER} << 'SANDBOX'
k3s kubectl exec -n nexus fileprocess-test -- sh -c '
echo "Testing Sandbox endpoint reachability..."
RESPONSE=$(curl -s -w "\n%{http_code}" -X GET http://nexus-sandbox:8090/health 2>&1 || echo "Connection failed")

HTTP_CODE=$(echo "$RESPONSE" | tail -1)
BODY=$(echo "$RESPONSE" | sed "$ d")

echo "HTTP Status: $HTTP_CODE"
echo "Response: $BODY"

if [ "$HTTP_CODE" = "200" ]; then
  echo "✓ PASS - Sandbox service reachable"
else
  echo "✗ FAIL - Sandbox unreachable or unhealthy"
fi
'
SANDBOX

# Step 10: Test GraphRAG Endpoint Reachability
echo -e "\n${BLUE}============================================${NC}"
echo -e "${BLUE}  GRAPHRAG INTEGRATION: Endpoint Check${NC}"
echo -e "${BLUE}============================================${NC}"

ssh ${SERVER} << 'GRAPHRAG'
k3s kubectl exec -n nexus fileprocess-test -- sh -c '
echo "Testing GraphRAG endpoint reachability..."
RESPONSE=$(curl -s -w "\n%{http_code}" -X GET http://nexus-graphrag:8091/health 2>&1 || echo "Connection failed")

HTTP_CODE=$(echo "$RESPONSE" | tail -1)
BODY=$(echo "$RESPONSE" | sed "$ d")

echo "HTTP Status: $HTTP_CODE"
echo "Response: $BODY"

if [ "$HTTP_CODE" = "200" ]; then
  echo "✓ PASS - GraphRAG service reachable"
else
  echo "✗ FAIL - GraphRAG unreachable or unhealthy"
fi
'
GRAPHRAG

# Summary
echo -e "\n${BLUE}============================================${NC}"
echo -e "${BLUE}  TEST SUMMARY${NC}"
echo -e "${BLUE}============================================${NC}"

echo -e "\n${GREEN}Cluster-internal tests completed.${NC}"
echo "Check output above for failures and errors."

# Cleanup option
echo -e "\n${YELLOW}To cleanup test pod:${NC}"
echo "ssh ${SERVER} \"k3s kubectl delete pod ${TEST_POD} -n ${NAMESPACE}\""
