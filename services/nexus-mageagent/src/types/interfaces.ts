/**
 * Shared type definitions for MageAgent services
 */

// Context Service Types
export interface ContextOptions {
  episodeLimit?: number;
  documentLimit?: number;
  memoryLimit?: number;
  graphDepth?: number;
  includeDecay?: boolean;
  sessionId?: string;
  agentId?: string;
  threadId?: string;
  timeWindow?: number;
  minRelevance?: number;
  includeRelationships?: boolean;
  includeFacts?: boolean;
  includeEpisodes?: boolean;
  includeDocuments?: boolean;
  includeMemories?: boolean;
  includeGraph?: boolean;
  limit?: number;
}

// Agent Learning Types
export interface AgentProfile {
  agentId: string;
  totalTasks: number;
  averagePerformance?: number;
  strengths: string[];
  weaknesses: string[];
  preferredModels: string[];
  adjustedParameters: {
    temperature?: number;
    maxTokens?: number;
    topP?: number;
  };
  learningHistory: LearningEvent[];
}

export interface LearningEvent {
  timestamp: Date;
  type: 'feedback' | 'performance' | 'pattern';
  data: any;
}

export interface PerformanceMetrics {
  tokensUsed: number;
  latency: number;
  errorRate: number;
  qualityScore: number;
  costEfficiency: number;
}

// Conversation Threading Types
export interface ConversationMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: Date;
  metadata?: any;
}

export interface ThreadContext {
  topic: string;
  goals: string[];
  constraints: string[];
  decisions: string[];
}