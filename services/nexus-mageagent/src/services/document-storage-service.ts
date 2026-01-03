/**
 * Document Storage Service for MageAgent
 * Stores agent outputs as searchable documents in GraphRAG
 * Handles chunking, embedding, and indexing
 */

import { v4 as uuidv4 } from 'uuid';
import { graphRAGClient, createGraphRAGClient } from '../clients/graphrag-client';
import { TenantContext } from '../middleware/tenant-context';
import { logger } from '../utils/logger';
import crypto from 'crypto';

export interface AgentDocument {
  id: string;
  content: string;
  title: string;
  metadata: {
    agentId: string;
    agentName: string;
    model: string;
    taskId: string;
    sessionId: string;
    timestamp: Date;
    type: 'agent_output' | 'synthesis' | 'analysis' | 'competition_result' | 'collaboration';
    tags: string[];
    wordCount: number;
    tokenCount?: number;
    hash: string;
    parentDocId?: string;
    version?: number;
    language?: string;
    confidence?: number;
    quality?: number;
  };
  chunks?: DocumentChunk[];
  embeddings?: boolean;
  indexed?: boolean;
}

export interface DocumentChunk {
  id: string;
  documentId: string;
  content: string;
  index: number;
  startOffset: number;
  endOffset: number;
  tokens?: number;
  embedding?: number[];
}

export interface DocumentSearchResult {
  document: AgentDocument;
  relevanceScore: number;
  matchedChunks: DocumentChunk[];
  highlights: string[];
}

export class DocumentStorageService {
  private static instance: DocumentStorageService;
  private readonly MIN_DOCUMENT_LENGTH = 100; // Minimum chars to store as document
  private readonly MAX_CHUNK_SIZE = 1000; // Max tokens per chunk
  private readonly CHUNK_OVERLAP = 100; // Token overlap between chunks
  private documentCache: Map<string, AgentDocument> = new Map();
  private hashCache: Map<string, string> = new Map(); // For deduplication

  private constructor() {}

  public static getInstance(): DocumentStorageService {
    if (!DocumentStorageService.instance) {
      DocumentStorageService.instance = new DocumentStorageService();
    }
    return DocumentStorageService.instance;
  }

  /**
   * Store agent output as document if it meets criteria
   *
   * PHASE 44: Added tenantContext parameter for multi-tenant isolation
   */
  async storeAgentOutput(
    agent: any,
    output: any,
    task: any,
    sessionId: string,
    tenantContext?: TenantContext
  ): Promise<AgentDocument | undefined> {
    try {
      const content = this.extractContent(output);

      // Check if content is substantial enough to store as document
      if (content.length < this.MIN_DOCUMENT_LENGTH) {
        logger.debug('Content too short for document storage', {
          length: content.length,
          agentId: agent.id
        });
        return undefined;
      }

      // Check for duplicate content
      const contentHash = this.hashContent(content);
      if (this.hashCache.has(contentHash)) {
        logger.debug('Duplicate content detected, skipping storage', {
          hash: contentHash,
          agentId: agent.id
        });
        return undefined;
      }

      // Create document
      const document: AgentDocument = {
        id: uuidv4(),
        content,
        title: this.generateTitle(content, task),
        metadata: {
          agentId: agent.id || agent.agentId,
          agentName: agent.name,
          model: agent.model,
          taskId: task.id || task.taskId,
          sessionId,
          timestamp: new Date(),
          type: this.determineDocumentType(task, output),
          tags: this.generateTags(content, task, agent),
          wordCount: this.countWords(content),
          tokenCount: output.usage?.totalTokens || this.estimateTokens(content),
          hash: contentHash,
          parentDocId: task.parentDocId,
          version: 1,
          language: this.detectLanguage(content),
          confidence: output.confidence || 0.8,
          quality: this.assessQuality(content, output)
        },
        embeddings: false,
        indexed: false
      };

      // Create chunks for large documents
      if (document.metadata.tokenCount! > this.MAX_CHUNK_SIZE) {
        document.chunks = await this.createChunks(document);
      }

      // Store in GraphRAG
      // PHASE 44: Pass tenant context for multi-tenant isolation
      const storedDoc = await this.storeInGraphRAG(document, tenantContext);

      // Cache document and hash
      this.documentCache.set(storedDoc.id, storedDoc);
      this.hashCache.set(contentHash, storedDoc.id);

      // Clean up old cache entries
      this.cleanCache();

      logger.info('Agent output stored as document', {
        documentId: storedDoc.id,
        title: storedDoc.title,
        wordCount: storedDoc.metadata.wordCount,
        chunks: storedDoc.chunks?.length || 0
      });

      return storedDoc;
    } catch (error) {
      logger.error('Failed to store agent output as document', { error });
      return undefined;
    }
  }

  /**
   * Store a synthesis document from multiple agent outputs
   *
   * PHASE 44: Added tenantContext parameter for multi-tenant isolation
   */
  async storeSynthesisDocument(
    outputs: any[],
    task: any,
    sessionId: string,
    tenantContext?: TenantContext
  ): Promise<AgentDocument> {
    try {
      // Combine outputs into synthesis
      const synthesizedContent = this.synthesizeOutputs(outputs);

      const document: AgentDocument = {
        id: uuidv4(),
        content: synthesizedContent,
        title: `Synthesis: ${task.name || task.query}`,
        metadata: {
          agentId: 'synthesis',
          agentName: 'Synthesis Engine',
          model: 'multi-agent',
          taskId: task.id || task.taskId,
          sessionId,
          timestamp: new Date(),
          type: 'synthesis',
          tags: ['synthesis', 'multi-agent', ...this.extractTopics(synthesizedContent)],
          wordCount: this.countWords(synthesizedContent),
          tokenCount: this.estimateTokens(synthesizedContent),
          hash: this.hashContent(synthesizedContent),
          quality: this.assessSynthesisQuality(outputs)
        },
        embeddings: false,
        indexed: false
      };

      // Create chunks if needed
      if (document.metadata.tokenCount! > this.MAX_CHUNK_SIZE) {
        document.chunks = await this.createChunks(document);
      }

      // Store in GraphRAG
      // PHASE 44: Pass tenant context for multi-tenant isolation
      const storedDoc = await this.storeInGraphRAG(document, tenantContext);

      // Link to source documents
      for (const output of outputs) {
        if (output.documentId) {
          await this.linkDocuments(storedDoc.id, output.documentId, 'synthesized_from');
        }
      }

      this.documentCache.set(storedDoc.id, storedDoc);

      logger.info('Synthesis document created', {
        documentId: storedDoc.id,
        sourceCount: outputs.length,
        wordCount: storedDoc.metadata.wordCount
      });

      return storedDoc;
    } catch (error) {
      logger.error('Failed to store synthesis document', { error });
      throw error;
    }
  }

  /**
   * Search documents by query
   */
  async searchDocuments(
    query: string,
    options: {
      limit?: number;
      agentId?: string;
      sessionId?: string;
      type?: string;
      minScore?: number;
    } = {}
  ): Promise<DocumentSearchResult[]> {
    try {
      // Search in GraphRAG
      const results = await graphRAGClient.retrieveDocuments({
        query,
        limit: options.limit || 10,
        strategy: 'semantic_chunks'
      });

      // Process and rank results
      const searchResults: DocumentSearchResult[] = [];

      for (const result of results) {
        // Filter by options
        if (options.agentId && result.metadata?.agentId !== options.agentId) continue;
        if (options.sessionId && result.metadata?.sessionId !== options.sessionId) continue;
        if (options.type && result.metadata?.type !== options.type) continue;

        // Check cache for full document
        let document = this.documentCache.get(result.id);
        if (!document) {
          document = await this.getDocument(result.id);
        }

        if (document) {
          const relevanceScore = result.score || this.calculateRelevance(query, document);

          if (relevanceScore >= (options.minScore || 0.3)) {
            searchResults.push({
              document,
              relevanceScore,
              matchedChunks: result.chunks || [],
              highlights: this.generateHighlights(query, document.content)
            });
          }
        }
      }

      // Sort by relevance
      searchResults.sort((a, b) => b.relevanceScore - a.relevanceScore);

      return searchResults.slice(0, options.limit || 10);
    } catch (error) {
      logger.error('Failed to search documents', { error, query });
      return [];
    }
  }

  /**
   * Get document by ID
   */
  async getDocument(documentId: string): Promise<AgentDocument | undefined> {
    try {
      // Check cache first
      const cached = this.documentCache.get(documentId);
      if (cached) return cached;

      // Retrieve from GraphRAG
      const doc = await graphRAGClient.getFullDocument(documentId);
      if (doc) {
        const document: AgentDocument = {
          id: doc.id,
          content: doc.content,
          title: doc.title,
          metadata: doc.metadata,
          chunks: doc.chunks,
          embeddings: true,
          indexed: true
        };

        this.documentCache.set(documentId, document);
        return document;
      }

      return undefined;
    } catch (error) {
      logger.error('Failed to get document', { error, documentId });
      return undefined;
    }
  }

  /**
   * Update document version
   *
   * PHASE 44: Added tenantContext parameter for multi-tenant isolation
   */
  async updateDocument(
    documentId: string,
    newContent: string,
    metadata?: any,
    tenantContext?: TenantContext
  ): Promise<AgentDocument> {
    try {
      const existingDoc = await this.getDocument(documentId);
      if (!existingDoc) {
        throw new Error(`Document ${documentId} not found`);
      }

      // Create new version
      const updatedDoc: AgentDocument = {
        ...existingDoc,
        id: uuidv4(), // New ID for new version
        content: newContent,
        metadata: {
          ...existingDoc.metadata,
          ...metadata,
          parentDocId: documentId,
          version: (existingDoc.metadata.version || 1) + 1,
          timestamp: new Date(),
          hash: this.hashContent(newContent),
          wordCount: this.countWords(newContent),
          tokenCount: this.estimateTokens(newContent)
        }
      };

      // Create new chunks if needed
      if (updatedDoc.metadata.tokenCount! > this.MAX_CHUNK_SIZE) {
        updatedDoc.chunks = await this.createChunks(updatedDoc);
      }

      // Store new version
      // PHASE 44: Pass tenant context for multi-tenant isolation
      const storedDoc = await this.storeInGraphRAG(updatedDoc, tenantContext);

      // Link versions
      await this.linkDocuments(storedDoc.id, documentId, 'version_of');

      this.documentCache.set(storedDoc.id, storedDoc);

      logger.info('Document updated', {
        oldId: documentId,
        newId: storedDoc.id,
        version: storedDoc.metadata.version
      });

      return storedDoc;
    } catch (error) {
      logger.error('Failed to update document', { error, documentId });
      throw error;
    }
  }

  /**
   * Store document in GraphRAG
   *
   * PHASE 44: Updated to accept tenantContext for multi-tenant isolation.
   * Uses dynamic GraphRAGClient when tenant context is provided.
   */
  private async storeInGraphRAG(document: AgentDocument, tenantContext?: TenantContext): Promise<AgentDocument> {
    try {
      // PHASE 44: Use dynamic client with tenant context for multi-tenant isolation
      const client = tenantContext ? createGraphRAGClient(tenantContext) : graphRAGClient;

      const result = await client.storeDocument(
        document.content,
        {
          title: document.title,
          ...document.metadata,
          timestamp: document.metadata.timestamp.toISOString()
        }
      );

      // Also create memory for cross-reference
      await client.storeMemory({
        content: document.title + ': ' + document.content.substring(0, 200),
        tags: document.metadata.tags,
        metadata: {
          documentId: result.documentId || document.id,
          type: 'document_reference'
        }
      });

      return {
        ...document,
        id: result.documentId || document.id,
        embeddings: true,
        indexed: true
      };
    } catch (error) {
      logger.error('Failed to store document in GraphRAG', { error });
      throw error;
    }
  }

  /**
   * Create chunks for large document
   */
  private async createChunks(document: AgentDocument): Promise<DocumentChunk[]> {
    const chunks: DocumentChunk[] = [];
    const words = document.content.split(/\s+/);
    const wordsPerChunk = Math.floor(this.MAX_CHUNK_SIZE / 0.75); // Estimate tokens
    const overlapWords = Math.floor(this.CHUNK_OVERLAP / 0.75);

    let index = 0;
    let startOffset = 0;

    while (startOffset < words.length) {
      const endOffset = Math.min(startOffset + wordsPerChunk, words.length);
      const chunkWords = words.slice(startOffset, endOffset);
      const chunkContent = chunkWords.join(' ');

      chunks.push({
        id: `${document.id}-chunk-${index}`,
        documentId: document.id,
        content: chunkContent,
        index,
        startOffset,
        endOffset,
        tokens: this.estimateTokens(chunkContent)
      });

      index++;
      startOffset = endOffset - overlapWords; // Overlap with previous chunk
    }

    return chunks;
  }

  /**
   * Link related documents
   */
  private async linkDocuments(
    sourceId: string,
    targetId: string,
    relationship: string
  ): Promise<void> {
    try {
      // In production, store this relationship in Neo4j
      logger.debug('Documents linked', { sourceId, targetId, relationship });
    } catch (error) {
      logger.error('Failed to link documents', { error, sourceId, targetId });
    }
  }

  /**
   * Extract content from agent output
   */
  private extractContent(output: any): string {
    if (typeof output === 'string') return output;
    if (output.text) return output.text;
    if (output.content) return output.content;
    if (output.response) return output.response;
    if (output.result) return this.extractContent(output.result);
    return JSON.stringify(output);
  }

  /**
   * Generate title for document
   */
  private generateTitle(content: string, task: any): string {
    // Use task name if available
    if (task.name) return task.name;
    if (task.query) return `Response to: ${task.query.substring(0, 50)}`;

    // Extract first sentence as title
    const firstSentence = content.match(/^[^.!?]+[.!?]/);
    if (firstSentence) {
      return firstSentence[0].substring(0, 100);
    }

    // Use first 100 chars
    return content.substring(0, 100) + '...';
  }

  /**
   * Determine document type based on task and output
   */
  private determineDocumentType(task: any, _output: any): AgentDocument['metadata']['type'] {
    if (task.type === 'synthesis') return 'synthesis';
    if (task.type === 'analysis') return 'analysis';
    if (task.type === 'competition') return 'competition_result';
    if (task.type === 'collaboration') return 'collaboration';
    return 'agent_output';
  }

  /**
   * Generate tags for document
   */
  private generateTags(content: string, task: any, agent: any): string[] {
    const tags = new Set<string>();

    // Add basic tags
    tags.add('agent-output');
    tags.add(agent.model);
    if (task.type) tags.add(task.type);
    if (agent.role) tags.add(agent.role);

    // Extract topics (simplified)
    const topics = this.extractTopics(content);
    topics.forEach(topic => tags.add(topic));

    return Array.from(tags).slice(0, 10); // Limit to 10 tags
  }

  /**
   * Extract topics from content (simplified)
   */
  private extractTopics(content: string): string[] {
    const topics: string[] = [];

    // Look for capitalized phrases (potential topics)
    const capitalizedPhrases: string[] = content.match(/\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+)*/g) || [];

    // Filter out common words and short phrases
    const filtered = capitalizedPhrases
      .filter(phrase => phrase.length > 3 && !['The', 'This', 'That', 'What'].includes(phrase))
      .slice(0, 5);

    topics.push(...filtered);

    return topics;
  }

  /**
   * Synthesize multiple outputs into one document
   */
  private synthesizeOutputs(outputs: any[]): string {
    const sections: string[] = [];

    sections.push('# Multi-Agent Synthesis\n');
    sections.push(`Synthesized from ${outputs.length} agent outputs\n\n`);

    outputs.forEach((output, index) => {
      const content = this.extractContent(output);
      const agentInfo = output.agent ? `${output.agent.name} (${output.agent.model})` : `Agent ${index + 1}`;

      sections.push(`## ${agentInfo}\n`);
      sections.push(content);
      sections.push('\n\n');
    });

    // Add consensus section if applicable
    const consensus = this.findConsensus(outputs);
    if (consensus) {
      sections.push('## Consensus\n');
      sections.push(consensus);
    }

    return sections.join('');
  }

  /**
   * Find consensus among outputs (simplified)
   */
  private findConsensus(outputs: any[]): string | null {
    // In production, use more sophisticated consensus detection
    const contents = outputs.map(o => this.extractContent(o).toLowerCase());

    // Find common phrases
    const commonPhrases: string[] = [];

    // Simple approach: find sentences that appear in multiple outputs
    const sentences = contents.flatMap(c => c.split(/[.!?]+/));
    const sentenceCounts = new Map<string, number>();

    sentences.forEach(s => {
      const normalized = s.trim();
      if (normalized.length > 20) {
        sentenceCounts.set(normalized, (sentenceCounts.get(normalized) || 0) + 1);
      }
    });

    // Find sentences that appear in majority of outputs
    const threshold = outputs.length / 2;
    sentenceCounts.forEach((count, sentence) => {
      if (count >= threshold) {
        commonPhrases.push(sentence);
      }
    });

    return commonPhrases.length > 0
      ? commonPhrases.slice(0, 3).join('. ') + '.'
      : null;
  }

  /**
   * Calculate relevance score
   */
  private calculateRelevance(query: string, document: AgentDocument): number {
    const queryLower = query.toLowerCase();
    const contentLower = document.content.toLowerCase();

    let score = 0;

    // Title match
    if (document.title.toLowerCase().includes(queryLower)) score += 0.3;

    // Content match
    const queryWords = queryLower.split(/\s+/);
    queryWords.forEach(word => {
      if (contentLower.includes(word)) score += 0.1;
    });

    // Recency boost
    const age = Date.now() - document.metadata.timestamp.getTime();
    const dayAge = age / (1000 * 60 * 60 * 24);
    score += Math.max(0, (7 - dayAge) / 7) * 0.2; // Boost recent documents

    // Quality boost
    if (document.metadata.quality) {
      score += document.metadata.quality * 0.1;
    }

    return Math.min(score, 1);
  }

  /**
   * Generate highlights for search results
   */
  private generateHighlights(query: string, content: string): string[] {
    const highlights: string[] = [];
    const queryWords = query.toLowerCase().split(/\s+/);
    const sentences = content.split(/[.!?]+/);

    for (const sentence of sentences) {
      const sentenceLower = sentence.toLowerCase();
      if (queryWords.some(word => sentenceLower.includes(word))) {
        highlights.push(sentence.trim());
        if (highlights.length >= 3) break;
      }
    }

    return highlights;
  }

  /**
   * Assess document quality
   */
  private assessQuality(content: string, output: any): number {
    let quality = 0.5; // Base quality

    // Length factor
    const words = this.countWords(content);
    if (words > 200) quality += 0.1;
    if (words > 500) quality += 0.1;

    // Structure factor (has paragraphs, headings, etc.)
    if (content.includes('\n\n')) quality += 0.1;
    if (content.match(/^#{1,3}\s/m)) quality += 0.1; // Has headings

    // Confidence factor
    if (output.confidence > 0.9) quality += 0.1;

    return Math.min(quality, 1);
  }

  /**
   * Assess synthesis quality
   */
  private assessSynthesisQuality(outputs: any[]): number {
    // Quality based on agreement and diversity
    const uniqueModels = new Set(outputs.map(o => o.agent?.model).filter(Boolean));
    const diversity = uniqueModels.size / outputs.length;

    return Math.min(0.5 + diversity * 0.5, 1);
  }

  // Utility methods
  private hashContent(content: string): string {
    return crypto.createHash('sha256').update(content).digest('hex');
  }

  private countWords(content: string): number {
    return content.split(/\s+/).filter(word => word.length > 0).length;
  }

  private estimateTokens(content: string): number {
    // Rough estimate: 1 token ≈ 0.75 words
    return Math.ceil(this.countWords(content) / 0.75);
  }

  private detectLanguage(content: string): string {
    // Simple detection - in production use proper language detection
    // eslint-disable-next-line no-control-regex
    const hasNonAscii = /[^\x00-\x7F]/.test(content);
    return hasNonAscii ? 'unknown' : 'en';
  }

  private cleanCache(): void {
    // Keep only last 100 documents in cache
    if (this.documentCache.size > 100) {
      const entries = Array.from(this.documentCache.entries());
      const toKeep = entries.slice(-100);
      this.documentCache.clear();
      toKeep.forEach(([key, value]) => this.documentCache.set(key, value));
    }

    // Keep only last 500 hashes
    if (this.hashCache.size > 500) {
      const entries = Array.from(this.hashCache.entries());
      const toKeep = entries.slice(-500);
      this.hashCache.clear();
      toKeep.forEach(([key, value]) => this.hashCache.set(key, value));
    }
  }
}

export const documentStorageService = DocumentStorageService.getInstance();