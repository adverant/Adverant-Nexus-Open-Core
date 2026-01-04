#!/bin/bash

# Production Testing Script via SSH
# Tests against the actual deployed FileProcessAgent in Kubernetes

set -e

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

SERVER="root@157.173.102.118"
POD_NAMESPACE="nexus"
POD_NAME=$(ssh $SERVER "k3s kubectl get pods -n $POD_NAMESPACE | grep fileprocess | grep Running | head -1 | awk '{print \$1}'")

echo -e "${BLUE}============================================${NC}"
echo -e "${BLUE}  FileProcessAgent Production Testing${NC}"
echo -e "${BLUE}  Testing Pod: $POD_NAME${NC}"
echo -e "${BLUE}============================================${NC}"

# Test 1: Health Check
echo -e "\n${YELLOW}[TEST 1]${NC} Health Check"
HEALTH=$(ssh $SERVER "k3s kubectl exec -n $POD_NAMESPACE $POD_NAME -c fileprocess -- curl -s http://localhost:9109/health 2>/dev/null" || echo "FAILED")

if echo "$HEALTH" | grep -q '"status":"ok"'; then
    echo -e "${GREEN}✓ PASS${NC} - Health endpoint responding"
    echo "Response: $HEALTH"
else
    echo -e "${RED}✗ FAIL${NC} - Health endpoint not responding"
    echo "Response: $HEALTH"
fi

# Test 2: Simple Text File Upload
echo -e "\n${YELLOW}[TEST 2]${NC} Simple Text File Upload"

# Create test file on server
ssh $SERVER 'cat > /tmp/test-simple.txt << EOF
Hello, World!
This is a simple test file for FileProcessAgent.
Line 3
Line 4
EOF'

# Upload via pod
RESULT=$(ssh $SERVER "k3s kubectl exec -n $POD_NAMESPACE $POD_NAME -c fileprocess -- \
  curl -s -X POST http://localhost:9109/api/process \
    -F 'file=@/tmp/test-simple.txt' \
    -F 'userId=test-user' \
    -w '\n%{http_code}' 2>/dev/null" || echo "FAILED
000")

HTTP_CODE=$(echo "$RESULT" | tail -1)
RESPONSE_BODY=$(echo "$RESULT" | sed '$d')

if [ "$HTTP_CODE" == "200" ] || [ "$HTTP_CODE" == "202" ]; then
    echo -e "${GREEN}✓ PASS${NC} - HTTP $HTTP_CODE"
    echo "Response: $RESPONSE_BODY" | head -5
else
    echo -e "${RED}✗ FAIL${NC} - HTTP $HTTP_CODE"
    echo "Response: $RESPONSE_BODY"
fi

# Test 3: ZIP Archive Upload
echo -e "\n${YELLOW}[TEST 3]${NC} ZIP Archive Upload"

# Create ZIP on server
ssh $SERVER 'cd /tmp && \
  mkdir -p test-archive && \
  echo "File 1" > test-archive/file1.txt && \
  echo "File 2" > test-archive/file2.txt && \
  echo "File 3" > test-archive/file3.txt && \
  zip -q test-archive.zip test-archive/* && \
  rm -rf test-archive'

# Upload ZIP
RESULT=$(ssh $SERVER "k3s kubectl exec -n $POD_NAMESPACE $POD_NAME -c fileprocess -- \
  curl -s -X POST http://localhost:9109/api/process \
    -F 'file=@/tmp/test-archive.zip' \
    -F 'userId=test-user' \
    -w '\n%{http_code}' 2>/dev/null" || echo "FAILED
000")

HTTP_CODE=$(echo "$RESULT" | tail -1)
RESPONSE_BODY=$(echo "$RESULT" | sed '$d')

if [ "$HTTP_CODE" == "200" ] || [ "$HTTP_CODE" == "202" ]; then
    echo -e "${GREEN}✓ PASS${NC} - HTTP $HTTP_CODE"
    echo "Response: $RESPONSE_BODY" | jq '.' 2>/dev/null || echo "$RESPONSE_BODY" | head -10

    # Check if archive extraction happened
    if echo "$RESPONSE_BODY" | grep -q "archiveFilename\|processedFiles"; then
        echo -e "${GREEN}✓ Archive extraction working${NC}"
    fi
else
    echo -e "${RED}✗ FAIL${NC} - HTTP $HTTP_CODE"
    echo "Response: $RESPONSE_BODY"
fi

# Test 4: Unknown File Type (Mock LAS)
echo -e "\n${YELLOW}[TEST 4]${NC} Unknown File Type (Mock LAS Point Cloud)"

# Create mock LAS file
ssh $SERVER 'python3 << "EOF"
with open("/tmp/test-pointcloud.las", "wb") as f:
    f.write(b"LASF")  # LAS signature
    f.write(b"\x01\x02")  # Version 1.2
    f.write(b"\x00" * 200)  # Padding
EOF'

RESULT=$(ssh $SERVER "k3s kubectl exec -n $POD_NAMESPACE $POD_NAME -c fileprocess -- \
  curl -s -X POST http://localhost:9109/api/process \
    -F 'file=@/tmp/test-pointcloud.las' \
    -F 'userId=test-user' \
    -w '\n%{http_code}' 2>/dev/null" || echo "FAILED
000")

HTTP_CODE=$(echo "$RESULT" | tail -1)
RESPONSE_BODY=$(echo "$RESULT" | sed '$d')

if [ "$HTTP_CODE" == "200" ] || [ "$HTTP_CODE" == "202" ]; then
    echo -e "${GREEN}✓ PASS${NC} - HTTP $HTTP_CODE (Unknown file type accepted)"
    echo "Response: $RESPONSE_BODY" | head -10
else
    echo -e "${RED}✗ FAIL${NC} - HTTP $HTTP_CODE"
    echo "Response: $RESPONSE_BODY"
fi

# Test 5: Database Schema Check
echo -e "\n${YELLOW}[TEST 5]${NC} Database Schema Verification"

POSTGRES_POD=$(ssh $SERVER "k3s kubectl get pods -n $POD_NAMESPACE | grep postgres | awk '{print \$1}'")

TABLES=$(ssh $SERVER "k3s kubectl exec -n $POD_NAMESPACE $POSTGRES_POD -c postgres -- \
  psql -U unified_brain -d nexus_brain -c '\dt fileprocess.*' 2>/dev/null" || echo "FAILED")

if echo "$TABLES" | grep -q "processing_patterns"; then
    echo -e "${GREEN}✓ PASS${NC} - processing_patterns table exists"
    echo "$TABLES"
else
    echo -e "${RED}✗ FAIL${NC} - processing_patterns table not found"
    echo "$TABLES"
fi

# Test 6: Check Logs for Errors
echo -e "\n${YELLOW}[TEST 6]${NC} Recent Logs Analysis"

LOGS=$(ssh $SERVER "k3s kubectl logs -n $POD_NAMESPACE $POD_NAME -c fileprocess --tail=50 2>/dev/null")

ERROR_COUNT=$(echo "$LOGS" | grep -i "error" | wc -l | tr -d ' ')
WARN_COUNT=$(echo "$LOGS" | grep -i "warn" | wc -l | tr -d ' ')

echo "Errors in last 50 lines: $ERROR_COUNT"
echo "Warnings in last 50 lines: $WARN_COUNT"

if [ "$ERROR_COUNT" -gt 0 ]; then
    echo -e "${YELLOW}Recent errors:${NC}"
    echo "$LOGS" | grep -i "error" | head -5
fi

# Test 7: Service Endpoints
echo -e "\n${YELLOW}[TEST 7]${NC} Service Configuration"

SVC_INFO=$(ssh $SERVER "k3s kubectl get svc nexus-fileprocess -n $POD_NAMESPACE -o wide")
echo "$SVC_INFO"

# Summary
echo -e "\n${BLUE}============================================${NC}"
echo -e "${BLUE}  Test Summary${NC}"
echo -e "${BLUE}============================================${NC}"

echo -e "\n${GREEN}Tests completed.${NC}"
echo "Check the output above for any failures."
