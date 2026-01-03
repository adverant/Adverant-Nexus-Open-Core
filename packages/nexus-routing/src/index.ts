/**
 * Nexus Routing Package
 *
 * Shared routing, health checking, and client logic for:
 * - Nexus MCP Server (stdio/MCP protocol)
 * - Nexus API Gateway (HTTP/WebSocket)
 *
 * Provides intelligent routing to GraphRAG and MageAgent backends
 * with automatic health monitoring and failover.
 */

// Export routing
export {
  SmartRouter,
  smartRouter,
  RouteDecision,
  type RequestContext
} from './routing/smart-router.js';

export {
  HealthChecker,
  healthChecker,
  ServiceHealth,
  HealthStatus as ServiceHealthStatus
} from './routing/health-checker.js';

// Export clients V1 (legacy - for backward compatibility)
export {
  GraphRAGClient,
  graphragClient
} from './clients/graphrag-client.js';

export {
  MageAgentClient,
  mageagentClient
} from './clients/mageagent-client.js';

// Export clients V2 (new - with connection pool, circuit breaker, service discovery)
export {
  GraphRAGClientV2,
  graphragClientV2
} from './clients/graphrag-client-v2.js';

export {
  MageAgentClientV2,
  mageagentClientV2
} from './clients/mageagent-client-v2.js';

export {
  SandboxClientV2,
  sandboxClientV2,
  type SandboxExecutionRequest,
  type SandboxExecutionResult,
  type SandboxTemplate,
  type ExecutionType,
  type ExecutionStatus,
  type ExecutionEngine
} from './clients/sandbox-client-v2.js';

export {
  APIGatewayClient,
  apiGatewayClient,
  createAPIGatewayClient
} from './clients/api-gateway-client.js';

// Export utilities
export {
  logger
} from './utils/logger.js';

export {
  NexusRoutingError,
  ServiceUnavailableError,
  RoutingError,
  ToolExecutionError,
  formatError,
  handleError,
  withErrorHandling
} from './utils/error-handler.js';

export {
  ServiceDiscovery,
  serviceDiscovery,
  ServiceEndpoint
} from './utils/service-discovery.js';

export {
  CircuitBreaker,
  CircuitBreakerManager,
  circuitBreakerManager,
  CircuitState,
  CircuitBreakerError
} from './utils/circuit-breaker.js';

export {
  SmartConnectionPool,
  TimeoutError,
  HttpError
} from './utils/connection-pool.js';

// Export configuration
export {
  config,
  TOOL_TIMEOUTS,
  ENDPOINT_FALLBACK
} from './config.js';

// Export context management (Phase 1-4)
export {
  ContextManager,
  createContextManager,
  type SessionContext,
  type ConversationEvent,
  type StorageOptions,
  type CheckpointOptions
} from './utils/context-manager.js';

export {
  ConversationHooks,
  createConversationHooks,
  installHooks,
  type HookContext,
  type UserPromptEvent,
  type ToolUseEvent,
  type SessionEvent
} from './hooks/conversation-hooks.js';

export {
  ContextInjector,
  createContextInjector,
  preToolUseHook,
  type InjectionRequest,
  type InjectionResult,
  type RelevantContext,
  type SuggestionRequest
} from './injection/context-injector.js';

export {
  ContextMonitor,
  getContextMonitor,
  type ContextMetrics,
  type StorageMetrics,
  type PerformanceMetrics,
  type HealthStatus,
  type HealthCheck,
  type AdaptiveConfig
} from './monitoring/context-monitor.js';

/**
 * Re-export shared foundation packages
 *
 * These packages provide standardized implementations across the Nexus stack:
 * - @adverant/logger: Enhanced structured logging with correlation ID support
 * - @adverant/errors: Unified error hierarchy with rich context
 * - @adverant/config: Configuration management with schema validation and secrets
 * - @adverant/resilience: Circuit breaker, retry, timeout, and bulkhead patterns
 * - @adverant/cache: Redis-backed distributed caching for query results
 * - @adverant/database: Unified database connection management (PostgreSQL, Redis, Neo4j, Qdrant)
 * - @adverant/event-bus: Event-driven architecture with message bus
 *
 * For new code, prefer these implementations over the legacy utilities above.
 * Legacy exports (logger, CircuitBreaker, etc.) are maintained for backward compatibility.
 */
export * as Logger from '@adverant/logger';
export * as Errors from '@adverant/errors';
export * as Config from '@adverant/config';
export * as Resilience from '@adverant/resilience';
export * as Cache from '@adverant/cache';
export * as Database from '@adverant/database';
export * as EventBus from '@adverant/event-bus';
