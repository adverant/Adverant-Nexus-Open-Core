/**
 * VideoAgent Client - Job ID Pattern Wrapper
 * Provides Job ID pattern interface for VideoAgent video processing service
 *
 * Pattern: submit → status → result
 */

import { logger } from '../utils/logger.js';
import { SmartConnectionPool } from '../utils/connection-pool.js';
import { circuitBreakerManager } from '../utils/circuit-breaker.js';
import { serviceDiscovery } from '../utils/service-discovery.js';
import { ServiceUnavailableError, ToolExecutionError } from '../utils/error-handler.js';
import { config } from '../config.js';

export class VideoAgentClient {
  private pool: SmartConnectionPool | null = null;
  private initialized: boolean = false;
  private readonly endpoints: string[];

  constructor(endpoints: string[] = config.videoagent?.endpoints || ['http://localhost:9095']) {
    this.endpoints = endpoints;
    logger.debug('VideoAgent client initialized (lazy loading enabled)', { endpoints: this.endpoints });
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
        name: 'videoagent',
        candidates: this.endpoints,
        healthPath: '/health',
        timeout: 5000
      });

      if (!endpoint.healthy) {
        logger.warn('VideoAgent endpoint not healthy', {
          endpoint: endpoint.url
        });
      }

      this.pool = new SmartConnectionPool(endpoint.url, {
        maxSockets: 10,
        maxFreeSockets: 5,
        timeout: 300000, // 5 minutes for video processing
        keepAlive: true,
        keepAliveMsecs: 60000
      });

      this.initialized = true;
      logger.debug('VideoAgent client initialized successfully', { endpoint: endpoint.url });
    } catch (error) {
      logger.error('Failed to initialize VideoAgent client', {
        error: (error as Error).message,
        endpoints: this.endpoints
      });
      throw new ServiceUnavailableError('VideoAgent', (error as Error).message);
    }
  }

  /**
   * Generic POST request with timeout
   */
  private async post<T = any>(endpoint: string, data: any, toolName: string): Promise<T> {
    try {
      await this.ensureInitialized();
      if (!this.pool) throw new Error('Connection pool not initialized');

      const response = await this.pool.post<T>(endpoint, data, {}, 300000); // 5 minute timeout
      return response.data;
    } catch (error) {
      const err = error as Error;
      logger.error('VideoAgent POST request failed', {
        endpoint,
        toolName,
        error: err.message
      });
      throw new ToolExecutionError(toolName, 'videoagent', err);
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
      logger.error('VideoAgent GET request failed', {
        endpoint,
        toolName,
        error: err.message
      });
      throw new ToolExecutionError(toolName, 'videoagent', err);
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
      logger.debug('VideoAgent health check failed', {
        error: (error as Error).message
      });
      return false;
    }
  }

  // ========================================
  // Job ID Pattern Methods (PHASE 3)
  // ========================================

  /**
   * Submit video processing job - returns immediately with jobId
   */
  async submitJob(options: {
    videoUrl?: string;
    filename?: string;
    userId?: string;
    sessionId?: string;
    options?: {
      analyzeFrames?: boolean;
      transcribeAudio?: boolean;
      detectScenes?: boolean;
      trackObjects?: boolean;
      extractMetadata?: boolean;
      quality?: 'low' | 'medium' | 'high';
    };
  }): Promise<{ jobId: string; status: string; pollWith: string; estimatedTime: string }> {
    const response = await this.post<any>('/api/video/process', {
      videoUrl: options.videoUrl,
      filename: options.filename,
      userId: options.userId || 'anonymous',
      sessionId: options.sessionId,
      sourceType: options.videoUrl ? 'url' : 'upload',
      options: options.options || {
        analyzeFrames: true,
        transcribeAudio: true,
        detectScenes: true,
        trackObjects: false,
        extractMetadata: true,
        quality: 'medium'
      }
    }, 'nexus_videoagent_submit_job');

    return {
      jobId: response.jobId,
      status: 'queued',
      pollWith: 'nexus_videoagent_get_status',
      estimatedTime: options.videoUrl ? '2-10 minutes' : '1-5 minutes'
    };
  }

  /**
   * Get video processing job status
   */
  async getJobStatus(jobId: string): Promise<{
    jobId: string;
    status: string;
    progress: number;
    currentStep?: string;
    error?: string;
  }> {
    const response = await this.get<any>(`/api/video/job/${jobId}`, 'nexus_videoagent_get_status');

    return {
      jobId,
      status: response.status || 'unknown',
      progress: response.progress || 0,
      currentStep: response.currentStep,
      error: response.failedReason
    };
  }

  /**
   * Get video processing job result
   */
  async getJobResult(jobId: string): Promise<any> {
    const response = await this.get<any>(`/api/video/job/${jobId}`, 'nexus_videoagent_get_result');

    if (response.status !== 'completed' && response.status !== 'succeeded') {
      throw new Error(`Job ${jobId} has status '${response.status}', not completed`);
    }

    return response.result || response;
  }

  /**
   * Cancel video processing job
   */
  async cancelJob(jobId: string): Promise<{ success: boolean; message: string }> {
    try {
      await this.ensureInitialized();
      if (!this.pool) throw new Error('Connection pool not initialized');

      const response = await this.pool.delete(`/api/video/job/${jobId}`, {}, 30000);
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
      throw new ToolExecutionError('nexus_videoagent_cancel_job', 'videoagent', err);
    }
  }

  /**
   * Get queue statistics
   */
  async getQueueStats(): Promise<{
    queued: number;
    processing: number;
    completed: number;
    failed: number;
  }> {
    const response = await this.get<any>('/api/video/queue/stats', 'nexus_videoagent_get_queue_stats');

    return {
      queued: response.stats?.queued || 0,
      processing: response.stats?.processing || 0,
      completed: response.stats?.completed || 0,
      failed: response.stats?.failed || 0
    };
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
    return circuitBreakerManager.getBreaker('videoagent').getStats();
  }
}

// Export singleton instance
export const videoagentClient = new VideoAgentClient();
