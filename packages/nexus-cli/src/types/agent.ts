/**
 * Agent Type Definitions
 *
 * Types for autonomous agent mode, ReAct loop, and orchestration
 */

export interface AgentTask {
  task: string;
  maxIterations?: number;
  budget?: number;
  workspace?: string;
  approveCommands?: boolean;
  stream?: boolean;
  context?: Record<string, any>;
}

export interface AgentStatus {
  taskId: string;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';
  currentIteration: number;
  maxIterations: number;
  thoughts: ThoughtEntry[];
  actions: ActionEntry[];
  observations: ObservationEntry[];
  result?: AgentResult;
  error?: string;
  startedAt?: Date;
  completedAt?: Date;
  estimatedCompletion?: Date;
  metadata?: {
    totalCost?: number;
    tokensUsed?: number;
    toolsCalled?: number;
  };
}

export interface AgentResult {
  success: boolean;
  taskId: string;
  summary: string;
  data?: any;
  iterations: number;
  duration: number;
  cost?: number;
  artifacts?: Artifact[];
  learnings?: string[];
}

export interface ReActEvent {
  type: 'thought' | 'action' | 'observation' | 'complete' | 'error' | 'approval-required';
  iteration: number;
  content: string;
  metadata?: any;
  timestamp: Date;
}

export interface ThoughtEntry {
  iteration: number;
  content: string;
  reasoning?: string;
  timestamp: Date;
}

export interface ActionEntry {
  iteration: number;
  action: string;
  tool?: string;
  params?: any;
  requiresApproval?: boolean;
  approved?: boolean;
  timestamp: Date;
}

export interface ObservationEntry {
  iteration: number;
  content: string;
  success: boolean;
  error?: string;
  data?: any;
  timestamp: Date;
}

export interface Artifact {
  type: 'file' | 'code' | 'document' | 'data';
  name: string;
  path?: string;
  content: string;
  metadata?: any;
}

export interface ReActOptions {
  approveCommands?: boolean;
  stream?: boolean;
  onThought?: (thought: ThoughtEntry) => void;
  onAction?: (action: ActionEntry) => Promise<boolean>; // Returns approval
  onObservation?: (observation: ObservationEntry) => void;
  onComplete?: (result: AgentResult) => void;
  onError?: (error: Error) => void;
}

export interface AgentClient {
  submitTask(task: AgentTask): Promise<string>; // Returns task ID
  streamProgress(taskId: string): AsyncIterable<ReActEvent>;
  getStatus(taskId: string): Promise<AgentStatus>;
  cancelTask(taskId: string): Promise<void>;
  listTasks(): Promise<AgentStatus[]>;
}

export interface CommandApproval {
  action: ActionEntry;
  command: string;
  safetyLevel: 'safe' | 'moderate' | 'dangerous';
  reason?: string;
}

export interface ApprovalResult {
  approved: boolean;
  modifiedCommand?: string;
  reason?: string;
}
