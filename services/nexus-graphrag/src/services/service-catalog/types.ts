/**
 * Service Catalog Types
 *
 * Living Service Knowledge Graph - Entity schemas for storing
 * service metadata, capabilities, and performance metrics in GraphRAG.
 */

/**
 * Service status
 */
export type ServiceStatus = 'active' | 'degraded' | 'offline' | 'deprecated';

/**
 * Protocol types
 */
export type ProtocolType = 'rest' | 'websocket' | 'grpc' | 'graphql';

/**
 * Query types that services can handle
 */
export type QueryType =
  | 'GREETING'
  | 'SIMPLE_QUESTION'
  | 'KNOWLEDGE_QUERY'
  | 'CODE_EXECUTION'
  | 'DOCUMENT_ANALYSIS'
  | 'RESEARCH_TASK'
  | 'VIDEO_ANALYSIS'
  | 'GEOSPATIAL'
  | 'COMPLEX_TASK';

/**
 * Cost tier for capabilities
 */
export type CostTier = 'free' | 'standard' | 'premium';

/**
 * Service endpoints configuration
 */
export interface ServiceEndpoints {
  base: string;
  health: string;
  websocket?: string;
  openapi?: string;
}

/**
 * Kubernetes metadata
 */
export interface KubernetesMetadata {
  namespace: string;
  deployment: string;
  replicas: number;
  serviceName?: string;
}

/**
 * Rate limit configuration
 */
export interface RateLimits {
  requestsPerMinute: number;
  concurrentConnections: number;
  maxPayloadSize?: string;
}

/**
 * Service Entity - Root level entity for a microservice
 */
export interface ServiceEntity {
  id: string;
  domain: 'service_catalog';
  entityType: 'service';
  hierarchyLevel: 0;

  // Natural language description for semantic search
  textContent: string;

  // Structured service metadata
  structuredData: {
    name: string;
    version: string;
    description: string;
    status: ServiceStatus;
    endpoints: ServiceEndpoints;
    capabilities: string[];
    queryTypes: QueryType[];
    protocols: ProtocolType[];
    authRequired: boolean;
    rateLimits?: RateLimits;
    dependencies?: string[];
  };

  // Additional metadata
  metadata: {
    kubernetes?: KubernetesMetadata;
    lastHealthCheck?: string;
    registeredAt: string;
    lastUpdated: string;
    owner?: string;
    tags?: string[];
  };

  // Bi-temporal tracking
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Estimated duration for capability execution
 */
export interface EstimatedDuration {
  minMs: number;
  avgMs: number;
  maxMs: number;
}

/**
 * Capability example with input/output
 */
export interface CapabilityExample {
  description: string;
  input: string;
  output: string;
  latencyMs?: number;
}

/**
 * Capability Entity - Child of Service, represents a specific operation
 */
export interface CapabilityEntity {
  id: string;
  domain: 'service_catalog';
  entityType: 'capability';
  hierarchyLevel: 1;
  parentId: string; // Service entity ID

  // Natural language description for semantic search
  textContent: string;

  // Structured capability metadata
  structuredData: {
    name: string;
    queryPatterns: string[];
    inputTypes: string[];
    outputTypes: string[];
    estimatedDuration: EstimatedDuration;
    endpoint: string;
    method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';
    costTier: CostTier;
    examples?: CapabilityExample[];
    requestSchema?: Record<string, unknown>;
    responseSchema?: Record<string, unknown>;
  };

  // Metadata
  metadata: {
    createdAt: string;
    lastUpdated: string;
    usageCount?: number;
    successRate?: number;
  };

  createdAt: Date;
  updatedAt: Date;
}

/**
 * Performance metrics for a time period
 */
export interface PerformanceMetrics {
  requests: number;
  successes: number;
  failures: number;
  avgLatencyMs: number;
  p50LatencyMs: number;
  p95LatencyMs: number;
  p99LatencyMs: number;
  errorRate: number;
  throughput: number;
}

/**
 * Metrics by operation breakdown
 */
export interface OperationMetrics {
  [operation: string]: {
    requests: number;
    avgLatencyMs: number;
    errorRate: number;
  };
}

/**
 * Performance Metric Entity - Child of Service, time-series metrics
 */
export interface PerformanceMetricEntity {
  id: string;
  domain: 'service_catalog';
  entityType: 'metric';
  hierarchyLevel: 1;
  parentId: string; // Service entity ID

  structuredData: {
    period: 'hourly' | 'daily' | 'weekly';
    timestamp: string;
    metrics: PerformanceMetrics;
    byOperation?: OperationMetrics;
  };

  createdAt: Date;
  updatedAt: Date;
}

/**
 * Service score components
 */
export interface ServiceScore {
  healthScore: number;
  latencyScore: number;
  reliabilityScore: number;
  throughputScore: number;
  recencyScore: number;
  satisfactionScore: number;
  compositeScore: number;
}

/**
 * Capability match result
 */
export interface CapabilityMatch {
  serviceId: string;
  serviceName: string;
  capabilityId: string;
  capabilityName: string;
  confidence: number;
  score: ServiceScore;
  endpoint: string;
  method: string;
  estimatedDuration: EstimatedDuration;
}

/**
 * Service registration request
 */
export interface ServiceRegistrationRequest {
  name: string;
  version: string;
  description: string;
  endpoints: ServiceEndpoints;
  capabilities: Array<{
    name: string;
    description: string;
    queryPatterns: string[];
    inputTypes: string[];
    outputTypes: string[];
    endpoint: string;
    method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';
    costTier?: CostTier;
    estimatedDuration?: EstimatedDuration;
    examples?: CapabilityExample[];
  }>;
  protocols?: ProtocolType[];
  authRequired?: boolean;
  rateLimits?: RateLimits;
  dependencies?: string[];
  kubernetes?: KubernetesMetadata;
  tags?: string[];
}

/**
 * Service query request
 */
export interface ServiceQueryRequest {
  query: string;
  requiredCapabilities?: string[];
  excludeServices?: string[];
  queryTypes?: QueryType[];
  limit?: number;
  includeMetrics?: boolean;
}

/**
 * Service query response
 */
export interface ServiceQueryResponse {
  query: string;
  matchedCapabilities: CapabilityMatch[];
  recommendedService: string | null;
  alternativeServices: string[];
  reasoning: string;
}

/**
 * Interaction recording for performance learning
 */
export interface InteractionRecord {
  serviceId: string;
  serviceName: string;
  capabilityName: string;
  success: boolean;
  latencyMs: number;
  userId?: string;
  sessionId?: string;
  timestamp: string;
  errorMessage?: string;
}

/**
 * Health check result
 */
export interface HealthCheckResult {
  healthy: boolean;
  status: ServiceStatus;
  latencyMs: number;
  serviceId?: string;
  serviceName?: string;
  timestamp?: string;
  details?: Record<string, unknown>;
}

/**
 * Service discovery result from K8s
 */
export interface DiscoveredService {
  name: string;
  namespace: string;
  endpoint: string;
  port: number;
  labels: Record<string, string>;
  annotations: Record<string, string>;
}

/**
 * Weights for service scoring
 */
export interface ScoringWeights {
  health: number;
  latency: number;
  reliability: number;
  throughput: number;
  recency: number;
  satisfaction: number;
}

/**
 * Default scoring weights
 */
export const DEFAULT_SCORING_WEIGHTS: ScoringWeights = {
  health: 0.20,
  latency: 0.25,
  reliability: 0.25,
  throughput: 0.10,
  recency: 0.10,
  satisfaction: 0.10,
};

/**
 * Known service definition for discovery agent
 */
export interface KnownServiceDefinition {
  name: string;
  version: string;
  description: string;
  baseUrl: string;
  healthEndpoint: string;
  websocketEndpoint?: string;
  protocols: ProtocolType[];
  authRequired: boolean;
  rateLimits?: RateLimits;
  dependencies?: string[];
  capabilities: Array<{
    name: string;
    description: string;
    queryPatterns: string[];
    inputTypes: string[];
    outputTypes: string[];
    endpoint: string;
    method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH' | 'WEBSOCKET';
    costTier: CostTier;
    estimatedDuration: EstimatedDuration;
    examples?: CapabilityExample[];
  }>;
  tags: string[];
}
