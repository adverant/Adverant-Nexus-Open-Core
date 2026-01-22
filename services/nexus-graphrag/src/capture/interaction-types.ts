/**
 * LLM Interaction Capture Types
 * Multi-platform conversation logging and context management
 */

// =============================================================================
// PLATFORM DEFINITIONS
// =============================================================================

export type PlatformType =
  | 'claude_code'
  | 'claude_desktop'
  | 'gemini_cli'
  | 'codex'
  | 'cursor'
  | 'vscode'
  | 'custom';

export type TaskType =
  | 'classification'
  | 'generation'
  | 'retrieval'
  | 'coding'
  | 'analysis'
  | 'debugging'
  | 'refactoring'
  | 'documentation'
  | 'testing';

// =============================================================================
// INTERACTION TYPES
// =============================================================================

export interface LLMInteraction {
  id: string;

  // Platform identification
  platform: PlatformType;
  platformVersion?: string;

  // User/session identification
  userId?: string; // Hashed for privacy
  sessionId: string;
  threadId?: string;
  parentInteractionId?: string;

  // Interaction content
  userMessage: string;
  assistantResponse: string;
  toolCalls?: ToolCall[];
  systemPrompt?: string;

  // Model information
  modelUsed?: string;
  modelProvider?: string;
  isFreeModel: boolean; // Should always be false

  // Context classification
  domain?: string;
  taskType?: TaskType;
  conversationContext?: ConversationMessage[];

  // Performance metrics
  tokensPrompt?: number;
  tokensCompletion?: number;
  tokensTotal?: number;
  costUsd?: number;
  latencyMs: number;
  cacheHit?: boolean;

  // Error tracking
  errorOccurred: boolean;
  errorMessage?: string;
  errorCode?: string;

  // Cross-references
  storedDocumentIds?: string[];
  retrievedDocumentIds?: string[];
  memoryIds?: string[];
  entityIds?: string[];

  // Timestamps
  startedAt: Date;
  completedAt: Date;
  createdAt: Date;
}

export interface ToolCall {
  name: string;
  arguments: Record<string, any>;
  result?: any;
  error?: string;
  latencyMs?: number;
}

export interface ConversationMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: Date;
  metadata?: Record<string, any>;
}

// =============================================================================
// INTERACTION CAPTURE REQUESTS
// =============================================================================

export interface CaptureInteractionRequest {
  // Platform
  platform: PlatformType;
  platformVersion?: string;

  // Session
  userId?: string;
  sessionId: string;
  threadId?: string;
  parentInteractionId?: string;

  // Content
  userMessage: string;
  assistantResponse: string;
  toolCalls?: ToolCall[];
  systemPrompt?: string;

  // Model
  modelUsed?: string;
  modelProvider?: string;

  // Classification (optional - can be auto-detected)
  domain?: string;
  taskType?: TaskType;
  conversationContext?: any;

  // Metrics
  tokensPrompt?: number;
  tokensCompletion?: number;
  tokensTotal?: number;
  costUsd?: number;
  latencyMs: number;
  cacheHit?: boolean;

  // Error info
  errorOccurred?: boolean;
  errorMessage?: string;
  errorCode?: string;

  // Cross-references
  storedDocumentIds?: string[];
  retrievedDocumentIds?: string[];
  memoryIds?: string[];
  entityIds?: string[];

  // Timestamps
  startedAt: Date;
  completedAt: Date;
}

export interface CaptureInteractionResponse {
  success: boolean;
  interactionId: string;
  message?: string;
}

// =============================================================================
// WEBHOOK CONFIGURATION
// =============================================================================

export interface PlatformWebhook {
  id: string;
  platformName: string;
  webhookUrl?: string;
  apiKeyHash?: string;
  enabled: boolean;
  lastPing?: Date;
  lastError?: string;
  errorCount: number;
  metadata: Record<string, any>;
  createdAt: Date;
  updatedAt: Date;
}

export interface RegisterWebhookRequest {
  platformName: string;
  webhookUrl?: string;
  apiKey: string; // Will be hashed
  metadata?: Record<string, any>;
}

export interface WebhookInteractionPayload extends CaptureInteractionRequest {
  signature: string; // HMAC signature for validation
  timestamp: number;
}

// =============================================================================
// INTERACTION RETRIEVAL AND SEARCH
// =============================================================================

export interface InteractionQuery {
  // Filtering
  sessionId?: string;
  threadId?: string;
  userId?: string;
  platform?: PlatformType | PlatformType[];
  domain?: string | string[];
  taskType?: TaskType | TaskType[];

  // Temporal filtering
  startDate?: Date;
  endDate?: Date;
  recentDays?: number; // Shortcut for last N days

  // Search
  searchText?: string;
  includeToolCalls?: boolean;

  // Error filtering
  errorsOnly?: boolean;
  successOnly?: boolean;

  // Pagination
  limit?: number;
  offset?: number;
  orderBy?: 'started_at' | 'latency_ms' | 'tokens_total' | 'cost_usd';
  orderDirection?: 'asc' | 'desc';
}

export interface InteractionQueryResult {
  interactions: LLMInteraction[];
  total: number;
  hasMore: boolean;
  aggregates?: InteractionAggregates;
}

export interface InteractionAggregates {
  totalInteractions: number;
  totalTokens: number;
  totalCost: number;
  averageLatency: number;
  errorRate: number;
  platformDistribution: Record<PlatformType, number>;
  domainDistribution: Record<string, number>;
}

// =============================================================================
// CONTEXT INJECTION
// =============================================================================

export interface ConversationContext {
  sessionId: string;
  threadId?: string;
  recentInteractions: LLMInteraction[];
  summary?: string;
  topics?: string[];
  activeDocuments?: string[];
  activeMemories?: string[];
}

export interface GetContextRequest {
  sessionId: string;
  threadId?: string;
  limit?: number; // Number of recent interactions to include
  includeSummary?: boolean;
}

export interface InjectContextRequest {
  sessionId: string;
  currentQuery: string;
  maxContextLength?: number; // Token limit for injected context
}

export interface InjectContextResponse {
  enrichedQuery: string;
  contextUsed: ConversationContext;
  tokensAdded: number;
}

// =============================================================================
// ARCHIVAL AND MAINTENANCE
// =============================================================================

export interface ArchiveInteractionsRequest {
  olderThanDays: number;
  convertToEntities?: boolean; // Convert to universal entities
}

export interface ArchiveInteractionsResult {
  archivedCount: number;
  deletedCount: number;
  entitiesCreated?: number;
  errors: string[];
}

export interface PurgeInteractionsRequest {
  // GDPR compliance
  userId?: string;
  sessionId?: string;
  olderThanDate?: Date;
  confirmPermanentDeletion: boolean;
}

export interface PurgeInteractionsResult {
  deletedCount: number;
  success: boolean;
  message: string;
}

// =============================================================================
// ANALYTICS AND INSIGHTS
// =============================================================================

export interface InteractionAnalytics {
  period: {
    start: Date;
    end: Date;
  };
  totalInteractions: number;
  uniqueSessions: number;
  uniqueUsers: number;
  totalTokens: number;
  totalCost: number;
  averageLatency: number;
  errorRate: number;

  // Platform breakdown
  byPlatform: Record<PlatformType, {
    count: number;
    tokens: number;
    cost: number;
    errorRate: number;
  }>;

  // Domain breakdown
  byDomain: Record<string, {
    count: number;
    tokens: number;
    cost: number;
  }>;

  // Model usage
  byModel: Record<string, {
    count: number;
    tokens: number;
    cost: number;
    avgLatency: number;
  }>;

  // Hourly distribution
  hourlyDistribution: Array<{
    hour: number;
    count: number;
    tokens: number;
  }>;
}

export interface GetAnalyticsRequest {
  startDate: Date;
  endDate: Date;
  platform?: PlatformType;
  domain?: string;
  groupBy?: 'hour' | 'day' | 'week';
}

// =============================================================================
// UTILITY FUNCTIONS
// =============================================================================

export function calculateLatency(startedAt: Date, completedAt: Date): number {
  return completedAt.getTime() - startedAt.getTime();
}

export function calculateTokens(prompt: string, completion: string): { prompt: number; completion: number; total: number } {
  // Rough estimation: 1 token ≈ 4 characters
  const promptTokens = Math.ceil(prompt.length / 4);
  const completionTokens = Math.ceil(completion.length / 4);
  return {
    prompt: promptTokens,
    completion: completionTokens,
    total: promptTokens + completionTokens
  };
}

export function validateInteraction(interaction: CaptureInteractionRequest): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  if (!interaction.platform) {
    errors.push('Platform is required');
  }

  if (!interaction.sessionId) {
    errors.push('Session ID is required');
  }

  if (!interaction.userMessage || interaction.userMessage.trim().length === 0) {
    errors.push('User message is required');
  }

  if (!interaction.assistantResponse || interaction.assistantResponse.trim().length === 0) {
    errors.push('Assistant response is required');
  }

  if (interaction.startedAt >= interaction.completedAt) {
    errors.push('Completed time must be after started time');
  }

  return {
    valid: errors.length === 0,
    errors
  };
}

export function hashUserId(userId: string): string {
  // Simple hash for privacy (in production, use proper crypto)
  const crypto = require('crypto');
  return crypto.createHash('sha256').update(userId).digest('hex');
}

export function buildInteractionSummary(interaction: LLMInteraction): string {
  const parts: string[] = [];

  parts.push(`[${interaction.platform}]`);
  if (interaction.modelUsed) {
    parts.push(`Model: ${interaction.modelUsed}`);
  }
  if (interaction.tokensTotal) {
    parts.push(`${interaction.tokensTotal} tokens`);
  }
  if (interaction.costUsd) {
    parts.push(`$${interaction.costUsd.toFixed(4)}`);
  }
  parts.push(`${interaction.latencyMs}ms`);

  return parts.join(' | ');
}
