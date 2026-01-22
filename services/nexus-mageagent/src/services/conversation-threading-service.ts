/**
 * Conversation Threading Service for MageAgent
 * Manages conversation threads with full context preservation
 * Enables multi-turn conversations with memory
 */

import { v4 as uuidv4 } from 'uuid';
import { episodeService, AgentEpisode } from './episode-service';
import { contextService } from './context-service';
import { documentStorageService } from './document-storage-service';
import { graphRAGClient, createGraphRAGClient } from '../clients/graphrag-client';
import { logger } from '../utils/logger';
import { TenantContext } from '../middleware/tenant-context';

export interface ConversationThread {
  id: string;
  title: string;
  sessionId: string;
  episodes: string[]; // Episode IDs
  participants: Set<string>; // Agent IDs and 'user'
  entities: Set<string>;
  facts: string[];
  summary?: string;
  metadata: {
    created: Date;
    lastUpdated: Date;
    messageCount: number;
    status: 'active' | 'paused' | 'completed' | 'archived';
    tags: string[];
    importance: number;
    parentThreadId?: string;
    branchPoint?: string; // Episode ID where thread branched
  };
  context?: {
    topic: string;
    goals: string[];
    constraints: string[];
    decisions: string[];
  };
  // PHASE 56: Store tenant context for periodic storage operations
  tenantContext?: TenantContext;
}

export interface ThreadMessage {
  id: string;
  threadId: string;
  episodeId: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  agentId?: string;
  agentName?: string;
  timestamp: Date;
  metadata?: any;
}

export interface ThreadAnalysis {
  threadId: string;
  turns: number;
  participants: number;
  avgResponseTime: number;
  topics: string[];
  sentiment: number;
  coherence: number;
  completeness: number;
  keyInsights: string[];
  unresolvedQuestions: string[];
}

export class ConversationThreadingService {
  private static instance: ConversationThreadingService;
  private threads: Map<string, ConversationThread> = new Map();
  private activeThreads: Map<string, string> = new Map(); // sessionId -> threadId
  private threadMessages: Map<string, ThreadMessage[]> = new Map();
  private interactionCounter: Map<string, number> = new Map(); // Track interactions per thread
  private readonly STORAGE_INTERVAL = 3; // Store after every 3 interactions

  private constructor() {
    // Start periodic storage timer - store all active conversations every 5 minutes
    this.startPeriodicStorage();
  }

  private startPeriodicStorage(): void {
    setInterval(async () => {
      await this.storeAllActiveConversations();
    }, 5 * 60 * 1000); // 5 minutes
  }

  private async storeAllActiveConversations(): Promise<void> {
    try {
      for (const [threadId, thread] of this.threads) {
        if (thread.metadata.status === 'active') {
          // PHASE 56: Pass tenant context stored on thread for multi-tenant isolation
          // Skip threads without tenant context to avoid security violations
          if (thread.tenantContext) {
            await this.storeFullConversation(threadId, thread.tenantContext);
          } else {
            logger.debug('Skipping thread storage - no tenant context', { threadId });
          }
        }
      }
      logger.debug('Periodic conversation storage completed', {
        threadsStored: this.threads.size
      });
    } catch (error) {
      logger.error('Failed to store active conversations', { error });
    }
  }

  public static getInstance(): ConversationThreadingService {
    if (!ConversationThreadingService.instance) {
      ConversationThreadingService.instance = new ConversationThreadingService();
    }
    return ConversationThreadingService.instance;
  }

  /**
   * Create a new conversation thread
   * PHASE38: Added tenantContext parameter for multi-tenant isolation
   */
  async createThread(
    initialMessage: string,
    sessionId: string,
    metadata?: any,
    tenantContext?: TenantContext
  ): Promise<ConversationThread> {
    try {
      const threadId = uuidv4();

      // Create initial episode
      // PHASE38: Pass tenant context for multi-tenant isolation
      const initialEpisode = await episodeService.createFromUserInput(
        initialMessage,
        sessionId,
        {
          threadId,
          ...metadata
        },
        tenantContext
      );

      // Extract initial context
      // PHASE 52: Pass tenant context to contextService for multi-tenant isolation
      const context = await contextService.synthesizeContext(initialMessage, {
        sessionId,
        episodeLimit: 5,
        documentLimit: 3,
        tenantContext
      });

      // Create thread
      // PHASE 56: Store tenant context on thread for periodic storage operations
      const thread: ConversationThread = {
        id: threadId,
        title: this.generateThreadTitle(initialMessage),
        sessionId,
        episodes: [initialEpisode.id],
        participants: new Set(['user']),
        entities: new Set(context.entities),
        facts: context.facts,
        summary: context.summary,
        metadata: {
          created: new Date(),
          lastUpdated: new Date(),
          messageCount: 1,
          status: 'active',
          tags: this.extractThreadTags(initialMessage),
          importance: 0.7, // Default importance
          ...metadata
        },
        context: {
          topic: this.extractTopic(initialMessage),
          goals: this.extractGoals(initialMessage),
          constraints: [],
          decisions: []
        },
        tenantContext // PHASE 56: Store tenant context for later use
      };

      // Create initial message
      const message: ThreadMessage = {
        id: uuidv4(),
        threadId,
        episodeId: initialEpisode.id,
        role: 'user',
        content: initialMessage,
        timestamp: new Date()
      };

      // Store thread and message
      this.threads.set(threadId, thread);
      this.activeThreads.set(sessionId, threadId);
      this.threadMessages.set(threadId, [message]);

      // Store in GraphRAG for persistence
      // PHASE 41: Pass tenantContext for multi-tenant isolation
      await this.persistThread(thread, tenantContext);

      logger.info('Conversation thread created', {
        threadId,
        title: thread.title,
        sessionId
      });

      return thread;
    } catch (error) {
      logger.error('Failed to create conversation thread', { error });
      throw error;
    }
  }

  /**
   * Add message to existing thread
   * PHASE38: Added tenantContext parameter for multi-tenant isolation
   */
  async addToThread(
    threadId: string,
    content: string,
    role: 'user' | 'assistant' | 'system',
    agentInfo?: { id: string; name: string; model?: string },
    tenantContext?: TenantContext
  ): Promise<ThreadMessage> {
    try {
      const thread = this.threads.get(threadId);
      if (!thread) {
        throw new Error(`Thread ${threadId} not found`);
      }

      // Create episode based on role
      // PHASE38: Pass tenant context for multi-tenant isolation
      let episode: AgentEpisode;
      if (role === 'user') {
        episode = await episodeService.createFromUserInput(
          content,
          thread.sessionId,
          { threadId, parentEpisodeId: thread.episodes[thread.episodes.length - 1] },
          tenantContext
        );
      } else {
        // For assistant/system responses
        episode = await episodeService.createFromAgentResponse(
          agentInfo || { id: 'system', name: 'System', model: 'internal' },
          { content },
          { threadId, parentEpisodeId: thread.episodes[thread.episodes.length - 1] },
          thread.sessionId,
          tenantContext
        );

        if (agentInfo) {
          thread.participants.add(agentInfo.id);
        }
      }

      // Update thread
      thread.episodes.push(episode.id);
      thread.metadata.lastUpdated = new Date();
      thread.metadata.messageCount++;

      // Extract and add new entities and facts
      if (episode.metadata.entities) {
        episode.metadata.entities.forEach(e => thread.entities.add(e));
      }
      if (episode.metadata.facts) {
        thread.facts.push(...episode.metadata.facts);
      }

      // Create message
      const message: ThreadMessage = {
        id: uuidv4(),
        threadId,
        episodeId: episode.id,
        role,
        content,
        agentId: agentInfo?.id,
        agentName: agentInfo?.name,
        timestamp: new Date(),
        metadata: episode.metadata
      };

      // Add message to thread
      const messages = this.threadMessages.get(threadId) || [];
      messages.push(message);
      this.threadMessages.set(threadId, messages);

      // Update thread summary if enough messages
      if (thread.metadata.messageCount % 5 === 0) {
        thread.summary = await this.generateThreadSummary(threadId);
      }

      // Check for thread completion conditions
      if (this.shouldCompleteThread(thread, content)) {
        thread.metadata.status = 'completed';
      }

      // PHASE 56: Update tenant context on thread if provided (for periodic storage)
      if (tenantContext && !thread.tenantContext) {
        thread.tenantContext = tenantContext;
      }

      // Persist updated thread
      // PHASE 41: Pass tenantContext for multi-tenant isolation
      await this.persistThread(thread, tenantContext);

      // Also store the message content directly to GraphRAG for better recall
      // PHASE 41: Use dynamic client with tenant context
      try {
        const client = tenantContext ? createGraphRAGClient(tenantContext) : graphRAGClient;
        await client.storeMemory({
          content: `${role === 'user' ? 'User' : agentInfo?.name || 'Assistant'}: ${content}`,
          tags: ['conversation', 'thread:' + threadId, `role:${role}`, 'session:' + thread.sessionId],
          metadata: {
            threadId,
            messageId: message.id,
            episodeId: episode.id,
            sessionId: thread.sessionId,
            timestamp: message.timestamp,
            agentInfo
          }
        });
        logger.debug('Message stored to GraphRAG memory', { messageId: message.id });
      } catch (error) {
        logger.warn('Failed to store message to GraphRAG, continuing', {
          error: error instanceof Error ? error.message : 'Unknown error',
          messageId: message.id
        });
        // Continue even if GraphRAG storage fails
      }

      // Track interactions and store after every 3-5 messages
      const interactions = (this.interactionCounter.get(threadId) || 0) + 1;
      this.interactionCounter.set(threadId, interactions);

      // Store full conversation after every 3 interactions
      if (interactions >= this.STORAGE_INTERVAL) {
        logger.info('Auto-storing conversation after 3 interactions', {
          threadId,
          interactions,
          messageCount: thread.metadata.messageCount
        });

        await this.storeFullConversation(threadId);

        // Reset interaction counter
        this.interactionCounter.set(threadId, 0);
      }

      // Store long conversations as documents
      // PHASE 44: Pass tenant context for multi-tenant isolation
      if (thread.metadata.messageCount > 10 && thread.metadata.messageCount % 10 === 0) {
        await this.archiveThreadSegment(thread, tenantContext);
      }

      logger.debug('Message added to thread', {
        threadId,
        episodeId: episode.id,
        role,
        messageCount: thread.metadata.messageCount,
        interactionCount: interactions
      });

      return message;
    } catch (error) {
      logger.error('Failed to add message to thread', { error, threadId });
      throw error;
    }
  }

  /**
   * Get or create active thread for session
   */
  async getOrCreateThread(sessionId: string, message?: string): Promise<ConversationThread> {
    // Check for active thread
    const activeThreadId = this.activeThreads.get(sessionId);
    if (activeThreadId) {
      const thread = this.threads.get(activeThreadId);
      if (thread && thread.metadata.status === 'active') {
        return thread;
      }
    }

    // Create new thread
    if (message) {
      return await this.createThread(message, sessionId);
    }

    throw new Error('No active thread and no message to create one');
  }

  /**
   * Get thread with full context
   */
  async getThreadWithContext(threadId: string): Promise<{
    thread: ConversationThread;
    messages: ThreadMessage[];
    context: any;
  }> {
    try {
      let thread = this.threads.get(threadId);
      if (!thread) {
        // Try to load from storage
        const loaded = await this.loadThread(threadId);
        if (!loaded) {
          throw new Error(`Thread ${threadId} not found`);
        }
        thread = loaded;
        this.threads.set(threadId, thread);
      }

      const messages = this.threadMessages.get(threadId) || [];

      // Get enriched context
      const context = await contextService.synthesizeContext(
        thread.summary || 'Thread context',
        {
          sessionId: thread.sessionId,
          episodeLimit: 10,
          documentLimit: 5
        }
      );

      return {
        thread: thread!,
        messages,
        context
      };
    } catch (error) {
      logger.error('Failed to get thread with context', { error, threadId });
      throw error;
    }
  }

  /**
   * Branch thread from specific point
   */
  async branchThread(
    sourceThreadId: string,
    branchPointEpisodeId: string,
    newMessage: string
  ): Promise<ConversationThread> {
    try {
      const sourceThread = this.threads.get(sourceThreadId);
      if (!sourceThread) {
        throw new Error(`Source thread ${sourceThreadId} not found`);
      }

      // Find branch point
      const branchIndex = sourceThread.episodes.indexOf(branchPointEpisodeId);
      if (branchIndex === -1) {
        throw new Error(`Episode ${branchPointEpisodeId} not found in thread`);
      }

      // Create new thread as branch
      const branchedThread = await this.createThread(newMessage, sourceThread.sessionId, {
        parentThreadId: sourceThreadId,
        branchPoint: branchPointEpisodeId
      });

      // Copy episodes up to branch point
      const copiedEpisodes = sourceThread.episodes.slice(0, branchIndex + 1);
      branchedThread.episodes = [...copiedEpisodes, ...branchedThread.episodes];

      // Copy relevant context
      branchedThread.entities = new Set(sourceThread.entities);
      branchedThread.facts = sourceThread.facts.slice(0, branchIndex);
      branchedThread.context = sourceThread.context ? { ...sourceThread.context } : {
        topic: '',
        goals: [],
        constraints: [],
        decisions: []
      };

      // Update metadata
      branchedThread.metadata.messageCount = copiedEpisodes.length + 1;
      branchedThread.title = `Branch of: ${sourceThread.title}`;

      // Persist branched thread
      await this.persistThread(branchedThread);

      logger.info('Thread branched', {
        sourceThreadId,
        branchedThreadId: branchedThread.id,
        branchPoint: branchPointEpisodeId
      });

      return branchedThread;
    } catch (error) {
      logger.error('Failed to branch thread', { error, sourceThreadId });
      throw error;
    }
  }

  /**
   * Merge threads
   */
  async mergeThreads(
    threadIds: string[],
    title?: string
  ): Promise<ConversationThread> {
    try {
      const threads = threadIds.map(id => this.threads.get(id)).filter(Boolean) as ConversationThread[];

      if (threads.length < 2) {
        throw new Error('Need at least 2 threads to merge');
      }

      // Create merged thread
      const mergedThread: ConversationThread = {
        id: uuidv4(),
        title: title || `Merged: ${threads.map(t => t.title).join(', ')}`,
        sessionId: threads[0].sessionId,
        episodes: [],
        participants: new Set(),
        entities: new Set(),
        facts: [],
        metadata: {
          created: new Date(),
          lastUpdated: new Date(),
          messageCount: 0,
          status: 'active',
          tags: [],
          importance: Math.max(...threads.map(t => t.metadata.importance))
        },
        context: {
          topic: 'Merged conversation',
          goals: [],
          constraints: [],
          decisions: []
        }
      };

      // Merge all episodes chronologically
      const allEpisodes: { episodeId: string; timestamp: Date }[] = [];
      for (const thread of threads) {
        for (const episodeId of thread.episodes) {
          // Get episode timestamp (would need to fetch from storage)
          allEpisodes.push({ episodeId, timestamp: new Date() });
        }
      }

      // Sort by timestamp
      allEpisodes.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
      mergedThread.episodes = allEpisodes.map(e => e.episodeId);

      // Merge participants, entities, facts
      threads.forEach(thread => {
        thread.participants.forEach(p => mergedThread.participants.add(p));
        thread.entities.forEach(e => mergedThread.entities.add(e));
        mergedThread.facts.push(...thread.facts);
        mergedThread.metadata.tags.push(...thread.metadata.tags);
      });

      // Deduplicate
      mergedThread.facts = [...new Set(mergedThread.facts)];
      mergedThread.metadata.tags = [...new Set(mergedThread.metadata.tags)];

      // Generate summary for merged thread
      mergedThread.summary = await this.generateThreadSummary(mergedThread.id);

      // Store merged thread
      this.threads.set(mergedThread.id, mergedThread);
      await this.persistThread(mergedThread);

      // Mark source threads as archived
      threads.forEach(thread => {
        thread.metadata.status = 'archived';
        this.persistThread(thread);
      });

      logger.info('Threads merged', {
        sourceThreads: threadIds,
        mergedThreadId: mergedThread.id
      });

      return mergedThread;
    } catch (error) {
      logger.error('Failed to merge threads', { error, threadIds });
      throw error;
    }
  }

  /**
   * Analyze thread
   */
  async analyzeThread(threadId: string): Promise<ThreadAnalysis> {
    try {
      const thread = this.threads.get(threadId);
      if (!thread) {
        throw new Error(`Thread ${threadId} not found`);
      }

      const messages = this.threadMessages.get(threadId) || [];

      // Calculate metrics
      const turns = messages.length;
      const participants = thread.participants.size;

      // Calculate average response time
      let totalResponseTime = 0;
      let responseCount = 0;
      for (let i = 1; i < messages.length; i++) {
        if (messages[i].role === 'assistant' && messages[i - 1].role === 'user') {
          const responseTime = messages[i].timestamp.getTime() - messages[i - 1].timestamp.getTime();
          totalResponseTime += responseTime;
          responseCount++;
        }
      }
      const avgResponseTime = responseCount > 0 ? totalResponseTime / responseCount : 0;

      // Extract topics
      const topics = Array.from(thread.entities).slice(0, 10);

      // Calculate sentiment
      const sentiment = await this.calculateThreadSentiment(messages);

      // Calculate coherence
      const coherence = this.calculateCoherence(messages);

      // Calculate completeness
      const completeness = this.calculateCompleteness(thread);

      // Extract key insights
      const keyInsights = await this.extractKeyInsights(messages);

      // Find unresolved questions
      const unresolvedQuestions = this.findUnresolvedQuestions(messages);

      const analysis: ThreadAnalysis = {
        threadId,
        turns,
        participants,
        avgResponseTime,
        topics,
        sentiment,
        coherence,
        completeness,
        keyInsights,
        unresolvedQuestions
      };

      logger.debug('Thread analyzed', { threadId, analysis });

      return analysis;
    } catch (error) {
      logger.error('Failed to analyze thread', { error, threadId });
      throw error;
    }
  }

  /**
   * Search threads
   */
  async searchThreads(
    query: string,
    options: {
      sessionId?: string;
      status?: string;
      limit?: number;
    } = {}
  ): Promise<ConversationThread[]> {
    try {
      const results: ConversationThread[] = [];

      for (const [_, thread] of this.threads) {
        // Filter by options
        if (options.sessionId && thread.sessionId !== options.sessionId) continue;
        if (options.status && thread.metadata.status !== options.status) continue;

        // Search in thread content
        const matches = this.searchInThread(thread, query);
        if (matches) {
          results.push(thread);
        }

        if (results.length >= (options.limit || 10)) break;
      }

      return results;
    } catch (error) {
      logger.error('Failed to search threads', { error, query });
      return [];
    }
  }

  // Private helper methods

  private generateThreadTitle(message: string): string {
    // Use first sentence or first 50 chars
    const firstSentence = message.match(/^[^.!?]+[.!?]/);
    if (firstSentence) {
      return firstSentence[0].substring(0, 50);
    }
    return message.substring(0, 50) + '...';
  }

  private extractThreadTags(message: string): string[] {
    // Extract potential tags from message
    const tags: string[] = [];

    // Look for hashtags
    const hashtags = message.match(/#\w+/g) || [];
    tags.push(...hashtags.map(h => h.substring(1)));

    // Look for key phrases
    if (message.toLowerCase().includes('question')) tags.push('question');
    if (message.toLowerCase().includes('help')) tags.push('help-request');
    if (message.toLowerCase().includes('problem')) tags.push('problem-solving');

    return tags.slice(0, 10);
  }

  private extractTopic(message: string): string {
    // Simple topic extraction
    const sentences = message.split(/[.!?]+/);
    return sentences[0]?.trim() || 'General conversation';
  }

  private extractGoals(message: string): string[] {
    const goals: string[] = [];

    // Look for goal indicators
    if (message.includes('want to')) {
      const match = message.match(/want to ([^.!?]+)/);
      if (match) goals.push(match[1]);
    }

    if (message.includes('need to')) {
      const match = message.match(/need to ([^.!?]+)/);
      if (match) goals.push(match[1]);
    }

    if (message.includes('help me')) {
      const match = message.match(/help me ([^.!?]+)/);
      if (match) goals.push(match[1]);
    }

    return goals;
  }

  private async generateThreadSummary(threadId: string): Promise<string> {
    const messages = this.threadMessages.get(threadId) || [];

    if (messages.length === 0) return 'Empty thread';

    // Simple summary generation
    const firstMessage = messages[0].content;
    const lastMessage = messages[messages.length - 1].content;
    const messageCount = messages.length;

    return `Thread with ${messageCount} messages. Started with: "${firstMessage.substring(0, 50)}..." ` +
           `Latest: "${lastMessage.substring(0, 50)}..."`;
  }

  private shouldCompleteThread(_thread: ConversationThread, lastMessage: string): boolean {
    // Check for completion indicators
    const completionPhrases = [
      'thank you', 'thanks', 'that helps', 'problem solved',
      'goodbye', 'bye', "that's all", 'done'
    ];

    const lowerMessage = lastMessage.toLowerCase();
    return completionPhrases.some(phrase => lowerMessage.includes(phrase));
  }

  // PHASE 56: Added tenantContext parameter for multi-tenant isolation in periodic storage
  private async storeFullConversation(threadId: string, tenantContext?: TenantContext): Promise<void> {
    try {
      const thread = this.threads.get(threadId);
      if (!thread) {
        logger.warn('Thread not found for storage', { threadId });
        return;
      }

      const messages = this.threadMessages.get(threadId) || [];

      // Create a comprehensive conversation record
      const conversationRecord = {
        threadId: thread.id,
        title: thread.title,
        sessionId: thread.sessionId,
        messageCount: thread.metadata.messageCount,
        participants: Array.from(thread.participants),
        messages: messages.map(m => ({
          role: m.role,
          content: m.content,
          timestamp: m.timestamp,
          agentName: m.agentName
        })),
        summary: thread.summary,
        entities: Array.from(thread.entities),
        facts: thread.facts,
        context: thread.context,
        metadata: thread.metadata
      };

      // PHASE 56: Use tenant-aware client if tenant context is available
      const client = tenantContext ? createGraphRAGClient(tenantContext) : graphRAGClient;

      // Store the full conversation in GraphRAG
      await client.storeMemory({
        content: JSON.stringify(conversationRecord),
        tags: ['full-conversation', 'auto-save', `thread:${threadId}`, `session:${thread.sessionId}`],
        metadata: {
          threadId,
          sessionId: thread.sessionId,
          messageCount: messages.length,
          timestamp: new Date(),
          type: 'full_conversation_backup'
        }
      });

      // Also store a human-readable version
      const readableContent = `Conversation: ${thread.title}
Session: ${thread.sessionId}
Messages (${messages.length}):

${messages.map((m, i) => `${i + 1}. [${m.role}${m.agentName ? ` - ${m.agentName}` : ''}] (${new Date(m.timestamp).toLocaleTimeString()}):
${m.content}`).join('\n\n')}

Summary: ${thread.summary || 'No summary yet'}
Entities: ${Array.from(thread.entities).join(', ') || 'None identified'}
Key Facts: ${thread.facts.join('; ') || 'None recorded'}`;

      // PHASE 56: Use same tenant-aware client for readable version
      await client.storeMemory({
        content: readableContent,
        tags: ['conversation-text', 'auto-save', `thread:${threadId}`],
        metadata: {
          threadId,
          sessionId: thread.sessionId,
          type: 'conversation_text'
        }
      });

      logger.info('Full conversation stored successfully', {
        threadId,
        messageCount: messages.length,
        sessionId: thread.sessionId
      });
    } catch (error) {
      logger.error('Failed to store full conversation', {
        error: error instanceof Error ? error.message : 'Unknown error',
        threadId
      });
    }
  }

  /**
   * PHASE 44: Updated to accept tenantContext for multi-tenant isolation
   */
  private async archiveThreadSegment(thread: ConversationThread, tenantContext?: TenantContext): Promise<void> {
    try {
      const messages = this.threadMessages.get(thread.id) || [];
      const segment = messages.slice(-10); // Last 10 messages

      // Create document from thread segment
      const content = segment.map(m =>
        `[${m.role}${m.agentName ? ` - ${m.agentName}` : ''}]: ${m.content}`
      ).join('\n\n');

      // PHASE 44: Pass tenant context for multi-tenant isolation
      await documentStorageService.storeAgentOutput(
        { id: 'thread', name: 'Thread Archive', model: 'conversation' },
        { content },
        { id: thread.id, name: thread.title },
        thread.sessionId,
        tenantContext
      );

      logger.debug('Thread segment archived', { threadId: thread.id });
    } catch (error) {
      logger.error('Failed to archive thread segment', { error, threadId: thread.id });
    }
  }

  /**
   * PHASE 41: Updated to accept tenantContext and use dynamic GraphRAGClient
   * for multi-tenant isolation during thread persistence
   */
  private async persistThread(thread: ConversationThread, tenantContext?: TenantContext): Promise<void> {
    try {
      // PHASE 41: Use dynamic client with tenant context for multi-tenant isolation
      const client = tenantContext ? createGraphRAGClient(tenantContext) : graphRAGClient;

      // Store thread metadata in GraphRAG
      await client.storeMemory({
        content: JSON.stringify({
          id: thread.id,
          title: thread.title,
          metadata: thread.metadata,
          context: thread.context
        }),
        tags: ['thread', 'conversation', ...thread.metadata.tags],
        metadata: {
          threadId: thread.id,
          sessionId: thread.sessionId,
          type: 'conversation_thread'
        }
      });
    } catch (error) {
      logger.error('Failed to persist thread', { error, threadId: thread.id });
    }
  }

  private async loadThread(threadId: string): Promise<ConversationThread | null> {
    try {
      // Load from GraphRAG
      const memories = await graphRAGClient.recallMemory({
        query: `threadId:${threadId}`,
        limit: 1,
        tags: ['thread']
      });

      if (memories.length > 0) {
        const threadData = JSON.parse(memories[0].content);
        return {
          ...threadData,
          participants: new Set(threadData.participants),
          entities: new Set(threadData.entities)
        };
      }

      return null;
    } catch (error) {
      logger.error('Failed to load thread', { error, threadId });
      return null;
    }
  }

  private searchInThread(thread: ConversationThread, query: string): boolean {
    const queryLower = query.toLowerCase();

    // Search in title
    if (thread.title.toLowerCase().includes(queryLower)) return true;

    // Search in summary
    if (thread.summary?.toLowerCase().includes(queryLower)) return true;

    // Search in entities
    if (Array.from(thread.entities).some(e => e.toLowerCase().includes(queryLower))) return true;

    // Search in facts
    if (thread.facts.some(f => f.toLowerCase().includes(queryLower))) return true;

    return false;
  }

  private async calculateThreadSentiment(messages: ThreadMessage[]): Promise<number> {
    // Simple sentiment calculation
    let totalSentiment = 0;
    let count = 0;

    for (const message of messages) {
      if (message.metadata?.sentiment !== undefined) {
        totalSentiment += message.metadata.sentiment;
        count++;
      }
    }

    return count > 0 ? totalSentiment / count : 0;
  }

  private calculateCoherence(messages: ThreadMessage[]): number {
    // Simple coherence based on topic consistency
    if (messages.length < 2) return 1;

    // Check for topic shifts (simplified)
    let topicShifts = 0;
    for (let i = 1; i < messages.length; i++) {
      const prev = messages[i - 1].content.toLowerCase();
      const curr = messages[i].content.toLowerCase();

      // Check if topics are related (very simplified)
      const prevWords = new Set(prev.split(/\s+/));
      const currWords = new Set(curr.split(/\s+/));
      const common = [...prevWords].filter(w => currWords.has(w));

      if (common.length < 3) topicShifts++;
    }

    return Math.max(0, 1 - (topicShifts / messages.length));
  }

  private calculateCompleteness(thread: ConversationThread): number {
    // Check if thread reached its goals
    if (thread.metadata.status === 'completed') return 1;
    if (thread.metadata.status === 'archived') return 0.8;
    if (thread.metadata.status === 'paused') return 0.5;

    // Check for resolution indicators
    const hasResolution = thread.context?.decisions && thread.context.decisions.length > 0;
    return hasResolution ? 0.7 : 0.3;
  }

  private async extractKeyInsights(messages: ThreadMessage[]): Promise<string[]> {
    const insights: string[] = [];

    // Look for insight patterns
    messages.forEach(message => {
      const content = message.content;

      // Look for conclusions
      if (content.includes('therefore') || content.includes('thus') || content.includes('in conclusion')) {
        const sentence = this.extractSentenceWithKeyword(content, ['therefore', 'thus', 'in conclusion']);
        if (sentence) insights.push(sentence);
      }

      // Look for discoveries
      if (content.includes('found that') || content.includes('discovered')) {
        const sentence = this.extractSentenceWithKeyword(content, ['found that', 'discovered']);
        if (sentence) insights.push(sentence);
      }
    });

    return insights.slice(0, 5);
  }

  private findUnresolvedQuestions(messages: ThreadMessage[]): string[] {
    const questions: string[] = [];
    const answered = new Set<string>();

    // Find questions
    messages.forEach((message, index) => {
      if (message.content.includes('?')) {
        const questionSentences = message.content
          .split(/[.!]+/)
          .filter(s => s.includes('?'));

        questionSentences.forEach(q => {
          // Check if answered in subsequent messages
          let isAnswered = false;
          for (let i = index + 1; i < messages.length; i++) {
            if (this.looksLikeAnswer(messages[i].content, q)) {
              isAnswered = true;
              answered.add(q);
              break;
            }
          }

          if (!isAnswered && !answered.has(q)) {
            questions.push(q.trim());
          }
        });
      }
    });

    return questions.slice(0, 5);
  }

  private extractSentenceWithKeyword(text: string, keywords: string[]): string | null {
    const sentences = text.split(/[.!?]+/);
    for (const sentence of sentences) {
      const lower = sentence.toLowerCase();
      if (keywords.some(k => lower.includes(k))) {
        return sentence.trim();
      }
    }
    return null;
  }

  private looksLikeAnswer(content: string, question: string): boolean {
    // Very simplified answer detection
    const questionWords = question.toLowerCase().split(/\s+/)
      .filter(w => w.length > 3 && !['what', 'when', 'where', 'who', 'how', 'why'].includes(w));

    const contentLower = content.toLowerCase();
    const matchCount = questionWords.filter(w => contentLower.includes(w)).length;

    return matchCount >= Math.min(3, questionWords.length * 0.5);
  }

  /**
   * Add message to thread
   */
  async addMessage(
    threadId: string,
    role: 'user' | 'assistant' | 'system',
    content: string,
    metadata?: any
  ): Promise<void> {
    const thread = this.threads.get(threadId);
    if (!thread) {
      throw new Error(`Thread ${threadId} not found`);
    }

    const message: ThreadMessage = {
      id: uuidv4(),
      threadId,
      episodeId: '',
      role,
      content,
      timestamp: new Date(),
      metadata
    };

    if (!this.threadMessages.has(threadId)) {
      this.threadMessages.set(threadId, []);
    }
    this.threadMessages.get(threadId)!.push(message);

    thread.metadata.lastUpdated = new Date();
    thread.metadata.messageCount++;

    logger.info('Message added to thread', { threadId, messageId: message.id, role });
  }

  /**
   * Get thread by ID
   */
  async getThread(threadId: string): Promise<ConversationThread | undefined> {
    return this.threads.get(threadId);
  }

  /**
   * Clear thread cache
   */
  clearCache(): void {
    // Keep only recent threads (last 20)
    if (this.threads.size > 20) {
      const entries = Array.from(this.threads.entries())
        .sort((a, b) => b[1].metadata.lastUpdated.getTime() - a[1].metadata.lastUpdated.getTime())
        .slice(0, 20);
      this.threads.clear();
      entries.forEach(([key, value]) => this.threads.set(key, value));
    }
  }
}

export const conversationThreadingService = ConversationThreadingService.getInstance();