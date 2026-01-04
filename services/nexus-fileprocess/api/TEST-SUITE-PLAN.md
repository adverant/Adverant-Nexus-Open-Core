# FileProcessAgent Comprehensive Test Suite Plan

**Phase 7-8 Deliverable**: 50+ tests with >90% code coverage

## Test Organization

### Test Categories

#### 1. Unit Tests (`src/__tests__/unit/`)
**Purpose**: Test individual functions and classes in isolation
**Target Coverage**: >95% of utility functions, validators, helpers
**Mock Strategy**: Mock all external dependencies (Redis, PostgreSQL, S3, HTTP clients)

Files to test:
- `utils/metrics.ts` - All 42 metric helper functions
- `validators/*.ts` - All validator classes (File, Archive, Office)
- `extractors/*.ts` - All extractor implementations
- `clients/SandboxClient.ts` - Circuit breaker, validation, execution (already has 19 tests)
- `repositories/PatternRepository.ts` - Pattern CRUD, cache operations
- `middleware/*.ts` - Error handling, validation, tenant context

#### 2. Integration Tests (`src/__tests__/integration/`)
**Purpose**: Test interactions between components
**Target Coverage**: >85% of service layer and route handlers
**Mock Strategy**: Use real Redis/PostgreSQL (test databases), mock external HTTP calls

Files to test:
- `routes/process.routes.ts` - All endpoints with real validators
- `services/*.ts` - Service layer with real database connections
- Database migrations - Schema validation
- Queue operations - Job creation, processing, completion

#### 3. End-to-End Tests (`src/__tests__/e2e/`)
**Purpose**: Test complete workflows from API to job completion
**Target Coverage**: All critical user journeys
**Mock Strategy**: Minimal - use test infrastructure with real components

Workflows to test:
- PDF upload → validation → job creation → worker processing → result storage
- Archive upload → extraction → recursive processing → artifact creation
- Pattern learning → cache hit → performance improvement
- Circuit breaker → failure → recovery
- Concurrent uploads → queue management → rate limiting

### Test Utilities Structure

#### `src/__tests__/utils/testHelpers.ts`
- `createMockRequest()` - Express request mocks
- `createMockResponse()` - Express response mocks
- `createMockFile()` - Multer file mocks
- `waitForCondition()` - Async polling utility
- `cleanupTestData()` - Database cleanup

#### `src/__tests__/utils/mockFactories.ts`
- `createMockSandboxClient()` - Mocked sandbox client
- `createMockRedisClient()` - Mocked Redis operations
- `createMockPostgresPool()` - Mocked PostgreSQL pool
- `createMockMinioClient()` - Mocked S3 client
- `createMockBullMQJob()` - Mocked BullMQ job

#### `src/__tests__/utils/fixtures.ts`
- `samplePDF` - Base64 encoded test PDF
- `samplePNG` - Base64 encoded test image
- `sampleZIP` - Base64 encoded test archive
- `corruptedFile` - Invalid file data
- `oversizedFile` - File exceeding limits
- `validJobData` - Sample job payloads

## Test Coverage Targets

| Module | Target Coverage | Priority | Est. Tests |
|--------|----------------|----------|-----------|
| `utils/metrics.ts` | 100% | High | 13 |
| `validators/*.ts` | 95% | High | 15 |
| `extractors/*.ts` | 90% | High | 10 |
| `clients/SandboxClient.ts` | 95% | High | 19 (exists) |
| `repositories/PatternRepository.ts` | 90% | High | 12 |
| `routes/process.routes.ts` | 90% | High | 8 |
| `middleware/*.ts` | 95% | Medium | 6 |
| `services/*.ts` | 85% | Medium | 8 |
| **TOTAL** | **>90%** | - | **91 tests** |

## Test Execution Plan

### Phase 1: Test Infrastructure (Current Phase)
- [x] Create test suite plan
- [ ] Create test utilities (`testHelpers.ts`)
- [ ] Create mock factories (`mockFactories.ts`)
- [ ] Create test fixtures (`fixtures.ts`)
- [ ] Update jest configuration if needed

### Phase 2: Unit Tests - Critical Utilities
Priority order:
1. `utils/metrics.test.ts` - Test all 13 metric categories (13 tests)
2. `validators/FileValidator.test.ts` - Test MIME detection, magic bytes (5 tests)
3. `validators/ArchiveValidator.test.ts` - Test 7 archive formats (already exists)
4. `validators/OfficeDocumentValidator.test.ts` - Test modern & legacy Office (5 tests)

### Phase 3: Unit Tests - Business Logic
5. `extractors/ArchiveExtractor.test.ts` - Test ZIP, TAR, RAR, 7Z (already exists)
6. `repositories/PatternRepository.test.ts` - Test cache, DB, GraphRAG fallback (12 tests)
7. `clients/SandboxClient.test.ts` - Additional edge cases (5 tests beyond existing 19)

### Phase 4: Integration Tests
8. `routes/process.routes.test.ts` - Test all endpoints (8 tests)
9. `services/jobService.test.ts` - Test job lifecycle (6 tests)
10. `database/migrations.test.ts` - Test schema integrity (2 tests)

### Phase 5: End-to-End Tests
11. `e2e/documentProcessing.test.ts` - Test complete PDF workflow (3 tests)
12. `e2e/archiveProcessing.test.ts` - Test archive extraction workflow (3 tests)
13. `e2e/patternLearning.test.ts` - Test pattern caching (2 tests)
14. `e2e/circuitBreaker.test.ts` - Test failure recovery (2 tests)

### Phase 6: Coverage Analysis & Gap Filling
15. Run `npm run test:coverage`
16. Identify uncovered branches
17. Write additional tests for uncovered code
18. Target: >90% coverage achieved

## Test Execution Commands

```bash
# Run all tests
npm test

# Run specific test category
npm test -- unit
npm test -- integration
npm test -- e2e

# Run specific test file
npm test -- metrics.test.ts

# Run with coverage
npm run test:coverage

# Watch mode for development
npm test -- --watch

# Run chaos tests (separate script)
./chaos-test.sh all
```

## CI/CD Integration

### Pre-commit Hooks
- Run `npm run typecheck`
- Run `npm run lint`
- Run unit tests only (fast feedback)

### CI Pipeline
- Run all test suites
- Generate coverage report
- Fail if coverage < 90%
- Upload coverage to reporting tool

### Pre-deployment
- Run chaos tests
- Verify metrics endpoints
- Smoke test critical workflows

## Success Criteria

✅ **Phase 7-8 Complete When**:
1. Total test count ≥ 50 tests
2. Overall code coverage ≥ 90%
3. All critical paths covered
4. All tests passing consistently
5. No flaky tests (run 10 times, 10 passes)
6. Test suite runs in < 30 seconds (unit tests)
7. Integration tests run in < 2 minutes
8. Chaos tests validate production readiness
