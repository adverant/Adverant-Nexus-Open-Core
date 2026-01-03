import { ChunkingStrategy } from './base-strategy';
import { ChunkingOptions, Chunk } from '../types';
import { logger } from '../utils/logger';
import { IntelligentChunkingEngine } from './chunking-engine';

export class TextChunkingStrategy extends ChunkingStrategy {
  async chunk(content: string, options: ChunkingOptions): Promise<Chunk[]> {
    const chunks: Chunk[] = [];
    
    // For text documents, we use semantic paragraph-based chunking
    const paragraphs = this.extractParagraphs(content);
    
    let currentChunk = '';
    let currentTokens = 0;
    let chunkStart = 0;
    let paragraphsInChunk: string[] = [];
    
    for (const paragraph of paragraphs) {
      const paragraphTokens = this.estimateTokens(paragraph.content);
      
      // If adding this paragraph would exceed token limit
      if (currentTokens + paragraphTokens > options.maxTokens && currentChunk) {
        // Determine page number from chunk's starting position
        const pageNumber = IntelligentChunkingEngine.getPageNumber(chunkStart, options.metadata.pages);

        // Save current chunk
        chunks.push(this.createChunk(
          currentChunk,
          'paragraph',
          {
            start: chunkStart,
            end: paragraph.position.start - 1
          },
          {
            importance_score: this.calculateImportance(paragraphsInChunk),
            semantic_density: this.calculateSemanticDensity(currentChunk),
            contains_key_info: this.detectKeyInformation(currentChunk),
            pageNumber  // Include page number in chunk metadata
          },
          options.metadata.id!
        ));
        
        // Start new chunk with overlap (last paragraph of previous chunk)
        if (options.overlap > 0 && paragraphsInChunk.length > 0) {
          const overlapParagraph = paragraphsInChunk[paragraphsInChunk.length - 1];
          currentChunk = overlapParagraph + '\n\n' + paragraph.content;
          currentTokens = this.estimateTokens(currentChunk);
          paragraphsInChunk = [overlapParagraph, paragraph.content];
        } else {
          currentChunk = paragraph.content;
          currentTokens = paragraphTokens;
          paragraphsInChunk = [paragraph.content];
        }
        chunkStart = paragraph.position.start;
      } else {
        // Add paragraph to current chunk
        if (currentChunk) {
          currentChunk += '\n\n' + paragraph.content;
        } else {
          currentChunk = paragraph.content;
          chunkStart = paragraph.position.start;
        }
        currentTokens += paragraphTokens;
        paragraphsInChunk.push(paragraph.content);
      }
    }
    
    // Add final chunk
    if (currentChunk) {
      // Determine page number from chunk's starting position
      const pageNumber = IntelligentChunkingEngine.getPageNumber(chunkStart, options.metadata.pages);

      chunks.push(this.createChunk(
        currentChunk,
        'paragraph',
        {
          start: chunkStart,
          end: content.length - 1
        },
        {
          importance_score: this.calculateImportance(paragraphsInChunk),
          semantic_density: this.calculateSemanticDensity(currentChunk),
          contains_key_info: this.detectKeyInformation(currentChunk),
          pageNumber  // Include page number in chunk metadata
        },
        options.metadata.id!
      ));
    }
    
    logger.debug('Text chunking completed', { 
      documentId: options.metadata.id,
      paragraphsFound: paragraphs.length,
      chunksCreated: chunks.length 
    });
    
    return chunks;
  }
  
  private extractParagraphs(content: string): Array<{ content: string; position: { start: number; end: number } }> {
    const paragraphs: Array<{ content: string; position: { start: number; end: number } }> = [];
    
    // Split by double newlines (standard paragraph separator)
    const rawParagraphs = content.split(/\n\s*\n/);
    let position = 0;
    
    for (const para of rawParagraphs) {
      const trimmedPara = para.trim();
      if (trimmedPara) {
        const start = content.indexOf(para, position);
        const end = start + para.length;
        
        paragraphs.push({
          content: trimmedPara,
          position: { start, end }
        });
        
        position = end;
      }
    }
    
    // If no paragraphs found (single block of text), split by sentences
    if (paragraphs.length <= 1) {
      return this.splitBySentences(content);
    }
    
    return paragraphs;
  }
  
  private splitBySentences(content: string): Array<{ content: string; position: { start: number; end: number } }> {
    const sentences: Array<{ content: string; position: { start: number; end: number } }> = [];
    
    // Simple sentence detection (can be improved with NLP libraries)
    const sentenceRegex = /[.!?]+\s+|[.!?]+$/g;
    let lastIndex = 0;
    let match;
    
    while ((match = sentenceRegex.exec(content)) !== null) {
      const sentence = content.substring(lastIndex, match.index + match[0].length).trim();
      if (sentence) {
        sentences.push({
          content: sentence,
          position: {
            start: lastIndex,
            end: match.index + match[0].length
          }
        });
      }
      lastIndex = match.index + match[0].length;
    }
    
    // Add remaining content
    if (lastIndex < content.length) {
      const remaining = content.substring(lastIndex).trim();
      if (remaining) {
        sentences.push({
          content: remaining,
          position: {
            start: lastIndex,
            end: content.length
          }
        });
      }
    }
    
    // Group sentences into paragraph-sized chunks
    const paragraphs: Array<{ content: string; position: { start: number; end: number } }> = [];
    const targetSentencesPerParagraph = 5;
    
    for (let i = 0; i < sentences.length; i += targetSentencesPerParagraph) {
      const sentenceGroup = sentences.slice(i, i + targetSentencesPerParagraph);
      const combinedContent = sentenceGroup.map(s => s.content).join(' ');
      
      paragraphs.push({
        content: combinedContent,
        position: {
          start: sentenceGroup[0].position.start,
          end: sentenceGroup[sentenceGroup.length - 1].position.end
        }
      });
    }
    
    return paragraphs;
  }
  
  private calculateImportance(paragraphs: string[]): number {
    // Heuristics for importance calculation
    let score = 0.5; // Base score
    
    for (const paragraph of paragraphs) {
      // First paragraph bonus
      if (paragraphs.indexOf(paragraph) === 0) {
        score += 0.1;
      }
      
      // Keywords that indicate importance
      const importantKeywords = [
        'important', 'critical', 'essential', 'key', 'main', 'primary',
        'conclusion', 'summary', 'result', 'finding', 'recommendation'
      ];
      
      const lowerPara = paragraph.toLowerCase();
      for (const keyword of importantKeywords) {
        if (lowerPara.includes(keyword)) {
          score += 0.05;
        }
      }
      
      // Questions often indicate important topics
      if (paragraph.includes('?')) {
        score += 0.05;
      }
      
      // Lists or numbered items
      if (paragraph.match(/^\s*[-•*]\s+/m) || paragraph.match(/^\s*\d+\.\s+/m)) {
        score += 0.05;
      }
    }
    
    return Math.min(score, 1.0);
  }
  
  private calculateSemanticDensity(text: string): number {
    // Simple heuristic for semantic density
    const words = text.split(/\s+/).filter(w => w.length > 0);
    const uniqueWords = new Set(words.map(w => w.toLowerCase()));
    
    // Ratio of unique words to total words
    const uniquenessRatio = uniqueWords.size / words.length;
    
    // Average word length (longer words often carry more meaning)
    const avgWordLength = words.reduce((sum, w) => sum + w.length, 0) / words.length;
    const normalizedWordLength = Math.min(avgWordLength / 10, 1); // Normalize to 0-1
    
    // Combine factors
    return (uniquenessRatio + normalizedWordLength) / 2;
  }
  
  private detectKeyInformation(text: string): boolean {
    // Patterns that indicate key information
    const keyPatterns = [
      /\b(define|definition|means?|is)\b/i,
      /\b(conclusion|summary|result|finding)\b/i,
      /\b(important|critical|essential|key|main)\b/i,
      /\b(must|should|need|require)\b/i,
      /\b(step\s+\d+|first|second|third|finally)\b/i,
      /\b(note:|important:|warning:|tip:|example:)\b/i
    ];
    
    return keyPatterns.some(pattern => pattern.test(text));
  }
}

// Export other strategies
export { StructuredDataChunkingStrategy } from './structured-strategy';
export { MultimodalChunkingStrategy } from './multimodal-strategy';
