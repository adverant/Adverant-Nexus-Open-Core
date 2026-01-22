/**
 * Google Drive Content Provider
 *
 * Handles Google Drive files and folders with:
 * - OAuth2 authentication
 * - Recursive folder traversal
 * - File metadata extraction
 * - Batch operations
 * - Rate limiting handling
 * - PUBLIC FILE DOWNLOAD FALLBACK (no auth required)
 *
 * Supported URL formats:
 * - https://drive.google.com/file/d/{fileId}/view
 * - https://drive.google.com/open?id={fileId}
 * - https://docs.google.com/document/d/{fileId}
 * - https://drive.google.com/drive/folders/{folderId}
 */

import { google, drive_v3 } from 'googleapis';
import { OAuth2Client } from 'google-auth-library';
import axios, { AxiosError } from 'axios';
import * as path from 'path';
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
import { GoogleOAuthManager } from '../auth/google-oauth-manager.js';

/**
 * Google Drive Provider Configuration
 */
export interface GoogleDriveProviderConfig {
  /** OAuth Manager instance (recommended for authenticated access) */
  oauthManager?: GoogleOAuthManager;

  /** OAuth2 credentials (deprecated - use oauthManager instead) */
  credentials?: {
    clientId: string;
    clientSecret: string;
    redirectUri: string;
  };

  /** API key (alternative to OAuth2 for public files) */
  apiKey?: string;

  /** Access token (deprecated - use oauthManager instead) */
  accessToken?: string;

  /** Refresh token (deprecated - use oauthManager instead) */
  refreshToken?: string;

  /** Maximum concurrent API requests (default: 5) */
  maxConcurrentRequests?: number;

  /** Request timeout in milliseconds (default: 30000) */
  timeout?: number;
}

/**
 * Google Drive file metadata
 */
interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  size?: string;
  webViewLink?: string;
  parents?: string[];
  createdTime?: string;
  modifiedTime?: string;
}

/**
 * Folder metadata for tracking
 */
interface FolderMetadata {
  id: string;
  name: string;
  path: string;
  depth: number;
}

/**
 * Google Drive MIME types
 */
const GOOGLE_FOLDER_MIME = 'application/vnd.google-apps.folder';
const GOOGLE_DOC_MIME = 'application/vnd.google-apps.document';
const GOOGLE_SHEET_MIME = 'application/vnd.google-apps.spreadsheet';
const GOOGLE_SLIDES_MIME = 'application/vnd.google-apps.presentation';

/**
 * Export MIME types for Google Workspace files
 */
const EXPORT_MIME_TYPES: Record<string, string> = {
  [GOOGLE_DOC_MIME]: 'application/pdf',
  [GOOGLE_SHEET_MIME]: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  [GOOGLE_SLIDES_MIME]: 'application/pdf'
};

/**
 * Google Drive Content Provider Implementation
 */
export class GoogleDriveProvider implements IContentProvider {
  readonly name = 'GoogleDriveProvider';
  private drive: drive_v3.Drive | null = null;
  private auth: OAuth2Client | null = null;
  private config: GoogleDriveProviderConfig;
  private oauthManager?: GoogleOAuthManager;

  constructor(config: GoogleDriveProviderConfig) {
    this.config = {
      maxConcurrentRequests: 5,
      timeout: 30000,
      ...config
    };

    // Store OAuth manager reference
    this.oauthManager = config.oauthManager;

    // Initialize auth based on available options (priority order)
    if (config.oauthManager) {
      // OAuth Manager (recommended) - auth will be retrieved dynamically
      logger.info('GoogleDriveProvider initialized', {
        authMethod: 'OAuth Manager (dynamic)'
      });
    } else if (config.credentials && config.accessToken) {
      // Legacy: Static OAuth2 credentials
      this.auth = new google.auth.OAuth2(
        config.credentials.clientId,
        config.credentials.clientSecret,
        config.credentials.redirectUri
      );

      this.auth.setCredentials({
        access_token: config.accessToken,
        refresh_token: config.refreshToken
      });

      this.drive = google.drive({
        version: 'v3',
        auth: this.auth
      });

      logger.info('GoogleDriveProvider initialized', {
        authMethod: 'OAuth2 (static credentials)'
      });
    } else if (config.apiKey) {
      // API key for public resources (no OAuth2)
      this.auth = null;
      this.drive = google.drive({
        version: 'v3',
        auth: config.apiKey
      });

      logger.info('GoogleDriveProvider initialized', {
        authMethod: 'API Key (public access)'
      });
    } else {
      // No auth configured - will initialize on first request if OAuth manager available
      logger.warn('GoogleDriveProvider initialized without auth', {
        message: 'Will attempt to use OAuth manager on first request'
      });
    }
  }

  /**
   * Get authenticated Drive client (creates on demand if using OAuth manager)
   */
  private async getDrive(): Promise<drive_v3.Drive> {
    logger.info('GoogleDriveProvider: getDrive() called', {
      driveInitialized: !!this.drive,
      hasOAuthManager: !!this.oauthManager,
      hasApiKey: !!this.config.apiKey
    });

    // If drive already initialized, return it
    if (this.drive) {
      logger.info('GoogleDriveProvider: returning existing drive client');
      return this.drive;
    }

    // If OAuth manager available, get Drive client from it
    if (this.oauthManager) {
      try {
        logger.info('GoogleDriveProvider: attempting to get drive client from OAuth manager');
        this.drive = await this.oauthManager.getDriveClient();
        logger.info('Drive client obtained from OAuth manager');
        return this.drive;
      } catch (error) {
        logger.error('GoogleDriveProvider: failed to get drive client from OAuth manager', {
          error: (error as Error).message
        });
        throw new ContentProviderError(
          `Failed to get authenticated Drive client: ${(error as Error).message}`,
          ContentProviderErrorCode.ACCESS_DENIED,
          this.name,
          undefined,
          error as Error
        );
      }
    }

    logger.error('GoogleDriveProvider: no authentication available', {
      driveInitialized: !!this.drive,
      hasOAuthManager: !!this.oauthManager
    });

    throw new ContentProviderError(
      'No authentication configured for Google Drive',
      ContentProviderErrorCode.ACCESS_DENIED,
      this.name
    );
  }

  /**
   * Check if URL is a Google Drive URL
   */
  canHandle(url: string): boolean {
    try {
      const parsed = new URL(url);
      return (
        parsed.hostname === 'drive.google.com' ||
        parsed.hostname === 'docs.google.com'
      );
    } catch {
      return false;
    }
  }

  /**
   * Validate Google Drive URL and determine resource type
   */
  async validateURL(url: string): Promise<ValidationResult> {
    try {
      logger.info('GoogleDriveProvider: validateURL called', { url });

      // Extract file/folder ID
      const resourceId = this.extractResourceId(url);
      logger.info('GoogleDriveProvider: extracted resource ID', { resourceId, url });

      if (!resourceId) {
        logger.error('GoogleDriveProvider: failed to extract resource ID', { url });
        return {
          valid: false,
          error: 'Could not extract file/folder ID from URL'
        };
      }

      // Try API-based metadata fetch first
      try {
        logger.info('GoogleDriveProvider: attempting to fetch metadata', { resourceId });
        const metadata = await this.getFileMetadata(resourceId);
        logger.info('GoogleDriveProvider: metadata fetched successfully', {
          resourceId,
          name: metadata.name,
          mimeType: metadata.mimeType
        });
        const isFolder = metadata.mimeType === GOOGLE_FOLDER_MIME;

        if (isFolder) {
          const estimatedCount = await this.estimateFileCount(resourceId);
          return {
            valid: true,
            type: 'folder',
            estimatedFileCount: estimatedCount,
            requiresConfirmation: estimatedCount > 10
          };
        } else {
          return {
            valid: true,
            type: 'file',
            requiresConfirmation: false
          };
        }
      } catch (apiError: any) {
        logger.warn('API-based validation failed, trying web scraping fallback', {
          url,
          error: (apiError as Error).message
        });

        // Fallback: For public folders, detect type from URL pattern
        // Folder URLs contain /folders/ or /drive/folders/
        const isFolderUrl = url.includes('/folders/') || url.includes('/drive/folders/');

        if (isFolderUrl) {
          logger.info('Detected public folder URL, will use web scraping', { url });
          return {
            valid: true,
            type: 'folder',
            estimatedFileCount: 0, // Unknown, will discover during scraping
            requiresConfirmation: false
          };
        } else {
          return {
            valid: true,
            type: 'file',
            requiresConfirmation: false
          };
        }
      }
    } catch (error) {
      logger.error('Google Drive URL validation failed', {
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
   * Fetch file from Google Drive
   */
  async fetchFile(url: string, onProgress?: ProgressCallback): Promise<Buffer> {
    try {
      const fileId = this.extractResourceId(url);

      if (!fileId) {
        throw this.createError(
          ContentProviderErrorCode.INVALID_URL,
          url,
          new Error('Could not extract file ID from URL')
        );
      }

      // Get file metadata
      const metadata = await this.getFileMetadata(fileId);

      // Check if it's a folder
      if (metadata.mimeType === GOOGLE_FOLDER_MIME) {
        throw this.createError(
          ContentProviderErrorCode.INVALID_URL,
          url,
          new Error('URL points to a folder, use discoverFiles() instead')
        );
      }

      if (onProgress) {
        onProgress({
          message: `Downloading: ${metadata.name}`,
          percentage: 0,
          filesProcessed: 0,
          totalFiles: 1
        });
      }

      // Download file
      const buffer = await this.downloadFile(fileId, metadata);

      if (onProgress) {
        onProgress({
          message: 'Download complete',
          percentage: 100,
          filesProcessed: 1,
          totalFiles: 1
        });
      }

      logger.info('Google Drive file fetched successfully', {
        fileId,
        name: metadata.name,
        size: buffer.length
      });

      return buffer;
    } catch (error) {
      logger.error('Google Drive file fetch failed', {
        url,
        error: (error as Error).message
      });

      if (error instanceof ContentProviderError) {
        throw error;
      }

      throw this.createError(
        ContentProviderErrorCode.PROVIDER_ERROR,
        url,
        error as Error
      );
    }
  }

  /**
   * Discover files in Google Drive folder (recursive)
   */
  async discoverFiles(
    url: string,
    options: DiscoveryOptions,
    onProgress?: ProgressCallback
  ): Promise<FileDescriptor[]> {
    try {
      const folderId = this.extractResourceId(url);

      if (!folderId) {
        throw this.createError(
          ContentProviderErrorCode.INVALID_URL,
          url,
          new Error('Could not extract folder ID from URL')
        );
      }

      // Get folder metadata
      const metadata = await this.getFileMetadata(folderId);

      // Verify it's a folder
      if (metadata.mimeType !== GOOGLE_FOLDER_MIME) {
        throw this.createError(
          ContentProviderErrorCode.INVALID_URL,
          url,
          new Error('URL does not point to a folder')
        );
      }

      // Set defaults
      const maxDepth = options.maxDepth ?? 5;
      const maxFiles = options.maxFiles ?? 1000;

      // Discover files recursively
      const files: FileDescriptor[] = [];
      const foldersToProcess: FolderMetadata[] = [
        {
          id: folderId,
          name: metadata.name,
          path: metadata.name,
          depth: 0
        }
      ];

      let processedFolders = 0;

      while (foldersToProcess.length > 0 && files.length < maxFiles) {
        const folder = foldersToProcess.shift()!;

        // Check depth limit
        if (folder.depth >= maxDepth) {
          logger.warn('Max depth reached, skipping folder', {
            folder: folder.name,
            depth: folder.depth
          });
          continue;
        }

        if (onProgress) {
          onProgress({
            message: `Discovering files in: ${folder.path}`,
            filesProcessed: files.length,
            totalFiles: maxFiles
          });
        }

        // List files in folder
        const children = await this.listFilesInFolder(folder.id);
        processedFolders++;

        for (const child of children) {
          // Check file limit
          if (files.length >= maxFiles) {
            logger.warn('Max files limit reached', { maxFiles });
            break;
          }

          if (child.mimeType === GOOGLE_FOLDER_MIME) {
            // Add subfolder to queue
            foldersToProcess.push({
              id: child.id,
              name: child.name,
              path: `${folder.path}/${child.name}`,
              depth: folder.depth + 1
            });
          } else {
            // Filter by extension if specified
            if (options.includeExtensions && options.includeExtensions.length > 0) {
              const ext = path.extname(child.name).toLowerCase();
              if (!options.includeExtensions.includes(ext)) {
                continue;
              }
            }

            if (options.excludeExtensions && options.excludeExtensions.length > 0) {
              const ext = path.extname(child.name).toLowerCase();
              if (options.excludeExtensions.includes(ext)) {
                continue;
              }
            }

            // Filter by size if specified
            if (child.size) {
              const size = parseInt(child.size, 10);

              if (options.minSize && size < options.minSize) {
                continue;
              }

              if (options.maxSize && size > options.maxSize) {
                continue;
              }
            }

            // Add file descriptor
            files.push({
              url: child.webViewLink || `https://drive.google.com/file/d/${child.id}/view`,
              filename: child.name,
              mimeType: child.mimeType,
              size: child.size ? parseInt(child.size, 10) : undefined,
              parentPath: folder.path,
              depth: folder.depth + 1,
              metadata: {
                provider: this.name,
                fileId: child.id,
                createdTime: child.createdTime,
                modifiedTime: child.modifiedTime
              }
            });
          }
        }
      }

      logger.info('Google Drive folder discovery complete', {
        folderId,
        filesFound: files.length,
        foldersProcessed: processedFolders
      });

      if (onProgress) {
        onProgress({
          message: 'Discovery complete',
          percentage: 100,
          filesProcessed: files.length,
          totalFiles: files.length
        });
      }

      return files;
    } catch (error) {
      logger.error('Google Drive folder discovery failed', {
        url,
        error: (error as Error).message
      });

      if (error instanceof ContentProviderError) {
        throw error;
      }

      throw this.createError(
        ContentProviderErrorCode.PROVIDER_ERROR,
        url,
        error as Error
      );
    }
  }

  /**
   * Extract file/folder ID from Google Drive URL
   */
  private extractResourceId(url: string): string | null {
    try {
      const parsed = new URL(url);

      // Pattern 1: /file/d/{fileId}
      const fileMatch = parsed.pathname.match(/\/file\/d\/([a-zA-Z0-9_-]+)/);
      if (fileMatch) return fileMatch[1];

      // Pattern 2: /folders/{folderId}
      const folderMatch = parsed.pathname.match(/\/folders\/([a-zA-Z0-9_-]+)/);
      if (folderMatch) return folderMatch[1];

      // Pattern 3: /document/d/{fileId} or /spreadsheets/d/{fileId}
      const docMatch = parsed.pathname.match(/\/d\/([a-zA-Z0-9_-]+)/);
      if (docMatch) return docMatch[1];

      // Pattern 4: ?id={fileId}
      const idParam = parsed.searchParams.get('id');
      if (idParam) return idParam;

      return null;
    } catch {
      return null;
    }
  }

  /**
   * Get file metadata from Google Drive
   */
  private async getFileMetadata(fileId: string): Promise<DriveFile> {
    try {
      logger.info('GoogleDriveProvider: getFileMetadata called', { fileId });
      const drive = await this.getDrive();
      logger.info('GoogleDriveProvider: drive client obtained, calling API', { fileId });

      const response = await drive.files.get({
        fileId,
        fields: 'id,name,mimeType,size,webViewLink,parents,createdTime,modifiedTime',
        supportsAllDrives: true
      });

      logger.info('GoogleDriveProvider: API response received', {
        fileId,
        name: response.data.name,
        mimeType: response.data.mimeType
      });

      return response.data as DriveFile;
    } catch (error: any) {
      logger.error('GoogleDriveProvider: getFileMetadata failed', {
        fileId,
        errorCode: error.code,
        errorMessage: error.message,
        errorStack: error.stack
      });

      if (error.code === 404) {
        throw new ContentProviderError(
          `File not found: ${fileId}`,
          ContentProviderErrorCode.NOT_FOUND,
          this.name,
          undefined,
          error
        );
      }

      if (error.code === 403) {
        throw new ContentProviderError(
          `Access denied: ${fileId}. This may indicate the API key lacks permissions or the file requires OAuth authentication.`,
          ContentProviderErrorCode.ACCESS_DENIED,
          this.name,
          undefined,
          error
        );
      }

      throw error;
    }
  }

  /**
   * Download file from Google Drive (API-based, requires authentication)
   */
  private async downloadFile(fileId: string, metadata: DriveFile): Promise<Buffer> {
    try {
      const drive = await this.getDrive();
      let response;

      // Check if it's a Google Workspace file (requires export)
      if (EXPORT_MIME_TYPES[metadata.mimeType]) {
        response = await drive.files.export(
          {
            fileId,
            mimeType: EXPORT_MIME_TYPES[metadata.mimeType]
          },
          { responseType: 'arraybuffer' }
        );
      } else {
        response = await drive.files.get(
          { fileId, alt: 'media', supportsAllDrives: true },
          { responseType: 'arraybuffer' }
        );
      }

      return Buffer.from(response.data as ArrayBuffer);
    } catch (error: any) {
      if (error.code === 403 && error.message.includes('quota')) {
        throw new ContentProviderError(
          'Google Drive API quota exceeded',
          ContentProviderErrorCode.RATE_LIMITED,
          this.name,
          undefined,
          error
        );
      }

      throw error;
    }
  }

  /**
   * Download PUBLIC file from Google Drive (no authentication required)
   *
   * This method handles publicly shared Google Drive files using direct download URLs.
   * It bypasses the Drive API and Google's virus scan warnings for large/binary files.
   *
   * @param fileId - Google Drive file ID
   * @returns File content as Buffer
   */
  private async downloadPublicFile(fileId: string): Promise<Buffer> {
    logger.info('Attempting public file download', { fileId });

    // Initial download URL with confirmation token for virus scan bypass
    let downloadUrl = `https://drive.google.com/uc?export=download&id=${fileId}&confirm=t`;

    try {
      // First attempt - get file or virus scan warning page
      const initialResponse = await axios.get(downloadUrl, {
        responseType: 'arraybuffer',
        maxRedirects: 5,
        timeout: 60000,
        validateStatus: (status) => status >= 200 && status < 400,
        headers: {
          'User-Agent': 'Adverant-Nexus-GraphRAG/1.0'
        }
      });

      const contentType = initialResponse.headers['content-type'] || '';
      const contentLength = parseInt(initialResponse.headers['content-length'] || '0', 10);

      // Check if Google returned a virus scan warning HTML page
      if (contentType.includes('text/html')) {
        const htmlContent = Buffer.from(initialResponse.data).toString('utf-8');

        // Detect virus scan warning page
        if (htmlContent.includes('Virus scan warning') ||
            htmlContent.includes('Google Drive - Virus scan warning') ||
            htmlContent.includes('uc-download-link') ||
            htmlContent.includes('Google Drive can\'t scan this file')) {

          logger.info('Google Drive virus scan warning detected - extracting confirmation URL', {
            fileId,
            contentType,
          });

          // Extract the confirmation URL from the HTML page
          const confirmUrl = this.extractVirusScanConfirmUrl(htmlContent, fileId);

          if (!confirmUrl) {
            throw new ContentProviderError(
              'Could not extract virus scan confirmation URL from Google Drive response',
              ContentProviderErrorCode.ACCESS_DENIED,
              this.name,
              `https://drive.google.com/file/d/${fileId}/view`
            );
          }

          logger.info('Retrying download with virus scan confirmation URL', { fileId });

          // Retry with the confirmation URL
          const confirmedResponse = await axios.get(confirmUrl, {
            responseType: 'arraybuffer',
            maxRedirects: 5,
            timeout: 300000, // 5 minutes for actual download
            validateStatus: (status) => status >= 200 && status < 400,
            headers: {
              'User-Agent': 'Adverant-Nexus-GraphRAG/1.0'
            }
          });

          const confirmedContentType = confirmedResponse.headers['content-type'] || 'application/octet-stream';

          // Verify we got the actual file, not another HTML page
          if (confirmedContentType.includes('text/html')) {
            throw new ContentProviderError(
              'Google Drive returned HTML instead of file content after confirmation',
              ContentProviderErrorCode.ACCESS_DENIED,
              this.name,
              `https://drive.google.com/file/d/${fileId}/view`
            );
          }

          const buffer = Buffer.from(confirmedResponse.data);
          logger.info('Public file downloaded successfully after virus scan bypass', {
            fileId,
            size: buffer.length,
            mimeType: confirmedContentType
          });

          return buffer;
        }

        // Unknown HTML response - might be access denied or other error
        throw new ContentProviderError(
          'Google Drive returned an unexpected HTML page instead of the file',
          ContentProviderErrorCode.ACCESS_DENIED,
          this.name,
          `https://drive.google.com/file/d/${fileId}/view`
        );
      }

      // We got the actual file in the first response
      const buffer = Buffer.from(initialResponse.data);
      logger.info('Public file downloaded successfully (direct)', {
        fileId,
        size: buffer.length,
        mimeType: contentType
      });

      return buffer;

    } catch (error) {
      if (error instanceof ContentProviderError) {
        throw error;
      }

      const axiosError = error as AxiosError;

      if (axiosError?.response?.status === 404) {
        throw new ContentProviderError(
          'File not found or not publicly accessible',
          ContentProviderErrorCode.NOT_FOUND,
          this.name,
          `https://drive.google.com/file/d/${fileId}/view`,
          error as Error
        );
      }

      if (axiosError?.response?.status === 403) {
        throw new ContentProviderError(
          'Access denied: File is not publicly shared',
          ContentProviderErrorCode.ACCESS_DENIED,
          this.name,
          `https://drive.google.com/file/d/${fileId}/view`,
          error as Error
        );
      }

      throw new ContentProviderError(
        `Failed to download public file: ${(error as Error).message}`,
        ContentProviderErrorCode.NETWORK_ERROR,
        this.name,
        `https://drive.google.com/file/d/${fileId}/view`,
        error as Error
      );
    }
  }

  /**
   * Extract virus scan confirmation URL from Google Drive HTML warning page
   */
  private extractVirusScanConfirmUrl(htmlContent: string, fileId: string): string | null {
    // Method 1: Extract from form action with hidden inputs
    const formActionMatch = htmlContent.match(/action="(https:\/\/drive\.usercontent\.google\.com\/download[^"]*)"/);
    if (formActionMatch) {
      const baseUrl = formActionMatch[1];
      const params = new URLSearchParams();

      // Extract all hidden input values
      const hiddenInputRegex = /<input[^>]*type="hidden"[^>]*name="([^"]+)"[^>]*value="([^"]*)"/g;
      let inputMatch;
      while ((inputMatch = hiddenInputRegex.exec(htmlContent)) !== null) {
        params.set(inputMatch[1], inputMatch[2]);
      }

      // Also try reverse attribute order: value before name
      const hiddenInputRegex2 = /<input[^>]*value="([^"]*)"[^>]*name="([^"]+)"/g;
      while ((inputMatch = hiddenInputRegex2.exec(htmlContent)) !== null) {
        params.set(inputMatch[2], inputMatch[1]);
      }

      // Ensure we have at least the file ID
      if (!params.has('id')) params.set('id', fileId);
      if (!params.has('export')) params.set('export', 'download');
      if (!params.has('confirm')) params.set('confirm', 't');

      return `${baseUrl}?${params.toString()}`;
    }

    // Method 2: Look for direct download link
    const downloadLinkMatch = htmlContent.match(/href="([^"]*confirm=[^"]*)"/);
    if (downloadLinkMatch) {
      let downloadUrl = downloadLinkMatch[1].replace(/&amp;/g, '&');
      if (downloadUrl.startsWith('/')) {
        downloadUrl = `https://drive.google.com${downloadUrl}`;
      }
      return downloadUrl;
    }

    // Method 3: Extract UUID and construct URL manually
    const uuidMatch = htmlContent.match(/uuid[^a-zA-Z0-9-]*([a-f0-9-]{36})/i);
    if (uuidMatch) {
      return `https://drive.usercontent.google.com/download?id=${fileId}&export=download&confirm=t&uuid=${uuidMatch[1]}`;
    }

    // Method 4: Fallback - use direct usercontent download
    return `https://drive.usercontent.google.com/download?id=${fileId}&export=download&authuser=0&confirm=t`;
  }

  /**
   * List files in a folder
   */
  private async listFilesInFolder(folderId: string): Promise<DriveFile[]> {
    const drive = await this.getDrive();
    const files: DriveFile[] = [];
    let pageToken: string | undefined;

    do {
      const response = await drive.files.list({
        q: `'${folderId}' in parents and trashed=false`,
        fields: 'nextPageToken,files(id,name,mimeType,size,webViewLink,parents,createdTime,modifiedTime)',
        pageSize: 100,
        pageToken,
        supportsAllDrives: true,
        includeItemsFromAllDrives: true
      });

      if (response.data.files) {
        files.push(...(response.data.files as DriveFile[]));
      }

      pageToken = response.data.nextPageToken || undefined;
    } while (pageToken);

    return files;
  }

  /**
   * Estimate file count in folder (single level only)
   */
  private async estimateFileCount(folderId: string): Promise<number> {
    try {
      const drive = await this.getDrive();
      const response = await drive.files.list({
        q: `'${folderId}' in parents and trashed=false`,
        fields: 'files(id)',
        pageSize: 1000,
        supportsAllDrives: true,
        includeItemsFromAllDrives: true
      });

      return response.data.files?.length || 0;
    } catch {
      return 0;
    }
  }

  /**
   * Create ContentProviderError from error
   */
  private createError(
    code: ContentProviderErrorCode,
    url: string,
    cause: Error
  ): ContentProviderError {
    let message = `Google Drive error: ${cause.message}`;

    switch (code) {
      case ContentProviderErrorCode.NOT_FOUND:
        message = `File or folder not found: ${url}`;
        break;
      case ContentProviderErrorCode.ACCESS_DENIED:
        message = `Access denied for resource: ${url}`;
        break;
      case ContentProviderErrorCode.RATE_LIMITED:
        message = `Google Drive API quota exceeded`;
        break;
      case ContentProviderErrorCode.INVALID_URL:
        message = `Invalid Google Drive URL: ${url}`;
        break;
    }

    return new ContentProviderError(message, code, this.name, url, cause);
  }

  /**
   * Get user-friendly error message
   */
  private getErrorMessage(error: Error): string {
    if ('code' in error) {
      const code = (error as any).code;

      if (code === 404) return 'File or folder not found';
      if (code === 403) return 'Access denied (check permissions)';
      if (code === 429) return 'Rate limit exceeded';
    }

    return error.message;
  }
}
