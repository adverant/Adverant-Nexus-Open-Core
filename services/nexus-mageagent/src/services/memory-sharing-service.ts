/**
 * Memory Sharing Service for MageAgent
 * Enables knowledge sharing and collective intelligence between agents
 * Part of the Cognitive Memory Loop architecture
 */

import { v4 as uuidv4 } from 'uuid';
import { createGraphRAGClient, TenantContext } from '../clients/graphrag-client';
import { episodeService } from './episode-service';
// import { contextService } from './context-service';  // Not used yet
import { agentLearningService } from './agent-learning-service';
import { logger } from '../utils/logger';

export interface SharedMemory {
  id: string;
  content: string;
  type: 'insight' | 'pattern' | 'solution' | 'warning' | 'best_practice';
  source: {
    agentId: string;
    agentRole: string;
    taskId: string;
    timestamp: Date;
  };
  metadata: {
    confidence: number;
    relevance: number;
    usageCount: number;
    lastAccessed: Date;
    tags: string[];
    domain?: string;
    entities?: string[];
    validatedBy?: string[];
  };
  sharing: {
    scope: 'private' | 'team' | 'global';
    permissions: string[];
    restrictions?: string[];
  };
}

export interface MemoryCluster {
  id: string;
  topic: string;
  memories: SharedMemory[];
  centroid?: any;
  coherence: number;
  diversity: number;
  lastUpdated: Date;
}

export interface CollectiveKnowledge {
  clusters: MemoryCluster[];
  insights: string[];
  consensus: Map<string, any>;
  conflicts: Map<string, any[]>;
  emergentPatterns: string[];
}

export class MemorySharingService {
  private static instance: MemorySharingService;
  private sharedMemoryPool: Map<string, SharedMemory> = new Map();
  private memoryClusters: Map<string, MemoryCluster> = new Map();
  private agentSubscriptions: Map<string, Set<string>> = new Map(); // agentId -> topicIds
  private memoryIndex: Map<string, Set<string>> = new Map(); // tag -> memoryIds

  private constructor() {}

  public static getInstance(): MemorySharingService {
    if (!MemorySharingService.instance) {
      MemorySharingService.instance = new MemorySharingService();
    }
    return MemorySharingService.instance;
  }

  /**
   * Share memory from an agent
   */
  async shareMemory(
    agentId: string,
    agentRole: string,
    taskId: string,
    content: any,
    type: SharedMemory['type'],
    options: {
      confidence?: number;
      tags?: string[];
      scope?: 'private' | 'team' | 'global';
      domain?: string;
      tenantContext?: TenantContext; // 🔒 SECURITY: Required for multi-tenant isolation
    } = {}
  ): Promise<SharedMemory> {
    try {
      // Extract entities and create rich content
      const processedContent = await this.processContent(content);

      const sharedMemory: SharedMemory = {
        id: uuidv4(),
        content: processedContent.text,
        type,
        source: {
          agentId,
          agentRole,
          taskId,
          timestamp: new Date()
        },
        metadata: {
          confidence: options.confidence || 0.75,
          relevance: 1.0, // Initially fully relevant
          usageCount: 0,
          lastAccessed: new Date(),
          tags: options.tags || [],
          domain: options.domain,
          entities: processedContent.entities,
          validatedBy: []
        },
        sharing: {
          scope: options.scope || 'team',
          permissions: [agentId], // Creator has access
          restrictions: []
        }
      };

      // Store in GraphRAG for persistence
      await this.persistSharedMemory(sharedMemory, options.tenantContext);

      // Add to memory pool
      this.sharedMemoryPool.set(sharedMemory.id, sharedMemory);

      // Index by tags
      for (const tag of sharedMemory.metadata.tags) {
        if (!this.memoryIndex.has(tag)) {
          this.memoryIndex.set(tag, new Set());
        }
        this.memoryIndex.get(tag)!.add(sharedMemory.id);
      }

      // Cluster with similar memories
      await this.clusterMemory(sharedMemory, options.tenantContext);

      // Notify subscribed agents
      await this.notifySubscribers(sharedMemory);

      logger.info('Memory shared successfully', {
        memoryId: sharedMemory.id,
        agentId,
        type,
        scope: sharedMemory.sharing.scope
      });

      return sharedMemory;
    } catch (error) {
      logger.error('Failed to share memory', { error, agentId, taskId });
      throw error;
    }
  }

  /**
   * Access shared memories relevant to a query
   */
  async accessSharedMemories(
    agentId: string,
    query: string,
    options: {
      types?: SharedMemory['type'][];
      minConfidence?: number;
      scope?: ('private' | 'team' | 'global')[];
      limit?: number;
      domain?: string;
      tenantContext?: TenantContext; // 🔒 SECURITY: Required for multi-tenant isolation
    } = {}
  ): Promise<SharedMemory[]> {
    try {
      // 🔒 SECURITY: Validate tenant context before searching
      if (!options.tenantContext) {
        logger.warn('SECURITY WARNING: accessSharedMemories called without tenant context', {
          agentId,
          query: query.substring(0, 50),
        });
        return [];
      }

      // Search in GraphRAG with tenant context
      const graphRAGClient = createGraphRAGClient(options.tenantContext);
      const searchResults = await graphRAGClient.searchMemories({
        query,
        limit: options.limit || 10,
        tags: options.domain ? [options.domain] : undefined
      });

      // Filter by access permissions and criteria
      const accessibleMemories: SharedMemory[] = [];

      for (const result of searchResults) {
        const memory = this.sharedMemoryPool.get(result.metadata?.memoryId);
        if (!memory) continue;

        // Check access permissions
        if (!this.hasAccess(agentId, memory)) continue;

        // Apply filters
        if (options.types && !options.types.includes(memory.type)) continue;
        if (options.minConfidence && memory.metadata.confidence < options.minConfidence) continue;
        if (options.scope && !options.scope.includes(memory.sharing.scope)) continue;

        // Update usage statistics
        memory.metadata.usageCount++;
        memory.metadata.lastAccessed = new Date();

        accessibleMemories.push(memory);
      }

      // Sort by relevance and confidence
      accessibleMemories.sort((a, b) => {
        const scoreA = a.metadata.relevance * a.metadata.confidence;
        const scoreB = b.metadata.relevance * b.metadata.confidence;
        return scoreB - scoreA;
      });

      // Track which memories were accessed
      await this.trackMemoryAccess(agentId, accessibleMemories.map(m => m.id), options.tenantContext);

      return accessibleMemories;
    } catch (error) {
      logger.error('Failed to access shared memories', { error, agentId, query });
      return [];
    }
  }

  /**
   * Build collective knowledge from all shared memories
   */
  async buildCollectiveKnowledge(
    domain?: string,
    options: {
      minClusterSize?: number;
      consensusThreshold?: number;
    } = {}
  ): Promise<CollectiveKnowledge> {
    try {
      // Get all relevant memories
      const memories = domain
        ? Array.from(this.sharedMemoryPool.values()).filter(m => m.metadata.domain === domain)
        : Array.from(this.sharedMemoryPool.values());

      // Refresh clusters
      await this.refreshClusters(memories);

      // Build consensus on topics
      const consensus = new Map<string, any>();
      const conflicts = new Map<string, any[]>();

      for (const cluster of this.memoryClusters.values()) {
        if (cluster.memories.length < (options.minClusterSize || 2)) continue;

        const topic = cluster.topic;
        const solutions = cluster.memories
          .filter(m => m.type === 'solution' || m.type === 'best_practice')
          .map(m => ({ content: m.content, confidence: m.metadata.confidence }));

        if (solutions.length > 0) {
          // Check for consensus
          const avgConfidence = solutions.reduce((sum, s) => sum + s.confidence, 0) / solutions.length;

          if (avgConfidence >= (options.consensusThreshold || 0.7)) {
            consensus.set(topic, {
              solution: solutions[0].content,
              confidence: avgConfidence,
              supportCount: solutions.length
            });
          } else {
            conflicts.set(topic, solutions);
          }
        }
      }

      // Extract insights and patterns
      const insights = memories
        .filter(m => m.type === 'insight' && m.metadata.confidence > 0.7)
        .map(m => m.content)
        .slice(0, 20);

      const emergentPatterns = this.identifyEmergentPatterns(memories);

      return {
        clusters: Array.from(this.memoryClusters.values()),
        insights,
        consensus,
        conflicts,
        emergentPatterns
      };
    } catch (error) {
      logger.error('Failed to build collective knowledge', { error, domain });
      throw error;
    }
  }

  /**
   * Validate shared memory through peer review
   */
  async validateMemory(
    memoryId: string,
    validatorAgentId: string,
    validation: {
      isValid: boolean;
      confidence: number;
      feedback?: string;
    }
  ): Promise<void> {
    const memory = this.sharedMemoryPool.get(memoryId);
    if (!memory) return;

    // Add validator to validated list
    if (validation.isValid && !memory.metadata.validatedBy?.includes(validatorAgentId)) {
      memory.metadata.validatedBy = memory.metadata.validatedBy || [];
      memory.metadata.validatedBy.push(validatorAgentId);
    }

    // Adjust confidence based on validation
    const validationWeight = 0.1; // Each validation affects confidence by 10%
    if (validation.isValid) {
      memory.metadata.confidence = Math.min(
        1.0,
        memory.metadata.confidence + (validationWeight * validation.confidence)
      );
    } else {
      memory.metadata.confidence = Math.max(
        0.1,
        memory.metadata.confidence - (validationWeight * validation.confidence)
      );
    }

    // Store validation as episode for tracking
    await episodeService.createFromAgentResponse(
      { id: validatorAgentId, name: 'Validator', model: 'validation' },
      { content: validation.feedback || `Validation: ${validation.isValid}` },
      { id: memoryId, type: 'validation' },
      'validation-session'
    );

    // Update in GraphRAG (skip if no tenant context - warning already logged in persistSharedMemory)
    await this.persistSharedMemory(memory);
  }

  /**
   * Subscribe agent to memory topics
   */
  async subscribeToTopics(agentId: string, topics: string[]): Promise<void> {
    if (!this.agentSubscriptions.has(agentId)) {
      this.agentSubscriptions.set(agentId, new Set());
    }

    const subscriptions = this.agentSubscriptions.get(agentId)!;
    for (const topic of topics) {
      subscriptions.add(topic);
    }

    logger.info('Agent subscribed to topics', { agentId, topics });
  }

  /**
   * Get memory recommendations for an agent
   */
  async getRecommendations(
    agentId: string,
    context: string,
    limit: number = 5,
    tenantContext?: TenantContext // 🔒 SECURITY: Required for multi-tenant isolation
  ): Promise<SharedMemory[]> {
    try {
      // Get agent's learning profile
      const profile = await agentLearningService.getAgentProfile(agentId);

      // Get subscribed topics
      const subscribedTopics = this.agentSubscriptions.get(agentId) || new Set();

      // Build recommendation query
      const queries: string[] = [context];
      if (profile?.strengths) {
        queries.push(...profile.strengths);
      }
      if (subscribedTopics.size > 0) {
        queries.push(...Array.from(subscribedTopics));
      }

      // Search for relevant memories
      const recommendations: SharedMemory[] = [];
      const seen = new Set<string>();

      for (const query of queries) {
        const memories = await this.accessSharedMemories(
          agentId,
          query,
          {
            minConfidence: 0.6,
            scope: ['team', 'global'],
            limit: Math.ceil(limit / queries.length),
            tenantContext // 🔒 Pass tenant context
          }
        );

        for (const memory of memories) {
          if (!seen.has(memory.id)) {
            seen.add(memory.id);
            recommendations.push(memory);
          }
        }
      }

      // Sort by relevance and recency
      recommendations.sort((a, b) => {
        const scoreA = a.metadata.relevance * a.metadata.confidence *
                       (1 / (Date.now() - a.metadata.lastAccessed.getTime() + 1));
        const scoreB = b.metadata.relevance * b.metadata.confidence *
                       (1 / (Date.now() - b.metadata.lastAccessed.getTime() + 1));
        return scoreB - scoreA;
      });

      return recommendations.slice(0, limit);
    } catch (error) {
      logger.error('Failed to get recommendations', { error, agentId });
      return [];
    }
  }

  /**
   * Process content for sharing
   */
  private async processContent(content: any): Promise<{ text: string; entities: string[] }> {
    const text = typeof content === 'string' ? content : JSON.stringify(content, null, 2);

    // Simple entity extraction
    const entities: string[] = [];

    // Extract capitalized phrases (potential entities)
    const matches = text.match(/\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+)*/g) || [];
    entities.push(...matches);

    return {
      text,
      entities: [...new Set(entities)].slice(0, 20)
    };
  }

  /**
   * Persist shared memory to GraphRAG
   */
  private async persistSharedMemory(memory: SharedMemory, tenantContext?: TenantContext): Promise<void> {
    // 🔒 SECURITY: Skip if no tenant context (log warning)
    if (!tenantContext) {
      logger.warn('SECURITY WARNING: Skipping GraphRAG persistence - no tenant context', {
        memoryId: memory.id,
        agentId: memory.source.agentId,
      });
      return;
    }

    const graphRAGClient = createGraphRAGClient(tenantContext);
    await graphRAGClient.storeMemory({
      content: memory.content,
      tags: [
        'shared-memory',
        memory.type,
        `agent:${memory.source.agentId}`,
        `scope:${memory.sharing.scope}`,
        ...memory.metadata.tags
      ],
      metadata: {
        memoryId: memory.id,
        ...memory.metadata,
        source: memory.source,
        sharing: memory.sharing
      }
    });
  }

  /**
   * Cluster memory with similar ones
   */
  private async clusterMemory(memory: SharedMemory, tenantContext?: TenantContext): Promise<void> {
    // 🔒 SECURITY: Skip clustering if no tenant context
    if (!tenantContext) {
      logger.debug('Skipping memory clustering - no tenant context available', {
        memoryId: memory.id,
      });
      return;
    }

    // Find similar memories using GraphRAG search
    const graphRAGClient = createGraphRAGClient(tenantContext);
    const similar = await graphRAGClient.searchMemories({
      query: memory.content,
      limit: 5,
      tags: ['shared-memory']
    });

    // Find best cluster or create new one
    let bestCluster: MemoryCluster | null = null;
    let maxSimilarity = 0;

    for (const result of similar) {
      const clusterId = result.metadata?.clusterId;
      if (clusterId && this.memoryClusters.has(clusterId)) {
        const cluster = this.memoryClusters.get(clusterId)!;
        const similarity = result.similarity || 0.5;
        if (similarity > maxSimilarity) {
          maxSimilarity = similarity;
          bestCluster = cluster;
        }
      }
    }

    if (bestCluster && maxSimilarity > 0.7) {
      // Add to existing cluster
      bestCluster.memories.push(memory);
      bestCluster.lastUpdated = new Date();
      this.updateClusterMetrics(bestCluster);
    } else {
      // Create new cluster
      const clusterId = uuidv4();
      const newCluster: MemoryCluster = {
        id: clusterId,
        topic: this.extractTopic(memory.content),
        memories: [memory],
        coherence: 1.0,
        diversity: 0.0,
        lastUpdated: new Date()
      };
      this.memoryClusters.set(clusterId, newCluster);
    }
  }

  /**
   * Check if agent has access to memory
   */
  private hasAccess(agentId: string, memory: SharedMemory): boolean {
    // Check scope
    if (memory.sharing.scope === 'private') {
      return memory.sharing.permissions.includes(agentId);
    }

    // Check restrictions
    if (memory.sharing.restrictions?.includes(agentId)) {
      return false;
    }

    // Team and global are accessible by default
    return true;
  }

  /**
   * Track memory access for analytics
   */
  private async trackMemoryAccess(agentId: string, memoryIds: string[], tenantContext?: TenantContext): Promise<void> {
    // 🔒 SECURITY: Skip tracking if no tenant context
    if (!tenantContext) {
      logger.debug('Skipping memory access tracking - no tenant context', { agentId });
      return;
    }

    // Store access pattern in GraphRAG
    const graphRAGClient = createGraphRAGClient(tenantContext);
    await graphRAGClient.storeMemory({
      content: `Agent ${agentId} accessed ${memoryIds.length} memories`,
      tags: ['memory-access', 'analytics'],
      metadata: {
        agentId,
        memoryIds,
        timestamp: new Date().toISOString(),
        accessCount: memoryIds.length
      }
    });
  }

  /**
   * Notify subscribed agents of new memory
   */
  private async notifySubscribers(memory: SharedMemory): Promise<void> {
    const topic = this.extractTopic(memory.content);

    for (const [agentId, topics] of this.agentSubscriptions) {
      if (topics.has(topic) && agentId !== memory.source.agentId) {
        // In production, send actual notification
        logger.info('Notifying subscriber', {
          agentId,
          topic,
          memoryId: memory.id
        });
      }
    }
  }

  /**
   * Refresh memory clusters
   */
  private async refreshClusters(memories: SharedMemory[]): Promise<void> {
    // Re-cluster if needed (simplified for now)
    for (const memory of memories) {
      const clusterId = Array.from(this.memoryClusters.values())
        .find(c => c.memories.some(m => m.id === memory.id))?.id;

      if (clusterId) {
        const cluster = this.memoryClusters.get(clusterId)!;
        this.updateClusterMetrics(cluster);
      }
    }
  }

  /**
   * Update cluster metrics
   */
  private updateClusterMetrics(cluster: MemoryCluster): void {
    // Calculate coherence (how similar memories are)
    const avgConfidence = cluster.memories.reduce((sum, m) => sum + m.metadata.confidence, 0) / cluster.memories.length;
    cluster.coherence = avgConfidence;

    // Calculate diversity (variety of sources)
    const uniqueAgents = new Set(cluster.memories.map(m => m.source.agentId));
    cluster.diversity = uniqueAgents.size / cluster.memories.length;
  }

  /**
   * Extract topic from content
   */
  private extractTopic(content: string): string {
    // Simple topic extraction - in production use NLP
    const words = content.split(/\s+/).slice(0, 10);
    return words.join(' ').substring(0, 50);
  }

  /**
   * Identify emergent patterns
   */
  private identifyEmergentPatterns(memories: SharedMemory[]): string[] {
    const patterns: string[] = [];

    // Group by type
    const byType = new Map<string, SharedMemory[]>();
    for (const memory of memories) {
      if (!byType.has(memory.type)) {
        byType.set(memory.type, []);
      }
      byType.get(memory.type)!.push(memory);
    }

    // Find patterns
    if (byType.has('pattern')) {
      patterns.push(...byType.get('pattern')!.map(m => m.content).slice(0, 5));
    }

    // Find recurring themes
    const allTags = memories.flatMap(m => m.metadata.tags);
    const tagCounts = new Map<string, number>();
    for (const tag of allTags) {
      tagCounts.set(tag, (tagCounts.get(tag) || 0) + 1);
    }

    // Top recurring tags as patterns
    const topTags = Array.from(tagCounts.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([tag, count]) => `Recurring theme: ${tag} (${count} occurrences)`);

    patterns.push(...topTags);

    return patterns;
  }

  /**
   * Clear old memories (cleanup)
   */
  clearOldMemories(daysOld: number = 30): void {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - daysOld);

    for (const [id, memory] of this.sharedMemoryPool) {
      if (memory.source.timestamp < cutoff && memory.metadata.usageCount < 5) {
        this.sharedMemoryPool.delete(id);

        // Remove from indexes
        for (const tag of memory.metadata.tags) {
          this.memoryIndex.get(tag)?.delete(id);
        }
      }
    }

    // Clean up empty clusters
    for (const [id, cluster] of this.memoryClusters) {
      cluster.memories = cluster.memories.filter(m => this.sharedMemoryPool.has(m.id));
      if (cluster.memories.length === 0) {
        this.memoryClusters.delete(id);
      }
    }
  }
}

export const memorySharingService = MemorySharingService.getInstance();