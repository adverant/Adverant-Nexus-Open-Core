# Approach C: Phase 4-8 - Comprehensive Testing Strategy

**Date**: 2025-11-27
**Status**: IN PROGRESS
**Phases**: 4 (Circuit Breaker), 5 (Prometheus Metrics), 6 (Chaos Testing), 7 (Test Suite), 8 (Coverage Target)

---

## Executive Summary

This document outlines the comprehensive testing strategy for FileProcessAgent following the successful deployment of Phases 60a-60c (OCR fix, health check, pattern learning). The goal is to achieve production-grade reliability through multi-layer testing, observability, and chaos engineering.

### Current State
- **Phase 60a**: MageAgent OCR endpoints fixed (dual-mount pattern)
- **Phase 60b**: Health check warnings eliminated (`/api/health` alias)
- **Phase 60c**: Pattern learning integration deployed (6x speedup potential)
- **Current Coverage**: 12.6% (baseline before comprehensive testing)
- **Target Coverage**: >90%

---

## Phase 4: Circuit Breaker Testing (SandboxClient)

### Objective
Validate SandboxClient's circuit breaker behavior under failure conditions to ensure graceful degradation.

### Circuit Breaker Requirements
- **Open Circuit**: Stop calling failing service after N failures
- **Half-Open**: Periodically test if service has recovered
- **Closed**: Resume normal operation when service healthy
- **Fail-Fast**: Return errors immediately when circuit open
- **Metrics**: Track circuit state, failure count, recovery attempts

### Test Cases

#### 1. Connection Failure Tests
```typescript
describe('SandboxClient Circuit Breaker - Connection Failures', () => {
  it('should open circuit after 3 consecutive connection failures', async () => {
    // Simulate sandbox service down
    // Assert circuit opens after threshold
    // Assert subsequent calls fail-fast
  });

  it('should enter half-open state after cooldown period', async () => {
    // Open circuit via failures
    // Wait for cooldown (30s)
    // Assert next call attempts connection
  });

  it('should close circuit after successful half-open request', async () => {
    // Open circuit, wait for half-open
    // Simulate successful request
    // Assert circuit closes, normal operation resumes
  });

  it('should reopen circuit if half-open request fails', async () => {
    // Open circuit, wait for half-open
    // Simulate failed request
    // Assert circuit reopens, cooldown resets
  });
});
```

#### 2. Timeout Tests
```typescript
describe('SandboxClient Circuit Breaker - Timeouts', () => {
  it('should count timeouts as failures toward circuit threshold', async () => {
    // Simulate slow responses exceeding timeout (30s default)
    // Assert timeouts count toward failure threshold
    // Assert circuit opens after 3 timeouts
  });

  it('should respect custom timeout values', async () => {
    // Execute task with custom timeout (60s)
    // Assert timeout honored
    // Assert failure recorded
  });
});
```

#### 3. Memory Limit Tests
```typescript
describe('SandboxClient Circuit Breaker - Memory Limits', () => {
  it('should reject tasks exceeding memory limit', async () => {
    // Attempt task with 10GB memory requirement (max: 8GB)
    // Assert validation error before execution
    // Assert does NOT count toward circuit breaker
  });

  it('should allow tasks within memory limit', async () => {
    // Execute task with 4GB memory requirement
    // Assert executes successfully
  });
});
```

#### 4. Recovery Tests
```typescript
describe('SandboxClient Circuit Breaker - Recovery', () => {
  it('should gradually recover after service becomes healthy', async () => {
    // Open circuit via failures
    // Restore sandbox service
    // Assert half-open attempt succeeds
    // Assert circuit closes
    // Assert subsequent requests succeed
  });

  it('should maintain failure statistics across recovery', async () => {
    // Track total failures across open/close cycles
    // Assert statistics persist for monitoring
  });
});
```

### Implementation Files
- **Test File**: `api/src/__tests__/clients/SandboxClient.circuitbreaker.test.ts`
- **Source File**: `api/src/clients/SandboxClient.ts`
- **Expected Coverage**: 95%+ for circuit breaker logic

---

## Phase 5: Prometheus Metrics for Observability

### Objective
Instrument FileProcessAgent with comprehensive metrics for production monitoring and alerting.

### Metric Categories

#### 1. Request Metrics
```typescript
// Counter: Total requests received
fileprocess_requests_total{method, route, status}

// Histogram: Request duration
fileprocess_request_duration_seconds{method, route}

// Gauge: In-flight requests
fileprocess_requests_inflight{method, route}
```

#### 2. Pattern Learning Metrics
```typescript
// Counter: Pattern cache hits/misses
fileprocess_pattern_cache_hits_total{mime_type}
fileprocess_pattern_cache_misses_total{mime_type}

// Histogram: Pattern execution time
fileprocess_pattern_execution_seconds{pattern_id, mime_type}

// Gauge: Cached patterns count
fileprocess_cached_patterns_count

// Counter: Pattern storage successes/failures
fileprocess_pattern_storage_total{status, mime_type}
```

#### 3. MageAgent Integration Metrics
```typescript
// Counter: MageAgent requests
fileprocess_mageagent_requests_total{operation, status}

// Histogram: MageAgent response time
fileprocess_mageagent_response_seconds{operation}

// Counter: OCR tier executions
fileprocess_ocr_tier_executions_total{tier, model, status}

// Histogram: OCR processing time per tier
fileprocess_ocr_tier_duration_seconds{tier, model}
```

#### 4. Queue Metrics
```typescript
// Gauge: Queue depth (BullMQ)
fileprocess_queue_depth{queue_name}

// Counter: Jobs processed
fileprocess_jobs_processed_total{queue_name, status}

// Histogram: Job processing time
fileprocess_job_duration_seconds{queue_name}

// Gauge: Active workers
fileprocess_active_workers{queue_name}
```

#### 5. Worker Metrics (Go)
```go
// Counter: Document processing
fileprocess_documents_processed_total{status, document_type}

// Histogram: Processing duration
fileprocess_processing_duration_seconds{stage, document_type}

// Counter: Tesseract OCR attempts
fileprocess_tesseract_ocr_total{status, language}

// Gauge: Goroutines count
fileprocess_goroutines_count

// Gauge: Memory usage
fileprocess_memory_bytes{type}
```

#### 6. Database Metrics
```typescript
// Counter: Database queries
fileprocess_db_queries_total{operation, table}

// Histogram: Query duration
fileprocess_db_query_duration_seconds{operation, table}

// Counter: Database errors
fileprocess_db_errors_total{operation, table, error_type}

// Gauge: Database connection pool size
fileprocess_db_connections{state}
```

#### 7. Circuit Breaker Metrics
```typescript
// Gauge: Circuit breaker state (0=closed, 1=half-open, 2=open)
fileprocess_circuit_state{service}

// Counter: Circuit breaker transitions
fileprocess_circuit_transitions_total{service, from_state, to_state}

// Counter: Circuit breaker failures
fileprocess_circuit_failures_total{service, reason}

// Histogram: Time in open state
fileprocess_circuit_open_duration_seconds{service}
```

### Implementation Files
- **API Metrics**: `api/src/middleware/PrometheusMetrics.ts`
- **Worker Metrics**: `worker/internal/metrics/prometheus.go`
- **Metrics Endpoint**: `GET /metrics` (both API and Worker)
- **Expected Coverage**: All critical paths instrumented

### Grafana Dashboard Configuration
```yaml
# Dashboards to create:
# 1. FileProcessAgent Overview
#    - Request rate, latency, error rate
#    - Pattern cache hit rate
#    - Queue depth and throughput
#    - Worker health and resource usage

# 2. Pattern Learning Performance
#    - Cache hit rate over time
#    - Speedup achieved (cached vs full MageAgent)
#    - Pattern accuracy (success rate)
#    - Most frequently cached patterns

# 3. OCR Pipeline Performance
#    - Tier 1/2/3 success rates
#    - Model usage distribution (GPT-4o vs Claude Opus)
#    - OCR latency per tier
#    - Fallback cascade effectiveness

# 4. System Health
#    - CPU, memory, goroutines
#    - Database connection pool health
#    - Redis connection status
#    - MageAgent integration health
```

---

## Phase 6: Chaos Testing

### Objective
Validate system resilience under adverse conditions through controlled chaos experiments.

### Chaos Scenarios

#### 1. Service Dependency Failures
```bash
#!/bin/bash
# chaos-test-dependencies.sh

# Scenario 1: MageAgent Unavailable
echo "=== Scenario 1: MageAgent Down ==="
kubectl scale deployment/nexus-mageagent --replicas=0 -n nexus
curl -X POST http://nexus-fileprocess:9099/api/fileprocess/process -F file=@test.pdf
# Expected: Pattern cache hit OR graceful error (no crash)
kubectl scale deployment/nexus-mageagent --replicas=2 -n nexus

# Scenario 2: Redis Unavailable
echo "=== Scenario 2: Redis Down ==="
kubectl scale deployment/nexus-redis --replicas=0 -n nexus
curl -X POST http://nexus-fileprocess:9099/api/fileprocess/process -F file=@test.pdf
# Expected: Queue operations fail gracefully, API returns error
kubectl scale deployment/nexus-redis --replicas=1 -n nexus

# Scenario 3: PostgreSQL Unavailable
echo "=== Scenario 3: PostgreSQL Down ==="
kubectl scale statefulset/nexus-postgres --replicas=0 -n nexus
curl -X POST http://nexus-fileprocess:9099/api/fileprocess/process -F file=@test.pdf
# Expected: Pattern cache fails, but processing continues via MageAgent
kubectl scale statefulset/nexus-postgres --replicas=1 -n nexus

# Scenario 4: GraphRAG Unavailable
echo "=== Scenario 4: GraphRAG Down ==="
kubectl scale deployment/nexus-graphrag --replicas=0 -n nexus
curl -X POST http://nexus-fileprocess:9099/api/fileprocess/process -F file=@test.pdf
# Expected: Pattern semantic search fails, fallback to MIME/extension search
kubectl scale deployment/nexus-graphrag --replicas=1 -n nexus
```

#### 2. Network Latency Injection
```bash
#!/bin/bash
# chaos-test-network-latency.sh

# Add 500ms latency to MageAgent pod
POD=$(kubectl get pods -n nexus -l app=nexus-mageagent -o jsonpath='{.items[0].metadata.name}')
kubectl exec -n nexus $POD -- tc qdisc add dev eth0 root netem delay 500ms

# Test OCR performance with latency
time curl -X POST http://nexus-fileprocess:9099/api/fileprocess/process -F file=@test.pdf

# Expected: Timeout handling works, circuit breaker may open

# Remove latency
kubectl exec -n nexus $POD -- tc qdisc del dev eth0 root
```

#### 3. Resource Exhaustion
```bash
#!/bin/bash
# chaos-test-resource-exhaustion.sh

# Scenario 1: Memory Pressure
# Reduce Worker memory limit to 512Mi (from 2Gi)
kubectl patch deployment nexus-fileprocess-worker -n nexus \
  -p '{"spec":{"template":{"spec":{"containers":[{"name":"worker","resources":{"limits":{"memory":"512Mi"}}}]}}}}'

# Upload large PDF (>100MB)
curl -X POST http://nexus-fileprocess:9099/api/fileprocess/process -F file=@large.pdf
# Expected: OOM handling, graceful failure, no pod crash

# Restore limits
kubectl patch deployment nexus-fileprocess-worker -n nexus \
  -p '{"spec":{"template":{"spec":{"containers":[{"name":"worker","resources":{"limits":{"memory":"2Gi"}}}]}}}}'

# Scenario 2: CPU Throttling
# Set CPU limit to 100m (from 1000m)
kubectl patch deployment nexus-fileprocess -n nexus \
  -p '{"spec":{"template":{"spec":{"containers":[{"name":"fileprocess","resources":{"limits":{"cpu":"100m"}}}]}}}}'

# Submit 10 concurrent requests
for i in {1..10}; do
  curl -X POST http://nexus-fileprocess:9099/api/fileprocess/process -F file=@test.pdf &
done
wait

# Expected: Requests queue, no timeouts, eventual completion

# Restore limits
kubectl patch deployment nexus-fileprocess -n nexus \
  -p '{"spec":{"template":{"spec":{"containers":[{"name":"fileprocess","resources":{"limits":{"cpu":"1000m"}}}]}}}}'
```

#### 4. Pod Restarts and Rollbacks
```bash
#!/bin/bash
# chaos-test-pod-lifecycle.sh

# Scenario 1: Random Pod Restarts
kubectl delete pod -n nexus -l app=nexus-fileprocess --field-selector=status.phase=Running --random
# Wait 5s, submit request
sleep 5
curl -X POST http://nexus-fileprocess:9099/api/fileprocess/process -F file=@test.pdf
# Expected: Request succeeds (routed to healthy pod)

# Scenario 2: Rolling Restart (zero downtime)
kubectl rollout restart deployment/nexus-fileprocess -n nexus
# Submit continuous requests during rollout
while kubectl rollout status deployment/nexus-fileprocess -n nexus | grep -q "Waiting"; do
  curl -X POST http://nexus-fileprocess:9099/api/fileprocess/process -F file=@test.pdf || echo "FAILED"
  sleep 2
done
# Expected: 0 failures during rollout

# Scenario 3: Deployment Rollback
PREV_REVISION=$(kubectl rollout history deployment/nexus-fileprocess -n nexus | tail -2 | head -1 | awk '{print $1}')
kubectl rollout undo deployment/nexus-fileprocess -n nexus --to-revision=$PREV_REVISION
kubectl rollout status deployment/nexus-fileprocess -n nexus
# Expected: Successful rollback, no data loss
```

#### 5. Data Corruption Simulation
```typescript
// Test: Corrupted File Uploads
describe('Chaos Testing - Data Corruption', () => {
  it('should handle corrupted PDF files gracefully', async () => {
    const corruptedPdf = Buffer.from('NOT_A_VALID_PDF');
    // Upload corrupted file
    // Expected: Validation error, no crash, error logged
  });

  it('should handle incomplete multipart uploads', async () => {
    // Simulate network interruption during upload
    // Expected: Request times out or validation fails
  });

  it('should handle malformed JSON in pattern cache', async () => {
    // Insert invalid JSON into processing_patterns table
    // Expected: Cache read fails, fallback to MageAgent
  });
});
```

### Chaos Testing Success Criteria
- ✅ **No Pod Crashes**: Services must never crash from dependency failures
- ✅ **Graceful Degradation**: Reduced functionality acceptable, total failure is not
- ✅ **Circuit Breaker Activation**: Circuit breakers must open on persistent failures
- ✅ **Error Logging**: All failures must be logged with context
- ✅ **Recovery**: Services must auto-recover when dependencies restore
- ✅ **Data Integrity**: No data loss or corruption under any scenario

---

## Phase 7: Comprehensive Test Suite

### Objective
Develop 50+ unit tests and 20+ integration tests covering all critical paths.

### Test Organization

#### Unit Tests (50+ tests)

**1. PatternRepository Tests** (`__tests__/repositories/PatternRepository.test.ts`)
- findPattern() - 4-layer search logic (10 tests)
- storePattern() - Storage with GraphRAG integration (8 tests)
- recordExecution() - Success/failure tracking (5 tests)
- Pattern cache LRU behavior (5 tests)
- Error handling for each layer (5 tests)

**2. Route Handler Tests** (`__tests__/routes/process.routes.test.ts`)
- Pattern cache hit path (3 tests)
- Pattern cache miss path (3 tests)
- Validation failure handling (5 tests)
- Archive extraction flow (5 tests)
- Error propagation (4 tests)

**3. Validator Tests** (`__tests__/validators/*.test.ts`)
- FileValidator - MIME detection (5 tests)
- ArchiveValidator - 7 format detection (7 tests)
- OfficeDocumentValidator - Modern & legacy Office (6 tests)

**4. Extractor Tests** (`__tests__/extractors/ArchiveExtractor.test.ts`)
- ZIP extraction (5 tests)
- TAR/TAR.GZ extraction (5 tests)
- RAR extraction (3 tests)
- 7Z extraction (3 tests)
- Recursive extraction (5 tests)

**5. Client Tests** (`__tests__/clients/*.test.ts`)
- SandboxClient - circuit breaker (10 tests, from Phase 4)
- Database client - connection pooling (5 tests)
- Redis client - queue operations (5 tests)

**6. Middleware Tests** (`__tests__/middleware/*.test.ts`)
- Error handler middleware (5 tests)
- Validation middleware (3 tests)
- Prometheus metrics middleware (5 tests)

#### Integration Tests (20+ tests)

**1. End-to-End Processing** (`__tests__/integration/e2e-processing.test.ts`)
- Upload PDF → Extract text → Store artifacts (5 tests)
- Upload archive → Extract files → Process recursively (3 tests)
- Upload unknown format → Pattern learning → Cache hit on retry (3 tests)

**2. Pattern Learning Workflow** (`__tests__/integration/pattern-learning.test.ts`)
- First upload (cache miss) → MageAgent → Pattern stored (1 test)
- Second upload (cache hit) → Cached pattern → 6x speedup (1 test)
- Pattern failure → Fallback to MageAgent (1 test)
- GraphRAG semantic search → Pattern discovery (2 tests)

**3. OCR Pipeline** (`__tests__/integration/ocr-pipeline.test.ts`)
- Tesseract Tier 1 (if fixed) (1 test)
- GPT-4o Tier 2 (2 tests)
- Claude Opus Tier 3 fallback (2 tests)
- All tiers fail → Graceful error (1 test)

**4. Queue Integration** (`__tests__/integration/queue-processing.test.ts`)
- Job enqueue → Worker pickup → Processing → Completion (2 tests)
- Job failure → Retry logic → Dead letter queue (2 tests)
- High load → Queue backlog → Eventual processing (1 test)

**5. Database Transactions** (`__tests__/integration/database-transactions.test.ts`)
- Pattern storage with transaction rollback (2 tests)
- Concurrent pattern updates (2 tests)
- Database connection pool exhaustion (1 test)

### Test Infrastructure

**Setup**:
```typescript
// jest.config.js
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/src'],
  testMatch: ['**/__tests__/**/*.test.ts'],
  collectCoverageFrom: [
    'src/**/*.ts',
    '!src/**/*.d.ts',
    '!src/__tests__/**',
  ],
  coverageThreshold: {
    global: {
      branches: 90,
      functions: 90,
      lines: 90,
      statements: 90,
    },
  },
  setupFilesAfterEnv: ['<rootDir>/src/__tests__/setup.ts'],
};
```

**Test Helpers**:
```typescript
// __tests__/setup.ts
beforeAll(async () => {
  // Setup test database
  // Setup test Redis
  // Setup mock MageAgent
});

afterAll(async () => {
  // Cleanup resources
});

beforeEach(async () => {
  // Clear test data
});

// __tests__/helpers/factories.ts
export function createMockPattern(): ProcessingPattern { ... }
export function createMockFile(): Express.Multer.File { ... }
export function createMockMageAgentResponse(): any { ... }
```

---

## Phase 8: Coverage Target (>90%)

### Objective
Achieve and maintain >90% code coverage across all services.

### Coverage Tracking

**Current Baseline** (from previous conversation):
```
Overall Coverage: 12.6%
- Statements: 12.6%
- Branches: 0%
- Functions: 11.1%
- Lines: 12.9%
```

**Target**:
```
Overall Coverage: >90%
- Statements: >90%
- Branches: >85%
- Functions: >90%
- Lines: >90%
```

### Coverage By Module

**High Priority (95%+ coverage)**:
- Pattern learning logic (`PatternRepository.ts`, `process.routes.ts`)
- Circuit breaker (`SandboxClient.ts`)
- Validation logic (`validators/*.ts`)
- Archive extraction (`extractors/*.ts`)

**Medium Priority (90%+ coverage)**:
- Database clients
- Queue producers
- Middleware
- Error handlers

**Low Priority (80%+ coverage)**:
- Server initialization
- Configuration loading
- Health check endpoints

### Coverage Monitoring

**Pre-Commit Hook**:
```bash
#!/bin/bash
# .git/hooks/pre-commit

echo "Running tests and checking coverage..."
npm run test:coverage

COVERAGE=$(npm run test:coverage -- --silent | grep "All files" | awk '{print $10}' | sed 's/%//')

if (( $(echo "$COVERAGE < 90" | bc -l) )); then
  echo "❌ Coverage is below 90% ($COVERAGE%)"
  echo "Please add tests before committing."
  exit 1
fi

echo "✅ Coverage check passed ($COVERAGE%)"
```

**CI/CD Integration**:
```yaml
# .github/workflows/test.yml
name: Test and Coverage

on: [push, pull_request]

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      - uses: actions/setup-node@v3
        with:
          node-version: '20'
      - run: npm ci
      - run: npm run test:coverage
      - name: Upload coverage to Codecov
        uses: codecov/codecov-action@v3
        with:
          fail_ci_if_error: true
          threshold: 90%
```

---

## Implementation Timeline

### Week 1: Phase 4-5
- **Days 1-2**: Circuit breaker tests (10 tests)
- **Days 3-4**: Prometheus metrics implementation
- **Day 5**: Grafana dashboard configuration

### Week 2: Phase 6-7
- **Days 1-2**: Chaos testing scripts (5 scenarios)
- **Days 3-5**: Unit test development (50+ tests)

### Week 3: Phase 7-8
- **Days 1-3**: Integration test development (20+ tests)
- **Days 4-5**: Coverage improvements to reach >90%

### Week 4: Verification and Documentation
- **Days 1-2**: Full chaos testing run
- **Days 3-4**: Performance benchmarking with metrics
- **Day 5**: Final documentation and handoff

---

## Success Metrics

### Phase 4 Complete
- ✅ Circuit breaker opens after 3 failures
- ✅ Half-open state tested after 30s cooldown
- ✅ Circuit closes on successful recovery
- ✅ All circuit breaker tests passing (10/10)

### Phase 5 Complete
- ✅ Prometheus endpoint `/metrics` accessible
- ✅ 40+ metrics instrumented
- ✅ Grafana dashboards deployed (4 dashboards)
- ✅ Metrics visible in Grafana UI

### Phase 6 Complete
- ✅ 5 chaos scenarios pass without pod crashes
- ✅ Graceful degradation verified in all scenarios
- ✅ Circuit breakers activate appropriately
- ✅ Recovery verified for all scenarios

### Phase 7 Complete
- ✅ 50+ unit tests implemented and passing
- ✅ 20+ integration tests implemented and passing
- ✅ No flaky tests (100% consistent pass rate)
- ✅ Test execution time <60s

### Phase 8 Complete
- ✅ Overall coverage >90%
- ✅ Coverage tracking in CI/CD
- ✅ Pre-commit hooks enforcing coverage
- ✅ No coverage regressions

---

## Risk Mitigation

### Risk 1: Tesseract Tier 1 Still Broken
**Mitigation**: Focus tests on Tier 2/3 (MageAgent OCR), Tesseract is optional

### Risk 2: Pattern Learning Not Achieving 6x Speedup
**Mitigation**: Profile pattern execution, optimize MageAgent task execution, adjust caching strategy

### Risk 3: Circuit Breaker Threshold Too Aggressive
**Mitigation**: Make thresholds configurable via environment variables, tune based on production data

### Risk 4: Chaos Testing Causes Production Issues
**Mitigation**: Run chaos tests ONLY in staging environment, never in production namespace

### Risk 5: Coverage Target Too Ambitious (>90%)
**Mitigation**: Start with 80% target, incrementally increase, focus on critical paths first

---

## Production Readiness Checklist

After completing Phases 4-8:

- [ ] All 70+ tests passing consistently
- [ ] Coverage >90% achieved and enforced
- [ ] Prometheus metrics exposed and verified
- [ ] Grafana dashboards deployed and monitored
- [ ] Chaos tests pass in staging environment
- [ ] Circuit breaker behavior validated
- [ ] Zero pod crashes during chaos testing
- [ ] Pattern learning 6x speedup verified
- [ ] OCR pipeline Tier 2/3 success rate >95%
- [ ] Documentation updated (README, runbooks)
- [ ] Deployment runbooks created
- [ ] Rollback procedures tested
- [ ] Load testing completed (1000 req/min sustained)
- [ ] Security audit passed
- [ ] Performance benchmarks documented

---

**Report Generated**: 2025-11-27
**Phase**: Approach C - Phase 4-8 Strategy
**Status**: STRATEGY DEFINED, IMPLEMENTATION READY
**Next Action**: Begin Phase 4 (Circuit Breaker Testing)
**Estimated Completion**: 3-4 weeks
**Engineer**: Claude Code (AI Assistant)
