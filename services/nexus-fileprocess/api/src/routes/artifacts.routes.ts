/**
 * Artifact Routes - Universal File Management API
 *
 * Provides endpoints for uploading, downloading, and managing files
 * across all Nexus services with automatic storage tier selection.
 *
 * Endpoints:
 * - POST /api/files/upload - Upload file (auto-routes to buffer/MinIO)
 * - GET /api/files/:artifactId - Download file
 * - GET /api/files/:artifactId/pages/:pageSpec - Extract PDF pages (22, 2-6, 50,55)
 * - GET /api/files/:artifactId/metadata - Get file metadata
 * - GET /api/files/executions/:executionId - List execution artifacts
 * - GET /api/files/source/:service/:sourceId - List source artifacts
 * - DELETE /api/files/:artifactId - Delete file
 * - POST /api/files/cleanup - Cleanup expired artifacts
 */

import { Router, Request, Response } from 'express';
import multer from 'multer';
import { PDFDocument } from 'pdf-lib';
import { getArtifactRepository } from '../repositories/ArtifactRepository';
import { logger } from '../utils/logger';
import { CreateArtifactRequest } from '../models/artifact.model';

const router = Router();

// Configure multer for file uploads (memory storage)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 5 * 1024 * 1024 * 1024, // 5GB max file size
  },
});

/**
 * POST /api/files/upload
 * Upload file with automatic storage tier selection
 *
 * Body (multipart/form-data):
 * - file: File to upload (required)
 * - source_service: Source service name (required)
 * - source_id: Source entity ID (required)
 * - metadata: Additional metadata (JSON string, optional)
 * - ttl_days: Time-to-live in days (optional, default 7)
 */
router.post('/files/upload', upload.single('file'), async (req: Request, res: Response) => {
  try {
    if (!req.file) {
      return res.status(400).json({
        success: false,
        error: 'File is required',
      });
    }

    const { source_service, source_id, metadata, ttl_days } = req.body;

    if (!source_service || !source_id) {
      return res.status(400).json({
        success: false,
        error: 'source_service and source_id are required',
      });
    }

    logger.info('File upload request', {
      filename: req.file.originalname,
      size: req.file.size,
      sourceService: source_service,
      sourceId: source_id,
    });

    const createRequest: CreateArtifactRequest = {
      source_service,
      source_id,
      filename: req.file.originalname,
      mime_type: req.file.mimetype,
      file_size: req.file.size,
      buffer: req.file.buffer,
      metadata: metadata ? JSON.parse(metadata) : undefined,
      ttl_days: ttl_days ? parseInt(ttl_days, 10) : undefined,
    };

    const artifactRepo = getArtifactRepository();
    const artifact = await artifactRepo.create(createRequest);

    logger.info('File uploaded successfully', {
      artifactId: artifact.id,
      storageBackend: artifact.storage_backend,
      filename: artifact.filename,
    });

    return res.status(201).json({
      success: true,
      artifact: {
        id: artifact.id,
        filename: artifact.filename,
        file_size: artifact.file_size,
        mime_type: artifact.mime_type,
        storage_backend: artifact.storage_backend,
        created_at: artifact.created_at,
        expires_at: artifact.expires_at,
        download_url: artifact.presigned_url || `/fileprocess/api/files/${artifact.id}`,
      },
    });
  } catch (error) {
    logger.error('File upload failed', {
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });

    return res.status(500).json({
      success: false,
      error: 'Failed to upload file',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * GET /api/files/:artifactId
 * Download file (returns presigned URL for MinIO, or buffer for small files)
 */
router.get('/files/:artifactId', async (req: Request, res: Response) => {
  try {
    const { artifactId } = req.params;

    logger.debug('File download request', { artifactId });

    const artifactRepo = getArtifactRepository();
    const downloadResponse = await artifactRepo.getDownloadResponse(artifactId);

    if (!downloadResponse) {
      return res.status(404).json({
        success: false,
        error: 'Artifact not found',
      });
    }

    const { artifact, download_url, buffer } = downloadResponse;

    if (buffer) {
      // Small file in PostgreSQL buffer - return directly
      res.setHeader('Content-Type', artifact.mime_type);
      res.setHeader('Content-Disposition', `attachment; filename="${artifact.filename}"`);
      res.setHeader('Content-Length', buffer.length);
      return res.send(buffer);
    } else if (download_url) {
      // Large file in MinIO - redirect to presigned URL
      return res.redirect(302, download_url);
    } else {
      return res.status(500).json({
        success: false,
        error: 'No download method available',
      });
    }
  } catch (error) {
    logger.error('File download failed', {
      artifactId: req.params.artifactId,
      error: error instanceof Error ? error.message : String(error),
    });

    res.status(500).json({
      success: false,
      error: 'Failed to download file',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * GET /api/files/:artifactId/pages/:pageSpec
 * Extract specific pages from a PDF and return as a new PDF
 *
 * Supports multiple formats:
 * - Single page: /pages/22
 * - Range: /pages/2-6
 * - Multiple: /pages/50,55,60
 * - Combined: /pages/2-6,50,55
 *
 * Returns a new PDF containing only the requested pages
 */
router.get('/files/:artifactId/pages/:pageSpec', async (req: Request, res: Response) => {
  try {
    const { artifactId, pageSpec } = req.params;

    logger.debug('Page extraction request', { artifactId, pageSpec });

    // Parse page specification into array of page numbers (0-indexed internally)
    const pageNumbers = parsePageSpec(pageSpec);

    if (pageNumbers.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'Invalid page specification',
        message: 'Use formats like: 22, 2-6, 50,55,60, or 2-6,50,55',
      });
    }

    // Get the artifact
    const artifactRepo = getArtifactRepository();
    const downloadResponse = await artifactRepo.getDownloadResponse(artifactId);

    if (!downloadResponse) {
      return res.status(404).json({
        success: false,
        error: 'Artifact not found',
      });
    }

    const { artifact, buffer } = downloadResponse;

    // Verify it's a PDF (check both MIME type and file extension)
    const isPdf = artifact.mime_type === 'application/pdf' ||
      artifact.filename?.toLowerCase().endsWith('.pdf');

    if (!isPdf) {
      return res.status(400).json({
        success: false,
        error: 'Page extraction only supported for PDF files',
        mime_type: artifact.mime_type,
      });
    }

    // Get PDF buffer (either from postgres buffer or fetch from MinIO)
    let pdfBuffer: Buffer;
    if (buffer) {
      pdfBuffer = buffer;
    } else if (downloadResponse.download_url) {
      // Fetch from MinIO presigned URL
      const axios = (await import('axios')).default;
      const response = await axios.get(downloadResponse.download_url, {
        responseType: 'arraybuffer',
        timeout: 60000, // 60 second timeout for large files
      });
      pdfBuffer = Buffer.from(response.data);
    } else {
      return res.status(500).json({
        success: false,
        error: 'Unable to retrieve PDF content',
      });
    }

    // Load the source PDF
    const sourcePdf = await PDFDocument.load(pdfBuffer);
    const totalPages = sourcePdf.getPageCount();

    // Validate page numbers
    const invalidPages = pageNumbers.filter(p => p < 0 || p >= totalPages);
    if (invalidPages.length > 0) {
      return res.status(400).json({
        success: false,
        error: 'Invalid page numbers',
        message: `Pages ${invalidPages.map(p => p + 1).join(', ')} are out of range. Document has ${totalPages} pages.`,
        totalPages,
      });
    }

    // Create new PDF with only requested pages
    const newPdf = await PDFDocument.create();
    const copiedPages = await newPdf.copyPages(sourcePdf, pageNumbers);
    copiedPages.forEach(page => newPdf.addPage(page));

    // Generate the new PDF
    const newPdfBytes = await newPdf.save();

    // Generate filename
    const baseName = artifact.filename.replace(/\.pdf$/i, '');
    const pageLabel = pageNumbers.length === 1
      ? `page-${pageNumbers[0] + 1}`
      : `pages-${pageSpec.replace(/,/g, '_')}`;
    const newFilename = `${baseName}-${pageLabel}.pdf`;

    logger.info('Page extraction successful', {
      artifactId,
      pageSpec,
      pagesExtracted: pageNumbers.length,
      originalPages: totalPages,
      newSize: newPdfBytes.length,
    });

    // Return the new PDF
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${newFilename}"`);
    res.setHeader('Content-Length', newPdfBytes.length);
    res.setHeader('X-Total-Pages', totalPages.toString());
    res.setHeader('X-Extracted-Pages', pageNumbers.map(p => p + 1).join(','));
    return res.send(Buffer.from(newPdfBytes));

  } catch (error) {
    logger.error('Page extraction failed', {
      artifactId: req.params.artifactId,
      pageSpec: req.params.pageSpec,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });

    return res.status(500).json({
      success: false,
      error: 'Failed to extract pages',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * Parse page specification string into array of 0-indexed page numbers
 * Supports: "22", "2-6", "50,55,60", "2-6,50,55"
 */
function parsePageSpec(spec: string): number[] {
  const pages = new Set<number>();

  // Split by comma
  const parts = spec.split(',').map(p => p.trim()).filter(p => p);

  for (const part of parts) {
    if (part.includes('-')) {
      // Range: "2-6"
      const [startStr, endStr] = part.split('-').map(s => s.trim());
      const start = parseInt(startStr, 10);
      const end = parseInt(endStr, 10);

      if (isNaN(start) || isNaN(end) || start < 1 || end < start) {
        continue; // Skip invalid ranges
      }

      // Convert to 0-indexed and add all pages in range
      for (let i = start; i <= end; i++) {
        pages.add(i - 1);
      }
    } else {
      // Single page: "22"
      const pageNum = parseInt(part, 10);
      if (!isNaN(pageNum) && pageNum >= 1) {
        pages.add(pageNum - 1); // Convert to 0-indexed
      }
    }
  }

  // Return sorted array
  return Array.from(pages).sort((a, b) => a - b);
}

/**
 * GET /api/files/:artifactId/metadata
 * Get file metadata without downloading
 */
router.get('/files/:artifactId/metadata', async (req: Request, res: Response) => {
  try {
    const { artifactId } = req.params;

    const artifactRepo = getArtifactRepository();
    const artifact = await artifactRepo.getById(artifactId);

    if (!artifact) {
      return res.status(404).json({
        success: false,
        error: 'Artifact not found',
      });
    }

    return res.json({
      success: true,
      artifact: {
        id: artifact.id,
        filename: artifact.filename,
        file_size: artifact.file_size,
        mime_type: artifact.mime_type,
        storage_backend: artifact.storage_backend,
        source_service: artifact.source_service,
        source_id: artifact.source_id,
        metadata: artifact.metadata,
        created_at: artifact.created_at,
        expires_at: artifact.expires_at,
        download_url: artifact.presigned_url || `/fileprocess/api/files/${artifact.id}`,
      },
    });
  } catch (error) {
    logger.error('Get metadata failed', {
      artifactId: req.params.artifactId,
      error: error instanceof Error ? error.message : String(error),
    });

    return res.status(500).json({
      success: false,
      error: 'Failed to get metadata',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * GET /api/files/executions/:executionId
 * List all artifacts for an execution
 */
router.get('/files/executions/:executionId', async (req: Request, res: Response) => {
  try {
    const { executionId } = req.params;

    const artifactRepo = getArtifactRepository();
    const artifacts = await artifactRepo.listBySource('sandbox', executionId);

    res.json({
      success: true,
      execution_id: executionId,
      count: artifacts.length,
      artifacts: artifacts.map((artifact) => ({
        id: artifact.id,
        filename: artifact.filename,
        file_size: artifact.file_size,
        mime_type: artifact.mime_type,
        storage_backend: artifact.storage_backend,
        created_at: artifact.created_at,
        download_url: artifact.presigned_url || `/fileprocess/api/files/${artifact.id}`,
      })),
    });
  } catch (error) {
    logger.error('List execution artifacts failed', {
      executionId: req.params.executionId,
      error: error instanceof Error ? error.message : String(error),
    });

    res.status(500).json({
      success: false,
      error: 'Failed to list artifacts',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * GET /api/files/source/:service/:sourceId
 * List all artifacts for a source service and ID
 */
router.get('/files/source/:service/:sourceId', async (req: Request, res: Response) => {
  try {
    const { service, sourceId } = req.params;

    const artifactRepo = getArtifactRepository();
    const artifacts = await artifactRepo.listBySource(service, sourceId);

    res.json({
      success: true,
      source_service: service,
      source_id: sourceId,
      count: artifacts.length,
      artifacts: artifacts.map((artifact) => ({
        id: artifact.id,
        filename: artifact.filename,
        file_size: artifact.file_size,
        mime_type: artifact.mime_type,
        storage_backend: artifact.storage_backend,
        created_at: artifact.created_at,
        download_url: artifact.presigned_url || `/fileprocess/api/files/${artifact.id}`,
      })),
    });
  } catch (error) {
    logger.error('List source artifacts failed', {
      service: req.params.service,
      sourceId: req.params.sourceId,
      error: error instanceof Error ? error.message : String(error),
    });

    res.status(500).json({
      success: false,
      error: 'Failed to list artifacts',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * DELETE /api/files/:artifactId
 * Delete artifact (from database and storage)
 */
router.delete('/files/:artifactId', async (req: Request, res: Response) => {
  try {
    const { artifactId } = req.params;

    logger.info('Delete artifact request', { artifactId });

    const artifactRepo = getArtifactRepository();
    const deleted = await artifactRepo.delete(artifactId);

    if (!deleted) {
      return res.status(404).json({
        success: false,
        error: 'Artifact not found',
      });
    }

    return res.json({
      success: true,
      message: 'Artifact deleted successfully',
    });
  } catch (error) {
    logger.error('Delete artifact failed', {
      artifactId: req.params.artifactId,
      error: error instanceof Error ? error.message : String(error),
    });

    return res.status(500).json({
      success: false,
      error: 'Failed to delete artifact',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * POST /api/files/cleanup
 * Cleanup expired artifacts (manual trigger)
 */
router.post('/files/cleanup', async (_req: Request, res: Response): Promise<void> => {
  try {
    logger.info('Manual cleanup triggered');

    const artifactRepo = getArtifactRepository();
    const deletedCount = await artifactRepo.cleanupExpired();

    res.json({
      success: true,
      deleted_count: deletedCount,
      message: `Cleaned up ${deletedCount} expired artifacts`,
    });
  } catch (error) {
    logger.error('Cleanup failed', {
      error: error instanceof Error ? error.message : String(error),
    });

    res.status(500).json({
      success: false,
      error: 'Cleanup failed',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

export default router;
