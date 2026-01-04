/**
 * Type-safe error handling for nexus-cli
 * Eliminates 'any' types and provides proper error context
 */

/**
 * Axios HTTP error with proper typing
 */
export interface HttpError extends Error {
  code?: string;
  response?: {
    status: number;
    statusText: string;
    data?: {
      message?: string;
      error?: string;
      details?: unknown;
    };
  };
  request?: unknown;
  config?: unknown;
}

/**
 * Network error (ECONNREFUSED, ENOTFOUND, etc.)
 */
export interface NetworkError extends Error {
  code: 'ECONNREFUSED' | 'ENOTFOUND' | 'ETIMEDOUT' | 'ECONNRESET' | string;
  errno?: number;
  syscall?: string;
  hostname?: string;
  port?: number;
}

/**
 * Type guard to check if error is HTTP error
 */
export function isHttpError(error: unknown): error is HttpError {
  return (
    error instanceof Error &&
    'response' in error &&
    typeof (error as HttpError).response === 'object' &&
    (error as HttpError).response !== null
  );
}

/**
 * Type guard to check if error is network error
 */
export function isNetworkError(error: unknown): error is NetworkError {
  return (
    error instanceof Error &&
    'code' in error &&
    typeof (error as NetworkError).code === 'string'
  );
}

/**
 * Type guard to check if error is standard Error
 */
export function isError(error: unknown): error is Error {
  return error instanceof Error;
}

/**
 * Safe error message extraction with fallback
 */
export function getErrorMessage(error: unknown): string {
  if (isHttpError(error) && error.response?.data?.message) {
    return error.response.data.message;
  }

  if (isHttpError(error) && error.response?.data?.error) {
    return error.response.data.error;
  }

  if (isError(error)) {
    return error.message;
  }

  if (typeof error === 'string') {
    return error;
  }

  return 'Unknown error occurred';
}

/**
 * Get HTTP status code from error
 */
export function getHttpStatus(error: unknown): number | undefined {
  if (isHttpError(error)) {
    return error.response?.status;
  }

  return undefined;
}

/**
 * Get error code (for network errors)
 */
export function getErrorCode(error: unknown): string | undefined {
  if (isNetworkError(error)) {
    return error.code;
  }

  return undefined;
}
