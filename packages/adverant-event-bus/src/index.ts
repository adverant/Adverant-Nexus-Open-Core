/**
 * @adverant/event-bus
 *
 * Unified Event Bus for Nexus Stack
 *
 * Consolidates all event infrastructure across services:
 * - Bull queue for async job processing
 * - Typed EventEmitter for local events
 * - Socket.IO for WebSocket streaming
 * - Redis pub/sub for inter-service communication
 * - Async operation tracking
 *
 * Features:
 * - Unified API for all event patterns
 * - Type-safe event and job types
 * - Health monitoring and statistics
 * - Graceful shutdown and cleanup
 *
 * Part of Phase 2.3: Event Bus Consolidation
 */

// Main manager
export { EventBusManager } from './event-bus-manager.js';

// Type exports
export type {
  EventBusConfig,
  QueueConfig,
  JobType,
  JobStatus,
  JobPayload,
  EventType,
  EventPayload,
  WebSocketNamespace,
  WebSocketSession,
  PubSubChannel,
  PubSubMessage,
  AsyncOperation,
  OperationStats,
  QueueStats,
  EventBusStats,
  HealthCheckResult,
} from './types.js';

// Enum exports
export { OperationStatus, OperationType } from './types.js';
