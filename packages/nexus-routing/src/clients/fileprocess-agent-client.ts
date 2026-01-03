/**
 * FileProcessAgent Client - Job ID Pattern Wrapper
 * Provides Job ID pattern interface for FileProcessAgent document processing service
 *
 * Pattern: submit → status → result
 */

import { logger } from '../utils/logger.js';
import { SmartConnectionPool } from '../utils/connection-pool.js';
import { circuitBreakerManager } from '../utils/circuit-breaker.js';
import { serviceDiscovery } from '../utils/service-discovery.js';
import { ServiceUnavailableError, ToolExecutionError } from '../utils/error-handler.js';
import { config } from '../config.js';

export class FileProcessAgentClient {
  private pool: SmartConnectionPool | null = null;
  private initialized: boolean = false;
  private readonly endpoints: string[];

  constructor(endpoints: string[] = config.fileprocess?.endpoints || ['http://localhost:9096']) {
    this.endpoints = endpoints;
    logger.debug('FileProcessAgent client initialized (lazy loading enabled)', { endpoints: this.endpoints });
  }

  /**
   * Lazy initialization - discover endpoint and create connection pool
   */
  private async ensureInitialized(): Promise<void> {
    if (this.initialized && this.pool) {
      return;
    }

    try {
      const endpoint = await serviceDiscovery.discover({
        name: 'fileprocess-agent',
        candidates: this.endpoints,
        healthPath: '/health',
        timeout: 5000
      });

      if (!endpoint.healthy) {
        logger.warn('FileProcessAgent endpoint not healthy', {
          endpoint: endpoint.url
        });
      }

      this.pool = new SmartConnectionPool(endpoint.url, {
        maxSockets: 10,
        maxFreeSockets: 5,
        timeout: 60000, // 1 minute for document processing
        keepAlive: true,
        keepAliveMsecs: 60000
      });

      this.initialized = true;
      logger.debug('FileProcessAgent client initialized successfully', { endpoint: endpoint.url });
    } catch (error) {
      logger.error('Failed to initialize FileProcessAgent client', {
        error: (error as Error).message,
        endpoints: this.endpoints
      });
      throw new ServiceUnavailableError('FileProcessAgent', (error as Error).message);
    }
  }

  /**
   * Generic POST request with timeout
   */
  private async post<T = any>(endpoint: string, data: any, toolName: string): Promise<T> {
    try {
      await this.ensureInitialized();
      if (!this.pool) throw new Error('Connection pool not initialized');

      const response = await this.pool.post<T>(endpoint, data, {}, 60000); // 1 minute timeout
      return response.data;
    } catch (error) {
      const err = error as Error;
      logger.error('FileProcessAgent POST request failed', {
        endpoint,
        toolName,
        error: err.message
      });
      throw new ToolExecutionError(toolName, 'fileprocess-agent', err);
    }
  }

  /**
   * Generic GET request with timeout
   */
  private async get<T = any>(endpoint: string, toolName: string): Promise<T> {
    try {
      await this.ensureInitialized();
      if (!this.pool) throw new Error('Connection pool not initialized');

      const response = await this.pool.get<T>(endpoint, {}, 30000); // 30 second timeout for status checks
      return response.data;
    } catch (error) {
      const err = error as Error;
      logger.error('FileProcessAgent GET request failed', {
        endpoint,
        toolName,
        error: err.message
      });
      throw new ToolExecutionError(toolName, 'fileprocess-agent', err);
    }
  }

  /**
   * Check health
   */
  async checkHealth(): Promise<boolean> {
    try {
      await this.ensureInitialized();
      if (!this.pool) return false;

      const response = await this.pool.get('/health', {}, 5000);
      return response.status === 200;
    } catch (error) {
      logger.debug('FileProcessAgent health check failed', {
        error: (error as Error).message
      });
      return false;
    }
  }

  // ========================================
  // Job ID Pattern Methods (PHASE 4)
  // ========================================

  /**
   * Submit document processing job (file upload)
   */
  async submitFileJob(options: {
    filename: string;
    mimeType?: string;
    fileSize?: number;
    fileBuffer?: Buffer;
    userId?: string;
    metadata?: Record<string, any>;
  }): Promise<{ jobId: string; status: string; pollWith: string; estimatedTime: string }> {
    // For file uploads, we would use multipart/form-data
    // This is a simplified interface - actual implementation would handle file streaming
    const response = await this.post<any>('/fileprocess/api/process', {
      filename: options.filename,
      mimeType: options.mimeType,
      fileSize: options.fileSize,
      userId: options.userId || 'anonymous',
      metadata: options.metadata
    }, 'nexus_fileprocess_submit_file');

    const estimatedTime = (options.fileSize || 0) > 1024 * 1024 ? '10-30 seconds' : '2-15 seconds';

    return {
      jobId: response.jobId,
      status: 'queued',
      pollWith: 'nexus_fileprocess_get_status',
      estimatedTime
    };
  }

  /**
   * Submit document processing job (URL)
   */
  async submitUrlJob(options: {
    fileUrl: string;
    filename: string;
    mimeType?: string;
    userId?: string;
    metadata?: Record<string, any>;
  }): Promise<{ jobId: string; status: string; pollWith: string; estimatedTime: string }> {
    const response = await this.post<any>('/fileprocess/api/process/url', {
      fileUrl: options.fileUrl,
      filename: options.filename,
      mimeType: options.mimeType,
      userId: options.userId || 'anonymous',
      metadata: options.metadata
    }, 'nexus_fileprocess_submit_url');

    return {
      jobId: response.jobId,
      status: 'queued',
      pollWith: 'nexus_fileprocess_get_status',
      estimatedTime: '5-30 seconds'
    };
  }

  /**
   * Get document processing job status
   */
  async getJobStatus(jobId: string): Promise<{
    jobId: string;
    status: string;
    progress: number;
    confidence?: number;
    currentStep?: string;
    error?: string;
  }> {
    const response = await this.get<any>(`/fileprocess/api/jobs/${jobId}`, 'nexus_fileprocess_get_status');

    if (!response.job) {
      throw new Error(`Job ${jobId} not found`);
    }

    const job = response.job;
    return {
      jobId,
      status: job.status || 'unknown',
      progress: this.calculateProgress(job.status),
      confidence: job.confidence,
      currentStep: this.getStepDescription(job.status),
      error: job.errorMessage
    };
  }

  /**
   * Get document processing job result
   */
  async getJobResult(jobId: string): Promise<any> {
    const response = await this.get<any>(`/fileprocess/api/jobs/${jobId}`, 'nexus_fileprocess_get_result');

    if (!response.job) {
      throw new Error(`Job ${jobId} not found`);
    }

    const job = response.job;
    if (job.status !== 'completed' && job.status !== 'succeeded') {
      throw new Error(`Job ${jobId} has status '${job.status}', not completed`);
    }

    return {
      jobId,
      filename: job.filename,
      mimeType: job.mimeType,
      fileSize: job.fileSize,
      status: job.status,
      confidence: job.confidence,
      processingTimeMs: job.processingTimeMs,
      documentDnaId: job.documentDnaId,
      ocrTierUsed: job.ocrTierUsed,
      metadata: job.metadata,
      documentDna: response.documentDna,
      createdAt: job.createdAt,
      updatedAt: job.updatedAt
    };
  }

  /**
   * Cancel document processing job
   */
  async cancelJob(jobId: string): Promise<{ success: boolean; message: string }> {
    try {
      await this.ensureInitialized();
      if (!this.pool) throw new Error('Connection pool not initialized');

      const response = await this.pool.delete(`/fileprocess/api/jobs/${jobId}`, {}, 30000);
      return {
        success: true,
        message: response.data?.message || 'Job cancelled successfully'
      };
    } catch (error) {
      const err = error as Error;
      logger.warn('Failed to cancel job', {
        jobId,
        error: err.message
      });
      throw new ToolExecutionError('nexus_fileprocess_cancel_job', 'fileprocess-agent', err);
    }
  }

  /**
   * List jobs by state
   */
  async listJobsByState(state: 'waiting' | 'active' | 'completed' | 'failed' | 'delayed', start: number = 0, end: number = 100): Promise<any[]> {
    const response = await this.get<any>(`/fileprocess/api/jobs?state=${state}&start=${start}&end=${end}`, 'nexus_fileprocess_list_jobs');

    return response.jobs || [];
  }

  /**
   * Get queue statistics
   */
  async getQueueStats(): Promise<{
    waiting: number;
    active: number;
    completed: number;
    failed: number;
  }> {
    const response = await this.get<any>('/fileprocess/api/queue/stats', 'nexus_fileprocess_get_queue_stats');

    return {
      waiting: response.stats?.waiting || 0,
      active: response.stats?.active || 0,
      completed: response.stats?.completed || 0,
      failed: response.stats?.failed || 0
    };
  }

  // ========================================
  // Helper Methods
  // ========================================

  private calculateProgress(status: string): number {
    const progressMap: Record<string, number> = {
      'waiting': 0,
      'queued': 0,
      'downloading': 10,
      'downloaded': 15,
      'preprocessing': 20,
      'ocr': 40,
      'extraction': 70,
      'validation': 85,
      'completed': 100,
      'succeeded': 100,
      'failed': 0
    };
    return progressMap[status] || 0;
  }

  private getStepDescription(status: string): string {
    const stepMap: Record<string, string> = {
      'waiting': 'Waiting in queue',
      'queued': 'Queued for processing',
      'downloading': 'Downloading file',
      'downloaded': 'File downloaded',
      'preprocessing': 'Preprocessing document',
      'ocr': 'Performing OCR',
      'extraction': 'Extracting content',
      'validation': 'Validating results',
      'completed': 'Processing completed',
      'succeeded': 'Processing succeeded',
      'failed': 'Processing failed'
    };
    return stepMap[status] || 'Processing...';
  }

  /**
   * Get connection statistics
   */
  getConnectionStats() {
    return this.pool?.getStats() || null;
  }

  /**
   * Get circuit breaker statistics
   */
  getCircuitBreakerStats() {
    return circuitBreakerManager.getBreaker('fileprocess-agent').getStats();
  }
}

// Export singleton instance
export const fileprocessagentClient = new FileProcessAgentClient();
