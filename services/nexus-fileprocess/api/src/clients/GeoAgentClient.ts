/**
 * GeoAgentClient for FileProcessAgent
 *
 * HTTP client for Nexus GeoAgent service - handles geospatial data processing,
 * LiDAR point cloud analysis, vector/raster processing, and geospatial ML.
 *
 * Design Pattern: Facade Pattern + Circuit Breaker
 * SOLID Principles:
 * - Single Responsibility: Only handles GeoAgent communication
 * - Dependency Inversion: Depends on interfaces, not implementations
 *
 * Use Cases for FileProcessAgent:
 * - Geospatial file processing (GeoJSON, KML, Shapefile, GeoTIFF)
 * - LiDAR point cloud processing (LAS, LAZ, PLY, PCD, E57)
 * - Hyperspectral data analysis
 * - SAR imagery processing
 * - Thermal imaging analysis
 * - Multi-modal geospatial fusion
 */

import { config } from '../config';
import { logger } from '../utils/logger';

// ============================================================================
// Types
// ============================================================================

/**
 * Geospatial processing options
 */
export interface GeoProcessingOptions {
  extractMetadata?: boolean;
  analyzeGeometry?: boolean;
  detectAnomalies?: boolean;
  generateThumbnail?: boolean;
  convertFormat?: string;
  coordinateSystem?: string; // e.g., 'EPSG:4326'
}

/**
 * LiDAR processing options
 */
export interface LiDARProcessingOptions {
  generateDEM?: boolean;      // Digital Elevation Model
  generateDSM?: boolean;      // Digital Surface Model
  generateCHM?: boolean;      // Canopy Height Model
  classifyGround?: boolean;
  extractBuildings?: boolean;
  extractVegetation?: boolean;
  outputFormat?: 'las' | 'laz' | 'geotiff' | 'xyz';
}

/**
 * Request to process a geospatial file
 */
export interface ProcessGeoRequest {
  userId: string;
  filename: string;
  fileUrl?: string;  // HTTP/HTTPS or file:// path
  options: GeoProcessingOptions;
  priority?: number;
  metadata?: Record<string, unknown>;
}

/**
 * Request to process a LiDAR file
 */
export interface ProcessLiDARRequest {
  userId: string;
  filename: string;
  fileUrl?: string;
  options: LiDARProcessingOptions;
  priority?: number;
  metadata?: Record<string, unknown>;
}

/**
 * Response from geospatial processing job creation
 */
export interface GeoJobResponse {
  success: boolean;
  jobId: string;
  status: 'queued' | 'processing' | 'completed' | 'failed';
  message?: string;
  statusUrl?: string;
  estimatedTime?: number;
}

/**
 * Geospatial processing job status
 */
export interface GeoJobStatus {
  jobId: string;
  status: 'waiting' | 'active' | 'completed' | 'failed' | 'pending' | 'running';
  state?: string;
  progress: number;
  result?: GeoProcessingResult;
  error?: string;
  createdAt?: string;
  processedAt?: string;
  completedAt?: string;
}

/**
 * Geospatial processing result
 */
export interface GeoProcessingResult {
  metadata?: {
    bounds?: { minX: number; minY: number; maxX: number; maxY: number };
    crs?: string;
    featureCount?: number;
    geometryType?: string;
    fileSize?: number;
  };
  artifacts?: string[];
  summary?: string;
  layers?: Array<{ name: string; featureCount: number; geometryType: string }>;
  thumbnail?: string;
}

/**
 * LiDAR processing result
 */
export interface LiDARProcessingResult {
  metadata?: {
    pointCount: number;
    bounds: { minX: number; minY: number; minZ: number; maxX: number; maxY: number; maxZ: number };
    classifications?: Record<string, number>;
    fileSize?: number;
  };
  artifacts?: string[];
  dem?: string;  // Path to DEM file
  dsm?: string;  // Path to DSM file
  chm?: string;  // Path to CHM file
  summary?: string;
}

/**
 * Health check response
 */
export interface GeoHealthStatus {
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
    name: string = 'geoagent'
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
          `Circuit breaker OPEN - GeoAgent unavailable (last failure: ${this.lastFailureTime?.toISOString()})`
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
// GeoAgentClient
// ============================================================================

export class GeoAgentClient {
  private circuitBreaker: CircuitBreaker;
  private baseUrl: string;
  private internalApiKey: string;

  // Configuration
  private readonly DEFAULT_TIMEOUT_MS = 600000; // 10 minutes (geo processing can be slow)
  private readonly MAX_POLL_ATTEMPTS = 360; // 360 * 5s = 30 minutes
  private readonly POLL_INTERVAL_MS = 5000; // 5 seconds

  constructor(baseUrl?: string) {
    // Use config or environment variable or default
    this.baseUrl = baseUrl ||
      config.geoagentUrl ||
      process.env.GEOAGENT_URL ||
      'http://nexus-geoagent:9103';

    // Internal service API key for service-to-service auth
    this.internalApiKey = process.env.INTERNAL_SERVICE_API_KEY ||
      process.env.API_KEY ||
      'brain_0T5uLPyy3j3RUdrJlFMY48VuN1a2ov9X';

    // Initialize circuit breaker
    this.circuitBreaker = new CircuitBreaker({
      failureThreshold: 3,
      successThreshold: 2,
      timeout: 30000, // 30 seconds in OPEN state
    }, 'geoagent');

    logger.info('GeoAgentClient initialized', {
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
   * Process a geospatial file (GeoJSON, KML, Shapefile, etc.)
   *
   * @param request - Geospatial processing request with options
   * @returns Geo job response with job ID for tracking
   */
  async processGeospatial(request: ProcessGeoRequest): Promise<GeoJobResponse> {
    return this.circuitBreaker.execute(async () => {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), this.DEFAULT_TIMEOUT_MS);

      try {
        logger.info('Processing geospatial file via GeoAgent', {
          filename: request.filename,
          fileUrl: request.fileUrl,
          userId: request.userId,
          options: request.options,
        });

        const response = await fetch(`${this.baseUrl}/api/v1/ingestion/upload`, {
          method: 'POST',
          headers: this.getAuthHeaders(),
          body: JSON.stringify({
            format: this.detectFormat(request.filename),
            data: request.fileUrl,
            layer_id: request.metadata?.layerId || `layer_${Date.now()}`,
            options: request.options,
            userId: request.userId,
          }),
          signal: controller.signal,
        });

        clearTimeout(timeoutId);

        if (!response.ok) {
          const errorText = await response.text().catch(() => 'Unable to read error');
          throw new Error(`GeoAgent returned HTTP ${response.status}: ${errorText}`);
        }

        const result = await response.json() as GeoJobResponse;

        logger.info('Geospatial processing job created', {
          jobId: result.jobId,
          status: result.status,
        });

        return result;
      } finally {
        clearTimeout(timeoutId);
      }
    });
  }

  /**
   * Process a LiDAR point cloud file
   *
   * @param request - LiDAR processing request with options
   * @returns Geo job response with job ID for tracking
   */
  async processLiDAR(request: ProcessLiDARRequest): Promise<GeoJobResponse> {
    return this.circuitBreaker.execute(async () => {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), this.DEFAULT_TIMEOUT_MS);

      try {
        logger.info('Processing LiDAR file via GeoAgent', {
          filename: request.filename,
          fileUrl: request.fileUrl,
          userId: request.userId,
          options: request.options,
        });

        // Use HyperModal LiDAR endpoint
        const response = await fetch(`${this.baseUrl}/api/v1/hypermodal/lidar/ingest`, {
          method: 'POST',
          headers: {
            ...this.getAuthHeaders(),
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            fileUrl: request.fileUrl,
            filename: request.filename,
            userId: request.userId,
            options: request.options,
            priority: request.priority || 5,
            metadata: request.metadata,
          }),
          signal: controller.signal,
        });

        clearTimeout(timeoutId);

        if (!response.ok) {
          const errorText = await response.text().catch(() => 'Unable to read error');
          throw new Error(`GeoAgent LiDAR returned HTTP ${response.status}: ${errorText}`);
        }

        const result = await response.json() as GeoJobResponse;

        logger.info('LiDAR processing job created', {
          jobId: result.jobId,
          status: result.status,
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
  async getJobStatus(jobId: string): Promise<GeoJobStatus> {
    return this.circuitBreaker.execute(async () => {
      const response = await fetch(`${this.baseUrl}/api/v1/hypermodal/jobs/${jobId}`, {
        method: 'GET',
        headers: this.getAuthHeaders(),
      });

      if (!response.ok) {
        throw new Error(`Failed to get job status: HTTP ${response.status}`);
      }

      return await response.json() as GeoJobStatus;
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
      const response = await fetch(`${this.baseUrl}/api/v1/hypermodal/jobs/${jobId}/cancel`, {
        method: 'POST',
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
   * @param timeout - Optional timeout in milliseconds (default: 10 minutes)
   * @returns Processing result when job completes
   */
  async waitForCompletion(
    jobId: string,
    timeout?: number
  ): Promise<GeoProcessingResult | LiDARProcessingResult> {
    const maxTime = timeout || this.DEFAULT_TIMEOUT_MS;
    const startTime = Date.now();
    let attempts = 0;

    logger.info('Waiting for geospatial processing job completion', {
      jobId,
      timeoutMs: maxTime,
    });

    while (Date.now() - startTime < maxTime && attempts < this.MAX_POLL_ATTEMPTS) {
      const status = await this.getJobStatus(jobId);

      if (status.status === 'completed' || status.state === 'completed') {
        if (!status.result) {
          throw new Error('Job completed but no result available');
        }
        logger.info('Geospatial processing job completed', {
          jobId,
          attempts,
          elapsedMs: Date.now() - startTime,
        });
        return status.result;
      }

      if (status.status === 'failed' || status.state === 'failed') {
        throw new Error(`Geospatial processing job failed: ${status.error || 'Unknown error'}`);
      }

      // Wait before next poll
      await this.delay(this.POLL_INTERVAL_MS);
      attempts++;

      if (attempts % 6 === 0) { // Log every 30 seconds
        logger.debug('Waiting for GeoAgent job completion', {
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

    throw new Error(`Geospatial processing job timed out after ${maxTime}ms`);
  }

  /**
   * Process geospatial file and wait for completion in one call
   *
   * @param request - Geospatial processing request
   * @param timeout - Optional timeout in milliseconds
   * @returns Processing result when job completes
   */
  async processGeospatialAndWait(
    request: ProcessGeoRequest,
    timeout?: number
  ): Promise<GeoProcessingResult> {
    logger.info('Processing geospatial file and waiting for completion', {
      filename: request.filename,
      fileUrl: request.fileUrl,
      timeout,
    });

    const job = await this.processGeospatial(request);
    return this.waitForCompletion(job.jobId, timeout) as Promise<GeoProcessingResult>;
  }

  /**
   * Process LiDAR file and wait for completion in one call
   *
   * @param request - LiDAR processing request
   * @param timeout - Optional timeout in milliseconds
   * @returns Processing result when job completes
   */
  async processLiDARAndWait(
    request: ProcessLiDARRequest,
    timeout?: number
  ): Promise<LiDARProcessingResult> {
    logger.info('Processing LiDAR file and waiting for completion', {
      filename: request.filename,
      fileUrl: request.fileUrl,
      timeout,
    });

    const job = await this.processLiDAR(request);
    return this.waitForCompletion(job.jobId, timeout) as Promise<LiDARProcessingResult>;
  }

  /**
   * Health check
   *
   * @returns Health status of GeoAgent service
   */
  async healthCheck(): Promise<{ status: 'healthy' | 'unhealthy'; details?: unknown }> {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 5000);

      const response = await fetch(`${this.baseUrl}/health`, {
        signal: controller.signal,
      }).catch(() => null);

      clearTimeout(timeoutId);

      if (!response || !response.ok) {
        return { status: 'unhealthy' };
      }

      const data = await response.json() as GeoHealthStatus;
      return {
        status: data.status === 'healthy' ? 'healthy' : 'unhealthy',
        details: data,
      };
    } catch (error) {
      logger.warn('GeoAgent health check failed', {
        error: error instanceof Error ? error.message : String(error),
      });
      return { status: 'unhealthy' };
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
    logger.info('GeoAgent circuit breaker manually reset');
  }

  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Detect file format from filename
   */
  private detectFormat(filename: string): string {
    const ext = filename.split('.').pop()?.toLowerCase() || '';
    const formatMap: Record<string, string> = {
      'geojson': 'geojson',
      'json': 'geojson',
      'kml': 'kml',
      'kmz': 'kmz',
      'shp': 'shapefile',
      'gpx': 'gpx',
      'gml': 'gml',
      'tiff': 'geotiff',
      'tif': 'geotiff',
      'gpkg': 'geopackage',
      'las': 'las',
      'laz': 'laz',
      'ply': 'ply',
      'pcd': 'pcd',
      'e57': 'e57',
      'xyz': 'xyz',
    };
    return formatMap[ext] || 'unknown';
  }

  /**
   * Check if a MIME type or filename is a geospatial file that should be
   * routed to GeoAgent for processing.
   *
   * @param mimeType - MIME type of the file
   * @param filename - Optional filename for extension checking
   * @returns True if file is a geospatial type
   */
  static isGeospatialFileType(mimeType: string, filename?: string): boolean {
    const geoMimeTypes = new Set([
      'application/geo+json',
      'application/vnd.geo+json',
      'application/vnd.google-earth.kml+xml',
      'application/vnd.google-earth.kmz',
      'application/gml+xml',
      'application/gpx+xml',
      'image/tiff',
      'application/x-shapefile',
      'application/x-esri-shapefile',
      'application/vnd.shp',
    ]);

    if (geoMimeTypes.has(mimeType)) {
      return true;
    }

    if (filename) {
      const ext = filename.split('.').pop()?.toLowerCase();
      const geoExtensions = new Set([
        'geojson', 'kml', 'kmz', 'shp', 'shx', 'dbf', 'prj',
        'gpx', 'gml', 'gpkg', 'mbtiles', 'topojson',
      ]);

      if (ext && geoExtensions.has(ext)) {
        return true;
      }
    }

    return false;
  }

  /**
   * Check if a MIME type or filename is a point cloud file that should be
   * routed to GeoAgent for LiDAR processing.
   *
   * @param mimeType - MIME type of the file
   * @param filename - Optional filename for extension checking
   * @returns True if file is a point cloud type
   */
  static isPointCloudFileType(_mimeType: string, filename?: string): boolean {
    if (filename) {
      const ext = filename.split('.').pop()?.toLowerCase();
      const pointCloudExtensions = new Set([
        'las', 'laz', 'ply', 'pcd', 'xyz', 'pts', 'ptx', 'e57', 'asc',
      ]);

      if (ext && pointCloudExtensions.has(ext)) {
        return true;
      }
    }

    return false;
  }
}

// ============================================================================
// Singleton
// ============================================================================

let geoAgentClientInstance: GeoAgentClient | null = null;

/**
 * Get or create the singleton GeoAgent client instance
 *
 * @returns Singleton GeoAgentClient instance
 */
export function getGeoAgentClient(): GeoAgentClient {
  if (!geoAgentClientInstance) {
    geoAgentClientInstance = new GeoAgentClient();
  }
  return geoAgentClientInstance;
}

/**
 * Reset the singleton instance (for testing)
 */
export function resetGeoAgentClient(): void {
  geoAgentClientInstance = null;
}
