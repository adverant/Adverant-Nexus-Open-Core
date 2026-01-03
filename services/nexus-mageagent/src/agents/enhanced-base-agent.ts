/**
 * Enhanced Base Agent with Universal Entity System Integration
 *
 * Backward compatible with base Agent while providing enhanced capabilities
 * when configuration is provided.
 */

import { Agent, AgentRole, AgentDependencies } from './base-agent';
import { getEntityManagerClient } from '../clients/entity-manager-client';
import { contextInjectorClient } from '../clients/context-injector-client';
import { createGraphRAGClient } from '../clients/graphrag-client';
import { logger } from '../utils/logger';
import { v4 as uuidv4 } from 'uuid';
import { createDomain } from '../types/domain';

// Create singleton instance for entity manager
const graphRAGClient = createGraphRAGClient();
const entityManagerClient = getEntityManagerClient(graphRAGClient);

export interface EnhancedAgentConfig {
  sessionId: string;
  threadId?: string;
  userId?: string;
  domain?: string;
  parentEntityId?: string;
  enableContextInjection?: boolean;
  enableInteractionCapture?: boolean;
}

/**
 * Type guard to check if dependencies include enhanced config
 */
function hasEnhancedConfig(deps: any): deps is AgentDependencies & { config: EnhancedAgentConfig } {
  return deps && typeof deps === 'object' && 'config' in deps && deps.config !== undefined;
}

/**
 * Enhanced Base Agent with Universal Entity Integration
 *
 * Fully backward compatible - works as standard agent when config not provided
 */
export abstract class EnhancedAgent extends Agent {
  protected entityId?: string;
  protected taskEntityId?: string;
  protected interactionIds: string[] = [];
  protected enhancedConfig?: EnhancedAgentConfig;

  constructor(
    id: string,
    model: string,
    role: AgentRole,
    dependencies: AgentDependencies | (AgentDependencies & { config: EnhancedAgentConfig })
  ) {
    super(id, model, role, dependencies);

    // Extract enhanced config if present
    if (hasEnhancedConfig(dependencies)) {
      this.enhancedConfig = dependencies.config;
    }
  }

  /**
   * Check if enhanced features are enabled
   */
  protected isEnhanced(): boolean {
    return this.enhancedConfig !== undefined;
  }

  /**
   * Enhanced execute with entity hierarchy creation
   */
  async execute(sharedContext?: any): Promise<any> {
    if (!this.task) {
      throw new Error('No task assigned to agent');
    }

    try {
      // Create task entity if enhanced
      if (this.isEnhanced()) {
        await this.createTaskEntity();
      }

      // Inject context if enabled
      if (this.shouldInjectContext()) {
        await this.injectContextIntoTask();
      }

      // Execute base agent logic
      const result = await super.execute(sharedContext);

      // Store results if enhanced
      if (this.isEnhanced()) {
        await this.updateTaskEntity(result, 'completed');
        await this.storeWorkAsEntity(result);
      }

      return result;
    } catch (error) {
      if (this.isEnhanced()) {
        await this.updateTaskEntity(error, 'failed');
      }
      throw error;
    }
  }

  /**
   * Create task entity in Universal Entity System
   */
  protected async createTaskEntity(): Promise<void> {
    if (!this.enhancedConfig || !this.task) return;

    try {
      const domain = createDomain(this.enhancedConfig.domain || 'general');

      const entity = await entityManagerClient.createEntity({
        type: 'task',
        domain,
        content: {
          objective: this.task.objective,
          agentId: this.id,
          agentRole: this.role,
          model: this.model,
          context: this.task.context
        },
        metadata: {
          status: 'in_progress',
          sessionId: this.enhancedConfig.sessionId,
          threadId: this.enhancedConfig.threadId,
          userId: this.enhancedConfig.userId,
          startedAt: new Date().toISOString()
        },
        relationships: this.enhancedConfig.parentEntityId ? [{
          targetId: this.enhancedConfig.parentEntityId,
          type: 'SUBTASK_OF',
          weight: 1.0
        }] : undefined
      });

      this.taskEntityId = entity.id;

      logger.info('Created task entity for agent', {
        entityId: this.taskEntityId,
        agentId: this.id,
        taskId: this.task.id
      });
    } catch (error) {
      logger.error('Failed to create task entity', {
        error: error instanceof Error ? error.message : String(error),
        agentId: this.id
      });
    }
  }

  /**
   * Update task entity with results or error
   */
  protected async updateTaskEntity(resultOrError: any, status: 'completed' | 'failed'): Promise<void> {
    if (!this.taskEntityId || !this.enhancedConfig || !this.task) return;

    try {
      const isError = status === 'failed';
      const domain = createDomain(this.enhancedConfig.domain || 'general');

      const contentUpdate: any = {
        objective: this.task.objective,
        agentId: this.id,
        agentRole: this.role,
        model: this.model,
        context: this.task.context
      };

      if (isError) {
        contentUpdate.error = resultOrError instanceof Error ? resultOrError.message : String(resultOrError);
        if (resultOrError instanceof Error && resultOrError.stack) {
          contentUpdate.errorStack = resultOrError.stack;
        }
      } else {
        contentUpdate.result = this.summarizeResult(resultOrError);
        contentUpdate.summary = this.generateTaskSummary(resultOrError);
      }

      await entityManagerClient.updateEntity(this.taskEntityId, {
        type: 'task',
        domain,
        content: contentUpdate,
        metadata: {
          status,
          sessionId: this.enhancedConfig.sessionId,
          threadId: this.enhancedConfig.threadId,
          userId: this.enhancedConfig.userId,
          startedAt: this.startTime?.toISOString(),
          completedAt: this.endTime?.toISOString(),
          duration: this.endTime && this.startTime ? this.endTime.getTime() - this.startTime.getTime() : undefined,
          interactionIds: this.interactionIds
        }
      });

      logger.info('Updated task entity', {
        entityId: this.taskEntityId,
        agentId: this.id,
        status
      });
    } catch (error) {
      logger.error('Failed to update task entity', {
        error: error instanceof Error ? error.message : String(error),
        agentId: this.id
      });
    }
  }

  /**
   * Check if context injection should be performed
   */
  protected shouldInjectContext(): boolean {
    return this.isEnhanced() && this.enhancedConfig!.enableContextInjection !== false;
  }

  /**
   * Inject context into task
   */
  protected async injectContextIntoTask(): Promise<void> {
    if (!this.enhancedConfig || !this.task) return;

    try {
      const injectedContext = await contextInjectorClient.inject({
        sessionId: this.enhancedConfig.sessionId,
        threadId: this.enhancedConfig.threadId,
        currentQuery: this.task.objective,
        maxContextLength: 8000,
        includeSummary: true,
        includeDocumentRefs: true,
        includeMemoryRefs: true
      });

      this.task.objective = injectedContext.enrichedQuery;
      this.task.context = {
        ...this.task.context,
        injectedContext
      };

      logger.debug('Context injected into task', {
        agentId: this.id,
        tokensAdded: injectedContext.tokensAdded,
        sourcesUsed: injectedContext.sources.length
      });
    } catch (error) {
      logger.warn('Context injection failed', {
        error: error instanceof Error ? error.message : String(error),
        agentId: this.id
      });
    }
  }

  /**
   * Store work as hierarchical entities
   */
  protected async storeWorkAsEntity(result: any): Promise<void> {
    if (!this.enhancedConfig) return;

    try {
      const workProducts = this.extractWorkProducts(result);
      const domain = createDomain(this.enhancedConfig.domain || 'general');

      for (const product of workProducts) {
        const entity = await entityManagerClient.createEntity({
          type: this.determineWorkProductType(product),
          domain,
          content: product.content,
          metadata: {
            ...product.metadata,
            agentId: this.id,
            agentRole: this.role,
            model: this.model,
            taskId: this.task!.id,
            sessionId: this.enhancedConfig.sessionId,
            threadId: this.enhancedConfig.threadId,
            userId: this.enhancedConfig.userId,
            createdBy: 'mageagent'
          },
          relationships: this.taskEntityId ? [{
            targetId: this.taskEntityId,
            type: 'PRODUCED_BY',
            weight: 1.0
          }] : undefined
        });

        logger.debug('Stored work product as entity', {
          entityId: entity.id,
          type: product.type,
          agentId: this.id
        });
      }
    } catch (error) {
      logger.error('Failed to store work as entity', {
        error: error instanceof Error ? error.message : String(error),
        agentId: this.id
      });
    }
  }

  /**
   * Enhanced model calling with interaction capture
   */
  protected async callModel(messages: any[], maxTokens?: number): Promise<string> {
    const interactionId = uuidv4();
    const startTime = Date.now();

    try {
      const response = await super.callModel(messages, maxTokens);

      if (this.shouldCaptureInteractions()) {
        await this.captureInteraction({
          interactionId,
          messages,
          response,
          model: this.model,
          duration: Date.now() - startTime,
          success: true
        });
        this.interactionIds.push(interactionId);
      }

      return response;
    } catch (error) {
      if (this.shouldCaptureInteractions()) {
        await this.captureInteraction({
          interactionId,
          messages,
          response: null,
          model: this.model,
          duration: Date.now() - startTime,
          success: false,
          error: error instanceof Error ? error.message : String(error)
        });
      }
      throw error;
    }
  }

  /**
   * Check if interaction capture is enabled
   */
  protected shouldCaptureInteractions(): boolean {
    return this.isEnhanced() && this.enhancedConfig!.enableInteractionCapture !== false;
  }

  /**
   * Capture LLM interaction
   */
  protected async captureInteraction(details: {
    interactionId: string;
    messages: any[];
    response: string | null;
    model: string;
    duration: number;
    success: boolean;
    error?: string;
  }): Promise<void> {
    try {
      await this.dependencies.graphRAGClient.storeMemory({
        content: JSON.stringify({
          type: 'llm_interaction',
          platform: 'mageagent',
          agentId: this.id,
          agentRole: this.role,
          model: details.model,
          messages: details.messages,
          response: details.response,
          success: details.success,
          error: details.error,
          duration: details.duration
        }),
        tags: ['llm-interaction', 'mageagent', this.role, details.success ? 'success' : 'failure'],
        metadata: {
          interactionId: details.interactionId,
          taskId: this.task?.id,
          taskEntityId: this.taskEntityId,
          sessionId: this.enhancedConfig?.sessionId,
          threadId: this.enhancedConfig?.threadId,
          userId: this.enhancedConfig?.userId,
          platform: 'mageagent',
          model: details.model,
          tokenEstimate: this.estimateTokens(details.messages, details.response)
        }
      });

      logger.debug('Captured LLM interaction', {
        interactionId: details.interactionId,
        agentId: this.id,
        success: details.success
      });
    } catch (error) {
      logger.warn('Failed to capture interaction', {
        error: error instanceof Error ? error.message : String(error),
        interactionId: details.interactionId
      });
    }
  }

  /**
   * Query entity context
   */
  protected async queryEntityContext(query: string): Promise<any[]> {
    if (!this.enhancedConfig) return [];

    try {
      const results = await entityManagerClient.searchEntities({
        query,
        domain: this.enhancedConfig.domain,
        limit: 10,
        filters: {
          sessionId: this.enhancedConfig.sessionId,
          threadId: this.enhancedConfig.threadId
        }
      });

      return results.items;
    } catch (error) {
      logger.warn('Failed to query entity context', {
        error: error instanceof Error ? error.message : String(error),
        agentId: this.id
      });
      return [];
    }
  }

  /**
   * Cross-domain query
   */
  protected async queryCrossDomain(query: string, domains: string[]): Promise<any[]> {
    try {
      const results = await entityManagerClient.queryCrossDomain({
        query,
        domains,
        limit: 5
      });

      return results.results.map((r: any) => r.entity);
    } catch (error) {
      logger.warn('Cross-domain query failed', {
        error: error instanceof Error ? error.message : String(error),
        agentId: this.id
      });
      return [];
    }
  }

  /**
   * Extract work products from results (override in subclasses)
   */
  protected extractWorkProducts(result: any): Array<{
    type: string;
    content: any;
    metadata: Record<string, any>;
  }> {
    return [{
      type: 'agent_output',
      content: result,
      metadata: { agentRole: this.role, taskType: 'general' }
    }];
  }

  /**
   * Determine work product type
   */
  protected determineWorkProductType(product: any): string {
    const typeMap: Record<string, string> = {
      'code': 'code_artifact',
      'research': 'research_finding',
      'review': 'code_review',
      'synthesis': 'synthesis_report',
      'agent_output': 'task_result'
    };
    return typeMap[product.type] || 'artifact';
  }

  /**
   * Generate task summary
   */
  protected generateTaskSummary(_result: any): string {
    if (!this.task) return 'Task completed';
    const objective = this.task.objective.substring(0, 100);
    return `${this.role} agent completed task: ${objective}${this.task.objective.length > 100 ? '...' : ''}`;
  }

  /**
   * Estimate tokens
   */
  protected estimateTokens(messages: any[], response: string | null): number {
    const messageText = messages.map((m: any) => m.content).join(' ');
    const totalText = messageText + (response || '');
    return Math.ceil(totalText.length / 4);
  }

  /**
   * Enhanced memory query
   */
  protected async queryMemory(): Promise<any> {
    try {
      const baseMemories = await super.queryMemory();

      if (this.isEnhanced() && this.task) {
        const entityContext = await this.queryEntityContext(this.task.objective);
        return {
          memories: baseMemories,
          entities: entityContext,
          combined: true
        };
      }

      return baseMemories;
    } catch (error) {
      logger.warn('Enhanced memory query failed, using base', {
        error: error instanceof Error ? error.message : String(error),
        agentId: this.id
      });
      return await super.queryMemory();
    }
  }

  /**
   * Enhanced success pattern storage
   */
  protected async storeSuccessPattern(_result: any): Promise<void> {
    await super.storeSuccessPattern(_result);

    if (this.isEnhanced() && this.enhancedConfig && this.task) {
      try {
        const domain = createDomain(this.enhancedConfig.domain || 'general');

        await entityManagerClient.createEntity({
          type: 'pattern',
          domain,
          content: {
            patternType: 'success',
            agentRole: this.role,
            model: this.model,
            task: this.task.objective,
            _result: this.summarizeResult(_result),
            context: this.task.context
          },
          metadata: {
            agentId: this.id,
            taskId: this.task.id,
            taskEntityId: this.taskEntityId,
            sessionId: this.enhancedConfig.sessionId,
            duration: this.endTime && this.startTime ? this.endTime.getTime() - this.startTime.getTime() : undefined,
            competitionGroup: this.competitionGroup,
            collaborationGroup: this.collaborationGroup
          },
          relationships: this.taskEntityId ? [{
            targetId: this.taskEntityId,
            type: 'PATTERN_FROM',
            weight: 1.0
          }] : undefined
        });
      } catch (error) {
        logger.warn('Failed to store success pattern as entity', {
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }
  }

  /**
   * Enhanced failure pattern storage
   */
  protected async storeFailurePattern(error: any): Promise<void> {
    await super.storeFailurePattern(error);

    if (this.isEnhanced() && this.enhancedConfig && this.task) {
      try {
        const domain = createDomain(this.enhancedConfig.domain || 'general');

        await entityManagerClient.createEntity({
          type: 'pattern',
          domain,
          content: {
            patternType: 'failure',
            agentRole: this.role,
            model: this.model,
            task: this.task.objective,
            error: error instanceof Error ? error.message : String(error),
            context: this.task.context
          },
          metadata: {
            agentId: this.id,
            taskId: this.task.id,
            taskEntityId: this.taskEntityId,
            sessionId: this.enhancedConfig.sessionId,
            duration: this.endTime && this.startTime ? this.endTime.getTime() - this.startTime.getTime() : undefined
          },
          relationships: this.taskEntityId ? [{
            targetId: this.taskEntityId,
            type: 'PATTERN_FROM',
            weight: 0.5
          }] : undefined
        });
      } catch (err) {
        logger.warn('Failed to store failure pattern as entity', {
          error: err instanceof Error ? err.message : String(err)
        });
      }
    }
  }
}
