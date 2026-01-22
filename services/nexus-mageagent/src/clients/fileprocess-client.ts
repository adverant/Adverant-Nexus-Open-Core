/**
 * FileProcessClient - HTTP client for Nexus FileProcessAgent service
 *
 * Design Pattern: Facade Pattern + Circuit Breaker
 * SOLID Principles:
 * - Single Responsibility: Only handles FileProcessAgent communication
 * - Dependency Inversion: Depends on interfaces, not implementations
 *
 * Provides:
 * - File processing (PDF, Office docs, images, archives)
 * - URL-based file download and processing
 * - Google Drive integration
 * - Job management
 * - Circuit breaker for fail-fast behavior
 */

import axios, { AxiosInstance, AxiosError } from 'axios';
import axiosRetry from 'axios-retry';
import { config } from '../config';

// ============================================================================
// Types
// ============================================================================

/**
 * Job status in FileProcessAgent
 */
export type FileJobStatus =
  | 'pending'
  | 'processing'
  | 'completed'
  | 'failed'
  | 'cancelled';

/**
 * Request to process a file from URL
 */
export interface ProcessUrlRequest {
  fileUrl: string;
  filename: string;
  mimeType?: string;
  userId?: string;
  sessionId?: string;
  metadata?: Record<string, unknown>;
  options?: {
    enableOcr?: boolean;
    extractTables?: boolean;
    enableAgentAnalysis?: boolean;
  };
}

/**
 * Request to process a Google Drive URL
 */
export interface ProcessDriveUrlRequest {
  driveUrl: string;
  userId?: string;
  sessionId?: string;
  metadata?: Record<string, unknown>;
  options?: {
    enableOcr?: boolean;
    extractTables?: boolean;
    enableAgentAnalysis?: boolean;
  };
}

/**
 * Response from file processing submission
 */
export interface ProcessFileResponse {
  jobId: string;
  status: FileJobStatus;
  message?: string;
  estimatedDurationMs?: number;
}

/**
 * File processing job entity
 */
export interface FileJob {
  id: string;
  status: FileJobStatus;
  filename: string;
  mimeType?: string;
  fileSize?: number;
  progress?: number;
  result?: FileProcessingResult;
  error?: string;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  metadata?: Record<string, unknown>;
}

/**
 * Result of file processing
 */
export interface FileProcessingResult {
  success: boolean;
  extractedContent?: string;
  metadata?: {
    pageCount?: number;
    wordCount?: number;
    language?: string;
    [key: string]: unknown;
  };
  artifacts?: FileArtifact[];
  tables?: ExtractedTable[];
  images?: ExtractedImage[];
  processingMethod: string;
  executionTimeMs: number;
}

/**
 * Extracted artifact from file
 */
export interface FileArtifact {
  id: string;
  filename: string;
  mimeType: string;
  size: number;
  url?: string;
  content?: string;
}

/**
 * Extracted table from document
 */
export interface ExtractedTable {
  id: string;
  pageNumber?: number;
  rows: number;
  columns: number;
  headers?: string[];
  data: string[][];
}

/**
 * Extracted image from document
 */
export interface ExtractedImage {
  id: string;
  pageNumber?: number;
  format: string;
  width: number;
  height: number;
  url?: string;
  caption?: string;
}

/**
 * Health check response
 */
export interface HealthStatus {
  status: 'healthy' | 'unhealthy' | 'degraded';
  version?: string;
  uptime?: number;
  queueStatus?: {
    pending: number;
    active: number;
    completed: number;
    failed: number;
  };
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
    name: string = 'fileprocess'
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
          `Circuit breaker OPEN - FileProcessAgent unavailable (last failure: ${this.lastFailureTime?.toISOString()})`
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
// FileProcessClient
// ============================================================================

export class FileProcessClient {
  private client: AxiosInstance;
  private circuitBreaker: CircuitBreaker;
  private baseUrl: string;

  // Configuration
  private readonly DEFAULT_TIMEOUT_MS = 300000; // 5 minutes (files can be large)
  private readonly MAX_POLL_ATTEMPTS = 150; // 150 * 2s = 5 minutes
  private readonly POLL_INTERVAL_MS = 2000; // 2 seconds

  constructor(baseUrl?: string) {
    // Use config or environment variable or default
    this.baseUrl = baseUrl ||
      (config as any).services?.fileProcess?.endpoint ||
      process.env.FILEPROCESS_URL ||
      'http://nexus-fileprocess:9040';

    // Create axios client with connection pooling
    this.client = axios.create({
      baseURL: this.baseUrl,
      timeout: this.DEFAULT_TIMEOUT_MS,
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'MageAgent/1.0',
      },
      httpAgent: new (require('http').Agent)({
        keepAlive: true,
        maxSockets: 20,
      }),
      httpsAgent: new (require('https').Agent)({
        keepAlive: true,
        maxSockets: 20,
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
        console.warn('[FileProcessClient] Retrying request', {
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

    console.log('[FileProcessClient] Initialized', {
      baseUrl: this.baseUrl,
      timeout: `${this.DEFAULT_TIMEOUT_MS}ms`,
    });
  }

  /**
   * Process a file from URL
   */
  async processUrl(request: ProcessUrlRequest): Promise<ProcessFileResponse> {
    return this.circuitBreaker.execute(async () => {
      const response = await this.client.post<ProcessFileResponse>(
        '/api/process/url',
        request
      );
      return response.data;
    });
  }

  /**
   * Process a file from Google Drive URL
   */
  async processDriveUrl(request: ProcessDriveUrlRequest): Promise<ProcessFileResponse> {
    return this.circuitBreaker.execute(async () => {
      const response = await this.client.post<ProcessFileResponse>(
        '/api/process/drive-url',
        request
      );
      return response.data;
    });
  }

  /**
   * Get job status by ID
   */
  async getJobStatus(jobId: string): Promise<FileJob> {
    return this.circuitBreaker.execute(async () => {
      const response = await this.client.get<{ job: FileJob }>(
        `/api/jobs/${jobId}`
      );
      return response.data.job;
    });
  }

  /**
   * Cancel a job
   */
  async cancelJob(jobId: string): Promise<void> {
    return this.circuitBreaker.execute(async () => {
      await this.client.post(`/api/jobs/${jobId}/cancel`);
    });
  }

  /**
   * Download and process a file from any URL
   *
   * Convenience method that submits job and polls until completion.
   */
  async downloadAndProcess(
    url: string,
    options: {
      filename?: string;
      mimeType?: string;
      enableOcr?: boolean;
      extractTables?: boolean;
      enableAgentAnalysis?: boolean;
      timeout?: number;
    } = {}
  ): Promise<FileProcessingResult> {
    // Detect if it's a Google Drive URL
    const isGoogleDrive = url.includes('drive.google.com') || url.includes('docs.google.com');

    let response: ProcessFileResponse;

    if (isGoogleDrive) {
      response = await this.processDriveUrl({
        driveUrl: url,
        options: {
          enableOcr: options.enableOcr,
          extractTables: options.extractTables,
          enableAgentAnalysis: options.enableAgentAnalysis,
        },
      });
    } else {
      response = await this.processUrl({
        fileUrl: url,
        filename: options.filename || this.extractFilenameFromUrl(url),
        mimeType: options.mimeType,
        options: {
          enableOcr: options.enableOcr,
          extractTables: options.extractTables,
          enableAgentAnalysis: options.enableAgentAnalysis,
        },
      });
    }

    return this.waitForJobCompletion(response.jobId, options.timeout);
  }

  /**
   * Extract content from a document
   *
   * High-level convenience method.
   */
  async extractContent(
    url: string,
    options: {
      includeOcr?: boolean;
      includeTables?: boolean;
    } = {}
  ): Promise<{
    content: string;
    tables?: ExtractedTable[];
    metadata?: Record<string, unknown>;
  }> {
    const result = await this.downloadAndProcess(url, {
      enableOcr: options.includeOcr ?? true,
      extractTables: options.includeTables ?? true,
    });

    return {
      content: result.extractedContent || '',
      tables: result.tables,
      metadata: result.metadata,
    };
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
  }

  /**
   * Wait for job completion with polling
   */
  private async waitForJobCompletion(
    jobId: string,
    timeout?: number
  ): Promise<FileProcessingResult> {
    const maxTime = timeout || this.DEFAULT_TIMEOUT_MS;
    const startTime = Date.now();
    let attempts = 0;

    while (Date.now() - startTime < maxTime && attempts < this.MAX_POLL_ATTEMPTS) {
      const job = await this.getJobStatus(jobId);

      if (job.status === 'completed') {
        if (!job.result) {
          throw new Error('Job completed but no result available');
        }
        return job.result;
      }

      if (job.status === 'failed') {
        throw new Error(`File processing failed: ${job.error || 'Unknown error'}`);
      }

      if (job.status === 'cancelled') {
        throw new Error('File processing was cancelled');
      }

      // Wait before next poll
      await this.delay(this.POLL_INTERVAL_MS);
      attempts++;
    }

    // Timeout - cancel the job
    try {
      await this.cancelJob(jobId);
    } catch {
      // Ignore cancel errors
    }

    throw new Error(`File processing timed out after ${maxTime}ms`);
  }

  /**
   * Extract filename from URL
   */
  private extractFilenameFromUrl(url: string): string {
    try {
      const parsedUrl = new URL(url);
      const pathname = parsedUrl.pathname;
      const filename = pathname.split('/').pop() || 'document';
      return decodeURIComponent(filename);
    } catch {
      return 'document';
    }
  }

  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

// ============================================================================
// Singleton
// ============================================================================

let fileProcessClientInstance: FileProcessClient | null = null;

export function getFileProcessClient(): FileProcessClient {
  if (!fileProcessClientInstance) {
    fileProcessClientInstance = new FileProcessClient();
  }
  return fileProcessClientInstance;
}

export function resetFileProcessClient(): void {
  fileProcessClientInstance = null;
}
