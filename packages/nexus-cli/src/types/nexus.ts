/**
 * Nexus-specific Type Definitions
 *
 * Types for Nexus MCP tool integration, streaming, and operations
 */

import type { ServiceHealth } from './service.js';

export interface NexusToolDefinition {
  name: string;
  description: string;
  category: NexusToolCategory;
  inputSchema: any;
  outputSchema?: any;
  streaming: boolean;
  examples: string[];
}

export type NexusToolCategory =
  | 'memory'
  | 'documents'
  | 'knowledge-graph'
  | 'code-analysis'
  | 'multi-agent'
  | 'learning'
  | 'episodes'
  | 'health'
  | 'general';

export interface NexusMemory {
  id: string;
  content: string;
  tags: string[];
  metadata?: Record<string, any>;
  embedding?: number[];
  score?: number;
  timestamp: Date;
}

export interface NexusDocument {
  id: string;
  title: string;
  content: string;
  type: DocumentType;
  tags: string[];
  metadata?: Record<string, any>;
  chunks?: DocumentChunk[];
  timestamp: Date;
}

export type DocumentType = 'code' | 'markdown' | 'text' | 'structured' | 'multimodal';

export interface DocumentChunk {
  id: string;
  documentId: string;
  content: string;
  index: number;
  embedding?: number[];
  metadata?: Record<string, any>;
}

export interface NexusEntity {
  id: string;
  domain: string;
  entityType: string;
  textContent: string;
  tags: string[];
  hierarchyLevel: number;
  metadata?: Record<string, any>;
  relationships?: EntityRelationship[];
  timestamp: Date;
}

export interface EntityRelationship {
  id: string;
  sourceEntityId: string;
  targetEntityId: string;
  relationshipType: string;
  weight: number;
  metadata?: Record<string, any>;
}

export interface CodeValidationRequest {
  code: string;
  language: string;
  context?: string;
  riskLevel: RiskLevel;
}

export type RiskLevel = 'low' | 'medium' | 'high' | 'critical';

export interface CodeValidationResult {
  validationId: string;
  models: ModelValidation[];
  consensus: ValidationConsensus;
  recommendations: string[];
}

export interface ModelValidation {
  model: string;
  issues: ValidationIssue[];
  score: number;
  executionTime: number;
}

export interface ValidationIssue {
  severity: 'critical' | 'warning' | 'info';
  category: string;
  message: string;
  line?: number;
  column?: number;
  suggestion?: string;
}

export interface ValidationConsensus {
  critical: number;
  warnings: number;
  info: number;
  recommendation: 'approve' | 'review' | 'reject';
  agreement: number; // 0-1 scale
}

export interface CodeAnalysisRequest {
  code: string;
  language: string;
  depth: AnalysisDepth;
  focusAreas?: string[];
}

export type AnalysisDepth = 'quick' | 'standard' | 'deep';

export interface CodeAnalysisResult {
  issues: AnalysisIssue[];
  metrics: CodeMetrics;
  suggestions: string[];
  executionTime: number;
}

export interface AnalysisIssue {
  type: string;
  severity: 'critical' | 'major' | 'minor' | 'info';
  message: string;
  location?: CodeLocation;
  suggestion?: string;
}

export interface CodeLocation {
  file?: string;
  line: number;
  column: number;
  endLine?: number;
  endColumn?: number;
}

export interface CodeMetrics {
  complexity: number;
  maintainability: number;
  security: number;
  performance: number;
  quality: number;
}

export interface OrchestrationRequest {
  task: string;
  maxAgents?: number;
  timeout?: number;
  context?: Record<string, any>;
}

export interface OrchestrationResult {
  taskId: string;
  agents: AgentExecution[];
  synthesisResult: any;
  totalExecutionTime: number;
  status: OrchestrationStatus;
}

export type OrchestrationStatus = 'pending' | 'running' | 'completed' | 'failed';

export interface AgentExecution {
  agentId: string;
  role: string;
  task: string;
  status: 'pending' | 'running' | 'completed' | 'failed';
  result?: any;
  executionTime?: number;
  error?: string;
}

export interface LearningRequest {
  topic: string;
  priority: number; // 1-10
  trigger: LearningTrigger;
  context?: Record<string, any>;
}

export type LearningTrigger =
  | 'user_request'
  | 'code_execution_failure'
  | 'knowledge_gap_detected'
  | 'sandbox_execution';

export interface LearningResult {
  topic: string;
  layers: LearningLayer[];
  status: 'queued' | 'processing' | 'completed';
  completionTime?: number;
}

export interface LearningLayer {
  level: 'OVERVIEW' | 'PROCEDURES' | 'TECHNIQUES' | 'EXPERT';
  content: string;
  sources: string[];
  confidence: number;
}

export interface NexusEpisode {
  id: string;
  content: string;
  type: EpisodeType;
  timestamp: Date;
  metadata?: {
    importance?: number;
    session_id?: string;
    user_id?: string;
    [key: string]: any;
  };
  decay?: number;
}

export type EpisodeType = 'user_query' | 'system_response' | 'event' | 'observation' | 'insight';

export interface NexusHealthStatus {
  healthy: boolean;
  services: {
    graphrag: ServiceHealth;
    mageagent: ServiceHealth;
    learningagent: ServiceHealth;
  };
  timestamp: Date;
}

export interface IngestionJob {
  jobId: string;
  status: 'pending' | 'processing' | 'completed' | 'failed';
  filesDiscovered: number;
  filesProcessed: number;
  totalSize: number;
  progress: number; // 0-100
  startTime: Date;
  endTime?: Date;
  errors?: string[];
}

export interface StreamingProgress {
  type: 'progress' | 'status' | 'agent' | 'file' | 'error' | 'complete';
  message: string;
  progress?: number;
  metadata?: any;
  timestamp: Date;
}

export interface NexusPattern {
  pattern: string;
  context: string;
  confidence: number;
  tags: string[];
  examples?: string[];
  metadata?: Record<string, any>;
  timestamp: Date;
}

export interface RetrievalStrategy {
  type: 'semantic_chunks' | 'graph_traversal' | 'hybrid' | 'adaptive';
  maxResults?: number;
  scoreThreshold?: number;
  rerank?: boolean;
  filters?: Record<string, any>;
}

export interface RetrievalResult {
  documents: NexusDocument[];
  chunks: DocumentChunk[];
  entities?: NexusEntity[];
  totalResults: number;
  executionTime: number;
  strategy: string;
}

export interface NexusOperationQueue {
  operations: QueuedNexusOperation[];
  count: number;
  processing: boolean;
}

export interface QueuedNexusOperation {
  id: string;
  operation: string;
  params: any;
  timestamp: Date;
  retries: number;
  maxRetries: number;
  status: 'queued' | 'processing' | 'completed' | 'failed';
  error?: string;
}
