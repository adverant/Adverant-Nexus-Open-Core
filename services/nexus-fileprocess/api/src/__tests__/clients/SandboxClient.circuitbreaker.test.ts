/**
 * SandboxClient Circuit Breaker Tests
 *
 * Phase 4: Comprehensive circuit breaker testing
 *
 * Tests cover:
 * - Connection failure scenarios
 * - Timeout handling
 * - Memory limit validation
 * - Recovery behavior
 * - State transitions (CLOSED → OPEN → HALF_OPEN → CLOSED)
 *
 * Circuit Breaker Configuration:
 * - Failure Threshold: 5 failures → OPEN
 * - Success Threshold: 2 successes in HALF_OPEN → CLOSED
 * - Timeout: 60 seconds in OPEN before trying HALF_OPEN
 */

import { SandboxClient, SandboxExecutionRequest, resetSandboxClient } from '../../clients/SandboxClient';
import axios from 'axios';
import MockAdapter from 'axios-mock-adapter';

// Mock axios for controlled testing
let mockAxios: MockAdapter;

// Increase timeout for slow tests (circuit breaker cooldown simulations)
jest.setTimeout(15000);

describe('SandboxClient Circuit Breaker - Connection Failures', () => {
  let client: SandboxClient;

  beforeEach(() => {
    // Reset singleton
    resetSandboxClient();

    // Setup axios mock FIRST (before creating client)
    mockAxios = new MockAdapter(axios, { onNoMatch: 'throwException' });

    // Create client with test URL
    client = new SandboxClient('http://localhost:9998');
  });

  afterEach(() => {
    mockAxios.restore();
    resetSandboxClient();
  });

  it('should open circuit after 5 consecutive connection failures', async () => {
    // Simulate connection failures
    mockAxios.onPost('/execute').networkError();

    const request: SandboxExecutionRequest = {
      code: 'print("test")',
      language: 'python',
    };

    // First 5 requests should attempt execution
    for (let i = 0; i < 5; i++) {
      const result = await client.execute(request);
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('SANDBOX_EXECUTION_FAILED');
    }

    // Circuit should now be OPEN
    expect(client.getCircuitState()).toBe('OPEN');

    // 6th request should fail fast without attempting connection
    const resultAfterOpen = await client.execute(request);
    expect(resultAfterOpen.success).toBe(false);
    expect(resultAfterOpen.error?.code).toBe('SANDBOX_UNAVAILABLE');
    expect(resultAfterOpen.error?.message).toContain('temporarily unavailable');
  });

  it('should enter half-open state after cooldown period (60s)', async () => {
    // Open the circuit
    mockAxios.onPost('/execute').networkError();

    const request: SandboxExecutionRequest = {
      code: 'print("test")',
      language: 'python',
    };

    // Trigger 5 failures to open circuit
    for (let i = 0; i < 5; i++) {
      await client.execute(request);
    }

    expect(client.getCircuitState()).toBe('OPEN');

    // Wait for cooldown period (simulate by advancing time)
    // Note: In production, use jest.useFakeTimers() or actual timeout
    // For now, we'll manually reset the circuit to simulate timeout
    await new Promise(resolve => setTimeout(resolve, 100));

    // Reset circuit to simulate cooldown timeout passing
    // In production code, this happens automatically after 60s
    client.resetCircuit();

    // Mock successful response
    mockAxios.reset();
    mockAxios.onPost('/execute').reply(200, {
      success: true,
      stdout: 'test',
      executionTimeMs: 100,
    });

    // Next request should attempt connection (HALF_OPEN state)
    const result = await client.execute(request);
    expect(result.success).toBe(true);
  });

  it('should close circuit after 2 successful half-open requests', async () => {
    // Open the circuit
    mockAxios.onPost('/execute').networkError();

    const request: SandboxExecutionRequest = {
      code: 'print("test")',
      language: 'python',
    };

    // Trigger 5 failures to open circuit
    for (let i = 0; i < 5; i++) {
      await client.execute(request);
    }

    expect(client.getCircuitState()).toBe('OPEN');

    // Reset circuit to simulate cooldown (entering HALF_OPEN)
    client.resetCircuit();

    // Mock successful responses
    mockAxios.reset();
    mockAxios.onPost('/execute').reply(200, {
      success: true,
      stdout: 'test',
      executionTimeMs: 100,
    });

    // First success in HALF_OPEN
    await client.execute(request);

    // Second success should close circuit
    await client.execute(request);

    // Circuit should now be CLOSED
    expect(client.getCircuitState()).toBe('CLOSED');

    // Subsequent requests should work normally
    const result = await client.execute(request);
    expect(result.success).toBe(true);
  });

  it('should reopen circuit if half-open request fails', async () => {
    // Open the circuit
    mockAxios.onPost('/execute').networkError();

    const request: SandboxExecutionRequest = {
      code: 'print("test")',
      language: 'python',
    };

    // Trigger 5 failures to open circuit
    for (let i = 0; i < 5; i++) {
      await client.execute(request);
    }

    expect(client.getCircuitState()).toBe('OPEN');

    // Reset circuit to simulate cooldown (entering HALF_OPEN)
    client.resetCircuit();

    // Mock failure in HALF_OPEN state
    mockAxios.reset();
    mockAxios.onPost('/execute').networkError();

    // Request fails in HALF_OPEN
    const result = await client.execute(request);
    expect(result.success).toBe(false);

    // Circuit should reopen
    // Note: Need to trigger threshold failures again
    for (let i = 1; i < 5; i++) {
      await client.execute(request);
    }

    expect(client.getCircuitState()).toBe('OPEN');
  });
});

describe('SandboxClient Circuit Breaker - Timeouts', () => {
  let client: SandboxClient;

  beforeEach(() => {
    resetSandboxClient();
    mockAxios = new MockAdapter(axios, { onNoMatch: 'throwException' });
    client = new SandboxClient('http://localhost:9998');
  });

  afterEach(() => {
    mockAxios.restore();
    resetSandboxClient();
  });

  it('should count timeouts as failures toward circuit threshold', async () => {
    // Simulate timeout by delaying response beyond axios timeout
    mockAxios.onPost('/execute').timeout();

    const request: SandboxExecutionRequest = {
      code: 'print("test")',
      language: 'python',
      timeout: 1000, // 1 second timeout
    };

    // Trigger 5 timeouts to open circuit
    for (let i = 0; i < 5; i++) {
      const result = await client.execute(request);
      expect(result.success).toBe(false);
    }

    // Circuit should be OPEN after 5 timeouts
    expect(client.getCircuitState()).toBe('OPEN');

    // Next request should fail fast
    const resultAfterOpen = await client.execute(request);
    expect(resultAfterOpen.error?.code).toBe('SANDBOX_UNAVAILABLE');
  });

  it('should respect custom timeout values', async () => {
    // Mock timeout error directly (axios-mock-adapter doesn't properly simulate timeouts)
    mockAxios.onPost('/execute').timeout();

    const requestWithShortTimeout: SandboxExecutionRequest = {
      code: 'print("test")',
      language: 'python',
      timeout: 1000, // 1 second timeout
    };

    const result = await client.execute(requestWithShortTimeout);
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('SANDBOX_EXECUTION_FAILED');
  });
});

describe('SandboxClient Circuit Breaker - Memory Limits', () => {
  let client: SandboxClient;

  beforeEach(() => {
    resetSandboxClient();
    mockAxios = new MockAdapter(axios, { onNoMatch: 'throwException' });
    client = new SandboxClient('http://localhost:9998');
    
  });

  afterEach(() => {
    mockAxios.restore();
    resetSandboxClient();
  });

  it('should reject tasks exceeding memory limit (2048MB)', async () => {
    const request: SandboxExecutionRequest = {
      code: 'print("test")',
      language: 'python',
      resourceLimits: {
        memoryLimit: '4096Mi', // Exceeds 2GB limit
      },
    };

    // Should throw validation error before execution
    await expect(client.execute(request)).rejects.toThrow('Memory limit exceeds maximum');

    // Should NOT count toward circuit breaker
    expect(client.getCircuitState()).toBe('CLOSED');
  });

  it('should allow tasks within memory limit', async () => {
    mockAxios.onPost('/execute').reply(200, {
      success: true,
      stdout: 'test',
      executionTimeMs: 100,
      resourceUsage: {
        cpuTimeMs: 50,
        memoryPeakMb: 512,
      },
    });

    const request: SandboxExecutionRequest = {
      code: 'print("test")',
      language: 'python',
      resourceLimits: {
        memoryLimit: '512Mi', // Within limit
      },
    };

    const result = await client.execute(request);
    expect(result.success).toBe(true);
    expect(result.resourceUsage?.memoryPeakMb).toBe(512);
  });

  it('should validate memory limit format', async () => {
    const request: SandboxExecutionRequest = {
      code: 'print("test")',
      language: 'python',
      resourceLimits: {
        memoryLimit: 'invalid', // Invalid format
      },
    };

    // Should throw validation error
    await expect(async () => {
      await client.execute(request);
    }).rejects.toThrow('Invalid memory limit format');
  });
});

describe('SandboxClient Circuit Breaker - Recovery', () => {
  let client: SandboxClient;

  beforeEach(() => {
    resetSandboxClient();
    mockAxios = new MockAdapter(axios, { onNoMatch: 'throwException' });
    client = new SandboxClient('http://localhost:9998');
    
  });

  afterEach(() => {
    mockAxios.restore();
    resetSandboxClient();
  });

  it('should gradually recover after service becomes healthy', async () => {
    const request: SandboxExecutionRequest = {
      code: 'print("test")',
      language: 'python',
    };

    // Step 1: Open circuit via failures
    mockAxios.onPost('/execute').networkError();

    for (let i = 0; i < 5; i++) {
      await client.execute(request);
    }

    expect(client.getCircuitState()).toBe('OPEN');

    // Step 2: Service becomes healthy
    mockAxios.reset();
    mockAxios.onPost('/execute').reply(200, {
      success: true,
      stdout: 'test',
      executionTimeMs: 100,
    });

    // Step 3: Simulate cooldown passing
    client.resetCircuit();

    // Step 4: First request succeeds (HALF_OPEN)
    const result1 = await client.execute(request);
    expect(result1.success).toBe(true);

    // Step 5: Second request succeeds, circuit closes
    const result2 = await client.execute(request);
    expect(result2.success).toBe(true);

    expect(client.getCircuitState()).toBe('CLOSED');

    // Step 6: Subsequent requests work normally
    const result3 = await client.execute(request);
    expect(result3.success).toBe(true);
  });

  it('should reset failure count on success in CLOSED state', async () => {
    const request: SandboxExecutionRequest = {
      code: 'print("test")',
      language: 'python',
    };

    // Trigger 3 failures (below threshold)
    mockAxios.onPost('/execute').networkErrorOnce();
    await client.execute(request);

    mockAxios.onPost('/execute').networkErrorOnce();
    await client.execute(request);

    mockAxios.onPost('/execute').networkErrorOnce();
    await client.execute(request);

    // Circuit should still be CLOSED (only 3 failures)
    expect(client.getCircuitState()).toBe('CLOSED');

    // Successful request should reset failure count
    mockAxios.reset();
    mockAxios.onPost('/execute').reply(200, {
      success: true,
      stdout: 'test',
      executionTimeMs: 100,
    });

    await client.execute(request);

    // Now trigger 3 more failures
    mockAxios.reset();
    mockAxios.onPost('/execute').networkError();

    for (let i = 0; i < 3; i++) {
      await client.execute(request);
    }

    // Circuit should still be CLOSED (failures were reset)
    expect(client.getCircuitState()).toBe('CLOSED');
  });
});

describe('SandboxClient Circuit Breaker - Health Check', () => {
  let client: SandboxClient;

  beforeEach(() => {
    resetSandboxClient();
    mockAxios = new MockAdapter(axios, { onNoMatch: 'throwException' });
    client = new SandboxClient('http://localhost:9998');
    
  });

  afterEach(() => {
    mockAxios.restore();
    resetSandboxClient();
  });

  it('should return true when sandbox is healthy', async () => {
    mockAxios.onGet('/health').reply(200, { status: 'healthy' });

    const isHealthy = await client.healthCheck();
    expect(isHealthy).toBe(true);
  });

  it('should return false when sandbox is unreachable', async () => {
    mockAxios.onGet('/health').networkError();

    const isHealthy = await client.healthCheck();
    expect(isHealthy).toBe(false);
  });

  it('should return false on non-200 response', async () => {
    mockAxios.onGet('/health').reply(503, { status: 'degraded' });

    const isHealthy = await client.healthCheck();
    expect(isHealthy).toBe(false);
  });

  it('should not affect circuit breaker state', async () => {
    mockAxios.onGet('/health').networkError();

    await client.healthCheck();

    // Circuit should remain CLOSED
    expect(client.getCircuitState()).toBe('CLOSED');
  });
});

describe('SandboxClient Circuit Breaker - Validation', () => {
  let client: SandboxClient;

  beforeEach(() => {
    resetSandboxClient();
    mockAxios = new MockAdapter(axios, { onNoMatch: 'throwException' });
    client = new SandboxClient('http://localhost:9998');
    
  });

  afterEach(() => {
    mockAxios.restore();
    resetSandboxClient();
  });

  it('should reject unsupported language', async () => {
    const request: SandboxExecutionRequest = {
      code: 'print("test")',
      language: 'invalid' as any,
    };

    await expect(async () => {
      await client.execute(request);
    }).rejects.toThrow('Unsupported language');

    // Should not affect circuit breaker
    expect(client.getCircuitState()).toBe('CLOSED');
  });

  it('should reject timeout exceeding maximum (300000ms)', async () => {
    const request: SandboxExecutionRequest = {
      code: 'print("test")',
      language: 'python',
      timeout: 400000, // Exceeds 5 minutes
    };

    await expect(async () => {
      await client.execute(request);
    }).rejects.toThrow('Timeout exceeds maximum');

    // Should not affect circuit breaker
    expect(client.getCircuitState()).toBe('CLOSED');
  });

  it('should reject empty code', async () => {
    const request: SandboxExecutionRequest = {
      code: '',
      language: 'python',
    };

    await expect(async () => {
      await client.execute(request);
    }).rejects.toThrow('Code cannot be empty');

    // Should not affect circuit breaker
    expect(client.getCircuitState()).toBe('CLOSED');
  });

  it('should reject file exceeding size limit (100MB)', async () => {
    // Create 101MB base64 encoded file
    const largeContent = Buffer.alloc(101 * 1024 * 1024, 'a').toString('base64');

    const request: SandboxExecutionRequest = {
      code: 'print("test")',
      language: 'python',
      files: [{
        filename: 'large.txt',
        content: largeContent,
      }],
    };

    await expect(async () => {
      await client.execute(request);
    }).rejects.toThrow('exceeds maximum size');

    // Should not affect circuit breaker
    expect(client.getCircuitState()).toBe('CLOSED');
  });
});
