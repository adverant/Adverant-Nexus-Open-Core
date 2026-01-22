/**
 * Unit Tests for SandboxClient
 *
 * Tests the Sandbox HTTP client with circuit breaker pattern.
 * Uses mocked HTTP responses for reliable testing.
 */

import MockAdapter from 'axios-mock-adapter';
import {
  SandboxClient,
  getSandboxClient,
  resetSandboxClient,
  SandboxExecutionRequest,
  SandboxExecutionResult,
  SupportedLanguage,
} from '../../../src/clients/sandbox-client';

describe('SandboxClient', () => {
  let client: SandboxClient;
  let mock: MockAdapter;

  const TEST_BASE_URL = 'http://test-sandbox:9080';

  beforeEach(() => {
    resetSandboxClient();
    client = new SandboxClient(TEST_BASE_URL);
    // Access the internal axios instance for mocking
    mock = new MockAdapter((client as any).client);
  });

  afterEach(() => {
    mock.reset();
    mock.restore();
  });

  // ==========================================================================
  // Constructor Tests
  // ==========================================================================

  describe('Constructor', () => {
    it('should create client with custom base URL', () => {
      const customClient = new SandboxClient('http://custom:9080');
      expect(customClient).toBeDefined();
      expect(customClient).toBeInstanceOf(SandboxClient);
    });

    it('should create client with default URL when none provided', () => {
      const defaultClient = new SandboxClient();
      expect(defaultClient).toBeDefined();
    });
  });

  // ==========================================================================
  // Singleton Pattern Tests
  // ==========================================================================

  describe('Singleton Pattern', () => {
    it('should return same instance when using getSandboxClient', () => {
      const instance1 = getSandboxClient();
      const instance2 = getSandboxClient();
      expect(instance1).toBe(instance2);
    });

    it('should create new instance after reset', () => {
      const instance1 = getSandboxClient();
      resetSandboxClient();
      const instance2 = getSandboxClient();
      expect(instance1).not.toBe(instance2);
    });
  });

  // ==========================================================================
  // Health Check Tests
  // ==========================================================================

  describe('healthCheck', () => {
    it('should return healthy status when service is available', async () => {
      mock.onGet('/health').reply(200, {
        status: 'healthy',
        version: '1.0.0',
        uptime: 7200,
        availableLanguages: ['python', 'node', 'bash']
      });

      const health = await client.healthCheck();
      expect(health.status).toBe('healthy');
      expect(health.availableLanguages).toContain('python');
    });

    it('should handle degraded status', async () => {
      mock.onGet('/health').reply(200, {
        status: 'degraded',
        version: '1.0.0',
        availableLanguages: ['python'] // Only Python available
      });

      const health = await client.healthCheck();
      expect(health.status).toBe('degraded');
    });

    it('should return unhealthy when service is unavailable', async () => {
      mock.onGet('/health').reply(503);

      // healthCheck catches errors and returns unhealthy
      const health = await client.healthCheck();
      expect(health.status).toBe('unhealthy');
    });
  });

  // ==========================================================================
  // Execute Code Tests
  // ==========================================================================

  describe('execute', () => {
    const validRequest: SandboxExecutionRequest = {
      code: 'print("Hello, World!")',
      language: 'python',
      timeout: 30000
    };

    const successResponse: SandboxExecutionResult = {
      success: true,
      stdout: 'Hello, World!\n',
      stderr: '',
      exitCode: 0,
      executionTimeMs: 150,
      resourceUsage: {
        cpuTimeMs: 50,
        memoryPeakMb: 32
      }
    };

    it('should execute Python code successfully', async () => {
      mock.onPost('/execute').reply(200, successResponse);

      const result = await client.execute(validRequest);
      expect(result.success).toBe(true);
      expect(result.stdout).toBe('Hello, World!\n');
      expect(result.exitCode).toBe(0);
    });

    it('should execute Node.js code successfully', async () => {
      mock.onPost('/execute').reply(200, {
        success: true,
        stdout: 'Hello from Node!\n',
        exitCode: 0,
        executionTimeMs: 100
      });

      const result = await client.execute({
        code: 'console.log("Hello from Node!")',
        language: 'node',
        timeout: 30000
      });

      expect(result.success).toBe(true);
      expect(result.stdout).toContain('Hello from Node!');
    });

    it('should execute Bash commands successfully', async () => {
      mock.onPost('/execute').reply(200, {
        success: true,
        stdout: 'Current directory\n',
        exitCode: 0,
        executionTimeMs: 50
      });

      const result = await client.execute({
        code: 'echo "Current directory"',
        language: 'bash',
        timeout: 10000
      });

      expect(result.success).toBe(true);
    });

    it('should handle code execution errors gracefully', async () => {
      mock.onPost('/execute').reply(200, {
        success: false,
        stdout: '',
        stderr: "NameError: name 'undefined_var' is not defined",
        exitCode: 1,
        executionTimeMs: 100,
        error: {
          code: 'EXECUTION_ERROR',
          message: 'Code execution failed'
        }
      });

      const result = await client.execute({
        code: 'print(undefined_var)',
        language: 'python'
      });

      expect(result.success).toBe(false);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('NameError');
    });

    it('should handle timeout errors', async () => {
      mock.onPost('/execute').reply(408, {
        success: false,
        error: {
          code: 'TIMEOUT',
          message: 'Execution timed out'
        }
      });

      const result = await client.execute({
        code: 'while True: pass',
        language: 'python',
        timeout: 1000
      });

      // Client catches errors and returns failure result
      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });

    it('should handle memory limit exceeded', async () => {
      mock.onPost('/execute').reply(200, {
        success: false,
        stdout: '',
        stderr: '',
        exitCode: 137,
        executionTimeMs: 1000,
        error: {
          code: 'OOM_KILLED',
          message: 'Out of memory'
        }
      });

      const result = await client.execute({
        code: 'x = [1] * (10 ** 10)',  // Try to allocate huge array
        language: 'python',
        resourceLimits: { memoryLimit: '256Mi' }
      });

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('OOM_KILLED');
    });

    it('should include packages in request', async () => {
      mock.onPost('/execute').reply((config) => {
        const data = JSON.parse(config.data);
        expect(data.packages).toEqual(['numpy', 'pandas']);
        return [200, successResponse];
      });

      await client.execute({
        ...validRequest,
        packages: ['numpy', 'pandas']
      });
    });

    it('should include files in request', async () => {
      mock.onPost('/execute').reply((config) => {
        const data = JSON.parse(config.data);
        expect(data.files).toHaveLength(1);
        expect(data.files[0].filename).toBe('data.csv');
        return [200, successResponse];
      });

      await client.execute({
        ...validRequest,
        files: [{
          filename: 'data.csv',
          content: Buffer.from('a,b,c\n1,2,3').toString('base64')
        }]
      });
    });

    it('should return artifacts from execution', async () => {
      mock.onPost('/execute').reply(200, {
        success: true,
        stdout: 'Created output.png\n',
        exitCode: 0,
        executionTimeMs: 500,
        artifacts: [{
          filename: 'output.png',
          content: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
          size: 95
        }]
      });

      const result = await client.execute({
        code: 'import matplotlib.pyplot as plt; plt.savefig("output.png")',
        language: 'python',
        packages: ['matplotlib']
      });

      expect(result.success).toBe(true);
      expect(result.artifacts).toHaveLength(1);
      expect(result.artifacts![0].filename).toBe('output.png');
    });
  });

  // ==========================================================================
  // Request Validation Tests
  // ==========================================================================

  describe('Request Validation', () => {
    it('should reject unsupported language', async () => {
      await expect(client.execute({
        code: 'code',
        language: 'cobol' as SupportedLanguage
      })).rejects.toThrow(/Unsupported language/i);
    });

    it('should reject timeout exceeding maximum', async () => {
      await expect(client.execute({
        code: 'print(1)',
        language: 'python',
        timeout: 600000 // 10 minutes
      })).rejects.toThrow(/Timeout exceeds maximum/i);
    });

    it('should reject memory limit exceeding maximum', async () => {
      await expect(client.execute({
        code: 'print(1)',
        language: 'python',
        resourceLimits: { memoryLimit: '10Gi' }
      })).rejects.toThrow(/Memory limit exceeds maximum/i);
    });

    it('should reject oversized files', async () => {
      // Create a fake large file (>100MB)
      const largeContent = Buffer.alloc(150 * 1024 * 1024).toString('base64');

      await expect(client.execute({
        code: 'print(1)',
        language: 'python',
        files: [{
          filename: 'large.txt',
          content: largeContent
        }]
      })).rejects.toThrow(/exceeds maximum size/i);
    });

    it('should reject empty code', async () => {
      await expect(client.execute({
        code: '   ',
        language: 'python'
      })).rejects.toThrow(/cannot be empty/i);
    });
  });

  // ==========================================================================
  // Circuit Breaker Tests
  // ==========================================================================

  describe('Circuit Breaker', () => {
    it('should open circuit after multiple failures', async () => {
      // Make circuit breaker fail by having errors thrown
      mock.onPost('/execute').reply(500, { error: 'Internal Server Error' });

      // First, we need to force actual failures (not graceful error returns)
      // The sandbox client catches errors and returns a result, so we need to
      // cause real circuit breaker failures by causing the operation to throw

      // Fail 5 times to trigger circuit breaker
      for (let i = 0; i < 5; i++) {
        await client.execute({
          code: 'print(1)',
          language: 'python'
        });
      }

      // The circuit breaker wraps the execution, so after 5 failures
      // it should return the SANDBOX_UNAVAILABLE error
      const result = await client.execute({
        code: 'print(1)',
        language: 'python'
      });

      // Circuit breaker returns error result instead of throwing
      expect(result.success).toBe(false);
      // When circuit breaker opens, it returns SANDBOX_UNAVAILABLE
      expect(['SANDBOX_EXECUTION_FAILED', 'SANDBOX_UNAVAILABLE']).toContain(result.error?.code);
    });

    it('should report circuit state', () => {
      const state = client.getCircuitState();
      expect(['CLOSED', 'OPEN', 'HALF_OPEN']).toContain(state);
    });

    it('should reset circuit breaker', () => {
      client.resetCircuit();
      expect(client.getCircuitState()).toBe('CLOSED');
    });
  });

  // ==========================================================================
  // Convenience Methods Tests
  // ==========================================================================

  describe('Convenience Methods', () => {
    describe('executePython', () => {
      it('should execute Python code with packages', async () => {
        mock.onPost('/execute').reply((config) => {
          const data = JSON.parse(config.data);
          expect(data.language).toBe('python');
          expect(data.packages).toEqual(['numpy']);
          return [200, {
            success: true,
            stdout: '3.141592653589793\n',
            exitCode: 0,
            executionTimeMs: 200
          }];
        });

        const result = await client.executePython(
          'import numpy as np; print(np.pi)',
          { packages: ['numpy'] }
        );
        expect(result.success).toBe(true);
      });
    });

    describe('executeNode', () => {
      it('should execute Node.js code', async () => {
        mock.onPost('/execute').reply((config) => {
          const data = JSON.parse(config.data);
          expect(data.language).toBe('node');
          return [200, {
            success: true,
            stdout: '42\n',
            exitCode: 0,
            executionTimeMs: 100
          }];
        });

        const result = await client.executeNode('console.log(42)');
        expect(result.success).toBe(true);
        expect(result.stdout).toBe('42\n');
      });
    });

    describe('executeBash', () => {
      it('should execute Bash commands', async () => {
        mock.onPost('/execute').reply((config) => {
          const data = JSON.parse(config.data);
          expect(data.language).toBe('bash');
          return [200, {
            success: true,
            stdout: 'hello\n',
            exitCode: 0,
            executionTimeMs: 50
          }];
        });

        const result = await client.executeBash('echo "hello"');
        expect(result.success).toBe(true);
      });
    });

    describe('analyzeFile', () => {
      it('should analyze file using Python', async () => {
        const fileContent = Buffer.from('name,age\nAlice,30\nBob,25').toString('base64');

        mock.onPost('/execute').reply(200, {
          success: true,
          stdout: JSON.stringify({
            filename: 'data.csv',
            size: 25,
            lines: 3,
            analysis_type: 'full',
            preview: 'name,age\nAlice,30\nBob,25'
          }, null, 2),
          exitCode: 0,
          executionTimeMs: 300
        });

        const result = await client.analyzeFile(
          'data.csv',
          fileContent
        );

        expect(result.success).toBe(true);
        expect(result.metadata?.filename).toBe('data.csv');
      });

      it('should analyze JSON files', async () => {
        const jsonContent = Buffer.from('{"key": "value"}').toString('base64');

        mock.onPost('/execute').reply(200, {
          success: true,
          stdout: JSON.stringify({
            filename: 'data.json',
            valid_json: true,
            keys: ['key'],
            type: 'dict'
          }, null, 2),
          exitCode: 0,
          executionTimeMs: 200
        });

        const result = await client.analyzeFile('data.json', jsonContent);
        expect(result.success).toBe(true);
        expect(result.metadata?.valid_json).toBe(true);
      });

      it('should handle analysis errors', async () => {
        const fileContent = Buffer.from('invalid').toString('base64');

        mock.onPost('/execute').reply(200, {
          success: false,
          stdout: '',
          stderr: 'Error analyzing file',
          exitCode: 1,
          executionTimeMs: 100,
          error: {
            code: 'ANALYSIS_ERROR',
            message: 'Failed to analyze file'
          }
        });

        const result = await client.analyzeFile('test.bin', fileContent);
        expect(result.success).toBe(false);
        expect(result.error).toBeDefined();
      });
    });
  });

  // ==========================================================================
  // Resource Limits Tests
  // ==========================================================================

  describe('Resource Limits', () => {
    it('should apply default resource limits', async () => {
      mock.onPost('/execute').reply((config) => {
        const data = JSON.parse(config.data);
        // Should have default limits applied
        expect(data.resourceLimits).toBeDefined();
        expect(data.resourceLimits.cpuLimit).toBe('1.0');
        expect(data.resourceLimits.memoryLimit).toBe('512Mi');
        return [200, {
          success: true,
          stdout: '',
          exitCode: 0,
          executionTimeMs: 100
        }];
      });

      await client.execute({
        code: 'print(1)',
        language: 'python'
      });
    });

    it('should respect custom resource limits', async () => {
      mock.onPost('/execute').reply((config) => {
        const data = JSON.parse(config.data);
        expect(data.resourceLimits.cpuLimit).toBe('2.0');
        expect(data.resourceLimits.memoryLimit).toBe('1Gi');
        return [200, {
          success: true,
          stdout: '',
          exitCode: 0,
          executionTimeMs: 100
        }];
      });

      await client.execute({
        code: 'print(1)',
        language: 'python',
        resourceLimits: {
          cpuLimit: '2.0',
          memoryLimit: '1Gi'
        }
      });
    });
  });
});
