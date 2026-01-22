#!/bin/bash
# Test GraphRAG Geo Endpoints
# This script tests all geo-related endpoints to verify they work correctly

set -e

# Configuration
GRAPHRAG_URL="http://localhost:9082"
API_BASE="${GRAPHRAG_URL}/api/v1/data-explorer"

# Test headers
HEADERS=(
  -H "Content-Type: application/json"
  -H "X-Company-ID: test-company"
  -H "X-App-ID: test-app"
  -H "X-User-ID: test-user"
)

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo "=== GraphRAG Geo Endpoints Testing ==="
echo ""
echo "Target: ${GRAPHRAG_URL}"
echo ""

# Function to test an endpoint
test_endpoint() {
  local name=$1
  local method=$2
  local endpoint=$3
  local data=$4

  echo -e "${YELLOW}Testing: ${name}${NC}"
  echo "  Endpoint: ${method} ${endpoint}"

  if [ "$method" = "GET" ]; then
    response=$(curl -s -w "\n%{http_code}" "${HEADERS[@]}" "${API_BASE}${endpoint}")
  else
    response=$(curl -s -w "\n%{http_code}" -X "${method}" "${HEADERS[@]}" -d "${data}" "${API_BASE}${endpoint}")
  fi

  http_code=$(echo "$response" | tail -n1)
  body=$(echo "$response" | head -n-1)

  if [ "$http_code" -ge 200 ] && [ "$http_code" -lt 300 ]; then
    echo -e "  ${GREEN}✓ Status: ${http_code}${NC}"

    # Pretty print JSON if jq is available
    if command -v jq &> /dev/null; then
      echo "  Response preview:"
      echo "$body" | jq -C '.' | head -n 10
      record_count=$(echo "$body" | jq -r 'if type == "array" then length elif .memories then (.memories | length) else 0 end')
      if [ "$record_count" != "null" ] && [ "$record_count" -gt 0 ]; then
        echo -e "  ${GREEN}Records returned: ${record_count}${NC}"
      fi
    else
      echo "  Response: ${body:0:200}..."
    fi
  else
    echo -e "  ${RED}✗ Status: ${http_code}${NC}"
    echo "  Error: ${body}"
  fi

  echo ""
}

# Test 1: Geo Memories (Europe)
echo "=== Test 1: Geo Memories (Europe) ==="
test_endpoint \
  "Geo Memories - Europe" \
  "POST" \
  "/geo/memories" \
  '{"north": 60, "south": 35, "east": 30, "west": -10}'

# Test 2: Geo Memories (North America)
echo "=== Test 2: Geo Memories (North America) ==="
test_endpoint \
  "Geo Memories - North America" \
  "POST" \
  "/geo/memories" \
  '{"north": 50, "south": 25, "east": -60, "west": -130}'

# Test 3: Geo Memories (Asia)
echo "=== Test 3: Geo Memories (Asia) ==="
test_endpoint \
  "Geo Memories - Asia" \
  "POST" \
  "/geo/memories" \
  '{"north": 50, "south": 0, "east": 150, "west": 100}'

# Test 4: Geo Heatmap
echo "=== Test 4: Geo Heatmap ==="
test_endpoint \
  "Geo Heatmap - Europe" \
  "POST" \
  "/geo/heatmap" \
  '{"north": 60, "south": 35, "east": 30, "west": -10, "resolution": 10}'

# Test 5: Geo Clusters (High Zoom)
echo "=== Test 5: Geo Clusters (High Zoom) ==="
test_endpoint \
  "Geo Clusters - Zoom 12" \
  "POST" \
  "/geo/clusters" \
  '{"north": 49, "south": 48.5, "east": 2.5, "west": 2, "zoom": 12}'

# Test 6: Geo Clusters (Low Zoom)
echo "=== Test 6: Geo Clusters (Low Zoom) ==="
test_endpoint \
  "Geo Clusters - Zoom 5" \
  "POST" \
  "/geo/clusters" \
  '{"north": 60, "south": 35, "east": 30, "west": -10, "zoom": 5}'

# Test 7: Geo Search (Basic)
echo "=== Test 7: Geo Search (Basic) ==="
test_endpoint \
  "Geo Search - All memories" \
  "POST" \
  "/geo/search" \
  '{"bounds": {"north": 60, "south": 35, "east": 30, "west": -10}}'

# Test 8: Geo Search (With Query)
echo "=== Test 8: Geo Search (With Query) ==="
test_endpoint \
  "Geo Search - With query" \
  "POST" \
  "/geo/search" \
  '{"bounds": {"north": 60, "south": 35, "east": 30, "west": -10}, "query": "conference"}'

# Test 9: Geo Search (With Filters)
echo "=== Test 9: Geo Search (With Filters) ==="
test_endpoint \
  "Geo Search - With tag filter" \
  "POST" \
  "/geo/search" \
  '{"bounds": {"north": 60, "south": 35, "east": 30, "west": -10}, "filters": {"tags": ["travel", "location"]}}'

# Test 10: Geo Search (With Relationships)
echo "=== Test 10: Geo Search (With Relationships) ==="
test_endpoint \
  "Geo Search - Include relationships" \
  "POST" \
  "/geo/search" \
  '{"bounds": {"north": 60, "south": 35, "east": 30, "west": -10}, "includeRelationships": true}'

# Test 11: Geo Search (With Communities)
echo "=== Test 11: Geo Search (With Communities) ==="
test_endpoint \
  "Geo Search - Include communities" \
  "POST" \
  "/geo/search" \
  '{"bounds": {"north": 60, "south": 35, "east": 30, "west": -10}, "includeCommunities": true}'

# Test 12: Geo Temporal
echo "=== Test 12: Geo Temporal ==="
test_endpoint \
  "Geo Temporal - Daily buckets" \
  "POST" \
  "/geo/temporal" \
  "{\"bounds\": {\"north\": 60, \"south\": 35, \"east\": 30, \"west\": -10}, \"startDate\": \"$(date -u -d '30 days ago' +%Y-%m-%d)\", \"endDate\": \"$(date -u +%Y-%m-%d)\", \"bucketSize\": \"day\"}"

# Test 13: Geo Temporal (Weekly)
echo "=== Test 13: Geo Temporal (Weekly) ==="
test_endpoint \
  "Geo Temporal - Weekly buckets" \
  "POST" \
  "/geo/temporal" \
  "{\"bounds\": {\"north\": 60, \"south\": 35, \"east\": 30, \"west\": -10}, \"startDate\": \"$(date -u -d '90 days ago' +%Y-%m-%d)\", \"endDate\": \"$(date -u +%Y-%m-%d)\", \"bucketSize\": \"week\"}"

# Test 14: Geo Ask (AI Query)
echo "=== Test 14: Geo Ask (AI Query) ==="
test_endpoint \
  "Geo Ask - Simple question" \
  "POST" \
  "/geo/ask" \
  '{"bounds": {"north": 60, "south": 35, "east": 30, "west": -10}, "question": "What are the most popular places visited?"}'

# Test 15: Related Memories
echo "=== Test 15: Related Memories ==="
# First, get a memory ID
memory_response=$(curl -s "${HEADERS[@]}" -X POST -d '{"north": 60, "south": 35, "east": 30, "west": -10}' "${API_BASE}/geo/memories")
memory_id=$(echo "$memory_response" | jq -r '.[0].id // empty')

if [ -n "$memory_id" ]; then
  test_endpoint \
    "Related Memories" \
    "GET" \
    "/memories/${memory_id}/related?limit=5" \
    ""
else
  echo -e "${YELLOW}Skipping related memories test - no memory ID found${NC}"
  echo ""
fi

echo "=== All Tests Complete ==="
echo ""
echo "Summary:"
echo "  All geo endpoints have been tested"
echo "  Check output above for any failures (marked with ✗)"
echo ""
echo "Next steps:"
echo "  1. Verify data appears correctly in the frontend map"
echo "  2. Test interactive features (clustering, filtering, search)"
echo "  3. Verify performance with larger datasets"
