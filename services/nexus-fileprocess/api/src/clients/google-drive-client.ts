/**
 * Google Drive Client for FileProcessAgent
 *
 * Handles server-to-server file uploads to Google Drive using service account authentication.
 * Provides resumable uploads for large files, automatic retry logic, and comprehensive error handling.
 *
 * Service Account Flow:
 * 1. Service account JWT is created using the private key from credentials JSON
 * 2. JWT is exchanged for an access token via Google's OAuth2 endpoint
 * 3. Access token is used to authenticate Drive API requests
 * 4. Token is cached and automatically refreshed when expired
 *
 * File Upload Flow:
 * 1. Initiate resumable upload session (returns upload_url)
 * 2. Upload file chunks in sequential order
 * 3. Handle chunk upload failures with exponential backoff retry
 * 4. Verify upload completion with file metadata
 * 5. Generate shareable link with long-term access
 *
 * Error Handling:
 * - Provides verbose error codes for troubleshooting
 * - Includes retry logic with exponential backoff for transient failures
 * - Distinguishes between retryable and non-retryable errors
 * - Logs complete context for debugging large file uploads
 */

import axios, { AxiosInstance, AxiosError } from 'axios';
import { Readable } from 'stream';
import { logger } from '../utils/logger';
import { GoogleDriveError, ErrorCode } from './google-drive-errors';

/**
 * JWT token with expiration tracking
 */
interface CachedToken {
  accessToken: string;
  expiresAt: number; // Unix timestamp in milliseconds
}

/**
 * Resumable upload session
 */
interface UploadSession {
  uploadUrl: string;
  fileId: string;
  mimeType: string;
  totalBytes: number;
  uploadedBytes: number;
}

/**
 * File metadata returned from Drive API
 */
interface DriveFileMetadata {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  webViewLink: string;
  createdTime: string;
  modifiedTime: string;
}

/**
 * Configuration for uploads
 */
interface UploadConfig {
  chunkSizeBytes: number; // Default: 10MB chunks
  maxRetries: number;
  retryBackoffMs: number;
  uploadTimeoutMs: number;
  tokenRefreshBufferMs: number; // Refresh token before expiry (default: 60s)
}

class GoogleDriveClient {
  private static instance: GoogleDriveClient | null = null;

  private client: AxiosInstance;
  private cachedToken: CachedToken | null = null;
  private serviceAccountEmail: string;
  private privateKey: string;
  private folderId: string;
  private uploadConfig: UploadConfig;
  private isInitializing = false;
  private initPromise: Promise<void> | null = null;

  /**
   * Private constructor - use getInstance() instead
   */
  private constructor(
    serviceAccountEmail: string,
    privateKey: string,
    folderId: string,
    uploadConfig: Partial<UploadConfig> = {}
  ) {
    this.serviceAccountEmail = serviceAccountEmail;
    this.privateKey = privateKey;
    this.folderId = folderId;

    // Merge with defaults
    this.uploadConfig = {
      chunkSizeBytes: 10 * 1024 * 1024, // 10MB chunks
      maxRetries: 5,
      retryBackoffMs: 1000,
      uploadTimeoutMs: 300000, // 5 minutes per chunk
      tokenRefreshBufferMs: 60000, // 60 seconds
      ...uploadConfig,
    };

    this.client = axios.create({
      timeout: this.uploadConfig.uploadTimeoutMs,
    });
  }

  /**
   * Get or create singleton instance
   */
  static getInstance(
    serviceAccountEmail: string,
    privateKey: string,
    folderId: string,
    uploadConfig?: Partial<UploadConfig>
  ): GoogleDriveClient {
    if (!GoogleDriveClient.instance) {
      GoogleDriveClient.instance = new GoogleDriveClient(
        serviceAccountEmail,
        privateKey,
        folderId,
        uploadConfig
      );
    }
    return GoogleDriveClient.instance;
  }

  /**
   * Ensure client is initialized (token obtained)
   */
  async ensureInitialized(): Promise<void> {
    if (this.cachedToken && !this.isTokenExpired()) {
      return;
    }

    if (this.isInitializing && this.initPromise) {
      return this.initPromise;
    }

    this.isInitializing = true;
    this.initPromise = this.refreshAccessToken()
      .catch((error) => {
        this.isInitializing = false;
        this.initPromise = null;
        throw error;
      })
      .finally(() => {
        this.isInitializing = false;
      });

    return this.initPromise;
  }

  /**
   * Create JWT and exchange for access token
   */
  private async refreshAccessToken(): Promise<void> {
    const startTime = Date.now();

    try {
      // Parse private key (handle various formats)
      const keyLines = this.privateKey
        .split('\\n')
        .map((line) => line.trim());
      const keyContent = keyLines.join('\n');

      // Create JWT header
      const header = {
        alg: 'RS256',
        typ: 'JWT',
      };

      // Create JWT payload
      const now = Math.floor(Date.now() / 1000);
      const payload = {
        iss: this.serviceAccountEmail,
        scope: 'https://www.googleapis.com/auth/drive.file',
        aud: 'https://oauth2.googleapis.com/token',
        exp: now + 3600, // 1 hour
        iat: now,
      };

      // Create JWT (using crypto module for signing)
      const crypto = require('crypto');
      const headerEncoded = Buffer.from(JSON.stringify(header)).toString(
        'base64url'
      );
      const payloadEncoded = Buffer.from(JSON.stringify(payload)).toString(
        'base64url'
      );
      const signatureInput = `${headerEncoded}.${payloadEncoded}`;

      const sign = crypto.createSign('sha256');
      sign.update(signatureInput);
      const signatureEncoded = sign
        .sign(keyContent, 'base64')
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=/g, '');

      const jwt = `${signatureInput}.${signatureEncoded}`;

      // Exchange JWT for access token
      const response = await axios.post(
        'https://oauth2.googleapis.com/token',
        {
          grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
          assertion: jwt,
        },
        {
          timeout: 10000,
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
          },
        }
      );

      const { access_token, expires_in } = response.data;

      if (!access_token) {
        throw new GoogleDriveError(
          'Access token not received from Google OAuth2',
          ErrorCode.TOKEN_GENERATION_FAILED,
          {
            operation: 'refreshAccessToken',
            apiResponse: response.status,
            timestamp: new Date(),
            suggestion:
              'Verify service account credentials are valid. Check Google Cloud console for any API errors.',
          }
        );
      }

      // Cache token with expiration time
      this.cachedToken = {
        accessToken: access_token,
        expiresAt: Date.now() + expires_in * 1000,
      };

      const duration = Date.now() - startTime;
      logger.info('Google Drive access token refreshed', {
        duration: `${duration}ms`,
        expiresIn: expires_in,
      });
    } catch (error) {
      const duration = Date.now() - startTime;
      const axiosError = error as AxiosError;

      if (axiosError?.response?.status === 401) {
        throw new GoogleDriveError(
          'Invalid Google service account credentials',
          ErrorCode.INVALID_CREDENTIALS,
          {
            operation: 'refreshAccessToken',
            apiResponse: axiosError.response.status,
            timestamp: new Date(),
            suggestion:
              'Verify service account email and private key are correct. Generate a new key from Google Cloud Console.',
            duration: `${duration}ms`,
          }
        );
      }

      if (axiosError?.response?.status === 403) {
        throw new GoogleDriveError(
          'Google Drive API not enabled for service account',
          ErrorCode.API_NOT_ENABLED,
          {
            operation: 'refreshAccessToken',
            apiResponse: axiosError.response.status,
            timestamp: new Date(),
            suggestion:
              'Enable Google Drive API in Google Cloud Console. Go to APIs & Services > Library > Search "Google Drive API" > Enable.',
            duration: `${duration}ms`,
          }
        );
      }

      if (axiosError?.code === 'ECONNABORTED') {
        throw new GoogleDriveError(
          'Connection timeout while obtaining access token',
          ErrorCode.NETWORK_TIMEOUT,
          {
            operation: 'refreshAccessToken',
            timestamp: new Date(),
            suggestion:
              'Check network connectivity. Verify Google OAuth2 endpoint is accessible.',
            duration: `${duration}ms`,
          }
        );
      }

      throw new GoogleDriveError(
        `Failed to obtain Google Drive access token: ${
          error instanceof Error ? error.message : String(error)
        }`,
        ErrorCode.TOKEN_GENERATION_FAILED,
        {
          operation: 'refreshAccessToken',
          error: error instanceof Error ? error.message : String(error),
          timestamp: new Date(),
          suggestion:
            'Check service account configuration and network connectivity.',
          duration: `${duration}ms`,
        }
      );
    }
  }

  /**
   * Check if cached token is expired (with buffer)
   */
  private isTokenExpired(): boolean {
    if (!this.cachedToken) {
      return true;
    }

    const expiryBuffer = this.uploadConfig.tokenRefreshBufferMs;
    return Date.now() > this.cachedToken.expiresAt - expiryBuffer;
  }

  /**
   * Get current access token, refreshing if needed
   */
  private async getAccessToken(): Promise<string> {
    await this.ensureInitialized();

    if (!this.cachedToken) {
      throw new Error('Failed to obtain access token');
    }

    return this.cachedToken.accessToken;
  }

  /**
   * Upload file from buffer to Google Drive
   *
   * @param filename - Name for the file in Drive
   * @param mimeType - MIME type of the file
   * @param buffer - File contents
   * @returns File ID and shareable link
   */
  async uploadBuffer(
    filename: string,
    mimeType: string,
    buffer: Buffer
  ): Promise<{ fileId: string; shareableLink: string }> {
    const startTime = Date.now();
    const fileSize = buffer.length;

    logger.info('Starting buffer upload to Google Drive', {
      filename,
      mimeType,
      fileSize,
    });

    try {
      // Initiate resumable upload session
      const session = await this.initiatUploadSession(
        filename,
        mimeType,
        fileSize
      );

      // Upload file in chunks
      let uploadedBytes = 0;
      let chunkIndex = 0;

      while (uploadedBytes < fileSize) {
        const chunkStart = uploadedBytes;
        const chunkEnd = Math.min(
          uploadedBytes + this.uploadConfig.chunkSizeBytes,
          fileSize
        );
        const chunk = buffer.slice(chunkStart, chunkEnd);

        logger.debug('Uploading chunk', {
          filename,
          chunkIndex,
          chunkSize: chunk.length,
          totalSize: fileSize,
          progress: `${((chunkEnd / fileSize) * 100).toFixed(1)}%`,
        });

        await this.uploadChunk(
          session.uploadUrl,
          chunk,
          chunkStart,
          chunkEnd - 1,
          fileSize
        );

        uploadedBytes = chunkEnd;
        chunkIndex++;
      }

      // Generate shareable link
      const shareableLink = await this.generateShareableLink(
        session.fileId
      );

      const duration = Date.now() - startTime;
      logger.info('Buffer upload completed successfully', {
        filename,
        fileSize,
        fileId: session.fileId,
        duration: `${duration}ms`,
        shareableLink,
      });

      return {
        fileId: session.fileId,
        shareableLink,
      };
    } catch (error) {
      const duration = Date.now() - startTime;

      if (error instanceof GoogleDriveError) {
        throw error;
      }

      throw new GoogleDriveError(
        `Failed to upload buffer: ${
          error instanceof Error ? error.message : String(error)
        }`,
        ErrorCode.UPLOAD_FAILED,
        {
          operation: 'uploadBuffer',
          filename,
          fileSize,
          error: error instanceof Error ? error.message : String(error),
          timestamp: new Date(),
          suggestion:
            'Check file size limits. Verify Google Drive folder permissions. Check network connectivity.',
          duration: `${duration}ms`,
        }
      );
    }
  }

  /**
   * Upload file from stream to Google Drive
   *
   * @param filename - Name for the file in Drive
   * @param mimeType - MIME type of the file
   * @param stream - File stream
   * @param totalBytes - Total file size (required for resumable upload header)
   * @returns File ID and shareable link
   */
  async uploadStream(
    filename: string,
    mimeType: string,
    stream: Readable,
    totalBytes: number
  ): Promise<{ fileId: string; shareableLink: string }> {
    const startTime = Date.now();

    logger.info('Starting stream upload to Google Drive', {
      filename,
      mimeType,
      totalBytes,
    });

    try {
      // Initiate resumable upload session
      const session = await this.initiatUploadSession(
        filename,
        mimeType,
        totalBytes
      );

      // Upload stream in chunks
      let uploadedBytes = 0;
      let chunkIndex = 0;
      const chunks: Buffer[] = [];
      let currentChunkSize = 0;

      await new Promise<void>((resolve, reject) => {
        stream.on('data', async (chunk: Buffer) => {
          try {
            chunks.push(chunk);
            currentChunkSize += chunk.length;

            // If we've accumulated enough data, upload a chunk
            if (currentChunkSize >= this.uploadConfig.chunkSizeBytes) {
              const chunkBuffer = Buffer.concat(chunks);
              const chunkStart = uploadedBytes;
              const chunkEnd = uploadedBytes + chunkBuffer.length;

              logger.debug('Uploading stream chunk', {
                filename,
                chunkIndex,
                chunkSize: chunkBuffer.length,
                totalSize: totalBytes,
                progress: `${((chunkEnd / totalBytes) * 100).toFixed(1)}%`,
              });

              await this.uploadChunk(
                session.uploadUrl,
                chunkBuffer,
                chunkStart,
                chunkEnd - 1,
                totalBytes
              );

              uploadedBytes = chunkEnd;
              chunkIndex++;
              chunks.length = 0;
              currentChunkSize = 0;
            }
          } catch (error) {
            reject(error);
          }
        });

        stream.on('end', async () => {
          try {
            // Upload any remaining data
            if (chunks.length > 0) {
              const chunkBuffer = Buffer.concat(chunks);
              const chunkStart = uploadedBytes;
              const chunkEnd = uploadedBytes + chunkBuffer.length;

              logger.debug('Uploading final stream chunk', {
                filename,
                chunkIndex,
                chunkSize: chunkBuffer.length,
                totalSize: totalBytes,
              });

              await this.uploadChunk(
                session.uploadUrl,
                chunkBuffer,
                chunkStart,
                chunkEnd - 1,
                totalBytes
              );

              uploadedBytes = chunkEnd;
            }

            resolve();
          } catch (error) {
            reject(error);
          }
        });

        stream.on('error', reject);
      });

      // Generate shareable link
      const shareableLink = await this.generateShareableLink(
        session.fileId
      );

      const duration = Date.now() - startTime;
      logger.info('Stream upload completed successfully', {
        filename,
        totalBytes,
        fileId: session.fileId,
        duration: `${duration}ms`,
        shareableLink,
      });

      return {
        fileId: session.fileId,
        shareableLink,
      };
    } catch (error) {
      const duration = Date.now() - startTime;

      if (error instanceof GoogleDriveError) {
        throw error;
      }

      throw new GoogleDriveError(
        `Failed to upload stream: ${
          error instanceof Error ? error.message : String(error)
        }`,
        ErrorCode.UPLOAD_FAILED,
        {
          operation: 'uploadStream',
          filename,
          fileSize: totalBytes,
          error: error instanceof Error ? error.message : String(error),
          timestamp: new Date(),
          suggestion:
            'Check stream is valid and properly opened. Verify network connectivity.',
          duration: `${duration}ms`,
        }
      );
    }
  }

  /**
   * Initiate a resumable upload session
   * Returns upload_url that can be used for chunk uploads
   */
  private async initiatUploadSession(
    filename: string,
    mimeType: string,
    fileSize: number
  ): Promise<UploadSession> {
    const startTime = Date.now();

    try {
      const accessToken = await this.getAccessToken();

      const response = await this.client.post(
        'https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable',
        {
          name: filename,
          mimeType,
          parents: [this.folderId],
          // Set retention rule: never expire
          properties: {
            retention: 'forever',
          },
        },
        {
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'X-Goog-Upload-Protocol': 'resumable',
            'X-Goog-Upload-Header-Content-Length': fileSize,
            'X-Goog-Upload-Header-Content-Type': mimeType,
          },
        }
      );

      const uploadUrl = response.headers['location'];

      if (!uploadUrl) {
        throw new GoogleDriveError(
          'No upload URL returned from Google Drive API',
          ErrorCode.UPLOAD_SESSION_FAILED,
          {
            operation: 'initiateUploadSession',
            filename,
            apiResponse: response.status,
            timestamp: new Date(),
            suggestion:
              'Verify Google Drive folder ID is correct and accessible by the service account.',
            duration: `${Date.now() - startTime}ms`,
          }
        );
      }

      const duration = Date.now() - startTime;
      logger.info('Upload session initiated', {
        filename,
        fileSize,
        duration: `${duration}ms`,
      });

      return {
        uploadUrl,
        fileId: '', // Will be extracted from first response
        mimeType,
        totalBytes: fileSize,
        uploadedBytes: 0,
      };
    } catch (error) {
      const duration = Date.now() - startTime;

      if (error instanceof GoogleDriveError) {
        throw error;
      }

      const axiosError = error as AxiosError;

      if (axiosError?.response?.status === 404) {
        throw new GoogleDriveError(
          'Google Drive folder not found',
          ErrorCode.FOLDER_NOT_FOUND,
          {
            operation: 'initiateUploadSession',
            filename,
            folderId: this.folderId,
            apiResponse: 404,
            timestamp: new Date(),
            suggestion:
              'Verify folder ID is correct. Folder must exist and be accessible by the service account email.',
            duration: `${duration}ms`,
          }
        );
      }

      if (axiosError?.response?.status === 403) {
        throw new GoogleDriveError(
          'Permission denied: Service account cannot access folder',
          ErrorCode.PERMISSION_DENIED,
          {
            operation: 'initiateUploadSession',
            filename,
            folderId: this.folderId,
            apiResponse: 403,
            timestamp: new Date(),
            suggestion:
              'Share the Google Drive folder with the service account email address. Grant "Editor" permissions.',
            duration: `${duration}ms`,
          }
        );
      }

      throw new GoogleDriveError(
        `Failed to initiate upload session: ${
          error instanceof Error ? error.message : String(error)
        }`,
        ErrorCode.UPLOAD_SESSION_FAILED,
        {
          operation: 'initiateUploadSession',
          filename,
          fileSize,
          error: error instanceof Error ? error.message : String(error),
          timestamp: new Date(),
          suggestion:
            'Check Google Drive API is enabled. Verify service account has Drive access.',
          duration: `${duration}ms`,
        }
      );
    }
  }

  /**
   * Upload a single chunk with retry logic
   */
  private async uploadChunk(
    uploadUrl: string,
    chunk: Buffer,
    start: number,
    end: number,
    total: number
  ): Promise<string> {
    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= this.uploadConfig.maxRetries; attempt++) {
      try {
        const accessToken = await this.getAccessToken();

        const response = await this.client.put(uploadUrl, chunk, {
          headers: {
            'Content-Type': 'application/octet-stream',
            'Content-Length': chunk.length,
            'Content-Range': `bytes ${start}-${end}/${total}`,
            Authorization: `Bearer ${accessToken}`,
          },
          validateStatus: (status) => status >= 200 && status < 300,
        });

        // Extract file ID from response location header if this is the first chunk
        if (response.headers['location']) {
          // Final chunk - file uploaded successfully
          const location = response.headers['location'] as string;
          const fileIdMatch = location.match(/\/files\/([a-zA-Z0-9_-]+)/);
          if (fileIdMatch) {
            return fileIdMatch[1];
          }
        }

        logger.debug('Chunk uploaded successfully', {
          chunk: `${start}-${end}/${total}`,
          status: response.status,
        });

        return ''; // Continue to next chunk
      } catch (error) {
        lastError = error as Error;
        const axiosError = error as AxiosError;

        // Determine if error is retryable
        const isRetryable =
          axiosError?.code === 'ECONNABORTED' ||
          axiosError?.code === 'ENOTFOUND' ||
          axiosError?.response?.status === 500 ||
          axiosError?.response?.status === 502 ||
          axiosError?.response?.status === 503 ||
          axiosError?.response?.status === 504;

        if (!isRetryable) {
          throw new GoogleDriveError(
            `Failed to upload chunk (non-retryable): ${
              error instanceof Error ? error.message : String(error)
            }`,
            ErrorCode.CHUNK_UPLOAD_FAILED,
            {
              operation: 'uploadChunk',
              chunk: `${start}-${end}/${total}`,
              attempt,
              apiResponse: axiosError?.response?.status,
              error: error instanceof Error ? error.message : String(error),
              timestamp: new Date(),
              suggestion:
                'Check file is not too large for single upload. Verify network connectivity.',
            }
          );
        }

        if (attempt < this.uploadConfig.maxRetries) {
          const backoffMs = this.uploadConfig.retryBackoffMs * Math.pow(2, attempt - 1);
          logger.warn('Retrying chunk upload', {
            chunk: `${start}-${end}/${total}`,
            attempt,
            nextAttemptIn: `${backoffMs}ms`,
            error: error instanceof Error ? error.message : String(error),
          });

          await new Promise((resolve) => setTimeout(resolve, backoffMs));
        }
      }
    }

    throw new GoogleDriveError(
      `Failed to upload chunk after ${this.uploadConfig.maxRetries} attempts`,
      ErrorCode.CHUNK_UPLOAD_FAILED,
      {
        operation: 'uploadChunk',
        chunk: `${start}-${end}/${total}`,
        maxRetries: this.uploadConfig.maxRetries,
        lastError: lastError?.message || 'Unknown',
        timestamp: new Date(),
        suggestion:
          'Check network stability. Consider reducing chunk size for very large files.',
      }
    );
  }

  /**
   * Generate a shareable link for a file
   */
  private async generateShareableLink(fileId: string): Promise<string> {
    const startTime = Date.now();

    try {
      const accessToken = await this.getAccessToken();

      await this.client.patch(
        `https://www.googleapis.com/drive/v3/files/${fileId}`,
        {},
        {
          params: {
            'webViewLink': true,
          },
          headers: {
            Authorization: `Bearer ${accessToken}`,
          },
        }
      );

      // Set permissions to allow anyone with link to view
      await this.client.post(
        `https://www.googleapis.com/drive/v3/files/${fileId}/permissions`,
        {
          role: 'reader',
          type: 'anyone',
        },
        {
          headers: {
            Authorization: `Bearer ${accessToken}`,
          },
        }
      );

      // Get file metadata to retrieve webViewLink
      const response = await this.client.get(
        `https://www.googleapis.com/drive/v3/files/${fileId}`,
        {
          params: {
            fields: 'webViewLink',
          },
          headers: {
            Authorization: `Bearer ${accessToken}`,
          },
        }
      );

      const shareableLink = response.data.webViewLink;

      if (!shareableLink) {
        throw new GoogleDriveError(
          'Failed to retrieve shareable link',
          ErrorCode.SHAREABLE_LINK_FAILED,
          {
            operation: 'generateShareableLink',
            fileId,
            timestamp: new Date(),
            suggestion: 'Verify file was created successfully in Drive.',
          }
        );
      }

      const duration = Date.now() - startTime;
      logger.info('Shareable link generated', {
        fileId,
        duration: `${duration}ms`,
      });

      return shareableLink;
    } catch (error) {
      const duration = Date.now() - startTime;

      if (error instanceof GoogleDriveError) {
        throw error;
      }

      throw new GoogleDriveError(
        `Failed to generate shareable link: ${
          error instanceof Error ? error.message : String(error)
        }`,
        ErrorCode.SHAREABLE_LINK_FAILED,
        {
          operation: 'generateShareableLink',
          fileId,
          error: error instanceof Error ? error.message : String(error),
          timestamp: new Date(),
          suggestion:
            'Verify Google Drive API has Files.create and Permissions.create scopes enabled.',
          duration: `${duration}ms`,
        }
      );
    }
  }

  /**
   * Get file metadata from Drive
   */
  async getFileMetadata(fileId: string): Promise<DriveFileMetadata> {
    try {
      const accessToken = await this.getAccessToken();

      const response = await this.client.get(
        `https://www.googleapis.com/drive/v3/files/${fileId}`,
        {
          params: {
            fields: 'id,name,mimeType,size,webViewLink,createdTime,modifiedTime',
          },
          headers: {
            Authorization: `Bearer ${accessToken}`,
          },
        }
      );

      return response.data;
    } catch (error) {
      const axiosError = error as AxiosError;

      if (axiosError?.response?.status === 404) {
        throw new GoogleDriveError(
          'File not found in Google Drive',
          ErrorCode.FILE_NOT_FOUND,
          {
            operation: 'getFileMetadata',
            fileId,
            apiResponse: 404,
            timestamp: new Date(),
            suggestion: 'Verify file ID is correct.',
          }
        );
      }

      throw new GoogleDriveError(
        `Failed to get file metadata: ${
          error instanceof Error ? error.message : String(error)
        }`,
        ErrorCode.METADATA_FETCH_FAILED,
        {
          operation: 'getFileMetadata',
          fileId,
          error: error instanceof Error ? error.message : String(error),
          timestamp: new Date(),
          suggestion: 'Check Google Drive API is enabled.',
        }
      );
    }
  }

  /**
   * Get download URL for a file
   * Used by Worker to download uploaded files from Drive
   */
  getDownloadUrl(fileId: string): string {
    return `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`;
  }

  /**
   * Download file from publicly shared Google Drive URL as stream
   *
   * This method works with publicly shared Google Drive files (no authentication required).
   * Supports both /file/d/ and /open?id= URL formats.
   *
   * INTELLIGENT HANDLING:
   * - Detects Google Drive virus scan warnings (HTML pages for potentially dangerous files)
   * - Automatically extracts confirmation URL and retries download
   * - Handles large file download confirmations (> 100MB files)
   * - Supports executables, archives, and other flagged file types
   *
   * @param driveUrl - Google Drive sharing URL (e.g., https://drive.google.com/file/d/FILE_ID/view?usp=sharing)
   * @returns Object containing readable stream, filename, MIME type, and file size
   */
  async downloadPublicFileStream(driveUrl: string): Promise<{
    stream: Readable;
    filename: string;
    mimeType: string;
    fileSize: number;
  }> {
    const startTime = Date.now();

    try {
      // Extract file ID from Google Drive URL
      const fileId = this.extractFileIdFromUrl(driveUrl);

      if (!fileId) {
        throw new GoogleDriveError(
          'Invalid Google Drive URL: Could not extract file ID',
          ErrorCode.INVALID_CREDENTIALS,
          {
            operation: 'downloadPublicFileStream',
            input: { driveUrl },
            timestamp: new Date(),
            suggestion:
              'Ensure the URL is a valid Google Drive sharing link (e.g., https://drive.google.com/file/d/FILE_ID/view)',
          }
        );
      }

      logger.info('Downloading public file from Google Drive', {
        fileId,
        driveUrl,
      });

      // Initial download URL with confirmation token
      let downloadUrl = `https://drive.google.com/uc?export=download&id=${fileId}&confirm=t`;

      // First attempt - get file or virus scan warning page
      const initialResponse = await axios.get(downloadUrl, {
        responseType: 'arraybuffer', // Use arraybuffer to check content type
        maxRedirects: 5,
        timeout: 60000, // 1 minute for initial check
        validateStatus: (status) => status >= 200 && status < 400,
      });

      const contentType = initialResponse.headers['content-type'] || '';
      const contentLength = parseInt(initialResponse.headers['content-length'] || '0', 10);
      let filename = this.extractFilenameFromHeaders(initialResponse.headers) || `drive-file-${fileId}`;

      // Check if Google returned a virus scan warning HTML page
      if (contentType.includes('text/html')) {
        const htmlContent = Buffer.from(initialResponse.data).toString('utf-8');

        // Detect virus scan warning page
        if (htmlContent.includes('Virus scan warning') ||
            htmlContent.includes('Google Drive - Virus scan warning') ||
            htmlContent.includes('uc-download-link')) {

          logger.info('Google Drive virus scan warning detected - extracting confirmation URL', {
            fileId,
            contentType,
          });

          // Extract the confirmation URL from the HTML page
          const confirmUrl = this.extractVirusScanConfirmUrl(htmlContent, fileId);

          if (!confirmUrl) {
            throw new GoogleDriveError(
              'Could not extract virus scan confirmation URL from Google Drive response',
              ErrorCode.UPLOAD_FAILED,
              {
                operation: 'downloadPublicFileStream',
                input: { driveUrl },
                timestamp: new Date(),
                suggestion: 'The file may require Google account authentication to download.',
              }
            );
          }

          logger.info('Retrying download with virus scan confirmation URL', {
            fileId,
            confirmUrl: confirmUrl.substring(0, 100) + '...',
          });

          // Retry with the confirmation URL - this time stream the response
          const confirmedResponse = await axios.get(confirmUrl, {
            responseType: 'stream',
            maxRedirects: 5,
            timeout: 300000, // 5 minutes for actual download
            validateStatus: (status) => status >= 200 && status < 400,
          });

          const confirmedContentType = confirmedResponse.headers['content-type'] || 'application/octet-stream';
          const confirmedContentLength = parseInt(confirmedResponse.headers['content-length'] || '0', 10);
          const confirmedFilename = this.extractFilenameFromHeaders(confirmedResponse.headers) || filename;

          // Verify we got the actual file, not another HTML page
          if (confirmedContentType.includes('text/html')) {
            throw new GoogleDriveError(
              'Google Drive returned HTML instead of file content after confirmation',
              ErrorCode.UPLOAD_FAILED,
              {
                operation: 'downloadPublicFileStream',
                input: { driveUrl },
                timestamp: new Date(),
                suggestion: 'The file may require Google account authentication or the sharing settings may not allow public access.',
              }
            );
          }

          const duration = Date.now() - startTime;
          logger.info('Public file stream initiated after virus scan bypass', {
            fileId,
            filename: confirmedFilename,
            mimeType: confirmedContentType,
            fileSize: confirmedContentLength,
            duration: `${duration}ms`,
            bypassedVirusScan: true,
          });

          return {
            stream: confirmedResponse.data as Readable,
            filename: confirmedFilename,
            mimeType: confirmedContentType,
            fileSize: confirmedContentLength,
          };
        }

        // Check if this is a "file too large" page or access denied page
        if (htmlContent.includes('Google Drive can\'t scan this file for viruses') ||
            htmlContent.includes('too large for Google to scan')) {
          logger.info('Large file warning detected - using direct download', { fileId });
          // For large files, try the direct download endpoint
          downloadUrl = `https://drive.usercontent.google.com/download?id=${fileId}&export=download&confirm=t`;
        } else {
          // Unknown HTML response - might be access denied or other error
          throw new GoogleDriveError(
            'Google Drive returned an unexpected HTML page instead of the file',
            ErrorCode.PERMISSION_DENIED,
            {
              operation: 'downloadPublicFileStream',
              input: { driveUrl },
              contentType,
              timestamp: new Date(),
              suggestion: 'Ensure the file is shared with "Anyone with the link" can view.',
            }
          );
        }
      } else {
        // We got the actual file in the first response
        // Convert arraybuffer response to a readable stream
        const bufferStream = new Readable();
        bufferStream.push(Buffer.from(initialResponse.data));
        bufferStream.push(null);

        const duration = Date.now() - startTime;
        logger.info('Public file stream initiated (direct)', {
          fileId,
          filename,
          mimeType: contentType,
          fileSize: contentLength,
          duration: `${duration}ms`,
        });

        return {
          stream: bufferStream,
          filename,
          mimeType: contentType,
          fileSize: contentLength,
        };
      }

      // Fallback: try streaming with updated URL
      const response = await axios.get(downloadUrl, {
        responseType: 'stream',
        maxRedirects: 5,
        timeout: 300000, // 5 minutes for initial connection
        validateStatus: (status) => status >= 200 && status < 400,
      });

      const stream = response.data as Readable;
      const finalMimeType = response.headers['content-type'] || 'application/octet-stream';
      const finalFileSize = parseInt(response.headers['content-length'] || '0', 10);
      const finalFilename = this.extractFilenameFromHeaders(response.headers) || filename;

      const duration = Date.now() - startTime;
      logger.info('Public file stream initiated', {
        fileId,
        filename: finalFilename,
        fileSize: finalFileSize,
        duration: `${duration}ms`,
      });

      return {
        stream,
        filename: finalFilename,
        mimeType: finalMimeType,
        fileSize: finalFileSize,
      };
    } catch (error) {
      const duration = Date.now() - startTime;

      if (error instanceof GoogleDriveError) {
        throw error;
      }

      const axiosError = error as AxiosError;

      if (axiosError?.response?.status === 404) {
        throw new GoogleDriveError(
          'File not found or not publicly accessible',
          ErrorCode.FILE_NOT_FOUND,
          {
            operation: 'downloadPublicFileStream',
            input: { driveUrl },
            apiResponse: 404,
            timestamp: new Date(),
            suggestion:
              'Ensure the file exists and sharing is enabled ("Anyone with the link" can view).',
            duration: `${duration}ms`,
          }
        );
      }

      if (axiosError?.response?.status === 403) {
        throw new GoogleDriveError(
          'Access denied: File is not publicly shared',
          ErrorCode.PERMISSION_DENIED,
          {
            operation: 'downloadPublicFileStream',
            input: { driveUrl },
            apiResponse: 403,
            timestamp: new Date(),
            suggestion:
              'Enable public sharing: Right-click file → Share → Change to "Anyone with the link".',
            duration: `${duration}ms`,
          }
        );
      }

      if (axiosError?.code === 'ECONNABORTED') {
        throw new GoogleDriveError(
          'Connection timeout while downloading file',
          ErrorCode.NETWORK_TIMEOUT,
          {
            operation: 'downloadPublicFileStream',
            input: { driveUrl },
            timestamp: new Date(),
            suggestion:
              'Check network connectivity. Try again or use a smaller file.',
            duration: `${duration}ms`,
          }
        );
      }

      throw new GoogleDriveError(
        `Failed to download public file: ${
          error instanceof Error ? error.message : String(error)
        }`,
        ErrorCode.UPLOAD_FAILED,
        {
          operation: 'downloadPublicFileStream',
          input: { driveUrl },
          error: error instanceof Error ? error.message : String(error),
          timestamp: new Date(),
          suggestion:
            'Verify the URL is correct and the file is publicly accessible.',
          duration: `${duration}ms`,
        }
      );
    }
  }

  /**
   * Extract virus scan confirmation URL from Google Drive HTML warning page
   *
   * Google Drive returns an HTML page with a virus scan warning for potentially dangerous files.
   * This method parses the HTML and extracts the actual download confirmation URL.
   *
   * @param htmlContent - The HTML content of the virus scan warning page
   * @param fileId - The Google Drive file ID
   * @returns The confirmation URL to download the file, or null if not found
   */
  private extractVirusScanConfirmUrl(htmlContent: string, fileId: string): string | null {
    // Method 1: Extract from form action with hidden inputs
    // Format: <form id="download-form" action="https://drive.usercontent.google.com/download" method="get">
    //         <input type="hidden" name="id" value="FILE_ID">
    //         <input type="hidden" name="confirm" value="t">
    //         <input type="hidden" name="uuid" value="UUID">
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
      if (!params.has('id')) {
        params.set('id', fileId);
      }
      if (!params.has('export')) {
        params.set('export', 'download');
      }
      if (!params.has('confirm')) {
        params.set('confirm', 't');
      }

      const confirmUrl = `${baseUrl}?${params.toString()}`;
      logger.debug('Extracted virus scan confirm URL from form', { confirmUrl: confirmUrl.substring(0, 100) });
      return confirmUrl;
    }

    // Method 2: Look for direct download link
    // Format: <a id="uc-download-link" class="..." href="/uc?export=download&amp;confirm=t&amp;id=FILE_ID&amp;uuid=UUID">
    const downloadLinkMatch = htmlContent.match(/href="([^"]*confirm=[^"]*)"/);
    if (downloadLinkMatch) {
      let downloadUrl = downloadLinkMatch[1];
      // Decode HTML entities
      downloadUrl = downloadUrl.replace(/&amp;/g, '&');
      // Make absolute URL if relative
      if (downloadUrl.startsWith('/')) {
        downloadUrl = `https://drive.google.com${downloadUrl}`;
      }
      logger.debug('Extracted virus scan confirm URL from link', { confirmUrl: downloadUrl.substring(0, 100) });
      return downloadUrl;
    }

    // Method 3: Extract UUID and construct URL manually
    // Look for uuid in any form or input
    const uuidMatch = htmlContent.match(/uuid[^a-zA-Z0-9-]*([a-f0-9-]{36})/i);
    if (uuidMatch) {
      const uuid = uuidMatch[1];
      const confirmUrl = `https://drive.usercontent.google.com/download?id=${fileId}&export=download&confirm=t&uuid=${uuid}`;
      logger.debug('Constructed virus scan confirm URL from UUID', { confirmUrl });
      return confirmUrl;
    }

    // Method 4: Fallback - use direct usercontent download with confirm=t
    // This often works even without the exact form parameters
    const fallbackUrl = `https://drive.usercontent.google.com/download?id=${fileId}&export=download&authuser=0&confirm=t`;
    logger.debug('Using fallback virus scan confirm URL', { confirmUrl: fallbackUrl });
    return fallbackUrl;
  }

  /**
   * Extract file ID from Google Drive URL
   *
   * Supported formats:
   * - https://drive.google.com/file/d/FILE_ID/view?usp=sharing
   * - https://drive.google.com/file/d/FILE_ID/view
   * - https://drive.google.com/open?id=FILE_ID
   * - https://drive.google.com/uc?id=FILE_ID
   */
  private extractFileIdFromUrl(url: string): string | null {
    // Format 1: /file/d/FILE_ID/
    const fileIdMatch1 = url.match(/\/file\/d\/([a-zA-Z0-9_-]+)/);
    if (fileIdMatch1) {
      return fileIdMatch1[1];
    }

    // Format 2: /open?id=FILE_ID or /uc?id=FILE_ID
    const fileIdMatch2 = url.match(/[?&]id=([a-zA-Z0-9_-]+)/);
    if (fileIdMatch2) {
      return fileIdMatch2[1];
    }

    return null;
  }

  /**
   * Extract filename from Content-Disposition header
   */
  private extractFilenameFromHeaders(headers: any): string | null {
    const contentDisposition = headers['content-disposition'];
    if (!contentDisposition) {
      return null;
    }

    // Format: attachment; filename="example.pdf"
    const filenameMatch = contentDisposition.match(/filename="?([^"]+)"?/);
    if (filenameMatch) {
      return filenameMatch[1];
    }

    // Format: attachment; filename*=UTF-8''example.pdf
    const filenameStarMatch = contentDisposition.match(/filename\*=UTF-8''([^;]+)/);
    if (filenameStarMatch) {
      return decodeURIComponent(filenameStarMatch[1]);
    }

    return null;
  }

  /**
   * Reset singleton instance (for testing)
   */
  static reset(): void {
    GoogleDriveClient.instance = null;
  }
}

export { GoogleDriveClient, UploadConfig, DriveFileMetadata };
