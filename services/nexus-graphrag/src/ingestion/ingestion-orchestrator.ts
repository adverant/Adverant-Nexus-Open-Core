/**
 * URL Ingestion Orchestrator
 *
 * High-level orchestrator that coordinates URL ingestion workflow:
 * 1. URL validation
 * 2. Resource discovery (single file or folder)
 * 3. User confirmation for recursive operations
 * 4. Job queue submission
 * 5. Progress monitoring
 *
 * Follows Facade Pattern to simplify complex interactions.
 */

import {
  ContentProviderRegistry,
  IContentProvider,
  FileDescriptor,
  DiscoveryOptions,
  ValidationResult,
  ContentProviderError,
} from '../providers/content-provider.interface.js';
import { HTTPProvider } from '../providers/http-provider.js';
import { GoogleDriveProvider } from '../providers/google-drive-provider.js';
import {
  IngestionJobQueue,
  IngestionOptions,
} from './ingestion-job.js';
import { logger } from '../utils/logger.js';
import { Redis } from 'ioredis';
import { GraphRAGStorageEngine } from '../storage/storage-engine.js';
import { GoogleOAuthManager } from '../auth/google-oauth-manager.js';

/**
 * Orchestrator configuration
 */
export interface OrchestratorConfig {
  /** Redis connection for job queue */
  redisConnection: Redis;

  /** GraphRAG storage engine for document storage */
  storageEngine: GraphRAGStorageEngine;

  /** Google Drive provider config (optional) */
  googleDriveConfig?: {
    clientId: string;
    clientSecret: string;
    redirectUri: string;
    apiKey?: string;
  };

  /** Google OAuth Manager (optional, recommended for authenticated Google Drive access) */
  googleOAuthManager?: GoogleOAuthManager;

  /** HTTP provider config (optional) */
  httpProviderConfig?: {
    timeout?: number;
    maxFileSize?: number;
    maxRetries?: number;
  };

  /** WebSocket server URL for progress events */
  websocketServerUrl?: string;
}

/**
 * Ingestion request
 */
export interface IngestionRequest {
  /** URL to ingest (file or folder) */
  url: string;

  /** Discovery options for folders */
  discoveryOptions?: DiscoveryOptions;

  /** Ingestion options */
  ingestionOptions?: IngestionOptions;

  /** User ID for tracking */
  userId?: string;

  /** Session ID for WebSocket room */
  sessionId?: string;

  /** Whether to skip confirmation (dangerous for large folders) */
  skipConfirmation?: boolean;
}

/**
 * Ingestion response
 */
export interface IngestionResponse {
  /** Job ID for tracking */
  jobId?: string;

  /** Validation result */
  validation: ValidationResult;

  /** Files discovered (for confirmation) */
  files?: FileDescriptor[];

  /** Whether confirmation is required */
  requiresConfirmation: boolean;

  /** Estimated processing time in seconds */
  estimatedProcessingTime?: number;

  /** Status message */
  message: string;
}

/**
 * URL Ingestion Orchestrator
 */
export class IngestionOrchestrator {
  private providerRegistry: ContentProviderRegistry;
  private jobQueue: IngestionJobQueue;
  private config: OrchestratorConfig;

  constructor(config: OrchestratorConfig) {
    this.config = config;

    // Initialize provider registry
    this.providerRegistry = new ContentProviderRegistry();

    // Register Google Drive provider FIRST (before HTTP) if configured
    // More specific providers must be registered before generic providers
    // to prevent HTTPProvider from intercepting Google Drive URLs
    if (config.googleDriveConfig) {
      const googleDriveProvider = new GoogleDriveProvider({
        oauthManager: config.googleOAuthManager, // Preferred: Use OAuth manager for dynamic auth
        credentials: {
          clientId: config.googleDriveConfig.clientId,
          clientSecret: config.googleDriveConfig.clientSecret,
          redirectUri: config.googleDriveConfig.redirectUri
        },
        apiKey: config.googleDriveConfig.apiKey // Fallback: Use API key for public files
      });
      this.providerRegistry.register(googleDriveProvider);
    }

    // Register HTTP provider LAST (fallback for non-Google Drive URLs)
    const httpProvider = new HTTPProvider(config.httpProviderConfig);
    this.providerRegistry.register(httpProvider);

    // Initialize job queue
    this.jobQueue = new IngestionJobQueue(
      config.redisConnection,
      this.providerRegistry,
      config.storageEngine
    );

    logger.info('IngestionOrchestrator initialized', {
      providers: this.providerRegistry.getProviders().map(p => p.name)
    });
  }

  /**
   * Initiate URL ingestion
   *
   * This is the main entry point for URL ingestion.
   * Returns immediately with job ID or confirmation request.
   */
  async ingest(request: IngestionRequest): Promise<IngestionResponse> {
    try {
      logger.info('Ingestion request received', {
        url: request.url,
        userId: request.userId
      });

      // Step 1: Get provider for URL
      const provider = this.providerRegistry.getProvider(request.url);

      logger.debug('Provider selected', {
        url: request.url,
        provider: provider.name
      });

      // Step 2: Validate URL
      const validation = await provider.validateURL(request.url);

      if (!validation.valid) {
        return {
          validation,
          requiresConfirmation: false,
          message: `Invalid URL: ${validation.error}`
        };
      }

      // Step 3: Handle based on resource type
      if (validation.type === 'file') {
        // Single file - submit directly
        const jobId = await this.ingestSingleFile(request, provider);

        return {
          jobId,
          validation,
          requiresConfirmation: false,
          message: `Ingestion job started: ${jobId}`
        };
      } else {
        // Folder - discover files first
        const files = await provider.discoverFiles(
          request.url,
          request.discoveryOptions || {}
        );

        logger.info('Files discovered', {
          url: request.url,
          fileCount: files.length
        });

        // Check if confirmation required
        const requiresConfirmation =
          !request.skipConfirmation &&
          (validation.requiresConfirmation || files.length > 10);

        if (requiresConfirmation) {
          // Return files for user confirmation
          return {
            validation,
            files,
            requiresConfirmation: true,
            estimatedProcessingTime: this.estimateProcessingTime(files.length),
            message: `Found ${files.length} files. Confirm to proceed.`
          };
        } else {
          // Submit job immediately
          const jobId = await this.ingestMultipleFiles(request, files);

          return {
            jobId,
            validation,
            files,
            requiresConfirmation: false,
            estimatedProcessingTime: this.estimateProcessingTime(files.length),
            message: `Ingestion job started: ${jobId} (${files.length} files)`
          };
        }
      }
    } catch (error) {
      logger.error('Ingestion request failed', {
        url: request.url,
        error: (error as Error).message
      });

      if (error instanceof ContentProviderError) {
        return {
          validation: {
            valid: false,
            error: error.message
          },
          requiresConfirmation: false,
          message: error.message
        };
      }

      throw error;
    }
  }

  /**
   * Confirm and proceed with ingestion
   *
   * Called after user confirms recursive folder ingestion.
   */
  async confirmAndIngest(
    files: FileDescriptor[],
    options: IngestionOptions = {}
  ): Promise<string> {
    logger.info('Ingestion confirmed', {
      fileCount: files.length
    });

    // Merge options with WebSocket URL
    const ingestionOptions: IngestionOptions = {
      ...options,
      websocketServerUrl: options.websocketServerUrl || this.config.websocketServerUrl
    };

    // Submit job
    const jobId = await this.jobQueue.addJob(files, ingestionOptions);

    logger.info('Confirmed ingestion job started', {
      jobId,
      fileCount: files.length
    });

    return jobId;
  }

  /**
   * Get job status
   */
  async getJobStatus(jobId: string): Promise<any> {
    return this.jobQueue.getJobStatus(jobId);
  }

  /**
   * Cancel job
   */
  async cancelJob(jobId: string): Promise<boolean> {
    return this.jobQueue.cancelJob(jobId);
  }

  /**
   * Ingest single file
   */
  private async ingestSingleFile(
    request: IngestionRequest,
    _provider: IContentProvider
  ): Promise<string> {
    // Create file descriptor
    const fileDescriptor: FileDescriptor = {
      url: request.url,
      filename: this.extractFilename(request.url),
      depth: 0
    };

    // Merge options with WebSocket URL
    const ingestionOptions: IngestionOptions = {
      ...request.ingestionOptions,
      websocketServerUrl:
        request.ingestionOptions?.websocketServerUrl || this.config.websocketServerUrl
    };

    // Submit job
    return this.jobQueue.addJob([fileDescriptor], ingestionOptions);
  }

  /**
   * Ingest multiple files
   */
  private async ingestMultipleFiles(
    request: IngestionRequest,
    files: FileDescriptor[]
  ): Promise<string> {
    // Merge options with WebSocket URL
    const ingestionOptions: IngestionOptions = {
      ...request.ingestionOptions,
      websocketServerUrl:
        request.ingestionOptions?.websocketServerUrl || this.config.websocketServerUrl
    };

    // Submit job
    return this.jobQueue.addJob(files, ingestionOptions);
  }

  /**
   * Extract filename from URL
   */
  private extractFilename(url: string): string {
    try {
      const parsed = new URL(url);
      const segments = parsed.pathname.split('/').filter(s => s.length > 0);

      if (segments.length > 0) {
        return decodeURIComponent(segments[segments.length - 1]);
      }

      return `file-${Date.now()}`;
    } catch {
      return `file-${Date.now()}`;
    }
  }

  /**
   * Estimate processing time in seconds
   */
  private estimateProcessingTime(fileCount: number): number {
    // Rough estimate: 5 seconds per file with concurrency of 5
    const concurrency = 5;
    const secondsPerFile = 5;

    return Math.ceil((fileCount * secondsPerFile) / concurrency);
  }

  /**
   * Graceful shutdown
   */
  async shutdown(): Promise<void> {
    logger.info('Shutting down IngestionOrchestrator...');
    await this.jobQueue.shutdown();
    logger.info('IngestionOrchestrator shutdown complete');
  }
}
