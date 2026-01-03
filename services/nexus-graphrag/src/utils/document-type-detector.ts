/**
 * Document Type Detection Utility
 * Intelligently detects document type from content and metadata
 */

import { logger } from './logger';

// Valid document types for GraphRAG
export const VALID_DOCUMENT_TYPES = ['code', 'markdown', 'text', 'structured', 'multimodal'] as const;
export type DocumentType = typeof VALID_DOCUMENT_TYPES[number];

/**
 * Detect document type from file extension
 */
function detectTypeFromExtension(filename?: string): DocumentType | null {
  if (!filename) return null;

  const ext = filename.toLowerCase().split('.').pop();

  const extensionMap: Record<string, DocumentType> = {
    // Code files
    'js': 'code',
    'ts': 'code',
    'jsx': 'code',
    'tsx': 'code',
    'py': 'code',
    'java': 'code',
    'c': 'code',
    'cpp': 'code',
    'cs': 'code',
    'go': 'code',
    'rs': 'code',
    'php': 'code',
    'rb': 'code',
    'swift': 'code',
    'kt': 'code',
    'scala': 'code',
    'sh': 'code',
    'bash': 'code',
    'sql': 'code',
    'html': 'code',
    'css': 'code',
    'scss': 'code',
    'sass': 'code',
    'less': 'code',
    'vue': 'code',
    'svelte': 'code',

    // Markdown
    'md': 'markdown',
    'mdx': 'markdown',
    'markdown': 'markdown',

    // Text
    'txt': 'text',
    'log': 'text',
    'csv': 'text',
    'tsv': 'text',

    // Structured
    'json': 'structured',
    'xml': 'structured',
    'yaml': 'structured',
    'yml': 'structured',
    'toml': 'structured',
    'ini': 'structured',
    'conf': 'structured',
    'config': 'structured',

    // Multimodal (documents with potential mixed content)
    'pdf': 'multimodal',
    'doc': 'multimodal',
    'docx': 'multimodal',
    'ppt': 'multimodal',
    'pptx': 'multimodal',
    'xls': 'multimodal',
    'xlsx': 'multimodal',
    'odt': 'multimodal',
    'rtf': 'multimodal',
    'tex': 'multimodal',
  };

  return extensionMap[ext!] || null;
}

/**
 * Detect document type from content patterns
 */
function detectTypeFromContent(content: string): DocumentType {
  // Check for code patterns
  const codePatterns = [
    /^import\s+/m,
    /^export\s+/m,
    /^function\s+\w+\s*\(/m,
    /^class\s+\w+/m,
    /^const\s+\w+\s*=/m,
    /^let\s+\w+\s*=/m,
    /^var\s+\w+\s*=/m,
    /^def\s+\w+\s*\(/m,
    /^public\s+class/m,
    /^private\s+/m,
    /^protected\s+/m,
    /\{\s*\n.*\n\s*\}/s,
    /=>\s*\{/,
    /if\s*\([^)]+\)\s*\{/,
    /for\s*\([^)]+\)\s*\{/,
    /while\s*\([^)]+\)\s*\{/,
  ];

  if (codePatterns.some(pattern => pattern.test(content))) {
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
    /^\>\s+/m,
    /\*\*[^*]+\*\*/,
    /__[^_]+__/,
    /\*[^*]+\*/,
    /_[^_]+_/,
  ];

  if (markdownPatterns.some(pattern => pattern.test(content))) {
    return 'markdown';
  }

  // Check for structured data patterns
  try {
    JSON.parse(content);
    return 'structured';
  } catch {}

  // Check for XML/HTML
  if (/<[^>]+>[\s\S]*<\/[^>]+>/.test(content)) {
    return 'structured';
  }

  // Check for YAML-like patterns
  if (/^[\w-]+:\s*[\w\s]+$/m.test(content) && /^  [\w-]+:/m.test(content)) {
    return 'structured';
  }

  // Default to text
  return 'text';
}

/**
 * Map common type names to valid types
 */
function mapCommonTypeNames(type?: string): DocumentType | null {
  if (!type) return null;

  const normalizedType = type.toLowerCase().trim();

  const typeMap: Record<string, DocumentType> = {
    // Direct mappings
    'code': 'code',
    'markdown': 'markdown',
    'text': 'text',
    'structured': 'structured',
    'multimodal': 'multimodal',

    // Common aliases
    'source': 'code',
    'source-code': 'code',
    'program': 'code',
    'script': 'code',
    'plaintext': 'text',
    'plain-text': 'text',
    'txt': 'text',
    'md': 'markdown',
    'json': 'structured',
    'xml': 'structured',
    'yaml': 'structured',
    'data': 'structured',
    'config': 'structured',
    'configuration': 'structured',
    'mixed': 'multimodal',
    'document': 'multimodal',
    'doc': 'multimodal',
    'pdf': 'multimodal',
    'rich': 'multimodal',
    'richtext': 'multimodal',
    'rich-text': 'multimodal',

    // Technical document types
    'technical': 'text',
    'documentation': 'markdown',
    'readme': 'markdown',
    'tutorial': 'markdown',
    'guide': 'markdown',
    'manual': 'text',
    'report': 'text',
    'article': 'text',
    'paper': 'text',
    'note': 'text',
    'notes': 'text',
    'memo': 'text',
  };

  return typeMap[normalizedType] || null;
}

/**
 * Intelligently detect document type with multiple strategies
 */
export function detectDocumentType(
  content: string,
  metadata?: {
    type?: string;
    filename?: string;
    source?: string;
    format?: string;
    [key: string]: any;
  }
): { type: DocumentType; confidence: number; reason: string } {
  let detectedType: DocumentType | null = null;
  // Confidence and reason calculated below based on detection strategy

  // Strategy 1: Check if type is already valid
  if (metadata?.type && VALID_DOCUMENT_TYPES.includes(metadata.type as DocumentType)) {
    return {
      type: metadata.type as DocumentType,
      confidence: 1.0,
      reason: 'Type provided is already valid'
    };
  }

  // Strategy 2: Try to map common type names
  if (metadata?.type) {
    detectedType = mapCommonTypeNames(metadata.type);
    if (detectedType) {
      return {
        type: detectedType,
        confidence: 0.95,
        reason: `Mapped type '${metadata.type}' to '${detectedType}'`
      };
    }
  }

  // Strategy 3: Detect from filename/source
  if (metadata?.filename || metadata?.source) {
    const filename = metadata.filename || metadata.source;
    detectedType = detectTypeFromExtension(filename);
    if (detectedType) {
      return {
        type: detectedType,
        confidence: 0.9,
        reason: `Detected from filename: ${filename}`
      };
    }
  }

  // Strategy 4: Detect from format field
  if (metadata?.format) {
    detectedType = mapCommonTypeNames(metadata.format);
    if (detectedType) {
      return {
        type: detectedType,
        confidence: 0.85,
        reason: `Detected from format: ${metadata.format}`
      };
    }
  }

  // Strategy 5: Detect from content patterns
  detectedType = detectTypeFromContent(content);
  return {
    type: detectedType,
    confidence: 0.7,
    reason: 'Detected from content analysis'
  };
}

/**
 * Get helpful error message for invalid type
 */
export function getTypeValidationError(providedType?: string): string {
  const validTypes = VALID_DOCUMENT_TYPES.join("', '");

  if (!providedType) {
    return `Document type is required. Valid types are: '${validTypes}'`;
  }

  // Check if it's a common mistake
  const suggestion = mapCommonTypeNames(providedType);
  if (suggestion) {
    return `Invalid document type '${providedType}'. Did you mean '${suggestion}'? Valid types are: '${validTypes}'`;
  }

  return `Invalid document type '${providedType}'. Valid types are: '${validTypes}'`;
}

/**
 * Validate and fix document type
 */
export function validateAndFixDocumentType(
  type?: string,
  content?: string,
  metadata?: any
): { isValid: boolean; type?: DocumentType; error?: string } {
  // If type is already valid, return it
  if (type && VALID_DOCUMENT_TYPES.includes(type as DocumentType)) {
    return { isValid: true, type: type as DocumentType };
  }

  // Try to detect the type
  if (content) {
    const detection = detectDocumentType(content, { ...metadata, type });
    logger.info('Document type detection', {
      providedType: type,
      detectedType: detection.type,
      confidence: detection.confidence,
      reason: detection.reason
    });

    return { isValid: true, type: detection.type };
  }

  // Cannot detect without content
  return {
    isValid: false,
    error: getTypeValidationError(type)
  };
}