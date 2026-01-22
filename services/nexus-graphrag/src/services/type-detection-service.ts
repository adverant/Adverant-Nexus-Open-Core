/**
 * Type Detection Service
 *
 * Implements the document type detection cascade for the Universal Document Viewer.
 * Detection methods (in order):
 * 1. Explicit metadata (document.type from database)
 * 2. File extension mapping (.pdf, .docx, etc.)
 * 3. MIME type analysis (application/pdf, text/markdown)
 * 4. Magic bytes detection (first 8-16 bytes of content)
 * 5. Content sniffing (regex patterns for JSON, XML, LaTeX, code)
 * 6. Default: unknown → fallback
 *
 * Also provides renderer and theme suggestions based on detected type.
 */

import { DocumentType, RendererType, ThemeType, TypeDetectionResult } from '../types';
import { logger } from '../utils/logger';

// ============================================================================
// MAGIC BYTES SIGNATURES
// ============================================================================

const MAGIC_BYTES: Array<{ bytes: number[]; type: DocumentType; description: string }> = [
  // PDF
  { bytes: [0x25, 0x50, 0x44, 0x46], type: 'pdf', description: '%PDF-' },

  // Office documents (ZIP-based)
  { bytes: [0x50, 0x4b, 0x03, 0x04], type: 'word', description: 'PK.. (ZIP/DOCX/XLSX/PPTX)' },

  // PNG
  { bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], type: 'image', description: 'PNG' },

  // JPEG
  { bytes: [0xff, 0xd8, 0xff], type: 'image', description: 'JPEG' },

  // GIF
  { bytes: [0x47, 0x49, 0x46, 0x38], type: 'image', description: 'GIF8' },

  // WebP
  { bytes: [0x52, 0x49, 0x46, 0x46], type: 'image', description: 'RIFF (WebP)' },
];

// ============================================================================
// FILE EXTENSION MAPPING
// ============================================================================

const EXTENSION_MAP: Record<string, DocumentType> = {
  // Documents
  pdf: 'pdf',
  doc: 'word',
  docx: 'word',
  odt: 'word',
  rtf: 'word',

  // Spreadsheets
  xls: 'excel',
  xlsx: 'excel',
  csv: 'excel',
  tsv: 'excel',

  // Presentations
  ppt: 'powerpoint',
  pptx: 'powerpoint',

  // Markup
  md: 'markdown',
  markdown: 'markdown',
  mdx: 'markdown',

  // LaTeX
  tex: 'latex',
  latex: 'latex',

  // Code
  js: 'code',
  jsx: 'code',
  ts: 'code',
  tsx: 'code',
  py: 'code',
  java: 'code',
  cpp: 'code',
  c: 'code',
  h: 'code',
  hpp: 'code',
  cs: 'code',
  go: 'code',
  rs: 'code',
  rb: 'code',
  php: 'code',
  swift: 'code',
  kt: 'code',
  scala: 'code',
  sh: 'code',
  bash: 'code',
  sql: 'code',
  html: 'code',
  css: 'code',
  scss: 'code',
  less: 'code',

  // Structured data
  json: 'json',
  yaml: 'yaml',
  yml: 'yaml',
  xml: 'xml',
  toml: 'json',

  // Images
  png: 'image',
  jpg: 'image',
  jpeg: 'image',
  gif: 'image',
  svg: 'image',
  webp: 'image',
  bmp: 'image',
  ico: 'image',

  // Plain text
  txt: 'text',
  text: 'text',
  log: 'text',
};

// ============================================================================
// MIME TYPE MAPPING
// ============================================================================

const MIME_MAP: Record<string, DocumentType> = {
  // Documents
  'application/pdf': 'pdf',
  'application/msword': 'word',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'word',
  'application/vnd.oasis.opendocument.text': 'word',

  // Spreadsheets
  'application/vnd.ms-excel': 'excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'excel',
  'text/csv': 'excel',
  'text/tab-separated-values': 'excel',

  // Presentations
  'application/vnd.ms-powerpoint': 'powerpoint',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'powerpoint',

  // Markup
  'text/markdown': 'markdown',
  'text/x-markdown': 'markdown',

  // Code
  'text/javascript': 'code',
  'application/javascript': 'code',
  'text/typescript': 'code',
  'text/x-python': 'code',
  'text/x-java': 'code',
  'text/x-c': 'code',
  'text/x-c++src': 'code',
  'text/x-go': 'code',
  'text/x-rustsrc': 'code',
  'text/html': 'code',
  'text/css': 'code',

  // Structured data
  'application/json': 'json',
  'application/x-yaml': 'yaml',
  'text/yaml': 'yaml',
  'application/xml': 'xml',
  'text/xml': 'xml',

  // Images
  'image/png': 'image',
  'image/jpeg': 'image',
  'image/gif': 'image',
  'image/svg+xml': 'image',
  'image/webp': 'image',

  // Plain text
  'text/plain': 'text',
};

// ============================================================================
// CONTENT PATTERN DETECTION
// ============================================================================

const CONTENT_PATTERNS: Array<{ pattern: RegExp; type: DocumentType; confidence: number }> = [
  // JSON (strict)
  { pattern: /^\s*[\[{][\s\S]*[\]}]\s*$/, type: 'json', confidence: 0.9 },

  // YAML
  { pattern: /^---[\s\S]*?(\n---|$)/, type: 'yaml', confidence: 0.85 },
  { pattern: /^[a-zA-Z_][a-zA-Z0-9_]*:\s+.+$/m, type: 'yaml', confidence: 0.7 },

  // XML
  { pattern: /^\s*<\?xml[\s\S]*\?>/, type: 'xml', confidence: 0.95 },
  { pattern: /^\s*<[a-zA-Z][^>]*>[\s\S]*<\/[a-zA-Z][^>]*>\s*$/, type: 'xml', confidence: 0.8 },

  // LaTeX
  { pattern: /\\documentclass(\[.*?\])?\{.*?\}/, type: 'latex', confidence: 0.95 },
  { pattern: /\\begin\{document\}/, type: 'latex', confidence: 0.95 },
  { pattern: /\\(usepackage|section|subsection|chapter|maketitle|title|author)/, type: 'latex', confidence: 0.8 },

  // Markdown
  { pattern: /^#{1,6}\s+.+$/m, type: 'markdown', confidence: 0.6 },
  { pattern: /^[\*\-]\s+.+$/m, type: 'markdown', confidence: 0.4 },
  { pattern: /\[.+\]\(.+\)/, type: 'markdown', confidence: 0.5 },
  { pattern: /```[\s\S]*?```/, type: 'markdown', confidence: 0.7 },

  // Code patterns
  { pattern: /(function|const|let|var|class|import|export|require)\s+/, type: 'code', confidence: 0.6 },
  { pattern: /(def|class|import|from|if|else|elif|return)\s+/, type: 'code', confidence: 0.6 },
  { pattern: /(public|private|protected|class|interface|implements)\s+/, type: 'code', confidence: 0.6 },
];

// ============================================================================
// TYPE DETECTION SERVICE
// ============================================================================

export class TypeDetectionService {
  /**
   * Full type detection cascade
   */
  async detectType(
    content: string | Buffer,
    filename?: string,
    mimeType?: string,
    explicitType?: DocumentType
  ): Promise<TypeDetectionResult> {
    const detectionMethods: string[] = [];
    let detectedType: DocumentType = 'unknown';
    let confidence = 0;

    // 1. Explicit metadata (highest priority)
    if (explicitType) {
      detectedType = explicitType;
      confidence = 1.0;
      detectionMethods.push('explicit-metadata');
      logger.debug('Type detected via explicit metadata', { type: explicitType });
    }

    // 2. File extension mapping
    if (confidence < 0.9 && filename) {
      const extension = this.getFileExtension(filename);
      if (extension && EXTENSION_MAP[extension]) {
        detectedType = EXTENSION_MAP[extension];
        confidence = 0.85;
        detectionMethods.push('file-extension');
        logger.debug('Type detected via file extension', { extension, type: detectedType });
      }
    }

    // 3. MIME type analysis
    if (confidence < 0.9 && mimeType) {
      const typeFromMime = MIME_MAP[mimeType.toLowerCase()];
      if (typeFromMime) {
        detectedType = typeFromMime;
        confidence = 0.8;
        detectionMethods.push('mime-type');
        logger.debug('Type detected via MIME type', { mimeType, type: detectedType });
      }
    }

    // 4. Magic bytes detection (for binary content)
    if (confidence < 0.9 && Buffer.isBuffer(content)) {
      const magicResult = this.getMagicBytes(content);
      if (magicResult) {
        detectedType = magicResult.type;
        confidence = 0.95;
        detectionMethods.push('magic-bytes');
        logger.debug('Type detected via magic bytes', magicResult);
      }
    }

    // 5. Content sniffing (for text content)
    if (confidence < 0.9 && typeof content === 'string') {
      const sniffResult = this.sniffContent(content);
      if (sniffResult && sniffResult.confidence > confidence) {
        detectedType = sniffResult.type;
        confidence = sniffResult.confidence;
        detectionMethods.push('content-sniffing');
        logger.debug('Type detected via content sniffing', sniffResult);
      }
    }

    // 6. Default to unknown
    if (detectionMethods.length === 0) {
      detectionMethods.push('default-unknown');
    }

    const rendering = this.getSuggestedRenderingForType(detectedType);

    return {
      detectedType,
      confidence,
      suggestedRenderer: rendering.renderer,
      suggestedTheme: rendering.theme,
      detectionMethods,
    };
  }

  /**
   * Detect type from magic bytes (first few bytes of file)
   */
  getMagicBytes(buffer: Buffer): { type: DocumentType; description: string } | null {
    for (const signature of MAGIC_BYTES) {
      let matches = true;

      for (let i = 0; i < signature.bytes.length; i++) {
        if (buffer[i] !== signature.bytes[i]) {
          matches = false;
          break;
        }
      }

      if (matches) {
        return {
          type: signature.type,
          description: signature.description,
        };
      }
    }

    return null;
  }

  /**
   * Sniff content using regex patterns
   */
  sniffContent(content: string): { type: DocumentType; confidence: number } | null {
    // Limit content length for performance
    const sampleLength = Math.min(content.length, 5000);
    const sample = content.substring(0, sampleLength);

    let bestMatch: { type: DocumentType; confidence: number } | null = null;

    for (const pattern of CONTENT_PATTERNS) {
      if (pattern.pattern.test(sample)) {
        if (!bestMatch || pattern.confidence > bestMatch.confidence) {
          bestMatch = {
            type: pattern.type,
            confidence: pattern.confidence,
          };
        }
      }
    }

    return bestMatch;
  }

  /**
   * Get suggested renderer and theme for document type
   */
  getSuggestedRenderer(type: DocumentType): RendererType {
    const rendererMap: Record<DocumentType, RendererType> = {
      pdf: 'pdf',
      markdown: 'markdown',
      code: 'code',
      latex: 'latex',
      word: 'word',
      excel: 'spreadsheet',
      powerpoint: 'presentation',
      json: 'structured-data',
      yaml: 'structured-data',
      xml: 'structured-data',
      image: 'image',
      'google-docs': 'google-docs',
      text: 'markdown',
      unknown: 'fallback',
    };

    return rendererMap[type] || 'fallback';
  }

  /**
   * Get suggested theme for document type
   */
  getSuggestedTheme(type: DocumentType): ThemeType {
    const themeMap: Record<DocumentType, ThemeType> = {
      pdf: 'immersive',
      markdown: 'minimal',
      code: 'vscode',
      latex: 'immersive',
      word: 'professional',
      excel: 'professional',
      powerpoint: 'immersive',
      json: 'vscode',
      yaml: 'vscode',
      xml: 'vscode',
      image: 'gallery',
      'google-docs': 'professional',
      text: 'minimal',
      unknown: 'minimal',
    };

    return themeMap[type] || 'minimal';
  }

  /**
   * Get suggested rendering (renderer + theme)
   */
  getSuggestedRenderingForType(type: DocumentType): { renderer: RendererType; theme: ThemeType } {
    return {
      renderer: this.getSuggestedRenderer(type),
      theme: this.getSuggestedTheme(type),
    };
  }

  /**
   * Extract file extension from filename
   */
  private getFileExtension(filename: string): string | null {
    const match = filename.match(/\.([^.]+)$/);
    return match ? match[1].toLowerCase() : null;
  }

  /**
   * Validate detected type against content
   */
  validateTypeAgainstContent(
    detectedType: DocumentType,
    content: string | Buffer
  ): { valid: boolean; alternativeSuggestion?: DocumentType } {
    // For now, trust the detection cascade
    // Future: Add validation logic to catch misdetections
    return { valid: true };
  }
}

/**
 * Singleton instance for convenience
 */
export const typeDetectionService = new TypeDetectionService();
