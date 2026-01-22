/**
 * Type Definitions for Unified Event Bus
 */

import type { Job, JobOptions } from 'bull';
import type { Socket } from 'socket.io';

/**
 * Event Bus Configuration
 */
export interface EventBusConfig {
  /** Redis connection URL */
  redisUrl?: string;
  /** Enable queue processing */
  enableQueue?: boolean;
  /** Enable WebSocket streaming */
  enableWebSocket?: boolean;
  /** Enable Redis pub/sub */
  enablePubSub?: boolean;
  /** Queue concurrency */
  concurrency?: number;
  /** Default job timeout */
  defaultTimeout?: number;
  /** Maximum job timeout */
  maxTimeout?: number;
  /** Remove completed jobs */
  removeOnComplete?: boolean;
  /** Remove failed jobs */
  removeOnFail?: boolean;
}

/**
 * Queue Configuration
 */
export interface QueueConfig {
  /** Queue name */
  name: string;
  /** Redis URL */
  redisUrl: string;
  /** Concurrency */
  concurrency?: number;
  /** Default job options */
  defaultJobOptions?: JobOptions;
}

/**
 * Job Types
 */
export type JobType =
  | 'memory_storage'
  | 'task_execution'
  | 'agent_orchestration'
  | 'document_ingestion'
  | 'code_validation'
  | 'learning_trigger'
  | 'custom';

/**
 * Job Status
 */
export type JobStatus =
  | 'pending'
  | 'active'
  | 'completed'
  | 'failed'
  | 'delayed'
  | 'waiting';

/**
 * Job Payload
 */
export interface JobPayload {
  type: JobType;
  data: Record<string, any>;
  metadata?: {
    priority?: number;
    timeout?: number;
    retries?: number;
    [key: string]: any;
  };
}

/**
 * Event Types
 */
export type EventType =
  | 'operation:queued'
  | 'operation:started'
  | 'operation:progress'
  | 'operation:completed'
  | 'operation:failed'
  | 'operation:retrying'
  | 'memory:stored'
  | 'memory:retrieved'
  | 'document:stored'
  | 'document:retrieved'
  | 'episode:stored'
  | 'entity:stored'
  | 'pattern:stored'
  | 'task:created'
  | 'task:started'
  | 'task:progress'
  | 'task:completed'
  | 'task:failed'
  | 'agent:spawned'
  | 'agent:completed'
  | 'circuit:open'
  | 'circuit:halfOpen'
  | 'circuit:closed'
  | 'dlq:operation'
  | 'custom';

/**
 * Event Payload
 */
export interface EventPayload {
  type: EventType;
  data: Record<string, any>;
  timestamp: Date;
  source?: string;
  metadata?: Record<string, any>;
}

/**
 * WebSocket Namespace
 */
export type WebSocketNamespace =
  | '/nexus'
  | '/nexus/graphrag'
  | '/nexus/mageagent'
  | '/nexus/geoagent'
  | '/nexus/learning';

/**
 * WebSocket Session
 */
export interface WebSocketSession {
  id: string;
  socket: Socket;
  subscriptions: Set<string>;
  createdAt: Date;
  metadata?: Record<string, any>;
}

/**
 * Pub/Sub Channel
 */
export type PubSubChannel =
  | 'memory-updates'
  | 'document-updates'
  | 'episode-updates'
  | 'task-updates'
  | 'agent-updates'
  | 'system-events'
  | string; // Allow custom channels

/**
 * Pub/Sub Message
 */
export interface PubSubMessage {
  channel: PubSubChannel;
  event: EventType;
  data: Record<string, any>;
  timestamp: Date;
  source?: string;
}

/**
 * Operation Status
 */
export enum OperationStatus {
  PENDING = 'pending',
  IN_PROGRESS = 'in_progress',
  COMPLETED = 'completed',
  FAILED = 'failed',
  CANCELLED = 'cancelled',
  TIMEOUT = 'timeout',
}

/**
 * Operation Type
 */
export enum OperationType {
  VALIDATION = 'validation',
  ANALYSIS = 'analysis',
  LEARNING = 'learning',
  ORCHESTRATION = 'orchestration',
  INGESTION = 'ingestion',
  CONTEXT = 'context',
  SYNTHESIS = 'synthesis',
  MEMORY = 'memory',
  CUSTOM = 'custom',
}

/**
 * Async Operation
 */
export interface AsyncOperation {
  id: string;
  type: OperationType;
  status: OperationStatus;
  createdAt: number;
  updatedAt: number;
  startedAt?: number;
  completedAt?: number;
  estimatedDurationMs?: number;
  result?: any;
  error?: {
    message: string;
    code: string;
    stack?: string;
  };
  progress?: number;
  metadata?: Record<string, any>;
}

/**
 * Operation Statistics
 */
export interface OperationStats {
  total: number;
  byStatus: Record<OperationStatus, number>;
  byType: Record<OperationType, number>;
  averageDurationMs: number;
  successRate: number;
}

/**
 * Queue Statistics
 */
export interface QueueStats {
  waiting: number;
  active: number;
  completed: number;
  failed: number;
  delayed: number;
  totalProcessed: number;
}

/**
 * Event Bus Statistics
 */
export interface EventBusStats {
  queue?: QueueStats;
  operations?: OperationStats;
  websocket?: {
    connections: number;
    namespaces: number;
    subscriptions: number;
  };
  pubsub?: {
    channels: number;
    subscribers: number;
    published: number;
    received: number;
  };
}

/**
 * Health Check Result
 */
export interface HealthCheckResult {
  healthy: boolean;
  latency?: number;
  error?: string;
  details?: Record<string, any>;
}
