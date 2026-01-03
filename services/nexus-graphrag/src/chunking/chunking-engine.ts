import { ChunkingStrategy } from './base-strategy';
import { CodeChunkingStrategy } from './code-strategy';
import { MarkdownChunkingStrategy } from './markdown-strategy';
import { TextChunkingStrategy } from './text-strategy';
import { StructuredDataChunkingStrategy } from './structured-strategy';
import { MultimodalChunkingStrategy } from './multimodal-strategy';
import {
  Chunk,
  ChunkingResult,
  DocumentMetadata,
  DocumentSummary,
  ChunkRelationship,
  DocumentOutline,
  OutlineSection,
  PageInfo
} from '../types';
import { VoyageAIClient } from '../clients/voyage-ai-unified-client';
import { logger } from '../utils/logger';

interface ChunkingConfig {
  maxChunkTokens?: number;
  overlapTokens?: number;
  voyageClient: VoyageAIClient;
}

export class IntelligentChunkingEngine {
  private readonly chunkingStrategies: Map<string, ChunkingStrategy>;
  private readonly maxChunkTokens: number;
  private readonly overlapTokens: number;
  
  constructor(config: ChunkingConfig) {
    this.maxChunkTokens = config.maxChunkTokens || 1000;
    this.overlapTokens = config.overlapTokens || 100;
    
    // Initialize chunking strategies
    this.chunkingStrategies = new Map([
      ['code', new CodeChunkingStrategy()],
      ['markdown', new MarkdownChunkingStrategy()],
      ['structured', new StructuredDataChunkingStrategy()],
      ['text', new TextChunkingStrategy()],
      ['multimodal', new MultimodalChunkingStrategy()]
    ]);
  }

  /**
   * Determines the page number for a given character offset based on page boundaries.
   * Returns undefined if no page information is available or offset is out of bounds.
   *
   * @param charOffset - Character position in the document
   * @param pages - Array of page boundary information from document metadata
   * @returns Page number (1-indexed) or undefined if not determinable
   */
  static getPageNumber(charOffset: number, pages?: PageInfo[]): number | undefined {
    if (!pages || pages.length === 0) return undefined;

    for (const page of pages) {
      if (charOffset >= page.startChar && charOffset < page.endChar) {
        return page.pageNumber;
      }
    }

    // If offset is past all pages, return the last page number
    const lastPage = pages[pages.length - 1];
    if (charOffset >= lastPage.endChar) {
      return lastPage.pageNumber;
    }

    return undefined;
  }

  async chunkDocument(content: string, metadata: DocumentMetadata): Promise<ChunkingResult> {
    const startTime = Date.now();
    logger.info('Starting document chunking', { 
      documentId: metadata.id,
      type: metadata.type,
      size: content.length 
    });
    
    try {
      // Select appropriate strategy
      const strategy = this.chunkingStrategies.get(metadata.type) || 
                      this.chunkingStrategies.get('text')!;
      
      // First pass: structural chunking
      const structuralChunks = await strategy.chunk(content, {
        maxTokens: this.maxChunkTokens,
        overlap: this.overlapTokens,
        metadata
      });
      
      // Second pass: semantic enhancement
      const enhancedChunks = await this.enhanceChunksWithSemantics(structuralChunks);
      
      // Third pass: create chunk relationships
      const relationships = await this.buildChunkRelationships(enhancedChunks);
      
      // Generate document summary and outline
      const summary = await this.generateDocumentSummary(enhancedChunks);
      const outline = await this.generateDocumentOutline(enhancedChunks);
      
      const processingTime = Date.now() - startTime;
      logger.info('Document chunking completed', { 
        documentId: metadata.id,
        chunksCreated: enhancedChunks.length,
        relationshipsCreated: relationships.length,
        processingTime
      });
      
      return {
        chunks: enhancedChunks,
        relationships,
        summary,
        outline
      };
    } catch (error) {
      logger.error('Document chunking failed', { 
        error, 
        documentId: metadata.id 
      });
      throw error;
    }
  }
  
  private async enhanceChunksWithSemantics(chunks: Chunk[]): Promise<Chunk[]> {
    const enhanced = [];
    
    for (const chunk of chunks) {
      // Calculate semantic density
      const semanticDensity = await this.calculateSemanticDensity(chunk.content);
      
      // Identify key information
      const containsKeyInfo = await this.identifyKeyInformation(chunk);
      
      // Generate chunk summary for important chunks
      const summary = (semanticDensity > 0.7 || containsKeyInfo) ? 
        await this.generateChunkSummary(chunk.content) : undefined;
      
      enhanced.push({
        ...chunk,
        metadata: {
          ...chunk.metadata,
          semantic_density: semanticDensity,
          contains_key_info: containsKeyInfo,
        },
        summary
      });
    }
    
    return enhanced;
  }
  
  private async buildChunkRelationships(chunks: Chunk[]): Promise<ChunkRelationship[]> {
    const relationships: ChunkRelationship[] = [];
    
    // Sequential relationships
    for (let i = 0; i < chunks.length - 1; i++) {
      relationships.push({
        source_id: chunks[i].id,
        target_id: chunks[i + 1].id,
        type: 'FOLLOWS',
        weight: 1.0
      });
    }
    
    // Semantic relationships - only for reasonably sized sets
    if (chunks.length < 100) {
      for (let i = 0; i < chunks.length; i++) {
        for (let j = i + 1; j < chunks.length; j++) {
          const similarity = await this.calculateSimilarity(chunks[i], chunks[j]);
          if (similarity > 0.7) {
            relationships.push({
              source_id: chunks[i].id,
              target_id: chunks[j].id,
              type: 'SIMILAR_TO',
              weight: similarity
            });
          }
        }
      }
    }
    
    // Hierarchical relationships (for code and structured documents)
    const hierarchicalRels = await this.buildHierarchicalRelationships(chunks);
    relationships.push(...hierarchicalRels);
    
    return relationships;
  }
  
  private async calculateSemanticDensity(content: string): Promise<number> {
    // Simple heuristic - in production, could use more sophisticated NLP
    const words = content.split(/\s+/).filter(w => w.length > 3);
    const uniqueWords = new Set(words.map(w => w.toLowerCase()));
    
    // Ratio of unique meaningful words to total words
    const uniquenessRatio = uniqueWords.size / Math.max(words.length, 1);
    
    // Check for technical/specialized vocabulary
    const technicalTerms = content.match(/\b[A-Z][a-zA-Z]+(?:[A-Z][a-zA-Z]+)+\b/g) || [];
    const technicalDensity = technicalTerms.length / Math.max(words.length, 1);
    
    // Combine factors
    return Math.min((uniquenessRatio + technicalDensity * 2) / 2, 1.0);
  }
  
  private async identifyKeyInformation(chunk: Chunk): Promise<boolean> {
    // Check chunk type
    if (['header', 'class', 'function'].includes(chunk.type)) {
      return true;
    }
    
    // Check metadata
    if (chunk.metadata.importance_score > 0.7) {
      return true;
    }
    
    // Check content patterns
    const keyPatterns = [
      /\b(important|critical|essential|key|main|primary)\b/i,
      /\b(conclusion|summary|abstract|overview)\b/i,
      /\b(definition|introduction|purpose)\b/i,
      /^\s*#+\s+/m, // Markdown headers
      /^(class|function|def|interface)\s+/m, // Code definitions
    ];
    
    return keyPatterns.some(pattern => pattern.test(chunk.content));
  }
  
  private async generateChunkSummary(content: string): Promise<string> {
    // For now, extract first sentence or line
    // In production, could use LLM to generate actual summaries
    const firstSentence = content.match(/^[^.!?]+[.!?]/);
    const firstLine = content.split('\n')[0];
    
    return firstSentence?.[0] || firstLine.substring(0, 100) + '...';
  }
  
  private async calculateSimilarity(chunk1: Chunk, chunk2: Chunk): Promise<number> {
    // For now, use simple text similarity
    // In production, would use embeddings
    const words1 = new Set(chunk1.content.toLowerCase().split(/\s+/));
    const words2 = new Set(chunk2.content.toLowerCase().split(/\s+/));
    
    const intersection = new Set([...words1].filter(w => words2.has(w)));
    const union = new Set([...words1, ...words2]);
    
    return intersection.size / Math.max(union.size, 1);
  }
  
  private async buildHierarchicalRelationships(chunks: Chunk[]): Promise<ChunkRelationship[]> {
    const relationships: ChunkRelationship[] = [];
    
    // Track parent chunks (headers, classes, functions)
    const parentStack: Chunk[] = [];
    
    for (const chunk of chunks) {
      // Update parent stack based on chunk type and level
      if (chunk.type === 'header') {
        const level = chunk.metadata.level || 0;
        
        // Pop parents at same or higher level
        while (parentStack.length > 0) {
          const parent = parentStack[parentStack.length - 1];
          const parentLevel = parent.metadata.level || 0;
          
          if (parent.type === 'header' && parentLevel >= level) {
            parentStack.pop();
          } else {
            break;
          }
        }
        
        // Add as child of current parent
        if (parentStack.length > 0) {
          relationships.push({
            source_id: parentStack[parentStack.length - 1].id,
            target_id: chunk.id,
            type: 'PARENT_OF',
            weight: 1.0
          });
        }
        
        // Push as new parent
        parentStack.push(chunk);
      } else if (['class', 'function'].includes(chunk.type)) {
        // Add as child of current parent
        if (parentStack.length > 0) {
          relationships.push({
            source_id: parentStack[parentStack.length - 1].id,
            target_id: chunk.id,
            type: 'CONTAINS',
            weight: 1.0
          });
        }
        
        // Classes can be parents of functions
        if (chunk.type === 'class') {
          parentStack.push(chunk);
        }
      } else {
        // Regular content - child of current parent
        if (parentStack.length > 0) {
          relationships.push({
            source_id: parentStack[parentStack.length - 1].id,
            target_id: chunk.id,
            type: 'CONTAINS',
            weight: 0.5
          });
        }
      }
    }
    
    return relationships;
  }
  
  private async generateDocumentSummary(chunks: Chunk[]): Promise<DocumentSummary> {
    // Collect key chunks
    const keyChunks = chunks.filter(c =>
      c.metadata.contains_key_info ||
      c.metadata.importance_score > 0.7 ||
      c.type === 'header' && (c.metadata.level || 0) <= 2
    );

    // Extract summaries or first lines
    const summaryParts: string[] = [];
    const keyPoints: string[] = [];

    for (const chunk of keyChunks.slice(0, 5)) {
      if (chunk.summary) {
        summaryParts.push(chunk.summary);
        keyPoints.push(chunk.summary);
      } else {
        const firstLine = chunk.content.split('\n')[0].trim();
        if (firstLine.length > 20) {
          const point = firstLine.substring(0, 100) + '...';
          summaryParts.push(point);
          keyPoints.push(point);
        }
      }
    }

    return {
      content: summaryParts.join(' '),
      keyPoints,
      generationModel: 'rule-based'
    };
  }
  
  private async generateDocumentOutline(chunks: Chunk[]): Promise<DocumentOutline> {
    const headerChunks = chunks.filter(c => c.type === 'header');
    const sections: OutlineSection[] = [];
    const sectionStack: OutlineSection[] = [];
    
    for (const chunk of headerChunks) {
      const level = chunk.metadata.level || 1;
      const title = chunk.content.replace(/^#+\s*/, '').trim();
      
      const section: OutlineSection = {
        title,
        level,
        start_chunk: chunk.id,
        end_chunk: chunk.id, // Will be updated
        subsections: []
      };
      
      // Find parent section
      while (sectionStack.length > 0 && sectionStack[sectionStack.length - 1].level >= level) {
        const completed = sectionStack.pop()!;
        
        // Update end chunk for completed section
        const completedIndex = chunks.findIndex(c => c.id === completed.start_chunk);
        const nextHeaderIndex = chunks.findIndex((c, i) => 
          i > completedIndex && c.type === 'header' && (c.metadata.level || 0) <= completed.level
        );
        
        if (nextHeaderIndex > 0) {
          completed.end_chunk = chunks[nextHeaderIndex - 1].id;
        } else {
          completed.end_chunk = chunks[chunks.length - 1].id;
        }
      }
      
      if (sectionStack.length > 0) {
        // Add as subsection
        sectionStack[sectionStack.length - 1].subsections?.push(section);
      } else {
        // Top-level section
        sections.push(section);
      }
      
      sectionStack.push(section);
    }
    
    // Complete remaining sections
    while (sectionStack.length > 0) {
      const completed = sectionStack.pop()!;
      completed.end_chunk = chunks[chunks.length - 1].id;
    }
    
    // Generate title from first header or metadata
    const title = headerChunks[0]?.content.replace(/^#+\s*/, '').trim() || 
                  'Document Outline';
    
    return {
      title,
      sections
    };
  }
}
