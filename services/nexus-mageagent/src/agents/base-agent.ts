import { OpenRouterClient } from '../clients/openrouter-client';
import { GraphRAGClient, createGraphRAGClient } from '../clients/graphrag-client';
import { DatabaseManager } from '../database/database-manager';
import { EventEmitter } from 'events';
import { logger } from '../utils/logger';
import { TenantContext } from '../middleware/tenant-context';

// ============================================================================
// PHASE 2.3: FinalizationRegistry for Leak Detection
// ============================================================================

/**
 * Global FinalizationRegistry to detect undisposed agents.
 *
 * When an agent is garbage collected without being disposed,
 * this registry triggers a warning to detect memory leaks.
 */
const agentRegistry = new FinalizationRegistry((agentInfo: { id: string; role: string; model: string }) => {
  logger.warn('MEMORY LEAK: Agent garbage collected without disposal', {
    agentId: agentInfo.id,
    role: agentInfo.role,
    model: agentInfo.model,
    component: 'base-agent',
    severity: 'high',
    suggestion: 'Agent should be explicitly disposed via dispose() method'
  });

  // Emit metric for monitoring
  logger.info('METRIC: agent_undisposed', {
    agentId: agentInfo.id,
    role: agentInfo.role,
    model: agentInfo.model,
    component: 'base-agent'
  });
});

export enum AgentRole {
  RESEARCH = 'research',
  CODING = 'coding',
  REVIEW = 'review',
  SYNTHESIS = 'synthesis',
  SPECIALIST = 'specialist'
}

export enum AgentState {
  IDLE = 'idle',
  WORKING = 'working',
  COMPLETED = 'completed',
  FAILED = 'failed',
  ERROR = 'error',
  TERMINATED = 'terminated'
}

export interface AgentTask {
  id: string;
  objective: string;
  context: any;
  model?: string;
  constraints?: any;
}

export interface AgentDependencies {
  openRouterClient: OpenRouterClient;
  graphRAGClient: GraphRAGClient;
  databaseManager: DatabaseManager;
  // PHASE 42: Optional tenant context for multi-tenant operations
  tenantContext?: TenantContext;
}

/**
 * Dispose Pattern Interface
 * Ensures proper resource cleanup and memory leak prevention
 */
export interface Disposable {
  dispose(): Promise<void>;
  isDisposed(): boolean;
}

export abstract class Agent extends EventEmitter implements Disposable {
  public state: AgentState = AgentState.IDLE;
  public task: AgentTask | null = null;
  public competitionGroup?: string;
  public collaborationGroup?: string;
  protected startTime?: Date;
  protected endTime?: Date;
  private _disposed: boolean = false;
  private _cachedData: Map<string, any> = new Map();

  constructor(
    public readonly id: string,
    public readonly model: string,
    public readonly role: AgentRole,
    protected dependencies: AgentDependencies
  ) {
    super();

    // PHASE 2.3: Register for finalization tracking
    agentRegistry.register(this, { id: this.id, role: this.role, model: this.model }, this);

    logger.debug('Agent registered with FinalizationRegistry', {
      agentId: this.id,
      role: this.role,
      model: this.model,
      component: 'base-agent'
    });
  }

  /**
   * PHASE 1 FIX: Implement Dispose Pattern
   * Guarantees proper cleanup of:
   * - Event listeners (prevents memory leaks)
   * - Cached data (frees memory)
   * - Task references (allows GC)
   */
  async dispose(): Promise<void> {
    if (this._disposed) {
      logger.warn(`Agent ${this.id} already disposed`, {
        role: this.role,
        model: this.model
      });
      return;
    }

    try {
      // Mark as disposed FIRST to prevent re-entry
      this._disposed = true;

      // PHASE 2.3: Unregister from finalization tracking
      agentRegistry.unregister(this);

      // 1. Remove ALL event listeners
      this.removeAllListeners();

      // 2. Clear cached data
      this.clearCache();

      // 3. Null out references to allow GC
      this.task = null;
      this.competitionGroup = undefined;
      this.collaborationGroup = undefined;
      this.startTime = undefined;
      this.endTime = undefined;

      // 4. Perform agent-specific cleanup
      await this.performCleanup();

      logger.debug('Agent disposed successfully', {
        agentId: this.id,
        role: this.role,
        model: this.model,
        state: this.state
      });
    } catch (error) {
      logger.error('Agent disposal failed', {
        agentId: this.id,
        error: error instanceof Error ? error.message : String(error)
      });
      throw error;
    }
  }

  /**
   * Check if agent has been disposed
   */
  isDisposed(): boolean {
    return this._disposed;
  }

  /**
   * Clear all cached data
   */
  protected clearCache(): void {
    this._cachedData.clear();
  }

  /**
   * Get cached data
   */
  protected getCached<T>(key: string): T | undefined {
    return this._cachedData.get(key) as T | undefined;
  }

  /**
   * Set cached data
   */
  protected setCached<T>(key: string, value: T): void {
    this._cachedData.set(key, value);
  }

  /**
   * Agent-specific cleanup hook
   * Override in subclasses to perform custom cleanup
   */
  protected async performCleanup(): Promise<void> {
    // Default implementation does nothing
    // Subclasses can override to perform specific cleanup
  }
  
  async execute(sharedContext?: any): Promise<any> {
    // PHASE 1 FIX: Check if agent is disposed
    if (this._disposed) {
      throw new Error(
        `Cannot execute disposed agent ${this.id}. ` +
        `Agent was already cleaned up and cannot be reused.`
      );
    }

    if (!this.task) {
      throw new Error('No task assigned to agent');
    }

    this.state = AgentState.WORKING;
    this.startTime = new Date();
    this.emit('started', { agentId: this.id, task: this.task });

    try {
      logger.info(`Agent ${this.id} starting execution`, {
        role: this.role,
        model: this.model,
        task: this.task.objective
      });

      // Query memory for relevant patterns
      const memoryContext = await this.queryMemory();

      // Execute agent-specific logic
      const result = await this.performTask(this.task, memoryContext, sharedContext);

      // Set completion time BEFORE storing patterns
      this.state = AgentState.COMPLETED;
      this.endTime = new Date();

      // Store successful pattern with proper timestamps
      await this.storeSuccessPattern(result);

      this.emit('completed', {
        agentId: this.id,
        task: this.task,
        result,
        duration: this.endTime.getTime() - this.startTime.getTime()
      });

      return result;

    } catch (error) {
      this.state = AgentState.FAILED;
      this.endTime = new Date();

      const errorMessage = error instanceof Error ? error.message : String(error);

      logger.error(`Agent ${this.id} execution failed`, {
        error: errorMessage,
        task: this.task,
        duration: this.endTime.getTime() - this.startTime!.getTime()
      });

      // Store failure pattern
      await this.storeFailurePattern(error);

      this.emit('failed', {
        agentId: this.id,
        model: this.model,
        task: this.task,
        error,
        duration: this.endTime.getTime() - this.startTime!.getTime()
      });

      // Propagate model-specific errors
      if (error instanceof Error && (
        error.message.includes('OpenRouter') ||
        error.message.includes('API') ||
        error.message.includes('timeout') ||
        error.message.includes('rate limit')
      )) {
        this.emit('model:failed', {
          model: this.model,
          error: error.message,
          agentId: this.id
        });
      }

      throw error;
    }
  }
  
  protected async queryMemory(): Promise<any> {
    try {
      // PHASE 49: Use tenant-aware GraphRAG client if tenant context is available
      const client = this.dependencies.tenantContext
        ? createGraphRAGClient(this.dependencies.tenantContext)
        : this.dependencies.graphRAGClient;

      const memories = await client.recallMemory({
        query: `${this.role} agent patterns for: ${this.task?.objective}`,
        limit: 5
      });

      return memories;
    } catch (error) {
      logger.warn(`Failed to query memory for agent ${this.id}:`, error);
      return [];
    }
  }
  
  protected async storeSuccessPattern(result: any): Promise<void> {
    try {
      // PHASE 42: Use tenant-aware GraphRAG client if tenant context is available
      const client = this.dependencies.tenantContext
        ? createGraphRAGClient(this.dependencies.tenantContext)
        : this.dependencies.graphRAGClient;

      await client.storeMemory({
        content: JSON.stringify({
          agentRole: this.role,
          model: this.model,
          task: this.task?.objective,
          result: this.summarizeResult(result),
          duration: this.endTime && this.startTime
            ? this.endTime.getTime() - this.startTime.getTime()
            : 0
        }),
        tags: ['mageagent', 'agent-success', this.role, this.model.split('/')[0]],
        metadata: {
          agentId: this.id,
          taskId: this.task?.id,
          competitionGroup: this.competitionGroup,
          collaborationGroup: this.collaborationGroup
        }
      });
    } catch (error) {
      logger.warn(`Failed to store success pattern for agent ${this.id}:`, error);
    }
  }
  
  protected async storeFailurePattern(error: any): Promise<void> {
    try {
      const errorMessage = error instanceof Error ? error.message : String(error);
      const errorStack = error instanceof Error ? error.stack : undefined;

      // PHASE 42: Use tenant-aware GraphRAG client if tenant context is available
      const client = this.dependencies.tenantContext
        ? createGraphRAGClient(this.dependencies.tenantContext)
        : this.dependencies.graphRAGClient;

      await client.storeMemory({
        content: JSON.stringify({
          agentRole: this.role,
          model: this.model,
          task: this.task?.objective,
          error: errorMessage,
          stack: errorStack,
          duration: this.endTime && this.startTime
            ? this.endTime.getTime() - this.startTime.getTime()
            : 0
        }),
        tags: ['mageagent', 'agent-failure', this.role, 'error'],
        metadata: {
          agentId: this.id,
          taskId: this.task?.id
        }
      });
    } catch (err) {
      logger.warn(`Failed to store failure pattern for agent ${this.id}:`, err);
    }
  }
  
  protected async callModel(messages: any[], maxTokens?: number): Promise<string> {
    const response = await this.dependencies.openRouterClient.createCompletion({
      model: this.model,
      messages,
      max_tokens: maxTokens, // NO LIMIT - let model decide or use its max
      temperature: 0.7
    });

    // Defensive error handling for malformed OpenRouter responses
    if (!response || !response.choices || !Array.isArray(response.choices) || response.choices.length === 0) {
      logger.error('OpenRouter returned malformed response', {
        agentId: this.id,
        model: this.model,
        response: JSON.stringify(response).substring(0, 500)
      });
      throw new Error(
        `OpenRouter returned invalid response structure for model ${this.model}. ` +
        `Expected response.choices[0].message.content but got: ${JSON.stringify(response).substring(0, 200)}...`
      );
    }

    if (!response.choices[0].message || typeof response.choices[0].message.content !== 'string') {
      logger.error('OpenRouter response missing message content', {
        agentId: this.id,
        model: this.model,
        choice: JSON.stringify(response.choices[0]).substring(0, 500)
      });
      throw new Error(
        `OpenRouter response missing valid content for model ${this.model}. ` +
        `Expected string content but got: ${typeof response.choices[0]?.message?.content}`
      );
    }

    // CRITICAL FIX: Validate content is not just whitespace
    const content = response.choices[0].message.content;
    const trimmedContent = content.trim();

    if (trimmedContent.length === 0) {
      logger.error('OpenRouter returned whitespace-only response', {
        agentId: this.id,
        model: this.model,
        contentLength: content.length,
        sample: JSON.stringify(content.substring(0, 100))
      });
      throw new Error(
        `OpenRouter returned empty/whitespace-only response for model ${this.model}. ` +
        `Original length: ${content.length}, Trimmed length: 0. This indicates a model compatibility issue.`
      );
    }

    return content;
  }
  
  protected async *streamModel(messages: any[], maxTokens?: number): AsyncGenerator<string, void, unknown> {
    const stream = this.dependencies.openRouterClient.streamCompletion({
      model: this.model,
      messages,
      max_tokens: maxTokens, // NO LIMIT - let model decide or use its max
      temperature: 0.7
    });

    let totalChunks = 0;
    let accumulatedContent = '';
    const startTime = Date.now();

    for await (const chunk of stream) {
      yield chunk;
      totalChunks++;
      accumulatedContent += chunk;

      // Emit detailed streaming progress
      this.emit('streaming', {
        agentId: this.id,
        model: this.model,
        role: this.role,
        chunk,
        progress: {
          chunksReceived: totalChunks,
          bytesReceived: accumulatedContent.length,
          elapsedMs: Date.now() - startTime,
          taskId: this.task?.id
        }
      });

      // Emit periodic status updates every 10 chunks
      if (totalChunks % 10 === 0) {
        logger.debug(`Agent ${this.id} streaming progress`, {
          model: this.model,
          chunks: totalChunks,
          bytes: accumulatedContent.length,
          elapsed: `${((Date.now() - startTime) / 1000).toFixed(1)}s`
        });
      }
    }

    // Final progress emit
    this.emit('streaming:complete', {
      agentId: this.id,
      model: this.model,
      totalChunks,
      totalBytes: accumulatedContent.length,
      duration: Date.now() - startTime
    });
  }
  
  // Abstract methods to be implemented by specific agent types
  protected abstract performTask(task: AgentTask, memoryContext: any, sharedContext?: any): Promise<any>;
  protected abstract summarizeResult(result: any): any;
}
