/**
 * Content Type Detector
 *
 * Intelligently detects the type of content being stored to route to appropriate processing pipeline.
 * Follows Single Responsibility Principle - one job: determine content type.
 *
 * Detection Strategy:
 * 1. Binary data (Buffer) → Needs parsing
 * 2. File path (string starting with / or \ and ending with extension) → Needs file reading + parsing
 * 3. Base64-encoded data → Needs decoding + parsing
 * 4. Plain text → Direct storage
 */

import { logger } from './logger';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Supported content types
 */
export enum ContentType {
  BUFFER = 'buffer',           // Binary data (Buffer object)
  FILEPATH = 'filepath',       // File system path to document
  BASE64 = 'base64',          // Base64-encoded file data
  PLAINTEXT = 'plaintext'      // Raw text content
}

/**
 * Detection result with confidence score
 */
export interface DetectionResult {
  type: ContentType;
  confidence: number;  // 0.0 - 1.0
  reason: string;
  metadata?: {
    fileExtension?: string;
    estimatedSize?: number;
    filePath?: string;
  };
}

/**
 * ContentTypeDetector class
 * Determines what kind of content is being provided for storage
 */
export class ContentTypeDetector {
  // Supported file extensions for parsing
  private static readonly PARSEABLE_EXTENSIONS = new Set([
    '.pdf', '.docx', '.doc', '.xlsx', '.xls',
    '.md', '.markdown', '.txt', '.text',
    '.rtf', '.epub'
  ]);

  /**
   * Detect content type from input
   * @param input - Content to analyze (string or Buffer)
   * @returns DetectionResult with type and confidence
   */
  static detect(input: string | Buffer): DetectionResult {
    // Detection Strategy 1: Buffer data
    if (Buffer.isBuffer(input)) {
      return {
        type: ContentType.BUFFER,
        confidence: 1.0,
        reason: 'Input is Buffer object',
        metadata: {
          estimatedSize: input.length
        }
      };
    }

    // Detection Strategy 2: File path
    const filePathCheck = this.isFilePath(input);
    if (filePathCheck.isFilePath) {
      return {
        type: ContentType.FILEPATH,
        confidence: filePathCheck.confidence,
        reason: filePathCheck.reason,
        metadata: {
          filePath: input,
          fileExtension: filePathCheck.extension
        }
      };
    }

    // Detection Strategy 3: Base64-encoded data
    const base64Check = this.isBase64(input);
    if (base64Check.isBase64) {
      return {
        type: ContentType.BASE64,
        confidence: base64Check.confidence,
        reason: base64Check.reason,
        metadata: {
          estimatedSize: input.length
        }
      };
    }

    // Default: Plain text content
    return {
      type: ContentType.PLAINTEXT,
      confidence: 1.0,
      reason: 'Input is plain text content',
      metadata: {
        estimatedSize: Buffer.byteLength(input, 'utf-8')
      }
    };
  }

  /**
   * Check if input is a file path
   * Multiple heuristics for confidence scoring
   */
  private static isFilePath(input: string): {
    isFilePath: boolean;
    confidence: number;
    reason: string;
    extension?: string;
  } {
    // Quick rejection: Very long strings are likely content, not paths
    if (input.length > 500) {
      return { isFilePath: false, confidence: 0, reason: 'Too long to be a file path' };
    }

    // Quick rejection: Strings with newlines are content, not paths
    if (input.includes('\n')) {
      return { isFilePath: false, confidence: 0, reason: 'Contains newlines (content)' };
    }

    let confidence = 0;
    const reasons: string[] = [];

    // Heuristic 1: Starts with / (Unix) or contains :\ (Windows)
    if (input.startsWith('/') || input.startsWith('\\') || /^[A-Za-z]:\\/.test(input)) {
      confidence += 0.4;
      reasons.push('starts with path separator');
    }

    // Heuristic 2: Contains file extension
    const extensionMatch = input.match(/\.([a-zA-Z0-9]{2,5})$/);
    if (extensionMatch) {
      const ext = `.${extensionMatch[1].toLowerCase()}`;
      confidence += 0.3;
      reasons.push(`has extension: ${ext}`);

      // Heuristic 3: Extension is in our parseable list
      if (this.PARSEABLE_EXTENSIONS.has(ext)) {
        confidence += 0.3;
        reasons.push('extension is parseable format');
      }

      // Heuristic 4: File exists on filesystem (highest confidence)
      if (fs.existsSync(input)) {
        confidence = 1.0;
        reasons.push('file exists on filesystem');

        const stats = fs.statSync(input);
        if (stats.isFile()) {
          return {
            isFilePath: true,
            confidence: 1.0,
            reason: `Verified file path: ${reasons.join(', ')}`,
            extension: ext
          };
        }
      }

      // Return with accumulated confidence
      if (confidence >= 0.7) {
        return {
          isFilePath: true,
          confidence,
          reason: `Likely file path: ${reasons.join(', ')}`,
          extension: ext
        };
      }
    }

    return {
      isFilePath: false,
      confidence,
      reason: 'Does not match file path patterns'
    };
  }

  /**
   * Check if input is base64-encoded data
   */
  private static isBase64(input: string): {
    isBase64: boolean;
    confidence: number;
    reason: string;
  } {
    // Quick rejection: Very short strings
    if (input.length < 100) {
      return { isBase64: false, confidence: 0, reason: 'Too short for base64 document' };
    }

    // Quick rejection: Contains typical base64 prefix
    const hasBase64Prefix = input.startsWith('data:') || input.startsWith('base64,');

    // Base64 pattern: Only contains A-Z, a-z, 0-9, +, /, =
    const base64Pattern = /^[A-Za-z0-9+/]+={0,2}$/;

    // Check if entire string (or string after prefix) matches base64
    const contentToCheck = hasBase64Prefix
      ? input.split(',')[1] || input
      : input;

    if (!base64Pattern.test(contentToCheck.substring(0, 1000))) {
      return { isBase64: false, confidence: 0, reason: 'Does not match base64 pattern' };
    }

    let confidence = 0.5;
    const reasons: string[] = ['matches base64 character set'];

    if (hasBase64Prefix) {
      confidence += 0.3;
      reasons.push('has base64 prefix');
    }

    // Length is multiple of 4 (base64 requirement)
    if (contentToCheck.length % 4 === 0) {
      confidence += 0.2;
      reasons.push('length is multiple of 4');
    }

    return {
      isBase64: confidence >= 0.7,
      confidence,
      reason: reasons.join(', ')
    };
  }

  /**
   * Validate file path exists and is readable
   * @param filePath - Path to validate
   * @returns Validation result with error details
   */
  static validateFilePath(filePath: string): {
    valid: boolean;
    error?: string;
    stats?: fs.Stats;
  } {
    try {
      if (!fs.existsSync(filePath)) {
        return {
          valid: false,
          error: `File does not exist: ${filePath}`
        };
      }

      const stats = fs.statSync(filePath);

      if (!stats.isFile()) {
        return {
          valid: false,
          error: `Path is not a file: ${filePath}`
        };
      }

      // Check read permissions
      try {
        fs.accessSync(filePath, fs.constants.R_OK);
      } catch {
        return {
          valid: false,
          error: `File is not readable: ${filePath}`
        };
      }

      return {
        valid: true,
        stats
      };
    } catch (error) {
      return {
        valid: false,
        error: `File validation failed: ${(error as Error).message}`
      };
    }
  }

  /**
   * Extract file extension from path or filename
   */
  static getFileExtension(filePathOrName: string): string | null {
    const ext = path.extname(filePathOrName).toLowerCase();
    return ext || null;
  }

  /**
   * Check if file extension is parseable
   */
  static isParseableExtension(extension: string): boolean {
    return this.PARSEABLE_EXTENSIONS.has(extension.toLowerCase());
  }

  /**
   * Get list of supported parseable extensions
   */
  static getSupportedExtensions(): string[] {
    return Array.from(this.PARSEABLE_EXTENSIONS);
  }

  /**
   * Decode base64 string to Buffer
   * @param base64String - Base64-encoded string
   * @returns Decoded Buffer
   */
  static decodeBase64(base64String: string): Buffer {
    // Remove data URI prefix if present
    const base64Data = base64String.includes(',')
      ? base64String.split(',')[1]
      : base64String;

    return Buffer.from(base64Data, 'base64');
  }
}

/**
 * Convenience function for quick detection
 */
export function detectContentType(input: string | Buffer): ContentType {
  return ContentTypeDetector.detect(input).type;
}

/**
 * Convenience function for full detection with metadata
 */
export function detectContentTypeFull(input: string | Buffer): DetectionResult {
  const result = ContentTypeDetector.detect(input);

  logger.debug('Content type detected', {
    type: result.type,
    confidence: result.confidence,
    reason: result.reason,
    metadata: result.metadata
  });

  return result;
}
