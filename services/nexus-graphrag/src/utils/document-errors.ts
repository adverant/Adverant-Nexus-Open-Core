/**
 * Custom Error Classes for Document Processing
 *
 * Implements verbose, actionable error messages following fail-fast philosophy.
 * Each error provides:
 * - What went wrong (specific failure point)
 * - Why it happened (root cause)
 * - How to fix it (resolution steps)
 *
 * Follows best practices:
 * - Specific error types (not generic exceptions)
 * - Structured error data for logging/monitoring
 * - User-friendly messages with technical context
 */

/**
 * Base class for all document processing errors
 */
export abstract class DocumentProcessingError extends Error {
  constructor(
    message: string,
    public readonly context: Record<string, any> = {}
  ) {
    super(message);
    this.name = this.constructor.name;

    // Maintain proper stack trace in V8
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, this.constructor);
    }
  }

  /**
   * Get structured error data for logging
   */
  toJSON(): Record<string, any> {
    return {
      name: this.name,
      message: this.message,
      context: this.context,
      stack: this.stack
    };
  }
}

/**
 * PDF parsing failed
 */
export class PDFParsingError extends DocumentProcessingError {
  constructor(
    public readonly filePath: string,
    public readonly reason: string,
    public readonly originalError?: Error
  ) {
    const message = [
      `PDF parsing failed for "${filePath}"`,
      ``,
      `Reason: ${reason}`,
      originalError ? `Original error: ${originalError.message}` : '',
      ``,
      `Resolution steps:`,
      `1. Verify PDF is not corrupted (try opening in PDF reader)`,
      `2. Check PDF is not password-protected`,
      `3. Ensure file size is under 50MB`,
      `4. Verify file is actually a PDF (check magic bytes: %PDF)`,
      `5. Try re-saving PDF with different tool to fix corruption`
    ].filter(Boolean).join('\n');

    super(message, {
      filePath,
      reason,
      originalError: originalError?.message,
      errorType: 'PDF_PARSING_FAILED'
    });
  }
}

/**
 * File parsing failed for supported format
 */
export class FileParsingError extends DocumentProcessingError {
  constructor(
    public readonly filePath: string,
    public readonly fileFormat: string,
    public readonly reason: string,
    public readonly originalError?: Error
  ) {
    const message = [
      `File parsing failed for ${fileFormat.toUpperCase()} document: "${filePath}"`,
      ``,
      `Reason: ${reason}`,
      originalError ? `Original error: ${originalError.message}` : '',
      ``,
      `Resolution steps:`,
      `1. Verify file is not corrupted`,
      `2. Check file format matches extension (.${fileFormat})`,
      `3. Ensure file is readable (check permissions)`,
      `4. Try re-saving file with different tool`,
      `5. Check file size is within limits`
    ].filter(Boolean).join('\n');

    super(message, {
      filePath,
      fileFormat,
      reason,
      originalError: originalError?.message,
      errorType: 'FILE_PARSING_FAILED'
    });
  }
}

/**
 * Unsupported content type provided
 */
export class UnsupportedContentTypeError extends DocumentProcessingError {
  constructor(
    public readonly detectedType: string,
    public readonly supportedTypes: string[]
  ) {
    const message = [
      `Unsupported content type detected: "${detectedType}"`,
      ``,
      `Supported content types:`,
      ...supportedTypes.map(t => `  - ${t}`),
      ``,
      `Resolution:`,
      `If providing a file, ensure extension is one of: ${supportedTypes.join(', ')}`,
      `If providing text content, ensure it's plain text (not binary data)`
    ].join('\n');

    super(message, {
      detectedType,
      supportedTypes,
      errorType: 'UNSUPPORTED_CONTENT_TYPE'
    });
  }
}

/**
 * Document produced insufficient chunks after processing
 * Indicates content extraction failed
 */
export class InsufficientChunksError extends DocumentProcessingError {
  constructor(
    public readonly documentId: string,
    public readonly chunkCount: number,
    public readonly minimumRequired: number,
    public readonly sampleChunkContent?: string
  ) {
    const message = [
      `Document ${documentId} produced insufficient chunks: ${chunkCount} (minimum required: ${minimumRequired})`,
      ``,
      `This indicates content extraction failed.`,
      ``,
      sampleChunkContent ? [
        `Sample of stored content:`,
        `"${sampleChunkContent.substring(0, 200)}${sampleChunkContent.length > 200 ? '...' : ''}"`,
        ``
      ].join('\n') : '',
      `Common causes:`,
      `1. File path was stored instead of content (check if chunk contains file path)`,
      `2. PDF text extraction failed (encrypted or image-only PDF)`,
      `3. File was empty or contained only metadata`,
      `4. Chunking strategy rejected all content as non-semantic`,
      ``,
      `Resolution:`,
      `1. Re-upload using correct content (not file path)`,
      `2. For PDFs: ensure they contain extractable text (not just images)`,
      `3. For encrypted PDFs: remove password protection first`,
      `4. Verify file actually contains content (not just formatting)`
    ].filter(Boolean).join('\n');

    super(message, {
      documentId,
      chunkCount,
      minimumRequired,
      sampleChunkContent: sampleChunkContent?.substring(0, 500),
      errorType: 'INSUFFICIENT_CHUNKS'
    });
  }
}

/**
 * File path validation failed
 */
export class InvalidFilePathError extends DocumentProcessingError {
  constructor(
    public readonly filePath: string,
    public readonly validationError: string
  ) {
    const message = [
      `Invalid file path: "${filePath}"`,
      ``,
      `Validation error: ${validationError}`,
      ``,
      `Resolution:`,
      `1. Verify file exists at specified path`,
      `2. Check file permissions (must be readable)`,
      `3. Ensure path is absolute (starts with / or drive letter)`,
      `4. Verify path doesn't contain invalid characters`
    ].join('\n');

    super(message, {
      filePath,
      validationError,
      errorType: 'INVALID_FILE_PATH'
    });
  }
}

/**
 * Content preprocessing failed
 */
export class ContentPreprocessingError extends DocumentProcessingError {
  constructor(
    public readonly contentType: string,
    public readonly stage: string,
    public readonly reason: string,
    public readonly originalError?: Error
  ) {
    const message = [
      `Content preprocessing failed at stage: ${stage}`,
      `Content type: ${contentType}`,
      ``,
      `Reason: ${reason}`,
      originalError ? `Original error: ${originalError.message}` : '',
      ``,
      `Resolution:`,
      `1. Check input format matches expected type`,
      `2. Verify content is not corrupted`,
      `3. Review preprocessing stage logs for details`,
      `4. Try providing content in different format`
    ].filter(Boolean).join('\n');

    super(message, {
      contentType,
      stage,
      reason,
      originalError: originalError?.message,
      errorType: 'PREPROCESSING_FAILED'
    });
  }
}

/**
 * Document validation failed
 */
export class DocumentValidationError extends DocumentProcessingError {
  constructor(
    public readonly validationErrors: string[],
    public readonly documentMetadata?: any
  ) {
    const message = [
      `Document validation failed with ${validationErrors.length} error(s):`,
      ``,
      ...validationErrors.map((err, i) => `  ${i + 1}. ${err}`),
      ``,
      documentMetadata ? [
        `Document metadata:`,
        JSON.stringify(documentMetadata, null, 2)
      ].join('\n') : '',
      ``,
      `Resolution:`,
      `1. Fix validation errors listed above`,
      `2. Ensure all required metadata fields are provided`,
      `3. Verify content type matches specified type`,
      `4. Check for invalid characters or encoding issues`
    ].filter(Boolean).join('\n');

    super(message, {
      validationErrors,
      documentMetadata,
      errorType: 'VALIDATION_FAILED'
    });
  }
}

/**
 * File size exceeds maximum allowed
 */
export class FileSizeExceededError extends DocumentProcessingError {
  constructor(
    public readonly filePath: string,
    public readonly actualSize: number,
    public readonly maxSize: number,
    public readonly fileFormat: string
  ) {
    const formatSize = (bytes: number) => {
      const mb = bytes / (1024 * 1024);
      return `${mb.toFixed(2)}MB`;
    };

    const message = [
      `File size exceeds maximum allowed for ${fileFormat.toUpperCase()} files`,
      ``,
      `File: "${filePath}"`,
      `Actual size: ${formatSize(actualSize)}`,
      `Maximum allowed: ${formatSize(maxSize)}`,
      ``,
      `Resolution:`,
      `1. Compress or split the file into smaller parts`,
      `2. Remove unnecessary content (images, metadata)`,
      `3. For PDFs: reduce image quality or remove embedded media`,
      `4. Convert to more compact format if possible`
    ].join('\n');

    super(message, {
      filePath,
      actualSize,
      maxSize,
      fileFormat,
      errorType: 'FILE_SIZE_EXCEEDED'
    });
  }
}

/**
 * Embedding generation failed
 */
export class EmbeddingGenerationError extends DocumentProcessingError {
  constructor(
    public readonly chunkId: string,
    public readonly reason: string,
    public readonly originalError?: Error
  ) {
    const message = [
      `Embedding generation failed for chunk: ${chunkId}`,
      ``,
      `Reason: ${reason}`,
      originalError ? `Original error: ${originalError.message}` : '',
      ``,
      `Resolution:`,
      `1. Check VoyageAI API key is valid`,
      `2. Verify network connectivity to VoyageAI service`,
      `3. Ensure chunk content is not empty or corrupted`,
      `4. Check if rate limits have been exceeded`,
      `5. Retry with exponential backoff`
    ].filter(Boolean).join('\n');

    super(message, {
      chunkId,
      reason,
      originalError: originalError?.message,
      errorType: 'EMBEDDING_FAILED'
    });
  }
}

/**
 * Helper function to check if error is a document processing error
 */
export function isDocumentProcessingError(error: any): error is DocumentProcessingError {
  return error instanceof DocumentProcessingError;
}

/**
 * Helper function to extract error context
 */
export function getErrorContext(error: Error): Record<string, any> {
  if (isDocumentProcessingError(error)) {
    return error.context;
  }
  return {
    message: error.message,
    stack: error.stack
  };
}

/**
 * Helper function to format error for API response
 */
export function formatErrorForAPI(error: Error): {
  error: string;
  type: string;
  context?: Record<string, any>;
  resolution?: string;
} {
  if (isDocumentProcessingError(error)) {
    return {
      error: error.message,
      type: error.context.errorType || error.name,
      context: error.context,
      resolution: extractResolutionFromMessage(error.message)
    };
  }

  return {
    error: error.message,
    type: 'UNKNOWN_ERROR',
    context: { stack: error.stack }
  };
}

/**
 * Extract resolution steps from error message
 */
function extractResolutionFromMessage(message: string): string | undefined {
  const resolutionMatch = message.match(/Resolution(?:\s+steps)?:([\s\S]*?)$/i);
  return resolutionMatch ? resolutionMatch[1].trim() : undefined;
}
