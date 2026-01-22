/**
 * Context Injector Client
 * Provides automatic context enrichment for agent tasks using GraphRAG
 */

import { GraphRAGClient, createGraphRAGClient } from './graphrag-client';
import { logger } from '../utils/logger';

export interface InjectContextOptions {
  sessionId: string;
  threadId?: string;
  currentQuery: string;
  maxContextLength?: number;
  includeSummary?: boolean;
  includeDocumentRefs?: boolean;
  includeMemoryRefs?: boolean;
}

export interface InjectedContext {
  enrichedQuery: string;
  contextSummary: string;
  documentRefs: string[];
  memoryRefs: string[];
  tokensAdded: number;
  sources: Array<{
    type: 'memory' | 'document';
    id: string;
    content: string;
    relevance: number;
  }>;
}

export class ContextInjectorClient {
  constructor(private graphRAGClient: GraphRAGClient) {}

  /**
   * Inject relevant context into a query
   */
  async inject(options: InjectContextOptions): Promise<InjectedContext> {
    try {
      logger.debug('Injecting context', {
        query: options.currentQuery.substring(0, 100),
        sessionId: options.sessionId
      });

      const maxLength = options.maxContextLength || 8000;
      const sources: InjectedContext['sources'] = [];

      // Retrieve relevant memories
      const memories = await this.retrieveMemories(
        options.currentQuery,
        options.sessionId,
        5
      );

      for (const memory of memories) {
        sources.push({
          type: 'memory',
          id: memory.id || 'unknown',
          content: memory.content || '',
          relevance: memory.relevance || 0.5
        });
      }

      // Search for relevant documents
      const documents = await this.searchDocuments(
        options.currentQuery,
        3
      );

      for (const doc of documents) {
        sources.push({
          type: 'document',
          id: doc.id || 'unknown',
          content: doc.content || '',
          relevance: doc.relevance || 0.5
        });
      }

      // Build enriched context
      const contextParts: string[] = [];
      const documentRefs: string[] = [];
      const memoryRefs: string[] = [];
      let currentLength = 0;

      // Sort sources by relevance
      sources.sort((a, b) => b.relevance - a.relevance);

      // Add sources until max length reached
      for (const source of sources) {
        const sourceText = this.formatSource(source);
        const sourceLength = this.estimateTokens(sourceText);

        if (currentLength + sourceLength <= maxLength) {
          contextParts.push(sourceText);
          currentLength += sourceLength;

          if (source.type === 'document') {
            documentRefs.push(source.id);
          } else {
            memoryRefs.push(source.id);
          }
        } else {
          break;
        }
      }

      // Build enriched query
      let enrichedQuery = options.currentQuery;

      if (contextParts.length > 0 && options.includeSummary !== false) {
        const contextBlock = contextParts.join('\n\n');
        enrichedQuery = `Context from previous interactions and knowledge:\n${contextBlock}\n\nCurrent query: ${options.currentQuery}`;
      }

      const result: InjectedContext = {
        enrichedQuery,
        contextSummary: this.summarizeContext(sources),
        documentRefs: options.includeDocumentRefs !== false ? documentRefs : [],
        memoryRefs: options.includeMemoryRefs !== false ? memoryRefs : [],
        tokensAdded: currentLength,
        sources
      };

      logger.info('Context injected', {
        sourcesAdded: sources.length,
        tokensAdded: currentLength,
        documentRefs: documentRefs.length,
        memoryRefs: memoryRefs.length
      });

      return result;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.warn('Context injection failed, using original query', {
        error: errorMessage,
        query: options.currentQuery.substring(0, 100)
      });

      return {
        enrichedQuery: options.currentQuery,
        contextSummary: 'Context injection failed',
        documentRefs: [],
        memoryRefs: [],
        tokensAdded: 0,
        sources: []
      };
    }
  }

  /**
   * Retrieve relevant memories using GraphRAG
   */
  private async retrieveMemories(
    query: string,
    _sessionId: string,
    limit: number
  ): Promise<Array<{ id: string; content: string; relevance: number }>> {
    try {
      const results = await this.graphRAGClient.recallMemory({
        query,
        limit
      });

      return (Array.isArray(results) ? results : []).map((memory: any) => ({
        id: memory.id || 'unknown',
        content: memory.content || '',
        relevance: memory.relevance || 0.5
      }));
    } catch (error) {
      logger.debug('Failed to retrieve memories', {
        error: error instanceof Error ? error.message : String(error)
      });
      return [];
    }
  }

  /**
   * Search for relevant documents using GraphRAG
   */
  private async searchDocuments(
    query: string,
    limit: number
  ): Promise<Array<{ id: string; content: string; relevance: number }>> {
    try {
      const results = await this.graphRAGClient.searchDocuments(query, { limit });

      return (Array.isArray(results) ? results : []).map((item: any) => ({
        id: item.id || item.documentId || 'unknown',
        content: item.content || '',
        relevance: item.score || item.relevance || 0.5
      }));
    } catch (error) {
      logger.debug('Failed to search documents', {
        error: error instanceof Error ? error.message : String(error)
      });
      return [];
    }
  }

  /**
   * Format a source for context injection
   */
  private formatSource(source: InjectedContext['sources'][0]): string {
    const typeLabel = source.type === 'memory' ? 'Memory' : 'Document';
    const relevancePercent = Math.round(source.relevance * 100);

    return `[${typeLabel} - ${relevancePercent}% relevant]\n${source.content}`;
  }

  /**
   * Summarize context sources
   */
  private summarizeContext(sources: InjectedContext['sources']): string {
    if (sources.length === 0) {
      return 'No relevant context found';
    }

    const memoryCount = sources.filter(s => s.type === 'memory').length;
    const documentCount = sources.filter(s => s.type === 'document').length;

    return `Added ${sources.length} context sources: ${memoryCount} memories, ${documentCount} documents`;
  }

  /**
   * Estimate tokens in text (rough approximation)
   */
  private estimateTokens(text: string): number {
    return Math.ceil(text.length / 4);
  }
}

// Factory and singleton
let clientInstance: ContextInjectorClient | null = null;

export function getContextInjectorClient(client: GraphRAGClient): ContextInjectorClient {
  if (!clientInstance) {
    clientInstance = new ContextInjectorClient(client);
  }
  return clientInstance;
}

const graphRAGClient = createGraphRAGClient();
export const contextInjectorClient = getContextInjectorClient(graphRAGClient);
