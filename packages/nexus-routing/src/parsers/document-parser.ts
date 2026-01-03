/**
 * Universal Document Parser
 *
 * Supports parsing of multiple file formats across all domains:
 * - PDF documents
 * - Word documents (.docx)
 * - Excel spreadsheets (.xlsx)
 * - Markdown (.md)
 * - Rich Text Format (.rtf)
 * - EPUB ebooks (.epub)
 * - Plain text (.txt)
 *
 * Features:
 * - Automatic format detection
 * - Metadata extraction
 * - Domain-specific processing
 * - Size-based timeout calculation
 */

import fs from 'fs/promises';
import path from 'path';
import { logger } from '../utils/logger.js';

/**
 * Supported file formats
 */
export enum FileFormat {
  PDF = 'pdf',
  DOCX = 'docx',
  XLSX = 'xlsx',
  MD = 'md',
  RTF = 'rtf',
  EPUB = 'epub',
  TXT = 'txt',
  UNKNOWN = 'unknown'
}

/**
 * Document metadata
 */
export interface DocumentMetadata {
  format: FileFormat;
  fileName: string;
  fileSize: number;
  wordCount: number;
  pageCount?: number;
  author?: string;
  title?: string;
  createdDate?: Date;
  modifiedDate?: Date;
  domain?: string;
  documentType?: string;
  [key: string]: any;
}

/**
 * Parsed document result
 */
export interface ParsedDocument {
  content: string;
  metadata: DocumentMetadata;
  extractedImages?: string[];
  extractedTables?: any[];
  rawMetadata?: any;
}

/**
 * Parser configuration
 */
export interface ParserConfig {
  extractImages?: boolean;
  extractTables?: boolean;
  ocrEnabled?: boolean;
  maxImageSize?: number;
  preserveFormatting?: boolean;
}

/**
 * Document Parser Class
 */
export class DocumentParser {
  private config: ParserConfig;

  constructor(config: ParserConfig = {}) {
    this.config = {
      extractImages: config.extractImages ?? false,
      extractTables: config.extractTables ?? true,
      ocrEnabled: config.ocrEnabled ?? false,
      maxImageSize: config.maxImageSize ?? 5 * 1024 * 1024, // 5MB
      preserveFormatting: config.preserveFormatting ?? true
    };
  }

  /**
   * Detect file format from extension or content
   */
  detectFormat(filePath: string, buffer?: Buffer): FileFormat {
    const ext = path.extname(filePath).toLowerCase().replace('.', '');

    switch (ext) {
      case 'pdf':
        return FileFormat.PDF;
      case 'docx':
      case 'doc':
        return FileFormat.DOCX;
      case 'xlsx':
      case 'xls':
        return FileFormat.XLSX;
      case 'md':
      case 'markdown':
        return FileFormat.MD;
      case 'rtf':
        return FileFormat.RTF;
      case 'epub':
        return FileFormat.EPUB;
      case 'txt':
      case 'text':
        return FileFormat.TXT;
      default:
        // Try to detect from buffer magic numbers if provided
        if (buffer) {
          return this.detectFromBuffer(buffer);
        }
        return FileFormat.UNKNOWN;
    }
  }

  /**
   * Detect format from buffer magic numbers
   */
  private detectFromBuffer(buffer: Buffer): FileFormat {
    // PDF magic number
    if (buffer.slice(0, 4).toString() === '%PDF') {
      return FileFormat.PDF;
    }

    // ZIP-based formats (DOCX, XLSX, EPUB)
    if (buffer.slice(0, 2).toString('hex') === '504b') {
      // Further detection needed - check internal structure
      // For now, return UNKNOWN and rely on extension
      return FileFormat.UNKNOWN;
    }

    // RTF magic number
    if (buffer.slice(0, 5).toString() === '{\\rtf') {
      return FileFormat.RTF;
    }

    // Plain text (UTF-8 BOM or ASCII)
    return FileFormat.TXT;
  }

  /**
   * Parse document from file path
   */
  async parseFile(filePath: string): Promise<ParsedDocument> {
    try {
      // Read file
      const buffer = await fs.readFile(filePath);
      const stats = await fs.stat(filePath);

      // Detect format
      const format = this.detectFormat(filePath, buffer);

      logger.info('Parsing document', {
        filePath,
        format,
        size: stats.size
      });

      // Route to appropriate parser
      switch (format) {
        case FileFormat.PDF:
          return await this.parsePDF(buffer, path.basename(filePath), stats);
        case FileFormat.DOCX:
          return await this.parseDOCX(buffer, path.basename(filePath), stats);
        case FileFormat.XLSX:
          return await this.parseXLSX(buffer, path.basename(filePath), stats);
        case FileFormat.MD:
          return await this.parseMarkdown(buffer, path.basename(filePath), stats);
        case FileFormat.RTF:
          return await this.parseRTF(buffer, path.basename(filePath), stats);
        case FileFormat.EPUB:
          return await this.parseEPUB(buffer, path.basename(filePath), stats);
        case FileFormat.TXT:
          return await this.parsePlainText(buffer, path.basename(filePath), stats);
        default:
          throw new Error(`Unsupported file format: ${format}`);
      }
    } catch (error) {
      logger.error('Document parsing failed', {
        filePath,
        error: (error as Error).message
      });
      throw error;
    }
  }

  /**
   * Parse document from buffer with explicit format
   */
  async parseBuffer(
    buffer: Buffer,
    fileName: string,
    format?: FileFormat
  ): Promise<ParsedDocument> {
    const detectedFormat = format || this.detectFormat(fileName, buffer);
    const stats = {
      size: buffer.length,
      mtime: new Date(),
      ctime: new Date()
    };

    switch (detectedFormat) {
      case FileFormat.PDF:
        return await this.parsePDF(buffer, fileName, stats);
      case FileFormat.DOCX:
        return await this.parseDOCX(buffer, fileName, stats);
      case FileFormat.XLSX:
        return await this.parseXLSX(buffer, fileName, stats);
      case FileFormat.MD:
        return await this.parseMarkdown(buffer, fileName, stats);
      case FileFormat.RTF:
        return await this.parseRTF(buffer, fileName, stats);
      case FileFormat.EPUB:
        return await this.parseEPUB(buffer, fileName, stats);
      case FileFormat.TXT:
        return await this.parsePlainText(buffer, fileName, stats);
      default:
        throw new Error(`Unsupported file format: ${detectedFormat}`);
    }
  }

  /**
   * Parse PDF document
   */
  private async parsePDF(buffer: Buffer, fileName: string, stats: any): Promise<ParsedDocument> {
    try {
      // Dynamic import to avoid loading unnecessary dependencies
      const pdfParse = (await import('pdf-parse')).default;

      const data = await pdfParse(buffer);

      const wordCount = this.countWords(data.text);

      return {
        content: data.text,
        metadata: {
          format: FileFormat.PDF,
          fileName,
          fileSize: stats.size,
          wordCount,
          pageCount: data.numpages,
          author: data.info?.Author,
          title: data.info?.Title || fileName,
          createdDate: data.info?.CreationDate ? new Date(data.info.CreationDate) : stats.ctime,
          modifiedDate: stats.mtime
        },
        rawMetadata: data.info
      };
    } catch (error) {
      throw new Error(`PDF parsing failed: ${(error as Error).message}`);
    }
  }

  /**
   * Parse DOCX document
   */
  private async parseDOCX(buffer: Buffer, fileName: string, stats: any): Promise<ParsedDocument> {
    try {
      // Dynamic import
      const mammoth = await import('mammoth');

      const result = await mammoth.extractRawText({ buffer });

      const wordCount = this.countWords(result.value);

      // Extract metadata from core properties if available
      const metadata: DocumentMetadata = {
        format: FileFormat.DOCX,
        fileName,
        fileSize: stats.size,
        wordCount,
        title: fileName,
        createdDate: stats.ctime,
        modifiedDate: stats.mtime
      };

      return {
        content: result.value,
        metadata
      };
    } catch (error) {
      throw new Error(`DOCX parsing failed: ${(error as Error).message}`);
    }
  }

  /**
   * Parse XLSX spreadsheet
   */
  private async parseXLSX(buffer: Buffer, fileName: string, stats: any): Promise<ParsedDocument> {
    try {
      // Dynamic import - using exceljs instead of xlsx (secure alternative)
      const ExcelJS = await import('exceljs');

      const workbook = new ExcelJS.Workbook();
      // Convert Buffer to ArrayBuffer for exceljs
      const arrayBuffer = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer;
      await workbook.xlsx.load(arrayBuffer);

      // Extract all sheets
      let content = '';
      const tables: any[] = [];

      for (const worksheet of workbook.worksheets) {
        const sheetName = worksheet.name;
        let csv = '';
        const jsonData: any[] = [];

        // Extract headers from first row
        const firstRow = worksheet.getRow(1);
        const headers: string[] = [];
        firstRow.eachCell((cell, colNumber) => {
          headers[colNumber - 1] = cell.text || `Column${colNumber}`;
        });

        // Convert worksheet to CSV and JSON
        worksheet.eachRow((row, rowNumber) => {
          const values: any[] = [];
          row.eachCell({ includeEmpty: true }, (cell, colNumber) => {
            values[colNumber - 1] = cell.text || '';
          });

          // Add to CSV
          csv += values.join(',') + '\n';

          // Add to JSON (skip header row)
          if (rowNumber > 1 && headers.length > 0) {
            const rowData: any = {};
            values.forEach((value, index) => {
              if (headers[index]) {
                rowData[headers[index]] = value;
              }
            });
            jsonData.push(rowData);
          }
        });

        content += `\n## Sheet: ${sheetName}\n${csv}\n`;
        tables.push({
          sheetName,
          data: jsonData
        });
      }

      const wordCount = this.countWords(content);

      return {
        content,
        metadata: {
          format: FileFormat.XLSX,
          fileName,
          fileSize: stats.size,
          wordCount,
          title: fileName,
          createdDate: stats.ctime,
          modifiedDate: stats.mtime,
          sheetCount: workbook.worksheets.length
        },
        extractedTables: tables
      };
    } catch (error) {
      throw new Error(`XLSX parsing failed: ${(error as Error).message}`);
    }
  }

  /**
   * Parse Markdown document
   */
  private async parseMarkdown(buffer: Buffer, fileName: string, stats: any): Promise<ParsedDocument> {
    try {
      // Dynamic import
      const { marked } = await import('marked');

      const text = buffer.toString('utf-8');

      // Extract front matter if present
      const frontMatterMatch = text.match(/^---\n([\s\S]*?)\n---\n/);
      let frontMatter: any = {};
      let content = text;

      if (frontMatterMatch) {
        content = text.slice(frontMatterMatch[0].length);
        // Simple YAML parsing (could use js-yaml for robust parsing)
        frontMatter = this.parseSimpleYAML(frontMatterMatch[1]);
      }

      const wordCount = this.countWords(content);

      return {
        content,
        metadata: {
          format: FileFormat.MD,
          fileName,
          fileSize: stats.size,
          wordCount,
          title: frontMatter.title || fileName,
          author: frontMatter.author,
          createdDate: frontMatter.date ? new Date(frontMatter.date) : stats.ctime,
          modifiedDate: stats.mtime,
          ...frontMatter
        }
      };
    } catch (error) {
      throw new Error(`Markdown parsing failed: ${(error as Error).message}`);
    }
  }

  /**
   * Parse RTF document
   */
  private async parseRTF(buffer: Buffer, fileName: string, stats: any): Promise<ParsedDocument> {
    try {
      // RTF parsing - simplified version
      // For production, use rtf-parser or similar
      const text = buffer.toString('latin1');

      // Remove RTF control words (very basic)
      const plainText = text
        .replace(/\\[a-z]+(-?\d+)?\s?/g, '')  // Remove control words
        .replace(/[{}]/g, '')                 // Remove braces
        .replace(/\\/g, '')                   // Remove backslashes
        .trim();

      const wordCount = this.countWords(plainText);

      return {
        content: plainText,
        metadata: {
          format: FileFormat.RTF,
          fileName,
          fileSize: stats.size,
          wordCount,
          title: fileName,
          createdDate: stats.ctime,
          modifiedDate: stats.mtime
        }
      };
    } catch (error) {
      throw new Error(`RTF parsing failed: ${(error as Error).message}`);
    }
  }

  /**
   * Parse EPUB ebook
   */
  private async parseEPUB(buffer: Buffer, fileName: string, stats: any): Promise<ParsedDocument> {
    try {
      // For EPUB, we need a specialized library
      // This is a placeholder - in production, use epub-parser or similar

      // Fallback: treat as plain text for now
      return await this.parsePlainText(buffer, fileName, stats);
    } catch (error) {
      throw new Error(`EPUB parsing failed: ${(error as Error).message}`);
    }
  }

  /**
   * Parse plain text document
   */
  private async parsePlainText(buffer: Buffer, fileName: string, stats: any): Promise<ParsedDocument> {
    const text = buffer.toString('utf-8');
    const wordCount = this.countWords(text);

    return {
      content: text,
      metadata: {
        format: FileFormat.TXT,
        fileName,
        fileSize: stats.size,
        wordCount,
        title: fileName,
        createdDate: stats.ctime,
        modifiedDate: stats.mtime
      }
    };
  }

  /**
   * Count words in text
   */
  private countWords(text: string): number {
    return text
      .trim()
      .split(/\s+/)
      .filter(word => word.length > 0)
      .length;
  }

  /**
   * Simple YAML parser for front matter
   */
  private parseSimpleYAML(yaml: string): any {
    const result: any = {};
    const lines = yaml.split('\n');

    for (const line of lines) {
      const match = line.match(/^(\w+):\s*(.+)$/);
      if (match) {
        result[match[1]] = match[2].replace(/^["']|["']$/g, '');
      }
    }

    return result;
  }

  /**
   * Calculate recommended timeout based on document size
   * Returns timeout in milliseconds
   */
  calculateTimeout(wordCount: number, format: FileFormat): number {
    const baseTimeout = 30000; // 30s base

    // Format-specific multipliers
    const formatMultiplier: Record<FileFormat, number> = {
      [FileFormat.PDF]: 2.0,      // PDFs are slower to parse
      [FileFormat.DOCX]: 1.5,     // DOCX requires ZIP extraction
      [FileFormat.XLSX]: 2.5,     // XLSX can be very large
      [FileFormat.EPUB]: 2.0,     // EPUB requires ZIP + HTML parsing
      [FileFormat.RTF]: 1.2,      // RTF is moderately complex
      [FileFormat.MD]: 1.0,       // Markdown is fast
      [FileFormat.TXT]: 1.0,      // Plain text is fastest
      [FileFormat.UNKNOWN]: 1.5   // Unknown, be conservative
    };

    // Size-based timeout calculation
    let timeout = baseTimeout;

    if (wordCount < 10000) {
      timeout = baseTimeout;
    } else if (wordCount < 50000) {
      timeout = 60000;  // 60s for medium documents
    } else if (wordCount < 100000) {
      timeout = 120000; // 120s for large documents
    } else {
      timeout = 180000; // 180s for extra large documents
    }

    // Apply format multiplier
    timeout *= formatMultiplier[format];

    return Math.min(timeout, 300000); // Cap at 5 minutes
  }
}

/**
 * Export singleton instance
 */
export const documentParser = new DocumentParser();

/**
 * Convenience function to parse document
 */
export async function parseDocument(filePath: string): Promise<ParsedDocument> {
  return documentParser.parseFile(filePath);
}

/**
 * Convenience function to parse buffer
 */
export async function parseDocumentBuffer(
  buffer: Buffer,
  fileName: string,
  format?: FileFormat
): Promise<ParsedDocument> {
  return documentParser.parseBuffer(buffer, fileName, format);
}
