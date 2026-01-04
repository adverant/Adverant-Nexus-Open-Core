/**
 * Local Compute Types for nexus-cli
 *
 * Type definitions for local compute agent, jobs, and hardware
 */

/**
 * Hardware information detected on local machine
 */
export interface HardwareInfo {
  platform: string;
  arch: string;
  hostname: string;
  cpu: CPUInfo;
  memory: MemoryInfo;
  gpu: GPUInfo | null;
  frameworks: FrameworkInfo[];
}

export interface CPUInfo {
  model: string;
  cores: number;
  performanceCores?: number;
  efficiencyCores?: number;
  speed?: number;
}

export interface MemoryInfo {
  total: number;
  available: number;
  unified: boolean;
}

export interface GPUInfo {
  type: string;
  memory: number;
  api: string;
  fp32Tflops?: number;
  fp16Tflops?: number;
  computeCapability?: string;
  neuralEngine?: boolean;
  neuralEngineTops?: number;
}

export interface FrameworkInfo {
  name: string;
  version?: string;
  available: boolean;
  gpuSupport: boolean;
}

/**
 * Local compute agent configuration
 */
export interface LocalComputeConfig {
  /** Name for this compute node */
  name: string;
  /** HPC Gateway URL */
  gatewayUrl: string;
  /** Maximum memory percentage to use (0-100) */
  maxMemoryPercent: number;
  /** Whether to accept remote jobs */
  allowRemoteJobs: boolean;
  /** Idle timeout in minutes before auto-shutdown */
  idleTimeoutMinutes: number;
  /** Port for local API server */
  apiPort: number;
  /** WebSocket reconnect interval in ms */
  reconnectInterval: number;
  /** Maximum reconnect attempts */
  maxReconnectAttempts: number;
}

/**
 * Default configuration for local compute agent
 */
export const DEFAULT_COMPUTE_CONFIG: LocalComputeConfig = {
  name: '',
  gatewayUrl: 'https://api.adverant.ai/hpc',
  maxMemoryPercent: 75,
  allowRemoteJobs: false,
  idleTimeoutMinutes: 30,
  apiPort: 9200,
  reconnectInterval: 5000,
  maxReconnectAttempts: 10,
};

/**
 * Agent registration payload sent to HPC Gateway
 */
export interface AgentRegistration {
  type: 'local-compute';
  name: string;
  hostname: string;
  capabilities: {
    gpuType: string;
    gpuMemory: number;
    cpuCores: number;
    ramTotal: number;
    frameworks: string[];
    metalVersion?: number;
    cudaVersion?: string;
    computeCapability?: string;
    neuralEngine?: boolean;
    neuralEngineTops?: number;
  };
  config: {
    maxMemoryPercent: number;
    allowRemoteJobs: boolean;
    idleTimeoutMinutes: number;
  };
}

/**
 * Compute agent status returned from HPC Gateway
 * Note: Named ComputeAgentStatus to avoid conflict with AgentStatus from agent.ts
 */
export interface ComputeAgentStatus {
  id: string;
  name: string;
  status: AgentConnectionStatus;
  registeredAt: Date;
  lastHeartbeat: Date;
  currentJob: LocalComputeJob | null;
  jobsCompleted: number;
  jobsFailed: number;
  totalComputeTime: number;
  hardware: HardwareInfo;
}

/**
 * Local agent runtime status (returned by agent getStatus)
 */
export interface LocalAgentStatus {
  running: boolean;
  pid?: number;
  uptime?: string;
  jobsCompleted: number;
  jobsRunning: number;
}

export type AgentConnectionStatus =
  | 'connected'
  | 'disconnected'
  | 'busy'
  | 'idle'
  | 'error';

/**
 * Local compute job definition
 */
export interface LocalComputeJob {
  id: string;
  name: string;
  script: string;
  scriptPath?: string;
  workingDir: string;
  environment: Record<string, string>;
  resources: JobResources;
  framework: MLFramework;
  status: JobStatus;
  submittedAt: Date;
  startedAt?: Date;
  completedAt?: Date;
  exitCode?: number;
  error?: string;
  logs: string[];
  metrics?: JobMetrics;
}

export interface JobResources {
  gpu: boolean;
  gpuMemoryPercent?: number;
  cpuCores?: number;
  memoryGb?: number;
}

export type MLFramework =
  | 'pytorch'
  | 'tensorflow'
  | 'mlx'
  | 'jax'
  | 'generic';

export type JobStatus =
  | 'queued'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled';

export interface JobMetrics {
  peakMemoryGb: number;
  peakGpuMemoryGb?: number;
  cpuUtilization: number;
  gpuUtilization?: number;
  durationSeconds: number;
}

/**
 * Job submission request
 */
export interface JobSubmitRequest {
  name: string;
  script: string;
  scriptPath?: string;
  workingDir?: string;
  environment?: Record<string, string>;
  resources?: Partial<JobResources>;
  framework?: MLFramework;
  remote?: boolean;
  cluster?: string;
}

/**
 * Events emitted by local compute agent
 */
export interface ComputeEvents {
  connected: { agentId: string };
  disconnected: { reason: string };
  reconnecting: { attempt: number; delay: number };
  error: { code: string; message: string };
  'job:assigned': { job: LocalComputeJob };
  'job:started': { jobId: string };
  'job:progress': { jobId: string; progress: number; message?: string };
  'job:log': { jobId: string; line: string; timestamp: Date };
  'job:completed': { jobId: string; exitCode: number; metrics: JobMetrics };
  'job:failed': { jobId: string; error: string };
  'job:cancelled': { jobId: string };
  heartbeat: { timestamp: Date };
}

/**
 * Local job queue item
 */
export interface QueuedJob {
  job: LocalComputeJob;
  priority: number;
  submittedAt: Date;
}

/**
 * Process info for running job
 */
export interface JobProcess {
  pid: number;
  job: LocalComputeJob;
  startTime: Date;
  logBuffer: string[];
}

/**
 * Jupyter Kernel Types for remote execution
 */

/**
 * Active kernel session
 */
export interface KernelSession {
  id: string;
  language: 'python' | 'r';
  createdAt: Date;
  lastActivity: Date;
  status: KernelStatus;
  executionCount: number;
}

export type KernelStatus = 'idle' | 'busy' | 'starting' | 'dead';

/**
 * Code execution request
 */
export interface ExecuteRequest {
  code: string;
  kernelId?: string;
  silent?: boolean;
  storeHistory?: boolean;
  allowStdin?: boolean;
}

/**
 * Code execution result
 */
export interface ExecuteResult {
  executionCount: number;
  status: 'ok' | 'error' | 'abort';
  outputs: ExecutionOutput[];
  error?: {
    name: string;
    value: string;
    traceback: string[];
  };
  duration: number;
}

/**
 * Output from code execution
 */
export interface ExecutionOutput {
  type: 'stream' | 'execute_result' | 'display_data' | 'error';
  name?: 'stdout' | 'stderr';
  text?: string;
  data?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

/**
 * Kernel events for WebSocket streaming
 */
export interface KernelEvents {
  'kernel:created': { kernelId: string; session: KernelSession };
  'kernel:status': { kernelId: string; status: KernelStatus };
  'kernel:output': { kernelId: string; output: ExecutionOutput };
  'kernel:result': { kernelId: string; result: ExecuteResult };
  'kernel:error': { kernelId: string; error: string };
  'kernel:shutdown': { kernelId: string };
}
