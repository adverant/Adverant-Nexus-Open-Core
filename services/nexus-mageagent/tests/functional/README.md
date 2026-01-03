# MageAgent Functional Tests

This directory contains comprehensive functional tests for the MageAgent service deployed on Kubernetes at https://graphrag.adverant.ai/mageagent.

## Overview

These tests perform **REAL API calls** against the **LIVE deployment** - no mocks, no stubs, only real service interactions.

## Test Coverage

### 1. API Endpoint Tests
- Health check endpoint
- Orchestration endpoints (task creation, status checking)
- Competition endpoints (agent competitions)
- Memory search endpoints (GraphRAG integration)
- Agent management endpoints
- Pattern storage and retrieval
- Model validation
- WebSocket statistics

### 2. WebSocket Tests
- Connection establishment
- Bidirectional communication
- Event streaming
- Reconnection behavior
- Error handling

### 3. Performance Tests
- Response time measurements
- Concurrent request handling
- P95/P99 latency metrics
- Throughput testing

### 4. Security Tests
- CORS configuration
- Security headers validation
- Input validation testing
- SQL injection protection
- XSS protection
- Authentication bypass attempts
- Rate limiting enforcement

### 5. Error Handling Tests
- Invalid requests
- Malformed JSON
- Large payloads
- 404 handling
- Method not allowed

## Running the Tests

### Quick Start
```bash
# Install dependencies first
npm install

# Run all functional tests
npm run test:functional

# Run tests directly (without wrapper)
npm run test:functional:direct

# Run with Jest integration
npm run test:functional:jest
```

### Options
```bash
# Skip security tests
npm run test:functional -- --skip-security

# Skip performance tests
npm run test:functional -- --skip-performance

# Test against staging environment
npm run test:functional -- --env=staging

# Show help
npm run test:functional -- --help
```

## Test Output

The tests generate:

1. **Console Output**: Real-time test progress and results
2. **JSON Report**: Detailed test results saved to `test-results/functional-test-report-{timestamp}.json`
3. **HTML Report**: Visual test report (when using Jest runner)
4. **JUnit XML**: CI/CD compatible test results

## Test Results Interpretation

### Success Criteria
- ✅ All endpoints respond with expected status codes
- ✅ Response times within acceptable limits (P95 < 2s, P99 < 5s)
- ✅ WebSocket connections establish and maintain
- ✅ Security tests pass without vulnerabilities
- ✅ Rate limiting properly enforced

### Common Issues
- ❌ **503 Service Unavailable**: Service may be starting up or unhealthy
- ❌ **429 Too Many Requests**: Rate limiting is working (this is good!)
- ❌ **Network Errors**: Check internet connectivity and VPN settings
- ❌ **WebSocket Failures**: Check if WSS protocol is allowed

## Environment Variables

Create a `.env.test` file for custom configuration:

```env
# Custom endpoints (optional)
TEST_BASE_URL=https://graphrag.adverant.ai/mageagent
TEST_WS_URL=wss://graphrag.adverant.ai/mageagent/ws

# Test behavior
TEST_VERBOSE=true
SKIP_DESTRUCTIVE_TESTS=true

# Environment
TEST_ENV=production
```

## Debugging

### Enable Verbose Output
```bash
TEST_VERBOSE=true npm run test:functional
```

### Test Specific Endpoint
Modify `mageagent-api.test.ts` to comment out unwanted tests.

### Network Debugging
Use tools like `curl` or `httpie` to test individual endpoints:
```bash
curl -X GET https://graphrag.adverant.ai/mageagent/health
```

## Contributing

When adding new tests:

1. Follow the existing pattern in `mageagent-api.test.ts`
2. Always test against REAL endpoints
3. Include both positive and negative test cases
4. Add appropriate error handling
5. Update this README with new test coverage

## CI/CD Integration

These tests can be integrated into CI/CD pipelines:

```yaml
# Example GitHub Actions
- name: Run Functional Tests
  run: |
    npm install
    npm run test:functional:jest
  env:
    TEST_ENV: production
```

## Performance Benchmarks

Current performance targets:
- Health check: < 500ms average
- API endpoints: < 2s P95, < 5s P99
- WebSocket connection: < 1s
- Memory search: < 3s for complex queries

## Security Considerations

These tests perform security validation but:
- Do NOT attempt actual exploits
- Do NOT store sensitive data
- Do NOT overwhelm the service
- Follow responsible disclosure for any vulnerabilities found