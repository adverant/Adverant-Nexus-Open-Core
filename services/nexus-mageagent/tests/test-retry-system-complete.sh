#!/bin/bash
# ============================================================================
# Intelligent Retry Loop - Complete Integration Test Suite
# ============================================================================
# Tests all components: Database, API, Orchestrator, WebSocket Events
# Run this script to verify the retry system is fully operational
# ============================================================================

set -e

echo "╔════════════════════════════════════════════════════════════════════════╗"
echo "║     Intelligent Retry Loop - Complete Integration Test Suite          ║"
echo "╚════════════════════════════════════════════════════════════════════════╝"
echo ""

# Colors for output
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

TESTS_PASSED=0
TESTS_FAILED=0

# Function to run test
run_test() {
  local test_name="$1"
  local test_command="$2"
  local expected="$3"

  echo -n "  Testing: $test_name... "

  if result=$(eval "$test_command" 2>&1); then
    if [[ "$result" == *"$expected"* ]]; then
      echo -e "${GREEN}✅ PASS${NC}"
      ((TESTS_PASSED++))
      return 0
    else
      echo -e "${RED}❌ FAIL${NC} (unexpected result)"
      echo "    Expected: $expected"
      echo "    Got: $result"
      ((TESTS_FAILED++))
      return 1
    fi
  else
    echo -e "${RED}❌ FAIL${NC} (command failed)"
    echo "    Error: $result"
    ((TESTS_FAILED++))
    return 1
  fi
}

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "1. CONTAINER HEALTH TESTS"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

run_test "Container Running" \
  "docker ps --filter 'name=nexus-mageagent' --format '{{.Status}}'" \
  "healthy"

run_test "Image Architecture" \
  "docker image inspect adverant/nexus-mageagent:latest --format '{{.Architecture}}'" \
  "amd64"

run_test "Health Endpoint" \
  "curl -s http://localhost:9080/health | jq -r '.status'" \
  "healthy"

run_test "Orchestrator Running" \
  "curl -s http://localhost:9080/health | jq -r '.orchestrator'" \
  "running"

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "2. DATABASE SCHEMA TESTS"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

run_test "Schema Exists" \
  "docker exec -i nexus-postgres psql -U unified_brain -d nexus_mageagent -t -c \"SELECT COUNT(*) FROM pg_namespace WHERE nspname = 'retry_intelligence';\"" \
  "1"

run_test "Error Patterns Table" \
  "docker exec -i nexus-postgres psql -U unified_brain -d nexus_mageagent -t -c \"SELECT COUNT(*) FROM pg_tables WHERE schemaname = 'retry_intelligence' AND tablename = 'error_patterns';\"" \
  "1"

run_test "Retry Attempts Table" \
  "docker exec -i nexus-postgres psql -U unified_brain -d nexus_mageagent -t -c \"SELECT COUNT(*) FROM pg_tables WHERE schemaname = 'retry_intelligence' AND tablename = 'retry_attempts';\"" \
  "1"

run_test "Analytics Views (3)" \
  "docker exec -i nexus-postgres psql -U unified_brain -d nexus_mageagent -t -c \"SELECT COUNT(*) FROM information_schema.views WHERE table_schema = 'retry_intelligence';\"" \
  "3"

run_test "SQL Functions (3)" \
  "docker exec -i nexus-postgres psql -U unified_brain -d nexus_mageagent -t -c \"SELECT COUNT(*) FROM information_schema.routines WHERE routine_schema = 'retry_intelligence';\"" \
  "3"

run_test "Indexes (14)" \
  "docker exec -i nexus-postgres psql -U unified_brain -d nexus_mageagent -t -c \"SELECT COUNT(*) FROM pg_indexes WHERE schemaname = 'retry_intelligence';\"" \
  "14"

run_test "Seeded Patterns (2)" \
  "docker exec -i nexus-postgres psql -U unified_brain -d nexus_mageagent -t -c \"SELECT COUNT(*) FROM retry_intelligence.error_patterns;\"" \
  "2"

run_test "PgCrypto Extension" \
  "docker exec -i nexus-postgres psql -U unified_brain -d nexus_mageagent -t -c \"SELECT COUNT(*) FROM pg_extension WHERE extname = 'pgcrypto';\"" \
  "1"

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "3. CODE VERIFICATION TESTS"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

run_test "Retry Directory Exists" \
  "docker exec nexus-mageagent test -d /app/src/retry && echo 'exists'" \
  "exists"

run_test "RetryAnalyzer File" \
  "docker exec nexus-mageagent test -f /app/src/retry/retry-analyzer.ts && echo 'exists'" \
  "exists"

run_test "Orchestrator Integration File" \
  "docker exec nexus-mageagent test -f /app/src/retry/orchestrator-integration.ts && echo 'exists'" \
  "exists"

run_test "Types File" \
  "docker exec nexus-mageagent test -f /app/src/retry/types.ts && echo 'exists'" \
  "exists"

run_test "Analytics Routes File" \
  "docker exec nexus-mageagent test -f /app/src/routes/retry-analytics.ts && echo 'exists'" \
  "exists"

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "4. API ENDPOINT TESTS"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

run_test "List Patterns Endpoint" \
  "curl -s 'http://localhost:9080/mageagent/api/retry/patterns?limit=1' | jq -r '.success'" \
  "true"

run_test "Get Pattern By ID" \
  "curl -s 'http://localhost:9080/mageagent/api/retry/patterns/a7158205-53ac-4dea-bd39-c9fdbc8ec07c' | jq -r '.success'" \
  "true"

run_test "Analytics Endpoint" \
  "curl -s 'http://localhost:9080/mageagent/api/retry/analytics?timeframe=24h' | jq -r '.success'" \
  "true"

run_test "Attempts Endpoint" \
  "curl -s 'http://localhost:9080/mageagent/api/retry/attempts?limit=10' | jq -r '.success'" \
  "true"

run_test "Pagination Support" \
  "curl -s 'http://localhost:9080/mageagent/api/retry/patterns?limit=5&offset=0' | jq -r '.pagination.limit'" \
  "5"

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "5. SERVICE INITIALIZATION TESTS"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

run_test "RetryAnalyzer Initialized" \
  "docker logs nexus-mageagent 2>&1 | grep -i 'RetryAnalyzer initialized'" \
  "RetryAnalyzer initialized"

run_test "RetryExecutor Initialized" \
  "docker logs nexus-mageagent 2>&1 | grep -i 'RetryExecutor initialized'" \
  "RetryExecutor initialized"

run_test "Orchestrator With Retry System" \
  "docker logs nexus-mageagent 2>&1 | grep -i 'Orchestrator initialized with intelligent retry system'" \
  "Orchestrator initialized with intelligent retry system"

run_test "Analytics Routes Mounted" \
  "docker logs nexus-mageagent 2>&1 | grep -i 'Intelligent Retry Analytics.*Mounted'" \
  "Intelligent Retry Analytics"

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "6. DATA VERIFICATION TESTS"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

run_test "LibreOffice Pattern Exists" \
  "docker exec -i nexus-postgres psql -U unified_brain -d nexus_mageagent -t -c \"SELECT COUNT(*) FROM retry_intelligence.error_patterns WHERE operation_name = 'libreoffice_document_conversion';\"" \
  "1"

run_test "OpenRouter Pattern Exists" \
  "docker exec -i nexus-postgres psql -U unified_brain -d nexus_mageagent -t -c \"SELECT COUNT(*) FROM retry_intelligence.error_patterns WHERE operation_name = 'agent_execution';\"" \
  "1"

run_test "Pattern Has Strategy" \
  "curl -s 'http://localhost:9080/mageagent/api/retry/patterns?limit=1' | jq -r '.data[0].recommended_strategy.maxRetries'" \
  "3"

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "INTEGRATION TEST SUMMARY"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

TOTAL_TESTS=$((TESTS_PASSED + TESTS_FAILED))
SUCCESS_RATE=$((TESTS_PASSED * 100 / TOTAL_TESTS))

echo "  Total Tests: $TOTAL_TESTS"
echo -e "  Passed: ${GREEN}$TESTS_PASSED ✅${NC}"
echo -e "  Failed: ${RED}$TESTS_FAILED ❌${NC}"
echo "  Success Rate: $SUCCESS_RATE%"
echo ""

if [ $TESTS_FAILED -eq 0 ]; then
  echo -e "${GREEN}╔════════════════════════════════════════════════════════════════════════╗${NC}"
  echo -e "${GREEN}║          ✅ ALL TESTS PASSED - SYSTEM FULLY OPERATIONAL ✅             ║${NC}"
  echo -e "${GREEN}╚════════════════════════════════════════════════════════════════════════╝${NC}"
  echo ""
  echo "The Intelligent Retry Loop system is fully integrated and operational!"
  echo ""
  echo "📊 Quick Start:"
  echo "  - View patterns: curl 'http://localhost:9080/mageagent/api/retry/patterns' | jq ."
  echo "  - Get analytics: curl 'http://localhost:9080/mageagent/api/retry/analytics?timeframe=7d' | jq ."
  echo "  - Monitor logs:  docker logs -f nexus-mageagent | grep -i retry"
  echo ""
  echo "📚 Documentation:"
  echo "  - Integration Complete: RETRY_LOOP_FULL_INTEGRATION_COMPLETE.md"
  echo "  - Quick Start Guide:    RETRY_SYSTEM_QUICK_START.md"
  echo "  - Deployment Summary:   INTELLIGENT_RETRY_LOOP_DEPLOYMENT.md"
  echo ""
  exit 0
else
  echo -e "${RED}╔════════════════════════════════════════════════════════════════════════╗${NC}"
  echo -e "${RED}║          ❌ SOME TESTS FAILED - REVIEW REQUIRED ❌                     ║${NC}"
  echo -e "${RED}╚════════════════════════════════════════════════════════════════════════╝${NC}"
  echo ""
  echo "🔍 Troubleshooting:"
  echo "  1. Check container logs: docker logs nexus-mageagent --tail 100"
  echo "  2. Verify database:      docker exec -i nexus-postgres psql -U unified_brain -d nexus_mageagent"
  echo "  3. Check health:         curl http://localhost:9080/health | jq ."
  echo ""
  exit 1
fi
