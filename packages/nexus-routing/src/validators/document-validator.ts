/**
 * Document Input Validator
 *
 * Comprehensive validation and sanitization for GraphRAG document storage.
 * Fixes HTTP 500 errors caused by type mismatches and constraint violations.
 *
 * Key Features:
 * - Version type coercion (string → integer)
 * - Domain type mapping (medical, legal, etc. → valid DocumentType enum)
 * - Content-based type detection fallback
 * - Defensive validation with clear error messages
 * - Zero breaking changes for valid inputs
 */

import { logger } from '../utils/logger.js';

// Valid document types per GraphRAG database CHECK constraint
export const VALID_DOCUMENT_TYPES = [
  'code',
  'markdown',
  'text',
  'structured',
  'multimodal'
] as const;

export type DocumentType = typeof VALID_DOCUMENT_TYPES[number];

/**
 * Domain-to-DocumentType mapping
 * Maps common domain names to valid GraphRAG document types
 */
const DOMAIN_TYPE_MAP: Record<string, DocumentType> = {
  // Medical domain
  'medical': 'text',
  'patient': 'text',
  'clinical': 'text',
  'diagnosis': 'text',
  'treatment': 'text',
  'healthcare': 'text',
  'hospital': 'text',
  'doctor': 'text',
  'prescription': 'text',

  // Legal domain
  'legal': 'text',
  'contract': 'text',
  'agreement': 'text',
  'clause': 'text',
  'brief': 'text',
  'law': 'text',
  'regulation': 'text',
  'compliance': 'text',
  'litigation': 'text',

  // Finance domain
  'finance': 'text',
  'financial': 'text',
  'financial-report': 'text',
  'report': 'text',
  'audit': 'structured', // Often contains tables
  'prospectus': 'text',
  'investment': 'text',
  'banking': 'text',
  'accounting': 'text',

  // Creative writing domain
  'novel': 'text',
  'story': 'text',
  'chapter': 'text',
  'scene': 'text',
  'creative': 'text',
  'fiction': 'text',
  'narrative': 'text',
  'dialogue': 'text',
  'writing': 'text',

  // Code domain (explicit mappings)
  'code': 'code',
  'source': 'code',
  'source-code': 'code',
  'program': 'code',
  'script': 'code',
  'typescript': 'code',
  'javascript': 'code',
  'python': 'code',
  'java': 'code',

  // Markdown domain
  'markdown': 'markdown',
  'md': 'markdown',
  'documentation': 'markdown',
  'readme': 'markdown',
  'tutorial': 'markdown',
  'guide': 'markdown',

  // Text domain
  'text': 'text',
  'plaintext': 'text',
  'plain-text': 'text',
  'txt': 'text',
  'article': 'text',
  'paper': 'text',
  'note': 'text',
  'memo': 'text',

  // Structured domain
  'structured': 'structured',
  'json': 'structured',
  'xml': 'structured',
  'yaml': 'structured',
  'data': 'structured',
  'config': 'structured',
  'configuration': 'structured',

  // Multimodal domain
  'multimodal': 'multimodal',
  'mixed': 'multimodal',
  'document': 'multimodal',
  'doc': 'multimodal',
  'pdf': 'multimodal',
  'rich': 'multimodal',
  'richtext': 'multimodal',

  // Memory type (special case)
  'memory': 'text',
  'episode': 'text',
  'recall': 'text'
};

/**
 * Validation error types
 */
export class ValidationError extends Error {
  constructor(
    message: string,
    public field: string,
    public providedValue: any,
    public suggestion?: string
  ) {
    super(message);
    this.name = 'ValidationError';
  }
}

/**
 * Validated document input ready for GraphRAG storage
 */
export interface ValidatedDocumentInput {
  content: string;
  title?: string;
  metadata: {
    type: DocumentType;
    version: number;
    format?: string;
    tags?: string[];
    source?: string;
    language?: string;
    encoding?: string;
    custom?: Record<string, any>;
    [key: string]: any;
  };
}

/**
 * Raw document input (possibly invalid)
 */
export interface RawDocumentInput {
  content: string;
  title?: string;
  metadata?: {
    type?: string;
    version?: string | number;
    format?: string;
    tags?: string[];
    source?: string;
    [key: string]: any;
  };
}

/**
 * Validate and coerce version to integer
 *
 * Database schema: version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0)
 *
 * Handles:
 * - String versions: "1.0", "2.0", "v3", "version 4" → extract number
 * - Numeric versions: 1, 2, 3 → pass through
 * - Invalid versions: null, undefined, NaN, <= 0 → default to 1
 *
 * @param version - Version value (any type)
 * @returns Valid integer version (>= 1)
 */
export function validateVersion(version: any): number {
  // Handle undefined/null
  if (version === undefined || version === null) {
    return 1;
  }

  // If already a valid integer
  if (Number.isInteger(version) && version > 0) {
    return version;
  }

  // Handle string versions
  if (typeof version === 'string') {
    // Extract first number from string
    // "2.0" → 2, "v3" → 3, "version 4" → 4, "1.5.2" → 1
    const match = version.match(/\d+/);
    if (match) {
      const parsed = parseInt(match[0], 10);
      if (parsed > 0) {
        logger.debug('Converted string version to integer', {
          original: version,
          converted: parsed
        });
        return parsed;
      }
    }
  }

  // Handle numeric strings or floats
  if (typeof version === 'number' || typeof version === 'string') {
    const parsed = parseInt(String(version), 10);
    if (!isNaN(parsed) && parsed > 0) {
      logger.debug('Coerced version to integer', {
        original: version,
        originalType: typeof version,
        converted: parsed
      });
      return parsed;
    }
  }

  // Default to 1 for any invalid input
  logger.warn('Invalid version, defaulting to 1', {
    providedVersion: version,
    providedType: typeof version
  });

  return 1;
}

/**
 * Map domain type to valid DocumentType
 *
 * Handles common domain names like 'medical', 'legal', 'finance', 'novel'
 * Maps them to valid GraphRAG types: 'code', 'markdown', 'text', 'structured', 'multimodal'
 *
 * @param type - Domain type string (may be invalid)
 * @returns Valid DocumentType or null if unmapped
 */
export function mapDomainToDocType(type: string): DocumentType | null {
  if (!type) return null;

  const normalized = type.toLowerCase().trim()
    .replace(/[_\s-]+/g, '-'); // Normalize: "financial report" → "financial-report"

  // Direct match in map
  if (DOMAIN_TYPE_MAP[normalized]) {
    return DOMAIN_TYPE_MAP[normalized];
  }

  // Try without hyphens: "financial-report" → "financialreport"
  const noHyphens = normalized.replace(/-/g, '');
  if (DOMAIN_TYPE_MAP[noHyphens]) {
    return DOMAIN_TYPE_MAP[noHyphens];
  }

  // Fuzzy matching for common patterns
  if (normalized.includes('code') || normalized.includes('program')) {
    return 'code';
  }
  if (normalized.includes('markdown') || normalized.includes('md')) {
    return 'markdown';
  }
  if (normalized.includes('json') || normalized.includes('xml') || normalized.includes('yaml')) {
    return 'structured';
  }
  if (normalized.includes('pdf') || normalized.includes('doc')) {
    return 'multimodal';
  }

  // Default to null (will trigger content-based detection)
  return null;
}

/**
 * Detect document type from content patterns
 * Fallback when type cannot be determined from metadata
 *
 * @param content - Document content
 * @returns Detected DocumentType
 */
export function detectTypeFromContent(content: string): DocumentType {
  if (!content || content.length === 0) {
    return 'text';
  }

  const sample = content.substring(0, Math.min(content.length, 5000)); // Check first 5k chars

  // Check for code patterns
  const codePatterns = [
    /^import\s+/m,
    /^export\s+/m,
    /^function\s+\w+\s*\(/m,
    /^class\s+\w+/m,
    /^const\s+\w+\s*=/m,
    /^let\s+\w+\s*=/m,
    /^def\s+\w+\s*\(/m,
    /^public\s+class/m,
    /\{\s*\n.*\n\s*\}/s,
    /=>\s*\{/,
    /if\s*\([^)]+\)\s*\{/
  ];

  const codeScore = codePatterns.filter(p => p.test(sample)).length;
  if (codeScore >= 2) {
    return 'code';
  }

  // Check for markdown patterns
  const markdownPatterns = [
    /^#{1,6}\s+/m,
    /^\*\s+/m,
    /^-\s+/m,
    /^\d+\.\s+/m,
    /\[([^\]]+)\]\(([^)]+)\)/,
    /```[\s\S]*```/,
    /\*\*[^*]+\*\*/
  ];

  const markdownScore = markdownPatterns.filter(p => p.test(sample)).length;
  if (markdownScore >= 2) {
    return 'markdown';
  }

  // Check for structured data
  try {
    JSON.parse(content);
    return 'structured';
  } catch {}

  if (/<[^>]+>[\s\S]*<\/[^>]+>/.test(sample)) {
    return 'structured';
  }

  // Default to text
  return 'text';
}

/**
 * Validate and fix document type
 *
 * Strategies (in order):
 * 1. If type is already valid → use it
 * 2. Try mapping domain type → valid type
 * 3. Detect from content patterns
 *
 * @param type - Provided type (may be invalid)
 * @param content - Document content
 * @returns Valid DocumentType
 */
export function validateDocumentType(type: string | undefined, content: string): DocumentType {
  // Strategy 1: Type already valid
  if (type && VALID_DOCUMENT_TYPES.includes(type as DocumentType)) {
    return type as DocumentType;
  }

  // Strategy 2: Map domain type
  if (type) {
    const mapped = mapDomainToDocType(type);
    if (mapped) {
      logger.debug('Mapped domain type to valid DocumentType', {
        originalType: type,
        mappedType: mapped
      });
      return mapped;
    }

    logger.warn('Unknown document type, will use content detection', {
      providedType: type
    });
  }

  // Strategy 3: Detect from content
  const detected = detectTypeFromContent(content);
  logger.debug('Detected DocumentType from content', {
    detectedType: detected
  });

  return detected;
}

/**
 * Validate complete document input
 *
 * Performs comprehensive validation and sanitization:
 * - Validates required 'content' field
 * - Coerces version string → integer
 * - Maps domain types → valid DocumentType
 * - Detects type from content if needed
 * - Provides clear error messages
 *
 * @param input - Raw document input
 * @returns Validated and sanitized input ready for GraphRAG
 * @throws ValidationError if content is missing
 */
export function validateDocumentInput(input: RawDocumentInput): ValidatedDocumentInput {
  // Validate required content
  if (!input.content || typeof input.content !== 'string') {
    throw new ValidationError(
      'Document content is required and must be a string',
      'content',
      input.content
    );
  }

  if (input.content.trim().length === 0) {
    throw new ValidationError(
      'Document content cannot be empty',
      'content',
      input.content
    );
  }

  // Initialize metadata if not provided
  const metadata = input.metadata || {};

  // Validate and coerce version
  const validVersion = validateVersion(metadata.version);

  // Validate and fix document type
  const validType = validateDocumentType(metadata.type, input.content);

  // Build validated output
  const validated: ValidatedDocumentInput = {
    content: input.content,
    title: input.title,
    metadata: {
      ...metadata, // Preserve all other metadata fields
      type: validType,
      version: validVersion
    }
  };

  logger.info('Document input validated successfully', {
    originalType: metadata.type,
    validatedType: validType,
    originalVersion: metadata.version,
    validatedVersion: validVersion,
    contentLength: input.content.length
  });

  return validated;
}

/**
 * Get validation errors without throwing
 * Useful for pre-validation checks
 *
 * @param input - Document input to validate
 * @returns Array of error messages (empty if valid)
 */
export function getValidationErrors(input: RawDocumentInput): string[] {
  const errors: string[] = [];

  if (!input.content) {
    errors.push('Content is required');
  }

  if (typeof input.content !== 'string') {
    errors.push('Content must be a string');
  }

  if (input.content && input.content.trim().length === 0) {
    errors.push('Content cannot be empty');
  }

  return errors;
}
