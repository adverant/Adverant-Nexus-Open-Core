/**
 * Artifact Repository - Universal File Storage Repository
 *
 * Implements intelligent storage routing:
 * - Small files (<10MB) → PostgreSQL buffer
 * - Large files (10MB - 5GB) → MinIO object storage
 * - Massive files (>5GB) → Reference-only (no upload)
 *
 * Features:
 * - Automatic storage tier selection
 * - Presigned URL generation for MinIO files
 * - TTL-based cleanup
 * - Transaction support
 */

import { Pool } from 'pg';
import { v4 as uuidv4 } from 'uuid';
import { getMinIOClient } from '../storage/minio-client';
import { logger } from '../utils/logger';
import {
  Artifact,
  CreateArtifactRequest,
  ArtifactDownloadResponse,
  STORAGE_TIERS,
  DEFAULT_ARTIFACT_TTL_DAYS,
  PRESIGNED_URL_EXPIRY_SECONDS,
} from '../models/artifact.model';

export class ArtifactRepository {
  constructor(private pool: Pool) {}

  /**
   * Create artifact with automatic storage tier selection
   */
  async create(request: CreateArtifactRequest): Promise<Artifact> {
    const artifactId = uuidv4();
    const now = new Date();
    const ttlDays = request.ttl_days || DEFAULT_ARTIFACT_TTL_DAYS;
    const expiresAt = new Date(now.getTime() + ttlDays * 24 * 60 * 60 * 1000);

    logger.info('Creating artifact with automatic storage routing', {
      artifactId,
      filename: request.filename,
      size: request.file_size,
      sourceService: request.source_service,
      sourceId: request.source_id,
    });

    // Determine storage backend based on file size
    let storageBackend: 'postgres_buffer' | 'minio' | 'reference_only';
    let storagePath: string | undefined;
    let bufferData: string | undefined;
    let presignedUrl: string | undefined;
    let urlExpiresAt: Date | undefined;

    if (request.file_size <= STORAGE_TIERS.BUFFER_MAX_SIZE) {
      // Tier 1: Small files → PostgreSQL buffer
      storageBackend = 'postgres_buffer';

      if (!request.buffer) {
        throw new Error('Buffer data required for small file storage');
      }

      bufferData = request.buffer.toString('base64');

      logger.debug('Using PostgreSQL buffer storage', {
        artifactId,
        size: request.file_size,
      });
    } else if (request.file_size <= STORAGE_TIERS.MINIO_MAX_SIZE) {
      // Tier 2: Large files → MinIO
      storageBackend = 'minio';

      if (!request.buffer && !request.storage_path) {
        throw new Error('Buffer or storage path required for MinIO storage');
      }

      const minioClient = getMinIOClient();
      const objectPath = `artifacts/${request.source_service}/${request.source_id}/${request.filename}`;

      if (request.buffer) {
        // Upload to MinIO
        const minioPath = await minioClient.uploadFile(
          objectPath,
          request.buffer,
          {
            contentType: request.mime_type,
            metadata: {
              sourceService: request.source_service,
              sourceId: request.source_id,
              artifactId,
              ...request.metadata,
            },
          }
        );

        storagePath = minioPath;
      } else if (request.storage_path) {
        // Already in MinIO (reference existing path)
        storagePath = request.storage_path;
      }

      // Generate presigned URL for immediate download
      presignedUrl = await minioClient.getPresignedUrl(
        objectPath,
        'download',
        { expirySeconds: PRESIGNED_URL_EXPIRY_SECONDS }
      );

      urlExpiresAt = new Date(now.getTime() + PRESIGNED_URL_EXPIRY_SECONDS * 1000);

      logger.debug('Using MinIO storage', {
        artifactId,
        size: request.file_size,
        storagePath,
      });
    } else {
      // Tier 3: Massive files → Reference-only
      storageBackend = 'reference_only';
      storagePath = request.external_url || request.storage_path;

      if (!storagePath) {
        throw new Error('External URL or storage path required for reference-only storage');
      }

      logger.debug('Using reference-only storage', {
        artifactId,
        size: request.file_size,
        storagePath,
      });
    }

    // Insert into database
    const query = `
      INSERT INTO fileprocess.artifacts (
        id,
        source_service,
        source_id,
        filename,
        mime_type,
        file_size,
        storage_backend,
        storage_path,
        buffer_data,
        presigned_url,
        url_expires_at,
        metadata,
        created_at,
        expires_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
      RETURNING *
    `;

    const values = [
      artifactId,
      request.source_service,
      request.source_id,
      request.filename,
      request.mime_type,
      request.file_size,
      storageBackend,
      storagePath,
      bufferData,
      presignedUrl,
      urlExpiresAt,
      JSON.stringify(request.metadata || {}),
      now,
      expiresAt,
    ];

    const result = await this.pool.query(query, values);

    logger.info('Artifact created successfully', {
      artifactId,
      storageBackend,
      filename: request.filename,
    });

    return this.mapRowToArtifact(result.rows[0]);
  }

  /**
   * Get artifact by ID
   */
  async getById(artifactId: string): Promise<Artifact | null> {
    const query = `
      SELECT * FROM fileprocess.artifacts
      WHERE id = $1
    `;

    const result = await this.pool.query(query, [artifactId]);

    if (result.rows.length === 0) {
      return null;
    }

    return this.mapRowToArtifact(result.rows[0]);
  }

  /**
   * Get download response with URL or buffer
   */
  async getDownloadResponse(artifactId: string): Promise<ArtifactDownloadResponse | null> {
    const artifact = await this.getById(artifactId);

    if (!artifact) {
      return null;
    }

    logger.debug('Generating download response', {
      artifactId,
      storageBackend: artifact.storage_backend,
    });

    if (artifact.storage_backend === 'postgres_buffer') {
      // Return buffer directly
      if (!artifact.buffer_data) {
        throw new Error('Buffer data missing for postgres_buffer artifact');
      }

      return {
        artifact,
        buffer: Buffer.from(artifact.buffer_data, 'base64'),
      };
    } else if (artifact.storage_backend === 'minio') {
      // Generate fresh presigned URL if expired
      if (!artifact.presigned_url || !artifact.url_expires_at || artifact.url_expires_at < new Date()) {
        logger.debug('Regenerating expired presigned URL', { artifactId });

        const minioClient = getMinIOClient();
        const presignedUrl = await minioClient.getPresignedUrl(
          artifact.storage_path!,
          'download',
          { expirySeconds: PRESIGNED_URL_EXPIRY_SECONDS }
        );

        // Update database with new URL
        await this.updatePresignedUrl(artifactId, presignedUrl);

        artifact.presigned_url = presignedUrl;
        artifact.url_expires_at = new Date(Date.now() + PRESIGNED_URL_EXPIRY_SECONDS * 1000);
      }

      return {
        artifact,
        download_url: artifact.presigned_url,
      };
    } else {
      // Reference-only - return external URL
      return {
        artifact,
        download_url: artifact.storage_path,
      };
    }
  }

  /**
   * List artifacts by source
   */
  async listBySource(sourceService: string, sourceId: string): Promise<Artifact[]> {
    const query = `
      SELECT * FROM fileprocess.artifacts
      WHERE source_service = $1 AND source_id = $2
      ORDER BY created_at DESC
    `;

    const result = await this.pool.query(query, [sourceService, sourceId]);

    return result.rows.map(this.mapRowToArtifact);
  }

  /**
   * Delete artifact (from database and storage)
   */
  async delete(artifactId: string): Promise<boolean> {
    const artifact = await this.getById(artifactId);

    if (!artifact) {
      return false;
    }

    logger.info('Deleting artifact', {
      artifactId,
      storageBackend: artifact.storage_backend,
    });

    // Delete from MinIO if applicable
    if (artifact.storage_backend === 'minio' && artifact.storage_path) {
      try {
        const minioClient = getMinIOClient();
        await minioClient.deleteFile(artifact.storage_path);
        logger.debug('Deleted artifact from MinIO', { artifactId, path: artifact.storage_path });
      } catch (error) {
        logger.warn('Failed to delete artifact from MinIO (non-critical)', {
          artifactId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    // Delete from database
    const query = `DELETE FROM fileprocess.artifacts WHERE id = $1`;
    await this.pool.query(query, [artifactId]);

    logger.info('Artifact deleted successfully', { artifactId });

    return true;
  }

  /**
   * Clean up expired artifacts
   */
  async cleanupExpired(): Promise<number> {
    logger.info('Starting expired artifacts cleanup');

    const now = new Date();

    // Find expired artifacts
    const query = `
      SELECT * FROM fileprocess.artifacts
      WHERE expires_at < $1
    `;

    const result = await this.pool.query(query, [now]);

    logger.info('Found expired artifacts', { count: result.rows.length });

    let deletedCount = 0;

    for (const row of result.rows) {
      const artifact = this.mapRowToArtifact(row);

      try {
        await this.delete(artifact.id);
        deletedCount++;
      } catch (error) {
        logger.error('Failed to delete expired artifact', {
          artifactId: artifact.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    logger.info('Expired artifacts cleanup completed', {
      deletedCount,
      failedCount: result.rows.length - deletedCount,
    });

    return deletedCount;
  }

  /**
   * Update presigned URL
   */
  private async updatePresignedUrl(artifactId: string, presignedUrl: string): Promise<void> {
    const urlExpiresAt = new Date(Date.now() + PRESIGNED_URL_EXPIRY_SECONDS * 1000);

    const query = `
      UPDATE fileprocess.artifacts
      SET presigned_url = $1, url_expires_at = $2
      WHERE id = $3
    `;

    await this.pool.query(query, [presignedUrl, urlExpiresAt, artifactId]);
  }

  /**
   * Map database row to Artifact model
   */
  private mapRowToArtifact(row: any): Artifact {
    return {
      id: row.id,
      source_service: row.source_service,
      source_id: row.source_id,
      filename: row.filename,
      mime_type: row.mime_type,
      file_size: parseInt(row.file_size, 10),
      storage_backend: row.storage_backend,
      storage_path: row.storage_path,
      buffer_data: row.buffer_data,
      presigned_url: row.presigned_url,
      url_expires_at: row.url_expires_at ? new Date(row.url_expires_at) : undefined,
      metadata: row.metadata || undefined,
      created_at: new Date(row.created_at),
      expires_at: row.expires_at ? new Date(row.expires_at) : undefined,
    };
  }
}

// Singleton instance
let artifactRepositoryInstance: ArtifactRepository | null = null;

/**
 * Initialize artifact repository
 */
export function initArtifactRepository(pool: Pool): void {
  artifactRepositoryInstance = new ArtifactRepository(pool);
  logger.info('ArtifactRepository initialized');
}

/**
 * Get artifact repository instance
 */
export function getArtifactRepository(): ArtifactRepository {
  if (!artifactRepositoryInstance) {
    throw new Error('ArtifactRepository not initialized. Call initArtifactRepository first.');
  }
  return artifactRepositoryInstance;
}
