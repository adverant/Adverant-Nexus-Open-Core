/**
 * Workflow Types for Universal Request Orchestrator
 *
 * These types define the structure for multi-service workflow orchestration,
 * enabling natural language requests to be decomposed and executed across
 * MageAgent, CyberAgent, FileProcessAgent, and Sandbox services.
 *
 * Design Principles:
 * - Service agnostic: Works with any Nexus service
 * - Dependency aware: Supports parallel and sequential execution
 * - Failure tolerant: Tracks partial failures and degraded results
 */

/**
 * Available services in the Nexus ecosystem
 */
export type WorkflowServiceType =
  | 'fileprocess'  // Document processing, archive extraction, OCR
  | 'cyberagent'   // Security scanning, malware detection, threat analysis
  | 'sandbox'      // Code execution, file analysis
  | 'mageagent'    // AI analysis, synthesis, collaboration
  | 'graphrag';    // Knowledge storage and retrieval

/**
 * Status of a workflow step
 */
export type WorkflowStepStatus =
  | 'pending'      // Waiting for dependencies
  | 'ready'        // Dependencies satisfied, ready to execute
  | 'running'      // Currently executing
  | 'completed'    // Successfully finished
  | 'failed'       // Execution failed
  | 'skipped';     // Skipped due to dependency failure

/**
 * Priority levels for workflow execution
 */
export type WorkflowPriority = 'low' | 'normal' | 'high' | 'critical';

/**
 * Execution mode for workflows
 */
export type WorkflowMode =
  | 'strict'       // Fail entire workflow on any step failure
  | 'best-effort'; // Continue with partial results on failure

/**
 * Individual step in a workflow
 */
export interface WorkflowStep {
  /** Unique identifier for this step */
  id: string;

  /** Human-readable name for the step */
  name: string;

  /** Target service to execute this step */
  service: WorkflowServiceType;

  /** Service-specific operation to perform */
  operation: string;

  /** Input parameters for the operation */
  input: Record<string, unknown>;

  /** IDs of steps this step depends on (must complete first) */
  dependsOn?: string[];

  /** Timeout in milliseconds for this step */
  timeout?: number;

  /** Maximum retry attempts on failure */
  maxRetries?: number;

  /** Current status of this step */
  status?: WorkflowStepStatus;

  /** Result of this step (populated after execution) */
  result?: WorkflowStepResult;

  /** Error information if step failed */
  error?: WorkflowStepError;

  /** Timestamps for tracking */
  startedAt?: Date;
  completedAt?: Date;
}

/**
 * Result of a workflow step
 */
export interface WorkflowStepResult {
  /** Whether the step succeeded */
  success: boolean;

  /** Data returned by the operation */
  data: unknown;

  /** Artifacts produced by the step */
  artifacts?: WorkflowArtifact[];

  /** Execution metrics */
  metrics: {
    durationMs: number;
    tokensUsed?: number;
    resourceUsage?: Record<string, number>;
  };
}

/**
 * Error information for a failed step
 */
export interface WorkflowStepError {
  /** Error code for categorization */
  code: string;

  /** Human-readable error message */
  message: string;

  /** Whether the error is recoverable */
  recoverable: boolean;

  /** Suggested recovery action */
  suggestedAction?: string;

  /** Additional error context */
  context?: Record<string, unknown>;
}

/**
 * Artifact produced by a workflow step
 */
export interface WorkflowArtifact {
  /** Unique identifier */
  id: string;

  /** Type of artifact */
  type: string;

  /** Source step that produced this artifact */
  sourceStepId: string;

  /** URL to access the artifact (if stored) */
  url?: string;

  /** Inline content (for small artifacts) */
  content?: string;

  /** Size in bytes */
  size?: number;

  /** MIME type */
  mimeType?: string;
}

/**
 * Complete workflow plan
 */
export interface WorkflowPlan {
  /** Unique identifier for the workflow */
  id: string;

  /** Correlation ID for tracking across services */
  correlationId: string;

  /** Original natural language request */
  originalRequest: string;

  /** All steps in the workflow */
  steps: WorkflowStep[];

  /** Groups of step IDs that can execute in parallel */
  parallelGroups: string[][];

  /** Overall workflow status */
  status: 'planning' | 'executing' | 'completed' | 'failed' | 'degraded';

  /** Execution mode */
  mode: WorkflowMode;

  /** Priority level */
  priority: WorkflowPriority;

  /** Overall timeout for the workflow */
  timeout: number;

  /** Timestamps */
  createdAt: Date;
  startedAt?: Date;
  completedAt?: Date;

  /** Multi-tenant context */
  tenantContext?: {
    companyId?: string;
    appId?: string;
    userId?: string;
    sessionId?: string;
  };
}

/**
 * Result of workflow execution
 */
export interface WorkflowResult {
  /** Whether the workflow succeeded */
  success: boolean;

  /** Overall status */
  status: 'completed' | 'failed' | 'degraded';

  /** Human-readable summary of the workflow execution */
  summary: string;

  /** Results from all steps */
  stepResults: Map<string, WorkflowStepResult>;

  /** Information about failed steps */
  failedSteps: Array<{
    stepId: string;
    stepName: string;
    error: WorkflowStepError;
    impact: string;
  }>;

  /** All artifacts produced by the workflow */
  artifacts: WorkflowArtifact[];

  /** Execution metrics */
  metrics: {
    totalDurationMs: number;
    stepCount: number;
    successCount: number;
    failedCount: number;
    skippedCount: number;
    parallelizationEfficiency: number; // 0-1
  };

  /** Suggestions for improving results (on partial failure) */
  suggestions?: string[];
}

/**
 * Request to parse a natural language workflow request
 */
export interface WorkflowParseRequest {
  /** Natural language request */
  request: string;

  /** Context from previous requests */
  context?: {
    previousRequestId?: string;
    sessionId?: string;
    metadata?: Record<string, unknown>;
  };

  /** Execution options */
  options?: {
    mode?: WorkflowMode;
    priority?: WorkflowPriority;
    timeout?: number;
    stream?: boolean;
  };
}

/**
 * Response from workflow parsing
 */
export interface WorkflowParseResponse {
  /** Generated workflow plan */
  plan: WorkflowPlan;

  /** Confidence in the parsing (0-1) */
  confidence: number;

  /** Clarification questions if confidence is low */
  clarifications?: string[];

  /** Estimated duration for the workflow */
  estimatedDurationMs: number;

  /** Services that will be involved */
  involvedServices: WorkflowServiceType[];
}

/**
 * Progress event for workflow streaming
 */
export interface WorkflowProgressEvent {
  /** Event type */
  type: 'step_started' | 'step_progress' | 'step_completed' | 'step_failed' | 'workflow_completed';

  /** Timestamp */
  timestamp: Date;

  /** Workflow ID */
  workflowId: string;

  /** Step ID (if applicable) */
  stepId?: string;

  /** Progress percentage (0-100) */
  progress: number;

  /** Human-readable message */
  message: string;

  /** Additional data */
  data?: Record<string, unknown>;
}

/**
 * Mapping of operations to their target services
 */
export const OPERATION_SERVICE_MAP: Record<string, WorkflowServiceType> = {
  // FileProcess operations
  file_download: 'fileprocess',
  file_upload: 'fileprocess',
  file_extraction: 'fileprocess',
  table_extraction: 'fileprocess',
  ocr: 'fileprocess',
  archive_extract: 'fileprocess',
  document_parse: 'fileprocess',

  // CyberAgent operations
  malware_scan: 'cyberagent',
  virus_check: 'cyberagent',
  threat_analysis: 'cyberagent',
  vulnerability_scan: 'cyberagent',
  security_assessment: 'cyberagent',
  ioc_extraction: 'cyberagent',

  // Sandbox operations
  code_execute: 'sandbox',
  script_run: 'sandbox',
  file_analyze: 'sandbox',

  // MageAgent operations
  ai_analysis: 'mageagent',
  pii_detection: 'mageagent',
  summarization: 'mageagent',
  synthesis: 'mageagent',
  collaboration: 'mageagent',
  competition: 'mageagent',

  // GraphRAG operations
  knowledge_store: 'graphrag',
  knowledge_recall: 'graphrag',
  document_store: 'graphrag',
  entity_query: 'graphrag',
};

/**
 * Default timeouts per service (milliseconds)
 */
export const SERVICE_TIMEOUTS: Record<WorkflowServiceType, number> = {
  fileprocess: 300000,  // 5 minutes - file processing can be slow
  cyberagent: 180000,   // 3 minutes - security scans
  sandbox: 300000,      // 5 minutes - code execution
  mageagent: 120000,    // 2 minutes - AI analysis
  graphrag: 30000,      // 30 seconds - knowledge operations
};

/**
 * Helper to determine service for an operation
 */
export function getServiceForOperation(operation: string): WorkflowServiceType | undefined {
  return OPERATION_SERVICE_MAP[operation];
}

/**
 * Helper to get default timeout for a service
 */
export function getDefaultTimeout(service: WorkflowServiceType): number {
  return SERVICE_TIMEOUTS[service];
}
