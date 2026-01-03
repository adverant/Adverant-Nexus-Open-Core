/**
 * @adverant/nexus-telemetry
 *
 * Unified telemetry and orchestration monitoring for Nexus stack
 *
 * Features:
 * - Redis Streams-based telemetry event publishing
 * - Express middleware for automatic request telemetry
 * - Consumer for orchestration decision-making
 * - Prometheus metrics integration
 * - UUIDv7 correlation IDs for distributed tracing
 *
 * Usage:
 * ```typescript
 * import {
 *   TelemetryPublisher,
 *   createTelemetryMiddleware,
 *   TelemetryConsumer
 * } from '@adverant/nexus-telemetry';
 *
 * // In your Express service
 * const publisher = new TelemetryPublisher({
 *   redisUrl: 'redis://localhost:6379',
 *   serviceName: 'nexus-fileprocess'
 * });
 * app.use(createTelemetryMiddleware(publisher));
 *
 * // In your orchestrator
 * const consumer = new TelemetryConsumer({
 *   redisUrl: 'redis://localhost:6379'
 * });
 * await consumer.start(async (event) => {
 *   // Handle telemetry events, make routing decisions
 *   console.log('Received:', event);
 * });
 * ```
 */

// Types
export * from './types';

// File Processing Events (Sandbox-First UOM)
export * from './file-processing-events';

// Publisher
export {
  TelemetryPublisher,
  createTelemetryPublisher
} from './publisher';

// Consumer
export {
  TelemetryConsumer,
  createTelemetryConsumer,
  type EventHandler
} from './consumer';

// Middleware
export {
  createTelemetryMiddleware,
  getTelemetryContext,
  createChildSpan,
  endChildSpan,
  type TelemetryMiddlewareOptions
} from './middleware';

// Stream key constants
export const STREAM_KEYS = {
  TELEMETRY: 'nexus:telemetry:events',
  DECISIONS: 'nexus:orchestration:decisions',
  SECURITY_SCANS: 'nexus:security:scans',
  // Sandbox-First UOM streams
  FILE_EVENTS: 'nexus:file:events',
  UOM_DECISIONS: 'nexus:uom:decisions',
  DECISION_OUTCOMES: 'nexus:uom:outcomes',
  REVIEW_QUEUE: 'nexus:file:review'
} as const;

// Consumer group constants
export const CONSUMER_GROUPS = {
  ORCHESTRATOR: 'orchestrator',
  ANALYTICS: 'analytics',
  AUDIT: 'audit',
  // Sandbox-First UOM consumer groups
  FILE_ORCHESTRATOR: 'file_orchestrator',
  PATTERN_LEARNING: 'pattern_learning',
  SECURITY_MONITOR: 'security_monitor',
  FILE_AUDIT: 'file_audit'
} as const;
