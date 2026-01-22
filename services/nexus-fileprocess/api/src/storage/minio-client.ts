/**
 * MinIO Client for FileProcessAgent - Unified Artifact Storage
 *
 * Manages object storage for sandbox artifacts and large files.
 * Adapted from GeoAgent MinIO client with artifact-specific optimizations.
 *
 * Features:
 * - Connection pooling for high throughput
 * - Presigned URL generation for direct client uploads/downloads
 * - Stream-based upload/download for large files
 * - Bucket lifecycle management
 * - Error handling with retries
 */

import { Client, ClientOptions, BucketItem, CopyConditions } from 'minio';
import { Readable } from 'stream';
import { logger } from '../utils/logger';

export interface MinIOConfig {
  endPoint: string;
  port: number;
  useSSL: boolean;
  accessKey: string;
  secretKey: string;
  region?: string;
}

export interface UploadOptions {
  metadata?: Record<string, string>;
  contentType?: string;
  partSize?: number; // For multipart uploads
}

export interface PresignedUrlOptions {
  expirySeconds?: number;
  requestDate?: Date;
}

/**
 * MinIO Client for universal artifact storage
 */
export class MinIOClient {
  private client: Client;
  private readonly bucket: string;
  private readonly region: string;

  constructor(options?: Partial<MinIOConfig>) {
    // Parse MinIO configuration from environment or options
    const minioConfig: MinIOConfig = {
      endPoint: options?.endPoint || process.env.MINIO_HOST || 'nexus-minio',
      port: options?.port || parseInt(process.env.MINIO_PORT || '9000', 10),
      useSSL: options?.useSSL ?? (process.env.MINIO_USE_SSL === 'true'),
      accessKey: options?.accessKey || process.env.MINIO_ACCESS_KEY || 'unified_nexus',
      secretKey: options?.secretKey || process.env.MINIO_SECRET_KEY || 'nexus_minio_secure',
      region: options?.region || process.env.MINIO_REGION || 'us-east-1',
    };

    this.bucket = process.env.MINIO_ARTIFACTS_BUCKET || 'nexus-artifacts';
    this.region = minioConfig.region || 'us-east-1';

    // Create MinIO client
    this.client = new Client(minioConfig as ClientOptions);

    logger.info('MinIOClient initialized for FileProcessAgent', {
      endPoint: minioConfig.endPoint,
      port: minioConfig.port,
      bucket: this.bucket,
      region: this.region,
      useSSL: minioConfig.useSSL,
    });
  }

  /**
   * Ensure bucket exists, create if not
   */
  async ensureBucket(): Promise<void> {
    try {
      const exists = await this.client.bucketExists(this.bucket);

      if (!exists) {
        logger.info('Creating MinIO artifacts bucket', { bucket: this.bucket });
        await this.client.makeBucket(this.bucket, this.region);

        // Set lifecycle policy for TTL cleanup (7 days default)
        const lifecycleConfig = {
          Rule: [
            {
              ID: 'ExpireOldArtifacts',
              Status: 'Enabled',
              Expiration: {
                Days: parseInt(process.env.ARTIFACT_RETENTION_DAYS || '7', 10)
              }
            }
          ]
        };

        // Note: setBucketLifecycle requires MinIO admin permissions
        try {
          await this.client.setBucketLifecycle(this.bucket, lifecycleConfig as any);
          logger.info('Bucket lifecycle policy configured', {
            bucket: this.bucket,
            retentionDays: lifecycleConfig.Rule[0].Expiration.Days
          });
        } catch (lifecycleError) {
          logger.warn('Failed to set lifecycle policy (non-critical)', {
            bucket: this.bucket,
            error: lifecycleError instanceof Error ? lifecycleError.message : String(lifecycleError)
          });
        }

        logger.info('Bucket created successfully', { bucket: this.bucket });
      } else {
        logger.debug('Bucket already exists', { bucket: this.bucket });
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error('Failed to ensure bucket exists', {
        bucket: this.bucket,
        error: errorMessage,
      });
      throw new Error(`Failed to ensure bucket exists: ${errorMessage}`);
    }
  }

  /**
   * Upload file from buffer
   *
   * @param objectPath - Path in bucket (e.g., "artifacts/exec-123/output.svg")
   * @param buffer - File buffer
   * @param options - Upload options (metadata, contentType)
   * @returns MinIO path
   */
  async uploadFile(
    objectPath: string,
    buffer: Buffer,
    options: UploadOptions = {}
  ): Promise<string> {
    try {
      logger.debug('Uploading file to MinIO', {
        bucket: this.bucket,
        objectPath,
        size: buffer.length,
        metadata: options.metadata,
      });

      await this.client.putObject(
        this.bucket,
        objectPath,
        buffer,
        buffer.length,
        {
          'Content-Type': options.contentType || 'application/octet-stream',
          ...options.metadata,
        }
      );

      const minioPath = `minio://${this.bucket}/${objectPath}`;

      logger.info('File uploaded successfully', {
        minioPath,
        size: buffer.length,
      });

      return minioPath;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error('Failed to upload file', {
        objectPath,
        error: errorMessage,
      });
      throw new Error(`Failed to upload file: ${errorMessage}`);
    }
  }

  /**
   * Upload file from stream (for large files)
   *
   * @param objectPath - Path in bucket
   * @param stream - Readable stream
   * @param size - Stream size (required for MinIO)
   * @param options - Upload options
   * @returns MinIO path
   */
  async uploadStream(
    objectPath: string,
    stream: Readable,
    size: number,
    options: UploadOptions = {}
  ): Promise<string> {
    try {
      logger.debug('Uploading stream to MinIO', {
        bucket: this.bucket,
        objectPath,
        size,
      });

      await this.client.putObject(
        this.bucket,
        objectPath,
        stream,
        size,
        {
          'Content-Type': options.contentType || 'application/octet-stream',
          ...options.metadata,
        }
      );

      const minioPath = `minio://${this.bucket}/${objectPath}`;

      logger.info('Stream uploaded successfully', { minioPath, size });

      return minioPath;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error('Failed to upload stream', {
        objectPath,
        error: errorMessage,
      });
      throw new Error(`Failed to upload stream: ${errorMessage}`);
    }
  }

  /**
   * Download file as buffer
   *
   * @param objectPath - Path in bucket or full minio:// URL
   * @returns File buffer
   */
  async downloadFile(objectPath: string): Promise<Buffer> {
    try {
      // Handle both "minio://bucket/path" and "artifacts/exec-123/file" formats
      const path = objectPath.startsWith('minio://')
        ? objectPath.replace(`minio://${this.bucket}/`, '')
        : objectPath;

      logger.debug('Downloading file from MinIO', {
        bucket: this.bucket,
        objectPath: path,
      });

      const stream = await this.client.getObject(this.bucket, path);
      const chunks: Buffer[] = [];

      for await (const chunk of stream) {
        chunks.push(chunk);
      }

      const buffer = Buffer.concat(chunks);

      logger.info('File downloaded successfully', {
        objectPath: path,
        size: buffer.length,
      });

      return buffer;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error('Failed to download file', {
        objectPath,
        error: errorMessage,
      });
      throw new Error(`Failed to download file: ${errorMessage}`);
    }
  }

  /**
   * Download file as stream (for large files)
   *
   * @param objectPath - Path in bucket or full minio:// URL
   * @returns Readable stream
   */
  async downloadStream(objectPath: string): Promise<Readable> {
    try {
      const path = objectPath.startsWith('minio://')
        ? objectPath.replace(`minio://${this.bucket}/`, '')
        : objectPath;

      logger.debug('Getting download stream from MinIO', {
        bucket: this.bucket,
        objectPath: path,
      });

      const stream = await this.client.getObject(this.bucket, path);

      logger.info('Download stream created', { objectPath: path });

      return stream as Readable;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error('Failed to get download stream', {
        objectPath,
        error: errorMessage,
      });
      throw new Error(`Failed to get download stream: ${errorMessage}`);
    }
  }

  /**
   * Generate presigned URL for direct upload/download
   *
   * @param objectPath - Path in bucket
   * @param operation - 'upload' or 'download'
   * @param options - URL options
   * @returns Presigned URL
   */
  async getPresignedUrl(
    objectPath: string,
    operation: 'upload' | 'download' = 'download',
    options: PresignedUrlOptions = {}
  ): Promise<string> {
    try {
      const expiry = options.expirySeconds || 3600; // 1 hour default

      logger.debug('Generating presigned URL', {
        bucket: this.bucket,
        objectPath,
        operation,
        expiry,
      });

      let url: string;

      if (operation === 'upload') {
        url = await this.client.presignedPutObject(this.bucket, objectPath, expiry);
      } else {
        url = await this.client.presignedGetObject(this.bucket, objectPath, expiry);
      }

      logger.info('Presigned URL generated', {
        objectPath,
        operation,
        expiresIn: `${expiry}s`,
      });

      return url;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error('Failed to generate presigned URL', {
        objectPath,
        operation,
        error: errorMessage,
      });
      throw new Error(`Failed to generate presigned URL: ${errorMessage}`);
    }
  }

  /**
   * Delete file from MinIO
   *
   * @param objectPath - Path in bucket or full minio:// URL
   */
  async deleteFile(objectPath: string): Promise<void> {
    try {
      const path = objectPath.startsWith('minio://')
        ? objectPath.replace(`minio://${this.bucket}/`, '')
        : objectPath;

      logger.debug('Deleting file from MinIO', {
        bucket: this.bucket,
        objectPath: path,
      });

      await this.client.removeObject(this.bucket, path);

      logger.info('File deleted successfully', { objectPath: path });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error('Failed to delete file', {
        objectPath,
        error: errorMessage,
      });
      throw new Error(`Failed to delete file: ${errorMessage}`);
    }
  }

  /**
   * List objects in a prefix
   *
   * @param prefix - Object prefix (e.g., "artifacts/exec-123/")
   * @param recursive - List recursively
   * @returns Array of object information
   */
  async listObjects(prefix: string = '', recursive: boolean = true): Promise<BucketItem[]> {
    try {
      logger.debug('Listing objects in MinIO', {
        bucket: this.bucket,
        prefix,
        recursive,
      });

      const stream = this.client.listObjects(this.bucket, prefix, recursive);
      const objects: BucketItem[] = [];

      for await (const obj of stream) {
        objects.push(obj);
      }

      logger.info('Objects listed successfully', {
        prefix,
        count: objects.length,
      });

      return objects;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error('Failed to list objects', {
        prefix,
        error: errorMessage,
      });
      throw new Error(`Failed to list objects: ${errorMessage}`);
    }
  }

  /**
   * Get object metadata
   *
   * @param objectPath - Path in bucket
   * @returns Object metadata
   */
  async getObjectMetadata(objectPath: string): Promise<any> {
    try {
      const path = objectPath.startsWith('minio://')
        ? objectPath.replace(`minio://${this.bucket}/`, '')
        : objectPath;

      logger.debug('Getting object metadata', {
        bucket: this.bucket,
        objectPath: path,
      });

      const stat = await this.client.statObject(this.bucket, path);

      logger.info('Object metadata retrieved', {
        objectPath: path,
        size: stat.size,
        lastModified: stat.lastModified,
      });

      return {
        size: stat.size,
        lastModified: stat.lastModified,
        etag: stat.etag,
        contentType: stat.metaData?.['content-type'],
        metadata: stat.metaData,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error('Failed to get object metadata', {
        objectPath,
        error: errorMessage,
      });
      throw new Error(`Failed to get object metadata: ${errorMessage}`);
    }
  }

  /**
   * Check if object exists
   *
   * @param objectPath - Path in bucket
   * @returns True if exists, false otherwise
   */
  async objectExists(objectPath: string): Promise<boolean> {
    try {
      const path = objectPath.startsWith('minio://')
        ? objectPath.replace(`minio://${this.bucket}/`, '')
        : objectPath;

      await this.client.statObject(this.bucket, path);
      return true;
    } catch (error: any) {
      if (error.code === 'NotFound') {
        return false;
      }
      throw error;
    }
  }

  /**
   * Copy object within MinIO
   *
   * @param sourcePath - Source object path
   * @param destPath - Destination object path
   */
  async copyObject(sourcePath: string, destPath: string): Promise<void> {
    try {
      logger.debug('Copying object in MinIO', {
        bucket: this.bucket,
        sourcePath,
        destPath,
      });

      const copyConditions = new CopyConditions();
      await this.client.copyObject(
        this.bucket,
        destPath,
        `/${this.bucket}/${sourcePath}`,
        copyConditions
      );

      logger.info('Object copied successfully', {
        sourcePath,
        destPath,
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error('Failed to copy object', {
        sourcePath,
        destPath,
        error: errorMessage,
      });
      throw new Error(`Failed to copy object: ${errorMessage}`);
    }
  }

  /**
   * Get bucket statistics
   *
   * @returns Bucket size and object count
   */
  async getBucketStats(): Promise<{ size: number; count: number }> {
    try {
      const objects = await this.listObjects('', true);

      const stats = objects.reduce(
        (acc, obj) => {
          acc.size += obj.size || 0;
          acc.count += 1;
          return acc;
        },
        { size: 0, count: 0 }
      );

      logger.info('Bucket statistics retrieved', {
        bucket: this.bucket,
        ...stats,
      });

      return stats;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error('Failed to get bucket stats', {
        bucket: this.bucket,
        error: errorMessage,
      });
      throw new Error(`Failed to get bucket stats: ${errorMessage}`);
    }
  }

  /**
   * Clean up old objects (older than specified days)
   *
   * @param prefix - Object prefix to clean
   * @param daysOld - Objects older than this will be deleted
   * @returns Number of objects deleted
   */
  async cleanupOldObjects(prefix: string, daysOld: number = 7): Promise<number> {
    try {
      logger.info('Cleaning up old objects', {
        bucket: this.bucket,
        prefix,
        daysOld,
      });

      const objects = await this.listObjects(prefix, true);
      const cutoffDate = new Date();
      cutoffDate.setDate(cutoffDate.getDate() - daysOld);

      let deletedCount = 0;

      for (const obj of objects) {
        if (obj.lastModified && obj.lastModified < cutoffDate) {
          await this.client.removeObject(this.bucket, obj.name);
          deletedCount++;
        }
      }

      logger.info('Old objects cleaned up', {
        bucket: this.bucket,
        prefix,
        deletedCount,
      });

      return deletedCount;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error('Failed to cleanup old objects', {
        prefix,
        error: errorMessage,
      });
      throw new Error(`Failed to cleanup old objects: ${errorMessage}`);
    }
  }
}

// Singleton instance
let minioClientInstance: MinIOClient | null = null;

/**
 * Get or create the singleton MinIO client instance
 */
export function getMinIOClient(): MinIOClient {
  if (!minioClientInstance) {
    minioClientInstance = new MinIOClient();
  }
  return minioClientInstance;
}

/**
 * Initialize MinIO client and ensure bucket exists
 */
export async function initializeMinIO(): Promise<MinIOClient> {
  const client = getMinIOClient();
  await client.ensureBucket();
  return client;
}
