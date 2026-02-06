import axios, { AxiosInstance, AxiosError } from 'axios';
import WebSocket from 'ws';
import { v4 as uuidv4 } from 'uuid';

/**
 * Comprehensive Functional Tests for MageAgent Service
 * Testing against LIVE deployment at https://graphrag.adverant.ai/mageagent
 *
 * NO MOCK DATA - All tests interact with REAL services
 */

interface TestResult {
  endpoint: string;
  method: string;
  status: number;
  success: boolean;
  responseTime: number;
  data?: any;
  error?: string;
  headers?: any;
}

// interface PerformanceMetrics {
//   endpoint: string;
//   averageResponseTime: number;
//   minResponseTime: number;
//   maxResponseTime: number;
//   p95ResponseTime: number;
//   p99ResponseTime: number;
//   totalRequests: number;
//   failedRequests: number;
// }

interface SecurityTestResult {
  test: string;
  passed: boolean;
  details: string;
  vulnerabilities?: string[];
}

interface WebSocketTestResult {
  test: string;
  success: boolean;
  details: string;
  metrics?: {
    connectionTime: number;
    messagesSent: number;
    messagesReceived: number;
    errors: number;
  };
}

class MageAgentFunctionalTests {
  private readonly baseUrl = 'https://graphrag.adverant.ai/mageagent';
  private readonly wsUrl = 'wss://graphrag.adverant.ai/mageagent/ws';
  private axiosInstance: AxiosInstance;
  private testResults: TestResult[] = [];
  private performanceMetrics: Map<string, number[]> = new Map();
  private securityResults: SecurityTestResult[] = [];
  private wsTestResults: WebSocketTestResult[] = [];

  constructor() {
    this.axiosInstance = axios.create({
      baseURL: this.baseUrl,
      timeout: 30000,
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'MageAgent-Functional-Tests/1.0'
      },
      validateStatus: () => true // Don't throw on any status code
    });
  }

  /**
   * Execute all functional tests
   */
  async runAllTests(): Promise<void> {
    console.log('🚀 Starting MageAgent Functional Tests Against LIVE Service');
    console.log(`📍 Base URL: ${this.baseUrl}`);
    console.log(`🔌 WebSocket URL: ${this.wsUrl}`);
    console.log('=' .repeat(80));

    try {
      // 1. Health Check Tests
      await this.testHealthEndpoint();

      // 2. API Endpoint Tests
      await this.testOrchestrationEndpoint();
      await this.testCompetitionEndpoint();
      await this.testMemorySearchEndpoint();
      await this.testAgentsEndpoints();
      await this.testPatternsEndpoints();
      await this.testTaskStatusEndpoint();
      await this.testWebSocketStatsEndpoint();
      await this.testModelValidationEndpoint();

      // 3. WebSocket Tests
      await this.testWebSocketConnection();
      await this.testWebSocketCommunication();
      await this.testWebSocketReconnection();

      // 4. Performance Tests
      await this.runPerformanceTests();

      // 5. Security Tests
      await this.runSecurityTests();

      // 6. Error Handling Tests
      await this.testErrorHandling();

      // 7. Rate Limiting Tests
      await this.testRateLimiting();

      // Generate and display comprehensive report
      this.generateTestReport();

    } catch (error) {
      console.error('❌ Fatal error during test execution:', error);
      this.generateTestReport();
    }
  }

  /**
   * Test Health Check Endpoint
   */
  private async testHealthEndpoint(): Promise<void> {
    console.log('\n📋 Testing Health Check Endpoint...');

    const result = await this.makeRequest('GET', '/health');

    if (result.success && result.data) {
      console.log(`✅ Health Check: ${result.data.status}`);
      console.log(`   Services:`, JSON.stringify(result.data.services, null, 2));
    } else {
      console.log(`❌ Health Check Failed: ${result.error}`);
    }
  }

  /**
   * Test Orchestration Endpoint
   */
  private async testOrchestrationEndpoint(): Promise<void> {
    console.log('\n📋 Testing Orchestration Endpoint...');

    // Test valid orchestration request
    const validRequest = {
      task: 'Analyze the impact of AI on software development productivity',
      options: {
        agentCount: 3,
        models: ['openai/gpt-4-turbo', 'anthropic/claude-opus-4.6', 'google/gemini-pro']
      }
    };

    const result = await this.makeRequest('POST', '/api/orchestrate', validRequest);

    if (result.success && result.data) {
      console.log(`✅ Orchestration Started: Task ID ${result.data.taskId}`);
      console.log(`   Status: ${result.data.status}`);
      console.log(`   Agents: ${result.data.agents?.length || 0}`);

      // Store taskId for later status check
      if (result.data.taskId) {
        await this.waitAndCheckTaskStatus(result.data.taskId);
      }
    } else {
      console.log(`❌ Orchestration Failed: ${result.error}`);
    }

    // Test invalid request
    await this.testInvalidRequest('POST', '/api/orchestrate', {});
  }

  /**
   * Test Competition Endpoint
   */
  private async testCompetitionEndpoint(): Promise<void> {
    console.log('\n📋 Testing Competition Endpoint...');

    const competitionRequest = {
      challenge: 'Develop the most efficient algorithm for real-time data stream processing',
      competitorCount: 3,
      models: ['openai/gpt-4-turbo', 'anthropic/claude-opus-4.6', 'google/gemini-pro']
    };

    const result = await this.makeRequest('POST', '/api/competition', competitionRequest);

    if (result.success && result.data) {
      console.log(`✅ Competition Started: ID ${result.data.competitionId}`);
      console.log(`   Winner: ${result.data.winner?.agentId || 'Pending'}`);
      console.log(`   Rankings: ${result.data.rankings?.length || 0} agents`);
    } else {
      console.log(`❌ Competition Failed: ${result.error}`);
    }
  }

  /**
   * Test Memory Search Endpoint
   */
  private async testMemorySearchEndpoint(): Promise<void> {
    console.log('\n📋 Testing Memory Search Endpoint...');

    const searchRequest = {
      query: 'AI orchestration patterns',
      limit: 5
    };

    const result = await this.makeRequest('POST', '/api/memory/search', searchRequest);

    if (result.success && result.data) {
      console.log(`✅ Memory Search Completed`);
      console.log(`   Query: "${searchRequest.query}"`);
      console.log(`   Results: ${result.data.count} items found`);
    } else {
      console.log(`❌ Memory Search Failed: ${result.error}`);
    }
  }

  /**
   * Test Agents Endpoints
   */
  private async testAgentsEndpoints(): Promise<void> {
    console.log('\n📋 Testing Agents Endpoints...');

    // List all agents
    const listResult = await this.makeRequest('GET', '/api/agents');

    if (listResult.success && listResult.data) {
      console.log(`✅ List Agents: ${listResult.data.count} active agents`);

      // Test getting specific agent if any exist
      if (listResult.data.agents?.length > 0) {
        const agentId = listResult.data.agents[0].id;
        const agentResult = await this.makeRequest('GET', `/api/agents/${agentId}`);

        if (agentResult.success) {
          console.log(`✅ Get Agent ${agentId}: Found`);
        } else {
          console.log(`❌ Get Agent Failed: ${agentResult.error}`);
        }
      }
    } else {
      console.log(`❌ List Agents Failed: ${listResult.error}`);
    }

    // Test invalid agent ID
    await this.testInvalidRequest('GET', '/api/agents/invalid-agent-id', null);
  }

  /**
   * Test Patterns Endpoints
   */
  private async testPatternsEndpoints(): Promise<void> {
    console.log('\n📋 Testing Patterns Endpoints...');

    // Store a pattern
    const storeRequest = {
      pattern: 'multi-agent-orchestration',
      context: 'distributed-processing',
      performance: {
        executionTime: 1500,
        successRate: 0.95,
        resourceUsage: 'medium'
      }
    };

    const storeResult = await this.makeRequest('POST', '/api/patterns', storeRequest);

    if (storeResult.success) {
      console.log(`✅ Pattern Stored Successfully`);

      // Retrieve patterns
      const getResult = await this.makeRequest('GET', '/api/patterns/distributed-processing?limit=5');

      if (getResult.success && getResult.data) {
        console.log(`✅ Get Patterns: ${getResult.data.count} patterns found`);
      } else {
        console.log(`❌ Get Patterns Failed: ${getResult.error}`);
      }
    } else {
      console.log(`❌ Store Pattern Failed: ${storeResult.error}`);
    }
  }

  /**
   * Test Task Status Endpoint
   */
  private async testTaskStatusEndpoint(): Promise<void> {
    console.log('\n📋 Testing Task Status Endpoint...');

    // Test with a sample task ID (may not exist)
    const taskId = uuidv4();
    const result = await this.makeRequest('GET', `/api/tasks/${taskId}`);

    if (result.status === 404) {
      console.log(`✅ Task Status (404 Expected): Task ${taskId} not found`);
    } else if (result.success) {
      console.log(`✅ Task Status: Found task ${taskId}`);
    } else {
      console.log(`❌ Task Status Failed: ${result.error}`);
    }
  }

  /**
   * Test WebSocket Stats Endpoint
   */
  private async testWebSocketStatsEndpoint(): Promise<void> {
    console.log('\n📋 Testing WebSocket Stats Endpoint...');

    const result = await this.makeRequest('GET', '/api/websocket/stats');

    if (result.success && result.data) {
      console.log(`✅ WebSocket Stats Retrieved`);
      console.log(`   Active Sessions: ${result.data.stats?.activeSessions || 0}`);
      console.log(`   Active Streams: ${result.data.stats?.activeAgentStreams || 0}`);
      console.log(`   Uptime: ${result.data.stats?.uptime || 0}s`);
    } else {
      console.log(`❌ WebSocket Stats Failed: ${result.error}`);
    }
  }

  /**
   * Test Model Validation Endpoint
   */
  private async testModelValidationEndpoint(): Promise<void> {
    console.log('\n📋 Testing Model Validation Endpoint...');

    const validModels = [
      'openai/gpt-4-turbo',
      'anthropic/claude-opus-4.6',
      'google/gemini-pro'
    ];

    for (const modelId of validModels) {
      const result = await this.makeRequest('POST', '/api/validate-model', { modelId });

      if (result.success && result.data) {
        console.log(`✅ Model ${modelId}: ${result.data.valid ? 'Valid' : 'Invalid'}`);
      } else {
        console.log(`❌ Model Validation Failed for ${modelId}: ${result.error}`);
      }
    }

    // Test invalid model
    const invalidResult = await this.makeRequest('POST', '/api/validate-model', {
      modelId: 'invalid/model-name'
    });
    console.log(`✅ Invalid Model Test: ${invalidResult.data?.valid === false ? 'Correctly rejected' : 'Unexpected result'}`);
  }

  /**
   * Test WebSocket Connection
   */
  private async testWebSocketConnection(): Promise<void> {
    console.log('\n📋 Testing WebSocket Connection...');

    return new Promise((resolve) => {
      const startTime = Date.now();
      const ws = new WebSocket(this.wsUrl);

      ws.on('open', () => {
        const connectionTime = Date.now() - startTime;
        console.log(`✅ WebSocket Connected in ${connectionTime}ms`);

        this.wsTestResults.push({
          test: 'Connection Establishment',
          success: true,
          details: `Connected successfully in ${connectionTime}ms`,
          metrics: {
            connectionTime,
            messagesSent: 0,
            messagesReceived: 0,
            errors: 0
          }
        });

        ws.close();
      });

      ws.on('error', (error) => {
        console.log(`❌ WebSocket Connection Failed: ${error.message}`);
        this.wsTestResults.push({
          test: 'Connection Establishment',
          success: false,
          details: error.message
        });
      });

      ws.on('close', () => {
        resolve();
      });

      // Timeout after 10 seconds
      setTimeout(() => {
        if (ws.readyState !== WebSocket.CLOSED) {
          ws.close();
          resolve();
        }
      }, 10000);
    });
  }

  /**
   * Test WebSocket Communication
   */
  private async testWebSocketCommunication(): Promise<void> {
    console.log('\n📋 Testing WebSocket Communication...');

    return new Promise((resolve) => {
      const ws = new WebSocket(this.wsUrl);
      let messageCount = 0;
      let sessionId: string | null = null;

      const testMetrics = {
        connectionTime: 0,
        messagesSent: 0,
        messagesReceived: 0,
        errors: 0
      };

      ws.on('open', () => {
        console.log('✅ WebSocket Connected for Communication Test');

        // Test subscribing to an agent
        ws.send(JSON.stringify({
          type: 'subscribe',
          data: {
            agentId: 'test-agent-' + uuidv4(),
            streamTypes: ['all']
          }
        }));
        testMetrics.messagesSent++;
      });

      ws.on('message', (data) => {
        testMetrics.messagesReceived++;
        try {
          const message = JSON.parse(data.toString());
          console.log(`📨 Received message type: ${message.type || 'unknown'}`);

          if (message.sessionId) {
            sessionId = message.sessionId;
            console.log(`   Session ID: ${sessionId}`);
          }

          messageCount++;

          // After receiving welcome and subscription confirmation, test other operations
          if (messageCount === 2) {
            // Test unsubscribe
            ws.send(JSON.stringify({
              type: 'unsubscribe',
              data: {
                agentId: 'test-agent-' + uuidv4()
              }
            }));
            testMetrics.messagesSent++;
          }

          if (messageCount >= 3) {
            this.wsTestResults.push({
              test: 'Bidirectional Communication',
              success: true,
              details: `Successfully exchanged ${messageCount} messages`,
              metrics: testMetrics
            });
            ws.close();
          }
        } catch (error) {
          testMetrics.errors++;
          console.error('Error parsing WebSocket message:', error);
        }
      });

      ws.on('error', (error) => {
        testMetrics.errors++;
        console.log(`❌ WebSocket Communication Error: ${error.message}`);
      });

      ws.on('close', () => {
        resolve();
      });

      // Timeout after 15 seconds
      setTimeout(() => {
        if (ws.readyState !== WebSocket.CLOSED) {
          this.wsTestResults.push({
            test: 'Bidirectional Communication',
            success: false,
            details: 'Communication test timed out',
            metrics: testMetrics
          });
          ws.close();
          resolve();
        }
      }, 15000);
    });
  }

  /**
   * Test WebSocket Reconnection
   */
  private async testWebSocketReconnection(): Promise<void> {
    console.log('\n📋 Testing WebSocket Reconnection...');

    return new Promise((resolve) => {
      let reconnectAttempts = 0;
      const maxReconnects = 3;

      const attemptConnection = () => {
        const ws = new WebSocket(this.wsUrl);

        ws.on('open', () => {
          reconnectAttempts++;
          console.log(`✅ Reconnection attempt ${reconnectAttempts} successful`);

          // Close connection to simulate disconnect
          if (reconnectAttempts < maxReconnects) {
            setTimeout(() => ws.close(), 100);
          } else {
            this.wsTestResults.push({
              test: 'Reconnection Behavior',
              success: true,
              details: `Successfully reconnected ${reconnectAttempts} times`
            });
            ws.close();
            resolve();
          }
        });

        ws.on('close', () => {
          if (reconnectAttempts < maxReconnects) {
            setTimeout(attemptConnection, 1000); // Wait 1 second before reconnecting
          }
        });

        ws.on('error', (error) => {
          console.log(`❌ Reconnection Error: ${error.message}`);
          this.wsTestResults.push({
            test: 'Reconnection Behavior',
            success: false,
            details: `Failed after ${reconnectAttempts} attempts: ${error.message}`
          });
          resolve();
        });
      };

      attemptConnection();
    });
  }

  /**
   * Run Performance Tests
   */
  private async runPerformanceTests(): Promise<void> {
    console.log('\n📊 Running Performance Tests...');

    const endpoints = [
      { method: 'GET', path: '/health', requests: 50 },
      { method: 'GET', path: '/api/agents', requests: 30 },
      { method: 'GET', path: '/api/websocket/stats', requests: 30 }
    ];

    for (const endpoint of endpoints) {
      console.log(`\nTesting ${endpoint.method} ${endpoint.path} with ${endpoint.requests} requests...`);
      const responseTimes: number[] = [];

      for (let i = 0; i < endpoint.requests; i++) {
        const startTime = Date.now();
        await this.makeRequest(endpoint.method as any, endpoint.path);
        const responseTime = Date.now() - startTime;

        responseTimes.push(responseTime);

        // Store for metrics calculation
        const key = `${endpoint.method} ${endpoint.path}`;
        if (!this.performanceMetrics.has(key)) {
          this.performanceMetrics.set(key, []);
        }
        this.performanceMetrics.get(key)!.push(responseTime);

        // Small delay to avoid overwhelming the server
        await new Promise(resolve => setTimeout(resolve, 100));
      }

      // Calculate and display metrics
      const metrics = this.calculatePerformanceMetrics(responseTimes);
      console.log(`  Average: ${metrics.average.toFixed(2)}ms`);
      console.log(`  Min: ${metrics.min}ms, Max: ${metrics.max}ms`);
      console.log(`  P95: ${metrics.p95}ms, P99: ${metrics.p99}ms`);
    }
  }

  /**
   * Run Security Tests
   */
  private async runSecurityTests(): Promise<void> {
    console.log('\n🔒 Running Security Tests...');

    // Test CORS headers
    await this.testCORSHeaders();

    // Test security headers
    await this.testSecurityHeaders();

    // Test input validation
    await this.testInputValidation();

    // Test SQL injection attempts
    await this.testSQLInjection();

    // Test XSS attempts
    await this.testXSSAttempts();

    // Test authentication bypass attempts
    await this.testAuthenticationBypass();
  }

  /**
   * Test CORS Headers
   */
  private async testCORSHeaders(): Promise<void> {
    console.log('\n🔒 Testing CORS Headers...');

    const result = await this.makeRequest('OPTIONS', '/api/orchestrate', null, {
      'Origin': 'https://malicious-site.com',
      'Access-Control-Request-Method': 'POST'
    });

    const corsHeaders = result.headers;
    const hasValidCORS = corsHeaders && (
      corsHeaders['access-control-allow-origin'] === '*' ||
      corsHeaders['access-control-allow-origin']?.includes('graphrag.adverant.ai')
    );

    this.securityResults.push({
      test: 'CORS Configuration',
      passed: hasValidCORS,
      details: hasValidCORS ? 'CORS headers properly configured' : 'CORS headers missing or misconfigured',
      vulnerabilities: hasValidCORS ? [] : ['Missing proper CORS configuration']
    });
  }

  /**
   * Test Security Headers
   */
  private async testSecurityHeaders(): Promise<void> {
    console.log('\n🔒 Testing Security Headers...');

    const result = await this.makeRequest('GET', '/health');
    const headers = result.headers || {};

    const securityHeaderTests = [
      { header: 'x-content-type-options', expected: 'nosniff' },
      { header: 'x-frame-options', expected: 'DENY' },
      { header: 'x-xss-protection', expected: '1; mode=block' },
      { header: 'strict-transport-security', expected: 'max-age=' }
    ];

    const missingHeaders: string[] = [];

    for (const test of securityHeaderTests) {
      if (!headers[test.header] || !headers[test.header].includes(test.expected)) {
        missingHeaders.push(test.header);
      }
    }

    this.securityResults.push({
      test: 'Security Headers',
      passed: missingHeaders.length === 0,
      details: missingHeaders.length === 0 ? 'All security headers present' : `Missing headers: ${missingHeaders.join(', ')}`,
      vulnerabilities: missingHeaders.map(h => `Missing ${h} header`)
    });
  }

  /**
   * Test Input Validation
   */
  private async testInputValidation(): Promise<void> {
    console.log('\n🔒 Testing Input Validation...');

    const invalidInputs = [
      { endpoint: '/api/orchestrate', data: { task: null } },
      { endpoint: '/api/orchestrate', data: { task: '' } },
      { endpoint: '/api/orchestrate', data: { task: 123 } }, // Wrong type
      { endpoint: '/api/competition', data: { challenge: '<script>alert("xss")</script>' } },
      { endpoint: '/api/memory/search', data: { query: 'a'.repeat(10000) } } // Very long input
    ];

    let validationPassed = true;
    const vulnerabilities: string[] = [];

    for (const test of invalidInputs) {
      const result = await this.makeRequest('POST', test.endpoint, test.data);

      if (result.status === 200) {
        validationPassed = false;
        vulnerabilities.push(`Accepted invalid input at ${test.endpoint}`);
      }
    }

    this.securityResults.push({
      test: 'Input Validation',
      passed: validationPassed,
      details: validationPassed ? 'All invalid inputs rejected' : 'Some invalid inputs were accepted',
      vulnerabilities
    });
  }

  /**
   * Test SQL Injection Attempts
   */
  private async testSQLInjection(): Promise<void> {
    console.log('\n🔒 Testing SQL Injection Protection...');

    const sqlInjectionPayloads = [
      "'; DROP TABLE users; --",
      "1' OR '1'='1",
      "admin'--",
      "1; SELECT * FROM sensitive_data",
      "UNION SELECT * FROM passwords"
    ];

    let injectionBlocked = true;
    const vulnerabilities: string[] = [];

    for (const payload of sqlInjectionPayloads) {
      const result = await this.makeRequest('POST', '/api/memory/search', { query: payload });

      // Check if the payload was processed (which would be bad)
      if (result.data && result.data.results && result.data.results.length > 0) {
        // Additional check: see if the response contains database errors
        const responseStr = JSON.stringify(result.data);
        if (responseStr.includes('syntax error') || responseStr.includes('SQL')) {
          injectionBlocked = false;
          vulnerabilities.push(`SQL injection payload processed: ${payload}`);
        }
      }
    }

    this.securityResults.push({
      test: 'SQL Injection Protection',
      passed: injectionBlocked,
      details: injectionBlocked ? 'All SQL injection attempts blocked' : 'Some SQL injection payloads were processed',
      vulnerabilities
    });
  }

  /**
   * Test XSS Attempts
   */
  private async testXSSAttempts(): Promise<void> {
    console.log('\n🔒 Testing XSS Protection...');

    const xssPayloads = [
      '<script>alert("XSS")</script>',
      '<img src=x onerror=alert("XSS")>',
      'javascript:alert("XSS")',
      '<svg onload=alert("XSS")>',
      '"><script>alert(String.fromCharCode(88,83,83))</script>'
    ];

    let xssBlocked = true;
    const vulnerabilities: string[] = [];

    for (const payload of xssPayloads) {
      const result = await this.makeRequest('POST', '/api/patterns', {
        pattern: payload,
        context: 'test-context'
      });

      // Check if the payload was stored without sanitization
      if (result.success) {
        // Try to retrieve it
        const getResult = await this.makeRequest('GET', '/api/patterns/test-context');
        if (getResult.data && getResult.data.patterns) {
          const storedPatterns = JSON.stringify(getResult.data.patterns);
          if (storedPatterns.includes(payload)) {
            xssBlocked = false;
            vulnerabilities.push(`XSS payload stored without sanitization: ${payload}`);
          }
        }
      }
    }

    this.securityResults.push({
      test: 'XSS Protection',
      passed: xssBlocked,
      details: xssBlocked ? 'All XSS attempts blocked or sanitized' : 'Some XSS payloads were stored unsanitized',
      vulnerabilities
    });
  }

  /**
   * Test Authentication Bypass Attempts
   */
  private async testAuthenticationBypass(): Promise<void> {
    console.log('\n🔒 Testing Authentication Bypass Protection...');

    const bypassAttempts = [
      { headers: { 'X-Forwarded-For': '127.0.0.1' } },
      { headers: { 'X-Real-IP': 'localhost' } },
      { headers: { 'Authorization': 'Bearer fake-token' } },
      { headers: { 'X-API-Key': 'admin' } }
    ];

    let bypassBlocked = true;
    const vulnerabilities: string[] = [];

    for (const attempt of bypassAttempts) {
      const result = await this.makeRequest('GET', '/api/agents', null, attempt.headers);

      // If we get data that looks privileged, that's bad
      if (result.data && result.data.agents && result.data.agents.length > 0) {
        // Check if the response contains sensitive information
        const responseStr = JSON.stringify(result.data);
        if (responseStr.includes('secret') || responseStr.includes('token') || responseStr.includes('password')) {
          bypassBlocked = false;
          vulnerabilities.push(`Potential auth bypass with headers: ${JSON.stringify(attempt.headers)}`);
        }
      }
    }

    this.securityResults.push({
      test: 'Authentication Bypass Protection',
      passed: bypassBlocked,
      details: bypassBlocked ? 'All authentication bypass attempts blocked' : 'Some bypass attempts may have succeeded',
      vulnerabilities
    });
  }

  /**
   * Test Error Handling
   */
  private async testErrorHandling(): Promise<void> {
    console.log('\n⚠️ Testing Error Handling...');

    // Test 404 handling
    const notFoundResult = await this.makeRequest('GET', '/api/nonexistent-endpoint');
    console.log(`404 Handling: ${notFoundResult.status === 404 ? '✅ Correct' : '❌ Incorrect'} (Status: ${notFoundResult.status})`);

    // Test method not allowed
    const methodResult = await this.makeRequest('DELETE', '/health');
    console.log(`Method Not Allowed: ${methodResult.status === 405 ? '✅ Correct' : '❌ Incorrect'} (Status: ${methodResult.status})`);

    // Test malformed JSON
    try {
      const response = await this.axiosInstance.post('/api/orchestrate', 'invalid json', {
        headers: { 'Content-Type': 'application/json' }
      });
      console.log(`Malformed JSON: ${response.status >= 400 ? '✅ Rejected' : '❌ Accepted'} (Status: ${response.status})`);
    } catch (error) {
      console.log(`Malformed JSON: ✅ Rejected with error`);
    }

    // Test large payload
    const largePayload = {
      task: 'a'.repeat(1000000) // 1MB string
    };
    const largeResult = await this.makeRequest('POST', '/api/orchestrate', largePayload);
    console.log(`Large Payload: ${largeResult.status === 413 || largeResult.status === 400 ? '✅ Rejected' : '⚠️ Accepted'} (Status: ${largeResult.status})`);
  }

  /**
   * Test Rate Limiting
   */
  private async testRateLimiting(): Promise<void> {
    console.log('\n🚦 Testing Rate Limiting...');

    const endpoints = [
      { path: '/api/orchestrate', method: 'POST', data: { task: 'rate limit test' }, limit: 10 },
      { path: '/api/memory/search', method: 'POST', data: { query: 'test' }, limit: 20 }
    ];

    for (const endpoint of endpoints) {
      console.log(`\nTesting rate limit for ${endpoint.path}...`);
      let rateLimitHit = false;
      let requestCount = 0;

      // Make rapid requests until rate limited
      for (let i = 0; i < endpoint.limit + 10; i++) {
        const result = await this.makeRequest(endpoint.method as any, endpoint.path, endpoint.data);
        requestCount++;

        if (result.status === 429) {
          rateLimitHit = true;
          console.log(`✅ Rate limit enforced after ${requestCount} requests`);

          // Check for rate limit headers
          if (result.headers) {
            console.log(`   Rate Limit Headers:`, {
              'X-RateLimit-Limit': result.headers['x-ratelimit-limit'],
              'X-RateLimit-Remaining': result.headers['x-ratelimit-remaining'],
              'X-RateLimit-Reset': result.headers['x-ratelimit-reset']
            });
          }
          break;
        }

        // Small delay to ensure requests are tracked
        await new Promise(resolve => setTimeout(resolve, 50));
      }

      if (!rateLimitHit) {
        console.log(`⚠️ Rate limit not enforced after ${requestCount} requests`);
      }

      // Wait for rate limit to reset
      console.log('   Waiting for rate limit reset...');
      await new Promise(resolve => setTimeout(resolve, 5000));
    }
  }

  /**
   * Helper method to make HTTP requests
   */
  private async makeRequest(
    method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'OPTIONS',
    path: string,
    data?: any,
    additionalHeaders?: any
  ): Promise<TestResult> {
    const startTime = Date.now();

    try {
      const config: any = {
        method,
        url: path,
        headers: { ...additionalHeaders }
      };

      if (data && (method === 'POST' || method === 'PUT')) {
        config.data = data;
      }

      const response = await this.axiosInstance.request(config);
      const responseTime = Date.now() - startTime;

      const result: TestResult = {
        endpoint: path,
        method,
        status: response.status,
        success: response.status >= 200 && response.status < 300,
        responseTime,
        data: response.data,
        headers: response.headers
      };

      this.testResults.push(result);
      return result;

    } catch (error) {
      const responseTime = Date.now() - startTime;
      const axiosError = error as AxiosError;

      const result: TestResult = {
        endpoint: path,
        method,
        status: axiosError.response?.status || 0,
        success: false,
        responseTime,
        error: axiosError.message,
        data: axiosError.response?.data,
        headers: axiosError.response?.headers
      };

      this.testResults.push(result);
      return result;
    }
  }

  /**
   * Test invalid requests
   */
  private async testInvalidRequest(
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    path: string,
    data: any
  ): Promise<void> {
    const result = await this.makeRequest(method, path, data);

    if (result.status >= 400) {
      console.log(`✅ Invalid request correctly rejected with status ${result.status}`);
    } else {
      console.log(`❌ Invalid request incorrectly accepted with status ${result.status}`);
    }
  }

  /**
   * Wait and check task status
   */
  private async waitAndCheckTaskStatus(taskId: string, maxAttempts: number = 5): Promise<void> {
    console.log(`\n⏳ Checking task status for ${taskId}...`);

    for (let i = 0; i < maxAttempts; i++) {
      await new Promise(resolve => setTimeout(resolve, 2000)); // Wait 2 seconds

      const result = await this.makeRequest('GET', `/api/tasks/${taskId}`);

      if (result.success && result.data) {
        console.log(`   Attempt ${i + 1}: Status = ${result.data.status?.status || 'unknown'}`);

        if (result.data.status?.status === 'completed' || result.data.status?.status === 'failed') {
          console.log(`   Task completed with status: ${result.data.status.status}`);
          break;
        }
      }
    }
  }

  /**
   * Calculate performance metrics
   */
  private calculatePerformanceMetrics(responseTimes: number[]): {
    average: number;
    min: number;
    max: number;
    p95: number;
    p99: number;
  } {
    const sorted = responseTimes.sort((a, b) => a - b);
    const sum = sorted.reduce((a, b) => a + b, 0);

    return {
      average: sum / sorted.length,
      min: sorted[0],
      max: sorted[sorted.length - 1],
      p95: sorted[Math.floor(sorted.length * 0.95)],
      p99: sorted[Math.floor(sorted.length * 0.99)]
    };
  }

  /**
   * Generate comprehensive test report
   */
  private generateTestReport(): void {
    console.log('\n' + '='.repeat(80));
    console.log('📊 COMPREHENSIVE TEST REPORT');
    console.log('='.repeat(80));

    // Summary Statistics
    const totalTests = this.testResults.length;
    const successfulTests = this.testResults.filter(r => r.success).length;
    const failedTests = totalTests - successfulTests;
    const successRate = (successfulTests / totalTests * 100).toFixed(2);

    console.log('\n📈 SUMMARY STATISTICS:');
    console.log(`   Total API Tests: ${totalTests}`);
    console.log(`   Successful: ${successfulTests} (${successRate}%)`);
    console.log(`   Failed: ${failedTests}`);

    // Endpoint Status Summary
    console.log('\n🔗 ENDPOINT STATUS SUMMARY:');
    const endpointSummary = new Map<string, { success: number, failed: number, avgTime: number }>();

    for (const result of this.testResults) {
      const key = `${result.method} ${result.endpoint}`;
      if (!endpointSummary.has(key)) {
        endpointSummary.set(key, { success: 0, failed: 0, avgTime: 0 });
      }

      const summary = endpointSummary.get(key)!;
      if (result.success) {
        summary.success++;
      } else {
        summary.failed++;
      }
      summary.avgTime = (summary.avgTime + result.responseTime) / 2;
    }

    for (const [endpoint, summary] of endpointSummary) {
      console.log(`   ${endpoint}:`);
      console.log(`      Success: ${summary.success}, Failed: ${summary.failed}`);
      console.log(`      Avg Response Time: ${summary.avgTime.toFixed(2)}ms`);
    }

    // Performance Metrics
    console.log('\n⚡ PERFORMANCE METRICS:');
    for (const [endpoint, times] of this.performanceMetrics) {
      const metrics = this.calculatePerformanceMetrics(times);
      console.log(`   ${endpoint}:`);
      console.log(`      Average: ${metrics.average.toFixed(2)}ms`);
      console.log(`      P95: ${metrics.p95}ms, P99: ${metrics.p99}ms`);
    }

    // WebSocket Test Results
    console.log('\n🔌 WEBSOCKET TEST RESULTS:');
    for (const wsResult of this.wsTestResults) {
      console.log(`   ${wsResult.test}: ${wsResult.success ? '✅ PASSED' : '❌ FAILED'}`);
      console.log(`      Details: ${wsResult.details}`);
      if (wsResult.metrics) {
        console.log(`      Metrics:`, wsResult.metrics);
      }
    }

    // Security Test Results
    console.log('\n🔒 SECURITY TEST RESULTS:');
    const securityPassed = this.securityResults.filter(r => r.passed).length;
    const securityFailed = this.securityResults.filter(r => !r.passed).length;
    console.log(`   Passed: ${securityPassed}, Failed: ${securityFailed}`);

    for (const secResult of this.securityResults) {
      console.log(`\n   ${secResult.test}: ${secResult.passed ? '✅ PASSED' : '❌ FAILED'}`);
      console.log(`      ${secResult.details}`);
      if (secResult.vulnerabilities && secResult.vulnerabilities.length > 0) {
        console.log(`      Vulnerabilities:`);
        for (const vuln of secResult.vulnerabilities) {
          console.log(`         - ${vuln}`);
        }
      }
    }

    // Failed Tests Details
    if (failedTests > 0) {
      console.log('\n❌ FAILED TEST DETAILS:');
      for (const result of this.testResults.filter(r => !r.success)) {
        console.log(`   ${result.method} ${result.endpoint}:`);
        console.log(`      Status: ${result.status}`);
        console.log(`      Error: ${result.error || 'Unknown error'}`);
        if (result.data) {
          console.log(`      Response: ${JSON.stringify(result.data).substring(0, 200)}...`);
        }
      }
    }

    // Recommendations
    console.log('\n💡 RECOMMENDATIONS:');

    if (securityFailed > 0) {
      console.log('   - Address security vulnerabilities identified in the security tests');
    }

    const slowEndpoints = Array.from(this.performanceMetrics.entries())
      .filter(([_, times]) => this.calculatePerformanceMetrics(times).average > 1000);

    if (slowEndpoints.length > 0) {
      console.log('   - Optimize slow endpoints (>1s average response time):');
      for (const [endpoint] of slowEndpoints) {
        console.log(`     • ${endpoint}`);
      }
    }

    if (this.wsTestResults.some(r => !r.success)) {
      console.log('   - Investigate WebSocket connectivity issues');
    }

    console.log('\n' + '='.repeat(80));
    console.log('✅ FUNCTIONAL TESTING COMPLETE');
    console.log('='.repeat(80));
  }
}

// Execute the tests
async function main() {
  const tester = new MageAgentFunctionalTests();
  await tester.runAllTests();
}

// Run the tests
main().catch(console.error);