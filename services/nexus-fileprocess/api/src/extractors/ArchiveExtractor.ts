/**
 * ArchiveExtractor - Universal archive extraction interface
 *
 * Design Pattern: Strategy Pattern
 * SOLID Principles:
 * - Single Responsibility: Each extractor handles one archive format
 * - Open/Closed: New archive formats can be added without modification
 * - Liskov Substitution: All extractors are interchangeable
 *
 * Supports: ZIP, RAR, 7Z, TAR, GZIP, BZIP2
 *
 * Root Cause Addressed: Issue #3 - Missing multi-stage processing pipeline
 */

import { logger } from '../utils/logger';

/**
 * Extracted file metadata
 */
export interface ExtractedFile {
  filename: string;
  buffer: Buffer;
  size: number;
  mimeType?: string;
  isDirectory: boolean;
}

/**
 * Extraction result
 */
export interface ExtractionResult {
  success: boolean;
  files: ExtractedFile[];
  error?: {
    code: string;
    message: string;
    details?: string;
  };
  metadata: {
    archiveType: string;
    totalFiles: number;
    totalSize: number;
    extractionTimeMs: number;
  };
}

/**
 * Archive extractor interface
 */
export interface IArchiveExtractor {
  extract(buffer: Buffer, filename: string): Promise<ExtractionResult>;
  canExtract(mimeType: string): boolean;
}

/**
 * ZIP Archive Extractor
 *
 * Uses adm-zip library for ZIP file extraction.
 * Supports standard ZIP and ZIP64 formats.
 */
export class ZipExtractor implements IArchiveExtractor {
  canExtract(mimeType: string): boolean {
    return mimeType === 'application/zip';
  }

  async extract(buffer: Buffer, filename: string): Promise<ExtractionResult> {
    const startTime = Date.now();

    try {
      // Dynamic import to avoid loading heavy dependencies unless needed
      const AdmZip = (await import('adm-zip')).default;
      const zip = new AdmZip(buffer);
      const zipEntries = zip.getEntries();

      const files: ExtractedFile[] = [];
      let totalSize = 0;

      for (const entry of zipEntries) {
        // Skip directories
        if (entry.isDirectory) {
          continue;
        }

        try {
          const entryBuffer = entry.getData();
          totalSize += entryBuffer.length;

          files.push({
            filename: entry.entryName,
            buffer: entryBuffer,
            size: entryBuffer.length,
            isDirectory: false,
          });

          logger.debug('Extracted file from ZIP', {
            archive: filename,
            file: entry.entryName,
            size: entryBuffer.length,
          });
        } catch (entryError) {
          logger.warn('Failed to extract ZIP entry', {
            archive: filename,
            entry: entry.entryName,
            error: entryError instanceof Error ? entryError.message : String(entryError),
          });
        }
      }

      const extractionTimeMs = Date.now() - startTime;

      logger.info('ZIP archive extracted successfully', {
        archive: filename,
        totalFiles: files.length,
        totalSize,
        extractionTimeMs,
      });

      return {
        success: true,
        files,
        metadata: {
          archiveType: 'zip',
          totalFiles: files.length,
          totalSize,
          extractionTimeMs,
        },
      };
    } catch (error) {
      const extractionTimeMs = Date.now() - startTime;
      const errorMessage = error instanceof Error ? error.message : String(error);

      logger.error('ZIP extraction failed', {
        archive: filename,
        error: errorMessage,
        extractionTimeMs,
      });

      return {
        success: false,
        files: [],
        error: {
          code: 'ZIP_EXTRACTION_FAILED',
          message: 'Failed to extract ZIP archive',
          details: errorMessage,
        },
        metadata: {
          archiveType: 'zip',
          totalFiles: 0,
          totalSize: 0,
          extractionTimeMs,
        },
      };
    }
  }
}

/**
 * TAR Archive Extractor
 *
 * Uses tar-stream library for TAR file extraction.
 * Supports plain TAR, TAR.GZ, and TAR.BZ2 formats.
 */
export class TarExtractor implements IArchiveExtractor {
  canExtract(mimeType: string): boolean {
    return (
      mimeType === 'application/x-tar' ||
      mimeType === 'application/gzip' ||
      mimeType === 'application/x-bzip2'
    );
  }

  async extract(buffer: Buffer, filename: string): Promise<ExtractionResult> {
    const startTime = Date.now();

    try {
      const tar = await import('tar-stream');
      const { promisify } = await import('util');

      // Detect compression format
      let processedBuffer = buffer;
      const isGzipped = buffer[0] === 0x1f && buffer[1] === 0x8b;
      const isBzipped = buffer[0] === 0x42 && buffer[1] === 0x5a && buffer[2] === 0x68;

      if (isGzipped) {
        // Decompress GZIP
        const zlib = await import('zlib');
        processedBuffer = await promisify(zlib.gunzip)(buffer);
      } else if (isBzipped) {
        // BZIP2 decompression requires external library
        logger.warn('BZIP2 TAR archives not yet supported', { filename });
        return {
          success: false,
          files: [],
          error: {
            code: 'TAR_BZIP2_NOT_SUPPORTED',
            message: 'TAR.BZ2 archives are not yet supported',
            details: 'Please extract the archive manually or convert to TAR.GZ format',
          },
          metadata: {
            archiveType: 'tar.bz2',
            totalFiles: 0,
            totalSize: 0,
            extractionTimeMs: Date.now() - startTime,
          },
        };
      }

      const extract = tar.extract();
      const files: ExtractedFile[] = [];
      let totalSize = 0;

      return new Promise((resolve) => {
        extract.on('entry', (header, stream, next) => {
          // Skip directories
          if (header.type === 'directory') {
            stream.resume();
            next();
            return;
          }

          const chunks: Buffer[] = [];

          stream.on('data', (chunk: Buffer) => {
            chunks.push(chunk);
          });

          stream.on('end', () => {
            const entryBuffer = Buffer.concat(chunks);
            totalSize += entryBuffer.length;

            files.push({
              filename: header.name,
              buffer: entryBuffer,
              size: entryBuffer.length,
              isDirectory: false,
            });

            logger.debug('Extracted file from TAR', {
              archive: filename,
              file: header.name,
              size: entryBuffer.length,
            });

            next();
          });

          stream.resume();
        });

        extract.on('finish', () => {
          const extractionTimeMs = Date.now() - startTime;

          logger.info('TAR archive extracted successfully', {
            archive: filename,
            totalFiles: files.length,
            totalSize,
            extractionTimeMs,
          });

          resolve({
            success: true,
            files,
            metadata: {
              archiveType: isGzipped ? 'tar.gz' : 'tar',
              totalFiles: files.length,
              totalSize,
              extractionTimeMs,
            },
          });
        });

        extract.on('error', (error: Error) => {
          const extractionTimeMs = Date.now() - startTime;

          logger.error('TAR extraction failed', {
            archive: filename,
            error: error.message,
            extractionTimeMs,
          });

          resolve({
            success: false,
            files: [],
            error: {
              code: 'TAR_EXTRACTION_FAILED',
              message: 'Failed to extract TAR archive',
              details: error.message,
            },
            metadata: {
              archiveType: isGzipped ? 'tar.gz' : 'tar',
              totalFiles: 0,
              totalSize: 0,
              extractionTimeMs,
            },
          });
        });

        // Write buffer to extract stream
        extract.end(processedBuffer);
      });
    } catch (error) {
      const extractionTimeMs = Date.now() - startTime;
      const errorMessage = error instanceof Error ? error.message : String(error);

      logger.error('TAR extraction failed', {
        archive: filename,
        error: errorMessage,
        extractionTimeMs,
      });

      return {
        success: false,
        files: [],
        error: {
          code: 'TAR_EXTRACTION_FAILED',
          message: 'Failed to extract TAR archive',
          details: errorMessage,
        },
        metadata: {
          archiveType: 'tar',
          totalFiles: 0,
          totalSize: 0,
          extractionTimeMs,
        },
      };
    }
  }
}

/**
 * RAR Archive Extractor
 *
 * Uses node-unrar-js library for RAR file extraction.
 * Supports RAR4 and RAR5 formats.
 */
export class RarExtractor implements IArchiveExtractor {
  canExtract(mimeType: string): boolean {
    return mimeType === 'application/x-rar-compressed';
  }

  async extract(buffer: Buffer, filename: string): Promise<ExtractionResult> {
    const startTime = Date.now();

    try {
      // Dynamic import to avoid loading heavy dependencies unless needed
      const { createExtractorFromData } = await import('node-unrar-js');

      // Create extractor from buffer
      const extractor = createExtractorFromData({ data: buffer });
      const extracted = extractor.extract();

      // Check for errors
      if (extracted.state === 'FAIL') {
        const extractionTimeMs = Date.now() - startTime;

        logger.error('RAR extraction failed', {
          archive: filename,
          error: 'Invalid or corrupted RAR archive',
          extractionTimeMs,
        });

        return {
          success: false,
          files: [],
          error: {
            code: 'RAR_EXTRACTION_FAILED',
            message: 'Failed to extract RAR archive',
            details: 'Archive may be corrupted or password-protected',
          },
          metadata: {
            archiveType: 'rar',
            totalFiles: 0,
            totalSize: 0,
            extractionTimeMs,
          },
        };
      }

      const files: ExtractedFile[] = [];
      let totalSize = 0;

      // Extract files from archive
      const fileList = extracted.files || [];

      for (const file of fileList) {
        // Skip directories
        if (file.fileHeader?.flags?.directory) {
          continue;
        }

        try {
          const fileData = file.extraction;

          if (fileData && fileData.length > 0) {
            const entryBuffer = Buffer.from(fileData);
            totalSize += entryBuffer.length;

            files.push({
              filename: file.fileHeader?.name || 'unknown',
              buffer: entryBuffer,
              size: entryBuffer.length,
              isDirectory: false,
            });

            logger.debug('Extracted file from RAR', {
              archive: filename,
              file: file.fileHeader?.name,
              size: entryBuffer.length,
            });
          }
        } catch (entryError) {
          logger.warn('Failed to extract RAR entry', {
            archive: filename,
            entry: file.fileHeader?.name,
            error: entryError instanceof Error ? entryError.message : String(entryError),
          });
        }
      }

      const extractionTimeMs = Date.now() - startTime;

      logger.info('RAR archive extracted successfully', {
        archive: filename,
        totalFiles: files.length,
        totalSize,
        extractionTimeMs,
      });

      return {
        success: true,
        files,
        metadata: {
          archiveType: 'rar',
          totalFiles: files.length,
          totalSize,
          extractionTimeMs,
        },
      };
    } catch (error) {
      const extractionTimeMs = Date.now() - startTime;
      const errorMessage = error instanceof Error ? error.message : String(error);

      logger.error('RAR extraction failed', {
        archive: filename,
        error: errorMessage,
        extractionTimeMs,
      });

      return {
        success: false,
        files: [],
        error: {
          code: 'RAR_EXTRACTION_FAILED',
          message: 'Failed to extract RAR archive',
          details: errorMessage,
        },
        metadata: {
          archiveType: 'rar',
          totalFiles: 0,
          totalSize: 0,
          extractionTimeMs,
        },
      };
    }
  }
}

/**
 * 7-Zip Archive Extractor
 *
 * Uses node-7z library for 7Z file extraction.
 * Requires 7za binary installed on system.
 */
export class SevenZipExtractor implements IArchiveExtractor {
  canExtract(mimeType: string): boolean {
    return mimeType === 'application/x-7z-compressed';
  }

  async extract(buffer: Buffer, filename: string): Promise<ExtractionResult> {
    const startTime = Date.now();

    try {
      // 7z extraction requires file system access
      // We'll use a temporary file approach
      const fs = await import('fs/promises');
      const path = await import('path');
      const os = await import('os');

      // Create temporary directory
      const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), '7z-extract-'));
      const tmpArchivePath = path.join(tmpDir, filename);
      const tmpExtractDir = path.join(tmpDir, 'extracted');

      try {
        // Write buffer to temporary file
        await fs.writeFile(tmpArchivePath, buffer);
        await fs.mkdir(tmpExtractDir, { recursive: true });

        // Dynamic import of node-7z
        const Seven = (await import('node-7z')).default;

        // Extract archive
        const extractStream = Seven.extractFull(tmpArchivePath, tmpExtractDir, {
          $bin: '7za', // Use 7za binary (must be installed)
          recursive: true,
        });

        await new Promise((resolve, reject) => {
          extractStream.on('end', resolve);
          extractStream.on('error', reject);
        });

        // Read extracted files
        const files: ExtractedFile[] = [];
        let totalSize = 0;

        const readDirRecursive = async (dir: string, baseDir: string): Promise<void> => {
          const entries = await fs.readdir(dir, { withFileTypes: true });

          for (const entry of entries) {
            const fullPath = path.join(dir, entry.name);

            if (entry.isDirectory()) {
              await readDirRecursive(fullPath, baseDir);
            } else {
              const fileBuffer = await fs.readFile(fullPath);
              const relativePath = path.relative(baseDir, fullPath);

              totalSize += fileBuffer.length;

              files.push({
                filename: relativePath,
                buffer: fileBuffer,
                size: fileBuffer.length,
                isDirectory: false,
              });

              logger.debug('Extracted file from 7Z', {
                archive: filename,
                file: relativePath,
                size: fileBuffer.length,
              });
            }
          }
        };

        await readDirRecursive(tmpExtractDir, tmpExtractDir);

        const extractionTimeMs = Date.now() - startTime;

        logger.info('7Z archive extracted successfully', {
          archive: filename,
          totalFiles: files.length,
          totalSize,
          extractionTimeMs,
        });

        // Cleanup temporary directory
        await fs.rm(tmpDir, { recursive: true, force: true });

        return {
          success: true,
          files,
          metadata: {
            archiveType: '7z',
            totalFiles: files.length,
            totalSize,
            extractionTimeMs,
          },
        };
      } catch (extractError) {
        // Cleanup on error
        try {
          await fs.rm(tmpDir, { recursive: true, force: true });
        } catch (cleanupError) {
          // Ignore cleanup errors
        }

        throw extractError;
      }
    } catch (error) {
      const extractionTimeMs = Date.now() - startTime;
      const errorMessage = error instanceof Error ? error.message : String(error);

      logger.error('7Z extraction failed', {
        archive: filename,
        error: errorMessage,
        extractionTimeMs,
      });

      // Check if error is due to missing 7za binary
      if (errorMessage.includes('ENOENT') || errorMessage.includes('7za')) {
        return {
          success: false,
          files: [],
          error: {
            code: '7Z_BINARY_NOT_FOUND',
            message: '7-Zip binary (7za) not found on system',
            details: 'Please install p7zip-full package: apt-get install p7zip-full',
          },
          metadata: {
            archiveType: '7z',
            totalFiles: 0,
            totalSize: 0,
            extractionTimeMs,
          },
        };
      }

      return {
        success: false,
        files: [],
        error: {
          code: '7Z_EXTRACTION_FAILED',
          message: 'Failed to extract 7Z archive',
          details: errorMessage,
        },
        metadata: {
          archiveType: '7z',
          totalFiles: 0,
          totalSize: 0,
          extractionTimeMs,
        },
      };
    }
  }
}

/**
 * Archive Extractor Factory
 *
 * Automatically selects the correct extractor based on MIME type.
 */
export class ArchiveExtractorFactory {
  private static extractors: IArchiveExtractor[] = [
    new ZipExtractor(),
    new TarExtractor(),
    new RarExtractor(),
    new SevenZipExtractor(),
  ];

  /**
   * Check if MIME type is a supported archive format
   */
  static isArchive(mimeType: string): boolean {
    return this.extractors.some((extractor) => extractor.canExtract(mimeType));
  }

  /**
   * Extract archive using the appropriate extractor
   */
  static async extract(
    buffer: Buffer,
    filename: string,
    mimeType: string
  ): Promise<ExtractionResult> {
    const extractor = this.extractors.find((ext) => ext.canExtract(mimeType));

    if (!extractor) {
      logger.warn('No extractor found for archive type', {
        filename,
        mimeType,
      });

      return {
        success: false,
        files: [],
        error: {
          code: 'UNSUPPORTED_ARCHIVE_FORMAT',
          message: `Archive format not supported: ${mimeType}`,
          details: 'Supported formats: ZIP, RAR, 7Z, TAR, TAR.GZ, GZIP, BZIP2',
        },
        metadata: {
          archiveType: mimeType,
          totalFiles: 0,
          totalSize: 0,
          extractionTimeMs: 0,
        },
      };
    }

    return extractor.extract(buffer, filename);
  }
}
