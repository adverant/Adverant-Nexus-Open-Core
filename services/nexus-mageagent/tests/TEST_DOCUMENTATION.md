# MageAgent Comprehensive Test Suite Documentation

## Overview

This document describes the comprehensive functional test suite for the MageAgent service. All tests use **REAL APIs and services** with **ZERO mock data** to ensure production-grade quality and reliability.

## Test Architecture

### Core Testing Principles

1. **NO MOCK DATA** - Every test interacts with real services
2. **Real API Calls** - All OpenRouter, GraphRAG, and database calls are real
3. **Production-Like Environment** - Tests run against actual infrastructure
4. **Comprehensive Coverage** - Tests cover all layers from API to database
5. **Forensic Error Reporting** - Detailed error context for debugging

### Test Categories

#### 1. Unit Tests
- **OpenRouterClient** (`tests/unit/clients/openrouter-client.test.ts`)
  - Real API authentication and model listing
  - Completion generation with various models
  - Streaming responses
  - Cost estimation
  - Circuit breaker pattern
  - Rate limiting and retry logic

- **GraphRAGClient** (`tests/unit/clients/graphrag-client.test.ts`)
  - Memory storage and retrieval
  - Document management
  - Pattern recognition
  - Health checks
  - Retry and timeout handling

- **DatabaseManager** (`tests/unit/database/database-manager.test.ts`)
  - PostgreSQL connection pooling
  - Redis operations and pub/sub
  - Neo4j graph operations
  - Qdrant vector operations
  - Cross-database consistency

#### 2. Integration Tests
- **Orchestrator** (`tests/integration/orchestration/orchestrator.test.ts`)
  - Multi-agent orchestration
  - Agent competition with real models
  - Collaborative workflows
  - Model selection strategies
  - Event handling

- **WebSocket Streaming** (`tests/integration/websocket/websocket-streaming.test.ts`)
  - Real-time agent streaming
  - Multi-client subscriptions
  - Broadcast messaging
  - Connection management
  - Performance under load

#### 3. End-to-End Tests
- **Complete Workflows** (`tests/e2e/complete-workflow.test.ts`)
  - Full API to database flows
  - WebSocket integration
  - Multi-service coordination
  - Error recovery
  - Performance monitoring

#### 4. Chaos Engineering Tests
- **System Resilience** (`tests/chaos/resilience.test.ts`)
  - Network failure scenarios
  - Database connection issues
  - Service outages
  - Cascading failures
  - Recovery mechanisms
  - Resource exhaustion

#### 5. Performance Tests
- **Load Testing** (`tests/performance/load-testing.test.ts`)
  - Throughput measurement
  - Latency distribution
  - Resource utilization
  - Scalability testing
  - Concurrent request handling
  - Memory leak detection

#### 6. Security Tests
- **Penetration Testing** (`tests/security/penetration.test.ts`)
  - SQL injection prevention
  - XSS protection
  - Authentication/authorization
  - Rate limiting
  - Data encryption
  - OWASP Top 10 compliance

## Running Tests

### Prerequisites

```bash
# Required environment variables
export OPENROUTER_API_KEY="your-real-api-key"
export POSTGRES_USER="vibe_user"
export POSTGRES_PASSWORD="your-password"
export POSTGRES_DATABASE="vibe_platform"
export REDIS_PASSWORD="your-redis-password"
export NEO4J_PASSWORD="your-neo4j-password"
export QDRANT_API_KEY="your-qdrant-key"
```

### Running Individual Test Suites

```bash
# Unit tests
npm run test:unit

# Integration tests
npm run test:integration

# E2E tests
npm run test:e2e

# Chaos engineering tests
npm run test:chaos

# Performance tests
npm run test:performance

# Security tests
npm run test:security

# Run all tests with comprehensive reporting
npm run test:all
```

### Test Configuration

Tests are configured in:
- `jest.config.js` - Main Jest configuration
- `tests/setup.ts` - Global test setup and custom matchers
- `.env.test` - Test environment variables

## Custom Test Matchers

The test suite includes custom Jest matchers:

- `toBeValidResponse()` - Validates API response structure
- `toHaveRealData()` - Ensures no mock/fake data
- `toCompleteWithinTime(ms)` - Performance assertions

## Test Reports

Running `npm run test:all` generates:

1. **Test Summary** (`test-results-*/test-summary.md`)
   - Overall pass/fail status
   - Performance metrics
   - Security findings
   - Recommendations

2. **HTML Report** (`test-results-*/test-report.html`)
   - Visual test results
   - Interactive navigation
   - Detailed findings

3. **Coverage Report** (`test-results-*/coverage/index.html`)
   - Code coverage metrics
   - Uncovered lines
   - Branch coverage

4. **Individual Test Outputs** (`test-results-*/*-output.txt`)
   - Detailed test execution logs
   - Performance measurements
   - Error stack traces

## Key Test Scenarios

### 1. Multi-Model Competition
Tests real competition between different AI models:
```typescript
const competition = await orchestrator.runCompetition({
  challenge: 'Design a caching strategy',
  competitorCount: 4,
  models: ['openai/gpt-4', 'anthropic/claude-3', 'google/gemini-pro']
});
```

### 2. Real-time Streaming
Tests WebSocket streaming with actual data:
```typescript
wsClient.on('agent_stream', (data) => {
  // Receives real agent output chunks
});
```

### 3. Database Resilience
Tests system behavior during database failures:
```typescript
// Simulates Redis disconnect during operation
// Verifies PostgreSQL maintains consistency
```

### 4. Security Validation
Tests against real attack vectors:
```typescript
// SQL injection attempts
// XSS payloads
// Authentication bypasses
```

## Performance Baselines

Expected performance metrics (with real APIs):

- **Analysis Task**: < 60s average
- **Competition (3 agents)**: < 120s average
- **WebSocket Latency**: < 100ms
- **Database Operations**: < 50ms
- **API Response Time**: P95 < 2s

## Production Readiness Checklist

✅ All tests pass with real services
✅ No mock data or stubs used
✅ GraphRAG integration validated
✅ Database connections tested
✅ WebSocket streaming verified
✅ Security vulnerabilities checked
✅ Performance baselines established
✅ Chaos scenarios tested
✅ Code coverage > 80%

## Troubleshooting

### Common Issues

1. **GraphRAG Not Available**
   - Tests gracefully handle GraphRAG unavailability
   - System operates in degraded mode
   - Memory patterns won't be stored/retrieved

2. **Rate Limiting**
   - OpenRouter may rate limit during extensive testing
   - Tests include retry logic
   - Consider spacing test runs

3. **Database Connection Limits**
   - Ensure PostgreSQL max_connections is sufficient
   - Redis memory limits should accommodate test data
   - Neo4j heap size should be adequate

### Debug Mode

Enable debug output:
```bash
DEBUG=true npm test
```

## Continuous Integration

The test suite is designed for CI/CD integration:

```yaml
# Example GitHub Actions workflow
- name: Run MageAgent Tests
  env:
    OPENROUTER_API_KEY: ${{ secrets.OPENROUTER_API_KEY }}
    # ... other secrets
  run: |
    npm install
    npm run test:all
```

## Contributing

When adding new tests:

1. **Always use real APIs** - No mocks allowed
2. **Handle failures gracefully** - Tests shouldn't break the system
3. **Clean up resources** - Remove test data after execution
4. **Document test scenarios** - Explain what's being tested
5. **Measure performance** - Include timing measurements

## Summary

This comprehensive test suite ensures MageAgent is production-ready by testing against real services, real data, and real-world scenarios. The zero-mock-data approach provides confidence that the system will perform correctly in production environments.