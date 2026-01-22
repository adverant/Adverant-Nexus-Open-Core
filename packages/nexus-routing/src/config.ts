/**
 * Configuration for Nexus Routing Package
 * Centralizes all environment-based configuration
 */

import dotenv from 'dotenv';
import { logger } from './utils/logger.js';

// Load environment variables
dotenv.config();

/**
 * Tool-specific timeout configuration (milliseconds)
 */
export const TOOL_TIMEOUTS: Record<string, number> = {
  // Fast operations (5s)
  'nexus_store_memory': 5000,
  'nexus_list_memories': 5000,
  'nexus_list_documents': 5000,
  'nexus_store_episode': 5000,
  'nexus_list_agents': 5000,
  'nexus_websocket_stats': 5000,
  'nexus_model_stats': 5000,
  'nexus_health': 5000,
  'nexus_get_stats': 5000,

  // Medium operations (15s)
  'nexus_recall_memory': 15000,
  'nexus_store_document': 120000,  // Increased to 120s for large documents (35k+ words, PDFs, DOCX)
  'nexus_get_document': 15000,
  'nexus_recall_episodes': 15000,
  'nexus_retrieve': 15000,
  'nexus_enhanced_retrieve': 15000,
  'nexus_search': 15000,
  'nexus_store_entity': 15000,
  'nexus_query_entities': 15000,
  'nexus_update_entity': 15000,
  'nexus_get_entity': 15000,
  'nexus_get_entity_history': 15000,
  'nexus_get_entity_hierarchy': 15000,
  'nexus_get_facts': 15000,
  'nexus_create_entity_relationship': 15000,
  'nexus_bulk_create_entities': 15000,
  'nexus_cross_domain_query': 15000,
  'nexus_memory_search': 15000,
  'nexus_store_pattern': 15000,
  'nexus_task_status': 15000,
  'nexus_agent_details': 15000,
  'nexus_model_select': 15000,

  // Long operations (120s)
  'nexus_orchestrate': 120000,
  'nexus_agent_competition': 120000,
  'nexus_agent_collaborate': 120000,
  'nexus_analyze': 120000,
  'nexus_synthesize': 60000,
  'nexus_trigger_learning': 120000,
  'nexus_recall_learned_knowledge': 30000,

  // Ingestion operations (variable duration)
  'nexus_ingest_url': 180000,  // 3 minutes for large files/folders
  'nexus_validate_url': 10000,
  'nexus_ingest_url_confirm': 180000,
  'nexus_check_ingestion_job': 5000,

  // Sandbox operations
  'nexus_sandbox_execute': 60000,

  // Context operations
  'nexus_inject_context': 10000,
  'nexus_get_suggestions': 15000,

  // Validation operations (async, but initial response is fast)
  'nexus_validate_code': 5000,  // Returns validation ID quickly
  'nexus_validate_command': 5000,
  'nexus_analyze_code': 5000,
  'nexus_validation_result': 5000,

  // Special operations
  'nexus_clear_data': 30000,

  // Google Geospatial AI operations (Phase 5)
  'nexus_google_earth_engine_analyze': 60000,  // Earth Engine analysis can take up to 60s
  'nexus_google_earth_engine_time_series': 90000,  // Time series can take longer
  'nexus_google_vertex_ai_predict': 120000,  // AI inference can take up to 2 minutes
  'nexus_google_bigquery_spatial_query': 60000,  // BigQuery queries typically < 60s
  'nexus_google_bigquery_spatial_join': 120000  // Large spatial joins can take longer
};

/**
 * Endpoint fallback chains for service discovery
 * Ordered by likelihood: container name → Docker Desktop → host → legacy
 */
export const ENDPOINT_FALLBACK = {
  graphrag: [
    'http://nexus-graphrag:8090', // Full container name (most common in production)
    'http://host.docker.internal:9090',  // Docker Desktop host access
    'http://localhost:9090',              // Direct host network (dev)
    'http://127.0.0.1:9090',             // Explicit localhost (dev)
    'http://graphrag:8090'               // Short name (legacy, may not resolve)
  ],
  mageagent: [
    'http://nexus-mageagent:8080', // Full container name (most common in production)
    'http://host.docker.internal:9080',   // Docker Desktop host access
    'http://localhost:9080',               // Direct host network (dev)
    'http://127.0.0.1:9080',              // Explicit localhost (dev)
    'http://mageagent:8080'                // Short name (legacy, may not resolve)
  ],
  apiGateway: [
    'http://nexus-api-gateway:8092', // Full container name (most common in production)
    'http://host.docker.internal:9092',      // Docker Desktop host access
    'http://localhost:9092',                  // Direct host network (dev)
    'http://127.0.0.1:9092',                 // Explicit localhost (dev)
    'http://api-gateway:8092'                 // Short name (legacy, may not resolve)
  ],
  videoagent: [
    'http://nexus-videoagent:9095', // Full container name (most common in production)
    'http://host.docker.internal:9095',      // Docker Desktop host access
    'http://localhost:9095',                  // Direct host network (dev)
    'http://127.0.0.1:9095',                 // Explicit localhost (dev)
    'http://videoagent:9095'                  // Short name (legacy, may not resolve)
  ],
  fileprocess: [
    'http://nexus-fileprocess-agent:9096', // Full container name (most common in production)
    'http://host.docker.internal:9096',             // Docker Desktop host access
    'http://localhost:9096',                        // Direct host network (dev)
    'http://127.0.0.1:9096',                       // Explicit localhost (dev)
    'http://fileprocess-agent:9096'                 // Short name (legacy, may not resolve)
  ]
};

/**
 * Nexus Routing Configuration
 */
export const config = {
  // GraphRAG Service Configuration
  graphrag: {
    // Support both singular (GRAPHRAG_ENDPOINT) and plural (GRAPHRAG_ENDPOINTS) env vars
    // Singular takes precedence for docker-compose compatibility
    // Remove any trailing slashes or /api suffix
    endpoints: process.env.GRAPHRAG_ENDPOINT
      ? [process.env.GRAPHRAG_ENDPOINT.replace(/\/+$/, '').replace(/\/api$/, '')]
      : (process.env.GRAPHRAG_ENDPOINTS?.split(',').map(e => e.trim().replace(/\/+$/, '').replace(/\/api$/, '')) || ENDPOINT_FALLBACK.graphrag),
    defaultTimeout: parseInt(process.env.GRAPHRAG_TIMEOUT_MS || '30000', 10),
    apiKey: process.env.GRAPHRAG_API_KEY || '',
    healthPath: '/health',
    healthTimeout: 5000
  },

  // MageAgent Service Configuration
  mageagent: {
    // Support both singular (MAGEAGENT_ENDPOINT) and plural (MAGEAGENT_ENDPOINTS) env vars
    // Singular takes precedence for docker-compose compatibility
    // Remove any trailing slashes or /api suffix to prevent double /api/api paths
    endpoints: process.env.MAGEAGENT_ENDPOINT
      ? [process.env.MAGEAGENT_ENDPOINT.replace(/\/+$/, '').replace(/\/api$/, '')]
      : (process.env.MAGEAGENT_ENDPOINTS?.split(',').map(e => e.trim().replace(/\/+$/, '').replace(/\/api$/, '')) || ENDPOINT_FALLBACK.mageagent),
    defaultTimeout: parseInt(process.env.MAGEAGENT_TIMEOUT_MS || '60000', 10),
    apiKey: process.env.MAGEAGENT_API_KEY || '',
    healthPath: '/api/health',
    healthTimeout: 5000
  },

  // API Gateway Service Configuration
  apiGateway: {
    // Support both singular (API_GATEWAY_ENDPOINT) and plural (API_GATEWAY_ENDPOINTS) env vars
    // Remove any trailing slashes or /api suffix
    endpoints: process.env.API_GATEWAY_ENDPOINT
      ? [process.env.API_GATEWAY_ENDPOINT.replace(/\/+$/, '').replace(/\/api$/, '')]
      : (process.env.API_GATEWAY_ENDPOINTS?.split(',').map(e => e.trim().replace(/\/+$/, '').replace(/\/api$/, '')) || ENDPOINT_FALLBACK.apiGateway),
    defaultTimeout: parseInt(process.env.API_GATEWAY_TIMEOUT || '60000', 10),
    apiKey: process.env.API_GATEWAY_API_KEY || '',
    healthPath: '/health',
    healthTimeout: 5000
  },

  // Sandbox Service Configuration
  sandbox: {
    endpoints: process.env.SANDBOX_ENDPOINT
      ? [process.env.SANDBOX_ENDPOINT.replace(/\/+$/, '')]
      : [
          'http://localhost:9095',
          'http://127.0.0.1:9095',
          'http://host.docker.internal:9095',
          'http://nexus-sandbox:9092'
        ],
    defaultTimeout: parseInt(process.env.SANDBOX_TIMEOUT || '60000', 10),
    timeout: parseInt(process.env.SANDBOX_TIMEOUT || '60000', 10),
    apiKey: process.env.SANDBOX_API_KEY || '',
    healthPath: '/health',
    healthTimeout: 5000
  },

  // LearningAgent Service Configuration
  learningAgent: {
    endpoints: process.env.LEARNING_AGENT_URL
      ? [process.env.LEARNING_AGENT_URL.replace(/\/+$/, '')]
      : [
          'http://localhost:9091',
          'http://127.0.0.1:9091',
          'http://host.docker.internal:9091',
          'http://nexus-learningagent:9091'
        ],
    defaultTimeout: parseInt(process.env.LEARNING_AGENT_TIMEOUT || '120000', 10),
    apiKey: process.env.LEARNING_AGENT_API_KEY || '',
    healthPath: '/health',
    healthTimeout: 5000
  },

  // VideoAgent Service Configuration
  videoagent: {
    endpoints: process.env.VIDEOAGENT_ENDPOINT
      ? [process.env.VIDEOAGENT_ENDPOINT.replace(/\/+$/, '')]
      : (process.env.VIDEOAGENT_ENDPOINTS?.split(',').map(e => e.trim().replace(/\/+$/, '')) || ENDPOINT_FALLBACK.videoagent),
    defaultTimeout: parseInt(process.env.VIDEOAGENT_TIMEOUT || '300000', 10), // 5 minutes for video processing
    apiKey: process.env.VIDEOAGENT_API_KEY || '',
    healthPath: '/health',
    healthTimeout: 5000
  },

  // FileProcessAgent Service Configuration
  fileprocess: {
    endpoints: process.env.FILEPROCESS_ENDPOINT
      ? [process.env.FILEPROCESS_ENDPOINT.replace(/\/+$/, '')]
      : (process.env.FILEPROCESS_ENDPOINTS?.split(',').map(e => e.trim().replace(/\/+$/, '')) || ENDPOINT_FALLBACK.fileprocess),
    defaultTimeout: parseInt(process.env.FILEPROCESS_TIMEOUT || '60000', 10), // 1 minute for document processing
    apiKey: process.env.FILEPROCESS_API_KEY || '',
    healthPath: '/health',
    healthTimeout: 5000
  },

  // Connection Pool Configuration
  connectionPool: {
    maxSockets: parseInt(process.env.MAX_SOCKETS || '10', 10),
    maxFreeSockets: parseInt(process.env.MAX_FREE_SOCKETS || '5', 10),
    keepAlive: process.env.KEEP_ALIVE !== 'false',
    keepAliveMsecs: parseInt(process.env.KEEP_ALIVE_MS || '60000', 10)
  },

  // Circuit Breaker Configuration
  circuitBreaker: {
    enabled: process.env.CIRCUIT_BREAKER !== 'false',
    failureThreshold: parseInt(process.env.CB_FAILURE_THRESHOLD || '5', 10),
    successThreshold: parseInt(process.env.CB_SUCCESS_THRESHOLD || '2', 10),
    timeout: parseInt(process.env.CB_TIMEOUT || '30000', 10),
    monitoringPeriod: parseInt(process.env.CB_MONITORING_PERIOD || '60000', 10)
  },

  // Routing Configuration
  routing: {
    enableFallback: process.env.ENABLE_FALLBACK !== 'false',
    retryAttempts: parseInt(process.env.RETRY_ATTEMPTS || '2', 10),
    retryDelay: parseInt(process.env.RETRY_DELAY || '1000', 10)
  },

  // Performance Configuration
  performance: {
    enableCaching: process.env.ENABLE_CACHING !== 'false',
    cacheTTL: parseInt(process.env.CACHE_TTL || '300000', 10), // 5 minutes
    maxConcurrentRequests: parseInt(process.env.MAX_CONCURRENT || '10', 10)
  },

  // Logging Configuration
  logging: {
    level: process.env.LOG_LEVEL || 'info',
    mcpMode: process.env.MCP_MODE === 'true'
  },

  // Tenant Configuration (Multi-tenancy support)
  // These headers are required by GraphRAG and MageAgent APIs
  tenant: {
    companyId: process.env.NEXUS_COMPANY_ID || process.env.X_COMPANY_ID || '',
    appId: process.env.NEXUS_APP_ID || process.env.X_APP_ID || '',
    userId: process.env.NEXUS_USER_ID || process.env.X_USER_ID || ''
  }
};

// Log configuration on startup (only in non-MCP mode)
if (!config.logging.mcpMode) {
  logger.info('Nexus Routing Configuration', {
    graphragEndpoints: config.graphrag.endpoints[0] + ` (+${config.graphrag.endpoints.length - 1} fallbacks)`,
    mageagentEndpoints: config.mageagent.endpoints[0] + ` (+${config.mageagent.endpoints.length - 1} fallbacks)`,
    mcpMode: config.logging.mcpMode,
    logLevel: config.logging.level
  });
}

export default config;
