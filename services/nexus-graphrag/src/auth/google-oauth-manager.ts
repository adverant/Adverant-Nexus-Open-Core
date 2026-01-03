/**
 * Google OAuth 2.0 Manager
 *
 * Handles OAuth 2.0 authentication flow for Google Drive API access:
 * 1. Generates authorization URL
 * 2. Exchanges authorization code for tokens
 * 3. Stores and refreshes tokens
 * 4. Provides authenticated Google Drive client
 */

import { google, drive_v3 } from 'googleapis';
import { OAuth2Client, Credentials } from 'google-auth-library';
import { logger } from '../utils/logger.js';
import { Redis } from 'ioredis';
import { Pool } from 'pg';

export interface GoogleOAuthConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  redisClient: Redis;
  pgPool?: Pool; // Optional PostgreSQL connection pool for permanent storage
}

export interface TokenData {
  access_token: string;
  refresh_token?: string;
  expiry_date?: number;
  scope?: string;
}

/**
 * Google OAuth Manager
 *
 * Singleton pattern for managing OAuth authentication state
 */
export class GoogleOAuthManager {
  private oauth2Client: OAuth2Client;
  private redisClient: Redis;
  private pgPool?: Pool;
  private readonly TOKEN_KEY = 'google_oauth:tokens';
  private readonly SCOPES = [
    'https://www.googleapis.com/auth/drive.readonly',
    'https://www.googleapis.com/auth/drive.metadata.readonly'
  ];

  constructor(config: GoogleOAuthConfig) {
    this.oauth2Client = new google.auth.OAuth2(
      config.clientId,
      config.clientSecret,
      config.redirectUri
    );

    this.redisClient = config.redisClient;
    this.pgPool = config.pgPool; // Optional PostgreSQL connection pool

    logger.info('GoogleOAuthManager initialized', {
      clientId: config.clientId,
      redirectUri: config.redirectUri,
      hasPostgresPool: !!this.pgPool
    });

    // Attempt to load existing tokens
    this.loadTokens().catch(error => {
      logger.warn('Could not load existing tokens', { error: error.message });
    });
  }

  /**
   * Generate authorization URL for user consent
   */
  getAuthorizationUrl(): string {
    const authUrl = this.oauth2Client.generateAuthUrl({
      access_type: 'offline', // Get refresh token
      scope: this.SCOPES,
      prompt: 'consent' // Force consent to ensure refresh token
    });

    logger.info('Generated authorization URL', { authUrl });
    return authUrl;
  }

  /**
   * Exchange authorization code for tokens
   */
  async exchangeCodeForTokens(code: string): Promise<TokenData> {
    try {
      logger.info('Exchanging authorization code for tokens');

      const { tokens } = await this.oauth2Client.getToken(code);

      if (!tokens.access_token) {
        throw new Error('No access token received from Google OAuth');
      }

      // Set credentials on OAuth2 client
      this.oauth2Client.setCredentials(tokens);

      // Store tokens in Redis
      await this.saveTokens(tokens);

      logger.info('Successfully exchanged code for tokens', {
        hasRefreshToken: !!tokens.refresh_token,
        expiryDate: tokens.expiry_date
      });

      return tokens as TokenData;
    } catch (error) {
      logger.error('Failed to exchange authorization code', {
        error: (error as Error).message
      });
      throw new Error(`OAuth token exchange failed: ${(error as Error).message}`);
    }
  }

  /**
   * Get authenticated Google Drive client
   */
  async getDriveClient(): Promise<drive_v3.Drive> {
    try {
      // Check if tokens are valid
      const tokens = await this.getValidTokens();

      if (!tokens) {
        throw new Error('No valid OAuth tokens available. Please authenticate first.');
      }

      // Create Drive client with authenticated OAuth2 client
      const drive = google.drive({ version: 'v3', auth: this.oauth2Client });

      return drive;
    } catch (error) {
      logger.error('Failed to get Drive client', {
        error: (error as Error).message
      });
      throw error;
    }
  }

  /**
   * Get OAuth2 client (for provider use)
   */
  async getOAuth2Client(): Promise<OAuth2Client> {
    const tokens = await this.getValidTokens();

    if (!tokens) {
      throw new Error('No valid OAuth tokens available. Please authenticate first.');
    }

    return this.oauth2Client;
  }

  /**
   * Check if authenticated
   */
  async isAuthenticated(): Promise<boolean> {
    try {
      const tokens = await this.loadTokens();
      return !!tokens && !!tokens.access_token;
    } catch {
      return false;
    }
  }

  /**
   * Get valid tokens (refresh if needed)
   */
  private async getValidTokens(): Promise<Credentials | null> {
    try {
      // Load tokens from Redis
      let tokens = await this.loadTokens();

      if (!tokens) {
        logger.warn('No tokens found in storage');
        return null;
      }

      // Set credentials
      this.oauth2Client.setCredentials(tokens);

      // Check if token is expired or about to expire (within 5 minutes)
      const now = Date.now();
      const expiryDate = tokens.expiry_date || 0;
      const isExpired = expiryDate < now + 5 * 60 * 1000;

      if (isExpired && tokens.refresh_token) {
        logger.info('Access token expired or expiring soon, refreshing...');

        // Refresh token
        const { credentials } = await this.oauth2Client.refreshAccessToken();
        this.oauth2Client.setCredentials(credentials);

        // Save refreshed tokens
        await this.saveTokens(credentials);

        tokens = credentials;

        logger.info('Successfully refreshed access token', {
          expiryDate: credentials.expiry_date
        });
      }

      return tokens;
    } catch (error) {
      logger.error('Failed to get valid tokens', {
        error: (error as Error).message
      });
      return null;
    }
  }

  /**
   * Save tokens to Redis and PostgreSQL (dual storage for permanence)
   */
  private async saveTokens(tokens: Credentials): Promise<void> {
    try {
      // Save to Redis (fast cache with 7-day TTL)
      await this.redisClient.set(
        this.TOKEN_KEY,
        JSON.stringify(tokens),
        'EX',
        7 * 24 * 60 * 60 // Expire in 7 days
      );

      logger.debug('Tokens saved to Redis');

      // Save to PostgreSQL (permanent storage)
      if (this.pgPool) {
        await this.saveTokensToPostgres(tokens);
        logger.debug('Tokens saved to PostgreSQL');
      }
    } catch (error) {
      logger.error('Failed to save tokens', {
        error: (error as Error).message
      });
      throw error;
    }
  }

  /**
   * Save tokens to PostgreSQL for permanent storage
   *
   * Uses 'system' as user_id for service-level OAuth tokens.
   * The unique constraint on (provider, user_id) allows one token per provider/user combo.
   */
  private async saveTokensToPostgres(tokens: Credentials): Promise<void> {
    if (!this.pgPool) return;

    try {
      await this.pgPool.query(
        `INSERT INTO graphrag.oauth_tokens
          (provider, user_id, access_token, refresh_token, token_type, expiry_date, scope, metadata)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        ON CONFLICT (provider, user_id)
        DO UPDATE SET
          access_token = EXCLUDED.access_token,
          refresh_token = EXCLUDED.refresh_token,
          expiry_date = EXCLUDED.expiry_date,
          scope = EXCLUDED.scope,
          updated_at = CURRENT_TIMESTAMP,
          last_used_at = CURRENT_TIMESTAMP,
          metadata = EXCLUDED.metadata`,
        [
          'google',
          'system', // Service-level tokens use 'system' as user_id
          tokens.access_token,
          tokens.refresh_token || null,
          tokens.token_type || 'Bearer',
          tokens.expiry_date || null,
          tokens.scope || this.SCOPES.join(' '),
          JSON.stringify({ saved_at: new Date().toISOString() })
        ]
      );
    } catch (error) {
      logger.error('Failed to save tokens to PostgreSQL', {
        error: (error as Error).message
      });
      // Don't throw - Redis save already succeeded
    }
  }

  /**
   * Load tokens from Redis with PostgreSQL fallback
   */
  private async loadTokens(): Promise<Credentials | null> {
    try {
      // Try Redis first (fastest)
      const tokensJson = await this.redisClient.get(this.TOKEN_KEY);

      if (tokensJson) {
        const tokens = JSON.parse(tokensJson) as Credentials;
        logger.debug('Tokens loaded from Redis');
        return tokens;
      }

      // Fallback to PostgreSQL if Redis is empty
      if (this.pgPool) {
        logger.info('Redis tokens empty, attempting PostgreSQL fallback');
        const tokens = await this.loadTokensFromPostgres();

        if (tokens) {
          // Re-populate Redis cache
          await this.redisClient.set(
            this.TOKEN_KEY,
            JSON.stringify(tokens),
            'EX',
            7 * 24 * 60 * 60
          );
          logger.info('Tokens restored from PostgreSQL to Redis');
          return tokens;
        }
      }

      return null;
    } catch (error) {
      logger.error('Failed to load tokens', {
        error: (error as Error).message
      });
      return null;
    }
  }

  /**
   * Load tokens from PostgreSQL permanent storage
   */
  private async loadTokensFromPostgres(): Promise<Credentials | null> {
    if (!this.pgPool) return null;

    try {
      const result = await this.pgPool.query(
        `SELECT access_token, refresh_token, token_type, expiry_date, scope
         FROM graphrag.oauth_tokens
         WHERE provider = $1
         ORDER BY updated_at DESC
         LIMIT 1`,
        ['google']
      );

      if (result.rows.length === 0) {
        return null;
      }

      const row = result.rows[0];
      const tokens: Credentials = {
        access_token: row.access_token,
        refresh_token: row.refresh_token,
        token_type: row.token_type,
        expiry_date: row.expiry_date,
        scope: row.scope
      };

      logger.debug('Tokens loaded from PostgreSQL');
      return tokens;
    } catch (error) {
      logger.error('Failed to load tokens from PostgreSQL', {
        error: (error as Error).message
      });
      return null;
    }
  }

  /**
   * Clear stored tokens (logout) from both Redis and PostgreSQL
   */
  async clearTokens(): Promise<void> {
    try {
      // Clear from Redis
      await this.redisClient.del(this.TOKEN_KEY);

      // Clear from PostgreSQL
      if (this.pgPool) {
        await this.pgPool.query(
          `DELETE FROM graphrag.oauth_tokens WHERE provider = $1`,
          ['google']
        );
        logger.debug('Tokens cleared from PostgreSQL');
      }

      this.oauth2Client.setCredentials({});

      logger.info('Tokens cleared from all storage');
    } catch (error) {
      logger.error('Failed to clear tokens', {
        error: (error as Error).message
      });
      throw error;
    }
  }
}
