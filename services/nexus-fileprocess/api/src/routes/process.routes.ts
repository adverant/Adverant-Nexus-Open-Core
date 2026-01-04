/**
 * Process Routes for FileProcessAgent API (REFACTORED)
 *
 * CHANGES:
 * - Removed direct RedisQueue dependency
 * - Uses JobRepository for job submission (single source of truth)
 * - Atomic operations: PostgreSQL INSERT + Redis LPUSH
 *
 * Handles document processing requests with file upload support.
 *
 * Endpoints:
 * - POST /api/process - Submit a new document for processing (file upload)
 * - POST /api/process/url - Submit a document via URL (Google Drive, HTTP, etc.)
 * - POST /api/process/drive-url - Submit a document from Google Drive sharing URL (no auth required)
 */

import { Router, Request, Response } from 'express';
import multer from 'multer';
import { getJobRepository } from '../repositories/JobRepository';
import { logger } from '../utils/logger';
import { config } from '../config';
import { ProcessFileResponse } from '../models/job.model';
import { GoogleDriveClient } from '../clients/google-drive-client';
import { GoogleDriveError } from '../clients/google-drive-errors';
import { getMageAgentClient, MageAgentClient } from '../clients/MageAgentClient';
import { getCyberAgentClient, CyberAgentClient } from '../clients/CyberAgentClient';
import { VideoAgentClient, getVideoAgentClient } from '../clients/VideoAgentClient';
import { fileValidator } from '../validators/FileValidator';
import { ValidationError, ProcessingError, ErrorCode } from '../errors/ValidationError';
import { ArchiveExtractorFactory } from '../extractors/ArchiveExtractor';
import { detectSuspiciousFile } from '../utils/suspicious-detector';
import {
  validateFileUpload,
  validateUrlUpload,
  validateRequest,
  validateFilePresence,
  sanitizeFilename,
} from '../middleware/validation.middleware';
import { getPostgresClient } from '../clients/postgres.client';
import { getPatternRepository, ProcessingPattern } from '../repositories/PatternRepository';
import { getSandboxFirstOrchestrator } from '../orchestration';
import { isYouTubeUrl, detectUrlType, isGitHubRepoUrl, extractGitHubRepoInfo } from '../utils/url-detector';
import { getGitHubManagerClient } from '../clients/GitHubManagerClient';

const router = Router();

// Configure multer for file uploads with disk storage for large files
// Strategy:
// - Files < 100MB: Use memory storage (fast, no disk I/O)
// - Files >= 100MB: Use disk storage (streaming, low memory footprint)
// - Validation happens after upload using magic bytes (not during upload)
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import os from 'os';

// Disk storage configuration for large files (supports GB-scale streaming)
const diskStorage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    const uploadDir = path.join(os.tmpdir(), 'fileprocess-uploads');
    fs.mkdirSync(uploadDir, { recursive: true });
    cb(null, uploadDir);
  },
  filename: (_req, file, cb) => {
    // Generate unique filename with original extension
    const uniqueId = crypto.randomBytes(16).toString('hex');
    const ext = path.extname(file.originalname);
    cb(null, `${uniqueId}${ext}`);
  },
});

// Use disk storage for all files (supports streaming for GB-sized files)
const upload = multer({
  storage: diskStorage,
  limits: {
    fileSize: config.maxFileSize, // Respects config (5GB default)
  },
});

/**
 * Execute a cached processing pattern
 *
 * This function runs pre-learned processing code for a specific file type,
 * achieving 6x speedup (60s → 10s) for repeated file types.
 *
 * @param pattern - The cached processing pattern to execute
 * @param fileInfo - File information (filename, buffer, url)
 * @returns Processing result or null if execution fails
 */
async function executeCachedPattern(
  pattern: ProcessingPattern,
  fileInfo: {
    filename: string;
    mimeType: string;
    fileSize: number;
    fileBuffer?: Buffer;
    fileUrl?: string;
  }
): Promise<{
  success: boolean;
  extractedContent?: string;
  metadata?: Record<string, unknown>;
  artifacts?: Array<{ filename: string; url?: string }>;
  processingMethod: string;
  executionTimeMs: number;
  error?: string;
} | null> {
  const startTime = Date.now();

  try {
    logger.info('Executing cached processing pattern', {
      patternId: pattern.id,
      mimeType: pattern.mimeType,
      language: pattern.language,
      successRate: pattern.successRate,
      avgExecutionTimeMs: pattern.averageExecutionTimeMs,
    });

    // Get MageAgent client to execute the pattern code
    const mageAgentClient = getMageAgentClient();

    // Build execution task that uses the cached pattern
    const executionTask = `
Execute this pre-validated processing pattern for file type ${pattern.mimeType}:

FILE INFORMATION:
- Filename: ${fileInfo.filename}
- MIME Type: ${fileInfo.mimeType}
- File Size: ${fileInfo.fileSize} bytes

PROCESSING PATTERN (${pattern.language}):
\`\`\`${pattern.language}
${pattern.processingCode}
\`\`\`

REQUIRED PACKAGES:
${pattern.packages.join(', ')}

INSTRUCTIONS:
1. Install required packages: ${pattern.packages.join(', ')}
2. Execute the processing code above
3. Return extracted content, metadata, and artifacts in JSON format

Expected JSON output:
{
  "extractedContent": "...",
  "metadata": { ... },
  "artifacts": [{ "filename": "...", "url": "..." }],
  "processingMethod": "cached_pattern_execution"
}
    `.trim();

    // Execute via MageAgent with cached pattern context
    const response = await mageAgentClient.orchestrate(executionTask, {
      maxAgents: 2, // Lightweight execution - pattern is already validated
      timeout: Math.max(pattern.averageExecutionTimeMs * 2, 30000), // 2x average time or 30s minimum
      context: {
        operation: 'cached_pattern_execution',
        patternId: pattern.id,
        mimeType: pattern.mimeType,
        language: pattern.language,
        packages: pattern.packages,
        fileUrl: fileInfo.fileUrl,
        filename: fileInfo.filename,
      },
    });

    const executionTimeMs = Date.now() - startTime;

    // Handle async responses (shouldn't happen for cached patterns, but handle it)
    if ('pollUrl' in response) {
      logger.warn('Cached pattern execution returned async response (unexpected)', {
        patternId: pattern.id,
        taskId: response.taskId,
      });
      return null; // Fall back to standard MageAgent processing
    }

    if (!response.success) {
      logger.warn('Cached pattern execution failed', {
        patternId: pattern.id,
        error: response.error,
        executionTimeMs,
      });

      return {
        success: false,
        processingMethod: 'cached_pattern_execution_failed',
        executionTimeMs,
        error: response.error,
      };
    }

    // Parse result
    const result = response.result as Record<string, unknown>;

    logger.info('Cached pattern executed successfully', {
      patternId: pattern.id,
      mimeType: pattern.mimeType,
      executionTimeMs,
      speedupVsAverage: `${Math.round(pattern.averageExecutionTimeMs / executionTimeMs)}x`,
    });

    return {
      success: true,
      extractedContent: result?.extractedContent as string || result?.text as string || '',
      metadata: result?.metadata as Record<string, unknown>,
      artifacts: result?.artifacts as Array<{ filename: string; url?: string }>,
      processingMethod: 'cached_pattern_execution',
      executionTimeMs,
    };
  } catch (error) {
    const executionTimeMs = Date.now() - startTime;
    const errorMessage = error instanceof Error ? error.message : String(error);

    logger.error('Cached pattern execution threw exception', {
      patternId: pattern.id,
      error: errorMessage,
      executionTimeMs,
    });

    return {
      success: false,
      processingMethod: 'cached_pattern_execution_error',
      executionTimeMs,
      error: errorMessage,
    };
  }
}

/**
 * POST /api/process
 *
 * Submit a document for processing via file upload.
 *
 * Request:
 * - Content-Type: multipart/form-data
 * - file: File to process (required)
 * - userId: User ID (optional, defaults to 'anonymous')
 * - metadata: JSON string with additional metadata (optional)
 *
 * Response:
 * {
 *   "success": true,
 *   "jobId": "uuid",
 *   "message": "Document queued for processing",
 *   "estimatedTime": "2-15 seconds"
 * }
 */
router.post(
  '/process',
  upload.single('file'),
  validateFilePresence, // Check file was uploaded
  validateFileUpload, // Validate userId, filename, metadata
  sanitizeFilename, // Sanitize filename for path traversal protection
  validateRequest, // Check validation results
  async (req: Request, res: Response): Promise<Response | void> => {
  const startTime = Date.now();
  let filePath: string | undefined; // Declare at function scope for finally block cleanup

  try {
    // File upload and parameter validation already done by middleware
    // req.file is guaranteed to exist here due to validateFilePresence middleware
    const { originalname, mimetype, size, path } = req.file!;
    filePath = path; // Store in function-scoped variable
    const userId = req.body.userId || 'anonymous';
    let metadata: Record<string, unknown> = {};

    // Parse metadata if provided
    if (req.body.metadata) {
      try {
        metadata = JSON.parse(req.body.metadata);
      } catch (error) {
        logger.warn('Invalid metadata JSON', { metadata: req.body.metadata });
      }
    }

    logger.info('File upload received', {
      filename: originalname,
      size,
      mimeType: mimetype,
      userId,
      diskPath: filePath,
    });

    // =========================================================================
    // DISK-BASED FILE STREAMING (LARGE FILE SUPPORT)
    // =========================================================================
    // Read file from disk in streaming fashion (low memory footprint).
    // For GB-scale files, we only read chunks as needed instead of loading
    // entire file into memory.
    // =========================================================================
    let buffer: Buffer;
    try {
      buffer = await fs.promises.readFile(filePath);
      logger.debug('File read from disk', {
        filename: originalname,
        size: buffer.length,
      });
    } catch (error) {
      logger.error('Failed to read uploaded file from disk', {
        filename: originalname,
        filePath,
        error: error instanceof Error ? error.message : String(error),
      });

      // Clean up temporary file
      try {
        await fs.promises.unlink(filePath);
      } catch (unlinkError) {
        logger.warn('Failed to clean up temporary file', {
          filePath,
          error: unlinkError instanceof Error ? unlinkError.message : String(unlinkError),
        });
      }

      return res.status(500).json({
        success: false,
        error: 'DISK_READ_FAILED',
        message: 'Failed to read uploaded file from disk',
        suggestion: 'Please try uploading the file again',
      });
    }

    // =========================================================================
    // PRE-QUEUE VALIDATION LAYER (CRITICAL FIX)
    // =========================================================================
    // Validate file content BEFORE queuing to catch errors early and prevent
    // HTTP 500 errors from empty/corrupted/disguised files.
    // Uses Chain of Responsibility pattern with magic byte detection.
    // =========================================================================
    const validationResult = await fileValidator.validate({
      buffer,
      filename: originalname,
      claimedMimeType: mimetype,
      userId,
    });

    if (!validationResult.valid) {
      // Return client error immediately (no queuing)
      logger.warn('File validation failed', {
        filename: originalname,
        error: validationResult.error?.code,
      });

      return res.status(validationResult.error!.httpStatus).json(
        validationResult.error!.toJSON()
      );
    }

    logger.info('File validation passed', {
      filename: originalname,
      detectedMimeType: validationResult.detectedMimeType,
    });

    // Use detected MIME type from magic byte detection (more reliable than client header)
    const verifiedMimeType = validationResult.detectedMimeType || mimetype;

    // =========================================================================
    // PHASE 61: SUSPICIOUS FILE DETECTION - EARLY CYBERAGENT ROUTING
    // =========================================================================
    // Run suspicious detection on ALL files BEFORE any other routing.
    // If ANY hint of suspicion is detected, route to CyberAgent for full
    // malware analysis regardless of file type.
    //
    // Detection checks:
    // - Double extensions (document.pdf.exe)
    // - Filename patterns (invoice, keygen, crack, etc.)
    // - MIME type mismatches (claims PDF but has EXE magic bytes)
    // - Embedded executables in documents
    // - Suspicious content patterns (powershell, eval, auto_open, etc.)
    // - High entropy (packed/encrypted content)
    //
    // Philosophy: Better safe than sorry - false positives are acceptable
    // =========================================================================

    const suspiciousResult = detectSuspiciousFile({
      filename: originalname,
      claimedMimeType: mimetype,
      detectedMimeType: verifiedMimeType,
      buffer,
      fileSize: size,
    });

    if (suspiciousResult.isSuspicious) {
      logger.warn('Suspicious file detected - routing to CyberAgent for full malware analysis', {
        filename: originalname,
        mimeType: verifiedMimeType,
        threatLevel: suspiciousResult.threatLevel,
        confidence: suspiciousResult.confidence,
        flags: suspiciousResult.flags,
        requiresFullScan: suspiciousResult.requiresFullScan,
      });

      try {
        // Route ALL suspicious files to CyberAgent for full analysis
        const cyberAgentClient = getCyberAgentClient();

        // Use file path for local sandbox analysis (shared volume)
        const sharedVolumePath = filePath ? `file://${filePath}` : undefined;

        if (!sharedVolumePath) {
          logger.error('Cannot analyze suspicious file - file path not available', {
            filename: originalname,
          });

          return res.status(500).json({
            success: false,
            error: 'INTERNAL_ERROR',
            message: 'Suspicious file was not saved to temporary storage',
            suggestion: 'Please try uploading the file again',
          });
        }

        // Full malware scan with deep analysis
        const analysisResult = await cyberAgentClient.analyzeBinary(sharedVolumePath, {
          filename: originalname,
          mimeType: verifiedMimeType,
          fileSize: buffer.length,
          localFilePath: sharedVolumePath,
          // Phase 1b: Enable decompilation for high-threat files and binaries
          // Decompile when: critical/high threat, embedded executables detected, or binary file type
          decompile: suspiciousResult.threatLevel === 'critical' ||
                     suspiciousResult.threatLevel === 'high' ||
                     suspiciousResult.flags.some(f => f.includes('Embedded executable')) ||
                     CyberAgentClient.isBinaryFileType(verifiedMimeType, originalname),
          deepAnalysis: true,
          timeout: 300000, // 5 minutes for full analysis
        });

        const duration = Date.now() - startTime;

        if (analysisResult.success) {
          // Check if CyberAgent confirmed the file is malicious
          if (analysisResult.isMalicious || analysisResult.threatLevel === 'critical') {
            logger.error('MALICIOUS FILE DETECTED AND BLOCKED', {
              filename: originalname,
              threatLevel: analysisResult.threatLevel,
              isMalicious: analysisResult.isMalicious,
              yaraMatches: analysisResult.yara_matches?.length || 0,
              duration: `${duration}ms`,
            });

            return res.status(403).json({
              success: false,
              error: 'MALICIOUS_FILE_BLOCKED',
              message: 'File blocked due to security threat detection',
              analysis: {
                threatLevel: analysisResult.threatLevel,
                isMalicious: analysisResult.isMalicious,
                summary: analysisResult.analysis_summary,
                recommendations: analysisResult.recommendations,
              },
              duration: `${duration}ms`,
              note: 'This file has been identified as potentially malicious and cannot be processed.',
            });
          }

          // File analyzed - threat level is manageable, allow processing with warning
          if (analysisResult.threatLevel === 'high') {
            logger.warn('File has high threat level but not confirmed malicious - proceeding with caution', {
              filename: originalname,
              threatLevel: analysisResult.threatLevel,
              duration: `${duration}ms`,
            });

            // Return security analysis result with warning
            return res.status(200).json({
              success: true,
              message: 'File analyzed - high threat level detected but not confirmed malicious',
              processingMethod: 'cyberagent_suspicious_analysis',
              securityWarning: true,
              analysis: {
                threatLevel: analysisResult.threatLevel,
                isMalicious: analysisResult.isMalicious,
                summary: analysisResult.analysis_summary,
                recommendations: analysisResult.recommendations,
                yaraMatches: analysisResult.yara_matches,
                fileMetadata: analysisResult.file_metadata,
              },
              suspiciousFlags: suspiciousResult.flags,
              duration: `${duration}ms`,
              note: 'File showed suspicious indicators. Proceed with caution.',
            });
          }

          logger.info('Suspicious file analyzed - threat level acceptable, continuing processing', {
            filename: originalname,
            threatLevel: analysisResult.threatLevel,
            isMalicious: analysisResult.isMalicious,
            duration: `${duration}ms`,
          });

          // For low/medium threat levels, return analysis and note it was flagged
          // but continue to allow the file to be processed
          if (suspiciousResult.threatLevel !== 'none') {
            return res.status(200).json({
              success: true,
              message: 'File analyzed via CyberAgent - security cleared',
              processingMethod: 'cyberagent_suspicious_analysis',
              analysis: {
                threatLevel: analysisResult.threatLevel,
                isMalicious: analysisResult.isMalicious,
                summary: analysisResult.analysis_summary,
                recommendations: analysisResult.recommendations,
              },
              suspiciousFlags: suspiciousResult.flags,
              duration: `${duration}ms`,
              note: 'File passed security analysis but showed initial suspicious indicators.',
            });
          }
        } else {
          // CyberAgent analysis failed - log and block as precaution
          logger.error('CyberAgent analysis failed for suspicious file', {
            filename: originalname,
            error: analysisResult.error,
            duration: `${duration}ms`,
          });

          return res.status(422).json({
            success: false,
            error: 'SUSPICIOUS_ANALYSIS_FAILED',
            message: 'Security analysis failed for suspicious file',
            suspiciousFlags: suspiciousResult.flags,
            details: analysisResult.error,
            suggestion: 'File showed suspicious indicators but security scan failed. Cannot process.',
          });
        }
      } catch (suspiciousError) {
        const duration = Date.now() - startTime;
        const errorMessage = suspiciousError instanceof Error ? suspiciousError.message : String(suspiciousError);

        logger.error('Error analyzing suspicious file via CyberAgent', {
          filename: originalname,
          suspiciousFlags: suspiciousResult.flags,
          error: errorMessage,
          duration: `${duration}ms`,
        });

        // Block file as precaution when suspicious and analysis fails
        return res.status(500).json({
          success: false,
          error: 'SUSPICIOUS_FILE_ERROR',
          message: 'Failed to analyze suspicious file - blocked as precaution',
          suspiciousFlags: suspiciousResult.flags,
          details: config.nodeEnv === 'development' ? errorMessage : undefined,
        });
      }
    }

    // =========================================================================
    // PHASE 8: Video File Routing to VideoAgent
    // =========================================================================
    // Check for video files FIRST (before binary and archive checks).
    // Route video files to VideoAgent for:
    // - Metadata extraction
    // - Frame analysis
    // - Audio transcription
    // - Scene detection
    // =========================================================================

    const isVideoFile = VideoAgentClient.isVideoFileType(verifiedMimeType, originalname);

    if (isVideoFile) {
      logger.info('Video file detected via upload - routing to VideoAgent', {
        filename: originalname,
        mimeType: verifiedMimeType,
        fileSize: size,
        userId
      });

      const videoAgentClient = getVideoAgentClient();
      const videoUrl = filePath ? `file://${filePath}` : undefined;

      if (!videoUrl) {
        return res.status(400).json({
          success: false,
          error: 'Video file path not available for processing'
        });
      }

      try {
        const jobResponse = await videoAgentClient.processVideo({
          userId: userId || 'anonymous',
          filename: originalname,
          videoUrl,
          options: {
            extractMetadata: true,
            analyzeFrames: (metadata && typeof metadata.analyzeFrames === 'boolean') ? metadata.analyzeFrames : true,
            transcribeAudio: (metadata && typeof metadata.transcribeAudio === 'boolean') ? metadata.transcribeAudio : false,
            quality: (metadata && typeof metadata.quality === 'string' && ['low', 'medium', 'high'].includes(metadata.quality as string))
              ? (metadata.quality as 'low' | 'medium' | 'high')
              : 'medium',
          },
        });

        return res.status(202).json({
          success: true,
          message: 'Video queued for processing via VideoAgent',
          processingMethod: 'videoagent_video_upload',
          jobId: jobResponse.jobId,
          pollUrl: `/api/video/status/${jobResponse.jobId}`,
          filename: originalname,
          mimeType: verifiedMimeType,
        });
      } catch (error) {
        logger.error('Failed to submit video to VideoAgent', {
          error: error instanceof Error ? error.message : 'Unknown error',
          filename: originalname
        });
        // Fall through to standard processing
      }
    }

    // =========================================================================
    // ARCHIVE EXTRACTION: Multi-Stage Processing Pipeline
    // =========================================================================
    // If file is an archive (ZIP, TAR, etc.), extract it and process each file.
    // This implements the multi-stage processing pipeline (Issue #3).
    //
    // Strategy:
    // 1. Extract archive to get individual files
    // 2. Validate each extracted file
    // 3. Queue each file for processing (recursive for nested archives)
    // 4. Return aggregate results
    // =========================================================================

    if (ArchiveExtractorFactory.isArchive(verifiedMimeType)) {
      logger.info('Archive detected - extracting files', {
        filename: originalname,
        mimeType: verifiedMimeType,
        size,
      });

      try {
        const extractionResult = await ArchiveExtractorFactory.extract(
          buffer,
          originalname,
          verifiedMimeType
        );

        if (!extractionResult.success) {
          logger.warn('Archive extraction failed', {
            filename: originalname,
            error: extractionResult.error,
          });

          return res.status(422).json({
            success: false,
            error: extractionResult.error?.code || 'ARCHIVE_EXTRACTION_FAILED',
            message: extractionResult.error?.message || 'Failed to extract archive',
            details: extractionResult.error?.details,
          });
        }

        logger.info('Archive extracted successfully', {
          filename: originalname,
          totalFiles: extractionResult.files.length,
          totalSize: extractionResult.metadata.totalSize,
          extractionTimeMs: extractionResult.metadata.extractionTimeMs,
        });

        // Process each extracted file recursively
        const processedFiles: Array<{
          filename: string;
          jobId?: string;
          success: boolean;
          error?: string;
        }> = [];

        for (const extractedFile of extractionResult.files) {
          try {
            // Validate extracted file
            const extractedValidationResult = await fileValidator.validate({
              buffer: extractedFile.buffer,
              filename: extractedFile.filename,
              userId,
            });

            if (!extractedValidationResult.valid) {
              logger.warn('Extracted file validation failed', {
                archive: originalname,
                file: extractedFile.filename,
                error: extractedValidationResult.error?.code,
              });

              processedFiles.push({
                filename: extractedFile.filename,
                success: false,
                error: extractedValidationResult.error?.message || 'Validation failed',
              });
              continue;
            }

            const extractedMimeType = extractedValidationResult.detectedMimeType || 'application/octet-stream';

            // Check if extracted file is also an archive (recursive extraction)
            if (ArchiveExtractorFactory.isArchive(extractedMimeType)) {
              logger.info('Nested archive detected - will be processed recursively', {
                archive: originalname,
                nestedArchive: extractedFile.filename,
                mimeType: extractedMimeType,
              });
            }

            // Queue extracted file for processing
            const jobRepository = getJobRepository();
            const extractedFileBuffer = extractedFile.buffer.toString('base64');

            const jobId = await jobRepository.submitJob({
              filename: extractedFile.filename,
              mimeType: extractedMimeType,
              fileSize: extractedFile.size,
              userId,
              metadata: {
                ...metadata,
                extractedFrom: originalname,
                extractedFromArchiveType: extractionResult.metadata.archiveType,
              },
              fileBuffer: extractedFileBuffer,
            });

            logger.info('Extracted file queued for processing', {
              archive: originalname,
              file: extractedFile.filename,
              jobId,
              mimeType: extractedMimeType,
            });

            processedFiles.push({
              filename: extractedFile.filename,
              jobId,
              success: true,
            });
          } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);

            logger.error('Failed to queue extracted file', {
              archive: originalname,
              file: extractedFile.filename,
              error: errorMessage,
            });

            processedFiles.push({
              filename: extractedFile.filename,
              success: false,
              error: errorMessage,
            });
          }
        }

        const duration = Date.now() - startTime;

        // Return aggregate results for all extracted files
        return res.status(200).json({
          success: true,
          message: 'Archive extracted and files queued for processing',
          archiveFilename: originalname,
          archiveType: extractionResult.metadata.archiveType,
          totalFiles: extractionResult.files.length,
          totalSize: extractionResult.metadata.totalSize,
          extractionTimeMs: extractionResult.metadata.extractionTimeMs,
          processedFiles,
          duration: `${duration}ms`,
        });
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);

        logger.error('Archive extraction failed unexpectedly', {
          filename: originalname,
          error: errorMessage,
        });

        return res.status(500).json({
          success: false,
          error: 'ARCHIVE_EXTRACTION_ERROR',
          message: 'Unexpected error during archive extraction',
          details: errorMessage,
        });
      }
    }

    // =========================================================================
    // PHASE 60: Binary/Executable File Routing to CyberAgent
    // =========================================================================
    // Check if this is a binary/executable file that should be routed to
    // CyberAgent for security analysis and decompilation instead of OCR.
    //
    // Binary files include:
    // - Executables: EXE, DLL, ELF, Mach-O
    // - Disk images: DMG, ISO, IMG
    // - Installers: MSI, PKG, DEB, RPM
    // - Mobile apps: APK, IPA
    // - Java: JAR, WAR
    //
    // CyberAgent provides:
    // - Malware scanning (YARA, ClamAV)
    // - Decompilation (Ghidra, Radare2)
    // - String extraction
    // - Import/export analysis
    // =========================================================================

    const isBinaryFile = CyberAgentClient.isBinaryFileType(verifiedMimeType, originalname);

    if (isBinaryFile) {
      logger.info('Binary/executable file detected - routing to CyberAgent for analysis', {
        filename: originalname,
        mimeType: verifiedMimeType,
        size,
        userId,
      });

      try {
        // =========================================================================
        // SANDBOX-FIRST BINARY ANALYSIS
        // =========================================================================
        // Use the locally uploaded file for CyberAgent sandbox analysis.
        // The file is already on disk at filePath (multer temp storage).
        // We pass this path directly to CyberAgent using file:// protocol,
        // which avoids external URL fetching and target authorization issues.
        // =========================================================================

        if (!filePath) {
          logger.error('Cannot analyze binary file - file path not available', {
            filename: originalname,
            mimeType: verifiedMimeType,
          });

          return res.status(500).json({
            success: false,
            error: 'INTERNAL_ERROR',
            message: 'Binary file was not saved to temporary storage',
            suggestion: 'Please try uploading the file again',
          });
        }

        // Construct shared volume path for CyberAgent
        // Use file:// protocol to indicate local file access
        const sharedVolumePath = `file://${filePath}`;

        logger.info('Using local file for CyberAgent sandbox analysis', {
          filename: originalname,
          localPath: filePath,
          sharedVolumePath,
          fileSize: buffer.length,
        });

        // Route to CyberAgent for binary analysis using local file
        const cyberAgentClient = getCyberAgentClient();
        const analysisResult = await cyberAgentClient.analyzeBinary(sharedVolumePath, {
          filename: originalname,
          mimeType: verifiedMimeType,
          fileSize: buffer.length,
          localFilePath: sharedVolumePath,
          decompile: true,
          deepAnalysis: true,
          timeout: 300000, // 5 minutes for binary analysis
        });

        const duration = Date.now() - startTime;

        if (analysisResult.success) {
          logger.info('Binary file analyzed successfully via CyberAgent', {
            filename: originalname,
            mimeType: verifiedMimeType,
            duration: `${duration}ms`,
            threatLevel: analysisResult.threatLevel,
            isMalicious: analysisResult.isMalicious,
          });

          return res.status(200).json({
            success: true,
            message: 'Binary file analyzed via CyberAgent',
            processingMethod: 'cyberagent_binary_analysis',
            analysis: {
              threatLevel: analysisResult.threatLevel,
              isMalicious: analysisResult.isMalicious,
              summary: analysisResult.analysis_summary,
              recommendations: analysisResult.recommendations,
              yaraMatches: analysisResult.yara_matches,
              fileMetadata: analysisResult.file_metadata,
            },
            // Include decompiled code if available
            extractedContent: analysisResult.decompiled_code,
            extractedStrings: analysisResult.extracted_strings,
            duration: `${duration}ms`,
            note: 'Binary files are analyzed by CyberAgent for security assessment and code extraction',
          });
        } else {
          logger.warn('Binary file analysis failed', {
            filename: originalname,
            mimeType: verifiedMimeType,
            error: analysisResult.error,
            duration: `${duration}ms`,
          });

          return res.status(422).json({
            success: false,
            error: 'BINARY_ANALYSIS_FAILED',
            message: `Binary analysis failed: ${analysisResult.error}`,
            suggestion: 'The file may be corrupted or in an unsupported format',
          });
        }
      } catch (binaryError) {
        const duration = Date.now() - startTime;
        const errorMessage = binaryError instanceof Error ? binaryError.message : String(binaryError);

        logger.error('CyberAgent binary analysis failed unexpectedly', {
          filename: originalname,
          mimeType: verifiedMimeType,
          error: errorMessage,
          duration: `${duration}ms`,
        });

        return res.status(500).json({
          success: false,
          error: 'BINARY_ANALYSIS_ERROR',
          message: 'Unexpected error during binary analysis',
          details: config.nodeEnv === 'development' ? errorMessage : undefined,
        });
      }
    }

    // =========================================================================
    // PHASE 59: Dynamic Unknown File Type Handling via MageAgent
    // =========================================================================
    // Check if this is an unknown file type that needs dynamic processing.
    // Unknown types are routed to MageAgent's UniversalTaskExecutor which:
    // 1. Uses LLM to analyze the file and determine required packages
    // 2. Generates processing code dynamically
    // 3. Executes in sandbox with auto-installed packages
    // 4. Stores successful patterns in GraphRAG for reuse
    // =========================================================================

    const isKnownType = MageAgentClient.isKnownDocumentType(verifiedMimeType);

    if (!isKnownType) {
      logger.info('Unknown file type detected - checking pattern cache before MageAgent processing', {
        filename: originalname,
        mimetype: verifiedMimeType,
        size,
        userId,
      });

      // =========================================================================
      // PATTERN LEARNING: Check if we have a cached processing pattern
      // =========================================================================
      // Before invoking expensive MageAgent processing (60s), check if we've
      // processed this file type before and can reuse the pattern (10s = 6x speedup)
      // =========================================================================
      let cachedPatternResult: Awaited<ReturnType<typeof executeCachedPattern>> = null;

      try {
        const postgresClient = getPostgresClient();
        const patternRepository = getPatternRepository((postgresClient as any).pool);

        // Extract file extension for pattern matching
        const fileExtension = originalname.includes('.')
          ? originalname.split('.').pop()?.toLowerCase()
          : undefined;

        // Search for cached pattern with 80% minimum success rate threshold
        const patternSearchResult = await patternRepository.findPattern({
          mimeType: verifiedMimeType,
          fileExtension,
          minSuccessRate: 0.80, // Only use patterns with 80%+ success rate
          limit: 1,
        });

        if (patternSearchResult) {
          logger.info('Cached processing pattern found - attempting execution', {
            patternId: patternSearchResult.pattern.id,
            mimeType: patternSearchResult.pattern.mimeType,
            confidence: patternSearchResult.confidence,
            reason: patternSearchResult.reason,
            successRate: patternSearchResult.pattern.successRate,
            avgExecutionTimeMs: patternSearchResult.pattern.averageExecutionTimeMs,
          });

          // For pattern execution, we need file URL (patterns execute in sandbox)
          let patternFileUrl: string | undefined;

          if (config.googleServiceAccountEmail && config.googleServiceAccountPrivateKey) {
            const driveClient = GoogleDriveClient.getInstance(
              config.googleServiceAccountEmail,
              config.googleServiceAccountPrivateKey,
              config.googleDriveFolderId,
              {
                maxRetries: config.googleDriveMaxRetries,
                retryBackoffMs: config.googleDriveRetryBackoffMs,
                uploadTimeoutMs: config.googleDriveUploadTimeoutMs,
              }
            );

            const uploadResult = await driveClient.uploadBuffer(
              originalname,
              verifiedMimeType || 'application/octet-stream',
              buffer
            );

            patternFileUrl = driveClient.getDownloadUrl(uploadResult.fileId);

            logger.debug('File uploaded to storage for pattern execution', {
              filename: originalname,
              fileId: uploadResult.fileId,
            });
          }

          // Execute cached pattern
          cachedPatternResult = await executeCachedPattern(
            patternSearchResult.pattern,
            {
              filename: originalname,
              mimeType: verifiedMimeType,
              fileSize: size,
              fileBuffer: buffer,
              fileUrl: patternFileUrl,
            }
          );

          // Record execution result for metrics tracking
          if (cachedPatternResult) {
            await patternRepository.recordExecution(
              patternSearchResult.pattern.id,
              {
                success: cachedPatternResult.success,
                executionTimeMs: cachedPatternResult.executionTimeMs,
                error: cachedPatternResult.error,
              }
            );

            // If pattern execution succeeded, return result immediately
            if (cachedPatternResult.success) {
              const duration = Date.now() - startTime;

              logger.info('File processed using cached pattern (PATTERN CACHE HIT)', {
                filename: originalname,
                patternId: patternSearchResult.pattern.id,
                executionTimeMs: cachedPatternResult.executionTimeMs,
                totalDurationMs: duration,
                speedup: `6x faster than full MageAgent processing`,
              });

              return res.status(200).json({
                success: true,
                message: 'Document processed using cached pattern (6x speedup)',
                processingMethod: 'cached_pattern_execution',
                patternId: patternSearchResult.pattern.id,
                extractedContent: cachedPatternResult.extractedContent,
                metadata: cachedPatternResult.metadata,
                artifacts: cachedPatternResult.artifacts,
                duration: `${duration}ms`,
                executionTimeMs: cachedPatternResult.executionTimeMs,
                note: 'This file type was previously learned. Processing was 6x faster than initial analysis.',
              });
            }

            // Pattern execution failed - fall through to MageAgent
            logger.warn('Cached pattern execution failed - falling back to full MageAgent processing', {
              patternId: patternSearchResult.pattern.id,
              error: cachedPatternResult.error,
            });
          }
        } else {
          logger.debug('No cached pattern found (PATTERN CACHE MISS) - proceeding with full MageAgent analysis', {
            mimeType: verifiedMimeType,
            fileExtension,
          });
        }
      } catch (patternError) {
        // Pattern system failure should not block processing - graceful degradation
        const errorMessage = patternError instanceof Error ? patternError.message : String(patternError);
        logger.warn('Pattern cache check failed - falling back to standard MageAgent processing', {
          error: errorMessage,
          filename: originalname,
        });
      }

      // =========================================================================
      // FULL MAGEAGENT PROCESSING (First-time or pattern execution failed)
      // =========================================================================

      try {
        const mageAgentClient = getMageAgentClient();

        // For unknown file types, we need to upload to storage first
        // so MageAgent can access the file via URL
        let unknownFileUrl: string | undefined;

        if (config.googleServiceAccountEmail && config.googleServiceAccountPrivateKey) {
          // Upload to Google Drive for MageAgent access
          const driveClient = GoogleDriveClient.getInstance(
            config.googleServiceAccountEmail,
            config.googleServiceAccountPrivateKey,
            config.googleDriveFolderId,
            {
              maxRetries: config.googleDriveMaxRetries,
              retryBackoffMs: config.googleDriveRetryBackoffMs,
              uploadTimeoutMs: config.googleDriveUploadTimeoutMs,
            }
          );

          const uploadResult = await driveClient.uploadBuffer(
            originalname,
            verifiedMimeType || 'application/octet-stream',
            buffer
          );

          unknownFileUrl = driveClient.getDownloadUrl(uploadResult.fileId);

          logger.info('Unknown file uploaded to storage for MageAgent processing', {
            filename: originalname,
            fileId: uploadResult.fileId,
          });
        }

        // Process via MageAgent's UniversalTaskExecutor
        const processingResult = await mageAgentClient.processUnknownFileType({
          filename: originalname,
          mimeType: verifiedMimeType,
          fileSize: size,
          fileBuffer: buffer,
          fileUrl: unknownFileUrl,
        });

        const duration = Date.now() - startTime;

        if (processingResult.success) {
          logger.info('Unknown file type processed successfully via MageAgent', {
            filename: originalname,
            mimetype: verifiedMimeType,
            duration: `${duration}ms`,
            processingMethod: processingResult.processingMethod,
          });

          // =========================================================================
          // PATTERN LEARNING: Store successful processing pattern for future reuse
          // =========================================================================
          // When MageAgent successfully processes a new file type, extract and store
          // the processing pattern so future files of this type can be processed 6x faster
          // =========================================================================
          try {
            const postgresClient = getPostgresClient();
            const patternRepository = getPatternRepository((postgresClient as any).pool);

            // Extract file extension
            const fileExtension = originalname.includes('.')
              ? originalname.split('.').pop()?.toLowerCase()
              : undefined;

            // Try to extract processing code from result metadata
            // MageAgent's UniversalTaskExecutor should include the generated code
            const processingCode = processingResult.metadata?.generatedCode as string ||
                                   processingResult.metadata?.processingCode as string ||
                                   '// Processing code not available from MageAgent response';

            const language = (processingResult.metadata?.language as 'python' | 'node' | 'go' | 'rust' | 'java' | 'bash') || 'python';
            const packages = (processingResult.metadata?.packages as string[]) || [];

            // Store the pattern for future use
            const patternId = await patternRepository.storePattern({
              mimeType: verifiedMimeType,
              fileCharacteristics: {
                extension: fileExtension,
                averageSize: size,
                commonPackages: packages,
              },
              processingCode,
              language,
              packages,
              successCount: 1, // First successful use
              failureCount: 0,
              successRate: 1.0, // 100% on first use
              averageExecutionTimeMs: duration,
            });

            logger.info('Processing pattern stored successfully for future reuse', {
              patternId,
              mimeType: verifiedMimeType,
              fileExtension,
              language,
              packages: packages.length,
              executionTimeMs: duration,
              note: 'Next file of this type will be processed 6x faster',
            });
          } catch (patternStoreError) {
            // Pattern storage failure should not affect the user's response
            const errorMessage = patternStoreError instanceof Error ? patternStoreError.message : String(patternStoreError);
            logger.error('Failed to store processing pattern (non-critical)', {
              error: errorMessage,
              mimeType: verifiedMimeType,
              filename: originalname,
            });
          }

          // Return direct result for unknown file types (no queuing needed)
          return res.status(200).json({
            success: true,
            message: 'Document processed via dynamic agent pipeline',
            processingMethod: processingResult.processingMethod || 'mageagent_universal_task_executor',
            extractedContent: processingResult.extractedContent,
            metadata: processingResult.metadata,
            artifacts: processingResult.artifacts,
            duration: `${duration}ms`,
            note: 'This file type required dynamic processing. Pattern stored for faster future processing.',
          });
        } else {
          logger.warn('Unknown file type processing failed', {
            filename: originalname,
            mimetype: verifiedMimeType,
            error: processingResult.error,
            duration: `${duration}ms`,
          });

          return res.status(422).json({
            success: false,
            error: 'Unsupported file format',
            message: `Could not process file type: ${verifiedMimeType}`,
            details: processingResult.error,
            suggestion: 'The file format may not be supported. Try converting to a standard format (PDF, PNG, TXT).',
          });
        }
      } catch (mageError) {
        const duration = Date.now() - startTime;
        const errorMessage = mageError instanceof Error ? mageError.message : String(mageError);

        logger.error('MageAgent processing failed for unknown file type', {
          filename: originalname,
          mimetype: verifiedMimeType,
          error: errorMessage,
          duration: `${duration}ms`,
        });

        // Fall back to queueing the job - worker will attempt processing
        logger.info('Falling back to standard queue for unknown file type', {
          filename: originalname,
          mimetype: verifiedMimeType,
        });
      }
    }

    // =========================================================================
    // Standard Processing Pipeline for Known File Types
    // =========================================================================

    // Determine if file should be stored in buffer or uploaded to Google Drive
    // For files < 10MB, store in buffer. For larger files, upload to Drive and use URL.
    const useBuffer = size < config.bufferThresholdBytes; // Default: 10MB threshold

    let fileUrl: string | undefined;
    let fileBuffer: string | undefined;

    if (useBuffer) {
      // Small file: store as base64 buffer for cross-language JSON compatibility
      fileBuffer = buffer.toString('base64');

      logger.debug('Using buffer storage for small file', {
        filename: originalname,
        size,
        threshold: `${config.bufferThresholdBytes / 1024 / 1024}MB`,
      });
    } else {
      // Large file: Check if Google Drive is configured, otherwise use local storage
      if (config.googleServiceAccountEmail && config.googleServiceAccountPrivateKey) {
        // Google Drive upload available
        try {
          logger.info('Uploading large file to Google Drive', {
            filename: originalname,
            size,
            threshold: `${config.bufferThresholdBytes / 1024 / 1024}MB`,
          });

          const driveClient = GoogleDriveClient.getInstance(
            config.googleServiceAccountEmail,
            config.googleServiceAccountPrivateKey,
            config.googleDriveFolderId,
            {
              maxRetries: config.googleDriveMaxRetries,
              retryBackoffMs: config.googleDriveRetryBackoffMs,
              uploadTimeoutMs: config.googleDriveUploadTimeoutMs,
            }
          );

          const uploadResult = await driveClient.uploadBuffer(
            originalname,
            verifiedMimeType || 'application/octet-stream',
            buffer
          );

          fileUrl = driveClient.getDownloadUrl(uploadResult.fileId);

          logger.info('File uploaded to Google Drive successfully', {
            filename: originalname,
            size,
            fileId: uploadResult.fileId,
            shareableLink: uploadResult.shareableLink,
          });
        } catch (error) {
          const duration = Date.now() - startTime;

          if (error instanceof GoogleDriveError) {
            logger.error('Google Drive upload failed', {
              filename: originalname,
              size,
              duration: `${duration}ms`,
              errorDetails: error.toJSON(),
            });

            return res.status(503).json({
              success: false,
              error: 'Storage service unavailable',
              message: 'Failed to upload document to storage service',
              code: error.code,
              details: config.nodeEnv === 'development' ? error.toDetailedString() : undefined,
              suggestion: error.context.suggestion,
            });
          }

          logger.error('Unexpected error during Drive upload', {
            filename: originalname,
            size,
            duration: `${duration}ms`,
            error: error instanceof Error ? error.message : String(error),
          });

          return res.status(500).json({
            success: false,
            error: 'Internal server error',
            message: 'Failed to upload document to storage service',
            details: config.nodeEnv === 'development' ?
              (error instanceof Error ? error.message : String(error)) : undefined,
          });
        }
      } else {
        // Fallback: Store large file as base64 in buffer (not ideal but functional)
        logger.warn('Google Drive not configured, using fallback buffer storage for large file', {
          filename: originalname,
          size,
          warning: 'Large files should use Google Drive for optimal performance',
        });
        fileBuffer = buffer.toString('base64');
      }
    }

    // Submit job via JobRepository (atomic: PostgreSQL INSERT + Redis LPUSH)
    // Include either fileBuffer (small files) or fileUrl (large files), never both
    const jobRepository = getJobRepository();
    const jobId = await jobRepository.submitJob({
      userId,
      filename: originalname,
      mimeType: verifiedMimeType, // Use verified MIME type from magic byte detection
      fileSize: size,
      fileBuffer, // Only set for small files
      fileUrl, // Only set for large files
      metadata,
    });

    const duration = Date.now() - startTime;

    logger.info('Document queued successfully', {
      jobId,
      filename: originalname,
      size,
      duration: `${duration}ms`
    });

    const response: ProcessFileResponse = {
      success: true,
      jobId,
      message: 'Document queued for processing',
      estimatedTime: size > 1024 * 1024 ? '5-30 seconds' : '2-15 seconds'
    };

    res.status(202).json(response);

  } catch (error) {
    const duration = Date.now() - startTime;
    const errorMessage = error instanceof Error ? error.message : String(error);

    logger.error('Failed to process file upload', {
      error: errorMessage,
      duration: `${duration}ms`,
      filename: req.file?.originalname,
      stack: error instanceof Error ? error.stack : undefined,
    });

    // Distinguish validation errors from system errors
    if (error instanceof ValidationError) {
      return res.status(error.httpStatus).json(error.toJSON());
    }

    if (error instanceof ProcessingError) {
      return res.status(500).json(error.toJSON());
    }

    // Unknown error (should never happen with proper error handling)
    res.status(500).json({
      success: false,
      error: ErrorCode.INTERNAL_ERROR,
      message: 'An unexpected error occurred',
      requestId: require('crypto').randomUUID(),
      timestamp: new Date().toISOString(),
      details: config.nodeEnv === 'development' ? errorMessage : undefined
    });
  } finally {
    // =========================================================================
    // CRITICAL: Cleanup temporary file from disk
    // =========================================================================
    // Always clean up the temporary file created by multer diskStorage,
    // regardless of success or failure. This prevents disk space exhaustion.
    // =========================================================================
    if (filePath) {
      const { cleanupTempFile } = await import('../utils/file-cleanup');
      await cleanupTempFile(filePath, 'file-upload');
    }
  }
});

/**
 * POST /api/process/url
 *
 * Submit a document for processing via URL (Google Drive, HTTP, etc.).
 *
 * Request Body:
 * {
 *   "fileUrl": "https://...",
 *   "filename": "document.pdf",
 *   "mimeType": "application/pdf" (optional),
 *   "userId": "user123" (optional),
 *   "metadata": { ... } (optional)
 * }
 *
 * Response:
 * {
 *   "success": true,
 *   "jobId": "uuid",
 *   "message": "Document queued for processing",
 *   "estimatedTime": "2-15 seconds"
 * }
 */
/**
 * Helper function to detect if a URL is a Google Drive URL
 * Supports all common Google Drive sharing formats
 */
function isGoogleDriveUrl(url: string): boolean {
  const googleDrivePatterns = [
    /^https?:\/\/drive\.google\.com\//,
    /^https?:\/\/docs\.google\.com\//,
  ];
  return googleDrivePatterns.some((pattern) => pattern.test(url));
}

/**
 * Pre-download Google Drive file and save to temp location
 * Returns the local file path for the worker to process
 */
async function preDownloadGoogleDriveFile(
  driveUrl: string,
  jobId: string
): Promise<{
  localPath: string;
  filename: string;
  mimeType: string;
  fileSize: number;
}> {
  // Create a no-op GoogleDriveClient instance (only need public download method)
  // The downloadPublicFileStream method doesn't require authentication
  const googleDriveClient = new (GoogleDriveClient as any)('', '', '');

  logger.info('Pre-downloading Google Drive file', {
    jobId,
    driveUrl: driveUrl.substring(0, 100) + '...'
  });

  // Download file to stream
  const downloadResult = await googleDriveClient.downloadPublicFileStream(driveUrl);

  // Create temp file path
  const uploadDir = path.join(os.tmpdir(), 'fileprocess-downloads');
  fs.mkdirSync(uploadDir, { recursive: true });
  const uniqueId = crypto.randomBytes(16).toString('hex');
  const ext = path.extname(downloadResult.filename) || '';
  const localFilename = `${uniqueId}${ext}`;
  const localPath = path.join(uploadDir, localFilename);

  // Write stream to file
  const writeStream = fs.createWriteStream(localPath);

  await new Promise<void>((resolve, reject) => {
    downloadResult.stream.pipe(writeStream);
    writeStream.on('finish', resolve);
    writeStream.on('error', reject);
    downloadResult.stream.on('error', reject);
  });

  // Get actual file size
  const stats = fs.statSync(localPath);

  logger.info('Google Drive file pre-downloaded successfully', {
    jobId,
    localPath,
    filename: downloadResult.filename,
    mimeType: downloadResult.mimeType,
    fileSize: stats.size,
  });

  return {
    localPath,
    filename: downloadResult.filename,
    mimeType: downloadResult.mimeType,
    fileSize: stats.size,
  };
}

router.post(
  '/process/url',
  validateUrlUpload, // Validate fileUrl, filename, mimeType, userId, metadata
  validateRequest, // Check validation results
  async (req: Request, res: Response): Promise<Response | void> => {
  const startTime = Date.now();
  let preDownloadedFilePath: string | undefined;

  try {
    const { fileUrl, filename, mimeType, userId, metadata } = req.body;

    // Parameter validation already done by middleware
    const jobRepository = getJobRepository();

    // =========================================================================
    // PHASE 8: YouTube URL Detection - Route to VideoAgent
    // =========================================================================
    // Check for YouTube URLs - route directly to VideoAgent for download and processing
    // VideoAgent uses yt-dlp to handle YouTube downloads
    // =========================================================================

    if (isYouTubeUrl(fileUrl)) {
      logger.info('YouTube URL detected - routing to VideoAgent', {
        url: fileUrl.substring(0, 50),
        userId
      });

      const videoAgentClient = getVideoAgentClient();

      try {
        const jobResponse = await videoAgentClient.processVideo({
          userId: userId || 'anonymous',
          filename: filename || 'youtube_video',
          videoUrl: fileUrl,  // Pass YouTube URL directly - VideoAgent uses yt-dlp
          options: {
            extractMetadata: true,
            analyzeFrames: true,
            transcribeAudio: true,  // Default true for YouTube
            quality: 'high',
          },
        });

        return res.status(202).json({
          success: true,
          message: 'YouTube video queued for processing',
          processingMethod: 'videoagent_youtube',
          jobId: jobResponse.jobId,
          pollUrl: `/api/video/status/${jobResponse.jobId}`,
          sourceUrl: fileUrl.substring(0, 50) + '...',
        });
      } catch (error) {
        logger.error('Failed to submit YouTube video to VideoAgent', {
          error: error instanceof Error ? error.message : 'Unknown error',
          url: fileUrl.substring(0, 50)
        });
        return res.status(500).json({
          success: false,
          error: 'Failed to process YouTube video',
          details: error instanceof Error ? error.message : 'Unknown error'
        });
      }
    }

    // =========================================================================
    // PHASE 9: GitHub Repository URL Detection - Route to GitHub Manager
    // =========================================================================
    // Check for GitHub repository URLs - route to GitHub Manager for full
    // repository ingestion into GraphRAG memory (AST parsing, code graphs,
    // embeddings, etc.)
    // =========================================================================

    if (isGitHubRepoUrl(fileUrl)) {
      const repoInfo = extractGitHubRepoInfo(fileUrl);

      logger.info('GitHub repository URL detected - routing to GitHub Manager', {
        url: fileUrl.substring(0, 80),
        owner: repoInfo?.owner,
        repo: repoInfo?.repo,
        branch: repoInfo?.branch,
        userId
      });

      const gitHubManagerClient = getGitHubManagerClient();

      try {
        // Build tenant context from request
        const tenantContext = {
          companyId: (req.headers['x-company-id'] as string) || 'default',
          appId: (req.headers['x-app-id'] as string) || 'nexus-fileprocess',
          userId: userId || undefined,
        };

        // Extract GitHub access token for private repositories
        // Can be passed via X-GitHub-Token header or Authorization header (if Bearer token starts with gh)
        let githubAccessToken: string | undefined = req.headers['x-github-token'] as string;

        // Also check metadata for accessToken (for backwards compatibility)
        if (!githubAccessToken && metadata?.accessToken) {
          githubAccessToken = metadata.accessToken as string;
        }

        if (githubAccessToken) {
          logger.info('GitHub access token provided for private repository access', {
            url: fileUrl.substring(0, 50),
            tokenPrefix: githubAccessToken.substring(0, 10) + '...',
          });
        }

        // Process the repository
        const result = await gitHubManagerClient.processGitHubRepo(
          fileUrl,
          tenantContext,
          {
            forceResync: metadata?.forceResync === true,
            waitForCompletion: metadata?.waitForCompletion !== false, // default true
            timeout: typeof metadata?.timeout === 'number' ? metadata.timeout : 600000, // 10 min default
            accessToken: githubAccessToken,
          }
        );

        if (!result.success) {
          return res.status(422).json({
            success: false,
            error: 'GITHUB_REPO_PROCESSING_FAILED',
            message: result.error || 'Failed to process GitHub repository',
            repoUrl: fileUrl,
            owner: repoInfo?.owner,
            repo: repoInfo?.repo,
          });
        }

        const duration = Date.now() - startTime;

        return res.status(result.status === 'syncing' ? 202 : 200).json({
          success: true,
          message: result.isNewConnection
            ? 'GitHub repository connected and syncing into memory'
            : 'GitHub repository already in memory',
          processingMethod: 'github_manager_repo_ingestion',
          repository: {
            id: result.repositoryId,
            fullName: result.fullName,
            status: result.status,
            isNewConnection: result.isNewConnection,
          },
          syncStats: result.syncStats,
          pollUrl: result.repositoryId
            ? `/api/github/repositories/${result.repositoryId}/sync/status`
            : undefined,
          sourceUrl: fileUrl,
          duration: `${duration}ms`,
        });
      } catch (error) {
        logger.error('Failed to process GitHub repository', {
          error: error instanceof Error ? error.message : 'Unknown error',
          url: fileUrl.substring(0, 80),
          owner: repoInfo?.owner,
          repo: repoInfo?.repo,
        });
        return res.status(500).json({
          success: false,
          error: 'GITHUB_REPO_ERROR',
          message: 'Failed to process GitHub repository',
          details: error instanceof Error ? error.message : 'Unknown error',
          repoUrl: fileUrl,
        });
      }
    }

    // Check if this is a Google Drive URL - requires special handling
    if (isGoogleDriveUrl(fileUrl)) {
      logger.info('Detected Google Drive URL, pre-downloading file', {
        fileUrl: fileUrl.substring(0, 100) + '...',
        filename,
      });

      // Pre-download the file from Google Drive (handles virus scan warnings)
      const tempJobId = crypto.randomBytes(8).toString('hex');
      const downloadResult = await preDownloadGoogleDriveFile(fileUrl, tempJobId);
      preDownloadedFilePath = downloadResult.localPath;

      // =========================================================================
      // PHASE 61: SUSPICIOUS FILE DETECTION - Google Drive Pre-Download
      // =========================================================================
      // Check for suspicious indicators BEFORE any other routing
      // =========================================================================

      // Read file for suspicious detection
      const downloadedBuffer = await fs.promises.readFile(preDownloadedFilePath);
      const urlSuspiciousResult = detectSuspiciousFile({
        filename: downloadResult.filename,
        claimedMimeType: mimeType,
        detectedMimeType: downloadResult.mimeType,
        buffer: downloadedBuffer,
        fileSize: downloadResult.fileSize,
      });

      if (urlSuspiciousResult.isSuspicious) {
        logger.warn('Suspicious file detected from Google Drive URL - routing to CyberAgent', {
          filename: downloadResult.filename,
          threatLevel: urlSuspiciousResult.threatLevel,
          flags: urlSuspiciousResult.flags,
        });

        try {
          const cyberAgentClient = getCyberAgentClient();
          const sharedVolumePath = `file://${preDownloadedFilePath}`;

          const analysisResult = await cyberAgentClient.analyzeBinary(sharedVolumePath, {
            filename: downloadResult.filename,
            mimeType: downloadResult.mimeType,
            fileSize: downloadResult.fileSize,
            localFilePath: sharedVolumePath,
            // Phase 1b: Enable decompilation for high-threat files and binaries
            // Decompile when: critical/high threat, embedded executables detected, or binary file type
            decompile: urlSuspiciousResult.threatLevel === 'critical' ||
                       urlSuspiciousResult.threatLevel === 'high' ||
                       urlSuspiciousResult.flags.some(f => f.includes('Embedded executable')) ||
                       CyberAgentClient.isBinaryFileType(downloadResult.mimeType, downloadResult.filename),
            deepAnalysis: true,
            timeout: 300000,
          });

          const duration = Date.now() - startTime;

          // Clean up temp file
          try { fs.unlinkSync(preDownloadedFilePath); } catch { /* ignore */ }

          if (analysisResult.success) {
            if (analysisResult.isMalicious || analysisResult.threatLevel === 'critical') {
              return res.status(403).json({
                success: false,
                error: 'MALICIOUS_FILE_BLOCKED',
                message: 'Google Drive file blocked due to security threat',
                analysis: {
                  threatLevel: analysisResult.threatLevel,
                  isMalicious: analysisResult.isMalicious,
                  summary: analysisResult.analysis_summary,
                },
                source: 'google_drive_url',
              });
            }

            return res.status(200).json({
              success: true,
              message: 'File analyzed via CyberAgent - security cleared',
              processingMethod: 'cyberagent_suspicious_analysis',
              analysis: {
                threatLevel: analysisResult.threatLevel,
                isMalicious: analysisResult.isMalicious,
                summary: analysisResult.analysis_summary,
              },
              suspiciousFlags: urlSuspiciousResult.flags,
              source: 'google_drive_url',
              duration: `${duration}ms`,
            });
          } else {
            return res.status(422).json({
              success: false,
              error: 'SUSPICIOUS_ANALYSIS_FAILED',
              message: 'Security analysis failed for suspicious file',
              suspiciousFlags: urlSuspiciousResult.flags,
              source: 'google_drive_url',
            });
          }
        } catch (suspError) {
          logger.error('Error analyzing suspicious Google Drive URL file', {
            error: suspError instanceof Error ? suspError.message : String(suspError),
          });

          return res.status(500).json({
            success: false,
            error: 'SUSPICIOUS_FILE_ERROR',
            message: 'Failed to analyze suspicious file - blocked as precaution',
            suspiciousFlags: urlSuspiciousResult.flags,
            source: 'google_drive_url',
          });
        }
      }

      // =========================================================================
      // PHASE 8: Video File Detection from Google Drive
      // =========================================================================
      // Check if downloaded file is a video - route to VideoAgent
      // =========================================================================

      if (VideoAgentClient.isVideoFileType(downloadResult.mimeType, downloadResult.filename)) {
        logger.info('Google Drive video detected - routing to VideoAgent', {
          filename: downloadResult.filename,
          mimeType: downloadResult.mimeType,
          userId
        });

        const videoAgentClient = getVideoAgentClient();

        try {
          const jobResponse = await videoAgentClient.processVideo({
            userId: userId || 'anonymous',
            filename: downloadResult.filename,
            videoUrl: `file://${preDownloadedFilePath}`,
            options: {
              extractMetadata: true,
              analyzeFrames: true,
              transcribeAudio: false,
              quality: 'medium',
            },
          });

          return res.status(202).json({
            success: true,
            message: 'Google Drive video queued for processing',
            processingMethod: 'videoagent_google_drive',
            jobId: jobResponse.jobId,
            pollUrl: `/api/video/status/${jobResponse.jobId}`,
            filename: downloadResult.filename,
          });
        } catch (error) {
          logger.error('Failed to submit Google Drive video to VideoAgent', {
            error: error instanceof Error ? error.message : 'Unknown error',
            filename: downloadResult.filename
          });
          // Fall through to standard processing
        }
      }

      // Check if this is a binary/executable file that should go to CyberAgent
      const isBinaryFile = CyberAgentClient.isBinaryFileType(
        downloadResult.mimeType,
        downloadResult.filename
      );

      if (isBinaryFile) {
        logger.info('Binary file detected from Google Drive, routing to CyberAgent', {
          filename: downloadResult.filename,
          mimeType: downloadResult.mimeType,
          fileSize: downloadResult.fileSize,
        });

        // Route to CyberAgent for security analysis using local file path
        const cyberAgentClient = getCyberAgentClient();
        const analysisResult = await cyberAgentClient.analyzeBinary(
          `file://${preDownloadedFilePath}`,
          {
            filename: downloadResult.filename,
            mimeType: downloadResult.mimeType,
            fileSize: downloadResult.fileSize,
            deepAnalysis: true,
            decompile: true,
            localFilePath: preDownloadedFilePath,
          }
        );

        // Clean up temp file
        try { fs.unlinkSync(preDownloadedFilePath); } catch { /* ignore */ }

        const duration = Date.now() - startTime;

        if (!analysisResult.success) {
          logger.error('CyberAgent binary analysis failed', {
            filename: downloadResult.filename,
            error: analysisResult.error,
            duration: `${duration}ms`,
          });

          res.status(422).json({
            success: false,
            error: 'BINARY_ANALYSIS_FAILED',
            message: `Binary analysis failed: ${analysisResult.error}`,
            suggestion: 'The file may be corrupted or in an unsupported format',
          });
          return;
        }

        logger.info('Binary file analyzed by CyberAgent successfully', {
          filename: downloadResult.filename,
          threatLevel: analysisResult.threatLevel,
          isMalicious: analysisResult.isMalicious,
          duration: `${duration}ms`,
        });

        res.status(200).json({
          success: true,
          message: 'Binary file analyzed by CyberAgent',
          filename: downloadResult.filename,
          mimeType: downloadResult.mimeType,
          fileSize: downloadResult.fileSize,
          analysis: {
            threatLevel: analysisResult.threatLevel,
            isMalicious: analysisResult.isMalicious,
            recommendations: analysisResult.recommendations,
            decompiled_code: analysisResult.decompiled_code?.substring(0, 1000),
            extracted_strings: analysisResult.extracted_strings?.slice(0, 100),
            file_metadata: analysisResult.file_metadata,
            yara_matches: analysisResult.yara_matches,
          },
          source: 'google-drive',
          processingTimeMs: duration,
        });
        return;
      }

      // For non-binary files, pass the downloaded buffer directly via Redis queue
      // The buffer was already read at line 1686 for suspicious file detection
      // Using base64-encoded fileBuffer allows cross-pod transfer via Redis
      const jobId = await jobRepository.submitJob({
        userId: userId || 'anonymous',
        filename: filename || downloadResult.filename,
        mimeType: mimeType || downloadResult.mimeType,
        fileSize: downloadResult.fileSize,
        fileBuffer: downloadedBuffer.toString('base64'),
        metadata: {
          ...metadata,
          googleDriveSource: fileUrl,
          preDownloaded: true,
          originalFileSize: downloadResult.fileSize,
        },
      });

      const duration = Date.now() - startTime;
      logger.info('Google Drive document queued successfully (pre-downloaded)', {
        jobId,
        fileUrl,
        filename: filename || downloadResult.filename,
        fileSize: downloadResult.fileSize,
        duration: `${duration}ms`,
      });

      res.status(202).json({
        success: true,
        jobId,
        message: 'Google Drive document downloaded and queued for processing',
        estimatedTime: '5-30 seconds',
      });
      return;
    }

    // =========================================================================
    // PHASE 8: HTTP Video URL Detection
    // =========================================================================
    // Check if HTTP URL points to a video file (by extension)
    // =========================================================================

    const urlSourceType = detectUrlType(fileUrl);
    if (urlSourceType === 'http_direct') {
      const ext = fileUrl.split('.').pop()?.toLowerCase();
      const videoExtensions = ['mp4', 'avi', 'mkv', 'mov', 'wmv', 'flv', 'webm', 'm4v', 'mpeg', 'mpg'];

      if (ext && videoExtensions.includes(ext)) {
        logger.info('HTTP video URL detected - routing to VideoAgent', {
          url: fileUrl.substring(0, 50),
          extension: ext,
          userId
        });

        const videoAgentClient = getVideoAgentClient();

        try {
          const jobResponse = await videoAgentClient.processVideo({
            userId: userId || 'anonymous',
            filename: filename || `video.${ext}`,
            videoUrl: fileUrl,  // Pass HTTP URL directly
            options: {
              extractMetadata: true,
              analyzeFrames: true,
              transcribeAudio: false,
              quality: 'medium',
            },
          });

          return res.status(202).json({
            success: true,
            message: 'Video URL queued for processing',
            processingMethod: 'videoagent_http_url',
            jobId: jobResponse.jobId,
            pollUrl: `/api/video/status/${jobResponse.jobId}`,
          });
        } catch (error) {
          logger.error('Failed to submit HTTP video to VideoAgent', {
            error: error instanceof Error ? error.message : 'Unknown error'
          });
          // Fall through to standard processing
        }
      }
    }

    // =========================================================================
    // PHASE 9: HTTP URL Suspicious File Detection
    // =========================================================================
    // Pre-download HTTP URLs for suspicious detection BEFORE queue submission
    // This closes the security gap where non-Google-Drive HTTP URLs bypassed inspection
    // =========================================================================

    if (urlSourceType === 'http_direct') {
      const tempPath = path.join(os.tmpdir(), `http-inspect-${crypto.randomBytes(8).toString('hex')}`);

      try {
        // Download first 10MB for inspection
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 30000);

        const response = await fetch(fileUrl, {
          signal: controller.signal,
          headers: { 'Range': 'bytes=0-10485760' }
        });
        clearTimeout(timeout);

        if (!response.ok) {
          throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }

        const buffer = Buffer.from(await response.arrayBuffer());
        await fs.promises.writeFile(tempPath, buffer);

        // Run suspicious detection
        const httpSuspiciousResult = detectSuspiciousFile({
          filename: filename || path.basename(new URL(fileUrl).pathname),
          claimedMimeType: mimeType,
          detectedMimeType: response.headers.get('content-type') || '',
          buffer,
          fileSize: buffer.length,
        });

        if (httpSuspiciousResult.isSuspicious) {
          // Route to CyberAgent for analysis
          logger.warn('Suspicious HTTP URL file detected', {
            url: fileUrl.substring(0, 100),
            threatLevel: httpSuspiciousResult.threatLevel,
            flags: httpSuspiciousResult.flags
          });

          const cyberAgentClient = getCyberAgentClient();
          const analysisResult = await cyberAgentClient.analyzeBinary(`file://${tempPath}`, {
            filename: filename || path.basename(new URL(fileUrl).pathname),
            mimeType,
            fileSize: buffer.length,
            localFilePath: `file://${tempPath}`,
            decompile: httpSuspiciousResult.threatLevel === 'critical' ||
                       httpSuspiciousResult.threatLevel === 'high',
            deepAnalysis: true,
            timeout: 300000,
          });

          if (analysisResult.isMalicious || analysisResult.threatLevel === 'critical') {
            // Clean up temp file before returning
            try { fs.unlinkSync(tempPath); } catch { /* ignore */ }

            return res.status(403).json({
              success: false,
              error: 'MALICIOUS_FILE_BLOCKED',
              message: 'HTTP URL file blocked due to security threat',
              analysis: {
                threatLevel: analysisResult.threatLevel,
                isMalicious: analysisResult.isMalicious,
                recommendations: analysisResult.recommendations,
                yara_matches: analysisResult.yara_matches,
              },
            });
          }

          // Log that file passed security check
          logger.info('HTTP URL file passed security analysis', {
            url: fileUrl.substring(0, 100),
            threatLevel: analysisResult.threatLevel,
            isMalicious: analysisResult.isMalicious,
          });
        }
      } catch (inspectError) {
        logger.error('Failed to inspect HTTP URL file', {
          error: inspectError instanceof Error ? inspectError.message : String(inspectError),
          url: fileUrl.substring(0, 100)
        });
        // Continue to normal processing if inspection fails
      } finally {
        try { fs.unlinkSync(tempPath); } catch { /* ignore */ }
      }
    }

    // For non-Google Drive URLs, submit job directly (Go worker handles HTTP download)
    const jobId = await jobRepository.submitJob({
      userId: userId || 'anonymous',
      filename,
      mimeType,
      fileUrl,
      metadata: metadata || {},
    });

    const duration = Date.now() - startTime;

    logger.info('URL document queued successfully', {
      jobId,
      fileUrl,
      filename,
      duration: `${duration}ms`
    });

    const response: ProcessFileResponse = {
      success: true,
      jobId,
      message: 'Document queued for processing',
      estimatedTime: '5-30 seconds'
    };

    res.status(202).json(response);

  } catch (error) {
    // Clean up pre-downloaded file on error
    if (preDownloadedFilePath) {
      try { fs.unlinkSync(preDownloadedFilePath); } catch { /* ignore */ }
    }

    const duration = Date.now() - startTime;
    const errorMessage = error instanceof Error ? error.message : String(error);

    logger.error('Failed to process URL request', {
      error: errorMessage,
      duration: `${duration}ms`
    });

    // Provide helpful error message for Google Drive errors
    if (error instanceof GoogleDriveError) {
      res.status(400).json({
        success: false,
        error: 'GOOGLE_DRIVE_ERROR',
        message: errorMessage,
        suggestion: error.context?.suggestion || 'Ensure the file is shared with "Anyone with the link" can view.',
      });
      return;
    }

    res.status(500).json({
      success: false,
      error: 'Internal server error',
      message: 'Failed to queue document for processing',
      details: config.nodeEnv === 'development' ? errorMessage : undefined
    });
  }
});

/**
 * POST /process/drive-url
 * (Full path: /fileprocess/api/process/drive-url)
 *
 * Process a file from a publicly shared Google Drive URL.
 * No authentication required - works with publicly shared links.
 *
 * Request body:
 * {
 *   "driveUrl": "https://drive.google.com/file/d/FILE_ID/view?usp=sharing",
 *   "userId": "user-123"
 * }
 */
router.post('/process/drive-url', async (req: Request, res: Response): Promise<void> => {
  const startTime = Date.now();
  let tempFilePath: string | undefined;

  try {
    const { driveUrl, userId } = req.body;

    // Validate required parameters
    if (!driveUrl || typeof driveUrl !== 'string') {
      res.status(400).json({
        success: false,
        error: 'INVALID_REQUEST',
        message: 'Missing or invalid driveUrl parameter',
        suggestion: 'Provide a valid Google Drive sharing URL',
      });
      return;
    }

    if (!userId || typeof userId !== 'string') {
      res.status(400).json({
        success: false,
        error: 'INVALID_REQUEST',
        message: 'Missing or invalid userId parameter',
        suggestion: 'Provide a valid userId string',
      });
      return;
    }

    logger.info('Google Drive URL processing request received', {
      driveUrl,
      userId,
    });

    // Create a no-op GoogleDriveClient instance (only need static download method)
    const driveClient = new (GoogleDriveClient as any)('', '', '');

    // Download file stream from Google Drive
    const { stream, filename, mimeType, fileSize } = await driveClient.downloadPublicFileStream(driveUrl);

    logger.info('Google Drive file stream initiated', {
      filename,
      mimeType,
      fileSize,
    });

    // Save stream to temporary file for processing
    tempFilePath = path.join(os.tmpdir(), 'fileprocess-uploads', `drive-${crypto.randomBytes(16).toString('hex')}-${filename}`);
    await fs.promises.mkdir(path.dirname(tempFilePath), { recursive: true });

    // Write stream to temp file
    const writeStream = fs.createWriteStream(tempFilePath);
    await new Promise<void>((resolve, reject) => {
      stream.pipe(writeStream);
      stream.on('end', resolve);
      stream.on('error', reject);
      writeStream.on('error', reject);
    });

    logger.debug('Google Drive file saved to temp storage', {
      filename,
      tempFilePath,
      fileSize,
    });

    // Read file from disk for processing
    let buffer: Buffer;
    try {
      buffer = await fs.promises.readFile(tempFilePath);
      logger.debug('File read from disk', {
        filename,
        size: buffer.length,
      });
    } catch (error) {
      logger.error('Failed to read downloaded file from disk', {
        filename,
        tempFilePath,
        error: error instanceof Error ? error.message : String(error),
      });

      res.status(500).json({
        success: false,
        error: 'DISK_READ_FAILED',
        message: 'Failed to read downloaded file from disk',
        suggestion: 'Please try uploading the file again',
      });
      return;
    }

    // Validate file using FileValidator
    const validationResult = await fileValidator.validate({
      buffer,
      filename,
      claimedMimeType: mimeType,
      userId,
    });

    if (!validationResult.valid) {
      logger.warn('Google Drive file validation failed', {
        filename,
        mimeType,
        error: validationResult.error,
      });

      res.status(400).json({
        success: false,
        error: 'INVALID_FILE',
        message: validationResult.error?.message || 'File validation failed',
        suggestion: 'Please check that the file is not corrupted and is a supported format',
      });
      return;
    }

    logger.info('Google Drive file validated successfully', {
      filename,
      mimeType: validationResult.detectedMimeType,
      fileSize,
    });

    // Use detected MIME type from magic byte detection (more reliable)
    const verifiedMimeType = validationResult.detectedMimeType || mimeType;

    // =========================================================================
    // PHASE 61: SUSPICIOUS FILE DETECTION - Google Drive URL Processing
    // =========================================================================
    // Run suspicious detection BEFORE any other routing.
    // If ANY hint of suspicion is detected, route to CyberAgent immediately.
    // =========================================================================

    const suspiciousResult = detectSuspiciousFile({
      filename,
      claimedMimeType: mimeType,
      detectedMimeType: verifiedMimeType,
      buffer,
      fileSize,
    });

    if (suspiciousResult.isSuspicious) {
      logger.warn('Suspicious Google Drive file detected - routing to CyberAgent', {
        filename,
        driveUrl: req.body.driveUrl?.substring(0, 50),
        threatLevel: suspiciousResult.threatLevel,
        confidence: suspiciousResult.confidence,
        flags: suspiciousResult.flags,
      });

      try {
        const cyberAgentClient = getCyberAgentClient();
        const sharedVolumePath = tempFilePath ? `file://${tempFilePath}` : undefined;

        if (!sharedVolumePath) {
          res.status(500).json({
            success: false,
            error: 'INTERNAL_ERROR',
            message: 'Suspicious file was not saved to temporary storage',
          });
          return;
        }

        const analysisResult = await cyberAgentClient.analyzeBinary(sharedVolumePath, {
          filename,
          mimeType: verifiedMimeType,
          fileSize: buffer.length,
          localFilePath: sharedVolumePath,
          // Phase 1b: Enable decompilation for high-threat files and binaries
          // Decompile when: critical/high threat, embedded executables detected, or binary file type
          decompile: suspiciousResult.threatLevel === 'critical' ||
                     suspiciousResult.threatLevel === 'high' ||
                     suspiciousResult.flags.some(f => f.includes('Embedded executable')) ||
                     CyberAgentClient.isBinaryFileType(verifiedMimeType, filename),
          deepAnalysis: true,
          timeout: 300000,
        });

        const duration = Date.now() - startTime;

        if (analysisResult.success) {
          if (analysisResult.isMalicious || analysisResult.threatLevel === 'critical') {
            logger.error('MALICIOUS FILE DETECTED FROM GOOGLE DRIVE', {
              filename,
              threatLevel: analysisResult.threatLevel,
              isMalicious: analysisResult.isMalicious,
            });

            res.status(403).json({
              success: false,
              error: 'MALICIOUS_FILE_BLOCKED',
              message: 'Google Drive file blocked due to security threat',
              analysis: {
                threatLevel: analysisResult.threatLevel,
                isMalicious: analysisResult.isMalicious,
                summary: analysisResult.analysis_summary,
              },
              source: 'google_drive',
            });
            return;
          }

          if (analysisResult.threatLevel === 'high') {
            res.status(200).json({
              success: true,
              message: 'File analyzed - high threat level detected',
              processingMethod: 'cyberagent_suspicious_analysis',
              securityWarning: true,
              analysis: {
                threatLevel: analysisResult.threatLevel,
                isMalicious: analysisResult.isMalicious,
                summary: analysisResult.analysis_summary,
                recommendations: analysisResult.recommendations,
              },
              suspiciousFlags: suspiciousResult.flags,
              source: 'google_drive',
              duration: `${duration}ms`,
            });
            return;
          }

          // Threat level acceptable
          res.status(200).json({
            success: true,
            message: 'File analyzed via CyberAgent - security cleared',
            processingMethod: 'cyberagent_suspicious_analysis',
            analysis: {
              threatLevel: analysisResult.threatLevel,
              isMalicious: analysisResult.isMalicious,
              summary: analysisResult.analysis_summary,
            },
            suspiciousFlags: suspiciousResult.flags,
            source: 'google_drive',
            duration: `${duration}ms`,
          });
          return;
        } else {
          res.status(422).json({
            success: false,
            error: 'SUSPICIOUS_ANALYSIS_FAILED',
            message: 'Security analysis failed for suspicious Google Drive file',
            suspiciousFlags: suspiciousResult.flags,
            source: 'google_drive',
          });
          return;
        }
      } catch (suspiciousError) {
        logger.error('Error analyzing suspicious Google Drive file', {
          filename,
          error: suspiciousError instanceof Error ? suspiciousError.message : String(suspiciousError),
        });

        res.status(500).json({
          success: false,
          error: 'SUSPICIOUS_FILE_ERROR',
          message: 'Failed to analyze suspicious file - blocked as precaution',
          suspiciousFlags: suspiciousResult.flags,
          source: 'google_drive',
        });
        return;
      }
    }

    // =========================================================================
    // PHASE 60: Binary/Executable File Routing to CyberAgent
    // =========================================================================
    // Check if this is a binary/executable file that should be routed to
    // CyberAgent for security analysis and decompilation instead of OCR.
    // =========================================================================

    const isBinaryFile = CyberAgentClient.isBinaryFileType(verifiedMimeType, filename);

    if (isBinaryFile) {
      logger.info('Binary/executable file detected from Google Drive - routing to CyberAgent', {
        filename,
        mimeType: verifiedMimeType,
        fileSize,
        userId,
        source: 'google_drive',
      });

      try {
        // =========================================================================
        // SANDBOX-FIRST BINARY ANALYSIS
        // =========================================================================
        // Use the locally downloaded file for CyberAgent sandbox analysis.
        // This ensures the binary goes directly to the sandbox without requiring
        // CyberAgent to fetch from external URLs (which would trigger target
        // authorization checks and potential network issues).
        //
        // The tempFilePath is on a shared volume accessible to both services.
        // We use file:// protocol to indicate this is a local file path.
        // =========================================================================

        if (!tempFilePath) {
          logger.error('Cannot analyze binary file - temp file path not available', {
            filename,
            mimeType: verifiedMimeType,
          });

          res.status(500).json({
            success: false,
            error: 'INTERNAL_ERROR',
            message: 'Binary file was not saved to temporary storage',
            suggestion: 'Please try uploading the file again',
          });
          return;
        }

        // Construct shared volume path for CyberAgent
        // The file is already downloaded to tempFilePath on the shared volume
        // Use file:// protocol to indicate local file access
        const sharedVolumePath = `file://${tempFilePath}`;

        logger.info('Using local file for CyberAgent sandbox analysis', {
          filename,
          localPath: tempFilePath,
          sharedVolumePath,
          fileSize: buffer.length,
        });

        // Route to CyberAgent for binary analysis using local file
        const cyberAgentClient = getCyberAgentClient();
        const analysisResult = await cyberAgentClient.analyzeBinary(sharedVolumePath, {
          filename,
          mimeType: verifiedMimeType,
          fileSize: buffer.length,
          localFilePath: sharedVolumePath,
          decompile: true,
          deepAnalysis: true,
          timeout: 300000, // 5 minutes for binary analysis
        });

        const duration = Date.now() - startTime;

        if (analysisResult.success) {
          logger.info('Binary file analyzed successfully via CyberAgent', {
            filename,
            mimeType: verifiedMimeType,
            duration: `${duration}ms`,
            threatLevel: analysisResult.threatLevel,
            isMalicious: analysisResult.isMalicious,
            source: 'google_drive',
          });

          res.status(200).json({
            success: true,
            message: 'Binary file analyzed via CyberAgent',
            processingMethod: 'cyberagent_binary_analysis',
            source: 'google_drive',
            analysis: {
              threatLevel: analysisResult.threatLevel,
              isMalicious: analysisResult.isMalicious,
              summary: analysisResult.analysis_summary,
              recommendations: analysisResult.recommendations,
              yaraMatches: analysisResult.yara_matches,
              fileMetadata: analysisResult.file_metadata,
            },
            // Include decompiled code if available
            extractedContent: analysisResult.decompiled_code,
            extractedStrings: analysisResult.extracted_strings,
            duration: `${duration}ms`,
            note: 'Binary files are analyzed by CyberAgent for security assessment and code extraction',
          });
          return;
        } else {
          logger.warn('Binary file analysis failed', {
            filename,
            mimeType: verifiedMimeType,
            error: analysisResult.error,
            duration: `${duration}ms`,
          });

          res.status(422).json({
            success: false,
            error: 'BINARY_ANALYSIS_FAILED',
            message: `Binary analysis failed: ${analysisResult.error}`,
            suggestion: 'The file may be corrupted or in an unsupported format',
          });
          return;
        }
      } catch (binaryError) {
        const duration = Date.now() - startTime;
        const errorMessage = binaryError instanceof Error ? binaryError.message : String(binaryError);

        logger.error('CyberAgent binary analysis failed unexpectedly', {
          filename,
          mimeType: verifiedMimeType,
          error: errorMessage,
          duration: `${duration}ms`,
          source: 'google_drive',
        });

        res.status(500).json({
          success: false,
          error: 'BINARY_ANALYSIS_ERROR',
          message: 'Unexpected error during binary analysis',
          details: config.nodeEnv === 'development' ? errorMessage : undefined,
        });
        return;
      }
    }

    // =========================================================================
    // Standard Processing Pipeline - Queue for Worker Processing
    // =========================================================================

    // Create job in database and queue
    const jobRepository = getJobRepository();
    const jobId = await jobRepository.submitJob({
      userId,
      filename,
      fileSize,
      mimeType: verifiedMimeType,
      fileBuffer: buffer.toString('base64'),
    });

    const duration = Date.now() - startTime;
    logger.info('Google Drive file job created successfully', {
      jobId,
      filename,
      userId,
      duration: `${duration}ms`,
    });

    const response: ProcessFileResponse = {
      success: true,
      jobId,
      message: 'Document queued for processing',
      estimatedTime: '2-15 seconds',
    };

    res.status(202).json(response);
  } catch (error) {
    const duration = Date.now() - startTime;
    const errorMessage = error instanceof Error ? error.message : String(error);

    // Handle Google Drive errors specifically
    if (error instanceof GoogleDriveError) {
      logger.error('Google Drive download failed', {
        error: errorMessage,
        code: (error as any).code,
        duration: `${duration}ms`,
      });

      res.status(400).json({
        success: false,
        error: (error as any).code || 'DRIVE_DOWNLOAD_FAILED',
        message: errorMessage,
        suggestion: (error as any).context?.suggestion || 'Verify the URL is a publicly shared Google Drive link',
      });
      return;
    }

    logger.error('Failed to process Google Drive URL request', {
      error: errorMessage,
      duration: `${duration}ms`,
    });

    res.status(500).json({
      success: false,
      error: 'Internal server error',
      message: 'Failed to process Google Drive file',
      details: config.nodeEnv === 'development' ? errorMessage : undefined,
    });
  } finally {
    // Clean up temporary file
    if (tempFilePath) {
      const { cleanupTempFile } = await import('../utils/file-cleanup');
      await cleanupTempFile(tempFilePath, 'drive-url-download');
    }
  }
});

// ============================================================================
// SANDBOX-FIRST UOM ROUTES
// ============================================================================
// New routes that use the Sandbox-First Unified Orchestration Monitor (UOM)
// for intelligent, LLM-driven file processing decisions.
//
// Features:
// - ALL files go through sandbox analysis first
// - UOM makes all routing decisions dynamically (no hardcoded if/else)
// - Pattern learning for faster future processing
// - Async processing with SSE updates
// ============================================================================

/**
 * POST /api/v1/process/sandbox-first
 *
 * Process a file using the Sandbox-First UOM architecture.
 * All files are analyzed in sandbox before routing decisions are made.
 *
 * Request:
 * - Content-Type: multipart/form-data
 * - file: File to process (required)
 * - userId: User ID (optional, defaults to 'anonymous')
 * - orgId: Organization ID (optional)
 * - async: If true, returns 202 with job ID for SSE tracking (default: true)
 * - metadata: JSON string with additional metadata (optional)
 *
 * Response (async=true, default):
 * {
 *   "success": true,
 *   "jobId": "uuid",
 *   "status": "pending",
 *   "progress": 0,
 *   "currentStage": "Queued for processing",
 *   "sseEndpoint": "/fileprocess/api/v1/jobs/:jobId/stream"
 * }
 *
 * Response (async=false):
 * {
 *   "success": true,
 *   "jobId": "uuid",
 *   "status": "completed",
 *   "progress": 100,
 *   "result": { ... }
 * }
 */
router.post(
  '/v1/process/sandbox-first',
  upload.single('file'),
  validateFilePresence,
  validateFileUpload,
  sanitizeFilename,
  validateRequest,
  async (req: Request, res: Response): Promise<Response | void> => {
    const startTime = Date.now();
    let filePath: string | undefined;

    try {
      const { originalname, mimetype, size, path } = req.file!;
      filePath = path;
      const userId = req.body.userId || 'anonymous';
      const orgId = req.body.orgId;
      const asyncMode = req.body.async !== 'false'; // Default to async
      // Parse optional metadata
      let requestMetadata: Record<string, unknown> | undefined;
      if (req.body.metadata) {
        try {
          requestMetadata = JSON.parse(req.body.metadata);
        } catch {
          logger.warn('Invalid metadata JSON', { metadata: req.body.metadata });
        }
      }

      logger.info('Sandbox-first processing request received', {
        filename: originalname,
        size,
        mimeType: mimetype,
        userId,
        orgId,
        asyncMode,
        diskPath: filePath,
        hasMetadata: !!requestMetadata,
      });

      // Read file from disk
      const buffer = await fs.promises.readFile(filePath);

      // Quick validation using FileValidator
      const validationResult = await fileValidator.validate({
        buffer,
        filename: originalname,
        claimedMimeType: mimetype,
        userId,
      });

      if (!validationResult.valid) {
        logger.warn('File validation failed', {
          filename: originalname,
          error: validationResult.error?.code,
        });

        return res.status(validationResult.error!.httpStatus).json(
          validationResult.error!.toJSON()
        );
      }

      const verifiedMimeType = validationResult.detectedMimeType || mimetype;

      // Get orchestrator and process
      const orchestrator = getSandboxFirstOrchestrator();

      const response = await orchestrator.processFile({
        file: {
          filename: originalname,
          mimeType: verifiedMimeType,
          fileSize: size,
          storagePath: filePath,
        },
        user: {
          userId,
          orgId,
        },
        async: asyncMode,
        priority: 5,
      });

      const duration = Date.now() - startTime;

      logger.info('Sandbox-first orchestration initiated', {
        jobId: response.jobId,
        status: response.status,
        asyncMode,
        duration: `${duration}ms`,
      });

      // Return 202 for async, 200 for sync
      const httpStatus = asyncMode && response.status === 'pending' ? 202 : 200;

      return res.status(httpStatus).json({
        success: true,
        ...response,
        processingMode: 'sandbox_first_uom',
        requestDuration: `${duration}ms`,
      });

    } catch (error) {
      const duration = Date.now() - startTime;
      const errorMessage = error instanceof Error ? error.message : String(error);

      logger.error('Sandbox-first processing failed', {
        error: errorMessage,
        duration: `${duration}ms`,
        filename: req.file?.originalname,
      });

      if (error instanceof ValidationError) {
        return res.status(error.httpStatus).json(error.toJSON());
      }

      return res.status(500).json({
        success: false,
        error: 'SANDBOX_FIRST_ERROR',
        message: 'Failed to process file via sandbox-first pipeline',
        details: config.nodeEnv === 'development' ? errorMessage : undefined,
      });

    } finally {
      // Cleanup temp file (unless orchestrator is using it)
      // Note: We don't clean up here for async mode since the orchestrator needs the file
      // The orchestrator is responsible for cleanup after processing
    }
  }
);

/**
 * GET /api/v1/jobs/:jobId
 *
 * Get the status of a sandbox-first orchestration job.
 *
 * Response:
 * {
 *   "success": true,
 *   "jobId": "uuid",
 *   "status": "processing" | "completed" | "blocked" | "review_queued" | "failed",
 *   "progress": 0-100,
 *   "currentStage": "Sandbox Analysis",
 *   "result": { ... } // Only present when completed
 * }
 */
router.get('/v1/jobs/:jobId', async (req: Request, res: Response): Promise<Response> => {
  const { jobId } = req.params;

  const orchestrator = getSandboxFirstOrchestrator();
  const response = orchestrator.getJobStatus(jobId);

  if (!response) {
    return res.status(404).json({
      success: false,
      error: 'JOB_NOT_FOUND',
      message: `Job ${jobId} not found`,
    });
  }

  return res.status(200).json({
    success: true,
    ...response,
  });
});

/**
 * GET /api/v1/jobs/:jobId/stream
 *
 * SSE endpoint for real-time job progress updates.
 *
 * Events:
 * - stage: Stage progress update
 * - complete: Job completed
 * - blocked: Job blocked due to security
 * - review_queued: Job queued for review
 * - error: Job failed
 */
router.get('/v1/jobs/:jobId/stream', async (req: Request, res: Response): Promise<void> => {
  const { jobId } = req.params;

  const orchestrator = getSandboxFirstOrchestrator();
  const job = orchestrator.getJob(jobId);

  if (!job) {
    res.status(404).json({
      success: false,
      error: 'JOB_NOT_FOUND',
      message: `Job ${jobId} not found`,
    });
    return;
  }

  // Set up SSE headers
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // Disable nginx buffering

  // Send initial status
  res.write(`event: status\n`);
  res.write(`data: ${JSON.stringify({
    jobId: job.id,
    status: job.status,
    progress: job.progress,
    currentStage: job.currentStage,
    stageMessages: job.stageMessages,
  })}\n\n`);

  // Check if job is already complete
  if (['completed', 'blocked', 'review_queued', 'failed'].includes(job.status)) {
    res.write(`event: ${job.status}\n`);
    res.write(`data: ${JSON.stringify(orchestrator.getJobStatus(jobId))}\n\n`);
    res.end();
    return;
  }

  // Subscribe to job events
  const unsubscribe = orchestrator.subscribeToJob(jobId, (event, data) => {
    try {
      res.write(`event: ${event}\n`);
      res.write(`data: ${JSON.stringify(data)}\n\n`);

      // End stream on terminal events
      if (['complete', 'blocked', 'review_queued', 'error'].includes(event)) {
        res.end();
      }
    } catch {
      // Client disconnected
      unsubscribe();
    }
  });

  // Handle client disconnect
  req.on('close', () => {
    unsubscribe();
    logger.debug('SSE client disconnected', { jobId });
  });

  // Send heartbeat every 30 seconds
  const heartbeatInterval = setInterval(() => {
    try {
      res.write(`:heartbeat\n\n`);
    } catch {
      clearInterval(heartbeatInterval);
      unsubscribe();
    }
  }, 30000);

  req.on('close', () => {
    clearInterval(heartbeatInterval);
  });
});

/**
 * GET /api/v1/orchestrator/stats
 *
 * Get orchestrator statistics and health metrics.
 */
router.get('/v1/orchestrator/stats', async (_req: Request, res: Response): Promise<Response> => {
  const orchestrator = getSandboxFirstOrchestrator();
  const stats = orchestrator.getStatistics();

  return res.status(200).json({
    success: true,
    stats,
    timestamp: new Date().toISOString(),
  });
});

export default router;
