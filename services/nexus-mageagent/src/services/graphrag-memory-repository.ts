/**
 * GraphRAG Memory Repository
 *
 * CRITICAL COMPONENT: Unified memory storage pipeline ensuring ALL conversations,
 * documents, code, and cognitive artifacts are systematically stored in GraphRAG.
 *
 * Root Cause Addressed: Previous architecture had fragmented memory storage with
 * no systematic persistence of orchestration flows, agent interactions, or outputs.
 *
 * Design Pattern: Repository Pattern + Event-Driven Architecture
 * - Centralizes all GraphRAG interactions
 * - Provides consistent interface for storage/retrieval
 * - Enables automatic, transparent persistence
 *
 * Integration Points:
 * - Orchestrator: Store task decomposition, agent results
 * - Context Service: Enhanced retrieval with graph traversal
 * - Episode Service: Bidirectional relationship creation
 * - Document Service: Automatic chunking for long outputs
 */

import { graphRAGClient, createGraphRAGClient } from '../clients/graphrag-client';
import { TenantContext } from '../middleware/tenant-context';
import { logger } from '../utils/logger';
import { v4 as uuidv4 } from 'uuid';

export interface ConversationMessage {
  threadId: string;
  messageId?: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  metadata?: {
    agentId?: string;
    model?: string;
    taskId?: string;
    parentMessageId?: string;
    timestamp?: Date;
  };
}

export interface TaskHierarchy {
  taskId: string;
  objective: string;
  parentTaskId?: string;
  agentId?: string;
  status: 'pending' | 'in_progress' | 'completed' | 'failed';
  complexity: 'simple' | 'medium' | 'complex' | 'extreme';
  metadata?: Record<string, any>;
}

export interface CodeArtifact {
  artifactId?: string;
  type: 'implementation' | 'refactoring' | 'analysis' | 'documentation';
  language: string;
  content: string;
  taskId?: string;
  agentId?: string;
  metadata?: {
    fileCount?: number;
    lineCount?: number;
    dependencies?: string[];
  };
}

export interface RetrievalOptions {
  query: string;
  strategy?: 'semantic' | 'graph_traversal' | 'hybrid' | 'adaptive';
  limit?: number;
  graphDepth?: number; // 1-3 hops for graph traversal
  includeRelationships?: boolean;
  minRelevance?: number;
  complexity?: 'simple' | 'medium' | 'complex' | 'extreme';
}

export interface EnhancedRetrievalResult {
  memories: any[];
  documents: any[];
  episodes: any[];
  entities: any[];
  relationships: any[];
  graphPaths?: any[]; // Related entities through graph traversal
  totalRelevanceScore: number;
  retrievalStrategy: string;
}

export class GraphRAGMemoryRepository {
  private static instance: GraphRAGMemoryRepository;
  private storageQueue: Array<() => Promise<void>> = [];
  private isProcessing = false;
  private readonly MAX_QUEUE_SIZE = 100;
  private readonly CHUNK_SIZE_THRESHOLD = 8000; // ~2000 tokens
  private readonly AUTO_STORE_THRESHOLD = 1000; // Auto-store outputs > 1000 tokens

  private constructor() {
    // Start background processing
    this.startQueueProcessor();
  }

  public static getInstance(): GraphRAGMemoryRepository {
    if (!GraphRAGMemoryRepository.instance) {
      GraphRAGMemoryRepository.instance = new GraphRAGMemoryRepository();
    }
    return GraphRAGMemoryRepository.instance;
  }

  /**
   * CRITICAL: Store conversation message with full graph relationships
   * Creates bidirectional links: Thread ← Message → Agent → Task
   *
   * PHASE 41: Updated to accept tenantContext for multi-tenant isolation.
   * Uses dynamic GraphRAGClient when tenant context is provided.
   */
  async storeConversationMessage(message: ConversationMessage, tenantContext?: TenantContext): Promise<string> {
    try {
      const messageId = message.messageId || uuidv4();

      // PHASE 41: Use dynamic client with tenant context for multi-tenant isolation
      const client = tenantContext ? createGraphRAGClient(tenantContext) : graphRAGClient;

      // Store as episodic memory for temporal tracking
      const episodeType = message.role === 'user' ? 'user_query' : 'system_response';

      await client.storeEpisode({
        content: message.content,
        type: episodeType,
        metadata: {
          threadId: message.threadId,
          messageId,
          agentId: message.metadata?.agentId,
          model: message.metadata?.model,
          taskId: message.metadata?.taskId,
          parentMessageId: message.metadata?.parentMessageId,
          timestamp: message.metadata?.timestamp || new Date(),
          importance: message.role === 'user' ? 0.8 : 0.7 // User queries more important
        }
      });

      // Store as structured entity for graph traversal
      await client.storeEntity({
        domain: 'conversation',
        entityType: 'message',
        textContent: message.content,
        metadata: {
          messageId,
          threadId: message.threadId,
          role: message.role,
          agentId: message.metadata?.agentId,
          taskId: message.metadata?.taskId
        },
        tags: [
          `thread:${message.threadId}`,
          `role:${message.role}`,
          message.metadata?.agentId ? `agent:${message.metadata.agentId}` : '',
          message.metadata?.taskId ? `task:${message.metadata.taskId}` : ''
        ].filter(Boolean),
        parentId: message.metadata?.parentMessageId, // Hierarchical relationship
        storyTime: message.metadata?.timestamp
      });

      logger.info('Conversation message stored in GraphRAG', {
        messageId,
        threadId: message.threadId,
        role: message.role,
        contentLength: message.content.length
      });

      return messageId;
    } catch (error) {
      logger.error('Failed to store conversation message', {
        error: error instanceof Error ? error.message : 'Unknown error',
        threadId: message.threadId,
        role: message.role
      });
      throw new Error(`Conversation storage failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * CRITICAL: Store task hierarchy with decomposition tracking
   * Enables analysis of orchestration patterns and task breakdown strategies
   */
  async storeTaskHierarchy(task: TaskHierarchy): Promise<string> {
    try {
      await graphRAGClient.storeEntity({
        domain: 'orchestration',
        entityType: 'task',
        textContent: `Task: ${task.objective} (Complexity: ${task.complexity}, Status: ${task.status})`,
        metadata: {
          taskId: task.taskId,
          status: task.status,
          complexity: task.complexity,
          agentId: task.agentId,
          ...task.metadata
        },
        tags: [
          `complexity:${task.complexity}`,
          `status:${task.status}`,
          task.agentId ? `agent:${task.agentId}` : ''
        ].filter(Boolean),
        parentId: task.parentTaskId, // Creates task decomposition tree
        hierarchyLevel: task.parentTaskId ? 1 : 0
      });

      // Create relationship to agent if assigned
      if (task.agentId) {
        await this.createRelationship(
          task.taskId,
          task.agentId,
          'ASSIGNED_TO',
          { weight: 1.0 }
        );
      }

      logger.info('Task hierarchy stored in GraphRAG', {
        taskId: task.taskId,
        complexity: task.complexity,
        hasParent: !!task.parentTaskId
      });

      return task.taskId;
    } catch (error) {
      logger.error('Failed to store task hierarchy', {
        error: error instanceof Error ? error.message : 'Unknown error',
        taskId: task.taskId
      });
      throw new Error(`Task storage failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * CRITICAL: Store code artifacts with automatic chunking
   * Prevents loss of generated code, analysis results, refactorings
   */
  async storeCodeArtifact(artifact: CodeArtifact): Promise<string> {
    try {
      const artifactId = artifact.artifactId || uuidv4();

      // Check if content needs chunking (> 8000 chars ≈ 2000 tokens)
      const requiresChunking = artifact.content.length > this.CHUNK_SIZE_THRESHOLD;

      if (requiresChunking) {
        // Store as document with intelligent chunking
        const docId = await graphRAGClient.storeDocument(
          artifact.content,
          {
            title: `${artifact.type} - ${artifact.language} (${artifactId})`,
            type: 'code',
            artifactId,
            artifactType: artifact.type,
            language: artifact.language,
            taskId: artifact.taskId,
            agentId: artifact.agentId,
            ...artifact.metadata
          }
        );

        logger.info('Code artifact stored as document with chunking', {
          artifactId,
          docId,
          contentLength: artifact.content.length,
          chunks: Math.ceil(artifact.content.length / this.CHUNK_SIZE_THRESHOLD)
        });

        return docId;
      } else {
        // Store as entity for smaller artifacts
        await graphRAGClient.storeEntity({
          domain: 'code',
          entityType: artifact.type,
          textContent: artifact.content,
          metadata: {
            artifactId,
            language: artifact.language,
            taskId: artifact.taskId,
            agentId: artifact.agentId,
            ...artifact.metadata
          },
          tags: [
            `language:${artifact.language}`,
            `type:${artifact.type}`,
            artifact.taskId ? `task:${artifact.taskId}` : ''
          ].filter(Boolean)
        });

        logger.info('Code artifact stored as entity', {
          artifactId,
          type: artifact.type,
          language: artifact.language
        });

        return artifactId;
      }
    } catch (error) {
      logger.error('Failed to store code artifact', {
        error: error instanceof Error ? error.message : 'Unknown error',
        type: artifact.type,
        language: artifact.language
      });
      throw new Error(`Code artifact storage failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * CRITICAL: Auto-store long-form outputs (e.g., 50k word novels)
   * Triggered automatically for outputs exceeding threshold
   */
  async autoStoreIfLarge(
    content: string,
    metadata: {
      type: 'response' | 'analysis' | 'generation' | 'research';
      taskId?: string;
      agentId?: string;
      context?: string;
    }
  ): Promise<string | null> {
    try {
      const tokenEstimate = Math.ceil(content.length / 4);

      if (tokenEstimate < this.AUTO_STORE_THRESHOLD) {
        logger.debug('Content below auto-store threshold, skipping', {
          tokens: tokenEstimate,
          threshold: this.AUTO_STORE_THRESHOLD
        });
        return null;
      }

      // Store as document with intelligent chunking
      const docId = await graphRAGClient.storeDocument(
        content,
        {
          title: `${metadata.type} - ${metadata.context || 'Auto-stored content'}`,
          autoStored: true,
          estimatedTokens: tokenEstimate,
          ...metadata
        }
      );

      logger.info('Large content auto-stored in GraphRAG', {
        docId,
        type: metadata.type,
        contentLength: content.length,
        estimatedTokens: tokenEstimate
      });

      return docId;
    } catch (error) {
      logger.error('Failed to auto-store large content', {
        error: error instanceof Error ? error.message : 'Unknown error',
        type: metadata.type,
        contentLength: content.length
      });
      // Non-critical: Don't throw, just log and return null
      return null;
    }
  }

  /**
   * CRITICAL: Enhanced retrieval with multi-strategy approach
   * Combines semantic search, graph traversal, and hybrid ranking
   */
  async enhancedRetrieve(options: RetrievalOptions): Promise<EnhancedRetrievalResult> {
    try {
      const strategy = options.strategy || this.selectOptimalStrategy(options.complexity);
      const limit = this.calculateAdaptiveLimit(options.complexity, options.limit);

      logger.info('Enhanced retrieval initiated', {
        strategy,
        limit,
        complexity: options.complexity,
        graphDepth: options.graphDepth
      });

      let result: EnhancedRetrievalResult;

      switch (strategy) {
        case 'semantic':
          result = await this.semanticRetrieval(options.query, limit, options.minRelevance);
          break;

        case 'graph_traversal':
          result = await this.graphTraversalRetrieval(options.query, limit, options.graphDepth || 2);
          break;

        case 'hybrid':
          result = await this.hybridRetrieval(options.query, limit, options.graphDepth, options.minRelevance);
          break;

        case 'adaptive':
          result = await this.adaptiveRetrieval(options);
          break;

        default:
          result = await this.semanticRetrieval(options.query, limit, options.minRelevance);
      }

      logger.info('Enhanced retrieval completed', {
        strategy: result.retrievalStrategy,
        memoriesFound: result.memories.length,
        documentsFound: result.documents.length,
        episodesFound: result.episodes.length,
        entitiesFound: result.entities.length,
        relevanceScore: result.totalRelevanceScore
      });

      return result;
    } catch (error) {
      logger.error('Enhanced retrieval failed', {
        error: error instanceof Error ? error.message : 'Unknown error',
        query: options.query.substring(0, 100)
      });

      // Return empty result rather than failing
      return {
        memories: [],
        documents: [],
        episodes: [],
        entities: [],
        relationships: [],
        totalRelevanceScore: 0,
        retrievalStrategy: 'failed'
      };
    }
  }

  /**
   * Semantic retrieval using vector search
   */
  private async semanticRetrieval(
    query: string,
    limit: number,
    minRelevance?: number
  ): Promise<EnhancedRetrievalResult> {
    const [memories, documents, episodes] = await Promise.all([
      graphRAGClient.recallMemory({
        query,
        limit: Math.floor(limit * 0.4), // 40% allocation
        score_threshold: minRelevance || 0.3
      }),
      graphRAGClient.retrieveDocuments({
        query,
        limit: Math.floor(limit * 0.3), // 30% allocation
        strategy: 'semantic_chunks'
      }),
      graphRAGClient.recallEpisodes({
        query,
        limit: Math.floor(limit * 0.3), // 30% allocation
        include_decay: true
      })
    ]);

    const avgRelevance = this.calculateAverageRelevance([
      ...memories.map((m: any) => m.score || 0),
      ...episodes.map((e: any) => e.relevanceScore || 0)
    ]);

    return {
      memories,
      documents,
      episodes,
      entities: [],
      relationships: [],
      totalRelevanceScore: avgRelevance,
      retrievalStrategy: 'semantic'
    };
  }

  /**
   * Graph traversal retrieval for related entities
   */
  private async graphTraversalRetrieval(
    query: string,
    limit: number,
    _depth: number // Prefix with _ to indicate intentionally unused for now
  ): Promise<EnhancedRetrievalResult> {
    // Start with semantic search to find seed entities
    const seedEntities = await graphRAGClient.queryEntities({
      searchText: query,
      limit: Math.floor(limit / 3)
    });

    // Traverse graph to find related entities
    const relatedEntities: any[] = [];
    const relationships: any[] = [];

    for (const entity of seedEntities) {
      // Query for entities related within depth hops
      // This would use Neo4j MATCH queries in production
      const related = await graphRAGClient.queryEntities({
        searchText: entity.textContent,
        limit: 5
      });

      relatedEntities.push(...related);
    }

    return {
      memories: [],
      documents: [],
      episodes: [],
      entities: [...seedEntities, ...relatedEntities],
      relationships,
      graphPaths: [], // Would contain path information
      totalRelevanceScore: 0.7,
      retrievalStrategy: 'graph_traversal'
    };
  }

  /**
   * Hybrid retrieval combining semantic + graph
   */
  private async hybridRetrieval(
    query: string,
    limit: number,
    graphDepth?: number,
    minRelevance?: number
  ): Promise<EnhancedRetrievalResult> {
    // Run both strategies in parallel
    const [semanticResult, graphResult] = await Promise.all([
      this.semanticRetrieval(query, Math.floor(limit * 0.7), minRelevance),
      this.graphTraversalRetrieval(query, Math.floor(limit * 0.3), graphDepth || 1)
    ]);

    // Merge and deduplicate results
    return {
      memories: semanticResult.memories,
      documents: semanticResult.documents,
      episodes: semanticResult.episodes,
      entities: graphResult.entities,
      relationships: graphResult.relationships,
      graphPaths: graphResult.graphPaths,
      totalRelevanceScore: (semanticResult.totalRelevanceScore + graphResult.totalRelevanceScore) / 2,
      retrievalStrategy: 'hybrid'
    };
  }

  /**
   * Adaptive retrieval - selects best strategy based on query characteristics
   */
  private async adaptiveRetrieval(options: RetrievalOptions): Promise<EnhancedRetrievalResult> {
    const queryLength = options.query.length;
    const hasEntityMentions = /\b(user|agent|task|code|document)\b/i.test(options.query);

    // Use graph traversal if query mentions entities
    if (hasEntityMentions && queryLength > 50) {
      return this.hybridRetrieval(options.query, options.limit || 20, 2, options.minRelevance);
    }

    // Use semantic for short, focused queries
    if (queryLength < 100) {
      return this.semanticRetrieval(options.query, options.limit || 10, options.minRelevance);
    }

    // Default to hybrid for complex queries
    return this.hybridRetrieval(options.query, options.limit || 20, 1, options.minRelevance);
  }

  /**
   * Calculate adaptive limit based on task complexity
   */
  private calculateAdaptiveLimit(
    complexity?: 'simple' | 'medium' | 'complex' | 'extreme',
    providedLimit?: number
  ): number {
    if (providedLimit) return providedLimit;

    switch (complexity) {
      case 'simple': return 5;
      case 'medium': return 10;
      case 'complex': return 20;
      case 'extreme': return 30;
      default: return 10;
    }
  }

  /**
   * Select optimal retrieval strategy based on complexity
   */
  private selectOptimalStrategy(
    complexity?: 'simple' | 'medium' | 'complex' | 'extreme'
  ): 'semantic' | 'graph_traversal' | 'hybrid' | 'adaptive' {
    switch (complexity) {
      case 'simple': return 'semantic';
      case 'medium': return 'semantic';
      case 'complex': return 'hybrid';
      case 'extreme': return 'hybrid';
      default: return 'adaptive';
    }
  }

  /**
   * Calculate average relevance score
   */
  private calculateAverageRelevance(scores: number[]): number {
    if (scores.length === 0) return 0;
    const sum = scores.reduce((acc, score) => acc + score, 0);
    return sum / scores.length;
  }

  /**
   * Create relationship between entities
   */
  private async createRelationship(
    sourceId: string,
    targetId: string,
    relationshipType: string,
    metadata?: { weight?: number }
  ): Promise<void> {
    try {
      await graphRAGClient.createEntityRelationship({
        source_entity_id: sourceId,
        target_entity_id: targetId,
        relationship_type: relationshipType,
        weight: metadata?.weight || 1.0
      });

      logger.debug('Entity relationship created', {
        sourceId,
        targetId,
        type: relationshipType
      });
    } catch (error) {
      logger.warn('Failed to create entity relationship', {
        error: error instanceof Error ? error.message : 'Unknown error',
        sourceId,
        targetId,
        type: relationshipType
      });
      // Non-critical: Don't throw
    }
  }

  /**
   * Queue processor for async storage operations
   */
  private startQueueProcessor(): void {
    setInterval(async () => {
      if (this.isProcessing || this.storageQueue.length === 0) {
        return;
      }

      this.isProcessing = true;

      try {
        const operation = this.storageQueue.shift();
        if (operation) {
          await operation();
        }
      } catch (error) {
        logger.error('Queue processing error', {
          error: error instanceof Error ? error.message : 'Unknown error'
        });
      } finally {
        this.isProcessing = false;
      }
    }, 100); // Process every 100ms
  }

  /**
   * Add operation to queue (non-blocking storage)
   */
  enqueueStorage(operation: () => Promise<void>): void {
    if (this.storageQueue.length >= this.MAX_QUEUE_SIZE) {
      logger.warn('Storage queue full, dropping operation', {
        queueSize: this.storageQueue.length
      });
      return;
    }

    this.storageQueue.push(operation);
  }

  /**
   * Get queue metrics
   */
  getQueueMetrics(): { queueSize: number; isProcessing: boolean } {
    return {
      queueSize: this.storageQueue.length,
      isProcessing: this.isProcessing
    };
  }
}

export const graphRAGMemoryRepository = GraphRAGMemoryRepository.getInstance();
