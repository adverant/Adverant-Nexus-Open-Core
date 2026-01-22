/**
 * Content Provider Interface
 *
 * Abstraction layer for fetching content from various sources:
 * - HTTP/HTTPS URLs
 * - Google Drive (files and folders)
 * - Future: Dropbox, OneDrive, S3, etc.
 *
 * Follows Open/Closed Principle: extensible for new providers
 * without modifying existing code.
 */

/**
 * File descriptor returned by content providers
 */
export interface FileDescriptor {
  /** Original URL or identifier */
  url: string;

  /** Suggested filename (extracted from URL or metadata) */
  filename: string;

  /** MIME type if available */
  mimeType?: string;

  /** File size in bytes if available */
  size?: number;

  /** Parent folder path for hierarchical display */
  parentPath?: string;

  /** Nesting depth (0 = root level) */
  depth: number;

  /** Last modified timestamp if available */
  lastModified?: string;

  /** File content hash if available */
  hash?: string;

  /** Additional metadata from source */
  metadata?: Record<string, any>;
}

/**
 * Discovery options for recursive folder traversal
 */
export interface DiscoveryOptions {
  /** Maximum recursion depth (default: 5) */
  maxDepth?: number;

  /** Maximum files to discover (default: 1000) */
  maxFiles?: number;

  /** File extensions to include (e.g., ['.pdf', '.docx']) */
  includeExtensions?: string[];

  /** File extensions to exclude */
  excludeExtensions?: string[];

  /** Minimum file size in bytes */
  minSize?: number;

  /** Maximum file size in bytes */
  maxSize?: number;

  /** Follow symlinks (for filesystem providers) */
  followSymlinks?: boolean;
}

/**
 * URL validation result
 */
export interface ValidationResult {
  /** Is URL valid and accessible? */
  valid: boolean;

  /** Type of resource: 'file' or 'folder' */
  type?: 'file' | 'folder';

  /** Error message if validation failed */
  error?: string;

  /** Estimated file count for folders */
  estimatedFileCount?: number;

  /** Whether recursive confirmation is needed */
  requiresConfirmation?: boolean;
}

/**
 * Progress callback for long-running operations
 */
export interface ProgressCallback {
  (progress: {
    /** Current step description */
    message: string;

    /** Progress percentage (0-100) */
    percentage?: number;

    /** Files processed so far */
    filesProcessed?: number;

    /** Total files to process */
    totalFiles?: number;
  }): void;
}

/**
 * Content Provider Interface
 *
 * All content providers must implement this interface.
 * Uses Strategy Pattern for interchangeable implementations.
 */
export interface IContentProvider {
  /**
   * Provider name for logging and identification
   */
  readonly name: string;

  /**
   * Check if this provider can handle the given URL
   *
   * @param url - URL to check
   * @returns true if provider can handle this URL
   *
   * Example:
   * - HTTPProvider: checks for http:// or https://
   * - GoogleDriveProvider: checks for drive.google.com or docs.google.com
   */
  canHandle(url: string): boolean;

  /**
   * Validate URL and determine resource type
   *
   * @param url - URL to validate
   * @returns Validation result with resource type and metadata
   * @throws ContentProviderError if validation fails
   */
  validateURL(url: string): Promise<ValidationResult>;

  /**
   * Fetch a single file from URL
   *
   * @param url - URL to fetch
   * @param onProgress - Optional progress callback
   * @returns File content as Buffer
   * @throws ContentProviderError if fetch fails
   */
  fetchFile(url: string, onProgress?: ProgressCallback): Promise<Buffer>;

  /**
   * Discover files in a folder (recursive)
   *
   * @param url - Folder URL
   * @param options - Discovery options (depth, filters, etc.)
   * @param onProgress - Optional progress callback
   * @returns Array of file descriptors
   * @throws ContentProviderError if discovery fails
   */
  discoverFiles(
    url: string,
    options: DiscoveryOptions,
    onProgress?: ProgressCallback
  ): Promise<FileDescriptor[]>;
}

/**
 * Content Provider Error
 *
 * Custom error class for content provider failures.
 * Includes error classification for proper handling.
 */
export class ContentProviderError extends Error {
  constructor(
    message: string,
    public readonly code: ContentProviderErrorCode,
    public readonly provider: string,
    public readonly url?: string,
    public readonly cause?: Error
  ) {
    super(message);
    this.name = 'ContentProviderError';

    // Maintain proper stack trace
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, ContentProviderError);
    }
  }
}

/**
 * Error codes for content provider failures
 */
export enum ContentProviderErrorCode {
  /** URL format is invalid */
  INVALID_URL = 'INVALID_URL',

  /** Authentication failed (OAuth, API key, etc.) */
  AUTH_FAILED = 'AUTH_FAILED',

  /** Access denied (permissions issue) */
  ACCESS_DENIED = 'ACCESS_DENIED',

  /** Resource not found (404) */
  NOT_FOUND = 'NOT_FOUND',

  /** Network error (timeout, connection refused) */
  NETWORK_ERROR = 'NETWORK_ERROR',

  /** Rate limit exceeded */
  RATE_LIMITED = 'RATE_LIMITED',

  /** File too large */
  FILE_TOO_LARGE = 'FILE_TOO_LARGE',

  /** Unsupported file type */
  UNSUPPORTED_TYPE = 'UNSUPPORTED_TYPE',

  /** Provider-specific error */
  PROVIDER_ERROR = 'PROVIDER_ERROR',

  /** Unknown error */
  UNKNOWN = 'UNKNOWN'
}

/**
 * Content Provider Registry
 *
 * Manages registered providers and routes URLs to appropriate provider.
 * Follows Single Responsibility Principle.
 */
export class ContentProviderRegistry {
  private providers: IContentProvider[] = [];

  /**
   * Register a new content provider
   */
  register(provider: IContentProvider): void {
    this.providers.push(provider);
  }

  /**
   * Find provider that can handle the given URL
   *
   * @param url - URL to route
   * @returns Provider instance
   * @throws ContentProviderError if no provider found
   */
  getProvider(url: string): IContentProvider {
    const provider = this.providers.find(p => p.canHandle(url));

    if (!provider) {
      throw new ContentProviderError(
        `No content provider found for URL: ${url}`,
        ContentProviderErrorCode.UNSUPPORTED_TYPE,
        'ContentProviderRegistry',
        url
      );
    }

    return provider;
  }

  /**
   * Get all registered providers
   */
  getProviders(): IContentProvider[] {
    return [...this.providers];
  }
}
