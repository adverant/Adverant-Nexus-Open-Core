import axios, { AxiosInstance } from 'axios';
import axiosRetry from 'axios-retry';
import { Agent as HttpAgent } from 'http';
import { Agent as HttpsAgent } from 'https';
import { logger } from '../utils/logger';
import { config } from '../config';
import { createCircuitBreaker, ServiceCircuitBreaker } from '../utils/circuit-breaker';
import { ResilienceManager } from '../utils/resilience-manager';
import { GoogleAuth } from 'google-auth-library';

/**
 * Request interface for Earth Engine image analysis
 */
export interface EarthEngineImageRequest {
  assetId: string;
  geometry?: GeoJSON.Geometry;
  scale?: number; // meters
  bands?: string[];
  startDate?: string;
  endDate?: string;
}

/**
 * Request interface for regional statistical analysis
 */
export interface EarthEngineAnalysisRequest {
  imageCollection: string;
  geometry: GeoJSON.Geometry;
  reducer: 'mean' | 'median' | 'sum' | 'min' | 'max' | 'count';
  scale: number;
  bands: string[];
  dateRange?: { start: string; end: string };
}

/**
 * Request interface for time series extraction
 */
export interface EarthEngineTimeSeriesRequest {
  imageCollection: string;
  geometry: GeoJSON.Geometry;
  bands: string[];
  scale: number;
  interval: 'day' | 'week' | 'month' | 'year';
  startDate: string;
  endDate: string;
}

/**
 * Response interface for Earth Engine analysis
 */
export interface EarthEngineAnalysisResult {
  [band: string]: number;
  metadata?: {
    pixelCount?: number;
    imageCount?: number;
    processedArea?: number;
  };
}

/**
 * Response interface for time series data
 */
export interface EarthEngineTimeSeriesResult {
  timeSeries: Array<{
    date: string;
    values: { [band: string]: number };
  }>;
  metadata: {
    totalImages: number;
    dateRange: { start: string; end: string };
  };
}

/**
 * Google Earth Engine Client
 *
 * Provides access to Google Earth Engine's planetary-scale satellite imagery
 * and geospatial datasets for analysis and monitoring.
 *
 * Features:
 * - Satellite imagery analysis (Landsat, Sentinel, MODIS, etc.)
 * - Time series extraction for change detection
 * - Regional statistics (NDVI, EVI, land cover, etc.)
 * - Circuit breaker for reliability
 * - Automatic retries with exponential backoff
 * - Request caching (5-minute TTL)
 */
export class GoogleEarthEngineClient {
  private httpClient: AxiosInstance;
  private endpoint: string;
  private circuitBreaker: ServiceCircuitBreaker;
  private resilienceManager: ResilienceManager;
  private httpAgent!: HttpAgent;
  private httpsAgent!: HttpsAgent;
  private auth: GoogleAuth;
  private projectId: string;
  private initialized: boolean = false;

  constructor() {
    this.endpoint = config.googleCloud?.earthEngine?.endpoint || 'https://earthengine.googleapis.com/v1';
    this.projectId = config.googleCloud?.projectId || '';

    if (!this.projectId) {
      logger.warn('Google Cloud Project ID not configured. Earth Engine client will fail on requests.');
    }

    // Initialize Google Auth
    this.auth = new GoogleAuth({
      keyFile: config.googleCloud?.keyFile,
      scopes: ['https://www.googleapis.com/auth/earthengine', 'https://www.googleapis.com/auth/cloud-platform']
    });

    this.httpClient = this.createHttpClient();

    // Initialize circuit breaker for Earth Engine requests
    // Earth Engine can be slow for large queries (up to 60 seconds)
    this.circuitBreaker = createCircuitBreaker('GoogleEarthEngine', async (fn: Function) => {
      return await fn();
    }, {
      timeout: 60000, // 60 seconds for complex Earth Engine operations
      errorThresholdPercentage: 30,
      resetTimeout: 120000, // 2 minutes before retrying
      volumeThreshold: 5
    });

    // Initialize resilience manager with Earth Engine-specific settings
    this.resilienceManager = new ResilienceManager({
      maxRetries: 3,
      initialRetryDelay: 1000,
      maxRetryDelay: 10000,
      cacheTTL: 300000, // Cache for 5 minutes (Earth Engine data is relatively static)
      deduplicationWindow: 5000,
      circuitBreakerThreshold: 3,
      circuitBreakerTimeout: 60000
    });

    logger.info(`GoogleEarthEngineClient initialized for project: ${this.projectId}`);
  }

  /**
   * Create HTTP client with authentication and retry logic
   */
  private createHttpClient(): AxiosInstance {
    // Create HTTP/HTTPS agents with connection pooling
    this.httpAgent = new HttpAgent({
      keepAlive: true,
      keepAliveMsecs: 30000,
      maxSockets: 50,
      maxFreeSockets: 10,
      timeout: 60000,
      scheduling: 'fifo'
    });

    this.httpsAgent = new HttpsAgent({
      keepAlive: true,
      keepAliveMsecs: 30000,
      maxSockets: 50,
      maxFreeSockets: 10,
      timeout: 60000,
      scheduling: 'fifo'
    });

    const client = axios.create({
      baseURL: this.endpoint,
      timeout: 60000,
      headers: {
        'Content-Type': 'application/json'
      },
      httpAgent: this.httpAgent,
      httpsAgent: this.httpsAgent
    });

    // Add authentication interceptor
    client.interceptors.request.use(async (config) => {
      try {
        const authClient = await this.auth.getClient();
        const token = await authClient.getAccessToken();

        if (token && token.token) {
          config.headers.Authorization = `Bearer ${token.token}`;
        } else {
          logger.error('Failed to obtain Google Cloud access token');
        }

        logger.debug(`Earth Engine Request: ${config.method?.toUpperCase()} ${config.url}`);
      } catch (error) {
        logger.error('Error obtaining Google Cloud credentials:', error);
        throw error;
      }

      return config;
    });

    // Add response interceptor for logging
    client.interceptors.response.use(
      (response) => {
        logger.debug(`Earth Engine Response: ${response.status} ${response.config.url}`);
        return response;
      },
      (error) => {
        if (error.response) {
          logger.error(
            `Earth Engine Error: ${error.response.status} ${error.response.config.url}`,
            error.response.data
          );
        } else {
          logger.error('Earth Engine Network Error:', error.message);
        }
        return Promise.reject(error);
      }
    );

    // Add retry logic with exponential backoff
    axiosRetry(client, {
      retries: 3,
      retryDelay: axiosRetry.exponentialDelay,
      retryCondition: (error) => {
        return (
          axiosRetry.isNetworkOrIdempotentRequestError(error) ||
          (error.response?.status ? error.response.status >= 500 : false)
        );
      },
      onRetry: (retryCount, _error, requestConfig) => {
        logger.warn(`Retrying Earth Engine request (attempt ${retryCount}): ${requestConfig.url}`);
      }
    });

    return client;
  }

  /**
   * Initialize Earth Engine connection
   * Must be called before using the client
   */
  async initialize(): Promise<void> {
    if (this.initialized) {
      return;
    }

    try {
      // Verify authentication by making a simple request
      await this.checkHealth();
      this.initialized = true;
      logger.info('Google Earth Engine client initialized successfully');
    } catch (error) {
      logger.error('Failed to initialize Google Earth Engine client:', error);
      throw new Error(`Earth Engine initialization failed: ${(error as Error).message}`);
    }
  }

  /**
   * Check if Earth Engine service is healthy and accessible
   */
  async checkHealth(): Promise<boolean> {
    try {
      // Make a simple request to verify connectivity and authentication
      // Use a public Earth Engine asset to test (SRTM elevation data)
      // This verifies both authentication and Earth Engine API access
      const response = await this.httpClient.get(
        `/projects/earthengine-public/assets/USGS/SRTMGL1_003`
      );
      return response.status === 200;
    } catch (error) {
      logger.error('Earth Engine health check failed:', error);
      return false;
    }
  }

  /**
   * Get image from Earth Engine by asset ID
   *
   * @param request - Image request parameters
   * @returns Image data
   */
  async getImage(request: EarthEngineImageRequest): Promise<any> {
    const cacheKey = ResilienceManager.generateKey('ee_get_image', request);

    return this.resilienceManager.execute(
      cacheKey,
      async () => {
        return this.circuitBreaker.fire(async () => {
          const params: any = {
            assetId: request.assetId,
            scale: request.scale || 30
          };

          if (request.geometry) {
            params.region = request.geometry;
          }

          if (request.bands) {
            params.bands = request.bands.join(',');
          }

          if (request.startDate && request.endDate) {
            params.startDate = request.startDate;
            params.endDate = request.endDate;
          }

          const response = await this.httpClient.post(
            `/projects/${this.projectId}/image:getPixels`,
            params
          );

          return response.data;
        });
      },
      false // Don't cache raw image data
    );
  }

  /**
   * Perform statistical analysis over a region
   *
   * Use this to calculate statistics (mean, median, sum, etc.) for satellite imagery
   * over a specific geographic area.
   *
   * Example: Calculate mean NDVI over a forest area
   *
   * @param request - Analysis request parameters
   * @returns Statistical results for each band
   */
  async analyzeRegion(request: EarthEngineAnalysisRequest): Promise<EarthEngineAnalysisResult> {
    const cacheKey = ResilienceManager.generateKey('ee_analyze_region', request);

    return this.resilienceManager.execute(
      cacheKey,
      async () => {
        return this.circuitBreaker.fire(async () => {
          const requestBody: any = {
            collection: request.imageCollection,
            geometry: request.geometry,
            reducer: request.reducer.toUpperCase(),
            scale: request.scale,
            bands: request.bands
          };

          if (request.dateRange) {
            requestBody.startDate = request.dateRange.start;
            requestBody.endDate = request.dateRange.end;
          }

          logger.info(
            `Analyzing region with ${request.imageCollection} (${request.bands.join(', ')}) using ${request.reducer} at ${request.scale}m resolution`
          );

          const response = await this.httpClient.post(
            `/projects/${this.projectId}/imageCollection:reduce`,
            requestBody
          );

          return response.data;
        });
      }
    );
  }

  /**
   * Get time series data for change detection and trend analysis
   *
   * Extract temporal data to analyze changes over time (e.g., vegetation changes,
   * urban growth, deforestation monitoring).
   *
   * @param request - Time series request parameters
   * @returns Time series data with values for each date
   */
  async getTimeSeries(request: EarthEngineTimeSeriesRequest): Promise<EarthEngineTimeSeriesResult> {
    const cacheKey = ResilienceManager.generateKey('ee_time_series', request);

    return this.resilienceManager.execute(
      cacheKey,
      async () => {
        return this.circuitBreaker.fire(async () => {
          logger.info(
            `Extracting time series from ${request.imageCollection} (${request.bands.join(', ')}) from ${request.startDate} to ${request.endDate}`
          );

          const response = await this.httpClient.post(
            `/projects/${this.projectId}/imageCollection:timeSeries`,
            {
              collection: request.imageCollection,
              geometry: request.geometry,
              bands: request.bands,
              scale: request.scale,
              interval: request.interval,
              startDate: request.startDate,
              endDate: request.endDate
            }
          );

          return response.data;
        });
      }
    );
  }

  /**
   * List available image collections
   *
   * @param query - Optional search query to filter collections
   * @returns List of available collections
   */
  async listCollections(query?: string): Promise<any> {
    return this.circuitBreaker.fire(async () => {
      const params: any = {};
      if (query) {
        params.query = query;
      }

      const response = await this.httpClient.get(
        `/projects/${this.projectId}/imagecollections`,
        { params }
      );

      return response.data;
    });
  }

  /**
   * Clean up resources
   * Call this when shutting down the client
   */
  async cleanup(): Promise<void> {
    logger.info('Cleaning up Google Earth Engine client resources');
    this.httpAgent.destroy();
    this.httpsAgent.destroy();
    this.initialized = false;
  }
}
