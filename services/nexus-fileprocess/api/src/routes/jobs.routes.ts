/**
 * Jobs Routes for FileProcessAgent API (REFACTORED)
 *
 * CHANGES:
 * - Removed BullMQ dependency (queue inconsistency fix)
 * - Uses JobRepository for all operations (single source of truth)
 * - All queries against PostgreSQL (authoritative data)
 * - Added original file download endpoints
 *
 * Endpoints:
 * - GET /api/jobs/:id - Get job status and details
 * - DELETE /api/jobs/:id - Cancel a job
 * - GET /api/jobs - List jobs by status and user
 * - GET /api/jobs/:id/download - Download original file
 * - HEAD /api/jobs/:id/download - Check if original file is available
 * - DELETE /api/jobs/:id/download - Delete original file (free storage)
 * - GET /api/queue/stats - Get queue statistics
 */

import { Router, Request, Response } from 'express';
import { getJobRepository } from '../repositories/JobRepository';
import { getPostgresClient } from '../clients/postgres.client';
import { logger } from '../utils/logger';
import { config } from '../config';
import { GetJobStatusResponse } from '../models/job.model';

const router = Router();

/**
 * GET /api/jobs/:id
 *
 * Get job status and details from PostgreSQL via JobRepository.
 */
router.get('/jobs/:id', async (req: Request, res: Response): Promise<Response | void> => {
  const startTime = Date.now();
  const jobId = req.params.id;

  try {
    logger.debug('Getting job status from JobRepository', { jobId });

    const jobRepository = getJobRepository();
    const job = await jobRepository.getJobById(jobId);

    if (!job) {
      logger.warn('Job not found', { jobId });
      return res.status(404).json({
        success: false,
        error: 'Job not found',
        message: `No job found with ID: ${jobId}`,
      });
    }

    const duration = Date.now() - startTime;

    logger.info('Job status retrieved', {
      jobId,
      status: job.status,
      confidence: job.confidence,
      duration: `${duration}ms`,
    });

    // Get Document DNA if available
    let documentDna: any = undefined;
    if (job.documentDnaId) {
      try {
        const postgresClient = getPostgresClient();
        const dna = await postgresClient.getDocumentDnaById(job.documentDnaId);
        if (dna) {
          documentDna = {
            id: dna.id,
            jobId: dna.jobId,
            qdrantPointId: dna.qdrantPointId,
            structuralData: dna.structuralData,
            embeddingDimensions: dna.embeddingDimensions,
            createdAt: dna.createdAt,
          };
        }
      } catch (error) {
        logger.warn('Failed to fetch Document DNA', {
          dnaId: job.documentDnaId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    const response: GetJobStatusResponse = {
      success: true,
      job: {
        id: job.id,
        userId: job.userId,
        filename: job.filename,
        mimeType: job.mimeType || undefined,
        fileSize: job.fileSize || undefined,
        status: job.status as any,
        confidence: job.confidence || undefined,
        processingTimeMs: job.processingTimeMs || undefined,
        documentDnaId: job.documentDnaId || undefined,
        errorCode: job.errorCode || undefined,
        errorMessage: job.errorMessage || undefined,
        ocrTierUsed: job.ocrTierUsed || undefined,
        metadata: job.metadata,
        createdAt: job.createdAt,
        updatedAt: job.updatedAt,
      } as any,
      documentDna,
    };

    res.status(200).json(response);
  } catch (error) {
    const duration = Date.now() - startTime;
    const errorMessage = error instanceof Error ? error.message : String(error);

    logger.error('Failed to get job status', {
      jobId,
      error: errorMessage,
      duration: `${duration}ms`,
    });

    res.status(500).json({
      success: false,
      error: 'Internal server error',
      message: 'Failed to retrieve job status',
      details: config.nodeEnv === 'development' ? errorMessage : undefined,
    });
  }
});

/**
 * DELETE /api/jobs/:id
 *
 * Cancel a job by updating status to 'cancelled' in PostgreSQL via JobRepository.
 */
router.delete('/jobs/:id', async (req: Request, res: Response): Promise<Response | void> => {
  const startTime = Date.now();
  const jobId = req.params.id;

  try {
    logger.info('Cancelling job', { jobId });

    const jobRepository = getJobRepository();
    const cancelled = await jobRepository.cancelJob(jobId);

    const duration = Date.now() - startTime;

    if (!cancelled) {
      logger.warn('Job could not be cancelled', { jobId });
      return res.status(404).json({
        success: false,
        error: 'Cannot cancel job',
        message: 'Job not found or already completed',
      });
    }

    logger.info('Job cancelled successfully', {
      jobId,
      duration: `${duration}ms`,
    });

    res.status(200).json({
      success: true,
      message: 'Job cancelled successfully',
    });
  } catch (error) {
    const duration = Date.now() - startTime;
    const errorMessage = error instanceof Error ? error.message : String(error);

    logger.error('Failed to cancel job', {
      jobId,
      error: errorMessage,
      duration: `${duration}ms`,
    });

    res.status(500).json({
      success: false,
      error: 'Internal server error',
      message: 'Failed to cancel job',
      details: config.nodeEnv === 'development' ? errorMessage : undefined,
    });
  }
});

/**
 * GET /api/jobs?status=waiting&userId=user123&start=0&limit=100
 *
 * List jobs with filtering from PostgreSQL via JobRepository.
 */
router.get('/jobs', async (req: Request, res: Response): Promise<Response | void> => {
  const startTime = Date.now();

  try {
    const status = req.query.status as string | undefined;
    const userId = req.query.userId as string | undefined;
    const offset = parseInt(req.query.start as string, 10) || 0;
    const limit = parseInt(req.query.limit as string, 10) || 100;

    // Validate status if provided
    if (status) {
      const validStatuses = ['queued', 'processing', 'completed', 'failed', 'cancelled'];
      if (!validStatuses.includes(status)) {
        return res.status(400).json({
          success: false,
          error: 'Invalid status',
          message: `Status must be one of: ${validStatuses.join(', ')}`,
        });
      }
    }

    // Validate pagination
    if (offset < 0 || limit < 1 || limit > 1000) {
      return res.status(400).json({
        success: false,
        error: 'Invalid pagination',
        message: 'start must be >= 0, limit must be between 1 and 1000',
      });
    }

    logger.debug('Listing jobs from JobRepository', { status, userId, offset, limit });

    const jobRepository = getJobRepository();
    const jobs = await jobRepository.listJobs({
      status: status as any,
      userId,
      offset,
      limit,
    });

    const duration = Date.now() - startTime;

    logger.info('Jobs listed successfully', {
      status,
      userId,
      count: jobs.length,
      duration: `${duration}ms`,
    });

    res.status(200).json({
      success: true,
      jobs: jobs.map(job => ({
        id: job.id,
        filename: job.filename,
        userId: job.userId,
        status: job.status,
        confidence: job.confidence,
        createdAt: job.createdAt,
        updatedAt: job.updatedAt,
        processingTimeMs: job.processingTimeMs,
        errorMessage: job.errorMessage,
      })),
      pagination: {
        offset,
        limit,
        count: jobs.length,
      },
    });
  } catch (error) {
    const duration = Date.now() - startTime;
    const errorMessage = error instanceof Error ? error.message : String(error);

    logger.error('Failed to list jobs', {
      error: errorMessage,
      duration: `${duration}ms`,
    });

    res.status(500).json({
      success: false,
      error: 'Internal server error',
      message: 'Failed to list jobs',
      details: config.nodeEnv === 'development' ? errorMessage : undefined,
    });
  }
});

/**
 * GET /api/jobs/:id/download
 *
 * Download the original file for a processed job.
 * Returns the original file content stored in PostgreSQL document_dna table.
 */
router.get('/jobs/:id/download', async (req: Request, res: Response): Promise<Response | void> => {
  const startTime = Date.now();
  const jobId = req.params.id;

  try {
    logger.info('Downloading original file', { jobId });

    const postgresClient = getPostgresClient();

    // Get job to verify it exists and is accessible
    const job = await postgresClient.getJobById(jobId);
    if (!job) {
      return res.status(404).json({
        success: false,
        error: 'Job not found',
        message: `No job found with ID: ${jobId}`,
      });
    }

    // Get original file content from document_dna
    const originalFile = await postgresClient.getOriginalFileByJobId(jobId);

    if (!originalFile) {
      return res.status(404).json({
        success: false,
        error: 'Original file not available',
        message: 'Original file was not stored or has been deleted. Only processed artifacts may be available.',
      });
    }

    const duration = Date.now() - startTime;

    logger.info('Original file download successful', {
      jobId,
      filename: originalFile.filename || job.filename,
      fileSize: originalFile.fileSize || originalFile.content.length,
      mimeType: originalFile.mimeType || job.mimeType,
      duration: `${duration}ms`,
    });

    // Set appropriate headers for file download
    const filename = originalFile.filename || job.filename || 'download';
    const mimeType = originalFile.mimeType || job.mimeType || 'application/octet-stream';

    res.setHeader('Content-Type', mimeType);
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(filename)}"`);
    res.setHeader('Content-Length', originalFile.content.length);
    res.setHeader('X-Job-Id', jobId);
    res.setHeader('X-Original-Filename', filename);

    // Send the file buffer
    res.status(200).send(originalFile.content);
  } catch (error) {
    const duration = Date.now() - startTime;
    const errorMessage = error instanceof Error ? error.message : String(error);

    logger.error('Failed to download original file', {
      jobId,
      error: errorMessage,
      duration: `${duration}ms`,
    });

    res.status(500).json({
      success: false,
      error: 'Internal server error',
      message: 'Failed to download original file',
      details: config.nodeEnv === 'development' ? errorMessage : undefined,
    });
  }
});

/**
 * HEAD /api/jobs/:id/download
 *
 * Check if original file is available for download without downloading it.
 */
router.head('/jobs/:id/download', async (req: Request, res: Response): Promise<Response | void> => {
  const jobId = req.params.id;

  try {
    const postgresClient = getPostgresClient();

    // Check if job exists
    const job = await postgresClient.getJobById(jobId);
    if (!job) {
      return res.status(404).end();
    }

    // Check if original file exists
    const hasFile = await postgresClient.hasOriginalFile(jobId);
    if (!hasFile) {
      return res.status(404).end();
    }

    // File exists - return success with minimal info
    res.setHeader('X-Job-Id', jobId);
    res.setHeader('X-File-Available', 'true');
    res.status(200).end();
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error('Failed to check original file availability', {
      jobId,
      error: errorMessage,
    });
    res.status(500).end();
  }
});

/**
 * DELETE /api/jobs/:id/download
 *
 * Delete the original file content (to free storage space).
 * Keeps all job metadata and processed artifacts.
 */
router.delete('/jobs/:id/download', async (req: Request, res: Response): Promise<Response | void> => {
  const jobId = req.params.id;

  try {
    logger.info('Deleting original file', { jobId });

    const postgresClient = getPostgresClient();

    // Verify job exists
    const job = await postgresClient.getJobById(jobId);
    if (!job) {
      return res.status(404).json({
        success: false,
        error: 'Job not found',
        message: `No job found with ID: ${jobId}`,
      });
    }

    // Delete original file content
    const deleted = await postgresClient.deleteOriginalFile(jobId);

    if (!deleted) {
      return res.status(404).json({
        success: false,
        error: 'No file to delete',
        message: 'Original file was not stored or has already been deleted.',
      });
    }

    logger.info('Original file deleted successfully', { jobId });

    res.status(200).json({
      success: true,
      message: 'Original file deleted successfully. Job metadata and artifacts remain available.',
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error('Failed to delete original file', {
      jobId,
      error: errorMessage,
    });

    res.status(500).json({
      success: false,
      error: 'Internal server error',
      message: 'Failed to delete original file',
      details: config.nodeEnv === 'development' ? errorMessage : undefined,
    });
  }
});

/**
 * GET /api/queue/stats
 *
 * Get queue statistics from PostgreSQL via JobRepository.
 */
router.get('/queue/stats', async (_req: Request, res: Response): Promise<Response | void> => {
  const startTime = Date.now();

  try {
    logger.debug('Getting queue stats from JobRepository');

    const jobRepository = getJobRepository();
    const stats = await jobRepository.getQueueStats();

    const duration = Date.now() - startTime;

    logger.info('Queue stats retrieved', {
      stats,
      duration: `${duration}ms`,
    });

    res.status(200).json({
      success: true,
      stats,
    });
  } catch (error) {
    const duration = Date.now() - startTime;
    const errorMessage = error instanceof Error ? error.message : String(error);

    logger.error('Failed to get queue stats', {
      error: errorMessage,
      duration: `${duration}ms`,
    });

    res.status(500).json({
      success: false,
      error: 'Internal server error',
      message: 'Failed to retrieve queue statistics',
      details: config.nodeEnv === 'development' ? errorMessage : undefined,
    });
  }
});

export default router;
