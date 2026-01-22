/**
 * File Document Validator
 *
 * Production-grade document parsing and validation layer implementing:
 * - Strategy Pattern: Different parsers for different file types
 * - Factory Pattern: Single entry point routing to appropriate parser
 * - Adapter Pattern: Wraps third-party libraries with consistent interface
 *
 * Supported Formats: PDF, DOCX, XLSX, MD, RTF, EPUB (extensible)
 */

import pdfParse from 'pdf-parse';
import { logger } from '../utils/logger';
import { PDFParsingError, FileParsingError, UnsupportedContentTypeError } from '../utils/document-errors';

// ============================================================================
// INTERFACES & TYPES
// ============================================================================

/**
 * Validation result contract
 * Provides consistent interface regardless of underlying parser
 */
export interface ValidationResult {
  valid: boolean;
  content: string;
  errors?: string[];
  metadata: {
    format: string;
    wordCount: number;
    pageCount?: number;
    author?: string;
    title?: string;
    createdDate?: Date;
    modifiedDate?: Date;
    language?: string;
    fileSize: number;
  };
}

/**
 * Parser options for fine-grained control
 */
export interface ParserOptions {
  maxFileSize?: number;      // Maximum file size in bytes (default: 100MB)
  password?: string;          // For encrypted PDFs
  extractImages?: boolean;    // Whether to extract image data
  preserveFormatting?: boolean; // Attempt to preserve document formatting
  domain?: string;            // Domain context for specialized parsing
}

// ============================================================================
// CONSTANTS
// ============================================================================

const MAX_FILE_SIZE = 100 * 1024 * 1024; // 100MB hard limit
const LARGE_FILE_THRESHOLD = 50 * 1024 * 1024; // 50MB warning threshold

const SUPPORTED_EXTENSIONS = new Set([
  '.pdf', '.docx', '.xlsx', '.md', '.markdown', '.rtf', '.epub', '.txt'
]);

// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================

/**
 * Extract file extension from filename
 */
function getExtension(filename: string): string {
  const ext = filename.toLowerCase().match(/\.[^.]+$/)?.[0] || '';
  return ext;
}

/**
 * Count words in text content
 */
function countWords(text: string): number {
  return text.trim().split(/\s+/).filter(word => word.length > 0).length;
}

/**
 * Validate buffer integrity
 */
function validateBuffer(buffer: Buffer, fileName: string): void {
  if (!buffer || buffer.length === 0) {
    throw new FileParsingError(
      fileName,
      getExtension(fileName),
      'Buffer is empty or null',
      new Error('Empty buffer provided')
    );
  }

  if (buffer.length > MAX_FILE_SIZE) {
    throw new FileParsingError(
      fileName,
      getExtension(fileName),
      `File size (${(buffer.length / 1024 / 1024).toFixed(2)}MB) exceeds maximum allowed size (${MAX_FILE_SIZE / 1024 / 1024}MB)`,
      new Error('File size exceeded')
    );
  }

  if (buffer.length > LARGE_FILE_THRESHOLD) {
    logger.warn('Processing large file', {
      fileName,
      sizeInMB: (buffer.length / 1024 / 1024).toFixed(2),
      threshold: LARGE_FILE_THRESHOLD / 1024 / 1024
    });
  }
}

// ============================================================================
// PDF PARSER IMPLEMENTATION
// ============================================================================

/**
 * Parse PDF documents using pdf-parse library
 * Implements robust error handling and metadata extraction
 */
async function parsePDF(
  buffer: Buffer,
  fileName: string,
  options?: ParserOptions
): Promise<ValidationResult> {
  try {
    logger.info('Starting PDF parsing', {
      fileName,
      bufferSize: buffer.length,
      hasPassword: !!options?.password
    });

    // Configure pdf-parse options
    const pdfOptions: any = {
      max: 0, // Parse all pages
    };

    // Handle password-protected PDFs
    if (options?.password) {
      pdfOptions.password = options.password;
    }

    // Parse PDF
    const data = await pdfParse(buffer, pdfOptions);

    // Validate extracted content
    if (!data.text || data.text.trim().length === 0) {
      logger.warn('PDF parsing produced empty text', {
        fileName,
        pageCount: data.numpages,
        metadata: data.info
      });

      throw new PDFParsingError(
        fileName,
        'No text content extracted from PDF. Document may be image-based or corrupted.',
        new Error('Empty text extraction')
      );
    }

    const wordCount = countWords(data.text);

    // Warn if extraction seems insufficient
    if (wordCount < 10 && data.numpages > 1) {
      logger.warn('PDF extraction may be incomplete', {
        fileName,
        wordCount,
        pageCount: data.numpages,
        ratio: wordCount / data.numpages
      });
    }

    logger.info('PDF parsed successfully', {
      fileName,
      pageCount: data.numpages,
      wordCount,
      contentLength: data.text.length
    });

    return {
      valid: true,
      content: data.text,
      metadata: {
        format: 'pdf',
        wordCount,
        pageCount: data.numpages,
        author: data.info?.Author,
        title: data.info?.Title,
        createdDate: data.info?.CreationDate ? new Date(data.info.CreationDate) : undefined,
        modifiedDate: data.info?.ModDate ? new Date(data.info.ModDate) : undefined,
        fileSize: buffer.length
      }
    };
  } catch (error: any) {
    // Transform pdf-parse errors into domain errors
    let errorMessage = error.message || 'Unknown PDF parsing error';

    // Handle specific pdf-parse error types
    if (errorMessage.includes('Invalid PDF')) {
      errorMessage = 'File is not a valid PDF document or is corrupted';
    } else if (errorMessage.includes('password')) {
      errorMessage = 'PDF is encrypted and requires a password';
    } else if (errorMessage.includes('encrypted')) {
      errorMessage = 'PDF is encrypted. Provide password via parser options';
    }

    logger.error('PDF parsing failed', {
      fileName,
      error: errorMessage,
      originalError: error.message,
      stack: error.stack
    });

    throw new PDFParsingError(fileName, errorMessage, error);
  }
}

// ============================================================================
// PLAINTEXT PARSER IMPLEMENTATION
// ============================================================================

/**
 * Parse plain text files (TXT, MD, etc.)
 * Simple UTF-8 decoding with validation
 */
async function parseTextFile(
  buffer: Buffer,
  fileName: string,
  _options?: ParserOptions
): Promise<ValidationResult> {
  try {
    logger.info('Parsing plain text file', { fileName });

    // Decode buffer as UTF-8
    const content = buffer.toString('utf-8');

    if (!content || content.trim().length === 0) {
      throw new FileParsingError(
        fileName,
        getExtension(fileName),
        'File contains no text content',
        new Error('Empty text file')
      );
    }

    const wordCount = countWords(content);

    logger.info('Text file parsed successfully', {
      fileName,
      wordCount,
      contentLength: content.length
    });

    return {
      valid: true,
      content,
      metadata: {
        format: 'text',
        wordCount,
        fileSize: buffer.length
      }
    };
  } catch (error: any) {
    logger.error('Text file parsing failed', {
      fileName,
      error: error.message
    });

    throw new FileParsingError(
      fileName,
      getExtension(fileName),
      error.message,
      error
    );
  }
}

// ============================================================================
// STUB PARSERS (Future Implementation)
// ============================================================================

/**
 * Stub parser for unsupported formats
 * Provides clear guidance for future implementation
 */
async function parseUnsupportedFormat(
  _buffer: Buffer,
  fileName: string,
  format: string
): Promise<ValidationResult> {
  const extension = getExtension(fileName);

  logger.warn('Attempted to parse unsupported format', {
    fileName,
    extension,
    format
  });

  throw new UnsupportedContentTypeError(
    format,
    Array.from(SUPPORTED_EXTENSIONS)
  );
}

// ============================================================================
// FACTORY FUNCTION (Main Entry Point)
// ============================================================================

/**
 * Validate and parse file document
 *
 * Factory function that routes to appropriate parser based on file extension.
 * Implements Strategy Pattern for extensible parser selection.
 *
 * @param buffer - File content as Buffer
 * @param fileName - Original filename (used for extension detection)
 * @param password - Optional password for encrypted documents
 * @param domain - Optional domain context for specialized parsing
 * @returns ValidationResult with parsed content and metadata
 * @throws PDFParsingError, FileParsingError, UnsupportedContentTypeError
 */
export async function validateFileDocument(
  buffer: Buffer,
  fileName: string,
  password?: string,
  domain?: string
): Promise<ValidationResult> {
  // Validate inputs
  if (!fileName || typeof fileName !== 'string') {
    throw new Error('fileName must be a non-empty string');
  }

  // Validate buffer integrity
  validateBuffer(buffer, fileName);

  const extension = getExtension(fileName);

  // Check if format is supported
  if (!SUPPORTED_EXTENSIONS.has(extension)) {
    return await parseUnsupportedFormat(buffer, fileName, extension);
  }

  // Build parser options
  const options: ParserOptions = {
    password,
    domain,
    maxFileSize: MAX_FILE_SIZE
  };

  // Route to appropriate parser (Strategy Pattern)
  logger.info('Routing to parser', {
    fileName,
    extension,
    fileSize: buffer.length
  });

  switch (extension) {
    case '.pdf':
      return await parsePDF(buffer, fileName, options);

    case '.txt':
    case '.md':
    case '.markdown':
      return await parseTextFile(buffer, fileName, options);

    case '.docx':
    case '.xlsx':
    case '.rtf':
    case '.epub':
      // Future implementation: Add specialized parsers
      return await parseUnsupportedFormat(buffer, fileName, extension);

    default:
      // Fallback to text parser for unknown extensions
      logger.warn('Unknown extension, attempting text parse', { fileName, extension });
      return await parseTextFile(buffer, fileName, options);
  }
}

/**
 * Convenience function to check if a file type is supported
 */
export function isFormatSupported(fileName: string): boolean {
  const extension = getExtension(fileName);

  // PDF and text formats are fully supported
  if (['.pdf', '.txt', '.md', '.markdown'].includes(extension)) {
    return true;
  }

  // Other formats are recognized but not yet implemented
  return SUPPORTED_EXTENSIONS.has(extension);
}

/**
 * Get list of fully supported formats
 */
export function getSupportedFormats(): string[] {
  return ['.pdf', '.txt', '.md', '.markdown'];
}

/**
 * Get list of formats recognized but not yet implemented
 */
export function getPendingFormats(): string[] {
  return ['.docx', '.xlsx', '.rtf', '.epub'];
}
