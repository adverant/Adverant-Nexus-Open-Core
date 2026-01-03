/**
 * Interaction Storage Service
 * Handles LLM interaction capture, storage, retrieval, and archival
 * Multi-platform support with automatic context management
 */

import { Pool } from 'pg';
import { logger } from '../utils/logger';
import { config } from '../config';
import {
  LLMInteraction,
  CaptureInteractionRequest,
  CaptureInteractionResponse,
  InteractionQuery,
  InteractionQueryResult,
  ConversationContext,
  GetContextRequest,
  ArchiveInteractionsRequest,
  ArchiveInteractionsResult,
  PurgeInteractionsRequest,
  PurgeInteractionsResult,
  InteractionAnalytics,
  GetAnalyticsRequest,
  validateInteraction,
  hashUserId,
} from './interaction-types';
import { getModelEngine } from '../models/model-engine';

export class InteractionService {
  private postgresPool: Pool;
  private modelEngine = getModelEngine();

  constructor(postgresPool: Pool) {
    this.postgresPool = postgresPool;
    logger.info('Interaction Service initialized');
  }

  /**
   * Capture a new LLM interaction
   */
  async capture(request: CaptureInteractionRequest): Promise<CaptureInteractionResponse> {
    try {
      // Validate request
      const validation = validateInteraction(request);
      if (!validation.valid) {
        throw new Error(`Invalid interaction request: ${validation.errors.join(', ')}`);
      }

      // Check if interaction capture is enabled
      if (!config.interactionCapture.enabled) {
        logger.debug('Interaction capture disabled, skipping');
        return {
          success: true,
          interactionId: 'disabled',
          message: 'Interaction capture is disabled'
        };
      }

      // Hash user ID for privacy
      const hashedUserId = request.userId ? hashUserId(request.userId) : undefined;

      // Detect if model is free (should never be true)
      const isFreeModel = await this.checkIfFreeModel(request.modelUsed);
      if (isFreeModel) {
        logger.error('CRITICAL: Free model detected in interaction', {
          model: request.modelUsed,
          platform: request.platform
        });
        // Still capture but flag it
      }

      // Auto-detect domain if not provided
      const domain = request.domain || await this.detectDomain(request.userMessage, request.assistantResponse);

      // Calculate tokens if not provided
      const tokens = {
        prompt: request.tokensPrompt || this.estimateTokens(request.userMessage),
        completion: request.tokensCompletion || this.estimateTokens(request.assistantResponse),
        total: request.tokensTotal || 0
      };
      tokens.total = tokens.total || (tokens.prompt + tokens.completion);

      // Insert interaction
      const query = `
        INSERT INTO graphrag.llm_interactions (
          platform, platform_version, user_id, session_id, thread_id, parent_interaction_id,
          user_message, assistant_response, tool_calls, system_prompt,
          model_used, model_provider, is_free_model,
          domain, task_type, conversation_context,
          tokens_prompt, tokens_completion, tokens_total, cost_usd, latency_ms, cache_hit,
          error_occurred, error_message, error_code,
          stored_document_ids, retrieved_document_ids, memory_ids, entity_ids,
          started_at, completed_at
        ) VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16,
          $17, $18, $19, $20, $21, $22, $23, $24, $25, $26, $27, $28, $29, $30, $31
        )
        RETURNING id
      `;

      const values = [
        request.platform,
        request.platformVersion,
        hashedUserId,
        request.sessionId,
        request.threadId,
        request.parentInteractionId,
        request.userMessage,
        request.assistantResponse,
        JSON.stringify(request.toolCalls || []),
        request.systemPrompt,
        request.modelUsed,
        request.modelProvider,
        isFreeModel,
        domain,
        request.taskType,
        JSON.stringify(request.conversationContext || []),
        tokens.prompt,
        tokens.completion,
        tokens.total,
        request.costUsd,
        request.latencyMs,
        request.cacheHit || false,
        request.errorOccurred || false,
        request.errorMessage,
        request.errorCode,
        request.storedDocumentIds || [],
        request.retrievedDocumentIds || [],
        request.memoryIds || [],
        request.entityIds || [],
        request.startedAt,
        request.completedAt
      ];

      const result = await this.postgresPool.query(query, values);
      const interactionId = result.rows[0].id;

      logger.info('Interaction captured', {
        id: interactionId,
        platform: request.platform,
        sessionId: request.sessionId,
        domain,
        tokens: tokens.total,
        latencyMs: request.latencyMs
      });

      return {
        success: true,
        interactionId,
        message: 'Interaction captured successfully'
      };
    } catch (error) {
      logger.error('Failed to capture interaction', { error, request });
      throw new Error(`Failed to capture interaction: ${error}`);
    }
  }

  /**
   * Query interactions with filters
   */
  async query(query: InteractionQuery): Promise<InteractionQueryResult> {
    try {
      const whereClauses: string[] = [];
      const values: any[] = [];
      let paramCounter = 1;

      // Build WHERE clauses
      if (query.sessionId) {
        whereClauses.push(`session_id = $${paramCounter++}`);
        values.push(query.sessionId);
      }

      if (query.threadId) {
        whereClauses.push(`thread_id = $${paramCounter++}`);
        values.push(query.threadId);
      }

      if (query.userId) {
        const hashedUserId = hashUserId(query.userId);
        whereClauses.push(`user_id = $${paramCounter++}`);
        values.push(hashedUserId);
      }

      if (query.platform) {
        if (Array.isArray(query.platform)) {
          whereClauses.push(`platform = ANY($${paramCounter++})`);
          values.push(query.platform);
        } else {
          whereClauses.push(`platform = $${paramCounter++}`);
          values.push(query.platform);
        }
      }

      if (query.domain) {
        if (Array.isArray(query.domain)) {
          whereClauses.push(`domain = ANY($${paramCounter++})`);
          values.push(query.domain);
        } else {
          whereClauses.push(`domain = $${paramCounter++}`);
          values.push(query.domain);
        }
      }

      if (query.taskType) {
        if (Array.isArray(query.taskType)) {
          whereClauses.push(`task_type = ANY($${paramCounter++})`);
          values.push(query.taskType);
        } else {
          whereClauses.push(`task_type = $${paramCounter++}`);
          values.push(query.taskType);
        }
      }

      if (query.startDate) {
        whereClauses.push(`started_at >= $${paramCounter++}`);
        values.push(query.startDate);
      }

      if (query.endDate) {
        whereClauses.push(`started_at <= $${paramCounter++}`);
        values.push(query.endDate);
      }

      if (query.recentDays) {
        whereClauses.push(`started_at > NOW() - INTERVAL '${query.recentDays} days'`);
      }

      if (query.searchText) {
        whereClauses.push(`(
          user_message ILIKE $${paramCounter} OR
          assistant_response ILIKE $${paramCounter}
        )`);
        values.push(`%${query.searchText}%`);
        paramCounter++;
      }

      if (query.errorsOnly) {
        whereClauses.push('error_occurred = true');
      }

      if (query.successOnly) {
        whereClauses.push('error_occurred = false');
      }

      const whereClause = whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : '';

      // Order by
      const orderBy = query.orderBy || 'started_at';
      const orderDirection = query.orderDirection || 'desc';

      // Limit and offset
      const limit = query.limit || 50;
      const offset = query.offset || 0;

      // Count total
      const countQuery = `
        SELECT COUNT(*) as total
        FROM graphrag.llm_interactions
        ${whereClause}
      `;
      const countResult = await this.postgresPool.query(countQuery, values);
      const total = parseInt(countResult.rows[0].total);

      // Get interactions
      const selectQuery = `
        SELECT
          id, platform, platform_version, user_id, session_id, thread_id, parent_interaction_id,
          user_message, assistant_response, tool_calls, system_prompt,
          model_used, model_provider, is_free_model,
          domain, task_type, conversation_context,
          tokens_prompt, tokens_completion, tokens_total, cost_usd, latency_ms, cache_hit,
          error_occurred, error_message, error_code,
          stored_document_ids, retrieved_document_ids, memory_ids, entity_ids,
          started_at, completed_at, created_at
        FROM graphrag.llm_interactions
        ${whereClause}
        ORDER BY ${orderBy} ${orderDirection}
        LIMIT $${paramCounter} OFFSET $${paramCounter + 1}
      `;

      const selectResult = await this.postgresPool.query(selectQuery, [...values, limit, offset]);

      const interactions: LLMInteraction[] = selectResult.rows.map(row => this.mapRowToInteraction(row));

      logger.debug('Interactions queried', {
        total,
        returned: interactions.length,
        filters: query
      });

      return {
        interactions,
        total,
        hasMore: offset + interactions.length < total
      };
    } catch (error) {
      logger.error('Failed to query interactions', { error, query });
      throw new Error(`Failed to query interactions: ${error}`);
    }
  }

  /**
   * Get conversation context for a session
   */
  async getContext(request: GetContextRequest): Promise<ConversationContext> {
    try {
      const limit = request.limit || 10;

      const queryParams: InteractionQuery = {
        sessionId: request.sessionId,
        threadId: request.threadId,
        limit,
        orderBy: 'started_at',
        orderDirection: 'desc'
      };

      const result = await this.query(queryParams);

      // Reverse to get chronological order
      const recentInteractions = result.interactions.reverse();

      // Extract topics from recent interactions
      const topics = this.extractTopics(recentInteractions);

      // Collect active documents and memories
      const activeDocuments = new Set<string>();
      const activeMemories = new Set<string>();

      for (const interaction of recentInteractions) {
        interaction.retrievedDocumentIds?.forEach(id => activeDocuments.add(id));
        interaction.storedDocumentIds?.forEach(id => activeDocuments.add(id));
        interaction.memoryIds?.forEach(id => activeMemories.add(id));
      }

      // Generate summary if requested
      let summary: string | undefined;
      if (request.includeSummary && recentInteractions.length > 0) {
        summary = await this.generateContextSummary(recentInteractions);
      }

      const context: ConversationContext = {
        sessionId: request.sessionId,
        threadId: request.threadId,
        recentInteractions,
        summary,
        topics,
        activeDocuments: Array.from(activeDocuments),
        activeMemories: Array.from(activeMemories)
      };

      logger.debug('Context retrieved', {
        sessionId: request.sessionId,
        interactionCount: recentInteractions.length,
        topics: topics.length
      });

      return context;
    } catch (error) {
      logger.error('Failed to get context', { error, request });
      throw new Error(`Failed to get context: ${error}`);
    }
  }

  /**
   * Archive old interactions to universal entities
   */
  async archive(request: ArchiveInteractionsRequest): Promise<ArchiveInteractionsResult> {
    try {
      if (!config.interactionCapture.autoArchive) {
        return {
          archivedCount: 0,
          deletedCount: 0,
          errors: ['Auto-archival is disabled']
        };
      }

      const query = 'SELECT graphrag.archive_old_interactions($1)';
      const result = await this.postgresPool.query(query, [request.olderThanDays]);

      const stats = result.rows[0].archive_old_interactions;
      const [archivedCount, deletedCount, errorCount] = stats.slice(1, -1).split(',').map(Number);

      logger.info('Interactions archived', {
        archivedCount,
        deletedCount,
        errorCount,
        olderThanDays: request.olderThanDays
      });

      return {
        archivedCount,
        deletedCount,
        entitiesCreated: archivedCount,
        errors: errorCount > 0 ? [`${errorCount} errors occurred during archival`] : []
      };
    } catch (error) {
      logger.error('Failed to archive interactions', { error, request });
      throw new Error(`Failed to archive interactions: ${error}`);
    }
  }

  /**
   * Purge interactions (GDPR compliance)
   */
  async purge(request: PurgeInteractionsRequest): Promise<PurgeInteractionsResult> {
    try {
      if (!request.confirmPermanentDeletion) {
        throw new Error('Must confirm permanent deletion');
      }

      const whereClauses: string[] = [];
      const values: any[] = [];
      let paramCounter = 1;

      if (request.userId) {
        const hashedUserId = hashUserId(request.userId);
        whereClauses.push(`user_id = $${paramCounter++}`);
        values.push(hashedUserId);
      }

      if (request.sessionId) {
        whereClauses.push(`session_id = $${paramCounter++}`);
        values.push(request.sessionId);
      }

      if (request.olderThanDate) {
        whereClauses.push(`started_at < $${paramCounter++}`);
        values.push(request.olderThanDate);
      }

      if (whereClauses.length === 0) {
        throw new Error('Must specify at least one filter for purge');
      }

      const whereClause = whereClauses.join(' AND ');
      const deleteQuery = `
        DELETE FROM graphrag.llm_interactions
        WHERE ${whereClause}
      `;

      const result = await this.postgresPool.query(deleteQuery, values);
      const deletedCount = result.rowCount || 0;

      logger.warn('Interactions purged (GDPR)', {
        deletedCount,
        filters: request
      });

      return {
        deletedCount,
        success: true,
        message: `Successfully purged ${deletedCount} interactions`
      };
    } catch (error) {
      logger.error('Failed to purge interactions', { error, request });
      return {
        deletedCount: 0,
        success: false,
        message: `Failed to purge interactions: ${error}`
      };
    }
  }

  /**
   * Get analytics for interactions
   */
  async getAnalytics(request: GetAnalyticsRequest): Promise<InteractionAnalytics> {
    try {
      const whereClauses = [
        'started_at >= $1',
        'started_at <= $2'
      ];
      const values: any[] = [request.startDate, request.endDate];
      let paramCounter = 3;

      if (request.platform) {
        whereClauses.push(`platform = $${paramCounter++}`);
        values.push(request.platform);
      }

      if (request.domain) {
        whereClauses.push(`domain = $${paramCounter++}`);
        values.push(request.domain);
      }

      const whereClause = whereClauses.join(' AND ');

      // Overall stats
      const statsQuery = `
        SELECT
          COUNT(*) as total_interactions,
          COUNT(DISTINCT session_id) as unique_sessions,
          COUNT(DISTINCT user_id) as unique_users,
          SUM(tokens_total) as total_tokens,
          SUM(cost_usd) as total_cost,
          AVG(latency_ms) as avg_latency,
          SUM(CASE WHEN error_occurred THEN 1 ELSE 0 END)::float / COUNT(*) as error_rate
        FROM graphrag.llm_interactions
        WHERE ${whereClause}
      `;

      const statsResult = await this.postgresPool.query(statsQuery, values);
      const stats = statsResult.rows[0];

      // By platform
      const platformQuery = `
        SELECT
          platform,
          COUNT(*) as count,
          SUM(tokens_total) as tokens,
          SUM(cost_usd) as cost,
          SUM(CASE WHEN error_occurred THEN 1 ELSE 0 END)::float / COUNT(*) as error_rate
        FROM graphrag.llm_interactions
        WHERE ${whereClause}
        GROUP BY platform
      `;

      const platformResult = await this.postgresPool.query(platformQuery, values);
      const byPlatform: any = {};
      platformResult.rows.forEach(row => {
        byPlatform[row.platform] = {
          count: parseInt(row.count),
          tokens: parseInt(row.tokens || 0),
          cost: parseFloat(row.cost || 0),
          errorRate: parseFloat(row.error_rate || 0)
        };
      });

      // By domain
      const domainQuery = `
        SELECT
          domain,
          COUNT(*) as count,
          SUM(tokens_total) as tokens,
          SUM(cost_usd) as cost
        FROM graphrag.llm_interactions
        WHERE ${whereClause} AND domain IS NOT NULL
        GROUP BY domain
      `;

      const domainResult = await this.postgresPool.query(domainQuery, values);
      const byDomain: any = {};
      domainResult.rows.forEach(row => {
        byDomain[row.domain] = {
          count: parseInt(row.count),
          tokens: parseInt(row.tokens || 0),
          cost: parseFloat(row.cost || 0)
        };
      });

      // By model
      const modelQuery = `
        SELECT
          model_used,
          COUNT(*) as count,
          SUM(tokens_total) as tokens,
          SUM(cost_usd) as cost,
          AVG(latency_ms) as avg_latency
        FROM graphrag.llm_interactions
        WHERE ${whereClause} AND model_used IS NOT NULL
        GROUP BY model_used
      `;

      const modelResult = await this.postgresPool.query(modelQuery, values);
      const byModel: any = {};
      modelResult.rows.forEach(row => {
        byModel[row.model_used] = {
          count: parseInt(row.count),
          tokens: parseInt(row.tokens || 0),
          cost: parseFloat(row.cost || 0),
          avgLatency: parseFloat(row.avg_latency || 0)
        };
      });

      const analytics: InteractionAnalytics = {
        period: {
          start: request.startDate,
          end: request.endDate
        },
        totalInteractions: parseInt(stats.total_interactions),
        uniqueSessions: parseInt(stats.unique_sessions),
        uniqueUsers: parseInt(stats.unique_users),
        totalTokens: parseInt(stats.total_tokens || 0),
        totalCost: parseFloat(stats.total_cost || 0),
        averageLatency: parseFloat(stats.avg_latency || 0),
        errorRate: parseFloat(stats.error_rate || 0),
        byPlatform,
        byDomain,
        byModel,
        hourlyDistribution: [] // TODO: Implement if needed
      };

      logger.info('Analytics generated', {
        period: analytics.period,
        totalInteractions: analytics.totalInteractions
      });

      return analytics;
    } catch (error) {
      logger.error('Failed to get analytics', { error, request });
      throw new Error(`Failed to get analytics: ${error}`);
    }
  }

  /**
   * Helper: Check if model is free
   */
  private async checkIfFreeModel(modelId?: string): Promise<boolean> {
    if (!modelId) return false;

    try {
      const validation = await this.modelEngine.validateModel(modelId);
      return !validation.valid && validation.reason.includes('free');
    } catch (error) {
      logger.debug('Could not validate model, assuming not free', { modelId });
      return false;
    }
  }

  /**
   * Helper: Auto-detect domain from messages
   */
  private async detectDomain(userMessage: string, assistantResponse: string): Promise<string | undefined> {
    // Simple keyword-based detection (can be enhanced with ML model)
    const combined = (userMessage + ' ' + assistantResponse).toLowerCase();

    if (combined.includes('chapter') || combined.includes('character') || combined.includes('story')) {
      return 'creative_writing';
    }
    if (combined.includes('function') || combined.includes('class') || combined.includes('code')) {
      return 'code';
    }
    if (combined.includes('patient') || combined.includes('diagnosis') || combined.includes('medical')) {
      return 'medical';
    }
    if (combined.includes('case') || combined.includes('statute') || combined.includes('legal')) {
      return 'legal';
    }

    return undefined;
  }

  /**
   * Helper: Estimate tokens
   */
  private estimateTokens(text: string): number {
    // Rough estimation: 1 token ≈ 4 characters
    return Math.ceil(text.length / 4);
  }

  /**
   * Helper: Extract topics from interactions
   */
  private extractTopics(interactions: LLMInteraction[]): string[] {
    const topics = new Set<string>();

    for (const interaction of interactions) {
      if (interaction.domain) topics.add(interaction.domain);
      if (interaction.taskType) topics.add(interaction.taskType);
    }

    return Array.from(topics);
  }

  /**
   * Helper: Generate context summary
   */
  private async generateContextSummary(interactions: LLMInteraction[]): Promise<string> {
    // Simple summary (can be enhanced with LLM summarization)
    if (interactions.length === 0) return 'No recent interactions';

    const parts: string[] = [];
    parts.push(`${interactions.length} recent interactions`);

    const domains = new Set(interactions.map(i => i.domain).filter(d => d));
    if (domains.size > 0) {
      parts.push(`Domains: ${Array.from(domains).join(', ')}`);
    }

    return parts.join('. ');
  }

  /**
   * Helper: Map database row to LLMInteraction
   */
  private mapRowToInteraction(row: any): LLMInteraction {
    return {
      id: row.id,
      platform: row.platform,
      platformVersion: row.platform_version,
      userId: row.user_id,
      sessionId: row.session_id,
      threadId: row.thread_id,
      parentInteractionId: row.parent_interaction_id,
      userMessage: row.user_message,
      assistantResponse: row.assistant_response,
      toolCalls: row.tool_calls,
      systemPrompt: row.system_prompt,
      modelUsed: row.model_used,
      modelProvider: row.model_provider,
      isFreeModel: row.is_free_model,
      domain: row.domain,
      taskType: row.task_type,
      conversationContext: row.conversation_context,
      tokensPrompt: row.tokens_prompt,
      tokensCompletion: row.tokens_completion,
      tokensTotal: row.tokens_total,
      costUsd: row.cost_usd ? parseFloat(row.cost_usd) : undefined,
      latencyMs: row.latency_ms,
      cacheHit: row.cache_hit,
      errorOccurred: row.error_occurred,
      errorMessage: row.error_message,
      errorCode: row.error_code,
      storedDocumentIds: row.stored_document_ids,
      retrievedDocumentIds: row.retrieved_document_ids,
      memoryIds: row.memory_ids,
      entityIds: row.entity_ids,
      startedAt: row.started_at,
      completedAt: row.completed_at,
      createdAt: row.created_at
    };
  }
}
