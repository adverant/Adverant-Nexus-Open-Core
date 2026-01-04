/**
 * OfficeDocumentValidator - Validates Microsoft Office documents (DOCX, XLSX, PPTX)
 *
 * Supports:
 * - Modern formats: DOCX, XLSX, PPTX (Open XML)
 * - Legacy formats: DOC, XLS, PPT (OLE2/CFB)
 *
 * Design Pattern: Chain of Responsibility
 * SOLID Principles:
 * - Single Responsibility: Only handles Office document detection
 * - Open/Closed: New Office formats can be added without modification
 *
 * Root Cause Addressed: Issue #1 - Hardcoded MIME type whitelist
 *
 * Office documents use two underlying formats:
 * 1. Modern (2007+): ZIP-based Open XML (detected as ZIP, then validated)
 * 2. Legacy (97-2003): OLE2 Compound File Binary (CFB) format
 *
 * IMPORTANT: Modern Office documents (DOCX, XLSX, PPTX) are ZIP files containing XML.
 * This validator checks for ZIP signature first, then validates the internal structure.
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
 * OfficeDocumentValidator
 *
 * Validates Microsoft Office documents using:
 * 1. Magic byte detection (file headers)
 * 2. Internal structure validation for Open XML formats
 *
 * Does NOT reject unknown formats - returns valid=true for non-Office files.
 */
export class OfficeDocumentValidator {
  /**
   * Office document signatures (magic bytes)
   *
   * Modern Office (2007+):
   * - All use ZIP format: 0x504B0304 (PK\x03\x04)
   * - Differentiated by internal structure
   *
   * Legacy Office (97-2003):
   * - OLE2 CFB format: 0xD0CF11E0A1B11AE1
   */
  private readonly OFFICE_SIGNATURES = {
    // Modern formats (ZIP-based Open XML)
    zip: Buffer.from([0x50, 0x4B, 0x03, 0x04]),

    // Legacy formats (OLE2/CFB)
    ole2: Buffer.from([0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1]),
  };

  /**
   * Open XML content type identifiers
   *
   * Modern Office documents contain a [Content_Types].xml file that specifies
   * the document type. These are the partial content types we look for.
   */
  private readonly OPEN_XML_CONTENT_TYPES = {
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document':
      'wordprocessingml',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'spreadsheetml',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation':
      'presentationml',
  };

  /**
   * File extension to MIME type mapping
   *
   * Used as a fallback when magic bytes match but internal structure validation fails.
   */
  private readonly EXTENSION_MIME_MAP: Record<string, string> = {
    // Modern formats
    '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',

    // Legacy formats
    '.doc': 'application/msword',
    '.xls': 'application/vnd.ms-excel',
    '.ppt': 'application/vnd.ms-powerpoint',
  };

  /**
   * Validate Office document format
   *
   * @param context - Validation context (buffer, filename, etc.)
   * @returns ValidationResult with detected MIME type and metadata
   *
   * IMPORTANT: This validator does NOT reject files. It only identifies
   * Office documents. Non-Office files return valid=true with no detectedMimeType.
   */
  async validate(context: ValidationContext): Promise<ValidationResult> {
    const { buffer, filename } = context;

    // Check for zero-byte files
    if (buffer.length === 0) {
      return { valid: true };
    }

    // Check for legacy Office format (OLE2/CFB)
    if (this.isOLE2Format(buffer)) {
      const mimeType = this.detectLegacyOfficeType(buffer, filename);

      if (mimeType) {
        logger.debug('Legacy Office document detected', {
          filename,
          mimeType,
          format: 'OLE2/CFB',
        });

        return {
          valid: true,
          detectedMimeType: mimeType,
          metadata: {
            isOfficeDocument: true,
            officeFormat: 'legacy',
            officeType: this.getOfficeTypeShortName(mimeType),
          },
        };
      }
    }

    // Check for modern Office format (ZIP-based Open XML)
    if (this.isZipFormat(buffer)) {
      const mimeType = await this.detectOpenXMLType(buffer, filename);

      if (mimeType) {
        logger.debug('Modern Office document detected', {
          filename,
          mimeType,
          format: 'Open XML',
        });

        return {
          valid: true,
          detectedMimeType: mimeType,
          metadata: {
            isOfficeDocument: true,
            officeFormat: 'openxml',
            officeType: this.getOfficeTypeShortName(mimeType),
          },
        };
      }
    }

    // Not an Office document - return valid with no detection
    return { valid: true };
  }

  /**
   * Check if buffer starts with ZIP signature
   *
   * @param buffer - File buffer
   * @returns True if ZIP format
   */
  private isZipFormat(buffer: Buffer): boolean {
    const zipSig = this.OFFICE_SIGNATURES.zip;
    if (buffer.length < zipSig.length) return false;
    return buffer.subarray(0, zipSig.length).equals(zipSig);
  }

  /**
   * Check if buffer starts with OLE2/CFB signature
   *
   * @param buffer - File buffer
   * @returns True if OLE2 format
   */
  private isOLE2Format(buffer: Buffer): boolean {
    const ole2Sig = this.OFFICE_SIGNATURES.ole2;
    if (buffer.length < ole2Sig.length) return false;
    return buffer.subarray(0, ole2Sig.length).equals(ole2Sig);
  }

  /**
   * Detect Open XML document type by scanning for content type markers
   *
   * Modern Office documents are ZIP files containing XML. We look for the
   * [Content_Types].xml file and check its content.
   *
   * Note: Full ZIP parsing is expensive. We use a heuristic approach:
   * scan the buffer for content type strings.
   *
   * @param buffer - File buffer (ZIP format)
   * @param filename - Original filename
   * @returns MIME type or null if not an Office document
   */
  private async detectOpenXMLType(buffer: Buffer, filename: string): Promise<string | null> {
    // Convert buffer to string (UTF-8) for content type search
    // Only scan first 64KB for performance (content types are near the beginning)
    const searchBuffer = buffer.subarray(0, Math.min(buffer.length, 65536));
    const searchString = searchBuffer.toString('utf8', 0, searchBuffer.length);

    // Search for content type markers
    for (const [mimeType, marker] of Object.entries(this.OPEN_XML_CONTENT_TYPES)) {
      if (searchString.includes(marker)) {
        return mimeType;
      }
    }

    // Fallback: check file extension
    const extension = this.getFileExtension(filename);
    if (extension && this.EXTENSION_MIME_MAP[extension]) {
      const mimeType = this.EXTENSION_MIME_MAP[extension];

      // Only return if it's a modern format (.docx, .xlsx, .pptx)
      if (mimeType.includes('openxmlformats')) {
        logger.debug('Office document detected by extension (fallback)', {
          filename,
          extension,
          mimeType,
        });
        return mimeType;
      }
    }

    // Not a recognized Office document
    return null;
  }

  /**
   * Detect legacy Office document type
   *
   * Legacy Office documents (DOC, XLS, PPT) use OLE2/CFB format.
   * They can't be reliably differentiated by magic bytes alone.
   * We use file extension as the primary indicator.
   *
   * @param _buffer - File buffer (OLE2 format) - unused but kept for interface consistency
   * @param filename - Original filename
   * @returns MIME type or null if not a legacy Office document
   */
  private detectLegacyOfficeType(_buffer: Buffer, filename: string): string | null {
    const extension = this.getFileExtension(filename);

    if (!extension) return null;

    // Check if extension matches legacy Office formats
    const mimeType = this.EXTENSION_MIME_MAP[extension];

    // Only return if it's a legacy format (.doc, .xls, .ppt)
    if (mimeType && !mimeType.includes('openxmlformats')) {
      return mimeType;
    }

    return null;
  }

  /**
   * Extract file extension from filename
   *
   * @param filename - Filename with extension
   * @returns Extension (lowercase, including dot) or null
   */
  private getFileExtension(filename: string): string | null {
    const match = filename.match(/(\.[^.]+)$/);
    return match ? match[1].toLowerCase() : null;
  }

  /**
   * Get short name from Office MIME type
   *
   * Examples:
   * - application/vnd.openxmlformats-officedocument.wordprocessingml.document → docx
   * - application/msword → doc
   *
   * @param mimeType - Full MIME type string
   * @returns Short Office type name
   */
  private getOfficeTypeShortName(mimeType: string): string {
    const mapping: Record<string, string> = {
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
      'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
      'application/msword': 'doc',
      'application/vnd.ms-excel': 'xls',
      'application/vnd.ms-powerpoint': 'ppt',
    };

    return mapping[mimeType] || 'office';
  }

  /**
   * Get human-readable description of Office document type
   *
   * @param mimeType - MIME type
   * @returns Human-readable description
   */
  getDescription(mimeType: string): string {
    const descriptions: Record<string, string> = {
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document':
        'Microsoft Word Document (DOCX)',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet':
        'Microsoft Excel Spreadsheet (XLSX)',
      'application/vnd.openxmlformats-officedocument.presentationml.presentation':
        'Microsoft PowerPoint Presentation (PPTX)',
      'application/msword': 'Microsoft Word Document (DOC)',
      'application/vnd.ms-excel': 'Microsoft Excel Spreadsheet (XLS)',
      'application/vnd.ms-powerpoint': 'Microsoft PowerPoint Presentation (PPT)',
    };

    return descriptions[mimeType] || 'Office Document';
  }
}
