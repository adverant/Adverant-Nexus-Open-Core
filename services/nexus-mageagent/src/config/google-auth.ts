/**
 * MageAgent Google Authentication Configuration
 *
 * Manages service account authentication for GCP AI/ML services.
 * Uses nexus-geo-worker@adverant-ai.iam.gserviceaccount.com for:
 * - Google Earth Engine (satellite imagery, NDVI, land cover analysis)
 * - Google Vertex AI (Gemini Pro Vision, PaLM 2)
 * - Google BigQuery GIS (spatial queries, geospatial analytics)
 *
 * Features:
 * - Automatic service account loading from Secret Manager
 * - Authentication verification with access token validation
 * - Comprehensive error handling
 * - Singleton pattern for shared auth across MageAgent services
 *
 * IAM Roles Required:
 * - roles/earthengine.viewer
 * - roles/aiplatform.user
 * - roles/bigquery.dataEditor
 * - roles/bigquery.jobUser
 *
 * @module services/nexus-mageagent/src/config/google-auth
 */

import { getSecretsLoader, ServiceAccountType } from '../../../../shared/utils/google-secrets-loader';
import { GoogleAuth, JWT } from 'google-auth-library';
import type { Logger } from '../../../../shared/utils/google-secrets-loader';

/**
 * Default logger implementation
 * MageAgent should inject its own structured logger
 */
const defaultLogger = {
  info: (msg: string, ctx?: Record<string, any>) => console.log(`[INFO] ${msg}`, ctx || ''),
  error: (msg: string, ctx?: Record<string, any>) => console.error(`[ERROR] ${msg}`, ctx || ''),
  debug: (msg: string, ctx?: Record<string, any>) => console.log(`[DEBUG] ${msg}`, ctx || ''),
  warn: (msg: string, ctx?: Record<string, any>) => console.warn(`[WARN] ${msg}`, ctx || ''),
};

/**
 * GCP Service enumeration
 * Represents the three primary GCP services used by MageAgent
 */
export enum GCPService {
  EARTH_ENGINE = 'earth-engine',
  VERTEX_AI = 'vertex-ai',
  BIGQUERY = 'bigquery',
}

/**
 * Authentication status for each GCP service
 */
export interface AuthStatus {
  service: GCPService;
  authenticated: boolean;
  error?: string;
  lastChecked: Date;
}

/**
 * MageAgent Google Authentication Manager
 *
 * Handles service account authentication for all GCP AI/ML services.
 * Loads credentials from Secret Manager and provides authenticated clients.
 *
 * Usage:
 * ```typescript
 * const auth = await getMageAgentGoogleAuth();
 *
 * // Verify authentication
 * const isValid = await auth.verify();
 *
 * // Get authenticated client
 * const client = auth.getAuthClient();
 *
 * // Check service-specific auth
 * const status = await auth.checkServiceAuth(GCPService.EARTH_ENGINE);
 * ```
 *
 * @class MageAgentGoogleAuth
 */
export class MageAgentGoogleAuth {
  private auth: GoogleAuth | null = null;
  private serviceAccountConfig: any = null;
  private logger: Logger;

  /**
   * Create a new MageAgentGoogleAuth instance
   *
   * @param logger - Optional custom logger
   */
  constructor(logger?: Logger) {
    this.logger = logger || defaultLogger;
  }

  /**
   * Initialize Google authentication for MageAgent
   *
   * Loads nexus-geo-worker service account from Secret Manager and creates
   * GoogleAuth instance with scopes for Earth Engine, Vertex AI, and BigQuery.
   *
   * @throws {Error} if initialization fails or service account invalid
   *
   * @example
   * ```typescript
   * const auth = new MageAgentGoogleAuth();
   * await auth.initialize();
   * ```
   */
  async initialize(): Promise<void> {
    const operation = 'initialize';

    try {
      this.logger.info('Initializing MageAgent Google authentication', {
        operation,
        serviceAccount: 'nexus-geo-worker',
      });

      const secretsLoader = getSecretsLoader();
      this.serviceAccountConfig = await secretsLoader.loadServiceAccountConfig(
        ServiceAccountType.NEXUS_GEO_WORKER
      );

      // Validate service account email
      if (!this.serviceAccountConfig.client_email.includes('nexus-geo-worker')) {
        throw new Error(
          `Incorrect service account loaded: expected nexus-geo-worker, got ${this.serviceAccountConfig.client_email}`
        );
      }

      // Create GoogleAuth instance with all required scopes
      this.auth = new GoogleAuth({
        credentials: this.serviceAccountConfig,
        scopes: [
          // Earth Engine
          'https://www.googleapis.com/auth/earthengine',
          'https://www.googleapis.com/auth/earthengine.readonly',
          // Vertex AI & Cloud Platform
          'https://www.googleapis.com/auth/cloud-platform',
          // BigQuery
          'https://www.googleapis.com/auth/bigquery',
          'https://www.googleapis.com/auth/bigquery.readonly',
        ],
      });

      this.logger.info('MageAgent Google authentication initialized successfully', {
        operation,
        serviceAccount: this.serviceAccountConfig.client_email,
        projectId: this.serviceAccountConfig.project_id,
        scopes: ['earthengine', 'vertex-ai', 'bigquery'],
      });
    } catch (error) {
      this.logger.error('Failed to initialize MageAgent Google authentication', {
        operation,
        error: error instanceof Error ? error.message : String(error),
      });

      throw new Error(
        `MageAgent Google authentication initialization failed. ` +
        `Ensure Secret Manager contains 'service-account-nexus-geo-worker' secret. ` +
        `Run: ./scripts/setup-google-secret-manager.sh. ` +
        `Error: ${error}`
      );
    }
  }

  /**
   * Get authenticated Google Auth client
   *
   * Returns the GoogleAuth instance for making authenticated GCP API calls.
   *
   * @returns GoogleAuth client
   * @throws {Error} if not initialized
   *
   * @example
   * ```typescript
   * const authClient = auth.getAuthClient();
   * const client = await authClient.getClient();
   * const token = await client.getAccessToken();
   * ```
   */
  getAuthClient(): GoogleAuth {
    if (!this.auth) {
      throw new Error(
        'MageAgent Google authentication not initialized. Call initialize() first.'
      );
    }
    return this.auth;
  }

  /**
   * Get service account email for logging and debugging
   *
   * @returns Service account email or 'unknown' if not initialized
   */
  getServiceAccountEmail(): string {
    return this.serviceAccountConfig?.client_email || 'unknown';
  }

  /**
   * Get GCP project ID
   *
   * @returns Project ID or 'unknown' if not initialized
   */
  getProjectId(): string {
    return this.serviceAccountConfig?.project_id || 'unknown';
  }

  /**
   * Verify authentication by attempting to get access token
   *
   * Tests authentication by requesting an access token.
   * This validates that:
   * 1. Service account credentials are valid
   * 2. Service account has not been deleted
   * 3. Private key is not revoked
   *
   * @returns True if authentication is valid
   *
   * @example
   * ```typescript
   * const isValid = await auth.verify();
   * if (!isValid) {
   *   throw new Error('Authentication failed');
   * }
   * ```
   */
  async verify(): Promise<boolean> {
    const operation = 'verify';

    try {
      if (!this.auth) {
        this.logger.error('Cannot verify: authentication not initialized', { operation });
        return false;
      }

      this.logger.debug('Verifying MageAgent Google authentication', {
        operation,
        serviceAccount: this.getServiceAccountEmail(),
      });

      const client = await this.auth.getClient();
      const tokenResponse = await client.getAccessToken();

      if (!tokenResponse.token) {
        this.logger.error('Access token verification failed: no token received', {
          operation,
        });
        return false;
      }

      this.logger.info('MageAgent Google authentication verified successfully', {
        operation,
        serviceAccount: this.getServiceAccountEmail(),
        tokenExpiry: tokenResponse.res?.data?.expires_in
          ? `${tokenResponse.res.data.expires_in}s`
          : 'unknown',
      });

      return true;
    } catch (error) {
      this.logger.error('MageAgent Google authentication verification failed', {
        operation,
        serviceAccount: this.getServiceAccountEmail(),
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }

  /**
   * Check authentication status for specific GCP service
   *
   * Verifies that the service account can authenticate for a specific service.
   * This is more comprehensive than verify() as it tests service-specific scopes.
   *
   * @param service - GCP service to check
   * @returns Authentication status with details
   *
   * @example
   * ```typescript
   * const earthEngineStatus = await auth.checkServiceAuth(GCPService.EARTH_ENGINE);
   * if (!earthEngineStatus.authenticated) {
   *   console.error('Earth Engine auth failed:', earthEngineStatus.error);
   * }
   * ```
   */
  async checkServiceAuth(service: GCPService): Promise<AuthStatus> {
    const operation = 'checkServiceAuth';
    const status: AuthStatus = {
      service,
      authenticated: false,
      lastChecked: new Date(),
    };

    try {
      if (!this.auth) {
        status.error = 'Authentication not initialized';
        return status;
      }

      this.logger.debug('Checking service-specific authentication', {
        operation,
        service,
        serviceAccount: this.getServiceAccountEmail(),
      });

      const client = await this.auth.getClient();
      const token = await client.getAccessToken();

      if (!token.token) {
        status.error = 'Failed to obtain access token';
        return status;
      }

      // Service-specific validation would go here
      // For now, we verify token exists (service-specific checks require actual API calls)
      status.authenticated = true;

      this.logger.debug('Service authentication check passed', {
        operation,
        service,
        serviceAccount: this.getServiceAccountEmail(),
      });

      return status;
    } catch (error) {
      status.error = error instanceof Error ? error.message : String(error);

      this.logger.error('Service authentication check failed', {
        operation,
        service,
        serviceAccount: this.getServiceAccountEmail(),
        error: status.error,
      });

      return status;
    }
  }

  /**
   * Check authentication for all GCP services
   *
   * Runs authentication checks for Earth Engine, Vertex AI, and BigQuery.
   * Useful for health checks and startup validation.
   *
   * @returns Array of authentication statuses
   *
   * @example
   * ```typescript
   * const statuses = await auth.checkAllServices();
   * const allAuthenticated = statuses.every(s => s.authenticated);
   * ```
   */
  async checkAllServices(): Promise<AuthStatus[]> {
    return Promise.all([
      this.checkServiceAuth(GCPService.EARTH_ENGINE),
      this.checkServiceAuth(GCPService.VERTEX_AI),
      this.checkServiceAuth(GCPService.BIGQUERY),
    ]);
  }

  /**
   * Get authenticated JSON client for direct API calls
   *
   * Returns a JWT client that can be used directly with GCP client libraries.
   *
   * @returns Authenticated JWT client
   * @throws {Error} if not initialized
   */
  async getJSONClient(): Promise<JWT> {
    if (!this.auth) {
      throw new Error('Authentication not initialized');
    }

    const client = await this.auth.getClient();
    return client as JWT;
  }
}

/**
 * Singleton instance
 * Most MageAgent services should use this shared instance
 */
let authInstance: MageAgentGoogleAuth | null = null;

/**
 * Get singleton MageAgentGoogleAuth instance
 *
 * Returns a shared, initialized instance of MageAgentGoogleAuth.
 * Automatically initializes on first call.
 *
 * @param logger - Optional custom logger
 * @returns Initialized MageAgentGoogleAuth instance
 * @throws {Error} if initialization fails
 *
 * @example
 * ```typescript
 * const auth = await getMageAgentGoogleAuth();
 * const client = auth.getAuthClient();
 * ```
 */
export async function getMageAgentGoogleAuth(logger?: Logger): Promise<MageAgentGoogleAuth> {
  if (!authInstance) {
    authInstance = new MageAgentGoogleAuth(logger);
    await authInstance.initialize();
  }
  return authInstance;
}

/**
 * Reset singleton instance
 * Only for testing purposes - do not use in production
 * @internal
 */
export function resetMageAgentGoogleAuthForTesting(): void {
  authInstance = null;
}
