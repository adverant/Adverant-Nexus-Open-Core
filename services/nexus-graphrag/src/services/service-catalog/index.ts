/**
 * Service Catalog Module
 *
 * Living Service Knowledge Graph - Dynamic service discovery
 * and intelligent routing for the Manus.ai replica.
 */

// Types
export * from './types.js';

// Repository
export {
  ServiceCatalogRepository,
  getServiceCatalogRepository,
} from './service-catalog-repository.js';

// Capability Matcher
export {
  CapabilityMatcher,
  createCapabilityMatcher,
} from './capability-matcher.js';

// Performance Scorer
export {
  PerformanceScorer,
  createPerformanceScorer,
} from './performance-scorer.js';

// Discovery Agent
export {
  ServiceDiscoveryAgent,
  createDiscoveryAgent,
  type DiscoveryAgentConfig,
} from './discovery-agent.js';
