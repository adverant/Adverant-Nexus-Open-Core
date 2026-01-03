/**
 * Context Injector
 * Automatically injects conversation context for cross-platform continuity
 */

import { logger } from '../utils/logger';
import { InteractionService } from './interaction-service';
import { GetContextRequest, ConversationContext } from './interaction-types';

export interface InjectContextOptions {
  sessionId: string;
  threadId?: string;
  currentQuery: string;
  maxContextLength?: number; // Token limit for injected context
  maxInteractions?: number; // Max number of past interactions to include
  includeSummary?: boolean;
  includeDocumentRefs?: boolean;
  includeMemoryRefs?: boolean;
}

export interface InjectedContext {
  enrichedQuery: string;
  contextUsed: ConversationContext;
  tokensAdded: number;
  contextSummary: string;
}

export class ContextInjector {
  private interactionService: InteractionService;

  constructor(interactionService: InteractionService) {
    this.interactionService = interactionService;
    logger.info('Context Injector initialized');
  }

  /**
   * Inject conversation context into current query
   */
  async inject(options: InjectContextOptions): Promise<InjectedContext> {
    try {
      // Get recent conversation context
      const contextRequest: GetContextRequest = {
        sessionId: options.sessionId,
        threadId: options.threadId,
        limit: options.maxInteractions || 10,
        includeSummary: options.includeSummary !== false
      };

      const context = await this.interactionService.getContext(contextRequest);

      // Build context string
      const contextParts: string[] = [];
      let estimatedTokens = 0;
      const maxTokens = options.maxContextLength || 8000;

      // Add summary if available
      if (context.summary) {
        contextParts.push(`## Conversation Summary\n${context.summary}\n`);
        estimatedTokens += this.estimateTokens(context.summary);
      }

      // Add recent interactions
      if (context.recentInteractions.length > 0) {
        contextParts.push('## Recent Conversation History\n');

        for (const interaction of context.recentInteractions.slice(-5)) {
          const interactionText = this.formatInteraction(interaction);
          const interactionTokens = this.estimateTokens(interactionText);

          if (estimatedTokens + interactionTokens > maxTokens) {
            break; // Stop if we exceed token limit
          }

          contextParts.push(interactionText);
          estimatedTokens += interactionTokens;
        }

        contextParts.push(''); // Empty line
      }

      // Add active documents
      if (options.includeDocumentRefs && context.activeDocuments && context.activeDocuments.length > 0) {
        contextParts.push(`## Referenced Documents\n- ${context.activeDocuments.slice(0, 5).join('\n- ')}\n`);
        estimatedTokens += this.estimateTokens(context.activeDocuments.join(''));
      }

      // Add active memories
      if (options.includeMemoryRefs && context.activeMemories && context.activeMemories.length > 0) {
        contextParts.push(`## Active Memories\n- ${context.activeMemories.slice(0, 5).join('\n- ')}\n`);
        estimatedTokens += this.estimateTokens(context.activeMemories.join(''));
      }

      // Add current query
      contextParts.push(`## Current Query\n${options.currentQuery}`);

      const enrichedQuery = contextParts.join('\n');

      const contextSummary = this.buildContextSummary(context);

      logger.debug('Context injected', {
        sessionId: options.sessionId,
        interactionsIncluded: context.recentInteractions.length,
        tokensAdded: estimatedTokens
      });

      return {
        enrichedQuery,
        contextUsed: context,
        tokensAdded: estimatedTokens,
        contextSummary
      };
    } catch (error) {
      logger.error('Failed to inject context', { error, options });
      // Fallback: return original query without context
      return {
        enrichedQuery: options.currentQuery,
        contextUsed: {
          sessionId: options.sessionId,
          recentInteractions: []
        },
        tokensAdded: 0,
        contextSummary: 'Context injection failed'
      };
    }
  }

  /**
   * Check if context injection would be beneficial for this query
   */
  shouldInjectContext(query: string): boolean {
    const lowerQuery = query.toLowerCase();

    // Queries that benefit from context
    const contextIndicators = [
      'what did',
      'previous',
      'earlier',
      'last time',
      'before',
      'yesterday',
      'we discussed',
      'we talked',
      'continue',
      'also',
      'more about',
      'that',
      'it',
      'this'
    ];

    return contextIndicators.some(indicator => lowerQuery.includes(indicator));
  }

  /**
   * Format interaction for context
   */
  private formatInteraction(interaction: any): string {
    const timestamp = new Date(interaction.startedAt).toLocaleString();
    const parts: string[] = [];

    parts.push(`**[${timestamp}] ${interaction.platform}**`);
    parts.push(`User: ${this.truncate(interaction.userMessage, 200)}`);
    parts.push(`Assistant: ${this.truncate(interaction.assistantResponse, 200)}`);

    if (interaction.toolCalls && interaction.toolCalls.length > 0) {
      const toolNames = interaction.toolCalls.map((t: any) => t.name).join(', ');
      parts.push(`Tools used: ${toolNames}`);
    }

    parts.push(''); // Empty line

    return parts.join('\n');
  }

  /**
   * Build human-readable context summary
   */
  private buildContextSummary(context: ConversationContext): string {
    const parts: string[] = [];

    if (context.recentInteractions.length > 0) {
      parts.push(`${context.recentInteractions.length} recent interactions`);
    }

    if (context.topics && context.topics.length > 0) {
      parts.push(`Topics: ${context.topics.join(', ')}`);
    }

    if (context.activeDocuments && context.activeDocuments.length > 0) {
      parts.push(`${context.activeDocuments.length} referenced documents`);
    }

    if (context.activeMemories && context.activeMemories.length > 0) {
      parts.push(`${context.activeMemories.length} active memories`);
    }

    return parts.join(' | ');
  }

  /**
   * Estimate tokens (rough approximation)
   */
  private estimateTokens(text: string): number {
    // Rough estimation: 1 token ≈ 4 characters
    return Math.ceil(text.length / 4);
  }

  /**
   * Truncate text to max length
   */
  private truncate(text: string, maxLength: number): string {
    if (text.length <= maxLength) return text;
    return text.substring(0, maxLength) + '...';
  }
}
