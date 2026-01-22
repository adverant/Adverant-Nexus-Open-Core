/**
 * Storage Handlers for SandboxFirstOrchestrator
 *
 * Implements post-processing storage to Postgres, Qdrant, and GraphRAG.
 * These handlers are designed to be gracefully fault-tolerant - if one
 * storage destination fails, others will still be attempted.
 *
 * NEW: Original file content is now stored in PostgreSQL for user retrieval.
 */

import { logger } from '../utils/logger';
import { getPostgresClient } from '../clients/postgres.client';
import { getGraphRAGClient } from '../clients/GraphRAGClient';
import type { OrchestrationJob } from './SandboxFirstOrchestrator';
import type { FileClassification } from '@adverant/nexus-telemetry';
import * as fs from 'fs/promises';
import * as crypto from 'crypto';

// Maximum file size to store in PostgreSQL (100MB)
// Files larger than this should use external storage (MinIO/S3)
const MAX_POSTGRES_FILE_SIZE = 100 * 1024 * 1024;

/**
 * Store job metadata to Postgres
 */
export async function storeToPostgres(job: OrchestrationJob): Promise<void> {
  const postgresClient = getPostgresClient();

  // Build metadata JSON
  const metadata = {
    correlationId: job.correlationId,
    originalFilename: job.file.filename,
    mimeType: job.file.mimeType,
    fileSize: job.file.fileSize,
    fileHash: job.file.fileHash,
    storagePath: job.file.storagePath,
    sandboxAnalysis: {
      tier: job.sandboxResult?.tier,
      classification: job.sandboxResult?.classification,
      threatLevel: job.sandboxResult?.security.threatLevel,
      isMalicious: job.sandboxResult?.security.isMalicious
    },
    processing: {
      targetService: job.routeDecision?.decision.targetService,
      method: job.routeDecision?.decision.method,
      durationMs: job.processingResult?.durationMs
    },
    user: {
      userId: job.user?.userId,
      orgId: job.user?.orgId,
      trustScore: job.user?.userTrustScore
    },
    timestamps: {
      created: job.createdAt.toISOString(),
      completed: job.completedAt?.toISOString()
    }
  };

  // Use raw query to insert orchestration job metadata
  // Note: We're using the existing processing_jobs table structure
  const pool = (postgresClient as any).pool;

  await pool.query(`
    INSERT INTO fileprocess.processing_jobs (
      id,
      user_id,
      filename,
      mime_type,
      file_size,
      status,
      confidence,
      processing_time_ms,
      metadata,
      created_at,
      updated_at
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
    ON CONFLICT (id) DO UPDATE SET
      status = EXCLUDED.status,
      processing_time_ms = EXCLUDED.processing_time_ms,
      metadata = EXCLUDED.metadata,
      updated_at = EXCLUDED.updated_at
  `, [
    job.id,
    job.user?.userId || 'anonymous',
    job.file.filename,
    job.file.mimeType,
    job.file.fileSize,
    job.status === 'completed' ? 'completed' : 'failed',
    job.sandboxResult?.classification.confidence || null,
    job.processingResult?.durationMs || null,
    JSON.stringify(metadata),
    job.createdAt,
    new Date()
  ]);

  logger.debug('Stored job metadata to Postgres', {
    jobId: job.id,
    userId: job.user?.userId || 'anonymous'
  });
}

/**
 * Store original file content to PostgreSQL
 *
 * This enables users to download the original file after processing.
 * For files > 100MB, logs a warning but still attempts storage.
 * PostgreSQL BYTEA columns can handle large files, but performance
 * degrades for very large files - consider MinIO/S3 for > 100MB files.
 */
export async function storeOriginalFile(job: OrchestrationJob): Promise<void> {
  const postgresClient = getPostgresClient();

  // Skip if no storage path (e.g., URL-only submissions)
  if (!job.file.storagePath) {
    logger.debug('No storage path - skipping original file storage', {
      jobId: job.id,
      filename: job.file.filename,
    });
    return;
  }

  try {
    // Read the original file from disk
    const fileBuffer = await fs.readFile(job.file.storagePath);

    // Warn for large files but still attempt storage
    if (fileBuffer.length > MAX_POSTGRES_FILE_SIZE) {
      logger.warn('Large file being stored in PostgreSQL - consider MinIO/S3 for better performance', {
        jobId: job.id,
        filename: job.file.filename,
        fileSize: fileBuffer.length,
        maxRecommended: MAX_POSTGRES_FILE_SIZE,
      });
    }

    // Compute file hash if not already set
    let fileHash = job.file.fileHash;
    if (!fileHash) {
      fileHash = crypto.createHash('sha256').update(fileBuffer).digest('hex');
    }

    // Store the original file content
    await postgresClient.storeOriginalFile(job.id, fileBuffer, {
      filename: job.file.filename,
      mimeType: job.file.mimeType,
      fileSize: fileBuffer.length,
      fileHash,
    });

    logger.info('Stored original file to PostgreSQL', {
      jobId: job.id,
      filename: job.file.filename,
      fileSize: fileBuffer.length,
      fileHash,
    });
  } catch (error) {
    // Non-fatal - log error but don't throw
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error('Failed to store original file to PostgreSQL', {
      jobId: job.id,
      filename: job.file.filename,
      storagePath: job.file.storagePath,
      error: errorMessage,
    });
    // Don't throw - original file storage is optional
  }
}

/**
 * Store document to Qdrant via GraphRAG
 */
export async function storeToQdrant(job: OrchestrationJob): Promise<void> {
  const graphragClient = getGraphRAGClient();

  // Only store to Qdrant if we have extracted content
  if (!job.processingResult?.extractedContent) {
    logger.debug('No extracted content to store in Qdrant', { jobId: job.id });
    return;
  }

  // Store as document (which will generate embeddings and store in Qdrant)
  await graphragClient.storeDocument({
    content: job.processingResult.extractedContent,
    title: job.file.filename,
    metadata: {
      source: 'SandboxFirstOrchestrator',
      type: mapCategoryToDocType(job.sandboxResult?.classification.category),
      jobId: job.id,
      correlationId: job.correlationId,
      userId: job.user?.userId,
      orgId: job.user?.orgId,
      mimeType: job.file.mimeType,
      fileSize: job.file.fileSize,
      threatLevel: job.sandboxResult?.security.threatLevel,
      processingService: job.routeDecision?.decision.targetService,
      processingMethod: job.routeDecision?.decision.method,
      tags: [
        job.sandboxResult?.classification.category || 'unknown',
        job.routeDecision?.decision.targetService || 'unknown',
        job.sandboxResult?.security.threatLevel || 'unknown'
      ]
    }
  });

  logger.debug('Stored document to Qdrant (via GraphRAG)', {
    jobId: job.id,
    contentLength: job.processingResult.extractedContent.length
  });
}

/**
 * Store knowledge to GraphRAG
 */
export async function storeToGraphRAG(job: OrchestrationJob): Promise<void> {
  const graphragClient = getGraphRAGClient();

  // Store episodic memory of this processing job
  const episodeContent = buildEpisodeContent(job);

  await graphragClient.storeEpisode({
    content: episodeContent,
    type: 'observation',
    metadata: {
      importance: calculateImportance(job),
      session_id: job.correlationId,
      user_id: job.user?.userId || 'anonymous',
      jobId: job.id,
      filename: job.file.filename,
      mimeType: job.file.mimeType,
      threatLevel: job.sandboxResult?.security.threatLevel,
      targetService: job.routeDecision?.decision.targetService,
      processingSuccess: job.processingResult?.success,
      category: job.sandboxResult?.classification.category
    }
  });

  logger.debug('Stored episode to GraphRAG', {
    jobId: job.id,
    importance: calculateImportance(job)
  });
}

/**
 * Build episode content from job state
 */
function buildEpisodeContent(job: OrchestrationJob): string {
  const parts: string[] = [];

  parts.push(`File Processing: ${job.file.filename}`);
  parts.push(`MIME Type: ${job.file.mimeType}`);
  parts.push(`Size: ${(job.file.fileSize / 1024 / 1024).toFixed(2)} MB`);

  if (job.sandboxResult) {
    parts.push(`Classification: ${job.sandboxResult.classification.category}`);
    parts.push(`Threat Level: ${job.sandboxResult.security.threatLevel}`);
    parts.push(`Malicious: ${job.sandboxResult.security.isMalicious ? 'Yes' : 'No'}`);
  }

  if (job.routeDecision) {
    parts.push(`Routed to: ${job.routeDecision.decision.targetService}`);
    parts.push(`Method: ${job.routeDecision.decision.method}`);
  }

  if (job.processingResult) {
    parts.push(`Processing: ${job.processingResult.success ? 'Success' : 'Failed'}`);
    parts.push(`Duration: ${job.processingResult.durationMs}ms`);
    if (job.processingResult.error) {
      parts.push(`Error: ${job.processingResult.error}`);
    }
  }

  return parts.join('\n');
}

/**
 * Calculate importance score for episodic memory
 */
function calculateImportance(job: OrchestrationJob): number {
  let importance = 0.5; // Base importance

  // Increase importance for security threats
  if (job.sandboxResult?.security.isMalicious) {
    importance += 0.3;
  } else if (job.sandboxResult?.security.threatLevel === 'high') {
    importance += 0.2;
  } else if (job.sandboxResult?.security.threatLevel === 'medium') {
    importance += 0.1;
  }

  // Increase importance for failures
  if (!job.processingResult?.success) {
    importance += 0.2;
  }

  // Cap at 1.0
  return Math.min(importance, 1.0);
}

/**
 * Map file category to GraphRAG document type
 */
function mapCategoryToDocType(category?: FileClassification['category']): 'code' | 'markdown' | 'text' | 'structured' | 'multimodal' {
  switch (category) {
    case 'code':
      return 'code';
    case 'document':
      return 'structured';
    case 'media':
      return 'multimodal';
    case 'binary':
      return 'structured';
    default:
      return 'text';
  }
}
