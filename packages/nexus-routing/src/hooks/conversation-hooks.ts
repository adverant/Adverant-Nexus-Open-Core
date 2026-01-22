/**
 * Conversation Hooks - Phase 2 & Phase 4 Implementation
 *
 * Provides automatic conversation capture and context storage through
 * Claude Code hooks integration.
 *
 * @module conversation-hooks
 */

import { ContextManager } from '../utils/context-manager.js';
import { GraphRAGClientV2 } from '../clients/graphrag-client-v2.js';
import { logger } from '../utils/logger.js';

// ============================================================================
// TYPES & INTERFACES
// ============================================================================

export interface HookContext {
  sessionId: string;
  timestamp: string;
  tokensUsed?: number;
  [key: string]: any;
}

export interface UserPromptEvent {
  prompt: string;
  context?: HookContext;
}

export interface ToolUseEvent {
  toolName: string;
  toolArgs: any;
  result?: any;
  error?: Error;
  duration?: number;
  context?: HookContext;
}

export interface SessionEvent {
  type: 'start' | 'end';
  sessionId: string;
  timestamp: string;
  context?: any;
}

// ============================================================================
// CONVERSATION HOOKS MANAGER
// ============================================================================

export class ConversationHooks {
  private contextManager: ContextManager;
  private graphragClient: GraphRAGClientV2;
  private progressTimer?: NodeJS.Timeout;
  private lastProgressUpdate: number = Date.now();

  constructor(graphragClient: GraphRAGClientV2, sessionId?: string) {
    this.graphragClient = graphragClient;
    this.contextManager = new ContextManager(graphragClient, sessionId);

    logger.info('ConversationHooks initialized');
  }

  // ============================================================================
  // PHASE 4: CLAUDE CODE HOOK HANDLERS
  // ============================================================================

  /**
   * Session Start Hook
   * Triggered when Claude Code session starts
   */
  async onSessionStart(event: SessionEvent): Promise<void> {
    try {
      logger.info(`Session started: ${event.sessionId}`);

      // Try to load previous checkpoint
      const checkpoint = await this.contextManager.loadCheckpoint(event.sessionId);

      if (checkpoint) {
        logger.info(`Loaded previous checkpoint for session: ${event.sessionId}`);
        this.contextManager.updateContext(checkpoint);

        // Store episode about resumption
        await this.contextManager.storeConversationEvent({
          type: 'event',
          content: `Session resumed from checkpoint. Last task: ${checkpoint.currentTask || 'Unknown'}`,
          importance: 0.6,
          sessionId: event.sessionId,
          timestamp: new Date().toISOString(),
          metadata: { resumed_from_checkpoint: true }
        });
      } else {
        logger.info(`New session started: ${event.sessionId}`);

        // Store new session start
        await this.contextManager.storeConversationEvent({
          type: 'event',
          content: 'New session started',
          importance: 0.5,
          sessionId: event.sessionId,
          timestamp: new Date().toISOString()
        });
      }

      // Start automatic progress updates (every 15-20 minutes)
      this.startProgressUpdates();
    } catch (error) {
      logger.error('Session start hook failed:', error);
      // Don't throw - graceful degradation
    }
  }

  /**
   * User Prompt Submit Hook
   * Triggered when user submits a prompt
   */
  async onUserPromptSubmit(event: UserPromptEvent): Promise<void> {
    try {
      const { prompt, context } = event;

      logger.info(`User prompt submitted: ${prompt.substring(0, 100)}...`);

      // Detect if this is task planning
      const isTaskPlanning = this.detectTaskPlanning(prompt);

      if (isTaskPlanning) {
        await this.handleTaskPlanning(prompt, context);
      } else {
        // Store as regular user query episode
        await this.contextManager.storeConversationEvent({
          type: 'user_query',
          content: prompt.length > 700 ? `${prompt.substring(0, 700)}...` : prompt,
          importance: 0.6,
          sessionId: context?.sessionId || 'unknown',
          timestamp: new Date().toISOString(),
          metadata: {
            prompt_length: prompt.length,
            tokens_used: context?.tokensUsed
          }
        });
      }

      // Auto-checkpoint if needed
      if (context?.tokensUsed) {
        await this.contextManager.autoCheckpoint(context.tokensUsed, {
          sessionId: context.sessionId
        });
      }
    } catch (error) {
      logger.error('User prompt submit hook failed:', error);
      // Don't throw - graceful degradation
    }
  }

  /**
   * Post Tool Use Hook
   * Triggered after a tool is executed
   */
  async onPostToolUse(event: ToolUseEvent): Promise<void> {
    try {
      const { toolName, toolArgs, result, error, duration, context } = event;

      logger.info(`Tool executed: ${toolName} (${duration}ms)`);

      // Detect task completion
      const isTaskCompletion = this.detectTaskCompletion(toolName, result);

      if (isTaskCompletion) {
        await this.handleTaskCompletion(toolName, result, context);
      }

      // Store significant tool executions
      if (this.isSignificantTool(toolName)) {
        await this.contextManager.storeConversationEvent({
          type: 'system_response',
          content: `Tool executed: ${toolName}${error ? ' (failed)' : ' (success)'} - Duration: ${duration}ms`,
          importance: error ? 0.8 : 0.5,
          sessionId: context?.sessionId || 'unknown',
          timestamp: new Date().toISOString(),
          metadata: {
            tool_name: toolName,
            duration_ms: duration,
            success: !error,
            error_message: error?.message
          }
        });
      }

      // Detect discoveries
      if (result && this.containsDiscovery(result)) {
        await this.handleDiscovery(toolName, result, context);
      }
    } catch (error) {
      logger.error('Post tool use hook failed:', error);
      // Don't throw - graceful degradation
    }
  }

  /**
   * Session End Hook
   * Triggered when Claude Code session ends
   */
  async onSessionEnd(event: SessionEvent): Promise<void> {
    try {
      logger.info(`Session ending: ${event.sessionId}`);

      // Stop progress updates
      this.stopProgressUpdates();

      // Create final checkpoint
      const finalContext = this.contextManager.getContext();
      await this.contextManager.storeCheckpoint({
        sessionId: event.sessionId,
        currentTask: finalContext.currentTask,
        force: true // Always checkpoint on session end
      });

      // Store session end episode
      await this.contextManager.storeConversationEvent({
        type: 'event',
        content: `Session ended. Completed ${finalContext.completedSteps.length} steps.`,
        importance: 0.7,
        sessionId: event.sessionId,
        timestamp: new Date().toISOString(),
        metadata: {
          completed_steps_count: finalContext.completedSteps.length,
          pending_tasks_count: finalContext.pendingTasks.length
        }
      });

      logger.info(`Session ended successfully: ${event.sessionId}`);
    } catch (error) {
      logger.error('Session end hook failed:', error);
      // Don't throw - graceful degradation
    }
  }

  // ============================================================================
  // AUTOMATIC PROGRESS UPDATES
  // ============================================================================

  /**
   * Start automatic progress updates (every 15-20 minutes)
   */
  private startProgressUpdates(): void {
    // Random interval between 15-20 minutes
    const interval = 900000 + Math.random() * 300000; // 15-20 minutes in ms

    this.progressTimer = setInterval(async () => {
      try {
        const context = this.contextManager.getContext();
        const progressSummary = this.buildProgressSummary(context);

        await this.contextManager.storeProgressUpdate(progressSummary, {
          importance: 0.5,
          tags: ['automatic', 'progress-update']
        });

        logger.info('Automatic progress update stored');
      } catch (error) {
        logger.error('Automatic progress update failed:', error);
      }
    }, interval);

    logger.info(`Automatic progress updates started (interval: ${Math.round(interval / 60000)} minutes)`);
  }

  /**
   * Stop automatic progress updates
   */
  private stopProgressUpdates(): void {
    if (this.progressTimer) {
      clearInterval(this.progressTimer);
      this.progressTimer = undefined;
      logger.info('Automatic progress updates stopped');
    }
  }

  // ============================================================================
  // DETECTION & HANDLING
  // ============================================================================

  /**
   * Detect if prompt is task planning
   */
  private detectTaskPlanning(prompt: string): boolean {
    const planningKeywords = [
      'plan for',
      'implement',
      'create',
      'build',
      'design',
      'refactor',
      'fix',
      'add feature',
      'steps to',
      'how to'
    ];

    const lowerPrompt = prompt.toLowerCase();
    return planningKeywords.some(keyword => lowerPrompt.includes(keyword)) &&
      prompt.length > 100; // Substantial planning request
  }

  /**
   * Handle task planning
   */
  private async handleTaskPlanning(prompt: string, context?: HookContext): Promise<void> {
    // Extract task description (first sentence or first 100 chars)
    const taskDescription = prompt.split('\n')[0].substring(0, 100);

    await this.contextManager.storeTaskPlanning(
      taskDescription,
      prompt,
      {
        sessionId: context?.sessionId,
        importance: 0.8,
        tags: ['task-planning', 'user-request']
      }
    );

    logger.info(`Task planning stored: ${taskDescription}`);
  }

  /**
   * Detect if tool execution indicates task completion
   */
  private detectTaskCompletion(toolName: string, result: any): boolean {
    // Tools that often indicate completion
    const completionTools = [
      'TodoWrite', // Task marked as completed
      'Bash', // Final build/test commands
      'nexus_store_document' // Storing final artifacts
    ];

    if (!completionTools.includes(toolName)) return false;

    // Check if TodoWrite has completed status
    if (toolName === 'TodoWrite' && result) {
      try {
        const todos = JSON.parse(result);
        return todos.some((t: any) => t.status === 'completed');
      } catch {
        return false;
      }
    }

    return false;
  }

  /**
   * Handle task completion
   */
  private async handleTaskCompletion(
    toolName: string,
    result: any,
    context?: HookContext
  ): Promise<void> {
    const currentContext = this.contextManager.getContext();

    if (!currentContext.currentTask) return;

    await this.contextManager.storeTaskCompletion(
      currentContext.currentTask,
      `Task completed via ${toolName}`,
      ['Successful execution', 'Proper tool usage'],
      {
        sessionId: context?.sessionId,
        importance: 0.9,
        tags: ['task-completion', 'automated']
      }
    );

    logger.info(`Task completion stored: ${currentContext.currentTask}`);
  }

  /**
   * Check if tool is significant enough to store
   */
  private isSignificantTool(toolName: string): boolean {
    const significantTools = [
      'nexus_validate_code',
      'nexus_orchestrate',
      'nexus_trigger_learning',
      'Bash', // Commands
      'Edit', // Code changes
      'Write' // File creation
    ];

    return significantTools.includes(toolName);
  }

  /**
   * Check if result contains a discovery
   */
  private containsDiscovery(result: any): boolean {
    if (!result) return false;

    const resultStr = typeof result === 'string' ? result : JSON.stringify(result);
    const discoveryKeywords = [
      'discovered',
      'found that',
      'realized',
      'insight',
      'learned',
      'pattern'
    ];

    return discoveryKeywords.some(keyword => resultStr.toLowerCase().includes(keyword));
  }

  /**
   * Handle discovery
   */
  private async handleDiscovery(
    toolName: string,
    result: any,
    context?: HookContext
  ): Promise<void> {
    const discoveryText = typeof result === 'string'
      ? result.substring(0, 300)
      : JSON.stringify(result).substring(0, 300);

    await this.contextManager.storeDiscovery(
      discoveryText,
      `Discovery from ${toolName} execution`,
      {
        sessionId: context?.sessionId,
        importance: 0.7,
        tags: ['discovery', toolName, 'automated']
      }
    );

    logger.info(`Discovery stored from ${toolName}`);
  }

  /**
   * Build progress summary from current context
   */
  private buildProgressSummary(context: any): string {
    return `Progress update: ${context.completedSteps.length} steps completed, ${context.inProgressWork.length} in progress, ${context.pendingTasks.length} pending. Current task: ${context.currentTask || 'None'}`;
  }

  // ============================================================================
  // PUBLIC ACCESSORS
  // ============================================================================

  /**
   * Get the underlying ContextManager
   */
  getContextManager(): ContextManager {
    return this.contextManager;
  }

  /**
   * Manually trigger checkpoint
   */
  async checkpoint(options?: any): Promise<string> {
    return this.contextManager.storeCheckpoint({
      ...options,
      force: true
    });
  }
}

// ============================================================================
// FACTORY FUNCTION
// ============================================================================

/**
 * Create a new ConversationHooks instance
 */
export function createConversationHooks(
  graphragClient: GraphRAGClientV2,
  sessionId?: string
): ConversationHooks {
  return new ConversationHooks(graphragClient, sessionId);
}

// ============================================================================
// HOOK INSTALLATION HELPER
// ============================================================================

/**
 * Install hooks into Claude Code (to be called from .claude/hooks/)
 */
export async function installHooks(graphragClient: GraphRAGClientV2): Promise<ConversationHooks> {
  const hooks = createConversationHooks(graphragClient);

  logger.info('Conversation hooks installed successfully');

  return hooks;
}

// ============================================================================
// EXPORTS
// ============================================================================

export default ConversationHooks;
