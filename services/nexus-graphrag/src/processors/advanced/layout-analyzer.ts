/**
 * Layout Analyzer
 *
 * Analyzes document structure and extracts layout information
 * for preservation in Document DNA structural layer.
 */

import { LayoutElement } from '../../types/document-dna';

export class LayoutAnalyzer {
  /**
   * Analyze text and extract layout structure
   */
  async analyze(text: string): Promise<LayoutElement[]> {
    const elements: LayoutElement[] = [];
    const lines = text.split('\n');

    let currentParagraph: string[] = [];
    let inCodeBlock = false;
    let inTable = false;
    let tableRows: string[] = [];

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const trimmedLine = line.trim();

      // Detect code blocks
      if (line.startsWith('```')) {
        if (inCodeBlock) {
          // End code block
          elements.push({
            type: 'code',
            content: currentParagraph.join('\n'),
            metadata: { language: line.replace('```', '').trim() }
          });
          currentParagraph = [];
          inCodeBlock = false;
        } else {
          // Start code block
          this.flushParagraph(elements, currentParagraph);
          currentParagraph = [];
          inCodeBlock = true;
        }
        continue;
      }

      if (inCodeBlock) {
        currentParagraph.push(line);
        continue;
      }

      // Detect headers (Markdown style)
      if (trimmedLine.startsWith('#')) {
        this.flushParagraph(elements, currentParagraph);
        currentParagraph = [];

        const level = trimmedLine.match(/^#+/)?.[0].length || 1;
        elements.push({
          type: 'header',
          content: trimmedLine.replace(/^#+\s*/, ''),
          level: Math.min(level, 6)
        });
        continue;
      }

      // Detect tables (simple pipe-delimited)
      if (trimmedLine.includes('|') && trimmedLine.split('|').length > 2) {
        if (!inTable) {
          this.flushParagraph(elements, currentParagraph);
          currentParagraph = [];
          inTable = true;
          tableRows = [];
        }
        tableRows.push(trimmedLine);
        continue;
      } else if (inTable) {
        // End of table
        elements.push(this.parseTable(tableRows));
        tableRows = [];
        inTable = false;
      }

      // Detect lists
      if (trimmedLine.match(/^[\*\-\+]\s/) || trimmedLine.match(/^\d+\.\s/)) {
        this.flushParagraph(elements, currentParagraph);
        currentParagraph = [];

        // Collect all list items
        const listItems: string[] = [trimmedLine];
        while (i + 1 < lines.length) {
          const nextLine = lines[i + 1].trim();
          if (nextLine.match(/^[\*\-\+]\s/) || nextLine.match(/^\d+\.\s/) || nextLine.startsWith('  ')) {
            listItems.push(lines[++i]);
          } else {
            break;
          }
        }

        elements.push({
          type: 'list',
          content: listItems.join('\n'),
          metadata: { ordered: trimmedLine.match(/^\d+\.\s/) !== null }
        });
        continue;
      }

      // Detect empty lines (paragraph breaks)
      if (!trimmedLine) {
        this.flushParagraph(elements, currentParagraph);
        currentParagraph = [];
        continue;
      }

      // Regular text - add to current paragraph
      currentParagraph.push(line);
    }

    // Flush any remaining content
    this.flushParagraph(elements, currentParagraph);

    if (inTable && tableRows.length > 0) {
      elements.push(this.parseTable(tableRows));
    }

    return elements;
  }

  /**
   * Extract layout from HTML content
   */
  async analyzeHTML(html: string): Promise<LayoutElement[]> {
    const elements: LayoutElement[] = [];

    // Simple regex-based HTML parsing
    // In production, use a proper HTML parser like cheerio

    // Extract headers
    const headerMatches = html.matchAll(/<h([1-6])[^>]*>(.*?)<\/h\1>/gi);
    for (const match of headerMatches) {
      elements.push({
        type: 'header',
        level: parseInt(match[1]),
        content: this.stripHTML(match[2])
      });
    }

    // Extract paragraphs
    const paragraphMatches = html.matchAll(/<p[^>]*>(.*?)<\/p>/gi);
    for (const match of paragraphMatches) {
      elements.push({
        type: 'paragraph',
        content: this.stripHTML(match[1])
      });
    }

    // Extract tables
    const tableMatches = html.matchAll(/<table[^>]*>(.*?)<\/table>/gis);
    for (const match of tableMatches) {
      elements.push({
        type: 'table',
        content: this.stripHTML(match[1])
      });
    }

    // Extract lists
    const listMatches = html.matchAll(/<(ul|ol)[^>]*>(.*?)<\/\1>/gis);
    for (const match of listMatches) {
      elements.push({
        type: 'list',
        content: this.stripHTML(match[2]),
        metadata: { ordered: match[1] === 'ol' }
      });
    }

    return elements;
  }

  /**
   * Detect layout patterns using heuristics
   */
  detectLayoutPatterns(elements: LayoutElement[]): {
    hasMultiColumn: boolean;
    hasSidebar: boolean;
    hasFootnotes: boolean;
    documentStructure: string;
  } {
    const headerLevels = elements
      .filter(e => e.type === 'header')
      .map(e => e.level || 1);

    const hasMultiColumn = this.detectMultiColumnLayout(elements);
    const hasSidebar = this.detectSidebarLayout(elements);
    const hasFootnotes = elements.some(e =>
      e.content?.match(/^\[\d+\]/) || e.content?.includes('footnote')
    );

    let documentStructure = 'simple';
    if (headerLevels.length > 5 && headerLevels.includes(1) && headerLevels.includes(2)) {
      documentStructure = 'hierarchical';
    }
    if (elements.filter(e => e.type === 'table').length > 3) {
      documentStructure = 'data-heavy';
    }

    return {
      hasMultiColumn,
      hasSidebar,
      hasFootnotes,
      documentStructure
    };
  }

  /**
   * Helper: Flush accumulated paragraph text
   */
  private flushParagraph(elements: LayoutElement[], lines: string[]) {
    if (lines.length > 0) {
      elements.push({
        type: 'paragraph',
        content: lines.join('\n')
      });
      lines.length = 0; // Clear array
    }
  }

  /**
   * Parse table from text lines
   */
  private parseTable(lines: string[]): LayoutElement {
    const rows = lines.map(line =>
      line.split('|').map(cell => cell.trim()).filter(cell => cell)
    );

    // Detect if second row is separator (markdown tables)
    let headers: string[] = [];
    let dataRows = rows;

    if (rows.length > 1 && rows[1].every(cell => cell.match(/^-+$/))) {
      headers = rows[0];
      dataRows = rows.slice(2);
    }

    return {
      type: 'table',
      content: lines.join('\n'),
      metadata: {
        headers,
        rowCount: dataRows.length,
        columnCount: headers.length || (dataRows[0]?.length || 0)
      }
    };
  }

  /**
   * Strip HTML tags from text
   */
  private stripHTML(html: string): string {
    return html.replace(/<[^>]*>/g, '').trim();
  }

  /**
   * Detect multi-column layout patterns
   */
  private detectMultiColumnLayout(elements: LayoutElement[]): boolean {
    // Heuristic: Check for short paragraphs with consistent widths
    const paragraphs = elements.filter(e => e.type === 'paragraph');
    if (paragraphs.length < 5) return false;

    const avgLength = paragraphs.reduce((sum, p) =>
      sum + (p.content?.length || 0), 0) / paragraphs.length;

    // If paragraphs are consistently short, might be columns
    return avgLength < 200 && paragraphs.length > 10;
  }

  /**
   * Detect sidebar layout patterns
   */
  private detectSidebarLayout(elements: LayoutElement[]): boolean {
    // Heuristic: Look for consistent short elements at start or end
    if (elements.length < 10) return false;

    const firstThree = elements.slice(0, 3);
    const lastThree = elements.slice(-3);

    const hasShortStart = firstThree.every(e =>
      (e.content?.length || 0) < 100 && e.type !== 'header'
    );
    const hasShortEnd = lastThree.every(e =>
      (e.content?.length || 0) < 100 && e.type !== 'header'
    );

    return hasShortStart || hasShortEnd;
  }

  /**
   * Merge adjacent elements of the same type
   */
  mergeAdjacentElements(elements: LayoutElement[]): LayoutElement[] {
    const merged: LayoutElement[] = [];
    let current: LayoutElement | null = null;

    for (const element of elements) {
      if (current && current.type === element.type && current.type === 'paragraph') {
        // Merge paragraphs
        current.content = (current.content || '') + '\n\n' + (element.content || '');
      } else {
        if (current) {
          merged.push(current);
        }
        current = { ...element };
      }
    }

    if (current) {
      merged.push(current);
    }

    return merged;
  }
}

export default LayoutAnalyzer;