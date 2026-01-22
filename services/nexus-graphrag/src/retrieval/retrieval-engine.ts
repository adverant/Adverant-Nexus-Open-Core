import { QdrantClient } from '@qdrant/js-client-rest';
import * as neo4j from 'neo4j-driver';
import Redis from 'ioredis';
import { Pool } from 'pg';
import { VoyageAIClient } from '../clients/voyage-ai-unified-client';
import { DocumentHelpers } from './document-helpers';
import {
  RetrievalOptions,
  RetrievalResult,
  QueryAnalysis,
  QueryIntent,
  Chunk
} from '../types';
import { logger } from '../utils/logger';
import { QueryCache, cacheKeys } from '../utils/cache';

interface RetrievalConfig {
  voyageClient: VoyageAIClient;
  qdrantClient: QdrantClient;
  neo4jDriver: neo4j.Driver;
  redisCache: Redis;
  postgresPool: Pool;
}

// Unused interface - kept for future use
// interface SearchFilter {
//   type?: string;
//   language?: string;
//   tags?: string[];
//   dateRange?: {
//     start: Date;
//     end: Date;
//   };
// }

export class SmartRetrievalEngine {
  private readonly voyageClient: VoyageAIClient;
  private readonly qdrantClient: QdrantClient;
  private readonly neo4jDriver: neo4j.Driver;
  private readonly queryCache: QueryCache;
  private readonly documentHelpers: DocumentHelpers;
  
  constructor(config: RetrievalConfig) {
    this.voyageClient = config.voyageClient;
    this.qdrantClient = config.qdrantClient;
    this.neo4jDriver = config.neo4jDriver;

    // Initialize QueryCache with defensive error handling
    try {
      this.queryCache = new QueryCache({
        redis: config.redisCache,
        keyPrefix: 'graphrag',
        defaultTTL: 300, // 5 minutes default
        enableStats: true,
      });

      logger.info('SmartRetrievalEngine initialized with query caching', {
        defaultTTL: 300,
      });
    } catch (error) {
      logger.error('Failed to initialize QueryCache', {
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
        redisConfig: {
          host: config.redisCache?.options?.host,
          port: config.redisCache?.options?.port,
          status: config.redisCache?.status,
        },
      });
      throw new Error(
        `QueryCache initialization failed: ${error instanceof Error ? error.message : String(error)}. ` +
        `Check Redis connection and ensure cache utility is properly imported.`
      );
    }

    this.documentHelpers = new DocumentHelpers(config.postgresPool);
  }
  
  async retrieve(query: string, options: RetrievalOptions = {}): Promise<RetrievalResult> {
    const {
      maxTokens = 8000,
      strategy = 'adaptive',
      includeFullDocument: _includeFullDocument = false,
      contentTypes: _contentTypes = ['all']
    } = options;

    // Use standardized cache key
    const cacheKey = cacheKeys.graphragQuery(query, options);

    // Use cache-aside pattern with getOrSet
    return this.queryCache.getOrSet(
      cacheKey,
      async () => {
        // This factory function only runs on cache miss
        const startTime = Date.now();

        try {
          // Analyze query intent
          const queryAnalysis = await this.analyzeQueryIntent(query);

          // Select retrieval strategy
          const retrievalStrategy = this.selectRetrievalStrategy(queryAnalysis, strategy);

          // Execute retrieval
          let result: RetrievalResult;

          switch (retrievalStrategy) {
            case 'full_document':
              result = await this.retrieveFullDocument(query, queryAnalysis);
              break;

            case 'semantic_chunks':
              result = await this.retrieveSemanticChunks(query, queryAnalysis, maxTokens);
              break;

            case 'hierarchical':
              result = await this.retrieveHierarchical(query, queryAnalysis, maxTokens);
              break;

            case 'graph_traversal':
              result = await this.retrieveGraphTraversal(query, queryAnalysis, maxTokens);
              break;

            case 'adaptive':
            default:
              result = await this.retrieveAdaptive(query, queryAnalysis, maxTokens);
          }

          // Post-process and optimize for LLM
          result = await this.optimizeForLLM(result, maxTokens);

          const retrievalTime = Date.now() - startTime;
          logger.info('Retrieval completed (cache miss)', {
            query,
            strategy: retrievalStrategy,
            chunksRetrieved: result.chunks.length,
            tokens: result.metadata.tokens,
            retrievalTime
          });

          return result;

        } catch (error) {
          logger.error('Retrieval failed', { error, query });
          throw error;
        }
      },
      300 // Cache for 5 minutes
    );
  }
  
  private async analyzeQueryIntent(query: string): Promise<QueryAnalysis> {
    // Pattern matching for query intent
    const patterns = {
      full_document: /^(provide|show|display|give me) (the )?(entire|full|complete|whole)/i,
      specific_section: /^(show|find|get) (the )?\w+ (section|part|chapter)/i,
      code_search: /(function|class|method|implementation|code for)/i,
      summary_request: /(summarize|summary|overview|tldr|brief)/i,
      ui_elements: /(font|color|design|style|css|component)/i
    };
    
    let intent: QueryIntent = 'general';
    
    for (const [key, pattern] of Object.entries(patterns)) {
      if (pattern.test(query)) {
        intent = key as QueryIntent;
        break;
      }
    }
    
    // Extract entities
    const entities = await this.extractEntities(query);
    
    return {
      intent,
      entities,
      requiresFullContext: intent === 'full_document',
      estimatedResponseTokens: this.estimateResponseTokens(intent),
      confidence: 0.85
    };
  }
  
  private async extractEntities(query: string): Promise<Array<{ type: string; value: string }>> {
    const entities: Array<{ type: string; value: string }> = [];
    
    // Document name detection
    const docNameMatch = query.match(/"([^"]+)"|'([^']+)'|`([^`]+)`/);
    if (docNameMatch) {
      entities.push({
        type: 'document',
        value: docNameMatch[1] || docNameMatch[2] || docNameMatch[3]
      });
    }
    
    // Code entity detection
    const codeTerms = query.match(/\b(function|class|method|variable|const|let|var)\s+(\w+)/gi);
    if (codeTerms) {
      for (const term of codeTerms) {
        const match = term.match(/\b(function|class|method|variable|const|let|var)\s+(\w+)/i);
        if (match) {
          entities.push({
            type: 'code',
            value: match[2]
          });
        }
      }
    }
    
    // Section/topic detection
    const sectionMatch = query.match(/(?:section|chapter|part)\s+(?:on|about)?\s*"?([^"]+)"?/i);
    if (sectionMatch) {
      entities.push({
        type: 'section',
        value: sectionMatch[1].trim()
      });
    }
    
    return entities;
  }
  
  private selectRetrievalStrategy(
    analysis: QueryAnalysis, 
    requestedStrategy: string
  ): RetrievalOptions['strategy'] {
    // Honor explicit strategy if provided
    if (requestedStrategy !== 'adaptive') {
      return requestedStrategy as RetrievalOptions['strategy'];
    }
    
    // Select based on query analysis
    if (analysis.requiresFullContext) {
      return 'full_document';
    }
    
    if (analysis.intent === 'code_search') {
      return 'semantic_chunks';
    }
    
    if (analysis.intent === 'summary_request') {
      return 'hierarchical';
    }
    
    // Default to semantic chunks for general queries
    return 'semantic_chunks';
  }
  
  private estimateResponseTokens(intent: QueryIntent): number {
    const estimates = {
      full_document: 8000,
      specific_section: 2000,
      code_search: 3000,
      summary_request: 1000,
      general: 4000
    };
    
    return estimates[intent] || 4000;
  }
  
  private async retrieveFullDocument(
    query: string, 
    analysis: QueryAnalysis
  ): Promise<RetrievalResult> {
    // Look for specific document request
    const documentName = analysis.entities.find(e => e.type === 'document')?.value;
    
    if (documentName) {
      // Direct document lookup by name/title
      const document = await this.documentHelpers.getDocumentByName(documentName);
      if (document) {
        logger.debug('Retrieved full document by name', { documentName });
        
        return {
          content: document.content,
          chunks: [],
          metadata: {
            strategy: 'full_document',
            source: document.metadata.source,
            tokens: this.estimateTokens(document.content),
            truncated: false,
            documents: [{
              id: document.id,
              title: document.metadata.title,
              type: document.metadata.type
            }]
          },
          relevanceScore: 1.0
        };
      }
    }
    
    // Fallback to semantic search for document
    const embedding = await this.voyageClient.generateEmbedding(query, {
      inputType: 'query',
      contentType: 'text'
    });
    
    const results = await this.qdrantClient.search('documents', {
      vector: embedding.embedding,  // FIXED: Use .embedding array
      limit: 1,
      score_threshold: 0.6  // Lowered from 0.8 for better recall
    });
    
    if (results.length > 0) {
      const document = await this.documentHelpers.getDocumentById(results[0].id as string);
      if (document) {
        logger.debug('Retrieved full document by semantic search', { documentId: results[0].id });
        
        return {
          content: document.content,
          chunks: [],
          metadata: {
            strategy: 'full_document',
            source: document.metadata.source,
            tokens: this.estimateTokens(document.content),
            truncated: false,
            documents: [{
              id: document.id,
              title: document.metadata.title,
              type: document.metadata.type
            }]
          },
          relevanceScore: results[0].score
        };
      }
    }
    
    // Fallback to chunk-based retrieval
    logger.debug('Full document not found, falling back to chunks', { query });
    return this.retrieveSemanticChunks(query, analysis, 8000);
  }
  
  private async retrieveSemanticChunks(
    query: string, 
    analysis: QueryAnalysis, 
    maxTokens: number
  ): Promise<RetrievalResult> {
    // Generate query embedding
    const queryEmbedding = await this.voyageClient.generateEmbedding(query, {
      inputType: 'query',
      contentType: analysis.entities.some(e => e.type === 'code') ? 'code' : 'text'
    });
    
    // Search for relevant chunks (increased from 50 to 100 for better coverage)
    const searchResults = await this.qdrantClient.search('chunks', {
      vector: queryEmbedding.embedding,  // FIXED: Use .embedding array, not whole object
      limit: 100, // Increased from 50 for better reranking coverage
      filter: this.buildSearchFilter(analysis),
      with_payload: true
    });

    // Rerank with Voyage AI (increased from 20 to 30 for better precision)
    const documents: string[] = searchResults.map(r => (r.payload as any)?.content || '');
    const reranked = await this.voyageClient.rerank(query, documents, 30);
    
    // Select chunks within token budget
    const selectedChunks: Chunk[] = [];
    let totalTokens = 0;
    
    for (const result of reranked) {
      const originalResult = searchResults[result.index];
      const chunk = originalResult.payload as Chunk;
      const chunkTokens = chunk.tokens || this.estimateTokens(chunk.content);
      
      if (totalTokens + chunkTokens <= maxTokens) {
        selectedChunks.push(chunk);
        totalTokens += chunkTokens;
      } else {
        break;
      }
    }
    
    // Group chunks by document and arrange
    const arrangedContent = await this.arrangeChunks(selectedChunks);

    logger.debug('Semantic chunk retrieval completed', {
      query,
      chunksFound: searchResults.length,
      chunksSelected: selectedChunks.length,
      totalTokens
    });
    
    return {
      content: arrangedContent.text,
      chunks: selectedChunks,
      metadata: {
        strategy: 'semantic_chunks',
        totalChunks: selectedChunks.length,
        tokens: totalTokens,
        documents: arrangedContent.documents
      },
      relevanceScore: reranked[0]?.score || 0
    };
  }
  
  private async retrieveHierarchical(
    query: string,
    _analysis: QueryAnalysis,
    maxTokens: number
  ): Promise<RetrievalResult> {
    // Start with high-level summaries
    const summaryEmbedding = await this.voyageClient.generateEmbedding(
      `Summary: ${query}`,
      { inputType: 'query' }
    );
    
    // Get relevant document summaries
    const summaries = await this.qdrantClient.search('document_summaries', {
      vector: summaryEmbedding.embedding,  // FIXED: Use .embedding array
      limit: 10,
      with_payload: true
    });
    
    // For each relevant document, get outline
    const relevantDocs = [];
    let tokensUsed = 0;
    
    for (const summary of summaries) {
      const outline = await this.documentHelpers.getDocumentOutline(summary.id as string);
      if (outline) {
        const outlineTokens = this.estimateTokens(JSON.stringify(outline));
        
        if (tokensUsed + outlineTokens <= maxTokens * 0.2) { // Use 20% for outlines
          relevantDocs.push({
            id: summary.id as string,
            summary: summary.payload?.content || '',
            outline: outline,
            score: summary.score
          });
          tokensUsed += outlineTokens;
        }
      }
    }
    
    // Get detailed chunks for most relevant sections
    const remainingTokens = maxTokens - tokensUsed;
    const detailedChunks = await this.getDetailedChunks(
      query,
      relevantDocs,
      remainingTokens
    );
    
    const formattedResult = this.formatHierarchicalResult(relevantDocs, detailedChunks);

    logger.debug('Hierarchical retrieval completed', {
      query,
      documentsFound: relevantDocs.length,
      chunksRetrieved: detailedChunks.length,
      totalTokens: tokensUsed
    });
    
    return {
      content: formattedResult,
      chunks: detailedChunks,
      metadata: {
        strategy: 'hierarchical',
        summaryCount: relevantDocs.length,
        detailCount: detailedChunks.length,
        tokens: tokensUsed
      },
      relevanceScore: summaries[0]?.score || 0
    };
  }
  
  private async retrieveGraphTraversal(
    query: string,
    analysis: QueryAnalysis,
    maxTokens: number
  ): Promise<RetrievalResult> {
    const session = this.neo4jDriver.session();
    
    try {
      // Find starting nodes
      const startNodes = await this.findStartingNodes(query, analysis);
      
      if (startNodes.length === 0) {
        logger.debug('No starting nodes found for graph traversal', { query });
        return this.retrieveSemanticChunks(query, analysis, maxTokens);
      }
      
      // Traverse graph to collect related content
      const traversalQuery = `
        MATCH path = (start:Chunk)-[:RELATES_TO|:FOLLOWS|:REFERENCES*1..3]-(related:Chunk)
        WHERE start.id IN $startIds
        AND (
          related.importance_score > 0.7
          OR related.contains_key_info = true
          OR any(keyword IN $keywords WHERE toLower(related.content) CONTAINS toLower(keyword))
        )
        WITH related, path, 
             length(path) as distance,
             reduce(score = 1.0, r in relationships(path) | score * r.weight) as pathScore
        RETURN DISTINCT related, distance, pathScore
        ORDER BY pathScore DESC, distance ASC
        LIMIT 50
      `;
      
      const result = await session.run(traversalQuery, {
        startIds: startNodes.map(n => n.id),
        keywords: analysis.entities.map(e => e.value)
      });
      
      // Collect and rank chunks
      const chunks: Chunk[] = [];
      let totalTokens = 0;
      
      for (const record of result.records) {
        const chunkData = record.get('related').properties;
        const pathScore = record.get('pathScore');
        
        const chunk: Chunk = {
          id: chunkData.id,
          document_id: chunkData.document_id,
          content: chunkData.content || '',
          type: chunkData.type,
          position: {
            start: chunkData.position_start || 0,
            end: chunkData.position_end || 0
          },
          metadata: {
            importance_score: chunkData.importance_score || 0.5,
            semantic_density: chunkData.semantic_density || 0.5,
            contains_key_info: chunkData.contains_key_info || false
          },
          tokens: chunkData.tokens || this.estimateTokens(chunkData.content)
        };
        
        if (totalTokens + chunk.tokens <= maxTokens) {
          chunks.push({
            ...chunk,
            metadata: {
              ...chunk.metadata,
              relevance_score: pathScore
            }
          });
          totalTokens += chunk.tokens;
        }
      }
      
      // Arrange in logical order
      const arranged = await this.arrangeChunksWithGraph(chunks);

      logger.debug('Graph traversal completed', {
        query,
        startNodes: startNodes.length,
        nodesVisited: chunks.length,
        totalTokens
      });
      
      return {
        content: arranged.text,
        chunks: chunks,
        metadata: {
          strategy: 'graph_traversal',
          nodesVisited: chunks.length,
          tokens: totalTokens,
          graphDepth: 3
        },
        relevanceScore: chunks[0]?.metadata?.relevance_score || 0
      };
      
    } finally {
      await session.close();
    }
  }
  
  private async retrieveAdaptive(
    query: string,
    analysis: QueryAnalysis,
    maxTokens: number
  ): Promise<RetrievalResult> {
    // Start with semantic search
    let result = await this.retrieveSemanticChunks(query, analysis, maxTokens * 0.6);

    // If relevance is low, try graph traversal (lowered threshold for better recall)
    if (result.relevanceScore < 0.6) {
      const graphResult = await this.retrieveGraphTraversal(
        query,
        analysis,
        maxTokens * 0.4
      );

      // Merge results
      result = await this.mergeRetrievalResults(result, graphResult, maxTokens);
    }
    
    // Add context from summaries if space allows
    const remainingTokens = maxTokens - result.metadata.tokens;
    if (remainingTokens > 500) {
      const contextResult = await this.addContextualInformation(
        query,
        result,
        remainingTokens
      );
      result = await this.mergeRetrievalResults(result, contextResult, maxTokens);
    }
    
    return result;
  }
  
  private async optimizeForLLM(
    result: RetrievalResult,
    _maxTokens: number
  ): Promise<RetrievalResult> {
    // Format and optimize content for LLM consumption
    const sections = this.identifySections(result);
    
    let optimizedContent = '';
    
    // Add document metadata summary
    if (result.metadata.documents && result.metadata.documents.length > 0) {
      optimizedContent += '## Retrieved Documents\n\n';
      for (const doc of result.metadata.documents) {
        optimizedContent += `- **${doc.title}** (${doc.type})\n`;
      }
      optimizedContent += '\n---\n\n';
    }
    
    // Add content with clear structure
    for (const section of sections) {
      optimizedContent += `## ${section.title}\n\n`;
      optimizedContent += section.content;
      optimizedContent += '\n\n';
    }
    
    // Add navigation hints for full documents
    if (result.metadata.strategy === 'full_document') {
      optimizedContent = this.addNavigationHints(optimizedContent);
    }
    
    return {
      ...result,
      content: optimizedContent,
      metadata: {
        ...result.metadata,
        optimized: true,
        sections: sections.map(s => ({ title: s.title, tokens: s.tokens }))
      }
    };
  }
  
  // Helper methods
  
  /**
   * Get cache statistics for monitoring
   */
  getCacheStats() {
    return this.queryCache.getStats();
  }

  /**
   * Clear all cached queries
   */
  async clearCache(): Promise<void> {
    await this.queryCache.clear();
    logger.info('GraphRAG query cache cleared');
  }
  
  private estimateTokens(text: string): number {
    return Math.ceil(text.length / 4);
  }
  
  /**
   * Build Qdrant v1.7+ compliant filter from query analysis
   *
   * Qdrant Filter Format:
   * - must: Array of conditions that ALL must match (AND logic)
   * - should: Array of conditions where AT LEAST ONE must match (OR logic)
   * - must_not: Array of conditions that NONE can match (NOT logic)
   *
   * Condition Types:
   * - { key: "field", match: { value: "exact_value" } }
   * - { key: "field", match: { any: ["value1", "value2"] } }
   * - { key: "field", range: { gte: 0.5, lte: 1.0 } }
   *
   * @param analysis Query analysis with intent and entities
   * @returns Qdrant filter object or undefined for no filtering
   */
  private buildSearchFilter(analysis: QueryAnalysis): any {
    const mustConditions: any[] = [];
    const shouldConditions: any[] = [];

    // Filter by entity types if code detected
    if (analysis.entities.some(e => e.type === 'code')) {
      shouldConditions.push({
        key: 'type',
        match: {
          any: ['code_block', 'function', 'class', 'method', 'interface']
        }
      });
    }

    // Filter by content type for specific sections
    if (analysis.entities.some(e => e.type === 'section')) {
      shouldConditions.push({
        key: 'type',
        match: {
          any: ['heading', 'section', 'paragraph']
        }
      });
    }

    // Filter by importance for summary requests
    if (analysis.intent === 'summary_request') {
      mustConditions.push({
        key: 'metadata.importance_score',
        range: {
          gte: 0.7
        }
      });
    }

    // Filter by key info flag for important queries
    if (analysis.requiresFullContext) {
      shouldConditions.push({
        key: 'metadata.contains_key_info',
        match: {
          value: true
        }
      });
    }

    // Build final filter structure
    const filter: any = {};

    if (mustConditions.length > 0) {
      filter.must = mustConditions;
    }

    if (shouldConditions.length > 0) {
      filter.should = shouldConditions;
    }

    // Return undefined if no filters (Qdrant will search all documents)
    return Object.keys(filter).length > 0 ? filter : undefined;
  }
  
  private async findStartingNodes(
    query: string,
    _analysis: QueryAnalysis
  ): Promise<Array<{ id: string }>> {
    // Find nodes to start graph traversal
    const embedding = await this.voyageClient.generateEmbedding(query, {
      inputType: 'query'
    });
    
    const results = await this.qdrantClient.search('chunks', {
      vector: embedding.embedding,  // FIXED: Use .embedding array
      limit: 5,
      score_threshold: 0.6  // Lowered from 0.7 for better recall
    });
    
    return results.map(r => ({ id: r.id as string }));
  }
  
  private async arrangeChunks(chunks: Chunk[]): Promise<{ text: string; documents: any[] }> {
    // Group chunks by document
    const documentGroups = new Map<string, Chunk[]>();
    
    for (const chunk of chunks) {
      const docId = chunk.document_id;
      if (!documentGroups.has(docId)) {
        documentGroups.set(docId, []);
      }
      documentGroups.get(docId)!.push(chunk);
    }
    
    // Sort chunks within each document
    for (const [_docId, docChunks] of documentGroups) {
      docChunks.sort((a, b) => a.position.start - b.position.start);
    }
    
    // Combine into final text
    let text = '';
    const documents: any[] = [];
    
    for (const [docId, docChunks] of documentGroups) {
      if (text) text += '\n\n---\n\n';
      
      // Try to get document metadata
      const document = await this.documentHelpers.getDocumentById(docId);
      
      if (document) {
        documents.push({
          id: docId,
          title: document.metadata.title,
          type: document.metadata.type
        });
        
        // Add document title as header
        text += `### ${document.metadata.title}\n\n`;
      } else {
        documents.push({
          id: docId,
          title: `Document ${docId.substring(0, 8)}...`,
          type: docChunks[0]?.type || 'unknown'
        });
      }
      
      // Add chunks
      for (const chunk of docChunks) {
        text += chunk.content + '\n\n';
      }
    }
    
    return { text, documents };
  }
  
  private async arrangeChunksWithGraph(chunks: Chunk[]): Promise<{ text: string }> {
    // Arrange chunks based on graph relationships
    // For now, sort by relevance score
    chunks.sort((a, b) => 
      (b.metadata.relevance_score || 0) - (a.metadata.relevance_score || 0)
    );
    
    const text = chunks.map(c => c.content).join('\n\n---\n\n');
    return { text };
  }
  
  private async getDetailedChunks(
    _query: string,
    relevantDocs: any[],
    maxTokens: number
  ): Promise<Chunk[]> {
    // Get detailed chunks for relevant document sections
    const chunks: Chunk[] = [];
    let totalTokens = 0;
    
    for (const doc of relevantDocs) {
      // Query chunks for this document
      const docChunks = await this.documentHelpers.getChunksForDocument(doc.id);
      
      for (const chunk of docChunks) {
        if (totalTokens + chunk.tokens <= maxTokens) {
          chunks.push(chunk);
          totalTokens += chunk.tokens;
        } else {
          break;
        }
      }
      
      if (totalTokens >= maxTokens) break;
    }
    
    return chunks;
  }
  
  private formatHierarchicalResult(docs: any[], chunks: Chunk[]): string {
    let result = '# Document Overview\n\n';
    
    // Add document summaries
    for (const doc of docs) {
      result += `## ${doc.outline?.title || 'Document'}\n\n`;
      result += `${doc.summary}\n\n`;
      
      // Add outline
      if (doc.outline?.sections?.length > 0) {
        result += '### Outline\n';
        for (const section of doc.outline.sections) {
          result += `- ${section.title}\n`;
        }
        result += '\n';
      }
    }
    
    // Add detailed chunks
    if (chunks.length > 0) {
      result += '\n---\n\n# Detailed Content\n\n';
      for (const chunk of chunks) {
        result += chunk.content + '\n\n';
      }
    }
    
    return result;
  }
  
  private async mergeRetrievalResults(
    result1: RetrievalResult,
    result2: RetrievalResult,
    maxTokens: number
  ): Promise<RetrievalResult> {
    // Merge two retrieval results
    const allChunks = [...result1.chunks, ...result2.chunks];
    
    // Deduplicate
    const uniqueChunks = Array.from(
      new Map(allChunks.map(c => [c.id, c])).values()
    );
    
    // Sort by relevance
    uniqueChunks.sort((a, b) => 
      (b.metadata.relevance_score || 0) - (a.metadata.relevance_score || 0)
    );
    
    // Select within token budget
    const selectedChunks: Chunk[] = [];
    let totalTokens = 0;
    
    for (const chunk of uniqueChunks) {
      if (totalTokens + chunk.tokens <= maxTokens) {
        selectedChunks.push(chunk);
        totalTokens += chunk.tokens;
      }
    }
    
    const arranged = await this.arrangeChunks(selectedChunks);

    return {
      content: arranged.text,
      chunks: selectedChunks,
      metadata: {
        strategy: 'adaptive',
        totalChunks: selectedChunks.length,
        tokens: totalTokens,
        documents: arranged.documents
      },
      relevanceScore: Math.max(result1.relevanceScore, result2.relevanceScore)
    };
  }
  
  private async addContextualInformation(
    _query: string,
    result: RetrievalResult,
    _maxTokens: number
  ): Promise<RetrievalResult> {
    // Add additional context from document summaries
    // This is a placeholder for more sophisticated context addition
    return result;
  }
  
  private identifySections(result: RetrievalResult): Array<{ title: string; content: string; tokens: number }> {
    // Simple section identification
    const sections = [];
    
    if (result.chunks.length > 0) {
      // Group by document or type
      const groups = new Map<string, Chunk[]>();
      
      for (const chunk of result.chunks) {
        const key = chunk.document_id;
        if (!groups.has(key)) {
          groups.set(key, []);
        }
        groups.get(key)!.push(chunk);
      }
      
      for (const [docId, chunks] of groups) {
        const content = chunks.map(c => c.content).join('\n\n');
        sections.push({
          title: `Document ${docId.substring(0, 8)}...`,
          content,
          tokens: chunks.reduce((sum, c) => sum + c.tokens, 0)
        });
      }
    } else {
      // Full document
      sections.push({
        title: 'Full Document',
        content: result.content,
        tokens: result.metadata.tokens
      });
    }
    
    return sections;
  }
  
  private addNavigationHints(content: string): string {
    // Add table of contents for long documents
    const lines = content.split('\n');
    const headers = lines.filter(line => line.match(/^#+\s+/));
    
    if (headers.length > 3) {
      let toc = '## Table of Contents\n\n';
      for (const header of headers) {
        const level = header.match(/^(#+)/)?.[1].length || 1;
        const title = header.replace(/^#+\s+/, '');
        toc += '  '.repeat(level - 1) + `- ${title}\n`;
      }
      
      return toc + '\n---\n\n' + content;
    }
    
    return content;
  }
}
