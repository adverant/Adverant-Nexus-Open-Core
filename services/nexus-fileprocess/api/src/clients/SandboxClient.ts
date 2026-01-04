/**
 * SandboxClient - Direct integration with Nexus Sandbox service
 *
 * Design Pattern: Facade Pattern + Circuit Breaker
 * SOLID Principles:
 * - Single Responsibility: Only handles sandbox communication
 * - Dependency Inversion: Depends on interfaces, not implementations
 *
 * Root Cause Addressed: Issue #5 - Incomplete sandbox integration
 *
 * This provides FileProcessAgent with direct control over sandbox execution,
 * decoupling from MageAgent's UniversalTaskExecutor.
 */

import axios, { AxiosInstance, AxiosError } from 'axios';
import axiosRetry from 'axios-retry';
import { logger } from '../utils/logger';
import { config } from '../config';
import {
  recordCircuitBreakerState,
  recordCircuitBreakerTransition,
  recordCircuitBreakerFailure,
  recordCircuitBreakerSuccess,
  recordSandboxExecution,
} from '../utils/metrics';

/**
 * Sandbox execution request
 */
export interface SandboxExecutionRequest {
  code: string;
  language: 'python' | 'node' | 'go' | 'rust' | 'java' | 'bash';
  packages?: string[];
  files?: Array<{
    filename: string;
    content: string; // base64
  }>;
  timeout?: number; // milliseconds (max 300000 = 5 minutes)
  resourceLimits?: {
    cpuLimit?: string; // e.g., '1.0' (1 CPU core)
    memoryLimit?: string; // e.g., '512Mi'
    gpuEnabled?: boolean;
  };
  metadata?: Record<string, unknown>;
}

/**
 * Sandbox execution result
 */
export interface SandboxExecutionResult {
  success: boolean;
  stdout?: string;
  stderr?: string;
  exitCode?: number;
  executionTimeMs: number;
  resourceUsage?: {
    cpuTimeMs: number;
    memoryPeakMb: number;
  };
  artifacts?: Array<{
    filename: string;
    content: string; // base64
    size: number;
  }>;
  error?: {
    code: string;
    message: string;
    details?: string;
  };
}

/**
 * Circuit breaker states
 */
enum CircuitState {
  CLOSED = 'CLOSED', // Normal operation
  OPEN = 'OPEN', // Failing, reject immediately
  HALF_OPEN = 'HALF_OPEN', // Testing if recovered
}

/**
 * Circuit breaker configuration
 */
interface CircuitBreakerConfig {
  failureThreshold: number; // Open after N failures
  successThreshold: number; // Close after N successes in HALF_OPEN
  timeout: number; // Time in OPEN state before trying HALF_OPEN (ms)
}

/**
 * Circuit breaker implementation
 */
class CircuitBreaker {
  private state: CircuitState = CircuitState.CLOSED;
  private failureCount = 0;
  private successCount = 0;
  private lastFailureTime?: Date;
  private readonly circuitName = 'sandbox';

  constructor(private config: CircuitBreakerConfig) {
    // Initialize metrics
    recordCircuitBreakerState(this.circuitName, this.state);
  }

  async execute<T>(operation: () => Promise<T>): Promise<T> {
    if (this.state === CircuitState.OPEN) {
      // Check if timeout has passed
      if (
        this.lastFailureTime &&
        Date.now() - this.lastFailureTime.getTime() > this.config.timeout
      ) {
        logger.info('Circuit breaker entering HALF_OPEN state');
        const oldState = this.state;
        this.state = CircuitState.HALF_OPEN;
        this.successCount = 0;

        // Record state transition
        recordCircuitBreakerTransition(this.circuitName, oldState, this.state);
        recordCircuitBreakerState(this.circuitName, this.state);
      } else {
        throw new Error(
          `Circuit breaker OPEN - sandbox unavailable (last failure: ${this.lastFailureTime?.toISOString()})`
        );
      }
    }

    try {
      const result = await operation();

      // Record success
      recordCircuitBreakerSuccess(this.circuitName);

      if (this.state === CircuitState.HALF_OPEN) {
        this.successCount++;

        if (this.successCount >= this.config.successThreshold) {
          logger.info('Circuit breaker closing - sandbox recovered');
          const oldState = this.state;
          this.state = CircuitState.CLOSED;
          this.failureCount = 0;

          // Record state transition
          recordCircuitBreakerTransition(this.circuitName, oldState, this.state);
          recordCircuitBreakerState(this.circuitName, this.state);
        }
      } else {
        this.failureCount = 0; // Reset on success in CLOSED state
      }

      return result;
    } catch (error) {
      // Record failure
      this.failureCount++;
      this.lastFailureTime = new Date();

      const errorType = error instanceof Error ? error.name : 'UnknownError';
      recordCircuitBreakerFailure(this.circuitName, errorType);

      if (this.failureCount >= this.config.failureThreshold) {
        logger.warn('Circuit breaker opening - sandbox failing', {
          failureCount: this.failureCount,
          threshold: this.config.failureThreshold,
        });
        const oldState = this.state;
        this.state = CircuitState.OPEN;

        // Record state transition
        recordCircuitBreakerTransition(this.circuitName, oldState, this.state);
        recordCircuitBreakerState(this.circuitName, this.state);
      }

      throw error;
    }
  }

  getState(): CircuitState {
    return this.state;
  }

  reset(): void {
    this.state = CircuitState.CLOSED;
    this.failureCount = 0;
    this.successCount = 0;
  }
}

/**
 * SandboxClient - Facade for Nexus Sandbox service
 *
 * Provides:
 * - Direct HTTP communication with sandbox
 * - Automatic retries with exponential backoff
 * - Circuit breaker for fail-fast behavior
 * - Safety limits validation
 * - Connection pooling (via axios)
 * - Complete error handling
 */
export class SandboxClient {
  private client: AxiosInstance;
  private circuitBreaker: CircuitBreaker;
  private baseUrl: string;

  // Safety limits (configured from environment or defaults)
  private readonly MAX_TIMEOUT_MS = 300000; // 5 minutes
  private readonly MAX_MEMORY_MB = 2048; // 2GB
  private readonly MAX_FILE_SIZE_MB = 100; // 100MB
  private readonly ALLOWED_LANGUAGES = [
    'python',
    'node',
    'go',
    'rust',
    'java',
    'bash',
  ];

  constructor(baseUrl?: string) {
    this.baseUrl = baseUrl || config.sandboxUrl;

    // Create axios client with connection pooling
    this.client = axios.create({
      baseURL: this.baseUrl,
      timeout: this.MAX_TIMEOUT_MS,
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'FileProcessAgent/1.0',
      },
      // Connection pooling configuration
      httpAgent: new (require('http').Agent)({
        keepAlive: true,
        maxSockets: 50,
      }),
      httpsAgent: new (require('https').Agent)({
        keepAlive: true,
        maxSockets: 50,
      }),
    });

    // Configure automatic retries with exponential backoff
    axiosRetry(this.client, {
      retries: 3,
      retryDelay: axiosRetry.exponentialDelay,
      retryCondition: (error: AxiosError) => {
        // Retry on network errors or 5xx server errors
        return (
          axiosRetry.isNetworkOrIdempotentRequestError(error) ||
          (error.response?.status ? error.response.status >= 500 : false)
        );
      },
      onRetry: (retryCount, error) => {
        logger.warn('Retrying sandbox request', {
          retryCount,
          error: error.message,
        });
      },
    });

    // Initialize circuit breaker
    this.circuitBreaker = new CircuitBreaker({
      failureThreshold: 5, // Open after 5 failures
      successThreshold: 2, // Close after 2 successes in HALF_OPEN
      timeout: 60000, // 1 minute in OPEN state
    });

    logger.info('SandboxClient initialized', {
      baseUrl: this.baseUrl,
      maxTimeout: `${this.MAX_TIMEOUT_MS}ms`,
      maxMemory: `${this.MAX_MEMORY_MB}MB`,
    });
  }

  /**
   * Execute code in sandbox
   *
   * @param request - Execution request with code, language, packages, files
   * @returns Execution result with stdout, stderr, artifacts
   *
   * Throws:
   * - Error if circuit breaker is OPEN
   * - Error if validation fails
   * - Error if sandbox returns error
   */
  async execute(
    request: SandboxExecutionRequest
  ): Promise<SandboxExecutionResult> {
    const startTime = Date.now();

    // Validate request
    this.validateRequest(request);

    logger.info('Executing code in sandbox', {
      language: request.language,
      packages: request.packages?.length || 0,
      files: request.files?.length || 0,
      timeout: request.timeout,
    });

    // Execute with circuit breaker
    try {
      const result = await this.circuitBreaker.execute(async () => {
        const response = await this.client.post<SandboxExecutionResult>(
          '/execute',
          {
            code: request.code,
            language: request.language,
            packages: request.packages,
            files: request.files,
            timeout: request.timeout || 60000, // Default 1 minute
            resourceLimits: request.resourceLimits || {
              cpuLimit: '1.0',
              memoryLimit: '512Mi',
              gpuEnabled: false,
            },
            metadata: request.metadata,
          },
          {
            timeout: request.timeout || 60000,
          }
        );

        return response.data;
      });

      const executionTimeMs = Date.now() - startTime;

      logger.info('Sandbox execution completed', {
        success: result.success,
        executionTimeMs,
        exitCode: result.exitCode,
        artifacts: result.artifacts?.length || 0,
      });

      // Record metrics
      recordSandboxExecution(
        request.language,
        result.success,
        executionTimeMs / 1000, // Convert to seconds
        result.resourceUsage?.cpuTimeMs,
        result.resourceUsage?.memoryPeakMb
      );

      return {
        ...result,
        executionTimeMs,
      };
    } catch (error) {
      const executionTimeMs = Date.now() - startTime;

      if (error instanceof Error && error.message.includes('Circuit breaker')) {
        logger.error('Sandbox circuit breaker OPEN', {
          error: error.message,
          executionTimeMs,
        });

        return {
          success: false,
          executionTimeMs,
          error: {
            code: 'SANDBOX_UNAVAILABLE',
            message: 'Sandbox service is temporarily unavailable',
            details: error.message,
          },
        };
      }

      const errorMessage =
        error instanceof Error ? error.message : String(error);
      const axiosError = error as AxiosError;

      logger.error('Sandbox execution failed', {
        error: errorMessage,
        status: axiosError.response?.status,
        executionTimeMs,
      });

      return {
        success: false,
        executionTimeMs,
        error: {
          code: 'SANDBOX_EXECUTION_FAILED',
          message: 'Failed to execute code in sandbox',
          details: errorMessage,
        },
      };
    }
  }

  /**
   * Health check - verify sandbox is available
   */
  async healthCheck(): Promise<boolean> {
    try {
      const response = await this.client.get('/health', {
        timeout: 5000,
      });

      return response.status === 200;
    } catch (error) {
      logger.warn('Sandbox health check failed', {
        error: error instanceof Error ? error.message : String(error),
      });

      return false;
    }
  }

  /**
   * Get circuit breaker state
   */
  getCircuitState(): CircuitState {
    return this.circuitBreaker.getState();
  }

  /**
   * Reset circuit breaker (for testing or manual recovery)
   */
  resetCircuit(): void {
    this.circuitBreaker.reset();
    logger.info('Circuit breaker manually reset');
  }

  /**
   * Validate execution request
   */
  private validateRequest(request: SandboxExecutionRequest): void {
    // Validate language
    if (!this.ALLOWED_LANGUAGES.includes(request.language)) {
      throw new Error(
        `Unsupported language: ${request.language}. Supported: ${this.ALLOWED_LANGUAGES.join(', ')}`
      );
    }

    // Validate timeout
    if (request.timeout && request.timeout > this.MAX_TIMEOUT_MS) {
      throw new Error(
        `Timeout exceeds maximum: ${request.timeout}ms > ${this.MAX_TIMEOUT_MS}ms`
      );
    }

    // Validate memory limit
    if (request.resourceLimits?.memoryLimit) {
      const memoryMb = this.parseMemoryLimit(request.resourceLimits.memoryLimit);
      if (memoryMb > this.MAX_MEMORY_MB) {
        throw new Error(
          `Memory limit exceeds maximum: ${memoryMb}MB > ${this.MAX_MEMORY_MB}MB`
        );
      }
    }

    // Validate file sizes
    if (request.files) {
      for (const file of request.files) {
        const sizeBytes = Buffer.from(file.content, 'base64').length;
        const sizeMb = sizeBytes / 1024 / 1024;

        if (sizeMb > this.MAX_FILE_SIZE_MB) {
          throw new Error(
            `File ${file.filename} exceeds maximum size: ${sizeMb.toFixed(2)}MB > ${this.MAX_FILE_SIZE_MB}MB`
          );
        }
      }
    }

    // Validate code is not empty
    if (!request.code || request.code.trim().length === 0) {
      throw new Error('Code cannot be empty');
    }
  }

  /**
   * Parse memory limit string (e.g., "512Mi", "1Gi") to MB
   */
  private parseMemoryLimit(limit: string): number {
    const match = limit.match(/^(\d+)(Mi|Gi)$/);

    if (!match) {
      throw new Error(`Invalid memory limit format: ${limit}`);
    }

    const value = parseInt(match[1], 10);
    const unit = match[2];

    if (unit === 'Mi') {
      return value;
    } else if (unit === 'Gi') {
      return value * 1024;
    }

    throw new Error(`Unknown memory unit: ${unit}`);
  }
}

/**
 * Singleton instance for dependency injection
 */
let sandboxClientInstance: SandboxClient | null = null;

export function getSandboxClient(): SandboxClient {
  if (!sandboxClientInstance) {
    sandboxClientInstance = new SandboxClient();
  }

  return sandboxClientInstance;
}

/**
 * Reset sandbox client (for testing)
 */
export function resetSandboxClient(): void {
  sandboxClientInstance = null;
}
