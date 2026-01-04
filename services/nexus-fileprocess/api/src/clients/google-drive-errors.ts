/**
 * Google Drive Error Types & Codes
 *
 * Provides structured error handling with verbose, actionable error messages.
 * Each error includes a specific error code, context about what failed,
 * and suggestions for how to fix the issue.
 */

/**
 * Error codes for different failure scenarios
 * Used to categorize and troubleshoot issues programmatically
 */
enum ErrorCode {
  // Authentication errors
  INVALID_CREDENTIALS = 'GDRIVE_INVALID_CREDENTIALS',
  TOKEN_GENERATION_FAILED = 'GDRIVE_TOKEN_GENERATION_FAILED',
  API_NOT_ENABLED = 'GDRIVE_API_NOT_ENABLED',

  // Upload session errors
  UPLOAD_SESSION_FAILED = 'GDRIVE_UPLOAD_SESSION_FAILED',
  FOLDER_NOT_FOUND = 'GDRIVE_FOLDER_NOT_FOUND',
  PERMISSION_DENIED = 'GDRIVE_PERMISSION_DENIED',

  // Chunk upload errors
  CHUNK_UPLOAD_FAILED = 'GDRIVE_CHUNK_UPLOAD_FAILED',
  UPLOAD_FAILED = 'GDRIVE_UPLOAD_FAILED',

  // Shareable link errors
  SHAREABLE_LINK_FAILED = 'GDRIVE_SHAREABLE_LINK_FAILED',

  // File metadata errors
  FILE_NOT_FOUND = 'GDRIVE_FILE_NOT_FOUND',
  METADATA_FETCH_FAILED = 'GDRIVE_METADATA_FETCH_FAILED',

  // Network errors
  NETWORK_TIMEOUT = 'GDRIVE_NETWORK_TIMEOUT',
  NETWORK_ERROR = 'GDRIVE_NETWORK_ERROR',

  // Configuration errors
  INVALID_CONFIG = 'GDRIVE_INVALID_CONFIG',
  MISSING_CONFIG = 'GDRIVE_MISSING_CONFIG',
}

/**
 * Context information included with errors
 */
interface ErrorContext {
  operation: string; // What operation was being performed
  filename?: string;
  fileSize?: number;
  fileId?: string;
  folderId?: string;
  chunk?: string; // For chunk uploads: "start-end/total"
  attempt?: number; // Retry attempt number
  maxRetries?: number;
  apiResponse?: number; // HTTP status code from Google API
  contentType?: string; // Content-Type header from response (useful for debugging HTML vs file responses)
  error?: string; // Original error message
  lastError?: string;
  input?: any;
  timestamp: Date;
  duration?: string; // How long operation took before failing
  suggestion: string; // How to fix the error
}

/**
 * Google Drive Error Class
 *
 * Extends Error with structured context and helpful suggestions.
 * Serializable to JSON for API responses.
 */
class GoogleDriveError extends Error {
  public readonly code: string;
  public readonly context: ErrorContext;
  public readonly isRetryable: boolean;

  constructor(
    message: string,
    code: string,
    context: ErrorContext,
    isRetryable: boolean = false
  ) {
    super(message);
    this.name = 'GoogleDriveError';
    this.code = code;
    this.context = context;
    this.isRetryable = isRetryable;

    // Capture stack trace
    Error.captureStackTrace(this, this.constructor);
  }

  /**
   * Serialize error to JSON for API responses
   * Includes all context needed for troubleshooting
   */
  toJSON() {
    return {
      error: this.message,
      code: this.code,
      isRetryable: this.isRetryable,
      context: {
        operation: this.context.operation,
        filename: this.context.filename,
        fileSize: this.context.fileSize,
        fileId: this.context.fileId,
        folderId: this.context.folderId,
        chunk: this.context.chunk,
        attempt: this.context.attempt,
        maxRetries: this.context.maxRetries,
        apiResponse: this.context.apiResponse,
        originalError: this.context.error,
        timestamp: this.context.timestamp.toISOString(),
        duration: this.context.duration,
        suggestion: this.context.suggestion,
      },
    };
  }

  /**
   * Get a detailed error report for logging
   */
  toDetailedString(): string {
    const lines = [
      `[${this.code}] ${this.message}`,
      `Operation: ${this.context.operation}`,
      `Timestamp: ${this.context.timestamp.toISOString()}`,
    ];

    if (this.context.filename) {
      lines.push(`Filename: ${this.context.filename}`);
    }

    if (this.context.fileSize) {
      lines.push(`File Size: ${this.formatBytes(this.context.fileSize)}`);
    }

    if (this.context.chunk) {
      lines.push(`Chunk: ${this.context.chunk}`);
    }

    if (this.context.attempt && this.context.maxRetries) {
      lines.push(`Attempt: ${this.context.attempt}/${this.context.maxRetries}`);
    }

    if (this.context.apiResponse) {
      lines.push(`API Response: ${this.context.apiResponse}`);
    }

    if (this.context.error) {
      lines.push(`Original Error: ${this.context.error}`);
    }

    if (this.context.duration) {
      lines.push(`Duration: ${this.context.duration}`);
    }

    lines.push(`Suggestion: ${this.context.suggestion}`);

    return lines.join('\n');
  }

  /**
   * Format bytes for human-readable display
   */
  private formatBytes(bytes: number): string {
    if (bytes === 0) return '0 Bytes';

    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));

    return Math.round((bytes / Math.pow(k, i)) * 100) / 100 + ' ' + sizes[i];
  }
}

/**
 * Error factory functions for common scenarios
 */
class GoogleDriveErrorFactory {
  /**
   * Create invalid config error
   */
  static invalidConfig(
    field: string,
    reason: string
  ): GoogleDriveError {
    return new GoogleDriveError(
      `Invalid Google Drive configuration: ${field}`,
      ErrorCode.INVALID_CONFIG,
      {
        operation: 'configuration',
        timestamp: new Date(),
        suggestion: `Fix ${field}. Reason: ${reason}`,
      }
    );
  }

  /**
   * Create missing config error
   */
  static missingConfig(field: string): GoogleDriveError {
    return new GoogleDriveError(
      `Missing required Google Drive configuration: ${field}`,
      ErrorCode.MISSING_CONFIG,
      {
        operation: 'configuration',
        timestamp: new Date(),
        suggestion: `Set ${field} environment variable or configuration. See README for setup instructions.`,
      }
    );
  }

  /**
   * Create network error
   */
  static networkError(
    operation: string,
    originalError: Error
  ): GoogleDriveError {
    return new GoogleDriveError(
      `Network error during ${operation}`,
      ErrorCode.NETWORK_ERROR,
      {
        operation,
        timestamp: new Date(),
        error: originalError.message,
        suggestion:
          'Check network connectivity. Verify Google APIs are accessible from your location.',
      },
      true // retryable
    );
  }

  /**
   * Create timeout error
   */
  static timeoutError(
    operation: string,
    timeoutMs: number
  ): GoogleDriveError {
    return new GoogleDriveError(
      `Timeout during ${operation} (${timeoutMs}ms)`,
      ErrorCode.NETWORK_TIMEOUT,
      {
        operation,
        timestamp: new Date(),
        suggestion: `${operation} took longer than ${timeoutMs}ms. Consider increasing timeout for large files.`,
      },
      true // retryable
    );
  }
}

export { GoogleDriveError, GoogleDriveErrorFactory, ErrorCode, ErrorContext };
