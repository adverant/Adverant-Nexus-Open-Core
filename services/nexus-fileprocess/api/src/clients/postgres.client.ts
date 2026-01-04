/**
 * PostgreSQL Client for FileProcessAgent API
 *
 * Provides direct database access for job status queries.
 * Uses the fileprocess schema where Worker stores job data.
 */

import { Pool } from 'pg';
import { config } from '../config';
import { logger } from '../utils/logger';

export interface JobRecord {
  id: string;
  userId: string;
  filename: string;
  mimeType: string | null;
  fileSize: number | null;
  status: string;
  confidence: number | null;
  processingTimeMs: number | null;
  documentDnaId: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  ocrTierUsed: string | null;
  metadata: Record<string, any>;
  createdAt: Date;
  updatedAt: Date;
}

export interface DocumentDnaRecord {
  id: string;
  jobId: string;
  qdrantPointId: string;
  structuralData: Record<string, any>;
  originalContent: Buffer | null;
  embeddingDimensions: number;
  createdAt: Date;
}

class PostgresClient {
  private pool: Pool;
  private isConnected = false;

  constructor() {
    this.pool = new Pool({
      connectionString: config.databaseUrl,
      max: 10, // Maximum 10 connections in pool
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 5000,
    });

    // Handle pool errors
    this.pool.on('error', (err: Error) => {
      logger.error('Unexpected PostgreSQL pool error', { error: err.message });
    });
  }

  /**
   * Initialize connection pool and verify connectivity
   */
  async connect(): Promise<void> {
    try {
      const client = await this.pool.connect();
      await client.query('SELECT 1');
      client.release();
      this.isConnected = true;
      logger.info('PostgreSQL client connected successfully', {
        database: config.databaseUrl.split('@')[1]?.split('?')[0]
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error('Failed to connect to PostgreSQL', { error: errorMessage });
      throw new Error(`PostgreSQL connection failed: ${errorMessage}`);
    }
  }

  /**
   * Get job by ID from fileprocess.processing_jobs table
   */
  async getJobById(jobId: string): Promise<JobRecord | null> {
    if (!this.isConnected) {
      throw new Error('PostgreSQL client not connected');
    }

    const query = `
      SELECT
        id,
        user_id,
        filename,
        mime_type,
        file_size,
        status,
        confidence,
        processing_time_ms,
        document_dna_id,
        error_code,
        error_message,
        ocr_tier_used,
        metadata,
        created_at,
        updated_at
      FROM fileprocess.processing_jobs
      WHERE id = $1::uuid
    `;

    try {
      const result = await this.pool.query(query, [jobId]);

      if (result.rows.length === 0) {
        return null;
      }

      const row = result.rows[0];
      return {
        id: row.id,
        userId: row.user_id,
        filename: row.filename,
        mimeType: row.mime_type,
        fileSize: row.file_size,
        status: row.status,
        confidence: row.confidence,
        processingTimeMs: row.processing_time_ms,
        documentDnaId: row.document_dna_id,
        errorCode: row.error_code,
        errorMessage: row.error_message,
        ocrTierUsed: row.ocr_tier_used,
        metadata: row.metadata || {},
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error('Failed to get job from PostgreSQL', { jobId, error: errorMessage });
      throw new Error(`Database query failed: ${errorMessage}`);
    }
  }

  /**
   * Get Document DNA by ID from fileprocess.document_dna table
   */
  async getDocumentDnaById(dnaId: string): Promise<DocumentDnaRecord | null> {
    if (!this.isConnected) {
      throw new Error('PostgreSQL client not connected');
    }

    const query = `
      SELECT
        id,
        job_id,
        qdrant_point_id,
        structural_data,
        original_content,
        embedding_dimensions,
        created_at
      FROM fileprocess.document_dna
      WHERE id = $1::uuid
    `;

    try {
      const result = await this.pool.query(query, [dnaId]);

      if (result.rows.length === 0) {
        return null;
      }

      const row = result.rows[0];
      return {
        id: row.id,
        jobId: row.job_id,
        qdrantPointId: row.qdrant_point_id,
        structuralData: row.structural_data || {},
        originalContent: row.original_content,
        embeddingDimensions: row.embedding_dimensions,
        createdAt: row.created_at,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error('Failed to get Document DNA from PostgreSQL', { dnaId, error: errorMessage });
      throw new Error(`Database query failed: ${errorMessage}`);
    }
  }

  /**
   * Get Document DNA by job ID
   */
  async getDocumentDnaByJobId(jobId: string): Promise<DocumentDnaRecord | null> {
    if (!this.isConnected) {
      throw new Error('PostgreSQL client not connected');
    }

    const query = `
      SELECT
        id,
        job_id,
        qdrant_point_id,
        structural_data,
        original_content,
        embedding_dimensions,
        created_at
      FROM fileprocess.document_dna
      WHERE job_id = $1::uuid
    `;

    try {
      const result = await this.pool.query(query, [jobId]);

      if (result.rows.length === 0) {
        return null;
      }

      const row = result.rows[0];
      return {
        id: row.id,
        jobId: row.job_id,
        qdrantPointId: row.qdrant_point_id,
        structuralData: row.structural_data || {},
        originalContent: row.original_content,
        embeddingDimensions: row.embedding_dimensions,
        createdAt: row.created_at,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error('Failed to get Document DNA by job ID', { jobId, error: errorMessage });
      throw new Error(`Database query failed: ${errorMessage}`);
    }
  }

  /**
   * Store original file content in document_dna table
   *
   * This allows users to download the original file later.
   * For files > 100MB, consider using external storage (MinIO/S3) instead.
   */
  async storeOriginalFile(
    jobId: string,
    originalContent: Buffer,
    metadata?: {
      filename?: string;
      mimeType?: string;
      fileSize?: number;
      fileHash?: string;
    }
  ): Promise<string> {
    if (!this.isConnected) {
      throw new Error('PostgreSQL client not connected');
    }

    const { v4: uuidv4 } = await import('uuid');
    const dnaId = uuidv4();

    // Build structural data with file metadata
    const structuralData = {
      originalFilename: metadata?.filename,
      mimeType: metadata?.mimeType,
      fileSize: metadata?.fileSize || originalContent.length,
      fileHash: metadata?.fileHash,
      storedAt: new Date().toISOString(),
      storageType: 'postgres_bytea',
    };

    const query = `
      INSERT INTO fileprocess.document_dna (
        id,
        job_id,
        qdrant_point_id,
        structural_data,
        original_content,
        embedding_dimensions,
        created_at
      ) VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7)
      ON CONFLICT (job_id) DO UPDATE SET
        original_content = EXCLUDED.original_content,
        structural_data = fileprocess.document_dna.structural_data || EXCLUDED.structural_data
      RETURNING id
    `;

    try {
      const result = await this.pool.query(query, [
        dnaId,
        jobId,
        null, // qdrant_point_id - will be set later when embeddings are stored
        JSON.stringify(structuralData),
        originalContent,
        0, // embedding_dimensions - will be set later
        new Date(),
      ]);

      logger.info('Stored original file content in PostgreSQL', {
        jobId,
        dnaId: result.rows[0]?.id || dnaId,
        fileSize: originalContent.length,
        filename: metadata?.filename,
      });

      return result.rows[0]?.id || dnaId;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error('Failed to store original file content', {
        jobId,
        error: errorMessage,
        fileSize: originalContent.length,
      });
      throw new Error(`Failed to store original file: ${errorMessage}`);
    }
  }

  /**
   * Get original file content by job ID
   *
   * Returns the original file buffer for user download.
   */
  async getOriginalFileByJobId(jobId: string): Promise<{
    content: Buffer;
    filename?: string;
    mimeType?: string;
    fileSize?: number;
  } | null> {
    if (!this.isConnected) {
      throw new Error('PostgreSQL client not connected');
    }

    const query = `
      SELECT
        original_content,
        structural_data
      FROM fileprocess.document_dna
      WHERE job_id = $1::uuid
        AND original_content IS NOT NULL
    `;

    try {
      const result = await this.pool.query(query, [jobId]);

      if (result.rows.length === 0 || !result.rows[0].original_content) {
        return null;
      }

      const row = result.rows[0];
      const structuralData = row.structural_data || {};

      return {
        content: row.original_content,
        filename: structuralData.originalFilename,
        mimeType: structuralData.mimeType,
        fileSize: structuralData.fileSize,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error('Failed to get original file by job ID', { jobId, error: errorMessage });
      throw new Error(`Database query failed: ${errorMessage}`);
    }
  }

  /**
   * Check if original file exists for a job
   */
  async hasOriginalFile(jobId: string): Promise<boolean> {
    if (!this.isConnected) {
      throw new Error('PostgreSQL client not connected');
    }

    const query = `
      SELECT EXISTS(
        SELECT 1 FROM fileprocess.document_dna
        WHERE job_id = $1::uuid
          AND original_content IS NOT NULL
      ) as exists
    `;

    try {
      const result = await this.pool.query(query, [jobId]);
      return result.rows[0]?.exists || false;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error('Failed to check for original file', { jobId, error: errorMessage });
      return false;
    }
  }

  /**
   * Delete original file content (to free space after user downloads)
   * Optional: Call this if storage space is a concern
   */
  async deleteOriginalFile(jobId: string): Promise<boolean> {
    if (!this.isConnected) {
      throw new Error('PostgreSQL client not connected');
    }

    const query = `
      UPDATE fileprocess.document_dna
      SET original_content = NULL,
          structural_data = structural_data || '{"originalContentDeleted": true, "deletedAt": "${new Date().toISOString()}"}'::jsonb
      WHERE job_id = $1::uuid
      RETURNING id
    `;

    try {
      const result = await this.pool.query(query, [jobId]);
      const deleted = (result.rowCount ?? 0) > 0;

      if (deleted) {
        logger.info('Deleted original file content from PostgreSQL', { jobId });
      }

      return deleted;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error('Failed to delete original file', { jobId, error: errorMessage });
      return false;
    }
  }

  /**
   * Get pool statistics
   */
  getStats() {
    return {
      totalCount: this.pool.totalCount,
      idleCount: this.pool.idleCount,
      waitingCount: this.pool.waitingCount,
    };
  }

  /**
   * Close connection pool
   */
  async close(): Promise<void> {
    await this.pool.end();
    this.isConnected = false;
    logger.info('PostgreSQL client closed');
  }
}

// Singleton instance
let postgresClient: PostgresClient | null = null;

/**
 * Get or create PostgreSQL client instance
 */
export function getPostgresClient(): PostgresClient {
  if (!postgresClient) {
    postgresClient = new PostgresClient();
  }
  return postgresClient;
}

/**
 * Initialize PostgreSQL client (call during server startup)
 */
export async function initPostgresClient(): Promise<void> {
  const client = getPostgresClient();
  await client.connect();
}
