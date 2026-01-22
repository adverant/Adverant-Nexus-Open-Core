/**
 * MageAgent Configuration
 * Uses existing infrastructure and real OpenRouter API
 */

export const config = {
  // Server configuration
  port: parseInt(process.env.PORT || '8080', 10),
  wsPort: parseInt(process.env.WS_PORT || '8081', 10),
  env: process.env.NODE_ENV || 'development',
  
  // OpenRouter configuration - REAL API
  openRouter: {
    apiKey: process.env.OPENROUTER_API_KEY || '',
    baseUrl: 'https://openrouter.ai/api/v1',
    httpReferer: process.env.HTTP_REFERER || 'https://adverant.ai',
    appName: 'MageAgent Multi-Model Orchestrator',
    options: {
      provider: {
        order: ['OpenAI', 'Anthropic', 'Google', 'Meta'],
        require_parameters: true,
        data_collection: 'deny',
        zdr: true // Zero data retention
      }
    }
  },
  
  // Database connections - use Docker service names for local dev
  databases: {
    postgres: {
      host: process.env.POSTGRES_HOST || 'postgres',
      port: parseInt(process.env.POSTGRES_PORT || '5432', 10),
      database: process.env.POSTGRES_DATABASE || 'graphrag',
      user: process.env.POSTGRES_USER || 'graphrag',
      password: process.env.POSTGRES_PASSWORD || 'graphrag123',
      ssl: process.env.POSTGRES_SSL === 'true',
      // Table prefix to avoid conflicts
      schema: 'mageagent',
    },

    redis: {
      host: process.env.REDIS_HOST || 'redis',
      port: parseInt(process.env.REDIS_PORT || '6379', 10),
      password: process.env.REDIS_PASSWORD,
      keyPrefix: 'mageagent:',
      // For task queues and real-time state
      db: 1,
    },

    neo4j: {
      host: process.env.NEO4J_HOST || 'neo4j',
      port: parseInt(process.env.NEO4J_PORT || '7687', 10),
      user: process.env.NEO4J_USER || 'neo4j',
      password: process.env.NEO4J_PASSWORD || 'neo4j123',
      encrypted: false,
      database: process.env.NEO4J_DATABASE || 'neo4j',
    },

    qdrant: {
      host: process.env.QDRANT_HOST || 'qdrant',
      port: parseInt(process.env.QDRANT_PORT || '6333', 10),
      apiKey: process.env.QDRANT_API_KEY,
      collections: {
        agentOutputs: 'mageagent_outputs',
        competitionResults: 'mageagent_competitions',
        patterns: 'mageagent_patterns',
      }
    },
  },
  
  // GraphRAG integration (replaces mem-agent)
  graphRAG: {
    endpoint: process.env.GRAPHRAG_ENDPOINT || 'http://graphrag:8090',
    externalEndpoint: process.env.GRAPHRAG_EXTERNAL || 'http://localhost:8090',
  },

  // Legacy mem-agent config (for backwards compatibility - redirects to GraphRAG)
  memAgent: {
    endpoint: process.env.GRAPHRAG_ENDPOINT || 'http://graphrag:8090',
    externalEndpoint: process.env.GRAPHRAG_EXTERNAL || 'http://localhost:8090',
  },

  // External Nexus services for Universal Request Orchestrator
  services: {
    // CyberAgent - Security scanning service
    cyberAgent: {
      endpoint: process.env.CYBERAGENT_URL || 'http://nexus-cyberagent:9050',
      timeout: parseInt(process.env.CYBERAGENT_TIMEOUT_MS || '180000', 10), // 3 minutes
    },

    // FileProcessAgent - Document processing service
    fileProcess: {
      endpoint: process.env.FILEPROCESS_URL || 'http://nexus-fileprocess:9040',
      timeout: parseInt(process.env.FILEPROCESS_TIMEOUT_MS || '300000', 10), // 5 minutes
    },

    // Sandbox - Code execution service
    sandbox: {
      endpoint: process.env.SANDBOX_URL || 'http://nexus-sandbox:9080',
      timeout: parseInt(process.env.SANDBOX_TIMEOUT_MS || '300000', 10), // 5 minutes
    },
  },
  
  // Orchestration settings - NO LIMITS
  orchestration: {
    maxConcurrentAgents: parseInt(process.env.MAX_CONCURRENT_AGENTS || '999999', 10), // Effectively unlimited
    defaultTimeout: parseInt(process.env.AGENT_TIMEOUT_MS || '3600000', 10), // 1 hour timeout
    taskQueueSize: parseInt(process.env.TASK_QUEUE_SIZE || '999999', 10), // Effectively unlimited
    // Agent competition settings - NO LIMITS
    competition: {
      minAgents: parseInt(process.env.MIN_COMPETITION_AGENTS || '2', 10),
      maxAgents: parseInt(process.env.MAX_COMPETITION_AGENTS || '999999', 10), // Effectively unlimited
      evaluationTimeout: parseInt(process.env.EVALUATION_TIMEOUT || '3600000', 10), // 1 hour
    },
    // Model selection strategy
    modelSelection: {
      costOptimization: true,
      latencyThreshold: parseInt(process.env.LATENCY_THRESHOLD || '300000', 10), // 5 minutes
      qualityThreshold: 0.8,
    }
  },
  
  // RabbitMQ integration (if needed for task distribution)
  rabbitmq: {
    enabled: process.env.RABBITMQ_ENABLED === 'true',
    url: process.env.RABBITMQ_URL || 'amqp://rabbitmq.vibe-data.svc.cluster.local:5672',
    exchanges: {
      tasks: 'mageagent.tasks',
      results: 'mageagent.results',
      events: 'mageagent.events',
    }
  },
  
  // Logging configuration
  logging: {
    level: process.env.LOG_LEVEL || 'info',
    format: process.env.LOG_FORMAT || 'json',
  },
  
  // Health check configuration
  healthCheck: {
    enabled: true,
    interval: 30000, // 30 seconds
    timeout: 5000,
  },

  // Google Cloud Platform configuration
  googleCloud: {
    projectId: process.env.GOOGLE_CLOUD_PROJECT_ID || 'adverant-ai',
    keyFile: process.env.GOOGLE_APPLICATION_CREDENTIALS || '/secrets/gcp-service-account.json',

    // Google Earth Engine configuration
    earthEngine: {
      endpoint: process.env.EARTH_ENGINE_ENDPOINT || 'https://earthengine.googleapis.com/v1',
      timeout: parseInt(process.env.EARTH_ENGINE_TIMEOUT_MS || '60000', 10), // 60 seconds
    },

    // Google Vertex AI configuration
    vertexAI: {
      endpoint: process.env.VERTEX_AI_ENDPOINT || 'https://us-central1-aiplatform.googleapis.com/v1',
      region: process.env.VERTEX_AI_REGION || 'us-central1',
      timeout: parseInt(process.env.VERTEX_AI_TIMEOUT_MS || '120000', 10), // 120 seconds
    },

    // Google BigQuery GIS configuration
    bigQuery: {
      endpoint: process.env.BIGQUERY_ENDPOINT || 'https://bigquery.googleapis.com/bigquery/v2',
      datasetId: process.env.BIGQUERY_DATASET_ID || 'geoagent_spatial',
      timeout: parseInt(process.env.BIGQUERY_TIMEOUT_MS || '60000', 10), // 60 seconds
    }
  }
};

// Validate required configuration
if (!config.openRouter.apiKey) {
  console.error('ERROR: OPENROUTER_API_KEY environment variable is required');
  process.exit(1);
}

// Log configuration (without sensitive data)
console.log('MageAgent Configuration:');
console.log('- HTTP Port:', config.port);
console.log('- WebSocket Port:', config.wsPort);
console.log('- PostgreSQL:', config.databases.postgres.host);
console.log('- Redis:', config.databases.redis.host);
console.log('- Neo4j:', `${config.databases.neo4j.host}:${config.databases.neo4j.port}`);
console.log('- Qdrant:', `${config.databases.qdrant.host}:${config.databases.qdrant.port}`);
console.log('- GraphRAG:', config.graphRAG.endpoint);
console.log('- OpenRouter: Configured');
console.log('- Google Cloud Project:', config.googleCloud.projectId);
console.log('- Earth Engine:', config.googleCloud.earthEngine.endpoint);
console.log('- Vertex AI:', config.googleCloud.vertexAI.region);
console.log('- BigQuery Dataset:', config.googleCloud.bigQuery.datasetId);
console.log('- Max Concurrent Agents:', config.orchestration.maxConcurrentAgents === 999999 ? 'UNLIMITED' : config.orchestration.maxConcurrentAgents);
console.log('- Max Competition Agents:', config.orchestration.competition.maxAgents === 999999 ? 'UNLIMITED' : config.orchestration.competition.maxAgents);
console.log('- CyberAgent:', config.services.cyberAgent.endpoint);
console.log('- FileProcess:', config.services.fileProcess.endpoint);
console.log('- Sandbox:', config.services.sandbox.endpoint);
