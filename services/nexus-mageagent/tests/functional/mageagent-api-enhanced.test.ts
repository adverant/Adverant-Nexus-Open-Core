import axios, { AxiosInstance } from 'axios';
import WebSocket from 'ws';
import { v4 as uuidv4 } from 'uuid';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Enhanced Functional Tests for MageAgent Service
 *
 * This version includes better error handling, connectivity checks,
 * and comprehensive reporting even when the service is unavailable.
 */

interface ServiceStatus {
  available: boolean;
  endpoint: string;
  error?: string;
  latency?: number;
  timestamp: string;
}

interface TestSummary {
  totalTests: number;
  executed: number;
  passed: number;
  failed: number;
  skipped: number;
  serviceAvailable: boolean;
  errors: string[];
}

interface DetailedTestReport {
  testRun: {
    id: string;
    startTime: string;
    endTime: string;
    duration: number;
    environment: string;
  };
  serviceInfo: {
    baseUrl: string;
    wsUrl: string;
    status: ServiceStatus;
  };
  summary: TestSummary;
  testResults: {
    api: any[];
    websocket: any[];
    performance: any[];
    security: any[];
  };
  recommendations: string[];
}

class EnhancedMageAgentTests {
  private readonly baseUrl = process.env.MAGEAGENT_BASE_URL || 'https://graphrag.adverant.ai/mageagent';
  private readonly wsUrl = process.env.MAGEAGENT_WS_URL || 'wss://graphrag.adverant.ai/mageagent/ws';
  private axiosInstance: AxiosInstance;
  private report: DetailedTestReport;
  private testRunId: string;

  constructor() {
    this.testRunId = uuidv4();
    this.axiosInstance = axios.create({
      baseURL: this.baseUrl,
      timeout: 10000, // 10 second timeout
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'MageAgent-Functional-Tests/2.0',
        'X-Test-Run-ID': this.testRunId
      },
      validateStatus: () => true
    });

    // Initialize report structure
    this.report = {
      testRun: {
        id: this.testRunId,
        startTime: new Date().toISOString(),
        endTime: '',
        duration: 0,
        environment: process.env.TEST_ENV || 'production'
      },
      serviceInfo: {
        baseUrl: this.baseUrl,
        wsUrl: this.wsUrl,
        status: {
          available: false,
          endpoint: this.baseUrl,
          timestamp: new Date().toISOString()
        }
      },
      summary: {
        totalTests: 0,
        executed: 0,
        passed: 0,
        failed: 0,
        skipped: 0,
        serviceAvailable: false,
        errors: []
      },
      testResults: {
        api: [],
        websocket: [],
        performance: [],
        security: []
      },
      recommendations: []
    };
  }

  /**
   * Main test execution
   */
  async runTests(): Promise<void> {
    console.log('🚀 Enhanced MageAgent Functional Tests');
    console.log('=' .repeat(80));
    console.log(`📍 Base URL: ${this.baseUrl}`);
    console.log(`🔌 WebSocket URL: ${this.wsUrl}`);
    console.log(`🔖 Test Run ID: ${this.testRunId}`);
    console.log('=' .repeat(80));

    const startTime = Date.now();

    try {
      // Step 1: Check service availability
      console.log('\n🔍 Checking Service Availability...');
      await this.checkServiceAvailability();

      if (!this.report.serviceInfo.status.available) {
        console.log('\n⚠️  Service is not available. Running limited tests...');
        await this.runLimitedTests();
      } else {
        console.log('\n✅ Service is available. Running full test suite...');
        await this.runFullTestSuite();
      }

    } catch (error) {
      console.error('\n❌ Critical error during test execution:', error);
      this.report.summary.errors.push(`Critical error: ${error instanceof Error ? error.message : 'Unknown error'}`);
    } finally {
      // Finalize report
      this.report.testRun.endTime = new Date().toISOString();
      this.report.testRun.duration = Date.now() - startTime;

      // Generate recommendations
      this.generateRecommendations();

      // Save and display report
      await this.saveReport();
      this.displayReport();
    }
  }

  /**
   * Check if the service is available
   */
  private async checkServiceAvailability(): Promise<void> {
    const checks = [
      { name: 'TCP Connection', url: this.baseUrl },
      { name: 'Health Endpoint', url: `${this.baseUrl}/health` },
      { name: 'API Root', url: `${this.baseUrl}/api` }
    ];

    for (const check of checks) {
      console.log(`   Checking ${check.name}...`);
      const startTime = Date.now();

      try {
        const response = await axios.get(check.url, {
          timeout: 5000,
          validateStatus: () => true
        });

        const latency = Date.now() - startTime;

        if (response.status > 0) {
          console.log(`   ✅ ${check.name}: Responded with status ${response.status} (${latency}ms)`);

          if (check.name === 'Health Endpoint' && response.status === 200) {
            this.report.serviceInfo.status = {
              available: true,
              endpoint: check.url,
              latency,
              timestamp: new Date().toISOString()
            };
            this.report.summary.serviceAvailable = true;
            return;
          }
        }
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        console.log(`   ❌ ${check.name}: ${errorMessage}`);

        if (!this.report.serviceInfo.status.error) {
          this.report.serviceInfo.status.error = errorMessage;
        }
      }
    }

    // Additional network diagnostics
    await this.runNetworkDiagnostics();
  }

  /**
   * Run network diagnostics
   */
  private async runNetworkDiagnostics(): Promise<void> {
    console.log('\n🔧 Running Network Diagnostics...');

    const diagnostics: any = {
      timestamp: new Date().toISOString(),
      checks: []
    };

    // DNS Resolution
    try {
      const url = new URL(this.baseUrl);
      const dns = require('dns').promises;
      const addresses = await dns.resolve4(url.hostname);
      diagnostics.checks.push({
        type: 'DNS Resolution',
        success: true,
        result: `Resolved to: ${addresses.join(', ')}`
      });
      console.log(`   ✅ DNS Resolution: ${addresses.join(', ')}`);
    } catch (error) {
      diagnostics.checks.push({
        type: 'DNS Resolution',
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error'
      });
      console.log(`   ❌ DNS Resolution failed`);
    }

    // TLS Certificate Check
    try {
      const https = require('https');
      const url = new URL(this.baseUrl);

      await new Promise((resolve) => {
        const req = https.get({
          hostname: url.hostname,
          port: 443,
          path: '/',
          timeout: 5000
        }, (res: any) => {
          const cert = res.connection.getPeerCertificate();
          if (cert) {
            diagnostics.checks.push({
              type: 'TLS Certificate',
              success: true,
              result: {
                subject: cert.subject,
                issuer: cert.issuer,
                valid_from: cert.valid_from,
                valid_to: cert.valid_to
              }
            });
            console.log(`   ✅ TLS Certificate: Valid (${cert.issuer?.CN || 'Unknown Issuer'})`);
          }
          resolve(true);
        });

        req.on('error', (error: any) => {
          diagnostics.checks.push({
            type: 'TLS Certificate',
            success: false,
            error: error.message
          });
          console.log(`   ❌ TLS Certificate check failed`);
          resolve(false);
        });

        req.end();
      });
    } catch (error) {
      console.log(`   ❌ TLS Certificate check error`);
    }

    this.report.testResults.api.push({
      category: 'Network Diagnostics',
      results: diagnostics
    });
  }

  /**
   * Run limited tests when service is unavailable
   */
  private async runLimitedTests(): Promise<void> {
    this.report.summary.totalTests = 10;

    // Test 1: Service Discovery
    await this.testServiceDiscovery();

    // Test 2: Error Response Format
    await this.testErrorResponseFormat();

    // Test 3: WebSocket Connectivity
    await this.testWebSocketConnectivity();

    // Test 4: Alternative Endpoints
    await this.testAlternativeEndpoints();

    // Test 5: Generate curl commands for manual testing
    this.generateCurlCommands();
  }

  /**
   * Run full test suite when service is available
   */
  private async runFullTestSuite(): Promise<void> {
    console.log('\n🧪 Running Full Test Suite...');

    // Calculate total tests
    this.report.summary.totalTests = 50; // Approximate

    // API Tests
    await this.runAPITests();

    // WebSocket Tests
    await this.runWebSocketTests();

    // Performance Tests
    await this.runPerformanceTests();

    // Security Tests
    await this.runSecurityTests();
  }

  /**
   * Test service discovery
   */
  private async testServiceDiscovery(): Promise<void> {
    console.log('\n📡 Testing Service Discovery...');

    const discoveryEndpoints = [
      '/mageagent',
      '/mageagent/api',
      '/api/mageagent',
      '/graphrag/mageagent',
      '/'
    ];

    const results: any[] = [];

    for (const endpoint of discoveryEndpoints) {
      try {
        const url = `https://graphrag.adverant.ai${endpoint}`;
        console.log(`   Trying: ${url}`);

        const response = await axios.get(url, {
          timeout: 5000,
          validateStatus: () => true
        });

        if (response.status > 0) {
          results.push({
            endpoint,
            status: response.status,
            success: response.status < 500,
            headers: response.headers
          });
          console.log(`   → Status: ${response.status}`);
        }
      } catch (error) {
        results.push({
          endpoint,
          error: error instanceof Error ? error.message : 'Unknown error'
        });
      }
    }

    this.report.testResults.api.push({
      category: 'Service Discovery',
      timestamp: new Date().toISOString(),
      results
    });

    this.report.summary.executed += discoveryEndpoints.length;
  }

  /**
   * Test error response format
   */
  private async testErrorResponseFormat(): Promise<void> {
    console.log('\n📝 Testing Error Response Format...');

    const testCases = [
      {
        name: 'Invalid JSON',
        data: '{invalid json}',
        contentType: 'application/json'
      },
      {
        name: 'Wrong Content Type',
        data: '<xml>test</xml>',
        contentType: 'application/xml'
      },
      {
        name: 'Empty Body',
        data: '',
        contentType: 'application/json'
      }
    ];

    const results: any[] = [];

    for (const testCase of testCases) {
      try {
        const response = await axios.post(`${this.baseUrl}/api/orchestrate`, testCase.data, {
          headers: { 'Content-Type': testCase.contentType },
          timeout: 5000,
          validateStatus: () => true
        });

        results.push({
          test: testCase.name,
          status: response.status,
          hasErrorMessage: !!response.data?.error,
          responseFormat: typeof response.data
        });

      } catch (error) {
        results.push({
          test: testCase.name,
          error: error instanceof Error ? error.message : 'Unknown error'
        });
      }
    }

    this.report.testResults.api.push({
      category: 'Error Response Format',
      timestamp: new Date().toISOString(),
      results
    });

    this.report.summary.executed += testCases.length;
  }

  /**
   * Test WebSocket connectivity
   */
  private async testWebSocketConnectivity(): Promise<void> {
    console.log('\n🔌 Testing WebSocket Connectivity...');

    return new Promise((resolve) => {
      const startTime = Date.now();
      const ws = new WebSocket(this.wsUrl);
      let connected = false;

      const timeout = setTimeout(() => {
        if (!connected) {
          this.report.testResults.websocket.push({
            category: 'WebSocket Connection',
            success: false,
            error: 'Connection timeout after 10s',
            duration: 10000
          });
          ws.terminate();
          resolve();
        }
      }, 10000);

      ws.on('open', () => {
        connected = true;
        clearTimeout(timeout);
        const duration = Date.now() - startTime;

        console.log(`   ✅ WebSocket connected in ${duration}ms`);

        this.report.testResults.websocket.push({
          category: 'WebSocket Connection',
          success: true,
          duration,
          readyState: ws.readyState
        });

        this.report.summary.passed++;
        ws.close();
      });

      ws.on('error', (error) => {
        clearTimeout(timeout);
        console.log(`   ❌ WebSocket error: ${error.message}`);

        this.report.testResults.websocket.push({
          category: 'WebSocket Connection',
          success: false,
          error: error.message,
          duration: Date.now() - startTime
        });

        this.report.summary.failed++;
      });

      ws.on('close', () => {
        resolve();
      });

      this.report.summary.executed++;
    });
  }

  /**
   * Test alternative endpoints
   */
  private async testAlternativeEndpoints(): Promise<void> {
    console.log('\n🔄 Testing Alternative Endpoints...');

    const alternatives = [
      { name: 'GraphRAG Root', url: 'https://graphrag.adverant.ai' },
      { name: 'API Gateway', url: 'https://api.adverant.ai/mageagent' },
      { name: 'K8s Ingress', url: 'https://k8s.adverant.ai/mageagent' }
    ];

    const results: any[] = [];

    for (const alt of alternatives) {
      try {
        console.log(`   Checking ${alt.name}: ${alt.url}`);
        const response = await axios.get(alt.url, {
          timeout: 5000,
          validateStatus: () => true
        });

        results.push({
          endpoint: alt.name,
          url: alt.url,
          reachable: response.status > 0,
          status: response.status || 'No response'
        });

      } catch (error) {
        results.push({
          endpoint: alt.name,
          url: alt.url,
          reachable: false,
          error: error instanceof Error ? error.message : 'Unknown error'
        });
      }
    }

    this.report.testResults.api.push({
      category: 'Alternative Endpoints',
      timestamp: new Date().toISOString(),
      results
    });

    this.report.summary.executed += alternatives.length;
  }

  /**
   * Generate curl commands for manual testing
   */
  private generateCurlCommands(): void {
    console.log('\n🛠️  Curl Commands for Manual Testing:');

    const commands = [
      {
        description: 'Health Check',
        command: `curl -v -X GET "${this.baseUrl}/health"`
      },
      {
        description: 'Orchestrate Task',
        command: `curl -v -X POST "${this.baseUrl}/api/orchestrate" \\
  -H "Content-Type: application/json" \\
  -d '{"task": "Test orchestration task", "options": {"agentCount": 3}}'`
      },
      {
        description: 'List Agents',
        command: `curl -v -X GET "${this.baseUrl}/api/agents"`
      },
      {
        description: 'WebSocket Test (using wscat)',
        command: `wscat -c "${this.wsUrl}"`
      }
    ];

    commands.forEach(cmd => {
      console.log(`\n   ${cmd.description}:`);
      console.log(`   ${cmd.command}`);
    });

    this.report.testResults.api.push({
      category: 'Manual Testing Commands',
      commands
    });
  }

  /**
   * Run API tests
   */
  private async runAPITests(): Promise<void> {
    console.log('\n🔧 Running API Tests...');

    // Test each endpoint
    const endpoints = [
      { method: 'GET', path: '/health', name: 'Health Check' },
      { method: 'GET', path: '/api/agents', name: 'List Agents' },
      { method: 'GET', path: '/api/websocket/stats', name: 'WebSocket Stats' },
      { method: 'POST', path: '/api/orchestrate', name: 'Orchestrate', data: { task: 'Test task' } },
      { method: 'POST', path: '/api/memory/search', name: 'Memory Search', data: { query: 'test' } }
    ];

    for (const endpoint of endpoints) {
      await this.testEndpoint(endpoint);
    }
  }

  /**
   * Test individual endpoint
   */
  private async testEndpoint(endpoint: any): Promise<void> {
    const startTime = Date.now();

    try {
      const config: any = {
        method: endpoint.method,
        url: endpoint.path,
        timeout: 10000
      };

      if (endpoint.data) {
        config.data = endpoint.data;
      }

      const response = await this.axiosInstance.request(config);
      const duration = Date.now() - startTime;

      const result = {
        endpoint: endpoint.name,
        method: endpoint.method,
        path: endpoint.path,
        status: response.status,
        success: response.status >= 200 && response.status < 300,
        duration,
        hasData: !!response.data,
        timestamp: new Date().toISOString()
      };

      this.report.testResults.api.push(result);

      if (result.success) {
        this.report.summary.passed++;
        console.log(`   ✅ ${endpoint.name}: ${response.status} (${duration}ms)`);
      } else {
        this.report.summary.failed++;
        console.log(`   ❌ ${endpoint.name}: ${response.status} (${duration}ms)`);
      }

    } catch (error) {
      this.report.summary.failed++;
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';

      console.log(`   ❌ ${endpoint.name}: ${errorMessage}`);

      this.report.testResults.api.push({
        endpoint: endpoint.name,
        method: endpoint.method,
        path: endpoint.path,
        success: false,
        error: errorMessage,
        timestamp: new Date().toISOString()
      });
    }

    this.report.summary.executed++;
  }

  /**
   * Run WebSocket tests
   */
  private async runWebSocketTests(): Promise<void> {
    console.log('\n🔌 Running WebSocket Tests...');

    // Test basic connection
    await this.testWebSocketConnection();

    // Test message exchange
    await this.testWebSocketMessages();
  }

  /**
   * Test WebSocket connection
   */
  private async testWebSocketConnection(): Promise<void> {
    return new Promise((resolve) => {
      const ws = new WebSocket(this.wsUrl);
      const startTime = Date.now();

      ws.on('open', () => {
        const duration = Date.now() - startTime;
        console.log(`   ✅ WebSocket connected (${duration}ms)`);

        this.report.testResults.websocket.push({
          test: 'Connection',
          success: true,
          duration
        });

        this.report.summary.passed++;
        ws.close();
      });

      ws.on('error', (error) => {
        console.log(`   ❌ WebSocket connection failed: ${error.message}`);

        this.report.testResults.websocket.push({
          test: 'Connection',
          success: false,
          error: error.message
        });

        this.report.summary.failed++;
      });

      ws.on('close', () => {
        resolve();
      });

      this.report.summary.executed++;
    });
  }

  /**
   * Test WebSocket message exchange
   */
  private async testWebSocketMessages(): Promise<void> {
    return new Promise((resolve) => {
      const ws = new WebSocket(this.wsUrl);
      let messageCount = 0;

      ws.on('open', () => {
        // Send test message
        ws.send(JSON.stringify({
          type: 'subscribe',
          data: { agentId: 'test-agent' }
        }));
      });

      ws.on('message', () => {
        messageCount++;
        console.log(`   📨 Received message #${messageCount}`);

        if (messageCount >= 1) {
          this.report.testResults.websocket.push({
            test: 'Message Exchange',
            success: true,
            messagesReceived: messageCount
          });

          this.report.summary.passed++;
          ws.close();
        }
      });

      ws.on('error', (error) => {
        this.report.testResults.websocket.push({
          test: 'Message Exchange',
          success: false,
          error: error.message
        });

        this.report.summary.failed++;
      });

      ws.on('close', () => {
        resolve();
      });

      this.report.summary.executed++;

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
   * Run performance tests
   */
  private async runPerformanceTests(): Promise<void> {
    console.log('\n⚡ Running Performance Tests...');

    const endpoints = [
      { path: '/health', requests: 10 },
      { path: '/api/agents', requests: 10 }
    ];

    for (const endpoint of endpoints) {
      const responseTimes: number[] = [];

      console.log(`   Testing ${endpoint.path} (${endpoint.requests} requests)...`);

      for (let i = 0; i < endpoint.requests; i++) {
        const startTime = Date.now();

        try {
          await this.axiosInstance.get(endpoint.path);
          responseTimes.push(Date.now() - startTime);
        } catch (error) {
          // Still record the time even if request failed
          responseTimes.push(Date.now() - startTime);
        }

        // Small delay between requests
        await new Promise(resolve => setTimeout(resolve, 100));
      }

      const stats = this.calculateStats(responseTimes);

      this.report.testResults.performance.push({
        endpoint: endpoint.path,
        requests: endpoint.requests,
        stats,
        timestamp: new Date().toISOString()
      });

      console.log(`   Average: ${stats.average.toFixed(2)}ms, Min: ${stats.min}ms, Max: ${stats.max}ms`);

      this.report.summary.executed += endpoint.requests;
    }
  }

  /**
   * Run security tests
   */
  private async runSecurityTests(): Promise<void> {
    console.log('\n🔒 Running Security Tests...');

    // Test security headers
    await this.testSecurityHeaders();

    // Test input validation
    await this.testInputValidation();
  }

  /**
   * Test security headers
   */
  private async testSecurityHeaders(): Promise<void> {
    try {
      const response = await this.axiosInstance.get('/health');
      const headers = response.headers;

      const securityHeaders = {
        'x-content-type-options': 'nosniff',
        'x-frame-options': 'DENY',
        'x-xss-protection': '1; mode=block',
        'strict-transport-security': 'max-age='
      };

      const results: any = {
        test: 'Security Headers',
        headers: {}
      };

      for (const [header, expected] of Object.entries(securityHeaders)) {
        const present = headers[header]?.includes(expected);
        results.headers[header] = present ? 'Present' : 'Missing';
      }

      this.report.testResults.security.push(results);
      console.log(`   Security headers check completed`);

    } catch (error) {
      this.report.testResults.security.push({
        test: 'Security Headers',
        error: error instanceof Error ? error.message : 'Unknown error'
      });
    }

    this.report.summary.executed++;
  }

  /**
   * Test input validation
   */
  private async testInputValidation(): Promise<void> {
    const invalidInputs = [
      { test: 'SQL Injection', data: { query: "'; DROP TABLE users; --" } },
      { test: 'XSS Attack', data: { task: '<script>alert("XSS")</script>' } },
      { test: 'Large Payload', data: { task: 'x'.repeat(10000) } }
    ];

    for (const input of invalidInputs) {
      try {
        const response = await this.axiosInstance.post('/api/orchestrate', input.data);

        this.report.testResults.security.push({
          test: input.test,
          rejected: response.status >= 400,
          status: response.status
        });

        console.log(`   ${input.test}: ${response.status >= 400 ? '✅ Rejected' : '⚠️ Accepted'}`);

      } catch (error) {
        this.report.testResults.security.push({
          test: input.test,
          error: error instanceof Error ? error.message : 'Unknown error'
        });
      }

      this.report.summary.executed++;
    }
  }

  /**
   * Calculate statistics
   */
  private calculateStats(times: number[]): any {
    if (times.length === 0) return { average: 0, min: 0, max: 0 };

    const sorted = times.sort((a, b) => a - b);
    const sum = sorted.reduce((a, b) => a + b, 0);

    return {
      average: sum / sorted.length,
      min: sorted[0],
      max: sorted[sorted.length - 1],
      p95: sorted[Math.floor(sorted.length * 0.95)] || sorted[sorted.length - 1],
      p99: sorted[Math.floor(sorted.length * 0.99)] || sorted[sorted.length - 1]
    };
  }

  /**
   * Generate recommendations based on test results
   */
  private generateRecommendations(): void {
    if (!this.report.summary.serviceAvailable) {
      this.report.recommendations.push(
        '🔴 Service is not accessible. Check deployment status and network configuration.',
        '🔧 Verify Kubernetes ingress configuration for mageagent service.',
        '🔍 Check if the service URL has changed or requires authentication.',
        '📡 Test connectivity from within the Kubernetes cluster.'
      );
    }

    if (this.report.summary.failed > this.report.summary.passed) {
      this.report.recommendations.push(
        '⚠️ More tests failed than passed. Review service health and logs.'
      );
    }

    if (this.report.testResults.security.some((r: any) => !r.rejected)) {
      this.report.recommendations.push(
        '🔒 Some invalid inputs were accepted. Strengthen input validation.'
      );
    }

    if (this.report.testResults.performance.some((r: any) => r.stats?.average > 2000)) {
      this.report.recommendations.push(
        '⚡ Some endpoints have slow response times (>2s). Consider optimization.'
      );
    }
  }

  /**
   * Save test report to file
   */
  private async saveReport(): Promise<void> {
    const reportDir = path.join(__dirname, '../../test-results');

    if (!fs.existsSync(reportDir)) {
      fs.mkdirSync(reportDir, { recursive: true });
    }

    const filename = `mageagent-functional-report-${this.testRunId}.json`;
    const filepath = path.join(reportDir, filename);

    fs.writeFileSync(filepath, JSON.stringify(this.report, null, 2));
    console.log(`\n📄 Report saved to: ${filepath}`);
  }

  /**
   * Display test report summary
   */
  private displayReport(): void {
    console.log('\n' + '='.repeat(80));
    console.log('📊 TEST REPORT SUMMARY');
    console.log('='.repeat(80));

    console.log(`\n🔍 Service Status: ${this.report.summary.serviceAvailable ? '✅ Available' : '❌ Unavailable'}`);
    console.log(`📍 Base URL: ${this.baseUrl}`);
    console.log(`⏱️  Duration: ${(this.report.testRun.duration / 1000).toFixed(2)}s`);

    console.log('\n📈 Test Results:');
    console.log(`   Total Tests: ${this.report.summary.totalTests}`);
    console.log(`   Executed: ${this.report.summary.executed}`);
    console.log(`   Passed: ${this.report.summary.passed} ✅`);
    console.log(`   Failed: ${this.report.summary.failed} ❌`);
    console.log(`   Skipped: ${this.report.summary.skipped} ⏭️`);

    if (this.report.summary.errors.length > 0) {
      console.log('\n❌ Errors:');
      this.report.summary.errors.forEach(error => {
        console.log(`   - ${error}`);
      });
    }

    console.log('\n💡 Recommendations:');
    this.report.recommendations.forEach(rec => {
      console.log(`   ${rec}`);
    });

    console.log('\n' + '='.repeat(80));
    console.log('✅ TEST EXECUTION COMPLETE');
    console.log('='.repeat(80));
  }
}

// Execute tests
async function main() {
  const tester = new EnhancedMageAgentTests();
  await tester.runTests();
}

main().catch(console.error);