/**
 * File Processing Telemetry Events
 *
 * Type definitions for Sandbox-First Unified Orchestration Monitor (UOM)
 * These types extend the base telemetry system with file-specific events.
 */

import { TelemetryEvent, EventPhase } from './types';

// ============================================================================
// Sandbox Analysis Types
// ============================================================================

/**
 * Sandbox analysis tiers
 */
export type SandboxTier = 'tier1' | 'tier2' | 'tier3';

/**
 * File classification categories
 */
export type FileCategory =
  | 'binary'
  | 'document'
  | 'archive'
  | 'media'
  | 'video'
  | 'code'
  | 'data'
  | 'geo'
  | 'pointcloud'
  | 'unknown';

/**
 * Threat levels from sandbox analysis
 */
export type ThreatLevel = 'safe' | 'low' | 'medium' | 'high' | 'critical';

/**
 * Security assessment actions
 */
export type SecurityAction = 'allow' | 'block' | 'review' | 'escalate';

/**
 * Target services for processing
 */
export type TargetService = 'cyberagent' | 'mageagent' | 'fileprocess' | 'videoagent' | 'geoagent' | 'github-manager';

/**
 * Storage destinations for post-processing
 */
export type StorageDestination = 'graphrag' | 'qdrant' | 'postgres';

/**
 * Decision source tracking
 */
export type DecisionSource =
  | 'pattern_cache'
  | 'llm_primary'
  | 'llm_fallback'
  | 'fast_path'
  | 'sandbox_recommendation';

// ============================================================================
// File Context Types
// ============================================================================

/**
 * File context for processing
 */
export interface FileContext {
  filename: string;
  mimeType: string;
  fileSize: number;
  fileHash?: string;
  storagePath?: string;
  originalUrl?: string;
}

/**
 * User context for decisions
 */
export interface UserContext {
  userId?: string;
  orgId?: string;
  userTrustScore?: number;
  sessionId?: string;
}

/**
 * Organization security policy
 */
export interface OrgSecurityPolicy {
  requireTier3ForExecutables: boolean;
  autoBlockHighThreat: boolean;
  reviewQueueEnabled: boolean;
  trustedUsersBypass: boolean;
  maxFileSizeMB: number;
  allowedMimeTypes?: string[];
  blockedMimeTypes?: string[];
}

// ============================================================================
// Sandbox Analysis Results
// ============================================================================

/**
 * File classification from sandbox
 */
export interface FileClassification {
  category: FileCategory;
  mimeType: string;
  format: string;
  confidence: number;
}

/**
 * Security findings from sandbox
 */
export interface SecurityFindings {
  threatLevel: ThreatLevel;
  isMalicious: boolean;
  shouldBlock: boolean;
  flags: string[];
  yaraMatches?: string[];
  cveMatches?: string[];
  behaviorIndicators?: string[];
}

/**
 * Sandbox recommendation
 */
export interface SandboxRecommendation {
  targetService: TargetService;
  method: string;
  priority: number;
  reason: string;
  confidence: number;
}

/**
 * Complete sandbox analysis result
 */
export interface SandboxAnalysisResult {
  analysisId: string;
  correlationId: string;
  tier: SandboxTier;
  classification: FileClassification;
  security: SecurityFindings;
  recommendations: SandboxRecommendation[];
  toolsUsed: string[];
  durationMs: number;
  timestamp: string;
}

// ============================================================================
// UOM Decision Types
// ============================================================================

/**
 * Decision points in the Sandbox-First flow
 */
export type UOMDecisionPoint =
  | 'initial_triage'
  | 'security_assessment'
  | 'processing_route'
  | 'post_processing';

/**
 * Initial Triage Decision
 */
export interface InitialTriageDecision {
  sandboxTier: SandboxTier;
  priority: number;
  timeout: number;
  tools: string[];
  reason: string;
}

/**
 * Security Assessment Decision
 */
export interface SecurityAssessmentDecision {
  action: SecurityAction;
  reason: string;
  reviewQueue?: string;
  notifyUsers?: string[];
  expiresAt?: string;
}

/**
 * Processing Route Decision
 */
export interface ProcessingRouteDecision {
  targetService: TargetService;
  method: string;
  tools?: string[];
  config?: Record<string, any>;
  priority: number;
  reason: string;
}

/**
 * Post-Processing Decision
 */
export interface PostProcessingDecision {
  storeIn: StorageDestination[];
  indexForSearch: boolean;
  generateEmbeddings: boolean;
  notifyUser: boolean;
  learnPattern: boolean;
  tags?: string[];
  reason: string;
}

/**
 * Generic UOM decision response
 */
export interface UOMDecision<T = Record<string, any>> {
  decisionPoint: UOMDecisionPoint;
  decision: T;
  confidence: number;
  reason: string;
  source: DecisionSource;
  durationMs: number;
  learnFromOutcome: boolean;
  alternatives?: Array<{
    decision: T;
    confidence: number;
    reason: string;
  }>;
}

// ============================================================================
// File Processing Events
// ============================================================================

/**
 * File processing operation types
 */
export type FileProcessingOperation =
  | 'file:received'
  | 'file:triage_requested'
  | 'file:triage_completed'
  | 'file:sandbox_started'
  | 'file:sandbox_completed'
  | 'file:security_requested'
  | 'file:security_completed'
  | 'file:route_requested'
  | 'file:route_completed'
  | 'file:processing_started'
  | 'file:processing_completed'
  | 'file:postprocess_requested'
  | 'file:postprocess_completed'
  | 'file:blocked'
  | 'file:review_queued'
  | 'file:completed'
  | 'file:failed';

/**
 * File received event
 */
export interface FileReceivedEvent extends TelemetryEvent {
  operation: 'file:received';
  metadata: {
    file: FileContext;
    user?: UserContext;
    sourceType: 'upload' | 'url' | 'google_drive' | 'api';
    sourceUrl?: string;
  };
}

/**
 * Triage requested event
 */
export interface TriageRequestedEvent extends TelemetryEvent {
  operation: 'file:triage_requested';
  metadata: {
    file: FileContext;
    user?: UserContext;
    orgPolicies?: OrgSecurityPolicy;
  };
}

/**
 * Triage completed event
 */
export interface TriageCompletedEvent extends TelemetryEvent {
  operation: 'file:triage_completed';
  metadata: {
    file: FileContext;
    decision: UOMDecision<InitialTriageDecision>;
  };
}

/**
 * Sandbox started event
 */
export interface SandboxStartedEvent extends TelemetryEvent {
  operation: 'file:sandbox_started';
  metadata: {
    file: FileContext;
    tier: SandboxTier;
    tools: string[];
    timeout: number;
  };
}

/**
 * Sandbox completed event
 */
export interface SandboxCompletedEvent extends TelemetryEvent {
  operation: 'file:sandbox_completed';
  metadata: {
    file: FileContext;
    sandboxResult: SandboxAnalysisResult;
  };
}

/**
 * Security assessment requested event
 */
export interface SecurityRequestedEvent extends TelemetryEvent {
  operation: 'file:security_requested';
  metadata: {
    file: FileContext;
    sandboxResult: SandboxAnalysisResult;
    user?: UserContext;
  };
}

/**
 * Security assessment completed event
 */
export interface SecurityCompletedEvent extends TelemetryEvent {
  operation: 'file:security_completed';
  metadata: {
    file: FileContext;
    sandboxResult: SandboxAnalysisResult;
    decision: UOMDecision<SecurityAssessmentDecision>;
  };
}

/**
 * Processing route requested event
 */
export interface RouteRequestedEvent extends TelemetryEvent {
  operation: 'file:route_requested';
  metadata: {
    file: FileContext;
    sandboxResult: SandboxAnalysisResult;
  };
}

/**
 * Processing route completed event
 */
export interface RouteCompletedEvent extends TelemetryEvent {
  operation: 'file:route_completed';
  metadata: {
    file: FileContext;
    sandboxResult: SandboxAnalysisResult;
    decision: UOMDecision<ProcessingRouteDecision>;
  };
}

/**
 * Processing started event
 */
export interface ProcessingStartedEvent extends TelemetryEvent {
  operation: 'file:processing_started';
  metadata: {
    file: FileContext;
    targetService: TargetService;
    method: string;
    jobId: string;
  };
}

/**
 * Processing completed event
 */
export interface ProcessingCompletedEvent extends TelemetryEvent {
  operation: 'file:processing_completed';
  metadata: {
    file: FileContext;
    targetService: TargetService;
    method: string;
    jobId: string;
    success: boolean;
    durationMs: number;
    outputPath?: string;
    extractedContent?: string;
    artifacts?: string[];
    error?: string;
  };
}

/**
 * Post-processing requested event
 */
export interface PostprocessRequestedEvent extends TelemetryEvent {
  operation: 'file:postprocess_requested';
  metadata: {
    file: FileContext;
    processingResult: {
      success: boolean;
      jobId: string;
      durationMs: number;
      outputPath?: string;
      artifacts?: string[];
    };
  };
}

/**
 * Post-processing completed event
 */
export interface PostprocessCompletedEvent extends TelemetryEvent {
  operation: 'file:postprocess_completed';
  metadata: {
    file: FileContext;
    decision: UOMDecision<PostProcessingDecision>;
    stored: boolean;
    indexed: boolean;
    patternLearned: boolean;
  };
}

/**
 * File blocked event
 */
export interface FileBlockedEvent extends TelemetryEvent {
  operation: 'file:blocked';
  metadata: {
    file: FileContext;
    reason: string;
    threatLevel: ThreatLevel;
    securityFlags: string[];
    notified?: string[];
  };
}

/**
 * File queued for review event
 */
export interface FileReviewQueuedEvent extends TelemetryEvent {
  operation: 'file:review_queued';
  metadata: {
    file: FileContext;
    reason: string;
    reviewQueue: string;
    expiresAt: string;
    threatLevel: ThreatLevel;
  };
}

/**
 * File processing completed event
 */
export interface FileCompletedEvent extends TelemetryEvent {
  operation: 'file:completed';
  metadata: {
    file: FileContext;
    totalDurationMs: number;
    sandboxDurationMs: number;
    processingDurationMs: number;
    targetService: TargetService;
    method: string;
    stored: boolean;
    indexed: boolean;
  };
}

/**
 * File processing failed event
 */
export interface FileFailedEvent extends TelemetryEvent {
  operation: 'file:failed';
  metadata: {
    file: FileContext;
    stage: 'triage' | 'sandbox' | 'security' | 'routing' | 'processing' | 'postprocess';
    error: string;
    errorCode?: string;
    durationMs: number;
  };
}

/**
 * Union type of all file processing events
 */
export type FileProcessingEvent =
  | FileReceivedEvent
  | TriageRequestedEvent
  | TriageCompletedEvent
  | SandboxStartedEvent
  | SandboxCompletedEvent
  | SecurityRequestedEvent
  | SecurityCompletedEvent
  | RouteRequestedEvent
  | RouteCompletedEvent
  | ProcessingStartedEvent
  | ProcessingCompletedEvent
  | PostprocessRequestedEvent
  | PostprocessCompletedEvent
  | FileBlockedEvent
  | FileReviewQueuedEvent
  | FileCompletedEvent
  | FileFailedEvent;

// ============================================================================
// Decision Outcome Tracking (for Pattern Learning)
// ============================================================================

/**
 * Decision outcome for learning
 */
export interface DecisionOutcome {
  decisionId: string;
  decisionPoint: UOMDecisionPoint;
  request: {
    file: FileContext;
    user?: UserContext;
    sandboxResult?: SandboxAnalysisResult;
  };
  decision: UOMDecision<any>;
  outcome: {
    success: boolean;
    actualResult: any;
    userFeedback?: 'correct' | 'incorrect' | 'adjusted';
    adjustedDecision?: Record<string, any>;
    processingTimeMs: number;
  };
  timestamp: string;
}

// ============================================================================
// Stream Key and Event Type Helpers
// ============================================================================

/**
 * Stream keys for file processing
 */
export const FILE_STREAM_KEYS = {
  FILE_EVENTS: 'nexus:file:events',
  UOM_DECISIONS: 'nexus:uom:decisions',
  DECISION_OUTCOMES: 'nexus:uom:outcomes',
  REVIEW_QUEUE: 'nexus:file:review'
} as const;

/**
 * Consumer groups for file processing
 */
export const FILE_CONSUMER_GROUPS = {
  ORCHESTRATOR: 'file_orchestrator',
  LEARNING: 'pattern_learning',
  SECURITY: 'security_monitor',
  AUDIT: 'file_audit'
} as const;

/**
 * Type guard for file processing events
 */
export function isFileProcessingEvent(event: TelemetryEvent): event is FileProcessingEvent {
  return event.operation.startsWith('file:');
}

/**
 * Type guard for specific file operations
 */
export function isFileOperation(
  event: TelemetryEvent,
  operation: FileProcessingOperation
): boolean {
  return event.operation === operation;
}
