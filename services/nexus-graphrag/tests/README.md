# GraphRAG Comprehensive Test Suite

## Overview

This test suite provides comprehensive coverage of all GraphRAG system components, including unit tests, integration tests, end-to-end tests, performance tests, and security tests.

## Test Structure

```
tests/
├── unit/                     # Unit tests for individual components
│   ├── storage/             # Storage engine tests
│   ├── retrieval/           # Retrieval engine tests
│   └── services/            # Service layer tests
├── integration/             # Integration tests
│   ├── api/                 # API endpoint tests
│   ├── websocket/           # WebSocket tests
│   ├── vector-search.test.ts # Vector search tests
│   └── graph-operations.test.ts # Neo4j graph tests
├── e2e/                     # End-to-end workflow tests
├── performance/             # Performance and load tests
├── security/                # Security and vulnerability tests
├── helpers/                 # Test utilities and helpers
├── test-config.ts           # Test configuration
├── setup.ts                 # Test setup file
├── run-all-tests.ts         # Comprehensive test runner
└── README.md                # This file
```

## Running Tests

### All Tests
```bash
npm run test:all
```

### Specific Test Categories

#### Unit Tests
```bash
npm run test:unit
```

#### Integration Tests
```bash
npm run test:integration
```

#### End-to-End Tests
```bash
npm run test:e2e
```

#### Performance Tests
```bash
npm run test:performance
```

#### Security Tests
```bash
npm run test:security
```

### Coverage Report
```bash
npm run test:coverage
```

### Watch Mode (for development)
```bash
npm run test:watch
```

### CI/CD Pipeline
```bash
npm run test:ci
```

## Test Coverage Areas

### 1. API Endpoints (18 core issues addressed)
- ✅ Health check endpoints (/health and /api/health)
- ✅ Document upload with text/plain content type
- ✅ Document listing with pagination
- ✅ Tag filtering for documents
- ✅ Batch document upload
- ✅ Document chunking and retrieval
- ✅ Custom chunking strategies
- ✅ Vector search with Qdrant
- ✅ Metadata filtering in search
- ✅ Graph operations with Neo4j
- ✅ Memory storage and retrieval
- ✅ WebSocket connections on port 8091
- ✅ Real-time document processing streams
- ✅ Large document handling
- ✅ Authentication with API keys
- ✅ Proper error responses (401/403)

### 2. Storage Engine
- Document storage and retrieval
- Duplicate detection
- Content type handling
- Metadata management
- Version control
- Batch operations
- Transaction management
- Data consistency

### 3. Vector Search
- Embedding generation with VoyageAI
- Qdrant collection management
- Similarity search
- Metadata filtering
- Hybrid search
- Re-ranking
- Batch vector operations

### 4. Graph Operations
- Neo4j connectivity
- Entity extraction
- Graph building
- Cypher query execution
- Graph traversal
- Relationship management
- Graph analytics
- Transaction handling

### 5. WebSocket Real-time
- Connection management
- Message exchange
- Document processing streams
- Memory update streams
- Broadcasting
- Error handling
- Reconnection logic

### 6. Performance
- Document upload performance
- Concurrent operations
- Search performance
- Pagination efficiency
- Chunking performance
- Memory management
- Database performance
- Caching effectiveness
- Scalability testing

### 7. Security
- Authentication and authorization
- Input validation and sanitization
- SQL injection prevention
- NoSQL injection prevention
- XSS protection
- CSRF protection
- Path traversal prevention
- Rate limiting
- Information disclosure prevention
- Command injection prevention
- XXE prevention
- Cryptographic security

## Environment Variables

Create a `.env.test` file with the following variables:

```bash
# API Configuration
TEST_API_URL=http://localhost:8090
REQUIRE_API_KEY=false
GRAPHRAG_API_KEY=test-api-key

# Database Configuration
TEST_PG_HOST=localhost
TEST_PG_PORT=5432
TEST_PG_DATABASE=graphrag_test
TEST_PG_USER=postgres
TEST_PG_PASSWORD=postgres

# Redis Configuration
TEST_REDIS_HOST=localhost
TEST_REDIS_PORT=6379

# Neo4j Configuration
TEST_NEO4J_URI=bolt://localhost:7687
TEST_NEO4J_USER=neo4j
TEST_NEO4J_PASSWORD=neo4j

# Qdrant Configuration
TEST_QDRANT_URL=http://localhost:6333
TEST_QDRANT_API_KEY=

# WebSocket Configuration
TEST_WS_URL=ws://localhost:8091/ws

# VoyageAI Configuration (optional)
VOYAGE_AI_API_KEY=

# Test Settings
TEST_VERBOSE=true
TEST_CLEANUP=true
TEST_SEED=false
TEST_PARALLEL=true
SILENT_TESTS=false
```

## Prerequisites

1. **Services Running**: Ensure all GraphRAG services are running:
   ```bash
   npm run dev
   ```

2. **Database Setup**: Ensure test databases are initialized:
   ```bash
   npm run migrate
   ```

3. **Docker Services**: If using Docker, ensure containers are running:
   ```bash
   docker-compose up -d postgres redis neo4j qdrant
   ```

## Test Helpers

### TestDataGenerator
Generates realistic test data for documents, memories, and queries.

### TestAPIClient
Provides a configured axios client for API testing.

### DatabaseTestUtils
Utilities for database operations, cleanup, and consistency checks.

### PerformanceTestUtils
Tools for measuring performance, generating load, and monitoring resources.

### AssertionHelpers
Custom assertions for API responses, pagination, errors, and WebSocket messages.

## Coverage Thresholds

The test suite enforces the following coverage thresholds:
- Branches: 70%
- Functions: 75%
- Lines: 80%
- Statements: 80%

## Continuous Integration

For CI/CD pipelines, use:
```bash
npm run test:ci
```

This runs tests with:
- Coverage reporting
- CI-optimized output
- Limited parallelization
- Automatic cleanup

## Troubleshooting

### Services Not Available
If tests fail due to service unavailability:
1. Check if all services are running
2. Verify connection strings in `.env.test`
3. Check service health: `curl http://localhost:8090/health`

### Database Issues
If database tests fail:
1. Run migrations: `npm run migrate`
2. Clean test data: `npm run migrate:reset`
3. Check database permissions

### WebSocket Connection Issues
If WebSocket tests fail:
1. Verify port 8091 is available
2. Check WebSocket server logs
3. Ensure no firewall blocking

### Performance Test Timeouts
For performance tests:
1. Increase timeout: `--testTimeout=300000`
2. Reduce load parameters
3. Check system resources

## Contributing

When adding new tests:
1. Follow the existing structure
2. Use appropriate test helpers
3. Add cleanup in `afterEach`
4. Document test purpose
5. Update this README

## Test Results

The test runner provides detailed results including:
- Pass/fail counts per suite
- Execution time
- Coverage percentages
- Failed test details
- Performance metrics

Example output:
```
🚀 GraphRAG Comprehensive Test Suite

✅ Storage Engine: 25 passed
✅ API Endpoints: 42 passed
✅ Vector Search: 18 passed
✅ Graph Operations: 20 passed
✅ WebSocket: 15 passed
✅ Performance: 12 passed
✅ Security: 30 passed

📊 Test Results Summary

Total Tests: 162
Pass Rate: 100%
Total Duration: 45.3 seconds

✅ All tests passed!
```