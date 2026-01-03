/**
 * File Document Validator
 *
 * Extends document-validator.ts to handle file uploads and parsing
 * Integrates with document-parser.ts for comprehensive file format support
 *
 * Features:
 * - File format validation
 * - Automatic parsing of PDFs, DOCX, XLSX, etc.
 * - Size-based timeout calculation
 * - Domain detection from content
 * - Metadata enrichment
 */

import { validateDocumentInput, mapDomainToDocType } from './document-validator.js';
import {
  DocumentParser,
  ParsedDocument,
  FileFormat,
  documentParser
} from '../parsers/document-parser.js';
import { logger } from '../utils/logger.js';

/**
 * File validation result
 */
export interface FileValidationResult {
  valid: boolean;
  content: string;
  title: string;
  metadata: any;
  recommendedTimeout: number;
  errors?: string[];
  warnings?: string[];
}

/**
 * Supported MIME types
 */
export const SUPPORTED_MIME_TYPES = {
  'application/pdf': FileFormat.PDF,
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': FileFormat.DOCX,
  'application/msword': FileFormat.DOCX,
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': FileFormat.XLSX,
  'application/vnd.ms-excel': FileFormat.XLSX,
  'text/markdown': FileFormat.MD,
  'text/plain': FileFormat.TXT,
  'application/rtf': FileFormat.RTF,
  'application/epub+zip': FileFormat.EPUB
};

/**
 * Max file sizes by format (bytes)
 */
export const MAX_FILE_SIZES: Record<FileFormat, number> = {
  [FileFormat.PDF]: 50 * 1024 * 1024,    // 50MB
  [FileFormat.DOCX]: 25 * 1024 * 1024,   // 25MB
  [FileFormat.XLSX]: 10 * 1024 * 1024,   // 10MB
  [FileFormat.MD]: 5 * 1024 * 1024,      // 5MB
  [FileFormat.RTF]: 5 * 1024 * 1024,     // 5MB
  [FileFormat.EPUB]: 20 * 1024 * 1024,   // 20MB
  [FileFormat.TXT]: 5 * 1024 * 1024,     // 5MB
  [FileFormat.UNKNOWN]: 1 * 1024 * 1024  // 1MB for unknown
};

/**
 * Validate file size
 */
export function validateFileSize(size: number, format: FileFormat): { valid: boolean; error?: string } {
  const maxSize = MAX_FILE_SIZES[format];

  if (size > maxSize) {
    return {
      valid: false,
      error: `File size ${(size / 1024 / 1024).toFixed(2)}MB exceeds maximum allowed ${(maxSize / 1024 / 1024).toFixed(2)}MB for ${format} files`
    };
  }

  return { valid: true };
}

/**
 * Detect domain from content
 */
export function detectDomainFromContent(content: string, fileName: string): string {
  const text = content.toLowerCase();
  const name = fileName.toLowerCase();

  // Medical domain indicators
  const medicalKeywords = [
    'patient', 'diagnosis', 'treatment', 'prescription', 'medical',
    'clinical', 'hospital', 'doctor', 'physician', 'health record',
    'laboratory', 'radiology', 'imaging', 'ehr', 'medical history'
  ];

  // Legal domain indicators
  const legalKeywords = [
    'plaintiff', 'defendant', 'court', 'judge', 'attorney', 'lawyer',
    'contract', 'agreement', 'whereas', 'hereby', 'pursuant',
    'litigation', 'deposition', 'discovery', 'brief', 'motion'
  ];

  // Creative writing indicators
  const creativeKeywords = [
    'chapter', 'novel', 'story', 'character', 'protagonist',
    'dialogue', 'scene', 'manuscript', 'fiction', 'narrative'
  ];

  // Financial domain indicators
  const financeKeywords = [
    'revenue', 'expenses', 'profit', 'balance sheet', 'income statement',
    'audit', 'financial', 'accounting', 'fiscal', 'quarter',
    'assets', 'liabilities', 'equity', 'gaap', 'sec filing'
  ];

  // Academic/Research indicators
  const academicKeywords = [
    'abstract', 'introduction', 'methodology', 'results', 'conclusion',
    'references', 'bibliography', 'research', 'study', 'hypothesis',
    'thesis', 'dissertation', 'journal', 'peer-reviewed'
  ];

  // Technical/Code indicators
  const technicalKeywords = [
    'function', 'class', 'method', 'api', 'documentation',
    'implementation', 'algorithm', 'code', 'syntax', 'library',
    'framework', 'repository', 'commit', 'pull request'
  ];

  // Count keyword matches
  const counts = {
    medical: medicalKeywords.filter(k => text.includes(k)).length,
    legal: legalKeywords.filter(k => text.includes(k)).length,
    creative: creativeKeywords.filter(k => text.includes(k)).length,
    finance: financeKeywords.filter(k => text.includes(k)).length,
    academic: academicKeywords.filter(k => text.includes(k)).length,
    technical: technicalKeywords.filter(k => text.includes(k) || name.includes(k)).length
  };

  // Find domain with most matches
  const maxCount = Math.max(...Object.values(counts));

  if (maxCount === 0) {
    return 'general'; // No clear domain
  }

  const detectedDomain = Object.entries(counts).find(([_, count]) => count === maxCount)?.[0] || 'general';

  logger.debug('Domain detected from content', {
    domain: detectedDomain,
    matchCounts: counts
  });

  return detectedDomain;
}

/**
 * Validate and parse file document
 */
export async function validateFileDocument(
  filePathOrBuffer: string | Buffer,
  fileName?: string,
  mimeType?: string,
  domain?: string
): Promise<FileValidationResult> {
  const errors: string[] = [];
  const warnings: string[] = [];

  try {
    // Parse document
    let parsed: ParsedDocument;

    if (Buffer.isBuffer(filePathOrBuffer)) {
      if (!fileName) {
        throw new Error('fileName is required when providing Buffer');
      }
      parsed = await documentParser.parseBuffer(filePathOrBuffer, fileName);
    } else {
      parsed = await documentParser.parseFile(filePathOrBuffer);
    }

    // Validate file size
    const sizeValidation = validateFileSize(parsed.metadata.fileSize, parsed.metadata.format);
    if (!sizeValidation.valid) {
      errors.push(sizeValidation.error!);
      return {
        valid: false,
        content: '',
        title: fileName || parsed.metadata.fileName,
        metadata: {},
        recommendedTimeout: 30000,
        errors
      };
    }

    // Detect domain if not provided
    const detectedDomain = domain || detectDomainFromContent(
      parsed.content.slice(0, 5000), // First 5k chars for detection
      parsed.metadata.fileName
    );

    // Map domain to document type (default to 'text' if no match)
    const documentType = mapDomainToDocType(detectedDomain) || 'text';

    // Calculate recommended timeout
    const recommendedTimeout = documentParser.calculateTimeout(
      parsed.metadata.wordCount,
      parsed.metadata.format
    );

    // Enrich metadata
    const enrichedMetadata = {
      ...parsed.metadata,
      domain: detectedDomain,
      type: documentType,
      version: 1, // Default version
      parsedFrom: parsed.metadata.format,
      extractedAt: new Date().toISOString()
    };

    // Validate using standard document validator
    const validated = validateDocumentInput({
      content: parsed.content,
      title: parsed.metadata.title || fileName || parsed.metadata.fileName,
      metadata: enrichedMetadata
    });

    // Add warnings for large documents
    if (parsed.metadata.wordCount > 100000) {
      warnings.push(`Large document detected: ${parsed.metadata.wordCount.toLocaleString()} words. Processing may take several minutes.`);
    }

    if (parsed.metadata.format === FileFormat.PDF && parsed.metadata.pageCount && parsed.metadata.pageCount > 100) {
      warnings.push(`Large PDF detected: ${parsed.metadata.pageCount} pages. Consider splitting if experiencing timeouts.`);
    }

    logger.info('File document validated successfully', {
      fileName: parsed.metadata.fileName,
      format: parsed.metadata.format,
      wordCount: parsed.metadata.wordCount,
      domain: detectedDomain,
      documentType,
      recommendedTimeout: `${recommendedTimeout}ms`
    });

    return {
      valid: true,
      content: validated.content,
      title: validated.title || fileName || 'Untitled Document',
      metadata: validated.metadata,
      recommendedTimeout,
      warnings: warnings.length > 0 ? warnings : undefined
    };
  } catch (error) {
    logger.error('File document validation failed', {
      error: (error as Error).message
    });

    errors.push((error as Error).message);

    return {
      valid: false,
      content: '',
      title: fileName || 'unknown',
      metadata: {},
      recommendedTimeout: 30000,
      errors
    };
  }
}

/**
 * Validate MIME type
 */
export function validateMimeType(mimeType: string): { valid: boolean; format?: FileFormat; error?: string } {
  const format = SUPPORTED_MIME_TYPES[mimeType as keyof typeof SUPPORTED_MIME_TYPES];

  if (!format) {
    return {
      valid: false,
      error: `Unsupported MIME type: ${mimeType}. Supported types: ${Object.keys(SUPPORTED_MIME_TYPES).join(', ')}`
    };
  }

  return {
    valid: true,
    format
  };
}

/**
 * Get supported file extensions
 */
export function getSupportedExtensions(): string[] {
  return [
    '.pdf',
    '.docx', '.doc',
    '.xlsx', '.xls',
    '.md', '.markdown',
    '.txt', '.text',
    '.rtf',
    '.epub'
  ];
}

/**
 * Check if file extension is supported
 */
export function isSupportedExtension(fileName: string): boolean {
  const ext = fileName.toLowerCase().slice(fileName.lastIndexOf('.'));
  return getSupportedExtensions().includes(ext);
}
