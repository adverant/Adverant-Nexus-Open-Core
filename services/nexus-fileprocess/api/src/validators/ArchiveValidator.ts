/**
 * ArchiveValidator - Detects and validates archive formats using magic byte signatures
 *
 * Supports: ZIP, RAR, 7Z, TAR, GZIP, BZIP2
 *
 * Design Pattern: Chain of Responsibility
 * SOLID Principles:
 * - Single Responsibility: Only handles archive format detection
 * - Open/Closed: New archive formats can be added without modification
 *
 * Root Cause Addressed: Issue #1 - Hardcoded MIME type whitelist
 *
 * This validator uses magic byte detection to identify archive formats,
 * enabling the system to route them to the ArchiveExtractor for processing.
 */

import { logger } from '../utils/logger';

export interface ValidationContext {
  buffer: Buffer;
  filename: string;
  claimedMimeType?: string;
  userId?: string;
}

export interface ValidationResult {
  valid: boolean;
  detectedMimeType?: string;
  error?: {
    code: string;
    message: string;
    httpStatus: number;
  };
  metadata?: Record<string, unknown>;
}

/**
 * ArchiveValidator
 *
 * Validates archive formats using magic byte signatures (file headers).
 * Does NOT reject unknown formats - returns valid=true for non-archives.
 *
 * This follows the Open/Closed Principle: the validator is open for extension
 * (new archive formats can be added) but closed for modification (existing logic
 * doesn't change).
 */
export class ArchiveValidator {
  /**
   * Archive format signatures (magic bytes)
   *
   * Sources:
   * - ZIP: 0x504B0304 (PK\x03\x04)
   * - RAR: 0x526172211A07 (Rar!\x1A\x07)
   * - 7Z: 0x377ABCAF271C (7z signature)
   * - TAR: "ustar" at byte offset 257
   * - GZIP: 0x1F8B (gzip header)
   * - BZIP2: 0x425A68 (BZh)
   */
  private readonly ARCHIVE_SIGNATURES: Record<string, Buffer> = {
    'application/zip': Buffer.from([0x50, 0x4B, 0x03, 0x04]),
    'application/x-rar-compressed': Buffer.from([0x52, 0x61, 0x72, 0x21, 0x1A, 0x07]),
    'application/x-7z-compressed': Buffer.from([0x37, 0x7A, 0xBC, 0xAF, 0x27, 0x1C]),
    'application/x-tar': Buffer.from('ustar', 'ascii'), // "ustar" at offset 257
    'application/gzip': Buffer.from([0x1F, 0x8B]),
    'application/x-bzip2': Buffer.from([0x42, 0x5A, 0x68]), // "BZh"
  };

  /**
   * TAR archives have "ustar" at byte offset 257 (not at the beginning)
   */
  private readonly TAR_USTAR_OFFSET = 257;

  /**
   * Validate archive format
   *
   * @param context - Validation context (buffer, filename, etc.)
   * @returns ValidationResult with detected MIME type and metadata
   *
   * IMPORTANT: This validator does NOT reject files. It only identifies
   * archive formats. Non-archives return valid=true with no detectedMimeType.
   */
  async validate(context: ValidationContext): Promise<ValidationResult> {
    const { buffer, filename } = context;

    // Check for zero-byte files (invalid for any archive)
    if (buffer.length === 0) {
      return {
        valid: true, // Don't reject - let other validators handle empty files
      };
    }

    // Check for TAR format first (special case - signature at offset 257)
    if (buffer.length > this.TAR_USTAR_OFFSET + 5) {
      const tarSignature = this.ARCHIVE_SIGNATURES['application/x-tar'];
      const tarRegion = buffer.subarray(
        this.TAR_USTAR_OFFSET,
        this.TAR_USTAR_OFFSET + tarSignature.length
      );

      if (tarRegion.equals(tarSignature)) {
        logger.debug('TAR archive detected', {
          filename,
          offset: this.TAR_USTAR_OFFSET,
        });

        return {
          valid: true,
          detectedMimeType: 'application/x-tar',
          metadata: {
            isArchive: true,
            archiveType: 'tar',
            compressionFormat: this.detectTarCompression(buffer),
          },
        };
      }
    }

    // Check other archive formats by magic bytes at the start of the file
    for (const [mimeType, signature] of Object.entries(this.ARCHIVE_SIGNATURES)) {
      // Skip TAR (already checked above)
      if (mimeType === 'application/x-tar') continue;

      // Check if buffer is long enough for this signature
      if (buffer.length < signature.length) continue;

      // Compare magic bytes
      const fileHeader = buffer.subarray(0, signature.length);
      if (fileHeader.equals(signature)) {
        const archiveType = this.getMimeTypeShortName(mimeType);

        logger.debug('Archive format detected', {
          filename,
          mimeType,
          archiveType,
          signatureLength: signature.length,
        });

        return {
          valid: true,
          detectedMimeType: mimeType,
          metadata: {
            isArchive: true,
            archiveType,
            compressionFormat: archiveType === 'gzip' || archiveType === 'bzip2' ? archiveType : null,
          },
        };
      }
    }

    // Not an archive - return valid with no detection
    // (This allows the file to be processed by other validators/handlers)
    return {
      valid: true,
    };
  }

  /**
   * Detect TAR compression format by checking for GZIP/BZIP2 signatures
   *
   * @param buffer - File buffer
   * @returns Compression format ('gzip', 'bzip2', or 'none')
   */
  private detectTarCompression(buffer: Buffer): string {
    // Check for GZIP compression (tar.gz)
    const gzipSig = this.ARCHIVE_SIGNATURES['application/gzip'];
    if (buffer.subarray(0, gzipSig.length).equals(gzipSig)) {
      return 'gzip';
    }

    // Check for BZIP2 compression (tar.bz2)
    const bzip2Sig = this.ARCHIVE_SIGNATURES['application/x-bzip2'];
    if (buffer.subarray(0, bzip2Sig.length).equals(bzip2Sig)) {
      return 'bzip2';
    }

    return 'none';
  }

  /**
   * Extract short name from MIME type
   *
   * Examples:
   * - application/zip → zip
   * - application/x-rar-compressed → rar
   * - application/x-7z-compressed → 7z
   *
   * @param mimeType - Full MIME type string
   * @returns Short archive type name
   */
  private getMimeTypeShortName(mimeType: string): string {
    const mapping: Record<string, string> = {
      'application/zip': 'zip',
      'application/x-rar-compressed': 'rar',
      'application/x-7z-compressed': '7z',
      'application/x-tar': 'tar',
      'application/gzip': 'gzip',
      'application/x-bzip2': 'bzip2',
    };

    return mapping[mimeType] || mimeType.split('/')[1];
  }

  /**
   * Get human-readable description of archive format
   *
   * @param mimeType - MIME type
   * @returns Human-readable description
   */
  getDescription(mimeType: string): string {
    const descriptions: Record<string, string> = {
      'application/zip': 'ZIP Archive',
      'application/x-rar-compressed': 'RAR Archive',
      'application/x-7z-compressed': '7-Zip Archive',
      'application/x-tar': 'TAR Archive',
      'application/gzip': 'GZIP Compressed File',
      'application/x-bzip2': 'BZIP2 Compressed File',
    };

    return descriptions[mimeType] || 'Archive';
  }
}
