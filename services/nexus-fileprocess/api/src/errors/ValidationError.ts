/**
 * Custom error types for FileProcessAgent API
 *
 * Design Pattern: Factory Pattern for error creation
 * SOLID Principle: Single Responsibility (each error type has one purpose)
 */

export enum ErrorCode {
  // File validation errors (HTTP 422)
  FILE_EMPTY = 'FILE_EMPTY',
  FILE_TOO_LARGE = 'FILE_TOO_LARGE',
  FILE_TOO_SMALL = 'FILE_TOO_SMALL',
  UNSUPPORTED_FORMAT = 'UNSUPPORTED_FORMAT',
  MIME_MISMATCH = 'MIME_MISMATCH',
  CORRUPTED_FILE = 'CORRUPTED_FILE',
  VALIDATION_FAILED = 'VALIDATION_FAILED', // Generic validation failure

  // Processing errors (HTTP 500)
  QUEUE_SUBMISSION_FAILED = 'QUEUE_SUBMISSION_FAILED',
  DATABASE_ERROR = 'DATABASE_ERROR',
  INTERNAL_ERROR = 'INTERNAL_ERROR',
}

/**
 * Base validation error with complete context
 */
export class ValidationError extends Error {
  constructor(
    message: string,
    public readonly code: ErrorCode,
    public readonly httpStatus: number,
    public readonly context: {
      filename?: string;
      mimeType?: string;
      fileSize?: number;
      detectedMimeType?: string;
      suggestion: string;
      timestamp: Date;
    }
  ) {
    super(message);
    this.name = 'ValidationError';
    Error.captureStackTrace(this, this.constructor);
  }

  toJSON() {
    return {
      success: false,
      error: this.code,
      message: this.message,
      suggestion: this.context.suggestion,
      details: {
        filename: this.context.filename,
        mimeType: this.context.mimeType,
        fileSize: this.context.fileSize,
        detectedMimeType: this.context.detectedMimeType,
      },
      timestamp: this.context.timestamp.toISOString(),
    };
  }
}

/**
 * Factory functions for common validation errors
 */
export class ValidationErrorFactory {
  static emptyFile(filename: string): ValidationError {
    return new ValidationError(
      'File contains no data',
      ErrorCode.FILE_EMPTY,
      422,
      {
        filename,
        fileSize: 0,
        suggestion: 'Please upload a file with actual content',
        timestamp: new Date(),
      }
    );
  }

  static fileTooSmall(filename: string, size: number, minSize: number): ValidationError {
    return new ValidationError(
      `File is too small (${size} bytes, minimum ${minSize} bytes)`,
      ErrorCode.FILE_TOO_SMALL,
      422,
      {
        filename,
        fileSize: size,
        suggestion: `The file may be corrupted or incomplete. Minimum size is ${minSize} bytes`,
        timestamp: new Date(),
      }
    );
  }

  static fileTooLarge(filename: string, size: number, maxSize: number): ValidationError {
    return new ValidationError(
      `File is too large (${size} bytes, maximum ${maxSize} bytes)`,
      ErrorCode.FILE_TOO_LARGE,
      422,
      {
        filename,
        fileSize: size,
        suggestion: `Please reduce file size to under ${maxSize / 1024 / 1024}MB`,
        timestamp: new Date(),
      }
    );
  }

  static unsupportedFormat(
    filename: string,
    mimeType: string,
    detectedMimeType?: string
  ): ValidationError {
    return new ValidationError(
      `File type ${detectedMimeType || mimeType} is not supported`,
      ErrorCode.UNSUPPORTED_FORMAT,
      422,
      {
        filename,
        mimeType,
        detectedMimeType,
        suggestion: 'Supported formats: PDF, PNG, JPEG, TXT. Try converting your file to one of these formats.',
        timestamp: new Date(),
      }
    );
  }

  static mimeMismatch(
    filename: string,
    claimedMimeType: string,
    detectedMimeType: string
  ): ValidationError {
    return new ValidationError(
      `File appears to be ${detectedMimeType} but was uploaded as ${claimedMimeType}`,
      ErrorCode.MIME_MISMATCH,
      422,
      {
        filename,
        mimeType: claimedMimeType,
        detectedMimeType,
        suggestion: 'The file extension may not match the actual file content. Try renaming or converting the file.',
        timestamp: new Date(),
      }
    );
  }

  static corruptedFile(filename: string, mimeType: string, reason: string): ValidationError {
    return new ValidationError(
      `File appears to be corrupted: ${reason}`,
      ErrorCode.CORRUPTED_FILE,
      422,
      {
        filename,
        mimeType,
        suggestion: 'Try re-downloading or re-creating the file from its original source',
        timestamp: new Date(),
      }
    );
  }
}

/**
 * Processing errors (system failures, not client errors)
 */
export class ProcessingError extends Error {
  constructor(
    message: string,
    public readonly code: ErrorCode,
    public readonly originalError?: Error
  ) {
    super(message);
    this.name = 'ProcessingError';
    Error.captureStackTrace(this, this.constructor);
  }

  toJSON() {
    return {
      success: false,
      error: this.code,
      message: this.message,
      timestamp: new Date().toISOString(),
      requestId: require('crypto').randomUUID(),
    };
  }
}
