/**
 * VideoAgentClient for FileProcessAgent
 *
 * HTTP client for Nexus VideoAgent service - handles video processing,
 * metadata extraction, scene detection, frame analysis, audio transcription,
 * and object tracking for video files.
 *
 * Design Pattern: Facade Pattern + Circuit Breaker
 * SOLID Principles:
 * - Single Responsibility: Only handles VideoAgent communication
 * - Dependency Inversion: Depends on interfaces, not implementations
 *
 * Use Cases for FileProcessAgent:
 * - Video file processing (MP4, AVI, MKV, MOV, etc.)
 * - Metadata extraction from video files
 * - Scene detection and segmentation
 * - Frame extraction and analysis
 * - Audio transcription
 * - Object tracking across frames
 */

import { config } from '../config';
import { logger } from '../utils/logger';

// ============================================================================
// Types
// ============================================================================

/**
 * Video processing options
 */
export interface VideoProcessingOptions {
  extractMetadata?: boolean;
  detectScenes?: boolean;
  analyzeFrames?: boolean;
  transcribeAudio?: boolean;
  trackObjects?: boolean;
  quality?: 'low' | 'medium' | 'high';
  maxFrames?: number;
  frameInterval?: number;
}

/**
 * Request to process a video
 */
export interface ProcessVideoRequest {
  userId: string;
  filename: string;
  videoUrl?: string;  // HTTP/HTTPS, YouTube URL, or file:// path
  options: VideoProcessingOptions;
  priority?: number;
  delay?: number;
  metadata?: Record<string, unknown>;
}

/**
 * Response from video processing job creation
 */
export interface VideoJobResponse {
  success: boolean;
  jobId: string;
  status: 'enqueued' | 'processing' | 'completed' | 'failed';
  enqueuedAt: string;
  message?: string;
}

/**
 * Video processing job status
 */
export interface VideoJobStatus {
  jobId: string;
  status: 'waiting' | 'active' | 'completed' | 'failed';
  progress: number;
  result?: VideoProcessingResult;
  error?: string;
  createdAt?: string;
  processedAt?: string;
  completedAt?: string;
  attemptsMade?: number;
}

/**
 * Video processing result
 */
export interface VideoProcessingResult {
  metadata?: {
    duration: number;
    resolution: { width: number; height: number };
    fps: number;
    codec: string;
    bitrate?: number;
    fileSize?: number;
  };
  scenes?: Array<{ startTime: number; endTime: number; description?: string }>;
  frames?: Array<{ timestamp: number; path: string; analysis?: string }>;
  transcription?: string;
  summary?: string;
  objects?: Array<{ name: string; confidence: number; timestamps: number[] }>;
}

/**
 * Health check response
 */
export interface VideoHealthStatus {
  status: 'healthy' | 'unhealthy' | 'degraded';
  version?: string;
  uptime?: number;
  services?: Record<string, boolean>;
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
    name: string = 'videoagent'
  ) {
    this.name = name;
  }

  async execute<T>(operation: () => Promise<T>): Promise<T> {
    if (this.state === CircuitState.OPEN) {
      if (
        this.lastFailureTime &&
        Date.now() - this.lastFailureTime.getTime() > this.config.timeout
      ) {
        logger.info(`[${this.name}] Circuit breaker entering HALF_OPEN state`);
        this.state = CircuitState.HALF_OPEN;
        this.successCount = 0;
      } else {
        throw new Error(
          `Circuit breaker OPEN - VideoAgent unavailable (last failure: ${this.lastFailureTime?.toISOString()})`
        );
      }
    }

    try {
      const result = await operation();

      if (this.state === CircuitState.HALF_OPEN) {
        this.successCount++;
        if (this.successCount >= this.config.successThreshold) {
          logger.info(`[${this.name}] Circuit breaker CLOSED - service recovered`);
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
        logger.warn(`[${this.name}] Circuit breaker OPEN - service failing`, {
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
// VideoAgentClient
// ============================================================================

export class VideoAgentClient {
  private circuitBreaker: CircuitBreaker;
  private baseUrl: string;
  private internalApiKey: string;

  // Configuration
  private readonly DEFAULT_TIMEOUT_MS = 300000; // 5 minutes
  private readonly MAX_POLL_ATTEMPTS = 150; // 150 * 2s = 5 minutes
  private readonly POLL_INTERVAL_MS = 2000; // 2 seconds

  constructor(baseUrl?: string) {
    // Use config or environment variable or default
    this.baseUrl = baseUrl ||
      config.videoagentUrl ||
      process.env.VIDEOAGENT_URL ||
      'http://nexus-videoagent:9060';

    // Internal service API key for service-to-service auth
    // Uses the same API key that FileProcess uses for authenticated requests
    this.internalApiKey = process.env.INTERNAL_SERVICE_API_KEY ||
      process.env.API_KEY ||
      'brain_0T5uLPyy3j3RUdrJlFMY48VuN1a2ov9X'; // Default internal service key

    // Initialize circuit breaker
    this.circuitBreaker = new CircuitBreaker({
      failureThreshold: 3,
      successThreshold: 2,
      timeout: 30000, // 30 seconds in OPEN state
    }, 'videoagent');

    logger.info('VideoAgentClient initialized', {
      baseUrl: this.baseUrl,
      timeout: `${this.DEFAULT_TIMEOUT_MS}ms`,
      hasApiKey: !!this.internalApiKey,
    });
  }

  /**
   * Get common headers for all requests including auth
   */
  private getAuthHeaders(): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      'User-Agent': 'FileProcessAgent/1.0',
      'X-API-Key': this.internalApiKey,
      'X-Internal-Service': 'nexus-fileprocess',
    };
  }

  /**
   * Process a video file
   *
   * This method handles:
   * - Metadata extraction (duration, resolution, codec, etc.)
   * - Scene detection and segmentation
   * - Frame extraction and analysis
   * - Audio transcription
   * - Object tracking across frames
   *
   * @param request - Video processing request with options
   * @returns Video job response with job ID for tracking
   */
  async processVideo(request: ProcessVideoRequest): Promise<VideoJobResponse> {
    return this.circuitBreaker.execute(async () => {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), this.DEFAULT_TIMEOUT_MS);

      try {
        logger.info('Processing video via VideoAgent', {
          filename: request.filename,
          videoUrl: request.videoUrl,
          userId: request.userId,
          options: request.options,
        });

        const response = await fetch(`${this.baseUrl}/videoagent/api/video/process`, {
          method: 'POST',
          headers: this.getAuthHeaders(),
          body: JSON.stringify(request),
          signal: controller.signal,
        });

        clearTimeout(timeoutId);

        if (!response.ok) {
          const errorText = await response.text().catch(() => 'Unable to read error');
          throw new Error(`VideoAgent returned HTTP ${response.status}: ${errorText}`);
        }

        const result = await response.json() as VideoJobResponse;

        logger.info('Video processing job created', {
          jobId: result.jobId,
          status: result.status,
          enqueuedAt: result.enqueuedAt,
        });

        return result;
      } finally {
        clearTimeout(timeoutId);
      }
    });
  }

  /**
   * Get job status by ID
   *
   * @param jobId - Job ID to check status for
   * @returns Current job status with progress and result if completed
   */
  async getJobStatus(jobId: string): Promise<VideoJobStatus> {
    return this.circuitBreaker.execute(async () => {
      const response = await fetch(`${this.baseUrl}/videoagent/api/video/status/${jobId}`, {
        method: 'GET',
        headers: this.getAuthHeaders(),
      });

      if (!response.ok) {
        throw new Error(`Failed to get job status: HTTP ${response.status}`);
      }

      return await response.json() as VideoJobStatus;
    });
  }

  /**
   * Cancel a running job
   *
   * @param jobId - Job ID to cancel
   * @returns True if job was successfully cancelled
   */
  async cancelJob(jobId: string): Promise<boolean> {
    return this.circuitBreaker.execute(async () => {
      const response = await fetch(`${this.baseUrl}/videoagent/api/video/cancel/${jobId}`, {
        method: 'DELETE',
        headers: this.getAuthHeaders(),
      });

      if (!response.ok) {
        throw new Error(`Failed to cancel job: HTTP ${response.status}`);
      }

      const data = await response.json() as { success: boolean };
      return data.success;
    });
  }

  /**
   * Wait for job completion with polling
   *
   * @param jobId - Job ID to wait for
   * @param timeout - Optional timeout in milliseconds (default: 5 minutes)
   * @returns Processing result when job completes
   */
  async waitForCompletion(
    jobId: string,
    timeout?: number
  ): Promise<VideoProcessingResult> {
    const maxTime = timeout || this.DEFAULT_TIMEOUT_MS;
    const startTime = Date.now();
    let attempts = 0;

    logger.info('Waiting for video processing job completion', {
      jobId,
      timeoutMs: maxTime,
    });

    while (Date.now() - startTime < maxTime && attempts < this.MAX_POLL_ATTEMPTS) {
      const status = await this.getJobStatus(jobId);

      if (status.status === 'completed') {
        if (!status.result) {
          throw new Error('Job completed but no result available');
        }
        logger.info('Video processing job completed', {
          jobId,
          attempts,
          elapsedMs: Date.now() - startTime,
        });
        return status.result;
      }

      if (status.status === 'failed') {
        throw new Error(`Video processing job failed: ${status.error || 'Unknown error'}`);
      }

      // Wait before next poll
      await this.delay(this.POLL_INTERVAL_MS);
      attempts++;

      if (attempts % 10 === 0) {
        logger.debug('Waiting for VideoAgent job completion', {
          jobId,
          attempts,
          maxAttempts: this.MAX_POLL_ATTEMPTS,
          elapsedMs: Date.now() - startTime,
          progress: status.progress || 0,
        });
      }
    }

    // Timeout - cancel the job
    try {
      await this.cancelJob(jobId);
    } catch {
      // Ignore cancel errors
    }

    throw new Error(`Video processing job timed out after ${maxTime}ms`);
  }

  /**
   * Process video and wait for completion in one call
   *
   * This is a convenience method that combines processVideo() and waitForCompletion().
   *
   * @param request - Video processing request
   * @param timeout - Optional timeout in milliseconds
   * @returns Processing result when job completes
   */
  async processVideoAndWait(
    request: ProcessVideoRequest,
    timeout?: number
  ): Promise<VideoProcessingResult> {
    logger.info('Processing video and waiting for completion', {
      filename: request.filename,
      videoUrl: request.videoUrl,
      timeout,
    });

    const job = await this.processVideo(request);
    return this.waitForCompletion(job.jobId, timeout);
  }

  /**
   * Health check
   *
   * Checks if VideoAgent service is available and healthy.
   * Falls back to metrics endpoint if health endpoint is not available.
   *
   * @returns Health status of VideoAgent service
   */
  async healthCheck(): Promise<{ status: 'healthy' | 'unhealthy'; details?: any }> {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 5000);

      // Try health endpoint first
      let response = await fetch(`${this.baseUrl}/health`, {
        signal: controller.signal,
      }).catch(() => null);

      // If health endpoint not available, try metrics endpoint
      if (!response || !response.ok) {
        response = await fetch(`${this.baseUrl}/videoagent/api/video/metrics`, {
          signal: controller.signal,
        }).catch(() => null);
      }

      clearTimeout(timeoutId);

      if (!response || !response.ok) {
        return { status: 'unhealthy' };
      }

      const data = await response.json() as VideoHealthStatus;
      return {
        status: data.status === 'healthy' ? 'healthy' : 'unhealthy',
        details: data,
      };
    } catch (error) {
      logger.warn('VideoAgent health check failed', {
        error: error instanceof Error ? error.message : String(error),
      });
      return { status: 'unhealthy' };
    }
  }

  /**
   * Get circuit breaker state
   *
   * @returns Current circuit breaker state (CLOSED, OPEN, or HALF_OPEN)
   */
  getCircuitState(): string {
    return this.circuitBreaker.getState();
  }

  /**
   * Reset circuit breaker
   *
   * Forces circuit breaker back to CLOSED state. Use with caution.
   */
  resetCircuit(): void {
    this.circuitBreaker.reset();
    logger.info('VideoAgent circuit breaker manually reset');
  }

  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Check if a MIME type or filename is a video file that should be
   * routed to VideoAgent for processing.
   *
   * @param mimeType - MIME type of the file
   * @param filename - Optional filename for extension checking
   * @returns True if file is a video type
   */
  static isVideoFileType(mimeType: string, filename?: string): boolean {
    // Video MIME types
    const videoMimeTypes = new Set([
      // Standard video formats
      'video/mp4',
      'video/mpeg',
      'video/x-msvideo', // AVI
      'video/x-matroska', // MKV
      'video/quicktime', // MOV
      'video/x-ms-wmv', // WMV
      'video/x-flv', // FLV
      'video/webm',
      'video/3gpp', // 3GP
      'video/3gpp2', // 3G2

      // Other video formats
      'video/ogg',
      'video/x-m4v', // M4V
      'video/MP2T', // MPEG-TS
      'video/x-ms-asf',
      'video/dvd',

      // Application types that are actually video
      'application/x-mpegURL', // M3U8
      'application/vnd.apple.mpegurl', // M3U8
    ]);

    // Check MIME type
    if (videoMimeTypes.has(mimeType)) {
      return true;
    }

    // Check if MIME type starts with 'video/'
    if (mimeType.startsWith('video/')) {
      return true;
    }

    // Check file extension as fallback
    if (filename) {
      const ext = filename.split('.').pop()?.toLowerCase();
      const videoExtensions = new Set([
        'mp4', 'avi', 'mkv', 'mov', 'wmv', 'flv', 'webm',
        'm4v', 'mpeg', 'mpg', '3gp', '3g2', 'ts', 'mts',
        'm2ts', 'vob', 'ogv', 'gifv', 'qt', 'rm', 'rmvb',
        'asf', 'amv', 'divx', 'f4v', 'm2v', 'mpe', 'mpv',
        'mxf', 'nsv', 'roq', 'svi', 'yuv',
      ]);

      if (ext && videoExtensions.has(ext)) {
        return true;
      }
    }

    return false;
  }
}

// ============================================================================
// Singleton
// ============================================================================

let videoAgentClientInstance: VideoAgentClient | null = null;

/**
 * Get or create the singleton VideoAgent client instance
 *
 * @returns Singleton VideoAgentClient instance
 */
export function getVideoAgentClient(): VideoAgentClient {
  if (!videoAgentClientInstance) {
    videoAgentClientInstance = new VideoAgentClient();
  }
  return videoAgentClientInstance;
}

/**
 * Reset the singleton instance (for testing)
 */
export function resetVideoAgentClient(): void {
  videoAgentClientInstance = null;
}
