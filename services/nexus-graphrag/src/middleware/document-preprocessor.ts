/**
 * Document Preprocessor Middleware
 *
 * Intelligent preprocessing for document ingestion that detects problematic
 * documents and provides helpful guidance without breaking backward compatibility.
 *
 * Features:
 * - Size limit enforcement with helpful suggestions
 * - Format detection (markdown, dense text, structured)
 * - Chunking strategy hints for storage engine
 * - Non-breaking warnings and guidance
 *
 * Created: 2025-10-13
 */

import { Request, Response, NextFunction } from 'express';
import { logger } from '../utils/logger.js';

/**
 * Size limits for document ingestion
 */
const SIZE_LIMITS = {
  SMALL: 5000,      // < 5KB - Fast path, direct chunking
  MEDIUM: 10000,    // 5-10KB - Normal processing
  LARGE: 50000,     // 10-50KB - Warning, suggest alternatives
  MAX: 100000       // > 100KB - Hard limit, reject
};

/**
 * Document preprocessing middleware
 *
 * Analyzes incoming documents and:
 * 1. Enforces size limits
 * 2. Detects format and density
 * 3. Adds chunking hints for storage engine
 * 4. Provides helpful error messages
 */
export async function preprocessDocument(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void | Response> {
  try {
    const { content, title, metadata = {} } = req.body;

    // Basic validation
    if (!content) {
      return res.status(400).json({
        error: {
          message: 'Content is required',
          code: 'MISSING_CONTENT'
        }
      });
    }

    // Calculate size
    const size = Buffer.byteLength(content, 'utf8');

    // Hard limit check
    if (size > SIZE_LIMITS.MAX) {
      logger.warn('Document rejected: exceeds maximum size', {
        size,
        maxSize: SIZE_LIMITS.MAX,
        title
      });

      return res.status(413).json({
        error: {
          message: 'Document too large for ingestion',
          code: 'PAYLOAD_TOO_LARGE',
          size,
          maxSize: SIZE_LIMITS.MAX,
          suggestion: 'Split document into smaller sections or use nexus_store_document MCP tool with file-based ingestion',
          alternatives: [
            'Break content at chapter/section boundaries',
            'Use POST /api/documents/ingest-url for file uploads',
            'Use nexus_store_document MCP tool for PDF/DOCX processing',
            'Store as multiple related documents with linking metadata'
          ]
        }
      });
    }

    // Format detection
    const analysis = analyzeContent(content, size);

    // Large document warning
    if (size > SIZE_LIMITS.LARGE) {
      logger.warn('Large document detected', {
        size,
        analysis,
        title
      });

      // Add warning to response (non-blocking)
      req.body._preprocessingWarnings = [{
        type: 'LARGE_DOCUMENT',
        message: `Document size (${size} bytes) is large. Consider using nexus_store_document MCP tool for better preprocessing.`,
        recommendation: 'For documents > 50KB, nexus_store_document provides automatic format detection, better chunking, and metadata extraction.'
      }];
    }

    // Dense content detection
    if (analysis.isDense && size > SIZE_LIMITS.MEDIUM) {
      logger.info('Dense document detected, adjusting chunking strategy', {
        size,
        avgLineLength: analysis.avgLineLength,
        title
      });

      // Add chunking hints for storage engine
      req.body.metadata = {
        ...metadata,
        _chunkingHints: {
          strategy: 'aggressive',
          minChunkSize: 500,  // Smaller chunks for dense content
          densityWarning: true,
          avgLineLength: analysis.avgLineLength
        }
      };

      // Add warning
      if (!req.body._preprocessingWarnings) {
        req.body._preprocessingWarnings = [];
      }
      req.body._preprocessingWarnings.push({
        type: 'DENSE_CONTENT',
        message: 'Dense content detected. Document will be chunked more aggressively.',
        recommendation: 'For optimal results with complex documents, use nexus_store_document MCP tool.'
      });
    }

    // Markdown detection
    if (analysis.isMarkdown) {
      logger.debug('Markdown document detected', { title });

      req.body.metadata = {
        ...req.body.metadata,
        type: metadata.type || 'markdown',  // Don't override if already set
        _chunkingHints: {
          ...req.body.metadata?._chunkingHints,
          preserveHeaders: true,
          splitOnHeaders: true
        }
      };
    }

    // Small document optimization
    if (size < SIZE_LIMITS.SMALL) {
      logger.debug('Small document detected, will store as single chunk', {
        size,
        title
      });

      req.body.metadata = {
        ...req.body.metadata,
        _chunkingHints: {
          ...req.body.metadata?._chunkingHints,
          singleChunk: true
        }
      };
    }

    // Add analysis metadata for debugging
    req.body._analysis = analysis;

    // Continue to next middleware/handler
    next();

  } catch (error) {
    logger.error('Document preprocessing failed', {
      error: (error as Error).message,
      stack: (error as Error).stack
    });

    return res.status(500).json({
      error: {
        message: 'Document preprocessing failed',
        code: 'PREPROCESSING_ERROR',
        details: (error as Error).message
      }
    });
  }
}

/**
 * Analyze document content to detect format and characteristics
 */
function analyzeContent(content: string, size: number): {
  isMarkdown: boolean;
  isDense: boolean;
  avgLineLength: number;
  lineCount: number;
  hasCodeBlocks: boolean;
  hasHeaders: boolean;
} {
  const lines = content.split('\n');
  const lineCount = lines.length;
  const avgLineLength = size / (lineCount || 1);

  // Markdown detection
  const hasHeaders = /^#{1,6}\s+/m.test(content);
  const hasCodeBlocks = /```[\s\S]*?```/.test(content);
  const hasBoldItalic = /\*\*[\s\S]+?\*\*|\*[\s\S]+?\*/.test(content);
  const hasLinks = /\[.+?\]\(.+?\)/.test(content);
  const isMarkdown = hasHeaders || (hasCodeBlocks && hasLinks) || (hasBoldItalic && hasHeaders);

  // Dense content detection (long lines, few breaks)
  const isDense = avgLineLength > 200;

  return {
    isMarkdown,
    isDense,
    avgLineLength,
    lineCount,
    hasCodeBlocks,
    hasHeaders
  };
}

/**
 * Export for use in other modules
 */
export default preprocessDocument;
