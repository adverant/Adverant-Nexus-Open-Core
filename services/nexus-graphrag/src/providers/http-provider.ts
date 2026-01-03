/**
 * HTTP/HTTPS Content Provider
 *
 * Handles generic file downloads from HTTP/HTTPS URLs with:
 * - Exponential backoff retry logic
 * - Timeout handling
 * - Error classification
 * - Progress streaming
 * - File size validation
 */

import axios, { AxiosError } from 'axios';
import {
  IContentProvider,
  FileDescriptor,
  DiscoveryOptions,
  ValidationResult,
  ProgressCallback,
  ContentProviderError,
  ContentProviderErrorCode
} from './content-provider.interface.js';
import { logger } from '../utils/logger.js';

/**
 * HTTP Provider Configuration
 */
export interface HTTPProviderConfig {
  /** Request timeout in milliseconds (default: 30000) */
  timeout?: number;

  /** Maximum file size in bytes (default: 100MB) */
  maxFileSize?: number;

  /** Maximum retry attempts (default: 3) */
  maxRetries?: number;

  /** Initial retry delay in milliseconds (default: 1000) */
  retryDelay?: number;

  /** Retry backoff multiplier (default: 2) */
  retryBackoff?: number;

  /** Custom HTTP headers */
  headers?: Record<string, string>;

  /** Follow redirects (default: true) */
  followRedirects?: boolean;

  /** Maximum redirects to follow (default: 5) */
  maxRedirects?: number;
}

/**
 * Default configuration
 */
const DEFAULT_CONFIG: Required<HTTPProviderConfig> = {
  timeout: 30000, // 30 seconds
  maxFileSize: 100 * 1024 * 1024, // 100MB
  maxRetries: 3,
  retryDelay: 1000, // 1 second
  retryBackoff: 2,
  headers: {
    'User-Agent': 'Adverant-Nexus-GraphRAG/1.0'
  },
  followRedirects: true,
  maxRedirects: 5
};

/**
 * HTTP Content Provider Implementation
 */
export class HTTPProvider implements IContentProvider {
  readonly name = 'HTTPProvider';
  private config: Required<HTTPProviderConfig>;

  constructor(config?: HTTPProviderConfig) {
    this.config = { ...DEFAULT_CONFIG, ...config };

    logger.info('HTTPProvider initialized', {
      timeout: this.config.timeout,
      maxFileSize: this.config.maxFileSize,
      maxRetries: this.config.maxRetries
    });
  }

  /**
   * Check if URL is HTTP/HTTPS
   */
  canHandle(url: string): boolean {
    try {
      const parsed = new URL(url);
      return parsed.protocol === 'http:' || parsed.protocol === 'https:';
    } catch {
      return false;
    }
  }

  /**
   * Validate URL and get resource metadata
   */
  async validateURL(url: string): Promise<ValidationResult> {
    try {
      // Parse URL
      const parsed = new URL(url);

      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        return {
          valid: false,
          error: `Unsupported protocol: ${parsed.protocol}`
        };
      }

      // Send HEAD request to check availability
      const response = await axios.head(url, {
        timeout: this.config.timeout,
        maxRedirects: this.config.maxRedirects,
        headers: this.config.headers,
        validateStatus: (status) => status < 500 // Accept 4xx for now
      });

      // Check for errors
      if (response.status === 404) {
        return {
          valid: false,
          error: 'Resource not found (404)'
        };
      }

      if (response.status === 403) {
        return {
          valid: false,
          error: 'Access denied (403)'
        };
      }

      if (response.status >= 400) {
        return {
          valid: false,
          error: `HTTP error: ${response.status} ${response.statusText}`
        };
      }

      // Check file size
      const contentLength = response.headers['content-length'];
      if (contentLength) {
        const size = parseInt(contentLength, 10);
        if (size > this.config.maxFileSize) {
          return {
            valid: false,
            error: `File too large: ${this.formatBytes(size)} (max: ${this.formatBytes(this.config.maxFileSize)})`
          };
        }
      }

      // HTTP URLs are always single files (no folder support)
      return {
        valid: true,
        type: 'file',
        requiresConfirmation: false
      };
    } catch (error) {
      logger.error('HTTP URL validation failed', {
        url,
        error: (error as Error).message
      });

      return {
        valid: false,
        error: this.getErrorMessage(error as Error)
      };
    }
  }

  /**
   * Fetch file from HTTP/HTTPS URL
   */
  async fetchFile(url: string, onProgress?: ProgressCallback): Promise<Buffer> {
    let lastError: Error | undefined;

    // Retry loop with exponential backoff
    for (let attempt = 0; attempt <= this.config.maxRetries; attempt++) {
      try {
        if (attempt > 0) {
          const delay = this.config.retryDelay * Math.pow(this.config.retryBackoff, attempt - 1);
          logger.info('Retrying HTTP request', {
            url,
            attempt,
            delayMs: delay
          });

          await this.sleep(delay);
        }

        // Make request
        const response = await axios.get(url, {
          responseType: 'arraybuffer',
          timeout: this.config.timeout,
          maxRedirects: this.config.maxRedirects,
          headers: this.config.headers,
          maxContentLength: this.config.maxFileSize,
          onDownloadProgress: (progressEvent) => {
            if (onProgress && progressEvent.total) {
              const percentage = Math.round(
                (progressEvent.loaded / progressEvent.total) * 100
              );

              onProgress({
                message: `Downloading: ${this.formatBytes(progressEvent.loaded)} / ${this.formatBytes(progressEvent.total)}`,
                percentage,
                filesProcessed: 0,
                totalFiles: 1
              });
            }
          }
        });

        // Validate response
        if (response.status !== 200) {
          throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }

        // Check content length
        const buffer = Buffer.from(response.data);
        if (buffer.length === 0) {
          throw new Error('Downloaded file is empty');
        }

        logger.info('HTTP file fetched successfully', {
          url,
          size: buffer.length,
          attempts: attempt + 1
        });

        if (onProgress) {
          onProgress({
            message: 'Download complete',
            percentage: 100,
            filesProcessed: 1,
            totalFiles: 1
          });
        }

        return buffer;
      } catch (error) {
        lastError = error as Error;

        // Classify error
        const errorCode = this.classifyError(error as Error);

        // Don't retry on certain errors
        if (
          errorCode === ContentProviderErrorCode.NOT_FOUND ||
          errorCode === ContentProviderErrorCode.ACCESS_DENIED ||
          errorCode === ContentProviderErrorCode.FILE_TOO_LARGE ||
          errorCode === ContentProviderErrorCode.INVALID_URL
        ) {
          throw this.createError(errorCode, url, error as Error);
        }

        // Log retry attempt
        if (attempt < this.config.maxRetries) {
          logger.warn('HTTP request failed, will retry', {
            url,
            attempt,
            error: (error as Error).message
          });
        } else {
          logger.error('HTTP request failed after all retries', {
            url,
            attempts: attempt + 1,
            error: (error as Error).message
          });
        }
      }
    }

    // All retries exhausted
    throw this.createError(
      ContentProviderErrorCode.NETWORK_ERROR,
      url,
      lastError!
    );
  }

  /**
   * Discover files (not supported for HTTP - returns single file descriptor)
   */
  async discoverFiles(
    url: string,
    _options: DiscoveryOptions,
    _onProgress?: ProgressCallback
  ): Promise<FileDescriptor[]> {
    // HTTP URLs represent single files, not folders
    // Validate URL first
    const validation = await this.validateURL(url);

    if (!validation.valid) {
      throw new ContentProviderError(
        validation.error || 'Invalid URL',
        ContentProviderErrorCode.INVALID_URL,
        this.name,
        url
      );
    }

    // Get filename from URL
    const filename = this.extractFilename(url);

    return [
      {
        url,
        filename,
        depth: 0,
        metadata: {
          provider: this.name
        }
      }
    ];
  }

  /**
   * Extract filename from URL
   */
  private extractFilename(url: string): string {
    try {
      const parsed = new URL(url);
      const pathname = parsed.pathname;

      // Get last segment of path
      const segments = pathname.split('/').filter(s => s.length > 0);
      if (segments.length > 0) {
        const lastSegment = segments[segments.length - 1];

        // Decode URL encoding
        return decodeURIComponent(lastSegment);
      }

      // Fallback: use hostname
      return `${parsed.hostname}-file`;
    } catch {
      // Fallback: generate filename
      return `http-file-${Date.now()}`;
    }
  }

  /**
   * Classify error into appropriate error code
   */
  private classifyError(error: Error): ContentProviderErrorCode {
    if (axios.isAxiosError(error)) {
      const axiosError = error as AxiosError;

      // HTTP status codes
      if (axiosError.response) {
        const status = axiosError.response.status;

        if (status === 404) return ContentProviderErrorCode.NOT_FOUND;
        if (status === 403 || status === 401) return ContentProviderErrorCode.ACCESS_DENIED;
        if (status === 429) return ContentProviderErrorCode.RATE_LIMITED;
        if (status === 413) return ContentProviderErrorCode.FILE_TOO_LARGE;
      }

      // Network errors
      if (axiosError.code === 'ECONNABORTED') return ContentProviderErrorCode.NETWORK_ERROR;
      if (axiosError.code === 'ETIMEDOUT') return ContentProviderErrorCode.NETWORK_ERROR;
      if (axiosError.code === 'ECONNREFUSED') return ContentProviderErrorCode.NETWORK_ERROR;
      if (axiosError.code === 'ENOTFOUND') return ContentProviderErrorCode.NOT_FOUND;
    }

    return ContentProviderErrorCode.UNKNOWN;
  }

  /**
   * Create ContentProviderError from error
   */
  private createError(
    code: ContentProviderErrorCode,
    url: string,
    cause: Error
  ): ContentProviderError {
    let message = `HTTP request failed: ${cause.message}`;

    // Add code-specific context
    switch (code) {
      case ContentProviderErrorCode.NOT_FOUND:
        message = `File not found at URL: ${url}`;
        break;
      case ContentProviderErrorCode.ACCESS_DENIED:
        message = `Access denied for URL: ${url}`;
        break;
      case ContentProviderErrorCode.RATE_LIMITED:
        message = `Rate limit exceeded for URL: ${url}`;
        break;
      case ContentProviderErrorCode.FILE_TOO_LARGE:
        message = `File too large (max: ${this.formatBytes(this.config.maxFileSize)}): ${url}`;
        break;
      case ContentProviderErrorCode.NETWORK_ERROR:
        message = `Network error fetching URL: ${url} - ${cause.message}`;
        break;
    }

    return new ContentProviderError(message, code, this.name, url, cause);
  }

  /**
   * Get user-friendly error message
   */
  private getErrorMessage(error: Error): string {
    if (axios.isAxiosError(error)) {
      const axiosError = error as AxiosError;

      if (axiosError.response) {
        return `HTTP ${axiosError.response.status}: ${axiosError.response.statusText}`;
      }

      if (axiosError.code === 'ETIMEDOUT') {
        return 'Request timed out';
      }

      if (axiosError.code === 'ECONNREFUSED') {
        return 'Connection refused';
      }

      if (axiosError.code === 'ENOTFOUND') {
        return 'Host not found';
      }
    }

    return error.message;
  }

  /**
   * Format bytes to human-readable string
   */
  private formatBytes(bytes: number): string {
    if (bytes === 0) return '0 Bytes';

    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));

    return Math.round((bytes / Math.pow(k, i)) * 100) / 100 + ' ' + sizes[i];
  }

  /**
   * Sleep utility
   */
  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
