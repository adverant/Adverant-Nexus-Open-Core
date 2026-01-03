/**
 * Context Manager - Phase 1-4 Implementation
 *
 * Provides systematic context capture, session checkpoints, and conversation storage
 * for the Nexus MCP system to enable seamless session resumption and learning.
 *
 * @module context-manager
 */

import { GraphRAGClientV2 } from '../clients/graphrag-client-v2.js';
import { logger } from './logger.js';

// ============================================================================
// TYPES & INTERFACES
// ============================================================================

export interface SessionContext {
  sessionId: string;
  currentTask?: string;
  completedSteps: string[];
  inProgressWork: string[];
  pendingTasks: string[];
  keyDecisions: Record<string, any>;
  gitStatus?: string;
  timestamp: string;
  tokensUsed?: number;
}

export interface ConversationEvent {
  type: 'user_query' | 'system_response' | 'event' | 'observation' | 'insight';
  content: string;
  importance: number;
  sessionId: string;
  timestamp: string;
  metadata?: Record<string, any>;
}

export interface StorageOptions {
  tags?: string[];
  importance?: number;
  sessionId?: string;
  metadata?: Record<string, any>;
}

export interface CheckpointOptions {
  sessionId: string;
  currentTask?: string;
  gitStatus?: string;
  force?: boolean; // Force checkpoint even if under token threshold
}

// ============================================================================
// CONTEXT MANAGER CLASS
// ============================================================================

export class ContextManager {
  private graphragClient: GraphRAGClientV2;
  private sessionId: string;
  private tokensUsed: number = 0;
  private lastCheckpoint: number = 0;
  private checkpointInterval: number = 50000; // 50K tokens
  private timeBasedCheckpoint: number = 1200000; // 20 minutes in ms
  private lastTimeCheckpoint: number = Date.now();

  private currentContext: SessionContext;

  constructor(graphragClient: GraphRAGClientV2, sessionId?: string) {
    this.graphragClient = graphragClient;
    this.sessionId = sessionId || this.generateSessionId();

    this.currentContext = {
      sessionId: this.sessionId,
      completedSteps: [],
      inProgressWork: [],
      pendingTasks: [],
      keyDecisions: {},
      timestamp: new Date().toISOString(),
      tokensUsed: 0
    };

    logger.info(`ContextManager initialized for session: ${this.sessionId}`);
  }

  // ============================================================================
  // PHASE 1: SESSION CHECKPOINTS
  // ============================================================================

  /**
   * Store a complete session checkpoint for resumption after context compaction
   */
  async storeCheckpoint(options: CheckpointOptions): Promise<string> {
    const checkpoint: SessionContext = {
      ...this.currentContext,
      sessionId: options.sessionId || this.sessionId,
      currentTask: options.currentTask,
      gitStatus: options.gitStatus,
      timestamp: new Date().toISOString(),
      tokensUsed: this.tokensUsed
    };

    const checkpointDoc = this.formatCheckpointDocument(checkpoint);

    try {
      const result = await this.graphragClient.storeDocument(
        checkpointDoc,
        `Session Checkpoint - ${checkpoint.sessionId} - ${new Date().toISOString()}`,
        {
          type: 'markdown',
          tags: ['session-checkpoint', 'context-resumption', checkpoint.sessionId],
          source: 'context-manager',
          checkpoint_number: Math.floor(this.tokensUsed / this.checkpointInterval)
        }
      );

      // Also store as episode for temporal tracking
      await this.graphragClient.storeEpisode(
        `Session checkpoint created: ${checkpoint.currentTask || 'No specific task'}. Tokens used: ${this.tokensUsed}`,
        'observation',
        {
          importance: 0.7,
          session_id: checkpoint.sessionId,
          checkpoint_id: result.documentId
        }
      );

      this.lastCheckpoint = this.tokensUsed;
      this.lastTimeCheckpoint = Date.now();

      logger.info(`Checkpoint stored: ${result.documentId}`);
      return result.documentId;
    } catch (error) {
      logger.error('Failed to store checkpoint:', error);
      throw error;
    }
  }

  /**
   * Load the most recent checkpoint for a session
   */
  async loadCheckpoint(sessionId?: string): Promise<SessionContext | null> {
    const targetSessionId = sessionId || this.sessionId;

    try {
      // Use enhanced retrieve to get the most recent checkpoint
      const result = await this.graphragClient.enhancedRetrieve(
        `session checkpoint ${targetSessionId}`,
        {
          includeDocuments: true,
          includeEpisodic: false,
          maxTokens: 3000
        }
      );

      if (result.documents && result.documents.length > 0) {
        // Parse checkpoint from document
        const checkpointDoc = result.documents[0];
        logger.info(`Loaded checkpoint: ${checkpointDoc.id}`);
        return this.parseCheckpointDocument(checkpointDoc.content);
      }

      return null;
    } catch (error) {
      logger.error('Failed to load checkpoint:', error);
      return null;
    }
  }

  /**
   * Automatically checkpoint if thresholds are met
   */
  async autoCheckpoint(tokensUsed: number, options?: CheckpointOptions): Promise<void> {
    this.tokensUsed = tokensUsed;
    const tokensSinceCheckpoint = this.tokensUsed - this.lastCheckpoint;
    const timeSinceCheckpoint = Date.now() - this.lastTimeCheckpoint;

    const shouldCheckpoint =
      options?.force ||
      tokensSinceCheckpoint >= this.checkpointInterval ||
      timeSinceCheckpoint >= this.timeBasedCheckpoint;

    if (shouldCheckpoint) {
      logger.info(`Auto-checkpoint triggered: tokens=${tokensSinceCheckpoint}, time=${timeSinceCheckpoint}ms`);
      await this.storeCheckpoint({
        sessionId: options?.sessionId || this.sessionId,
        currentTask: options?.currentTask,
        gitStatus: options?.gitStatus
      });
    }
  }

  // ============================================================================
  // PHASE 2: CONVERSATION CAPTURE
  // ============================================================================

  /**
   * Store a conversation event (episode) at critical moments
   */
  async storeConversationEvent(event: ConversationEvent): Promise<string> {
    try {
      const result = await this.graphragClient.storeEpisode(
        event.content,
        event.type,
        {
          importance: event.importance,
          session_id: event.sessionId || this.sessionId,
          ...event.metadata
        }
      );

      logger.info(`Conversation event stored: ${result.episode_id} (${event.type})`);
      return result.episode_id;
    } catch (error) {
      logger.error('Failed to store conversation event:', error);
      throw error;
    }
  }

  /**
   * Store task planning - CLAUDE.md mandate #1
   */
  async storeTaskPlanning(
    taskDescription: string,
    plan: string,
    options?: StorageOptions
  ): Promise<{ episodeId: string; documentId: string }> {
    // Store episode (< 800 chars)
    const episodeContent = `Task planned: ${taskDescription}\nPlan summary: ${plan.substring(0, 500)}...`;
    const episodeId = await this.storeConversationEvent({
      type: 'user_query',
      content: episodeContent,
      importance: options?.importance || 0.8,
      sessionId: options?.sessionId || this.sessionId,
      timestamp: new Date().toISOString(),
      metadata: options?.metadata
    });

    // Store full plan as document (> 800 chars)
    const documentResult = await this.graphragClient.storeDocument(
      plan,
      `Task Plan: ${taskDescription.substring(0, 50)} - ${new Date().toISOString()}`,
      {
        type: 'markdown',
        tags: ['planning', 'task', ...(options?.tags || [])],
        source: 'task-planning',
        episode_id: episodeId
      }
    );

    logger.info(`Task planning stored: episode=${episodeId}, document=${documentResult.documentId}`);

    // Update context
    this.currentContext.currentTask = taskDescription;
    this.currentContext.pendingTasks.push(taskDescription);

    return { episodeId, documentId: documentResult.documentId };
  }

  /**
   * Store task completion - CLAUDE.md mandate #2
   */
  async storeTaskCompletion(
    taskDescription: string,
    outcome: string,
    learnings: string[],
    options?: StorageOptions
  ): Promise<{ episodeId: string; documentId?: string }> {
    // Store episode
    const episodeContent = `Task completed: ${taskDescription}\nOutcome: ${outcome.substring(0, 500)}`;
    const episodeId = await this.storeConversationEvent({
      type: 'insight',
      content: episodeContent,
      importance: options?.importance || 0.9,
      sessionId: options?.sessionId || this.sessionId,
      timestamp: new Date().toISOString(),
      metadata: options?.metadata
    });

    // If outcome is large, store as document
    let documentId: string | undefined;
    if (outcome.length > 800) {
      const docResult = await this.graphragClient.storeDocument(
        outcome,
        `Task Completion: ${taskDescription.substring(0, 50)} - ${new Date().toISOString()}`,
        {
          type: 'markdown',
          tags: ['completion', 'outcome', ...(options?.tags || [])],
          source: 'task-completion',
          episode_id: episodeId
        }
      );
      documentId = docResult.documentId;
    }

    // Store learnings as patterns
    for (const learning of learnings) {
      await this.graphragClient.storePattern(
        learning,
        `Task completion: ${taskDescription}`,
        0.8,
        ['learning', 'task-completion', ...(options?.tags || [])]
      );
    }

    logger.info(`Task completion stored: episode=${episodeId}, document=${documentId}`);

    // Update context
    this.currentContext.completedSteps.push(taskDescription);
    this.currentContext.pendingTasks = this.currentContext.pendingTasks.filter(t => t !== taskDescription);

    return { episodeId, documentId };
  }

  /**
   * Store significant discovery - CLAUDE.md mandate #3
   */
  async storeDiscovery(
    discovery: string,
    context: string,
    options?: StorageOptions
  ): Promise<string> {
    const result = await this.graphragClient.storeMemory(
      discovery,
      ['discovery', 'insight', ...(options?.tags || [])],
      {
        importance: options?.importance || 0.8,
        context,
        session_id: options?.sessionId || this.sessionId,
        ...options?.metadata
      }
    );

    logger.info(`Discovery stored: ${result.memoryId}`);
    return result.memoryId;
  }

  /**
   * Store progress update - CLAUDE.md mandate #4 (every 15-20 minutes)
   */
  async storeProgressUpdate(progressSummary: string, options?: StorageOptions): Promise<string> {
    const episodeId = await this.storeConversationEvent({
      type: 'observation',
      content: progressSummary,
      importance: options?.importance || 0.5,
      sessionId: options?.sessionId || this.sessionId,
      timestamp: new Date().toISOString(),
      metadata: options?.metadata
    });

    logger.info(`Progress update stored: ${episodeId}`);
    return episodeId;
  }

  // ============================================================================
  // PHASE 3: CONTEXT INJECTION (FOUNDATION)
  // ============================================================================

  /**
   * Recall relevant context for a given query or tool execution
   */
  async recallContext(
    query: string,
    options?: {
      maxTokens?: number;
      includeEpisodes?: boolean;
      includeDocuments?: boolean;
    }
  ): Promise<any> {
    try {
      const result = await this.graphragClient.enhancedRetrieve(query, {
        maxTokens: options?.maxTokens || 2000,
        includeDocuments: options?.includeDocuments ?? true,
        includeEpisodic: options?.includeEpisodes ?? true
      });

      logger.info(`Context recalled for query: "${query}" - ${result.memories?.length || 0} memories, ${result.documents?.length || 0} documents`);
      return result;
    } catch (error) {
      logger.error('Failed to recall context:', error);
      throw error;
    }
  }

  /**
   * Inject context before tool execution (Phase 3 foundation)
   */
  async injectContextForTool(
    toolName: string,
    toolArgs: any,
    sessionId?: string
  ): Promise<any> {
    try {
      // Build context query from tool name and args
      const query = this.buildToolContextQuery(toolName, toolArgs);

      // Recall relevant context
      const context = await this.recallContext(query, {
        maxTokens: 1500,
        includeEpisodes: true,
        includeDocuments: true
      });

      logger.info(`Context injected for tool: ${toolName}`);
      return context;
    } catch (error) {
      logger.error(`Failed to inject context for tool ${toolName}:`, error);
      return null; // Graceful degradation
    }
  }

  // ============================================================================
  // UTILITIES
  // ============================================================================

  /**
   * Update context with new information
   */
  updateContext(updates: Partial<SessionContext>): void {
    this.currentContext = {
      ...this.currentContext,
      ...updates,
      timestamp: new Date().toISOString()
    };
  }

  /**
   * Get current context
   */
  getContext(): SessionContext {
    return { ...this.currentContext };
  }

  /**
   * Generate session ID
   */
  private generateSessionId(): string {
    return `session_${Date.now()}_${Math.random().toString(36).substring(7)}`;
  }

  /**
   * Format checkpoint as markdown document
   */
  private formatCheckpointDocument(checkpoint: SessionContext): string {
    return `# Session Checkpoint - ${checkpoint.timestamp}

## Session Info
- **Session ID**: ${checkpoint.sessionId}
- **Tokens Used**: ${checkpoint.tokensUsed || 0}
- **Checkpoint Time**: ${checkpoint.timestamp}

## Current Task
${checkpoint.currentTask || 'No specific task'}

## Completed Steps
${checkpoint.completedSteps.length > 0 ? checkpoint.completedSteps.map((s, i) => `${i + 1}. ${s}`).join('\n') : 'None yet'}

## In Progress
${checkpoint.inProgressWork.length > 0 ? checkpoint.inProgressWork.map((s, i) => `${i + 1}. ${s}`).join('\n') : 'None'}

## Pending Tasks
${checkpoint.pendingTasks.length > 0 ? checkpoint.pendingTasks.map((s, i) => `${i + 1}. ${s}`).join('\n') : 'None'}

## Key Decisions Made
${Object.entries(checkpoint.keyDecisions).length > 0 ? Object.entries(checkpoint.keyDecisions).map(([k, v]) => `- **${k}**: ${v}`).join('\n') : 'None'}

## Git Status
\`\`\`
${checkpoint.gitStatus || 'Not captured'}
\`\`\`
`;
  }

  /**
   * Parse checkpoint document back to SessionContext
   */
  private parseCheckpointDocument(content: string): SessionContext {
    // Simple parsing - in production, use more robust parsing
    const sessionIdMatch = content.match(/Session ID\*\*: (.+)/);
    const tokensMatch = content.match(/Tokens Used\*\*: (\d+)/);
    const timestampMatch = content.match(/Checkpoint Time\*\*: (.+)/);
    const currentTaskMatch = content.match(/## Current Task\n(.+?)\n/s);

    return {
      sessionId: sessionIdMatch?.[1] || 'unknown',
      tokensUsed: tokensMatch ? parseInt(tokensMatch[1]) : 0,
      timestamp: timestampMatch?.[1] || new Date().toISOString(),
      currentTask: currentTaskMatch?.[1]?.trim(),
      completedSteps: this.extractListItems(content, '## Completed Steps'),
      inProgressWork: this.extractListItems(content, '## In Progress'),
      pendingTasks: this.extractListItems(content, '## Pending Tasks'),
      keyDecisions: {}
    };
  }

  /**
   * Extract list items from markdown section
   */
  private extractListItems(content: string, sectionHeader: string): string[] {
    const sectionMatch = content.match(new RegExp(`${sectionHeader}\\n([\\s\\S]+?)(?=\\n##|$)`));
    if (!sectionMatch) return [];

    const items = sectionMatch[1].match(/^\d+\. (.+)$/gm);
    return items ? items.map(item => item.replace(/^\d+\. /, '')) : [];
  }

  /**
   * Build context query from tool name and arguments
   */
  private buildToolContextQuery(toolName: string, toolArgs: any): string {
    // Extract meaningful parts from tool arguments
    const argString = Object.entries(toolArgs)
      .filter(([key, value]) => typeof value === 'string' && value.length < 100)
      .map(([key, value]) => `${key}:${value}`)
      .join(' ');

    return `${toolName} ${argString}`.trim();
  }
}

// ============================================================================
// FACTORY FUNCTION
// ============================================================================

/**
 * Create a new ContextManager instance
 */
export function createContextManager(
  graphragClient: GraphRAGClientV2,
  sessionId?: string
): ContextManager {
  return new ContextManager(graphragClient, sessionId);
}

// ============================================================================
// EXPORTS
// ============================================================================

export default ContextManager;
