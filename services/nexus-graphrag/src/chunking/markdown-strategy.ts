import { ChunkingStrategy, MarkdownSection } from './base-strategy';
import { ChunkingOptions, Chunk } from '../types';
import { logger } from '../utils/logger';

export class MarkdownChunkingStrategy extends ChunkingStrategy {
  async chunk(content: string, options: ChunkingOptions): Promise<Chunk[]> {
    const chunks: Chunk[] = [];
    
    // Parse markdown structure
    const sections = await this.parseMarkdownStructure(content);
    
    for (const section of sections) {
      const tokens = this.estimateTokens(section.content);
      
      if (tokens <= options.maxTokens) {
        chunks.push(this.createChunk(
          section.content,
          section.type as Chunk['type'],
          section.position,
          {
            level: section.level,
            importance_score: this.calculateHeaderImportance(section.level || 0),
            semantic_density: 0.7,
            contains_key_info: (section.level || 0) <= 2
          },
          options.metadata.id!
        ));
      } else {
        // Split large sections
        const subChunks = await this.splitLargeSection(section, options);
        chunks.push(...subChunks);
      }
    }
    
    logger.debug('Markdown chunking completed', { 
      documentId: options.metadata.id,
      sectionsFound: sections.length,
      chunksCreated: chunks.length 
    });
    
    return chunks;
  }
  
  private async parseMarkdownStructure(content: string): Promise<MarkdownSection[]> {
    const sections: MarkdownSection[] = [];
    const lines = content.split('\n');
    let currentSection: MarkdownSection | null = null;
    let position = 0;
    let inCodeBlock = false;
    let codeBlockStart = 0;
    let _codeBlockLang = '';
    
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const lineStart = position;
      
      // Check for code blocks
      if (line.startsWith('```')) {
        if (!inCodeBlock) {
          // Save current section if exists
          if (currentSection && currentSection.content.trim()) {
            currentSection.position.end = position - 1;
            sections.push(currentSection);
          }
          
          // Start code block
          inCodeBlock = true;
          codeBlockStart = i;
          _codeBlockLang = line.substring(3).trim();
          currentSection = null;
        } else {
          // End code block
          inCodeBlock = false;
          const codeContent = lines.slice(codeBlockStart, i + 1).join('\n');
          
          sections.push({
            type: 'code_block',
            content: codeContent,
            position: {
              start: this.getLinePosition(lines, codeBlockStart),
              end: position + line.length
            },
            level: 0,
            title: _codeBlockLang || 'code' // Store language in title field
          });
          
          currentSection = null;
        }
      } else if (!inCodeBlock) {
        // Check for headers
        const headerMatch = line.match(/^(#{1,6})\s+(.+)$/);
        if (headerMatch) {
          // Save previous section
          if (currentSection && currentSection.content.trim()) {
            currentSection.position.end = position - 1;
            sections.push(currentSection);
          }
          
          // Start new section
          const level = headerMatch[1].length;
          currentSection = {
            type: 'header',
            level,
            title: headerMatch[2],
            content: line,
            position: { start: lineStart, end: lineStart + line.length },
            children: []
          };
        } else if (line.trim() === '' && currentSection) {
          // Empty line - potential section break
          if (currentSection.type === 'header' && currentSection.content === currentSection.content.split('\n')[0]) {
            // Just a header, no content yet
          } else {
            // End current section
            currentSection.position.end = position - 1;
            sections.push(currentSection);
            currentSection = null;
          }
        } else if (line.trim() !== '') {
          // Content line
          if (!currentSection) {
            // Start new paragraph section
            currentSection = {
              type: 'paragraph',
              content: line,
              position: { start: lineStart, end: lineStart + line.length }
            };
          } else {
            // Add to current section
            currentSection.content += '\n' + line;
          }
        }
      }
      
      position += line.length + 1; // +1 for newline
    }
    
    // Save last section
    if (currentSection && currentSection.content.trim()) {
      currentSection.position.end = position;
      sections.push(currentSection);
    }
    
    // Post-process: detect lists and tables
    return this.detectSpecialMarkdownElements(sections, lines);
  }
  
  private detectSpecialMarkdownElements(sections: MarkdownSection[], _lines: string[]): MarkdownSection[] {
    const processedSections: MarkdownSection[] = [];
    
    for (const section of sections) {
      if (section.type === 'paragraph') {
        // Check if it's actually a list
        const sectionLines = section.content.split('\n');
        const isUnorderedList = sectionLines.every(line => 
          line.trim() === '' || line.match(/^(\s*)[*+-]\s+/)
        );
        const isOrderedList = sectionLines.every(line => 
          line.trim() === '' || line.match(/^(\s*)\d+\.\s+/)
        );
        
        if (isUnorderedList || isOrderedList) {
          processedSections.push({
            ...section,
            type: 'list'
          });
        } else if (this.isTable(sectionLines)) {
          processedSections.push({
            ...section,
            type: 'table'
          });
        } else {
          processedSections.push(section);
        }
      } else {
        processedSections.push(section);
      }
    }
    
    return processedSections;
  }
  
  private isTable(lines: string[]): boolean {
    // Simple table detection - check for pipe characters and separator line
    if (lines.length < 3) return false;
    
    const hasPipes = lines.every(line => 
      line.trim() === '' || line.includes('|')
    );
    
    const hasSeparator = lines.some(line => 
      line.match(/^\s*\|?\s*:?-+:?\s*\|/)
    );
    
    return hasPipes && hasSeparator;
  }
  
  private calculateHeaderImportance(level: number): number {
    // Lower level (h1, h2) headers are more important
    const importanceMap: { [key: number]: number } = {
      0: 0.5,  // Regular content
      1: 1.0,  // H1
      2: 0.9,  // H2
      3: 0.8,  // H3
      4: 0.7,  // H4
      5: 0.6,  // H5
      6: 0.5   // H6
    };
    
    return importanceMap[level] || 0.5;
  }
  
  private async splitLargeSection(section: MarkdownSection, options: ChunkingOptions): Promise<Chunk[]> {
    const chunks: Chunk[] = [];
    const lines = section.content.split('\n');
    
    let currentChunk = '';
    let currentTokens = 0;
    let chunkStart = section.position.start;
    
    // Always include the header in the first chunk if it's a header section
    if (section.type === 'header' && section.title) {
      currentChunk = lines[0]; // The header line
      currentTokens = this.estimateTokens(currentChunk);
    }
    
    const startLine = section.type === 'header' ? 1 : 0;
    
    for (let i = startLine; i < lines.length; i++) {
      const line = lines[i];
      const lineTokens = this.estimateTokens(line);
      
      if (currentTokens + lineTokens > options.maxTokens && currentChunk.trim()) {
        // Save current chunk
        chunks.push(this.createChunk(
          currentChunk,
          section.type as Chunk['type'],
          {
            start: chunkStart,
            end: chunkStart + currentChunk.length
          },
          {
            level: section.level,
            importance_score: this.calculateHeaderImportance(section.level || 0) * (chunks.length === 0 ? 1 : 0.8),
            semantic_density: 0.7,
            contains_key_info: chunks.length === 0 && (section.level || 0) <= 2
          },
          options.metadata.id!
        ));
        
        // Start new chunk
        currentChunk = line;
        currentTokens = lineTokens;
        chunkStart += currentChunk.length + 1;
      } else {
        currentChunk += (currentChunk ? '\n' : '') + line;
        currentTokens += lineTokens;
      }
    }
    
    // Add final chunk
    if (currentChunk.trim()) {
      chunks.push(this.createChunk(
        currentChunk,
        section.type as Chunk['type'],
        {
          start: chunkStart,
          end: section.position.end
        },
        {
          level: section.level,
          importance_score: this.calculateHeaderImportance(section.level || 0) * 0.7,
          semantic_density: 0.7,
          contains_key_info: false
        },
        options.metadata.id!
      ));
    }
    
    return chunks;
  }
  
  private getLinePosition(lines: string[], lineNumber: number): number {
    let position = 0;
    for (let i = 0; i < lineNumber && i < lines.length; i++) {
      position += lines[i].length + 1; // +1 for newline
    }
    return position;
  }
}
