/**
 * SandboxClient - HTTP client for Nexus Sandbox service
 *
 * Design Pattern: Facade Pattern + Circuit Breaker
 * SOLID Principles:
 * - Single Responsibility: Only handles Sandbox communication
 * - Dependency Inversion: Depends on interfaces, not implementations
 *
 * Provides:
 * - Code execution in isolated containers
 * - Multi-language support (Python, Node, Go, Rust, Java, Bash)
 * - Resource limit validation
 * - Circuit breaker for fail-fast behavior
 * - Automatic retries with exponential backoff
 * - Connection pooling
 */

import axios, { AxiosInstance, AxiosError } from 'axios';
import axiosRetry from 'axios-retry';
import { config } from '../config';

// ============================================================================
// Types
// ============================================================================

/**
 * Supported programming languages
 */
export type SupportedLanguage =
  | 'python'
  | 'node'
  | 'go'
  | 'rust'
  | 'java'
  | 'bash';

/**
 * File to include in sandbox execution
 */
export interface SandboxFile {
  filename: string;
  content: string; // base64 encoded
}

/**
 * Resource limits for sandbox execution
 */
export interface ResourceLimits {
  cpuLimit?: string; // e.g., '1.0' (1 CPU core)
  memoryLimit?: string; // e.g., '512Mi', '1Gi'
  gpuEnabled?: boolean;
}

/**
 * Sandbox execution request
 */
export interface SandboxExecutionRequest {
  code: string;
  language: SupportedLanguage;
  packages?: string[];
  files?: SandboxFile[];
  timeout?: number; // milliseconds (max 300000 = 5 minutes)
  resourceLimits?: ResourceLimits;
  metadata?: Record<string, unknown>;
}

/**
 * Resource usage metrics
 */
export interface ResourceUsage {
  cpuTimeMs: number;
  memoryPeakMb: number;
}

/**
 * Artifact produced by sandbox execution
 */
export interface SandboxArtifact {
  filename: string;
  content: string; // base64 encoded
  size: number;
}

/**
 * Error details from sandbox
 */
export interface SandboxError {
  code: string;
  message: string;
  details?: string;
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
  resourceUsage?: ResourceUsage;
  artifacts?: SandboxArtifact[];
  error?: SandboxError;
}

/**
 * Health check response
 */
export interface HealthStatus {
  status: 'healthy' | 'unhealthy' | 'degraded';
  version?: string;
  uptime?: number;
  availableLanguages?: SupportedLanguage[];
}

// ============================================================================
// Circuit Breaker
// ============================================================================

enum CircuitState {
  CLOSED = 'CLOSED',
  OPEN = 'OPEN',
  HALF_OPEN = 'HALF_OPEN',
}

interface CircuitBreakerConfig {
  failureThreshold: number;
  successThreshold: number;
  timeout: number;
}

class CircuitBreaker {
  private state: CircuitState = CircuitState.CLOSED;
  private failureCount = 0;
  private successCount = 0;
  private lastFailureTime?: Date;
  private readonly name: string;

  constructor(
    private config: CircuitBreakerConfig,
    name: string = 'sandbox'
  ) {
    this.name = name;
  }

  async execute<T>(operation: () => Promise<T>): Promise<T> {
    if (this.state === CircuitState.OPEN) {
      if (
        this.lastFailureTime &&
        Date.now() - this.lastFailureTime.getTime() > this.config.timeout
      ) {
        console.log(`[${this.name}] Circuit breaker entering HALF_OPEN state`);
        this.state = CircuitState.HALF_OPEN;
        this.successCount = 0;
      } else {
        throw new Error(
          `Circuit breaker OPEN - Sandbox unavailable (last failure: ${this.lastFailureTime?.toISOString()})`
        );
      }
    }

    try {
      const result = await operation();

      if (this.state === CircuitState.HALF_OPEN) {
        this.successCount++;
        if (this.successCount >= this.config.successThreshold) {
          console.log(`[${this.name}] Circuit breaker CLOSED - service recovered`);
          this.state = CircuitState.CLOSED;
          this.failureCount = 0;
        }
      } else {
        this.failureCount = 0;
      }

      return result;
    } catch (error) {
      this.failureCount++;
      this.lastFailureTime = new Date();

      if (this.failureCount >= this.config.failureThreshold) {
        console.warn(`[${this.name}] Circuit breaker OPEN - service failing`, {
          failureCount: this.failureCount,
          threshold: this.config.failureThreshold,
        });
        this.state = CircuitState.OPEN;
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

// ============================================================================
// SandboxClient
// ============================================================================

export class SandboxClient {
  private client: AxiosInstance;
  private circuitBreaker: CircuitBreaker;
  private baseUrl: string;

  // Safety limits
  private readonly MAX_TIMEOUT_MS = 300000; // 5 minutes
  private readonly MAX_MEMORY_MB = 2048; // 2GB
  private readonly MAX_FILE_SIZE_MB = 100; // 100MB
  private readonly ALLOWED_LANGUAGES: SupportedLanguage[] = [
    'python',
    'node',
    'go',
    'rust',
    'java',
    'bash',
  ];

  constructor(baseUrl?: string) {
    // Use config or environment variable or default
    // Port 9092 is the sandbox service port (config.ts:39)
    this.baseUrl = baseUrl ||
      (config as any).services?.sandbox?.endpoint ||
      process.env.SANDBOX_URL ||
      'http://nexus-sandbox:9092';

    // Create axios client with connection pooling
    this.client = axios.create({
      baseURL: this.baseUrl,
      timeout: this.MAX_TIMEOUT_MS,
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'MageAgent/1.0',
      },
      httpAgent: new (require('http').Agent)({
        keepAlive: true,
        maxSockets: 50,
      }),
      httpsAgent: new (require('https').Agent)({
        keepAlive: true,
        maxSockets: 50,
      }),
    });

    // Configure automatic retries
    axiosRetry(this.client, {
      retries: 3,
      retryDelay: axiosRetry.exponentialDelay,
      retryCondition: (error: AxiosError) => {
        return (
          axiosRetry.isNetworkOrIdempotentRequestError(error) ||
          (error.response?.status ? error.response.status >= 500 : false)
        );
      },
      onRetry: (retryCount, error) => {
        console.warn('[SandboxClient] Retrying request', {
          retryCount,
          error: error.message,
        });
      },
    });

    // Initialize circuit breaker
    this.circuitBreaker = new CircuitBreaker({
      failureThreshold: 5,
      successThreshold: 2,
      timeout: 60000, // 1 minute in OPEN state
    });

    console.log('[SandboxClient] Initialized', {
      baseUrl: this.baseUrl,
      maxTimeout: `${this.MAX_TIMEOUT_MS}ms`,
      maxMemory: `${this.MAX_MEMORY_MB}MB`,
    });
  }

  /**
   * Execute code in sandbox
   */
  async execute(request: SandboxExecutionRequest): Promise<SandboxExecutionResult> {
    const startTime = Date.now();

    // Validate request
    this.validateRequest(request);

    console.log('[SandboxClient] Executing code', {
      language: request.language,
      packages: request.packages?.length || 0,
      files: request.files?.length || 0,
      timeout: request.timeout,
    });

    try {
      const result = await this.circuitBreaker.execute(async () => {
        // Use /api/execute endpoint (routes mounted under /api prefix in server.ts:66)
        // Request structure matches sandbox ExecutionRequest type (types/index.ts)
        const response = await this.client.post<any>(
          '/api/execute',
          {
            id: `exec-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
            type: 'code' as const,
            template: request.language, // sandbox uses 'template' not 'language'
            config: {
              code: request.code,
              packages: request.packages ? { pip: request.packages } : undefined,
              files: request.files ? this.convertFilesToRecord(request.files) : undefined,
              timeout: request.timeout || 60000,
              cpus: this.parseCpuLimit(request.resourceLimits?.cpuLimit),
              memory: request.resourceLimits?.memoryLimit || '512Mi',
            },
            metadata: request.metadata,
          },
          {
            timeout: request.timeout || 60000,
          }
        );

        // Transform sandbox response to SandboxExecutionResult format
        const sandboxResult = response.data?.result;
        const transformedResult: SandboxExecutionResult = {
          success: sandboxResult?.status === 'success' || sandboxResult?.status === 'completed',
          stdout: sandboxResult?.output || '',
          stderr: sandboxResult?.error || '',
          exitCode: (sandboxResult?.status === 'success' || sandboxResult?.status === 'completed') ? 0 : 1,
          executionTimeMs: sandboxResult?.metrics?.duration || 0,
          resourceUsage: {
            cpuTimeMs: sandboxResult?.metrics?.cpuUsage || 0,
            memoryPeakMb: sandboxResult?.metrics?.memoryUsage || 0,
          },
          artifacts: sandboxResult?.artifacts?.map((a: any) => ({
            filename: a.name || a.filename,
            content: a.content || '',
            size: a.size || 0,
          })),
        };

        return transformedResult;
      });

      const executionTimeMs = Date.now() - startTime;

      console.log('[SandboxClient] Execution completed', {
        success: result.success,
        executionTimeMs,
        exitCode: result.exitCode,
        artifacts: result.artifacts?.length || 0,
      });

      return {
        ...result,
        executionTimeMs,
      };
    } catch (error) {
      const executionTimeMs = Date.now() - startTime;

      if (error instanceof Error && error.message.includes('Circuit breaker')) {
        console.error('[SandboxClient] Circuit breaker OPEN', {
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

      const errorMessage = error instanceof Error ? error.message : String(error);
      const axiosError = error as AxiosError;

      console.error('[SandboxClient] Execution failed', {
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
   * Execute Python code (convenience method)
   */
  async executePython(
    code: string,
    options: {
      packages?: string[];
      files?: SandboxFile[];
      timeout?: number;
    } = {}
  ): Promise<SandboxExecutionResult> {
    return this.execute({
      code,
      language: 'python',
      ...options,
    });
  }

  /**
   * Execute Node.js code (convenience method)
   */
  async executeNode(
    code: string,
    options: {
      packages?: string[];
      files?: SandboxFile[];
      timeout?: number;
    } = {}
  ): Promise<SandboxExecutionResult> {
    return this.execute({
      code,
      language: 'node',
      ...options,
    });
  }

  /**
   * Execute Bash script (convenience method)
   */
  async executeBash(
    script: string,
    options: {
      files?: SandboxFile[];
      timeout?: number;
    } = {}
  ): Promise<SandboxExecutionResult> {
    return this.execute({
      code: script,
      language: 'bash',
      ...options,
    });
  }

  /**
   * Analyze file content using sandbox
   *
   * Convenience method that generates analysis code based on file type.
   */
  async analyzeFile(
    filename: string,
    content: string, // base64 encoded
    options: {
      analysisType?: 'structure' | 'content' | 'metadata' | 'full';
      timeout?: number;
    } = {}
  ): Promise<{
    success: boolean;
    analysis?: string;
    metadata?: Record<string, unknown>;
    error?: SandboxError;
  }> {
    const analysisType = options.analysisType || 'full';

    // Generate analysis code based on file extension
    const ext = filename.split('.').pop()?.toLowerCase() || '';
    let code: string;
    let language: SupportedLanguage;

    if (['py', 'js', 'ts', 'go', 'rs', 'java'].includes(ext)) {
      // Source code analysis
      language = 'python';
      code = `
import base64
import json

content = base64.b64decode("${content}").decode('utf-8', errors='replace')

result = {
    "filename": "${filename}",
    "size": len(content),
    "lines": len(content.splitlines()),
    "analysis_type": "${analysisType}",
    "preview": content[:500] if len(content) > 500 else content,
}

print(json.dumps(result, indent=2))
`;
    } else if (['json', 'yaml', 'yml', 'xml'].includes(ext)) {
      // Data file analysis
      language = 'python';
      code = `
import base64
import json

content = base64.b64decode("${content}").decode('utf-8', errors='replace')

try:
    data = json.loads(content)
    keys = list(data.keys()) if isinstance(data, dict) else None
    result = {
        "filename": "${filename}",
        "valid_json": True,
        "keys": keys,
        "type": type(data).__name__,
    }
except:
    result = {
        "filename": "${filename}",
        "valid_json": False,
        "preview": content[:500],
    }

print(json.dumps(result, indent=2))
`;
    } else {
      // Binary or unknown file
      language = 'python';
      code = `
import base64
import json

content = base64.b64decode("${content}")

result = {
    "filename": "${filename}",
    "size": len(content),
    "is_text": False,
    "first_bytes_hex": content[:32].hex(),
}

# Try to detect if it's actually text
try:
    text = content.decode('utf-8')
    result["is_text"] = True
    result["preview"] = text[:500]
    result["lines"] = len(text.splitlines())
except:
    pass

print(json.dumps(result, indent=2))
`;
    }

    const execResult = await this.execute({
      code,
      language,
      timeout: options.timeout || 30000,
    });

    if (!execResult.success) {
      return {
        success: false,
        error: execResult.error,
      };
    }

    try {
      const analysis = JSON.parse(execResult.stdout || '{}');
      return {
        success: true,
        analysis: execResult.stdout,
        metadata: analysis,
      };
    } catch {
      return {
        success: true,
        analysis: execResult.stdout,
      };
    }
  }

  /**
   * Health check
   */
  async healthCheck(): Promise<HealthStatus> {
    try {
      const response = await this.client.get<HealthStatus>('/health', {
        timeout: 5000,
      });
      return response.data;
    } catch (error) {
      console.warn('[SandboxClient] Health check failed', {
        error: error instanceof Error ? error.message : String(error),
      });
      return {
        status: 'unhealthy',
      };
    }
  }

  /**
   * Get circuit breaker state
   */
  getCircuitState(): string {
    return this.circuitBreaker.getState();
  }

  /**
   * Reset circuit breaker
   */
  resetCircuit(): void {
    this.circuitBreaker.reset();
    console.log('[SandboxClient] Circuit breaker manually reset');
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

  /**
   * Convert files array to Record<string, string> format
   * Required by sandbox API which expects files as {filename: content} object
   */
  private convertFilesToRecord(files: SandboxFile[]): Record<string, string> {
    const record: Record<string, string> = {};
    for (const file of files) {
      record[file.filename] = file.content;
    }
    return record;
  }

  /**
   * Parse CPU limit string to number
   * Sandbox API expects cpus as a number (e.g., 1, 2, 4)
   */
  private parseCpuLimit(cpuLimit?: string): number {
    if (!cpuLimit) return 1;
    const parsed = parseFloat(cpuLimit);
    return isNaN(parsed) ? 1 : Math.max(1, Math.min(parsed, 8)); // Clamp between 1-8 CPUs
  }
}

// ============================================================================
// Singleton
// ============================================================================

let sandboxClientInstance: SandboxClient | null = null;

export function getSandboxClient(): SandboxClient {
  if (!sandboxClientInstance) {
    sandboxClientInstance = new SandboxClient();
  }
  return sandboxClientInstance;
}

export function resetSandboxClient(): void {
  sandboxClientInstance = null;
}
