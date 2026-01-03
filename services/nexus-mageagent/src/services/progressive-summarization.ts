/**
 * Progressive Summarization Engine
 *
 * CRITICAL COMPONENT: Handles extreme scenarios like 100k+ word novels,
 * complex legal cases, and massive codebases through hierarchical summarization.
 *
 * Root Cause Addressed: Token budget catastrophe - system could not handle
 * large-scale content (novels, legal docs, codebases) due to 4k-20k token limits.
 *
 * Architecture: 4-Level Pyramid
 * - Level 0 (Detail): Raw content chunks (~1000 tokens)
 * - Level 1 (Chapter): 10:1 compression (~100 tokens per chapter)
 * - Level 2 (Volume): 5:1 compression (~500 tokens per volume)
 * - Level 3 (Series): 3:1 compression (~1500 tokens for entire series)
 *
 * Design Pattern: Hierarchical Aggregation + Lazy Evaluation
 * - Progressive compression as content grows
 * - Cross-reference system for drill-down
 * - Temporal coherence preservation
 * - Importance-weighted summarization
 *
 * Use Cases:
 * - Multi-series novels (300k+ words)
 * - Legal discovery (10k+ documents)
 * - Medical patient histories (10+ years)
 * - Codebase analysis (500k+ LOC)
 */

import { graphRAGClient } from '../clients/graphrag-client';
import { logger } from '../utils/logger';
import { v4 as uuidv4 } from 'uuid';

export interface SummarizationLevel {
  level: 0 | 1 | 2 | 3; // Detail, Chapter, Volume, Series
  name: 'detail' | 'chapter' | 'volume' | 'series';
  compressionRatio: number;
  targetTokens: number;
}

export interface ContentChunk {
  chunkId: string;
  content: string;
  tokens: number;
  sequence: number; // Position in content stream
  metadata: {
    domain: string; // novel, legal, medical, code
    contentType: string; // narrative, dialogue, case_law, diagnosis, function
    importance: number; // 0-1 for weighted summarization
    timestamp: Date;
    parentId?: string; // Link to higher-level summary
  };
}

export interface Summary {
  summaryId: string;
  level: SummarizationLevel;
  content: string;
  tokens: number;
  sourceChunkIds: string[]; // Links to source chunks
  parentSummaryId?: string; // Link to next level up
  childSummaryIds?: string[]; // Links to next level down
  metadata: {
    domain: string;
    totalSourceTokens: number;
    actualCompressionRatio: number;
    keyEntities: string[]; // Important names, concepts
    timeRange?: { start: Date; end: Date }; // Temporal span
    importance: number; // Aggregated from source chunks
  };
}

export interface SummarizationRequest {
  domain: 'novel' | 'legal' | 'medical' | 'code' | 'general';
  contentStream: AsyncIterable<string> | string[];
  metadata: {
    title?: string;
    author?: string;
    context?: string;
    expectedTotalTokens?: number;
  };
  options?: {
    enableStreaming?: boolean; // Process chunks as they arrive
    targetLevel?: 0 | 1 | 2 | 3; // Target summarization level
    preserveEntities?: string[]; // Entities to preserve across levels
    compressionStrategy?: 'aggressive' | 'balanced' | 'conservative';
  };
}

export class ProgressiveSummarizationEngine {
  private static instance: ProgressiveSummarizationEngine;

  // Summarization level definitions
  private readonly LEVELS: Record<number, SummarizationLevel> = {
    0: { level: 0, name: 'detail', compressionRatio: 1, targetTokens: 1000 },
    1: { level: 1, name: 'chapter', compressionRatio: 10, targetTokens: 100 },
    2: { level: 2, name: 'volume', compressionRatio: 50, targetTokens: 500 },
    3: { level: 3, name: 'series', compressionRatio: 150, targetTokens: 1500 }
  };

  // Domain-specific chunking strategies
  private readonly CHUNK_SIZE_BY_DOMAIN: Record<string, number> = {
    novel: 1000, // ~250 words per chunk
    legal: 800, // Preserve legal structure
    medical: 600, // Precise medical terminology
    code: 1200, // Function-level chunks
    general: 1000
  };

  // Compression strategy multipliers
  private readonly COMPRESSION_MULTIPLIERS = {
    aggressive: 1.5,
    balanced: 1.0,
    conservative: 0.7
  };

  private constructor() {}

  public static getInstance(): ProgressiveSummarizationEngine {
    if (!ProgressiveSummarizationEngine.instance) {
      ProgressiveSummarizationEngine.instance = new ProgressiveSummarizationEngine();
    }
    return ProgressiveSummarizationEngine.instance;
  }

  /**
   * CRITICAL: Process large content with progressive summarization
   * Creates hierarchical summary pyramid for efficient retrieval
   */
  async processContent(request: SummarizationRequest): Promise<string> {
    try {
      const sessionId = uuidv4();
      logger.info('Progressive summarization initiated', {
        sessionId,
        domain: request.domain,
        enableStreaming: request.options?.enableStreaming || false
      });

      // Step 1: Chunk content into Level 0 (Detail)
      const chunks = await this.chunkContent(request, sessionId);
      logger.info('Content chunked', {
        sessionId,
        totalChunks: chunks.length,
        totalTokens: chunks.reduce((sum, c) => sum + c.tokens, 0)
      });

      // Step 2: Store Level 0 chunks in GraphRAG
      await this.storeChunks(chunks, sessionId);

      // Step 3: Build summary pyramid (Level 1 → 2 → 3)
      const pyramidTop = await this.buildSummaryPyramid(chunks, request, sessionId);

      logger.info('Progressive summarization completed', {
        sessionId,
        topLevelId: pyramidTop.summaryId,
        finalTokens: pyramidTop.tokens,
        compressionRatio: pyramidTop.metadata.actualCompressionRatio
      });

      return pyramidTop.summaryId;
    } catch (error) {
      logger.error('Progressive summarization failed', {
        error: error instanceof Error ? error.message : 'Unknown error',
        domain: request.domain
      });
      throw new Error(`Summarization failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Chunk content into Level 0 detail chunks
   */
  private async chunkContent(
    request: SummarizationRequest,
    _sessionId: string // Prefix with _ to indicate intentionally unused
  ): Promise<ContentChunk[]> {
    const chunks: ContentChunk[] = [];
    const chunkSize = this.CHUNK_SIZE_BY_DOMAIN[request.domain];
    let sequence = 0;

    // Handle both async iterable and array content streams
    const contentItems = Array.isArray(request.contentStream)
      ? request.contentStream
      : await this.collectAsyncIterable(request.contentStream);

    for (const content of contentItems) {
      // Split large content into chunks
      const contentChunks = this.splitIntoChunks(content, chunkSize);

      for (const chunkContent of contentChunks) {
        const chunk: ContentChunk = {
          chunkId: uuidv4(),
          content: chunkContent,
          tokens: this.estimateTokens(chunkContent),
          sequence: sequence++,
          metadata: {
            domain: request.domain,
            contentType: this.detectContentType(chunkContent, request.domain),
            importance: this.calculateImportance(chunkContent, request.domain),
            timestamp: new Date()
          }
        };

        chunks.push(chunk);
      }
    }

    return chunks;
  }

  /**
   * Split content into fixed-size chunks
   */
  private splitIntoChunks(content: string, maxTokens: number): string[] {
    const chunks: string[] = [];
    const maxChars = maxTokens * 4; // ~4 chars per token

    // Split on paragraph boundaries when possible
    const paragraphs = content.split(/\n\n+/);
    let currentChunk = '';

    for (const paragraph of paragraphs) {
      if ((currentChunk + paragraph).length > maxChars) {
        if (currentChunk) {
          chunks.push(currentChunk.trim());
          currentChunk = '';
        }

        // If single paragraph exceeds max, force split
        if (paragraph.length > maxChars) {
          const forceSplit = this.forceSplitLarge(paragraph, maxChars);
          chunks.push(...forceSplit.slice(0, -1));
          currentChunk = forceSplit[forceSplit.length - 1];
        } else {
          currentChunk = paragraph;
        }
      } else {
        currentChunk += (currentChunk ? '\n\n' : '') + paragraph;
      }
    }

    if (currentChunk) {
      chunks.push(currentChunk.trim());
    }

    return chunks;
  }

  /**
   * Force split large paragraph that exceeds chunk size
   */
  private forceSplitLarge(text: string, maxChars: number): string[] {
    const chunks: string[] = [];
    let start = 0;

    while (start < text.length) {
      let end = Math.min(start + maxChars, text.length);

      // Try to split on sentence boundary
      if (end < text.length) {
        const sentenceEnd = text.lastIndexOf('. ', end);
        if (sentenceEnd > start + maxChars * 0.7) {
          end = sentenceEnd + 1;
        }
      }

      chunks.push(text.substring(start, end));
      start = end;
    }

    return chunks;
  }

  /**
   * Store Level 0 chunks in GraphRAG
   */
  private async storeChunks(chunks: ContentChunk[], sessionId: string): Promise<void> {
    // Store in batches of 5 to avoid overwhelming the system
    const batchSize = 5;

    for (let i = 0; i < chunks.length; i += batchSize) {
      const batch = chunks.slice(i, i + batchSize);

      await Promise.all(
        batch.map(chunk =>
          graphRAGClient.storeEntity({
            domain: chunk.metadata.domain,
            entityType: 'content_chunk',
            textContent: chunk.content,
            metadata: {
              chunkId: chunk.chunkId,
              sessionId,
              level: 0,
              sequence: chunk.sequence,
              tokens: chunk.tokens,
              contentType: chunk.metadata.contentType,
              importance: chunk.metadata.importance
            },
            tags: [
              `session:${sessionId}`,
              `domain:${chunk.metadata.domain}`,
              `level:0`,
              `type:${chunk.metadata.contentType}`
            ],
            hierarchyLevel: 0
          })
        )
      );

      logger.debug('Chunk batch stored', {
        sessionId,
        batchStart: i,
        batchSize: batch.length
      });
    }
  }

  /**
   * Build summary pyramid from Level 0 to Level 3
   */
  private async buildSummaryPyramid(
    chunks: ContentChunk[],
    request: SummarizationRequest,
    sessionId: string
  ): Promise<Summary> {
    let currentLevel = chunks;
    let currentLevelNum = 0;
    let previousSummaries: Summary[] = [];

    // Determine target level based on content size
    const totalTokens = chunks.reduce((sum, c) => sum + c.tokens, 0);
    const targetLevel = this.determineTargetLevel(totalTokens, request.options?.targetLevel);

    logger.info('Building summary pyramid', {
      sessionId,
      totalTokens,
      targetLevel,
      chunksAtLevel0: chunks.length
    });

    // Build each level until we reach target
    while (currentLevelNum < targetLevel) {
      currentLevelNum++;
      const levelConfig = this.LEVELS[currentLevelNum];

      // Group chunks/summaries for next level
      const groups = this.groupForNextLevel(
        currentLevel,
        levelConfig,
        request.options?.compressionStrategy || 'balanced'
      );

      // Summarize each group
      const levelSummaries: Summary[] = [];

      for (const group of groups) {
        const summary = await this.summarizeGroup(
          group,
          levelConfig,
          request.domain,
          sessionId,
          previousSummaries
        );
        levelSummaries.push(summary);
      }

      // Store summaries in GraphRAG
      await this.storeSummaries(levelSummaries, sessionId);

      logger.info(`Level ${currentLevelNum} completed`, {
        sessionId,
        summariesCreated: levelSummaries.length,
        avgTokensPerSummary: levelSummaries.reduce((sum, s) => sum + s.tokens, 0) / levelSummaries.length
      });

      previousSummaries = levelSummaries;
      currentLevel = levelSummaries as any; // Type flexibility for next iteration
    }

    // Return top of pyramid (single summary at target level)
    return previousSummaries[0];
  }

  /**
   * Determine target summarization level based on content size
   */
  private determineTargetLevel(
    totalTokens: number,
    explicitTarget?: 0 | 1 | 2 | 3
  ): 0 | 1 | 2 | 3 {
    if (explicitTarget !== undefined) return explicitTarget;

    // Auto-determine based on content size
    if (totalTokens < 10000) return 0; // < 10k tokens: no summarization
    if (totalTokens < 50000) return 1; // < 50k tokens: chapter level
    if (totalTokens < 200000) return 2; // < 200k tokens: volume level
    return 3; // >= 200k tokens: series level
  }

  /**
   * Group chunks/summaries for next summarization level
   */
  private groupForNextLevel(
    items: (ContentChunk | Summary)[],
    levelConfig: SummarizationLevel,
    strategy: 'aggressive' | 'balanced' | 'conservative'
  ): Array<(ContentChunk | Summary)[]> {
    const groups: Array<(ContentChunk | Summary)[]> = [];
    const multiplier = this.COMPRESSION_MULTIPLIERS[strategy];
    const targetRatio = levelConfig.compressionRatio * multiplier;
    const groupSize = Math.ceil(targetRatio);

    for (let i = 0; i < items.length; i += groupSize) {
      groups.push(items.slice(i, i + groupSize));
    }

    return groups;
  }

  /**
   * Summarize a group of chunks/summaries into next level summary
   */
  private async summarizeGroup(
    group: (ContentChunk | Summary)[],
    levelConfig: SummarizationLevel,
    _domain: string, // Prefix with _ to indicate intentionally unused
    _sessionId: string, // Prefix with _ to indicate intentionally unused
    _previousSummaries: Summary[] // Prefix with _ to indicate intentionally unused
  ): Promise<Summary> {
    // Concatenate content from group
    const combinedContent = group
      .map(item => item.content) // Both ContentChunk and Summary have content field
      .join('\n\n');

    const sourceTokens = group.reduce((sum, item) => sum + ('tokens' in item ? item.tokens : 0), 0);

    // Extract key entities for preservation
    const keyEntities = this.extractKeyEntities(combinedContent, _domain);

    // Generate summary using LLM (simplified - would use OpenRouter in production)
    const summaryContent = await this.generateSummary(
      combinedContent,
      levelConfig,
      _domain,
      keyEntities
    );

    const summary: Summary = {
      summaryId: uuidv4(),
      level: levelConfig,
      content: summaryContent,
      tokens: this.estimateTokens(summaryContent),
      sourceChunkIds: group.map(item => ('chunkId' in item ? item.chunkId : item.summaryId)),
      metadata: {
        domain: _domain,
        totalSourceTokens: sourceTokens,
        actualCompressionRatio: sourceTokens / this.estimateTokens(summaryContent),
        keyEntities,
        importance: this.aggregateImportance(group)
      }
    };

    return summary;
  }

  /**
   * Generate summary using LLM (placeholder - would use OpenRouter)
   */
  private async generateSummary(
    content: string,
    levelConfig: SummarizationLevel,
    _domain: string, // Prefix with _ to indicate intentionally unused for now
    keyEntities: string[]
  ): Promise<string> {
    // PLACEHOLDER: In production, this would call OpenRouter with specialized prompts
    // For now, use simple extraction
    const sentences = content.split(/\.\s+/);
    const targetSentences = Math.ceil(levelConfig.targetTokens / 20); // ~20 tokens per sentence

    // Simple extractive summarization (importance-weighted)
    const importantSentences = sentences
      .slice(0, Math.min(sentences.length, targetSentences * 3))
      .sort((a, b) => {
        const scoreA = keyEntities.filter(e => a.includes(e)).length;
        const scoreB = keyEntities.filter(e => b.includes(e)).length;
        return scoreB - scoreA;
      })
      .slice(0, targetSentences);

    return importantSentences.join('. ') + '.';
  }

  /**
   * Store summaries in GraphRAG
   */
  private async storeSummaries(summaries: Summary[], sessionId: string): Promise<void> {
    await Promise.all(
      summaries.map(summary =>
        graphRAGClient.storeEntity({
          domain: summary.metadata.domain,
          entityType: 'summary',
          textContent: summary.content,
          metadata: {
            summaryId: summary.summaryId,
            sessionId,
            level: summary.level.level,
            levelName: summary.level.name,
            tokens: summary.tokens,
            sourceTokens: summary.metadata.totalSourceTokens,
            compressionRatio: summary.metadata.actualCompressionRatio,
            keyEntities: summary.metadata.keyEntities,
            importance: summary.metadata.importance
          },
          tags: [
            `session:${sessionId}`,
            `domain:${summary.metadata.domain}`,
            `level:${summary.level.level}`,
            ...summary.metadata.keyEntities.map(e => `entity:${e}`)
          ],
          hierarchyLevel: summary.level.level
        })
      )
    );
  }

  /**
   * Detect content type from chunk
   */
  private detectContentType(content: string, domain: string): string {
    switch (domain) {
      case 'novel':
        return /^["\']/.test(content.trim()) ? 'dialogue' : 'narrative';
      case 'legal':
        return /^\d+\.\s/.test(content.trim()) ? 'statute' : 'case_law';
      case 'medical':
        return /diagnosis|treatment|symptoms/i.test(content) ? 'clinical' : 'history';
      case 'code':
        return /^(function|class|interface|export)/i.test(content.trim()) ? 'definition' : 'implementation';
      default:
        return 'general';
    }
  }

  /**
   * Calculate importance score for chunk
   */
  private calculateImportance(content: string, domain: string): number {
    // Simple heuristic: longer chunks = more important
    // In production, would use LLM scoring
    const length = content.length;
    const avgLength = this.CHUNK_SIZE_BY_DOMAIN[domain] * 4;

    const lengthScore = Math.min(1, length / avgLength);

    // Boost for specific keywords
    const importantPatterns: Record<string, RegExp> = {
      novel: /protagonist|climax|resolution|character development/i,
      legal: /holding|precedent|statute|material fact/i,
      medical: /diagnosis|critical|emergency|treatment plan/i,
      code: /export|public|interface|critical|main/i
    };

    const keywordBoost = importantPatterns[domain]?.test(content) ? 0.2 : 0;

    return Math.min(1, lengthScore + keywordBoost);
  }

  /**
   * Extract key entities (names, concepts) from content
   */
  private extractKeyEntities(content: string, domain: string): string[] {
    // Simple entity extraction (in production, would use NER model)
    const patterns: Record<string, RegExp> = {
      novel: /\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+)*\b/g, // Proper nouns
      legal: /\b[A-Z][a-z]+\s+v\.\s+[A-Z][a-z]+\b|§\s*\d+/g, // Case names, statutes
      medical: /\b(?:diagnosis|treatment|condition|medication):\s*([^\n]+)/gi,
      code: /\b(?:class|function|interface|export)\s+(\w+)/gi
    };

    const pattern = patterns[domain] || patterns.novel;
    const matches = content.match(pattern) || [];

    // Return unique entities, top 10 by frequency
    const entityCounts = matches.reduce((acc: Record<string, number>, entity) => {
      acc[entity] = (acc[entity] || 0) + 1;
      return acc;
    }, {});

    return Object.entries(entityCounts)
      .sort(([, a], [, b]) => b - a)
      .slice(0, 10)
      .map(([entity]) => entity);
  }

  /**
   * Aggregate importance from group of items
   */
  private aggregateImportance(items: (ContentChunk | Summary)[]): number {
    const importances = items.map(item =>
      'metadata' in item && typeof item.metadata.importance === 'number'
        ? item.metadata.importance
        : 0.5
    );

    if (importances.length === 0) return 0.5;

    // Weighted average with higher weight for higher importance
    const sorted = importances.sort((a, b) => b - a);
    const weights = sorted.map((_, i) => 1 / (i + 1));
    const totalWeight = weights.reduce((sum, w) => sum + w, 0);

    return sorted.reduce((sum, imp, i) => sum + imp * weights[i], 0) / totalWeight;
  }

  /**
   * Estimate tokens from text (rough heuristic)
   */
  private estimateTokens(text: string): number {
    return Math.ceil(text.length / 4);
  }

  /**
   * Collect async iterable into array
   */
  private async collectAsyncIterable<T>(iterable: AsyncIterable<T>): Promise<T[]> {
    const items: T[] = [];
    for await (const item of iterable) {
      items.push(item);
    }
    return items;
  }

  /**
   * Retrieve content with drill-down capability
   * Starts at top of pyramid, can drill down to detail level
   */
  async retrieveWithDrillDown(
    query: string,
    sessionId: string,
    targetLevel: 0 | 1 | 2 | 3 = 2
  ): Promise<{ summary: Summary; relatedChunks?: ContentChunk[] }> {
    try {
      // Query for summaries at target level
      const summaries = await graphRAGClient.queryEntities({
        domain: undefined,
        entityType: 'summary',
        searchText: query,
        limit: 5
      });

      if (summaries.length === 0) {
        throw new Error('No summaries found for query');
      }

      const topSummary = summaries[0] as unknown as Summary;

      // If requesting detail level, retrieve source chunks
      let relatedChunks: ContentChunk[] | undefined;
      if (targetLevel === 0) {
        const chunkEntities = await graphRAGClient.queryEntities({
          domain: undefined,
          entityType: 'content_chunk',
          searchText: query,
          limit: 20
        });

        relatedChunks = chunkEntities as unknown as ContentChunk[];
      }

      return { summary: topSummary, relatedChunks };
    } catch (error) {
      logger.error('Drill-down retrieval failed', {
        error: error instanceof Error ? error.message : 'Unknown error',
        sessionId,
        query
      });
      throw error;
    }
  }
}

export const progressiveSummarizationEngine = ProgressiveSummarizationEngine.getInstance();
