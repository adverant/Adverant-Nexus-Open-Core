/**
 * @nexus/voyage-ai-client
 *
 * Shared VoyageAI embedding client with:
 * - Dynamic model discovery
 * - Circuit breaker protection
 * - Multimodal support
 * - Content type detection
 * - Automatic endpoint routing
 * - Comprehensive validation
 * - Batch operations
 * - Reranking support
 *
 * This is the standard embedding client for all Unified Nexus services.
 */

// Main client
export { VoyageAIUnifiedClient, VoyageAIClient } from './VoyageAIUnifiedClient';

// Model discovery
export {
  VoyageModelDiscovery,
  type VoyageModelInfo,
  type ModelDiscoveryCache
} from './voyage-model-discovery';

// Circuit breaker
export {
  CircuitBreaker,
  CircuitBreakerOpenError,
  CircuitState,
  createVoyageCircuitBreaker,
  type CircuitBreakerConfig
} from './utils/circuit-breaker';

// Logger
export {
  logger,
  configureLogger,
  createChildLogger
} from './utils/logger';

// Types
export type {
  EmbeddingOptions,
  EmbeddingResult,
  RerankResult
} from './VoyageAIUnifiedClient';
