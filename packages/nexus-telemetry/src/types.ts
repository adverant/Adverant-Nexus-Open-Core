/**
 * Nexus Telemetry Types
 *
 * Core type definitions for unified orchestration monitoring
 */

/**
 * Phase of a telemetry event
 */
export type EventPhase = 'start' | 'end' | 'error';

/**
 * Orchestration decision types
 */
export type OrchestrationAction = 'passthrough' | 'route' | 'scan' | 'block';

/**
 * Security scan types supported by CyberAgent
 */
export type ScanType = 'malware' | 'exploit' | 'pentest' | 'c2' | 'apt_simulation';

/**
 * Core telemetry event structure
 * Published to Redis Streams by all services
 */
export interface TelemetryEvent {
  // Identity - uniquely identifies this event
  eventId: string;
  correlationId: string;
  spanId?: string;
  parentSpanId?: string;

  // Source - identifies the originating service/instance
  service: string;
  instance: string;

  // Request context - HTTP request details
  method: string;
  path: string;
  statusCode?: number;
  durationMs?: number;

  // Semantic context - business-level operation info
  operation: string;
  resourceType?: string;
  resourceId?: string;

  // User context
  userId?: string;
  orgId?: string;

  // Extensible metadata
  metadata?: Record<string, unknown>;

  // Timing
  timestamp: string;
  phase: EventPhase;
}

/**
 * Partial telemetry event for publishing
 * Required fields are automatically filled by the publisher
 */
export type TelemetryEventInput = Partial<TelemetryEvent> & {
  correlationId?: string;
  method?: string;
  path?: string;
  operation?: string;
  phase?: EventPhase;
};

/**
 * Orchestration decision made by the decision engine
 */
export interface OrchestrationDecision {
  eventId: string;
  correlationId: string;
  decision: OrchestrationAction;
  targetService?: string;
  reason?: string;
  confidence?: number;
  scanType?: ScanType;
  priority?: number;
  timestamp: string;
}

/**
 * Configuration for the telemetry publisher
 */
export interface TelemetryPublisherConfig {
  redisUrl: string;
  serviceName: string;
  instanceId?: string;
  streamKey?: string;
  maxStreamLength?: number;
  enableMetrics?: boolean;
}

/**
 * Configuration for the telemetry consumer
 */
export interface TelemetryConsumerConfig {
  redisUrl: string;
  streamKey?: string;
  consumerGroup?: string;
  consumerName?: string;
  batchSize?: number;
  blockTimeout?: number;
}

/**
 * Decision rule for the orchestration engine
 */
export interface DecisionRule {
  name: string;
  description?: string;
  priority?: number;
  condition: (event: TelemetryEvent) => boolean;
  action: OrchestrationAction;
  scanType?: ScanType;
  scanPriority?: number;
  targetService?: string;
}

/**
 * Metrics exported by telemetry components
 */
export interface TelemetryMetrics {
  eventsPublished: number;
  eventsConsumed: number;
  publishErrors: number;
  consumeErrors: number;
  averageLatencyMs: number;
  streamLag: number;
}

/**
 * Security scan request for CyberAgent
 */
export interface SecurityScanRequest {
  correlationId: string;
  resourceType?: string;
  resourceId?: string;
  scanType: ScanType;
  priority: number;
  target?: string;
  fileUrl?: string;
  config?: Record<string, unknown>;
}

/**
 * Security scan result from CyberAgent
 */
export interface SecurityScanResult {
  jobId: string;
  status: 'queued' | 'running' | 'completed' | 'failed';
  scanType: ScanType;
  correlationId: string;
  threats?: ThreatInfo[];
  completedAt?: string;
}

/**
 * Threat information from security scan
 */
export interface ThreatInfo {
  type: string;
  severity: 'critical' | 'high' | 'medium' | 'low' | 'info';
  description: string;
  indicators?: string[];
  recommendation?: string;
}

/**
 * Express request with telemetry context attached
 */
export interface TelemetryRequest {
  correlationId: string;
  spanId: string;
  telemetryStartTime: number;
}

/**
 * Stream message from Redis
 */
export interface StreamMessage {
  id: string;
  fields: Record<string, string>;
}

/**
 * Consumer group info from Redis
 */
export interface ConsumerGroupInfo {
  name: string;
  consumers: number;
  pending: number;
  lastDeliveredId: string;
}
