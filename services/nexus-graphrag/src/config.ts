/**
 * GraphRAG Configuration
 * Uses existing databases - NO new deployments needed
 */

export const config = {
  // API Server
  port: parseInt(process.env.PORT || '8090', 10),
  env: process.env.NODE_ENV || 'development',
  
  // CORS allowed origins
  corsOrigins: [
    'http://localhost:*',
    'https://localhost:*',
    'vscode-webview://*',
    /^vscode-resource:/
  ],
  
  // Use environment variables with local Docker defaults
  // Unified 'nexus' database with schema-based isolation
  postgres: {
    host: process.env.POSTGRES_HOST || 'postgres',
    port: parseInt(process.env.POSTGRES_PORT || '5432', 10),
    database: process.env.POSTGRES_DATABASE || process.env.POSTGRES_DB || 'nexus',
    schema: process.env.POSTGRES_SCHEMA || 'graphrag',
    user: process.env.POSTGRES_USER || 'nexus',
    password: process.env.POSTGRES_PASSWORD || 'graphrag123',
    ssl: process.env.POSTGRES_SSL === 'true',
    // Use existing read replica for queries
    readHost: process.env.POSTGRES_READ_HOST || process.env.POSTGRES_HOST || 'postgres',
  },

  neo4j: {
    uri: process.env.NEO4J_URI || `bolt://${process.env.NEO4J_HOST || 'nexus-neo4j'}:${process.env.NEO4J_PORT || '7687'}`,
    user: process.env.NEO4J_USER || 'neo4j',
    password: process.env.NEO4J_PASSWORD || 'neo4j123',
    database: process.env.NEO4J_DATABASE || 'neo4j',
  },

  qdrant: {
    url: `http://${process.env.QDRANT_HOST || 'qdrant'}:${process.env.QDRANT_PORT || '6333'}`,
    host: process.env.QDRANT_HOST || 'qdrant',
    port: parseInt(process.env.QDRANT_PORT || '6333', 10),
    apiKey: process.env.QDRANT_API_KEY,
    // Use existing collections or create new ones with prefix
    collections: {
      chunks: 'graphrag_chunks',
      documents: 'graphrag_documents',
      summaries: 'graphrag_summaries',
    }
  },
  
  redis: {
    // Using Redis - local Docker or Kubernetes
    host: process.env.REDIS_HOST || 'redis',
    port: parseInt(process.env.REDIS_PORT || '6379', 10),
    password: process.env.REDIS_PASSWORD,
    // Use specific key prefix to avoid conflicts
    keyPrefix: 'graphrag:',
    cluster: process.env.REDIS_CLUSTER === 'true',
    clusterNodes: process.env.REDIS_CLUSTER_NODES ? process.env.REDIS_CLUSTER_NODES.split(',') : []
  },
  
  // Voyage AI Configuration
  voyageAI: {
    apiKey: process.env.VOYAGE_API_KEY,
    model: process.env.VOYAGE_MODEL || 'voyage-3',
    rerankModel: process.env.VOYAGE_RERANK_MODEL || 'rerank-2.5',
    dimensions: 1024, // voyage-3 dimensions
  },

  // Google Drive Configuration (optional for URL ingestion)
  googleDrive: {
    enabled: process.env.GOOGLE_DRIVE_ENABLED === 'true',
    clientId: process.env.GOOGLE_DRIVE_CLIENT_ID || '',
    clientSecret: process.env.GOOGLE_DRIVE_CLIENT_SECRET || '',
    redirectUri: process.env.GOOGLE_DRIVE_REDIRECT_URI || 'http://localhost:8090/auth/google/callback',
    apiKey: process.env.GOOGLE_DRIVE_API_KEY || '',
  },

  // OpenRouter Configuration (for dynamic model selection)
  openRouter: {
    apiKey: process.env.OPENROUTER_API_KEY,
    baseUrl: process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1',
    filterFreeModels: process.env.FILTER_FREE_MODELS !== 'false', // Default: true
    allowUserOverride: process.env.ALLOW_USER_MODEL_OVERRIDE !== 'false', // Default: true
    noTokenLimits: true, // Always true - no token limits enforced
  },
  
  // Chunking configuration
  chunking: {
    maxTokens: parseInt(process.env.MAX_CHUNK_TOKENS || '1000', 10),
    overlapTokens: parseInt(process.env.OVERLAP_TOKENS || '100', 10),
  },
  
  // Database configuration (unified nexus database with schema isolation)
  database: {
    postgres: {
      host: process.env.POSTGRES_HOST || 'postgres',
      port: parseInt(process.env.POSTGRES_PORT || '5432', 10),
      database: process.env.POSTGRES_DATABASE || process.env.POSTGRES_DB || 'nexus',
      schema: process.env.POSTGRES_SCHEMA || 'graphrag',
      user: process.env.POSTGRES_USER || 'nexus',
      password: process.env.POSTGRES_PASSWORD || 'graphrag123',
    },
    neo4j: {
      uri: process.env.NEO4J_URI || `bolt://${process.env.NEO4J_HOST || 'nexus-neo4j'}:${process.env.NEO4J_PORT || '7687'}`,
      user: process.env.NEO4J_USER || 'neo4j',
      password: process.env.NEO4J_PASSWORD || 'neo4j123',
    },
    redis: {
      host: process.env.REDIS_HOST || 'redis',
      port: parseInt(process.env.REDIS_PORT || '6379', 10),
      password: process.env.REDIS_PASSWORD,
    },
    qdrant: {
      host: process.env.QDRANT_HOST || 'qdrant',
      port: parseInt(process.env.QDRANT_PORT || '6333', 10),
      url: `http://${process.env.QDRANT_HOST || 'qdrant'}:${process.env.QDRANT_PORT || '6333'}`,
      apiKey: process.env.QDRANT_API_KEY,
    }
  },
  
  // Mem-agent integration
  memAgent: {
    endpoint: process.env.MEM_AGENT_ENDPOINT || 'http://31.97.54.143:30578',
    mcp: process.env.MEM_AGENT_MCP || 'http://31.97.54.143:8080',
  },

  // Interaction Capture Configuration
  interactionCapture: {
    enabled: process.env.ENABLE_INTERACTION_CAPTURE !== 'false', // Default: true
    retentionDays: parseInt(process.env.INTERACTION_RETENTION_DAYS || '7', 10),
    autoArchive: process.env.AUTO_ARCHIVE_INTERACTIONS !== 'false', // Default: true
    webhookSecret: process.env.WEBHOOK_SECRET || 'change-me-in-production',
    enableSignatureValidation: process.env.ENABLE_WEBHOOK_SIGNATURE_VALIDATION !== 'false',
  },
  
  // Logging
  logging: {
    level: process.env.LOG_LEVEL || 'info',
  },
  logLevel: process.env.LOG_LEVEL || 'info', // For backward compatibility
};

// Validate required environment variables
// PHASE 1.1: Standardize Fail-Fast Configuration
// Embeddings are MANDATORY for GraphRAG - service cannot function without them
const requiredEnvVars: string[] = ['VOYAGE_API_KEY'];

for (const envVar of requiredEnvVars) {
  if (!process.env[envVar]) {
    const errorMessage = `
╔════════════════════════════════════════════════════════════════════╗
║                     CRITICAL STARTUP ERROR                         ║
╚════════════════════════════════════════════════════════════════════╝

Missing required environment variable: ${envVar}

GraphRAG cannot function without Voyage AI embeddings. The service
requires a valid Voyage AI API key to generate embeddings for:
  - Document ingestion
  - Memory storage
  - Semantic search
  - Knowledge graph construction

RESOLUTION:
  1. Obtain a Voyage AI API key from: https://www.voyageai.com/
  2. Set the environment variable: export ${envVar}=your_api_key_here
  3. Restart the GraphRAG service

Service startup aborted.
`;
    console.error(errorMessage);
    process.exit(1);
  }
}

// OPENROUTER_API_KEY warning if not provided
if (!process.env.OPENROUTER_API_KEY) {
  console.warn('WARNING: OPENROUTER_API_KEY not set - dynamic model selection will be disabled');
}

// Log database connections (without passwords)
console.log('GraphRAG Configuration:');
console.log('- PostgreSQL:', config.postgres.host);
console.log('- Neo4j:', config.neo4j.uri);
console.log('- Qdrant:', `${config.qdrant.host}:${config.qdrant.port}`);
console.log('- Redis:', config.redis.host);
console.log('- Mem-agent:', config.memAgent.endpoint);
