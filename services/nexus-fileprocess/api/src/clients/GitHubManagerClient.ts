/**
 * GitHubManagerClient for FileProcessAgent
 *
 * HTTP client for Nexus GitHub Manager service - handles GitHub repository
 * ingestion into GraphRAG memory. Provides full repository digital twin
 * capabilities including:
 * - AST parsing with Tree-sitter
 * - Neo4j code graphs
 * - Voyage AI code embeddings
 * - Qdrant vector search
 *
 * Design Pattern: Facade Pattern + Circuit Breaker
 * SOLID Principles:
 * - Single Responsibility: Only handles GitHub Manager communication
 * - Dependency Inversion: Depends on interfaces, not implementations
 *
 * Use Cases for FileProcessAgent:
 * - GitHub repository URL processing
 * - Full repository ingestion into memory
 * - Code search and analysis
 * - Repository sync and update
 */

import { config } from '../config';
import { logger } from '../utils/logger';

// ============================================================================
// Types
// ============================================================================

/**
 * Repository connection request
 */
export interface ConnectRepositoryRequest {
  /** GitHub repository URL (https://github.com/owner/repo) */
  url: string;
  /** Optional GitHub access token for private repos */
  accessToken?: string;
  /** Optional GitHub App installation ID */
  installationId?: number;
  /** Sync options */
  syncOptions?: {
    /** Include file content in graph */
    includeContent?: boolean;
    /** Parse AST for code files */
    parseAst?: boolean;
    /** Generate code embeddings */
    generateEmbeddings?: boolean;
    /** Branch to sync (default: default branch) */
    branch?: string;
  };
}

/**
 * Response from connecting a repository
 */
export interface ConnectRepositoryResponse {
  success: boolean;
  data?: {
    repository: {
      id: string;
      owner: string;
      name: string;
      fullName: string;
      visibility: 'public' | 'private';
      defaultBranch: string;
      status: 'pending' | 'syncing' | 'synced' | 'error';
      createdAt: string;
      updatedAt: string;
    };
  };
  error?: {
    message: string;
    code: string;
  };
}

/**
 * Sync job request
 */
export interface SyncRepositoryRequest {
  /** Sync type: initial (full), incremental, or manual */
  type?: 'initial' | 'incremental' | 'manual';
  /** GitHub access token for private repositories */
  accessToken?: string;
  /** Specific commit to sync from */
  fromCommit?: string;
  /** Specific commit to sync to */
  toCommit?: string;
  /** Specific file paths to sync */
  filePaths?: string[];
}

/**
 * Sync job response
 */
export interface SyncJobResponse {
  success: boolean;
  message?: string;
  data?: {
    jobId: string;
    type: 'initial' | 'incremental' | 'manual';
    status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
    createdAt: string;
  };
  error?: {
    message: string;
    code: string;
  };
}

/**
 * Sync status response
 */
export interface SyncStatusResponse {
  success: boolean;
  data?: {
    state: 'idle' | 'syncing' | 'queued' | 'error';
    currentJob?: {
      id: string;
      type: string;
      status: string;
      startedAt?: string;
      stats?: Record<string, number>;
      progress?: {
        phase: string;
        current: number;
        total: number;
        currentFile?: string;
        message?: string;
      };
    };
    activeJobs: Array<{
      id: string;
      type: string;
      status: string;
      createdAt: string;
    }>;
    lastSync?: string;
    lastSyncCommit?: string;
    syncStats?: SyncStats;
  };
  error?: {
    message: string;
    code: string;
  };
}

/**
 * Sync statistics
 */
export interface SyncStats {
  totalFiles: number;
  parsedFiles: number;
  entitiesExtracted: number;
  lastSyncDurationMs: number;
}

/**
 * Repository details response
 */
export interface RepositoryDetailsResponse {
  success: boolean;
  data?: {
    repository: {
      id: string;
      owner: string;
      name: string;
      fullName: string;
      visibility: 'public' | 'private';
      defaultBranch: string;
      status: string;
      lastSyncedAt?: string;
      lastSyncedCommit?: string;
      createdAt: string;
      updatedAt: string;
    };
    stats?: {
      totalFiles: number;
      parsedFiles: number;
      entitiesExtracted: number;
    };
  };
  error?: {
    message: string;
    code: string;
  };
}

/**
 * Health check response
 */
export interface GitHubManagerHealthStatus {
  success: boolean;
  service: string;
  status: 'healthy' | 'degraded' | 'unhealthy';
  version?: string;
  timestamp?: string;
  uptime?: number;
  database?: {
    postgres: boolean;
    neo4j: boolean;
    qdrant: boolean;
    redis: boolean;
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
    name: string = 'github-manager'
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
          `Circuit breaker OPEN - GitHub Manager unavailable (last failure: ${this.lastFailureTime?.toISOString()})`
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
// GitHubManagerClient
// ============================================================================

export class GitHubManagerClient {
  private circuitBreaker: CircuitBreaker;
  private baseUrl: string;
  private internalApiKey: string;

  // Configuration
  private readonly DEFAULT_TIMEOUT_MS = 600000; // 10 minutes (repo ingestion can be slow)
  private readonly MAX_POLL_ATTEMPTS = 300; // 300 * 2s = 10 minutes
  private readonly POLL_INTERVAL_MS = 2000; // 2 seconds

  constructor(baseUrl?: string) {
    // Use config or environment variable or default
    this.baseUrl = baseUrl ||
      config.githubManagerUrl ||
      process.env.GITHUB_MANAGER_URL ||
      'http://nexus-github-manager:9110';

    // Internal service API key for service-to-service auth
    this.internalApiKey = process.env.INTERNAL_SERVICE_API_KEY ||
      process.env.API_KEY ||
      'brain_0T5uLPyy3j3RUdrJlFMY48VuN1a2ov9X';

    // Initialize circuit breaker with higher thresholds for long-running operations
    this.circuitBreaker = new CircuitBreaker({
      failureThreshold: 3,
      successThreshold: 2,
      timeout: 60000, // 60 seconds in OPEN state
    }, 'github-manager');

    logger.info('GitHubManagerClient initialized', {
      baseUrl: this.baseUrl,
      timeout: `${this.DEFAULT_TIMEOUT_MS}ms`,
      hasApiKey: !!this.internalApiKey,
    });
  }

  /**
   * Get common headers for all requests including auth
   */
  private getAuthHeaders(tenantContext?: {
    companyId: string;
    appId: string;
    userId?: string;
  }): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'User-Agent': 'FileProcessAgent/1.0',
      'X-API-Key': this.internalApiKey,
      'X-Internal-Service': 'nexus-fileprocess',
    };

    // Add tenant context headers if provided
    if (tenantContext) {
      headers['X-Company-ID'] = tenantContext.companyId;
      headers['X-App-ID'] = tenantContext.appId;
      if (tenantContext.userId) {
        headers['X-User-ID'] = tenantContext.userId;
      }
    }

    return headers;
  }

  /**
   * Connect a GitHub repository for ingestion
   *
   * This method:
   * 1. Creates a repository record in GitHub Manager
   * 2. Queues an initial sync job
   * 3. Returns the repository details
   *
   * @param request - Repository connection request with URL and options
   * @param tenantContext - Tenant context for multi-tenancy
   * @returns Repository connection response
   */
  async connectRepository(
    request: ConnectRepositoryRequest,
    tenantContext: { companyId: string; appId: string; userId?: string }
  ): Promise<ConnectRepositoryResponse> {
    return this.circuitBreaker.execute(async () => {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 30000); // 30s for connect

      try {
        logger.info('Connecting GitHub repository via GitHub Manager', {
          url: request.url,
          companyId: tenantContext.companyId,
        });

        const response = await fetch(`${this.baseUrl}/api/github/repositories`, {
          method: 'POST',
          headers: this.getAuthHeaders(tenantContext),
          body: JSON.stringify(request),
          signal: controller.signal,
        });

        clearTimeout(timeoutId);

        const result = await response.json() as ConnectRepositoryResponse;

        if (!response.ok) {
          logger.error('Failed to connect repository', {
            status: response.status,
            error: result.error,
          });
          return result;
        }

        logger.info('Repository connected successfully', {
          repositoryId: result.data?.repository.id,
          fullName: result.data?.repository.fullName,
          status: result.data?.repository.status,
        });

        return result;
      } finally {
        clearTimeout(timeoutId);
      }
    });
  }

  /**
   * Trigger a sync for a connected repository
   *
   * @param repositoryId - ID of the connected repository
   * @param request - Sync options (type, commit range, file paths)
   * @param tenantContext - Tenant context for multi-tenancy
   * @returns Sync job response
   */
  async triggerSync(
    repositoryId: string,
    request: SyncRepositoryRequest,
    tenantContext: { companyId: string; appId: string; userId?: string }
  ): Promise<SyncJobResponse> {
    return this.circuitBreaker.execute(async () => {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 30000);

      try {
        logger.info('Triggering repository sync', {
          repositoryId,
          type: request.type || 'incremental',
          companyId: tenantContext.companyId,
          hasAccessToken: !!request.accessToken,
        });

        const response = await fetch(
          `${this.baseUrl}/api/github/repositories/${repositoryId}/sync`,
          {
            method: 'POST',
            headers: this.getAuthHeaders(tenantContext),
            body: JSON.stringify(request),
            signal: controller.signal,
          }
        );

        clearTimeout(timeoutId);

        const result = await response.json() as SyncJobResponse;

        if (!response.ok) {
          logger.error('Failed to trigger sync', {
            status: response.status,
            error: result.error,
          });
          return result;
        }

        logger.info('Sync job queued', {
          jobId: result.data?.jobId,
          type: result.data?.type,
          status: result.data?.status,
        });

        return result;
      } finally {
        clearTimeout(timeoutId);
      }
    });
  }

  /**
   * Get sync status for a repository
   *
   * @param repositoryId - ID of the repository
   * @param tenantContext - Tenant context for multi-tenancy
   * @returns Sync status response
   */
  async getSyncStatus(
    repositoryId: string,
    tenantContext: { companyId: string; appId: string; userId?: string }
  ): Promise<SyncStatusResponse> {
    return this.circuitBreaker.execute(async () => {
      const response = await fetch(
        `${this.baseUrl}/api/github/repositories/${repositoryId}/sync/status`,
        {
          method: 'GET',
          headers: this.getAuthHeaders(tenantContext),
        }
      );

      const result = await response.json() as SyncStatusResponse;

      if (!response.ok) {
        logger.warn('Failed to get sync status', {
          status: response.status,
          error: result.error,
        });
      }

      return result;
    });
  }

  /**
   * Get repository details
   *
   * @param repositoryId - ID of the repository
   * @param tenantContext - Tenant context for multi-tenancy
   * @returns Repository details response
   */
  async getRepository(
    repositoryId: string,
    tenantContext: { companyId: string; appId: string; userId?: string }
  ): Promise<RepositoryDetailsResponse> {
    return this.circuitBreaker.execute(async () => {
      const response = await fetch(
        `${this.baseUrl}/api/github/repositories/${repositoryId}`,
        {
          method: 'GET',
          headers: this.getAuthHeaders(tenantContext),
        }
      );

      return await response.json() as RepositoryDetailsResponse;
    });
  }

  /**
   * Find repository by full name (owner/repo)
   *
   * @param fullName - Full repository name (e.g., "adverant/nexus-cli")
   * @param tenantContext - Tenant context for multi-tenancy
   * @returns Repository if found, null otherwise
   */
  async findRepositoryByFullName(
    fullName: string,
    tenantContext: { companyId: string; appId: string; userId?: string }
  ): Promise<RepositoryDetailsResponse['data'] | null> {
    return this.circuitBreaker.execute(async () => {
      // List repositories and find by full name
      const response = await fetch(
        `${this.baseUrl}/api/github/repositories?search=${encodeURIComponent(fullName)}`,
        {
          method: 'GET',
          headers: this.getAuthHeaders(tenantContext),
        }
      );

      if (!response.ok) {
        return null;
      }

      const result = await response.json() as {
        success: boolean;
        data?: {
          repositories: Array<{
            id: string;
            fullName: string;
            [key: string]: unknown;
          }>;
        };
      };

      if (!result.success || !result.data?.repositories) {
        return null;
      }

      // Find exact match
      const repo = result.data.repositories.find(
        r => r.fullName.toLowerCase() === fullName.toLowerCase()
      );

      if (!repo) {
        return null;
      }

      // Fetch full details
      const detailsResponse = await this.getRepository(repo.id, tenantContext);
      return detailsResponse.data || null;
    });
  }

  /**
   * Connect repository and wait for initial sync to complete
   *
   * This is a convenience method that:
   * 1. Connects the repository
   * 2. Waits for the initial sync to complete
   * 3. Returns the final repository state
   *
   * @param request - Repository connection request
   * @param tenantContext - Tenant context
   * @param timeout - Optional timeout in milliseconds
   * @returns Repository details after sync completes
   */
  async connectAndWaitForSync(
    request: ConnectRepositoryRequest,
    tenantContext: { companyId: string; appId: string; userId?: string },
    timeout?: number
  ): Promise<{
    success: boolean;
    repository?: RepositoryDetailsResponse['data'];
    syncStats?: SyncStats;
    error?: string;
  }> {
    logger.info('Connecting repository and waiting for sync', {
      url: request.url,
      timeout: timeout || this.DEFAULT_TIMEOUT_MS,
    });

    // Step 1: Connect the repository
    const connectResult = await this.connectRepository(request, tenantContext);

    if (!connectResult.success || !connectResult.data?.repository) {
      return {
        success: false,
        error: connectResult.error?.message || 'Failed to connect repository',
      };
    }

    const repositoryId = connectResult.data.repository.id;

    // Step 2: Wait for sync to complete
    const maxTime = timeout || this.DEFAULT_TIMEOUT_MS;
    const startTime = Date.now();
    let attempts = 0;

    while (Date.now() - startTime < maxTime && attempts < this.MAX_POLL_ATTEMPTS) {
      const statusResult = await this.getSyncStatus(repositoryId, tenantContext);

      if (!statusResult.success) {
        logger.warn('Failed to get sync status during wait', {
          repositoryId,
          attempt: attempts,
        });
        await this.delay(this.POLL_INTERVAL_MS);
        attempts++;
        continue;
      }

      const state = statusResult.data?.state;

      // Check if sync completed
      if (state === 'idle' && statusResult.data?.lastSync) {
        logger.info('Repository sync completed', {
          repositoryId,
          attempts,
          elapsedMs: Date.now() - startTime,
          syncStats: statusResult.data?.syncStats,
        });

        // Fetch final repository state
        const repoDetails = await this.getRepository(repositoryId, tenantContext);

        return {
          success: true,
          repository: repoDetails.data,
          syncStats: statusResult.data?.syncStats,
        };
      }

      // Check for error state
      if (state === 'error') {
        return {
          success: false,
          error: 'Repository sync failed',
        };
      }

      // Still syncing - wait and poll again
      await this.delay(this.POLL_INTERVAL_MS);
      attempts++;

      if (attempts % 15 === 0) {
        logger.debug('Waiting for repository sync', {
          repositoryId,
          state,
          attempts,
          elapsedMs: Date.now() - startTime,
          progress: statusResult.data?.currentJob?.progress,
        });
      }
    }

    // Timeout
    return {
      success: false,
      error: `Repository sync timed out after ${maxTime}ms`,
    };
  }

  /**
   * Process a GitHub repository URL
   *
   * This is the main entry point for FileProcessAgent. It:
   * 1. Checks if repository is already connected
   * 2. If not, connects and syncs it
   * 3. If yes, optionally triggers an incremental sync
   *
   * @param url - GitHub repository URL
   * @param tenantContext - Tenant context
   * @param options - Processing options
   * @returns Processing result
   */
  async processGitHubRepo(
    url: string,
    tenantContext: { companyId: string; appId: string; userId?: string },
    options?: {
      forceResync?: boolean;
      waitForCompletion?: boolean;
      timeout?: number;
      /** GitHub access token for private repositories */
      accessToken?: string;
    }
  ): Promise<{
    success: boolean;
    repositoryId?: string;
    fullName?: string;
    status: 'connected' | 'syncing' | 'synced' | 'error';
    isNewConnection: boolean;
    syncStats?: SyncStats;
    error?: string;
  }> {
    const { forceResync = false, waitForCompletion = true, timeout, accessToken } = options || {};

    logger.info('Processing GitHub repository URL', {
      url,
      forceResync,
      waitForCompletion,
      companyId: tenantContext.companyId,
      hasAccessToken: !!accessToken,
    });

    // Extract owner/repo from URL for lookup
    const urlMatch = url.match(/github\.com[\/:]([^\/]+)\/([^\/\s.]+)/i);
    if (!urlMatch) {
      return {
        success: false,
        status: 'error',
        isNewConnection: false,
        error: 'Invalid GitHub repository URL',
      };
    }

    const fullName = `${urlMatch[1]}/${urlMatch[2].replace(/\.git$/, '')}`;

    // Check if repository is already connected
    const existing = await this.findRepositoryByFullName(fullName, tenantContext);

    if (existing?.repository) {
      logger.info('Repository already connected', {
        repositoryId: existing.repository.id,
        fullName: existing.repository.fullName,
        lastSyncedAt: existing.repository.lastSyncedAt,
      });

      // If force resync, trigger incremental sync
      if (forceResync) {
        const syncResult = await this.triggerSync(
          existing.repository.id,
          { type: 'incremental', accessToken },
          tenantContext
        );

        if (!syncResult.success) {
          return {
            success: false,
            repositoryId: existing.repository.id,
            fullName: existing.repository.fullName,
            status: 'error',
            isNewConnection: false,
            error: syncResult.error?.message || 'Failed to trigger resync',
          };
        }

        if (waitForCompletion) {
          // Wait for sync to complete
          const startTime = Date.now();
          const maxTime = timeout || this.DEFAULT_TIMEOUT_MS;
          let attempts = 0;

          while (Date.now() - startTime < maxTime && attempts < this.MAX_POLL_ATTEMPTS) {
            const statusResult = await this.getSyncStatus(
              existing.repository.id,
              tenantContext
            );

            if (statusResult.data?.state === 'idle') {
              return {
                success: true,
                repositoryId: existing.repository.id,
                fullName: existing.repository.fullName,
                status: 'synced',
                isNewConnection: false,
                syncStats: statusResult.data?.syncStats,
              };
            }

            await this.delay(this.POLL_INTERVAL_MS);
            attempts++;
          }
        }

        return {
          success: true,
          repositoryId: existing.repository.id,
          fullName: existing.repository.fullName,
          status: 'syncing',
          isNewConnection: false,
        };
      }

      // Return existing repository without resync
      return {
        success: true,
        repositoryId: existing.repository.id,
        fullName: existing.repository.fullName,
        status: 'synced',
        isNewConnection: false,
        syncStats: existing.stats as SyncStats,
      };
    }

    // Repository not connected - connect and sync
    if (waitForCompletion) {
      const result = await this.connectAndWaitForSync(
        { url, accessToken },
        tenantContext,
        timeout
      );

      return {
        success: result.success,
        repositoryId: result.repository?.repository?.id,
        fullName: result.repository?.repository?.fullName,
        status: result.success ? 'synced' : 'error',
        isNewConnection: true,
        syncStats: result.syncStats,
        error: result.error,
      };
    }

    // Connect without waiting
    const connectResult = await this.connectRepository({ url, accessToken }, tenantContext);

    if (!connectResult.success) {
      return {
        success: false,
        status: 'error',
        isNewConnection: true,
        error: connectResult.error?.message || 'Failed to connect repository',
      };
    }

    return {
      success: true,
      repositoryId: connectResult.data?.repository.id,
      fullName: connectResult.data?.repository.fullName,
      status: 'syncing',
      isNewConnection: true,
    };
  }

  /**
   * Health check
   *
   * Checks if GitHub Manager service is available and healthy.
   *
   * @returns Health status of GitHub Manager service
   */
  async healthCheck(): Promise<{ status: 'healthy' | 'unhealthy'; details?: GitHubManagerHealthStatus }> {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 5000);

      const response = await fetch(`${this.baseUrl}/health`, {
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        return { status: 'unhealthy' };
      }

      const data = await response.json() as GitHubManagerHealthStatus;
      return {
        status: data.status === 'healthy' ? 'healthy' : 'unhealthy',
        details: data,
      };
    } catch (error) {
      logger.warn('GitHub Manager health check failed', {
        error: error instanceof Error ? error.message : String(error),
      });
      return { status: 'unhealthy' };
    }
  }

  /**
   * Get circuit breaker state
   *
   * @returns Current circuit breaker state
   */
  getCircuitState(): string {
    return this.circuitBreaker.getState();
  }

  /**
   * Reset circuit breaker
   */
  resetCircuit(): void {
    this.circuitBreaker.reset();
    logger.info('GitHub Manager circuit breaker manually reset');
  }

  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

// ============================================================================
// Singleton
// ============================================================================

let gitHubManagerClientInstance: GitHubManagerClient | null = null;

/**
 * Get or create the singleton GitHub Manager client instance
 *
 * @returns Singleton GitHubManagerClient instance
 */
export function getGitHubManagerClient(): GitHubManagerClient {
  if (!gitHubManagerClientInstance) {
    gitHubManagerClientInstance = new GitHubManagerClient();
  }
  return gitHubManagerClientInstance;
}

/**
 * Reset the singleton instance (for testing)
 */
export function resetGitHubManagerClient(): void {
  gitHubManagerClientInstance = null;
}
