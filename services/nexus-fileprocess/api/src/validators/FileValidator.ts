import { fileTypeFromBuffer } from 'file-type';
import { ValidationError, ValidationErrorFactory } from '../errors/ValidationError';
import { ArchiveValidator } from './ArchiveValidator';
import { OfficeDocumentValidator } from './OfficeDocumentValidator';
import { config } from '../config';

/**
 * Comprehensive file validation layer
 *
 * Design Pattern: Chain of Responsibility
 * SOLID Principles:
 *   - Single Responsibility: Each validator has one job
 *   - Open/Closed: Easy to add new validators
 *   - Dependency Inversion: Depends on abstractions, not concretions
 */

export interface FileValidationContext {
  buffer: Buffer;
  filename: string;
  claimedMimeType?: string;
  userId?: string;
}

export interface FileValidationResult {
  valid: boolean;
  detectedMimeType?: string;
  error?: ValidationError;
}

/**
 * Base validator interface
 */
export interface IFileValidator {
  validate(context: FileValidationContext): Promise<FileValidationResult>;
}

/**
 * Validator 1: File Size Validation
 */
export class FileSizeValidator implements IFileValidator {
  constructor(
    private readonly minSize: number = 1, // 1 byte minimum
    private readonly maxSize: number = 100 * 1024 * 1024 // 100MB maximum
  ) {}

  async validate(context: FileValidationContext): Promise<FileValidationResult> {
    const size = context.buffer.length;

    if (size === 0) {
      return {
        valid: false,
        error: ValidationErrorFactory.emptyFile(context.filename),
      };
    }

    if (size < this.minSize) {
      return {
        valid: false,
        error: ValidationErrorFactory.fileTooSmall(context.filename, size, this.minSize),
      };
    }

    if (size > this.maxSize) {
      return {
        valid: false,
        error: ValidationErrorFactory.fileTooLarge(context.filename, size, this.maxSize),
      };
    }

    return { valid: true };
  }
}

/**
 * Validator 2: Magic Byte Detection (File Signature) with UTF-8 Fallback
 *
 * REFACTORED: Removed hardcoded SUPPORTED_MIME_TYPES whitelist.
 *
 * Root Cause Fix: Issue #1 - Hardcoded MIME type whitelist (architectural flaw)
 * Root Cause Fix: Issue #2 - Validator rejects unknown formats before routing
 *
 * NEW BEHAVIOR:
 * - Detects MIME type using magic bytes (file-type library)
 * - Does NOT reject unknown formats
 * - Returns valid=true with detectedMimeType for ALL formats
 * - Routing layer decides how to process each format (not validation layer)
 *
 * This follows the Open/Closed Principle: system is open for extension
 * (new formats can be added) without modification (no code changes needed).
 */
export class MagicByteValidator implements IFileValidator {
  // Minimum sizes for known formats (to detect truncated/corrupted files)
  // Note: This is NOT a whitelist - unknown formats are still accepted
  private readonly MIN_SIZES: Record<string, number> = {
    'application/pdf': 100, // PDF header + trailer minimum
    'image/png': 67,        // PNG signature + IHDR chunk minimum
    'image/jpeg': 125,      // JPEG markers + minimal data
    'text/plain': 1,        // Any size for plain text
  };

  /**
   * Check if buffer appears to be UTF-8 text
   * Uses heuristic: >90% printable characters
   */
  private isUtf8Text(buffer: Buffer): boolean {
    // Sample size: first 2KB or entire file if smaller
    const sampleSize = Math.min(2048, buffer.length);
    const sample = buffer.subarray(0, sampleSize);

    try {
      // Try to decode as UTF-8
      const text = sample.toString('utf-8');

      // Count printable characters
      let printableCount = 0;
      for (const char of text) {
        const code = char.charCodeAt(0);

        // Printable ASCII (32-126) + common whitespace (9, 10, 13)
        if (
          (code >= 32 && code <= 126) ||
          code === 9 || // tab
          code === 10 || // newline
          code === 13 // carriage return
        ) {
          printableCount++;
        }
      }

      // Require >90% printable characters
      const printableRatio = printableCount / text.length;
      return printableRatio > 0.9;
    } catch (error) {
      // Not valid UTF-8
      return false;
    }
  }

  async validate(context: FileValidationContext): Promise<FileValidationResult> {
    // Detect actual MIME type from file signature
    const detected = await fileTypeFromBuffer(context.buffer);
    const detectedMimeType = detected?.mime || 'application/octet-stream';

    // ENHANCEMENT: If file-type library says "application/octet-stream" (no magic bytes),
    // perform UTF-8 text validation to detect text files (.txt, .csv, .md, .json, .xml, etc.)
    if (detectedMimeType === 'application/octet-stream') {
      if (this.isUtf8Text(context.buffer)) {
        // File appears to be UTF-8 text, accept as text/plain
        return { valid: true, detectedMimeType: 'text/plain' };
      }

      // REFACTORED: No longer reject unknown formats
      // Return valid=true with detectedMimeType='application/octet-stream'
      // Routing layer will decide how to handle (MageAgent + Sandbox)
      return { valid: true, detectedMimeType: 'application/octet-stream' };
    }

    // REFACTORED: Removed whitelist check - accept ALL detected formats
    // Archives, Office documents, and other formats now pass validation

    // Verify file size meets minimum for detected format (if known)
    const minSize = this.MIN_SIZES[detectedMimeType];
    if (minSize && context.buffer.length < minSize) {
      return {
        valid: false,
        detectedMimeType,
        error: ValidationErrorFactory.corruptedFile(
          context.filename,
          detectedMimeType,
          `File is too small for ${detectedMimeType} format (${context.buffer.length} bytes, expected at least ${minSize} bytes)`
        ),
      };
    }

    // Accept all formats - routing layer handles processing
    return { valid: true, detectedMimeType };
  }
}

/**
 * Validator 3: MIME Type Consistency Check with UTF-8 Text Detection
 */
export class MimeConsistencyValidator implements IFileValidator {
  /**
   * Check if buffer appears to be UTF-8 text
   * Uses heuristic: >90% printable characters
   */
  private isUtf8Text(buffer: Buffer): boolean {
    // Sample size: first 2KB or entire file if smaller
    const sampleSize = Math.min(2048, buffer.length);
    const sample = buffer.subarray(0, sampleSize);

    try {
      // Try to decode as UTF-8
      const text = sample.toString('utf-8');

      // Count printable characters
      let printableCount = 0;
      for (const char of text) {
        const code = char.charCodeAt(0);

        // Printable ASCII (32-126) + common whitespace (9, 10, 13)
        if (
          (code >= 32 && code <= 126) ||
          code === 9 || // tab
          code === 10 || // newline
          code === 13 // carriage return
        ) {
          printableCount++;
        }
      }

      // Require >90% printable characters
      const printableRatio = printableCount / text.length;
      return printableRatio > 0.9;
    } catch (error) {
      // Not valid UTF-8
      return false;
    }
  }

  async validate(context: FileValidationContext): Promise<FileValidationResult> {
    const detected = await fileTypeFromBuffer(context.buffer);
    const detectedMimeType = detected?.mime || 'application/octet-stream';

    // ENHANCEMENT: If file-type library says "application/octet-stream" (no magic bytes),
    // perform UTF-8 text validation to detect text files (.txt, .csv, .md, .json, .xml, etc.)
    if (detectedMimeType === 'application/octet-stream') {
      if (this.isUtf8Text(context.buffer)) {
        // File appears to be UTF-8 text, accept as text/plain
        return { valid: true, detectedMimeType: 'text/plain' };
      }

      // REFACTORED: No longer reject unknown formats
      // Return valid=true with detectedMimeType='application/octet-stream'
      return { valid: true, detectedMimeType: 'application/octet-stream' };
    }

    // If client claimed a MIME type, verify it matches detected type
    // REFACTORED: Changed from hard error to warning (log mismatch but accept)
    if (context.claimedMimeType && context.claimedMimeType !== detectedMimeType) {
      // Allow text/plain → application/octet-stream (legacy behavior)
      if ((detectedMimeType as string) === 'application/octet-stream' && context.claimedMimeType === 'text/plain') {
        return { valid: true, detectedMimeType: 'text/plain' };
      }

      // REFACTORED: Log mismatch as warning but don't reject
      // Detected MIME type is more reliable than client-provided
      // (prevents spoofed/incorrect MIME types from blocking valid files)
      console.warn(`MIME type mismatch for ${context.filename}: claimed=${context.claimedMimeType}, detected=${detectedMimeType}`);
    }

    // Accept all formats with detected MIME type
    return { valid: true, detectedMimeType };
  }
}

/**
 * Validator 4: PDF-Specific Validation
 */
export class PdfValidator implements IFileValidator {
  private readonly PDF_MAGIC = Buffer.from([0x25, 0x50, 0x44, 0x46]); // "%PDF"

  async validate(context: FileValidationContext): Promise<FileValidationResult> {
    const detected = await fileTypeFromBuffer(context.buffer);
    if (detected?.mime !== 'application/pdf') {
      return { valid: true }; // Not a PDF, skip this validator
    }

    // Verify PDF magic bytes
    if (!context.buffer.subarray(0, 4).equals(this.PDF_MAGIC)) {
      return {
        valid: false,
        error: ValidationErrorFactory.corruptedFile(
          context.filename,
          'application/pdf',
          'Invalid PDF header (missing %PDF magic bytes)'
        ),
      };
    }

    // Verify PDF has EOF marker
    const lastBytes = context.buffer.subarray(-20).toString('utf-8');
    if (!lastBytes.includes('%%EOF')) {
      return {
        valid: false,
        error: ValidationErrorFactory.corruptedFile(
          context.filename,
          'application/pdf',
          'Incomplete PDF file (missing %%EOF marker)'
        ),
      };
    }

    return { valid: true };
  }
}

/**
 * Adapter for ArchiveValidator to match IFileValidator interface
 */
class ArchiveValidatorAdapter implements IFileValidator {
  private archiveValidator = new ArchiveValidator();

  async validate(context: FileValidationContext): Promise<FileValidationResult> {
    const result = await this.archiveValidator.validate(context);

    // Convert ValidationResult to FileValidationResult
    if (!result.valid && result.error) {
      return {
        valid: false,
        error: new ValidationError(
          result.error.message,
          result.error.code as any, // Archive validator uses string codes, not ErrorCode enum
          result.error.httpStatus,
          {
            filename: context.filename,
            suggestion: 'Archive validation failed',
            timestamp: new Date(),
          }
        ),
      };
    }

    return {
      valid: result.valid,
      detectedMimeType: result.detectedMimeType,
    };
  }
}

/**
 * Adapter for OfficeDocumentValidator to match IFileValidator interface
 */
class OfficeDocumentValidatorAdapter implements IFileValidator {
  private officeValidator = new OfficeDocumentValidator();

  async validate(context: FileValidationContext): Promise<FileValidationResult> {
    const result = await this.officeValidator.validate(context);

    // Convert ValidationResult to FileValidationResult
    if (!result.valid && result.error) {
      return {
        valid: false,
        error: new ValidationError(
          result.error.message,
          result.error.code as any, // Office validator uses string codes, not ErrorCode enum
          result.error.httpStatus,
          {
            filename: context.filename,
            suggestion: 'Office document validation failed',
            timestamp: new Date(),
          }
        ),
      };
    }

    return {
      valid: result.valid,
      detectedMimeType: result.detectedMimeType,
    };
  }
}

/**
 * Composite validator: Chain of Responsibility pattern
 */
export class FileValidatorChain {
  private validators: IFileValidator[];

  constructor() {
    this.validators = [
      new FileSizeValidator(1, config.maxFileSize), // Use config for max file size (supports GB-scale)
      new ArchiveValidatorAdapter(),       // Archive detection (ZIP, RAR, 7Z, TAR, GZIP, BZIP2)
      new OfficeDocumentValidatorAdapter(), // Office document detection (DOCX, XLSX, PPTX, DOC, XLS, PPT)
      new MagicByteValidator(),
      new MimeConsistencyValidator(),
      new PdfValidator(),
    ];
  }

  /**
   * Run all validators in sequence, return first failure
   */
  async validate(context: FileValidationContext): Promise<FileValidationResult> {
    let detectedMimeType: string | undefined;

    for (const validator of this.validators) {
      const result = await validator.validate(context);

      // Update detected MIME type if provided
      if (result.detectedMimeType) {
        detectedMimeType = result.detectedMimeType;
      }

      // Return immediately on first failure
      if (!result.valid) {
        return result;
      }
    }

    // All validators passed
    return { valid: true, detectedMimeType };
  }
}

/**
 * Singleton instance for dependency injection
 */
export const fileValidator = new FileValidatorChain();
