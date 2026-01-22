/**
 * Intelligent Retry System - Type Definitions
 *
 * Centralized type definitions for the retry system.
 *
 * @module retry/types
 * @version 1.0.0
 */

// ============================================================================
// Core Retry Types
// ============================================================================

export interface RetryOptions {
  taskId?: string;
  agentId?: string;
  operation: string;
  context?: any;
  retryConfig?: RetryStrategy;
  maxAttempts?: number;
}

export interface RetryStrategy {
  maxRetries: number;
  backoffMs: number[];
  exponentialBackoff: boolean;
  timeout?: number;
  jitterMs?: number;
}

export interface RetryRecommendation {
  patternId: string | null;
  shouldRetry: boolean;
  strategy: RetryStrategy;
  confidence: number;
  category: string;
  severity: string;
  reasoning: string;
  modifications?: OperationModification[];
}

export interface OperationModification {
  type: 'parameter_change' | 'alternative_method' | 'resource_adjustment';
  description: string;
  changes: Record<string, any>;
}

// ============================================================================
// Error Context Types
// ============================================================================

export interface ErrorContext {
  service: string;
  operation: string;
  context?: Record<string, any>;
  attempt?: number;
  taskId?: string;
  agentId?: string;
}

export interface RetryAttempt {
  taskId: string;
  agentId?: string;
  patternId?: string;
  attempt: number;
  strategyApplied: RetryStrategy;
  modificationsApplied?: OperationModification[];
  success: boolean;
  executionTimeMs?: number;
  error?: string;
  contextSnapshot?: Record<string, any>;
}

// ============================================================================
// Pattern Types
// ============================================================================

export interface ErrorPattern {
  id: string;
  errorType: string;
  errorMessage: string;
  errorStack?: string;
  errorCode?: string;
  serviceName: string;
  operationName: string;
  category?: string;
  severity?: string;
  retryable: boolean;
  retrySuccessCount: number;
  retryFailureCount: number;
  successRate?: number;
  recommendedStrategy: RetryStrategy;
  normalizedMessage: string;
  messageHash: string;
  occurrenceCount: number;
  firstSeenAt: Date;
  lastSeenAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

// ============================================================================
// WebSocket Event Types
// ============================================================================

export interface RetryAttemptEvent {
  type: 'retry:attempt';
  taskId: string;
  attempt: number;
  strategy: RetryStrategy;
  timestamp: string;
}

export interface RetryAnalysisEvent {
  type: 'retry:analysis';
  taskId: string;
  attempt: number;
  error: string;
  recommendation: RetryRecommendation;
  timestamp: string;
}

export interface RetryBackoffEvent {
  type: 'retry:backoff';
  taskId: string;
  attempt: number;
  backoffMs: number;
  nextAttempt: number;
  timestamp: string;
}

export interface RetrySuccessEvent {
  type: 'retry:success';
  taskId: string;
  totalAttempts: number;
  timestamp: string;
}

export interface RetryExhaustedEvent {
  type: 'retry:exhausted';
  taskId: string;
  totalAttempts: number;
  finalError: string;
  timestamp: string;
}

export type RetryEvent =
  | RetryAttemptEvent
  | RetryAnalysisEvent
  | RetryBackoffEvent
  | RetrySuccessEvent
  | RetryExhaustedEvent;

// ============================================================================
// Analytics Types
// ============================================================================

export interface RetryAnalytics {
  stats: {
    totalPatterns: number;
    retryablePatterns: number;
    avgSuccessRate: number;
    totalSuccesses: number;
    totalFailures: number;
  };
  topPatterns: PatternSummary[];
  recentActivity: {
    attemptsLastHour: number;
    successesLastHour: number;
    failuresLastHour: number;
  };
  cacheMetrics: {
    size: number;
    hitRate: number;
    lastRefresh: string;
  };
}

export interface PatternSummary {
  serviceName: string;
  operationName: string;
  category: string;
  patternCount: number;
  avgSuccessRate: number;
}

// ============================================================================
// Configuration Types
// ============================================================================

export interface RetryConfig {
  // Global settings
  enabled: boolean;
  maxGlobalRetries: number;
  defaultBackoffMs: number[];
  enableLearning: boolean;

  // Cache settings
  cacheTTL: number;
  cacheMaxSize: number;

  // Database settings
  retentionDays: number;
  batchSize: number;

  // Performance settings
  analysisTimeoutMs: number;
  recordingAsync: boolean;

  // Service-specific overrides
  serviceOverrides?: {
    [service: string]: Partial<RetryStrategy>;
  };
}

// ============================================================================
// Error Categories
// ============================================================================

export enum ErrorCategory {
  TRANSIENT = 'transient',
  INFRASTRUCTURE = 'infrastructure',
  DATA_QUALITY = 'data_quality',
  RESOURCE_EXHAUSTION = 'resource_exhaustion',
  CONFIGURATION = 'configuration',
  UNKNOWN = 'unknown'
}

export enum ErrorSeverity {
  LOW = 'low',
  MEDIUM = 'medium',
  HIGH = 'high',
  CRITICAL = 'critical'
}

// ============================================================================
// Retry Outcome Types
// ============================================================================

export interface RetryOutcome {
  success: boolean;
  attempts: number;
  totalTimeMs: number;
  pattern?: ErrorPattern;
  modifications?: OperationModification[];
  finalError?: Error;
}

// ============================================================================
// Utility Types
// ============================================================================

export type RetryableOperation<T> = () => Promise<T>;

export interface RetryMetrics {
  operation: string;
  attempts: number;
  success: boolean;
  totalTimeMs: number;
  backoffTimeMs: number;
  pattern?: string;
}
