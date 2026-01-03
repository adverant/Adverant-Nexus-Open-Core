/**
 * Graphiti Service Implementation
 * Provides episodic memory capabilities through Neo4j graph database
 * with Qdrant vector similarity search for accurate retrieval
 */

import neo4j, { Driver, Session } from 'neo4j-driver';
import { v4 as uuidv4 } from 'uuid';
import { createHash } from 'crypto';
import winston from 'winston';
import axios, { AxiosInstance } from 'axios';
import { QdrantClient } from '@qdrant/js-client-rest';
import {
  Episode,
  ExtractedEntity,
  ExtractedFact,
  EpisodicEdge,
  GraphitiConfig,
  IGraphitiService,
  StoreEpisodeRequest,
  StoreEpisodeResponse,
  RecallEpisodesRequest,
  RecallEpisodesResponse,
  EpisodeSource,
  EpisodeSummary,
  EpisodeMedium,
  EpisodeResponseLevel,
  HybridScoringWeights,
  HybridScoreBreakdown,
  ScoredEpisode,
  DEFAULT_SCORING_WEIGHTS
} from './types';
import { VoyageAIClient, VoyageAIUnifiedClient } from '../clients/voyage-ai-unified-client';
import {
  TokenBudgetManager,
  generateSummary,
  estimateObjectTokens,
} from './token-utils';
import { EnhancedTenantContext } from '../middleware/tenant-context';
import { getClassificationMetrics } from '../metrics/classification-metrics';
import { getClassificationConfig } from '../config/classification-config';
import { SemanticClassifier, ClassificationResult, EntityType } from '../classification/semantic-classifier';
import { EntityResolution } from './entity-resolution';
import { TemporalExtractor, TemporalEntity } from './temporal-extraction';
import { EmbeddingCache } from '../utils/cache';
import Redis from 'ioredis';

const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json()
  ),
  defaultMeta: { service: 'graphiti' },
  transports: [
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.colorize(),
        winston.format.simple()
      )
    })
  ]
});

/**
 * Stopwords to filter out from entity extraction
 * These are common words that shouldn't be treated as entities
 */
const ENTITY_STOPWORDS = new Set([
  // Articles and pronouns
  'the', 'a', 'an', 'this', 'that', 'these', 'those',
  'i', 'we', 'you', 'he', 'she', 'it', 'they', 'me', 'us', 'him', 'her', 'them',
  'my', 'our', 'your', 'his', 'its', 'their',
  // Common verbs (capitalized at sentence start)
  'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could', 'should',
  'can', 'may', 'might', 'must', 'shall',
  'get', 'got', 'make', 'made', 'let', 'set', 'put', 'take', 'took',
  'create', 'created', 'execute', 'executed', 'run', 'ran',
  'add', 'added', 'update', 'updated', 'delete', 'deleted', 'remove', 'removed',
  // Prepositions and conjunctions
  'for', 'from', 'with', 'without', 'to', 'of', 'in', 'on', 'at', 'by',
  'and', 'or', 'but', 'if', 'then', 'else', 'when', 'where', 'how', 'why',
  // Common nouns that aren't useful entities
  'thing', 'things', 'stuff', 'way', 'ways', 'time', 'times', 'day', 'days',
  'year', 'years', 'month', 'months', 'week', 'weeks', 'hour', 'hours',
  'example', 'examples', 'case', 'cases', 'type', 'types', 'kind', 'kinds',
  'part', 'parts', 'step', 'steps', 'point', 'points', 'item', 'items',
  // Document structure words
  'summary', 'executive', 'overview', 'introduction', 'conclusion',
  'section', 'chapter', 'table', 'figure', 'note', 'notes',
  // Months and days (not useful as entities)
  'january', 'february', 'march', 'april', 'may', 'june',
  'july', 'august', 'september', 'october', 'november', 'december',
  'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday',
  // Common tech words that are too generic
  'data', 'code', 'file', 'files', 'function', 'functions', 'class', 'classes',
  'method', 'methods', 'variable', 'variables', 'value', 'values',
  'key', 'keys', 'name', 'names', 'id', 'ids',
  'error', 'errors', 'issue', 'issues', 'bug', 'bugs', 'fix', 'fixes',
  // Common adjectives
  'new', 'old', 'good', 'bad', 'great', 'small', 'large', 'big', 'little',
  'first', 'last', 'next', 'previous', 'current', 'main', 'other',
  // Meta words
  'here', 'there', 'now', 'then', 'today', 'tomorrow', 'yesterday',
  'true', 'false', 'yes', 'no', 'ok', 'okay',
  // Single letters
  'a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'l', 'm',
  'n', 'o', 'p', 'q', 'r', 's', 't', 'u', 'v', 'w', 'x', 'y', 'z',
  // Greetings and conversational words (commonly missed garbage)
  'hello', 'hi', 'hey', 'bye', 'goodbye', 'thanks', 'thank', 'please', 'sorry', 'welcome',
  // Question words (when capitalized at sentence start)
  'what', 'which', 'who', 'whom', 'whose', 'why', 'how', 'where', 'when',
  // Quantifiers
  'some', 'any', 'all', 'each', 'every', 'both', 'few', 'many', 'much', 'more', 'most', 'less', 'least',
  // Generic adjectives commonly extracted as entities
  'important', 'specific', 'different', 'same', 'similar', 'various', 'certain', 'particular',
  // Common verbs that slip through
  'use', 'used', 'using', 'work', 'working', 'works', 'need', 'needs', 'needed',
  'want', 'wants', 'wanted', 'like', 'likes', 'liked', 'know', 'knows', 'knew',
  'think', 'thinks', 'thought', 'see', 'sees', 'saw', 'find', 'finds', 'found',
  // Code/tech garbage that shouldn't be entities
  'script', 'scripts', 'test', 'tests', 'testing', 'config', 'configuration',
  'build', 'builds', 'deploy', 'deployment', 'server', 'servers', 'client', 'clients',
  'user', 'users', 'system', 'systems', 'service', 'services', 'api', 'apis',
  // Miscellaneous garbage
  'something', 'anything', 'everything', 'nothing', 'someone', 'anyone', 'everyone', 'no one',
  'lot', 'lots', 'bit', 'bits', 'number', 'numbers', 'amount', 'amounts',
  // Action verbs that were being extracted as entities (from testing)
  'integrate', 'integration', 'integrating', 'integrated',
  'after', 'before', 'during', 'while', 'through', 'between',
  'confidence', 'confident', 'confidently',
  'adding', 'removing', 'updating', 'deleting', 'creating',
  'emoji', 'emojis',
  'evidence', 'proof', 'proofs',
  'quality', 'quantity', 'quantities',
  'based', 'base', 'basis',
  'always', 'never', 'sometimes', 'often', 'rarely',
  'adjust', 'adjusting', 'adjusted', 'adjustment',
  'provided', 'provide', 'providing', 'provides',
  'high', 'low', 'medium', 'higher', 'lower',
  'strong', 'weak', 'stronger', 'weaker',
  'adapt', 'adapting', 'adapted', 'adaptation',
  // Abstract adjectives commonly extracted incorrectly
  'available', 'unavailable',
  'complete', 'incomplete', 'completed',
  'correct', 'incorrect', 'correctly',
  'valid', 'invalid', 'validated', 'validation',
  'enabled', 'disabled', 'enable', 'disable',
  // Process words
  'process', 'processes', 'processing', 'processed',
  'result', 'results', 'resulting',
  'response', 'responses', 'responding',
  'request', 'requests', 'requesting',
  'action', 'actions',
  'operation', 'operations', 'operating',
  // Generic terms
  'thing', 'things', 'stuff', 'item', 'items',
  'way', 'ways', 'approach', 'approaches',
  'method', 'methods', 'technique', 'techniques',
  'option', 'options', 'choice', 'choices',
  'feature', 'features', 'capability', 'capabilities'
]);

/**
 * Known locations for proper classification
 * Helps prevent cities from being classified as persons
 */
const KNOWN_LOCATIONS = new Set([
  // US Cities
  'seattle', 'san francisco', 'san jose', 'los angeles', 'new york',
  'austin', 'denver', 'chicago', 'boston', 'portland', 'miami',
  'mountain view', 'palo alto', 'menlo park', 'cupertino', 'redmond',
  'santa clara', 'sunnyvale', 'san diego', 'phoenix', 'atlanta',
  // International
  'london', 'paris', 'berlin', 'tokyo', 'beijing', 'singapore',
  'toronto', 'vancouver', 'sydney', 'melbourne', 'dublin', 'amsterdam',
  // States/Countries
  'california', 'texas', 'washington', 'oregon', 'colorado',
  'usa', 'uk', 'canada', 'australia', 'germany', 'france', 'japan', 'china'
]);

/**
 * Known organizations (COMPANIES ONLY - not technologies)
 */
const KNOWN_ORGANIZATIONS = new Set([
  'google', 'microsoft', 'apple', 'amazon', 'meta', 'facebook',
  'netflix', 'tesla', 'nvidia', 'intel', 'amd', 'ibm', 'oracle', 'adobe',
  'salesforce', 'uber', 'lyft', 'airbnb', 'spotify', 'twitter', 'linkedin',
  'github', 'gitlab', 'atlassian', 'slack', 'zoom', 'stripe', 'square',
  'openai', 'anthropic', 'deepmind', 'hugging face', 'databricks', 'snowflake',
  'palantir', 'crowdstrike', 'datadog', 'mongodb inc', 'elastic', 'confluent'
]);

/**
 * Known technologies (frameworks, languages, tools, products - NOT companies)
 * Checked BEFORE organizations to prevent "React" → "organization"
 */
const KNOWN_TECHNOLOGIES = new Set([
  // Frameworks
  'react', 'angular', 'vue', 'svelte', 'next', 'nuxt', 'gatsby', 'remix', 'astro',
  // Runtimes & Servers
  'node', 'deno', 'bun', 'express', 'fastify', 'nest', 'koa', 'hapi',
  // Languages
  'python', 'javascript', 'typescript', 'rust', 'go', 'java', 'kotlin', 'swift', 'scala',
  'ruby', 'php', 'c', 'c++', 'c#', 'objective-c', 'perl', 'lua', 'elixir', 'clojure',
  // Databases
  'redis', 'mongodb', 'postgresql', 'mysql', 'elasticsearch', 'neo4j', 'qdrant',
  'pinecone', 'weaviate', 'milvus', 'cassandra', 'dynamodb', 'sqlite', 'mariadb',
  // Infrastructure & DevOps
  'docker', 'kubernetes', 'k8s', 'aws', 'azure', 'gcp', 'vercel', 'netlify',
  'terraform', 'ansible', 'jenkins', 'circleci', 'traefik', 'nginx', 'istio',
  // Package managers & Build tools
  'npm', 'yarn', 'pnpm', 'pip', 'cargo', 'maven', 'gradle', 'webpack', 'vite', 'rollup',
  // AI/ML
  'transformer', 'bert', 'gpt', 'llama', 'claude', 'langchain', 'pytorch', 'tensorflow',
  'huggingface', 'scikit-learn', 'keras', 'jax', 'onnx', 'mlflow', 'ray',
  // APIs & Protocols
  'graphql', 'rest', 'grpc', 'websocket', 'http', 'https', 'oauth', 'jwt', 'cors',
  // Consumer tech products (devices, phones, smart devices)
  'iphone', 'ipad', 'macbook', 'imac', 'airpods', 'apple watch', 'mac pro', 'mac mini',
  'pixel', 'galaxy', 'oneplus', 'surface', 'chromebook', 'kindle', 'echo', 'fire tv',
  // Operating systems & platforms
  'ios', 'macos', 'watchos', 'tvos', 'android', 'windows', 'linux', 'ubuntu', 'debian',
  'fedora', 'centos', 'freebsd', 'chromeos', 'harmonyos',
  // Smart assistants & AI products
  'siri', 'alexa', 'google assistant', 'cortana', 'bixby',
  'chatgpt', 'gemini', 'copilot', 'midjourney', 'dall-e', 'stable diffusion',
  // Browsers
  'chrome', 'firefox', 'safari', 'edge', 'brave', 'opera', 'vivaldi', 'arc',
  // Consumer apps & services
  'spotify', 'netflix', 'youtube', 'tiktok', 'instagram', 'whatsapp', 'telegram',
  'slack', 'discord', 'zoom', 'teams', 'notion', 'obsidian', 'linear', 'figma'
]);

/**
 * Custom errors for Graphiti operations
 */
export class GraphitiError extends Error {
  constructor(message: string, public code: string, public context?: any) {
    super(message);
    this.name = 'GraphitiError';
  }
}

export class EpisodeNotFoundError extends GraphitiError {
  constructor(episodeId: string) {
    super(`Episode ${episodeId} not found`, 'EPISODE_NOT_FOUND', { episodeId });
  }
}

export class EntityResolutionError extends GraphitiError {
  constructor(message: string, entities: string[]) {
    super(message, 'ENTITY_RESOLUTION_FAILED', { entities });
  }
}

/**
 * LLM-based entity type classification cache
 * Stores results from Claude Sonnet 4.5 to avoid repeated API calls
 * Key: lowercased entity name, Value: { type, confidence }
 */
const LLM_ENTITY_TYPE_CACHE = new Map<string, { type: string; confidence: number }>();

/**
 * Pre-populate cache with high-confidence known entities
 * This is a PERFORMANCE optimization only - LLM is authoritative for unknown entities
 */
function initializeEntityTypeCache(): void {
  // Technologies (highest confidence - these are unambiguous)
  const technologies = [
    'react', 'angular', 'vue', 'svelte', 'next', 'nuxt', 'gatsby', 'remix', 'astro',
    'node', 'deno', 'bun', 'express', 'fastify', 'nest', 'koa', 'hapi',
    'python', 'javascript', 'typescript', 'rust', 'go', 'java', 'kotlin', 'swift',
    'redis', 'mongodb', 'postgresql', 'mysql', 'neo4j', 'qdrant', 'pinecone',
    'docker', 'kubernetes', 'k8s', 'aws', 'azure', 'gcp', 'vercel', 'netlify',
    'terraform', 'ansible', 'jenkins', 'webpack', 'vite', 'rollup',
    'transformer', 'bert', 'gpt', 'llama', 'claude', 'langchain', 'pytorch', 'tensorflow',
    'graphql', 'rest', 'grpc', 'websocket', 'oauth', 'jwt', 'prisma', 'trpc', 'supabase'
  ];
  for (const tech of technologies) {
    LLM_ENTITY_TYPE_CACHE.set(tech.toLowerCase(), { type: 'technology', confidence: 0.99 });
  }

  // Major organizations (companies that are unambiguous)
  const organizations = [
    'google', 'microsoft', 'apple', 'amazon', 'meta', 'facebook', 'netflix',
    'tesla', 'nvidia', 'intel', 'amd', 'ibm', 'oracle', 'adobe', 'salesforce',
    'uber', 'lyft', 'airbnb', 'spotify', 'twitter', 'linkedin', 'github', 'gitlab',
    'openai', 'anthropic', 'deepmind', 'databricks', 'snowflake', 'stripe', 'square',
    'neurips', 'icml', 'iclr', 'cvpr', 'acl', 'emnlp', 'stanford', 'mit', 'berkeley',
    'harvard', 'oxford', 'cambridge', 'cmu', 'caltech'
  ];
  for (const org of organizations) {
    LLM_ENTITY_TYPE_CACHE.set(org.toLowerCase(), { type: 'organization', confidence: 0.99 });
  }

  // Major locations
  const locations = [
    'seattle', 'san francisco', 'new york', 'los angeles', 'austin', 'denver',
    'chicago', 'boston', 'london', 'paris', 'berlin', 'tokyo', 'singapore',
    'vancouver', 'toronto', 'sydney', 'california', 'texas', 'washington'
  ];
  for (const loc of locations) {
    LLM_ENTITY_TYPE_CACHE.set(loc.toLowerCase(), { type: 'location', confidence: 0.99 });
  }
}

// Initialize cache on module load
initializeEntityTypeCache();

/**
 * Main Graphiti service implementation
 */
export class GraphitiService implements IGraphitiService {
  private driver: Driver;
  private config: GraphitiConfig;
  private embeddingClient: VoyageAIClient;
  private isInitialized: boolean = false;
  private openRouterClient: AxiosInstance | null = null;
  private summarizationEnabled: boolean = false;
  private semanticClassifier: SemanticClassifier | null = null;
  private semanticClassificationEnabled: boolean = false;
  private entityResolver: EntityResolution | null = null;
  private temporalExtractor: TemporalExtractor;
  private qdrantClient: QdrantClient | null = null;
  private qdrantCollectionName: string = 'memories';
  private embeddingCache: EmbeddingCache | null = null;
  // private databaseName: string;

  constructor(config: GraphitiConfig, embeddingClient: VoyageAIClient, redisClient?: Redis) {
    this.config = config;
    this.embeddingClient = embeddingClient;

    // Validate embedding client on construction
    if (!embeddingClient) {
      logger.error('Graphiti initialized without embedding client - episodes will be stored without vectors');
    } else if (!embeddingClient.generateEmbedding) {
      logger.error('Embedding client missing generateEmbedding method - check VoyageAI client initialization');
    }

    // Validate Voyage AI API key
    const voyageApiKey = process.env.VOYAGE_API_KEY;
    if (!voyageApiKey) {
      logger.warn(
        'VOYAGE_API_KEY environment variable not set. ' +
        'Graphiti will store episodes without embeddings. ' +
        'Set VOYAGE_API_KEY for full episodic memory functionality.'
      );
    } else if (!voyageApiKey.startsWith('pa-')) {
      logger.warn(
        'Voyage AI API key format unexpected (should start with "pa-"). ' +
        'Episodes may fail to generate embeddings.'
      );
    }

    // Initialize OpenRouter client for LLM-based summarization
    const openRouterApiKey = process.env.OPENROUTER_API_KEY;
    if (openRouterApiKey) {
      this.openRouterClient = axios.create({
        baseURL: 'https://openrouter.ai/api/v1',
        timeout: 30000, // 30 second timeout for summarization
        headers: {
          'Authorization': `Bearer ${openRouterApiKey}`,
          'Content-Type': 'application/json',
          'HTTP-Referer': 'https://api.adverant.ai',
          'X-Title': 'Nexus GraphRAG - Episode Summarization'
        }
      });
      this.summarizationEnabled = true;
      logger.info('Episode summarization enabled via OpenRouter');
    } else {
      logger.warn(
        'OPENROUTER_API_KEY not set. ' +
        'Episode summaries will use truncated content fallback.'
      );
    }

    // Initialize Embedding Cache if Redis client is provided
    // This enables content-hash based deduplication for embedding generation
    // Saves ~150ms per duplicate content and reduces Voyage AI API calls
    if (redisClient) {
      this.embeddingCache = new EmbeddingCache(redisClient, 86400); // 24h TTL
      logger.info('[EMBEDDING-CACHE] Enabled - using Redis for embedding deduplication');
    } else {
      logger.warn('[EMBEDDING-CACHE] Disabled - Redis client not provided');
    }

    // Initialize Neo4j driver
    this.driver = neo4j.driver(
      config.neo4j.uri,
      neo4j.auth.basic(config.neo4j.username, config.neo4j.password),
      {
        maxConnectionLifetime: 3 * 60 * 60 * 1000, // 3 hours
        maxConnectionPoolSize: 50,
        connectionAcquisitionTimeout: 2 * 60 * 1000 // 120 seconds
      }
    );

    // Store database name for session creation
    // this.databaseName = config.neo4j.database || 'neo4j';

    // Initialize Semantic Classifier if embedding client is available
    // Uses Voyage AI reranking (rerank-2.5) for entity type classification
    if (embeddingClient && typeof embeddingClient.generateEmbedding === 'function') {
      try {
        // Cast to VoyageAIUnifiedClient to access rerank method
        const unifiedClient = embeddingClient as VoyageAIUnifiedClient;
        if (typeof unifiedClient.rerank === 'function') {
          this.semanticClassifier = new SemanticClassifier(unifiedClient);
          this.semanticClassificationEnabled = process.env.ENABLE_SEMANTIC_CLASSIFICATION !== 'false';
          logger.info('[SEMANTIC-CLASSIFICATION] Enabled - using Voyage AI rerank-2.5 for entity classification', {
            enabled: this.semanticClassificationEnabled
          });

          // Initialize Entity Resolution with Voyage AI for fuzzy deduplication
          this.entityResolver = new EntityResolution(unifiedClient);
          logger.info('[ENTITY-RESOLUTION] Enabled - using Levenshtein + Voyage AI for entity deduplication');
        } else {
          logger.warn('[SEMANTIC-CLASSIFICATION] Voyage client missing rerank method - falling back to heuristic classification');
        }
      } catch (error: any) {
        logger.warn('[SEMANTIC-CLASSIFICATION] Failed to initialize - falling back to heuristic classification', {
          error: error.message
        });
      }
    }

    // Initialize Temporal Extractor for date/duration/recurring pattern extraction
    this.temporalExtractor = new TemporalExtractor();
    logger.info('[TEMPORAL-EXTRACTION] Enabled - extracting dates, durations, and recurring patterns');

    // Initialize Qdrant client for vector similarity search
    // This enables REAL vector search instead of text CONTAINS matching
    const qdrantUrl = config.qdrant?.url || process.env.QDRANT_URL || 'http://nexus-qdrant:6333';
    if (qdrantUrl) {
      try {
        this.qdrantClient = new QdrantClient({
          url: qdrantUrl,
          apiKey: config.qdrant?.apiKey || process.env.QDRANT_API_KEY
        });
        this.qdrantCollectionName = config.qdrant?.collectionName || 'memories';
        logger.info('[QDRANT] Vector search enabled', {
          url: qdrantUrl,
          collection: this.qdrantCollectionName
        });
      } catch (error: any) {
        logger.warn('[QDRANT] Failed to initialize Qdrant client - falling back to text matching', {
          error: error.message,
          url: qdrantUrl
        });
        this.qdrantClient = null;
      }
    } else {
      logger.warn('[QDRANT] No Qdrant URL configured - using text matching fallback');
    }

    logger.info('Graphiti service initialized', {
      neo4j_uri: config.neo4j.uri,
      enabled: config.enabled,
      has_embedding_client: !!embeddingClient,
      has_api_key: !!voyageApiKey,
      summarization_enabled: this.summarizationEnabled,
      semantic_classification_enabled: this.semanticClassificationEnabled,
      entity_resolution_enabled: !!this.entityResolver,
      temporal_extraction_enabled: !!this.temporalExtractor,
      qdrant_enabled: !!this.qdrantClient
    });
  }

  /**
   * Initialize the Graphiti schema in Neo4j
   */
  async initialize(): Promise<void> {
    if (this.isInitialized) return;

    const session = this.driver.session();
    try {
      // Create constraints and indexes with proper error handling
      const constraints = [
        'CREATE CONSTRAINT episode_id IF NOT EXISTS FOR (e:Episode) REQUIRE e.id IS UNIQUE',
        'CREATE CONSTRAINT entity_id IF NOT EXISTS FOR (n:Entity) REQUIRE n.id IS UNIQUE',
        'CREATE CONSTRAINT fact_id IF NOT EXISTS FOR (f:Fact) REQUIRE f.id IS UNIQUE',
        'CREATE INDEX episode_timestamp IF NOT EXISTS FOR (e:Episode) ON (e.timestamp)',
        'CREATE INDEX episode_type IF NOT EXISTS FOR (e:Episode) ON (e.type)',
        'CREATE INDEX episode_has_embedding IF NOT EXISTS FOR (e:Episode) ON (e.has_embedding)',
        // Phase 2: User-level filtering indexes
        'CREATE INDEX episode_company_id IF NOT EXISTS FOR (e:Episode) ON (e.company_id)',
        'CREATE INDEX episode_app_id IF NOT EXISTS FOR (e:Episode) ON (e.app_id)',
        'CREATE INDEX episode_user_id IF NOT EXISTS FOR (e:Episode) ON (e.user_id)',
        'CREATE INDEX episode_session_id IF NOT EXISTS FOR (e:Episode) ON (e.session_id)',
        // Phase 3: Deduplication index
        'CREATE INDEX episode_content_hash IF NOT EXISTS FOR (e:Episode) ON (e.content_hash)',
        'CREATE INDEX entity_name IF NOT EXISTS FOR (n:Entity) ON (n.name)',
        'CREATE INDEX entity_type IF NOT EXISTS FOR (n:Entity) ON (n.type)',
        'CREATE INDEX entity_company_id IF NOT EXISTS FOR (n:Entity) ON (n.company_id)',
        'CREATE INDEX entity_app_id IF NOT EXISTS FOR (n:Entity) ON (n.app_id)',
        'CREATE INDEX fact_subject IF NOT EXISTS FOR (f:Fact) ON (f.subject)',
        'CREATE INDEX fact_object IF NOT EXISTS FOR (f:Fact) ON (f.object)',
        'CREATE INDEX fact_company_id IF NOT EXISTS FOR (f:Fact) ON (f.company_id)',
        'CREATE INDEX fact_app_id IF NOT EXISTS FOR (f:Fact) ON (f.app_id)'
      ];

      // Execute each constraint/index creation
      for (const constraint of constraints) {
        try {
          await session.run(constraint);
        } catch (err: any) {
          // Only log non-duplicate errors
          if (!err.message?.includes('already exists') &&
              !err.message?.includes('equivalent') &&
              !err.message?.includes('An equivalent index already exists')) {
            logger.warn(`Constraint/index creation warning: ${err.message}`);
          }
        }
      }

      // Try to create fulltext indexes (may not be available in all versions)
      const fulltextIndexes = [
        'CREATE FULLTEXT INDEX episode_content IF NOT EXISTS FOR (e:Episode) ON EACH [e.content]',
        'CREATE FULLTEXT INDEX episode_summary IF NOT EXISTS FOR (e:Episode) ON EACH [e.summary]',
        'CREATE FULLTEXT INDEX entity_aliases IF NOT EXISTS FOR (n:Entity) ON EACH [n.name]'
      ];

      for (const index of fulltextIndexes) {
        try {
          await session.run(index);
        } catch (err: any) {
          // Fulltext indexes might not be supported
          logger.debug(`Fulltext index not created (may not be supported): ${err.message}`);
        }
      }

      this.isInitialized = true;
      logger.info('Graphiti schema initialized successfully');
    } catch (error) {
      logger.error('Failed to initialize Graphiti schema', { error });
      // Don't throw - allow service to continue with reduced functionality
      this.isInitialized = true; // Mark as initialized to prevent repeated attempts
    } finally {
      await session.close();
    }
  }

  /**
   * Generate a content hash for deduplication
   */
  private generateContentHash(content: string): string {
    // Normalize content: lowercase, remove extra whitespace, trim
    const normalized = content.toLowerCase().replace(/\s+/g, ' ').trim();
    return createHash('sha256').update(normalized).digest('hex').substring(0, 16);
  }

  /**
   * Generate LLM-based summary for an episode
   * Uses Claude Haiku via OpenRouter for cost-effective summarization
   * Falls back to truncated content if LLM call fails
   *
   * @param content The episode content to summarize
   * @param episodeType The type of episode for context
   * @returns A concise 1-2 sentence summary
   */
  /**
   * Generate episode summary - public for async worker access
   */
  public async generateEpisodeSummary(
    content: string,
    episodeType: string
  ): Promise<string> {
    // If summarization is not enabled or content is very short, use fallback
    if (!this.summarizationEnabled || !this.openRouterClient || content.length < 50) {
      return this.generateFallbackSummary(content);
    }

    try {
      const prompt = `Summarize this ${episodeType.replace('_', ' ')} in 1-2 concise sentences.

Capture:
- The main action or intent
- Key entities mentioned (people, systems, concepts)
- The outcome if any

Content:
${content.substring(0, 2000)}

Return ONLY the summary, no quotes or prefix.`;

      const response = await this.openRouterClient.post('/chat/completions', {
        model: 'anthropic/claude-3-5-haiku-20241022',  // Haiku: 3x faster, same quality for summarization
        messages: [
          {
            role: 'user',
            content: prompt
          }
        ],
        temperature: 0.3,
        max_tokens: 150
      });

      const summary = response.data?.choices?.[0]?.message?.content?.trim();

      if (!summary) {
        logger.warn('Empty summary response from LLM, using fallback');
        return this.generateFallbackSummary(content);
      }

      // Validate summary length - should be concise
      if (summary.length > 300) {
        // If LLM returned something too long, truncate intelligently
        const truncated = summary.substring(0, 297) + '...';
        logger.debug('Truncated overly long LLM summary', {
          originalLength: summary.length,
          truncatedLength: truncated.length
        });
        return truncated;
      }

      logger.debug('Generated LLM-based episode summary', {
        contentLength: content.length,
        summaryLength: summary.length,
        episodeType
      });

      return summary;
    } catch (error: any) {
      // Log the error but don't throw - use fallback instead
      logger.warn('LLM summarization failed, using fallback', {
        error: error.message,
        contentLength: content.length,
        episodeType
      });
      return this.generateFallbackSummary(content);
    }
  }

  /**
   * Generate a fallback summary by truncating content intelligently
   * Used when LLM summarization is unavailable or fails
   */
  private generateFallbackSummary(content: string): string {
    // Truncate to ~150 characters at word boundary
    if (content.length <= 150) {
      return content.trim();
    }

    // Find last space before 147 characters to avoid cutting words
    const truncatePoint = content.lastIndexOf(' ', 147);
    const endPoint = truncatePoint > 50 ? truncatePoint : 147;

    return content.substring(0, endPoint).trim() + '...';
  }

  /**
   * Check if an episode with similar content already exists
   */
  private async checkDuplicateEpisode(
    session: Session,
    contentHash: string,
    tenantContext: EnhancedTenantContext
  ): Promise<string | null> {
    const result = await session.run(`
      MATCH (e:Episode)
      WHERE e.content_hash = $contentHash
        AND e.company_id = $companyId
        AND e.app_id = $appId
        AND (e.user_id = $userId OR e.user_id = 'system')
      RETURN e.id as id
      LIMIT 1
    `, {
      contentHash,
      companyId: tenantContext.companyId,
      appId: tenantContext.appId,
      userId: tenantContext.userId
    });

    if (result.records.length > 0) {
      return result.records[0].get('id');
    }
    return null;
  }

  /**
   * Store a new episode in the graph
   * Phase 2: Now includes tenant + user context for user-level isolation
   * Phase 3: Added content hash deduplication
   */
  async storeEpisode(
    request: StoreEpisodeRequest,
    tenantContext: EnhancedTenantContext
  ): Promise<StoreEpisodeResponse> {
    await this.initialize();

    const session = this.driver.session();
    const episodeId = uuidv4();
    const timestamp = new Date();

    try {
      // Validate and sanitize episode content
      const validatedContent = this.validateAndSanitizeContent(request.content);

      // Generate content hash for deduplication
      const contentHash = this.generateContentHash(validatedContent);

      // Check for duplicates
      const existingEpisodeId = await this.checkDuplicateEpisode(session, contentHash, tenantContext);
      if (existingEpisodeId) {
        logger.info('Duplicate episode detected, skipping storage', {
          existingId: existingEpisodeId,
          contentHash
        });

        // Return existing episode info instead of storing duplicate
        return {
          episode_id: existingEpisodeId,
          entities_extracted: [],
          facts_extracted: [],
          edges_created: [],
          duplicate: true,
          content_hash: contentHash
        };
      }

      // Check if embedding client is available
      if (!this.embeddingClient || this.embeddingClient === null || !this.embeddingClient.generateEmbedding) {
        logger.warn('Embedding client not available, storing episode without vector');

        // Extract entities and facts from content (these don't need embeddings)
        const entities = await this.extractEntities(validatedContent, request.entities);
        const facts = await this.extractFactsCore(validatedContent, episodeId);

        // Store without embedding
        return await this.storeEpisodeWithoutEmbedding(
          session, episodeId, { ...request, content: validatedContent }, entities, facts, timestamp, tenantContext
        );
      }

      // Extract entities and facts from content
      const entities = await this.extractEntities(validatedContent, request.entities);
      const facts = await this.extractFactsCore(validatedContent, episodeId);

      // Calculate importance score if not provided
      const importance = request.importance ?? this.calculateImportance(
        validatedContent,
        entities,
        facts
      );

      // PARALLELIZED: Generate embedding and summary simultaneously (1-3s savings)
      const episodeType = request.type || 'user_query';
      const [embeddingResult, summary] = await Promise.all([
        this.generateEmbeddingWithRetry(validatedContent).catch((err: any) => {
          logger.error('Failed to generate embedding after retries', {
            error: err.message,
            episodeId,
            contentLength: validatedContent.length
          });
          return null;
        }),
        this.generateEpisodeSummary(validatedContent, episodeType)
      ]);

      // Handle embedding failure - fallback to storing without embedding
      let embedding: number[] | null = embeddingResult;
      if (!embedding) {
        logger.warn('Storing episode without embedding as fallback', { episodeId });
        return await this.storeEpisodeWithoutEmbedding(
          session, episodeId, { ...request, content: validatedContent }, entities, facts, timestamp, tenantContext
        );
      }

      // Validate embedding dimensions
      if (!Array.isArray(embedding) || embedding.length === 0) {
        logger.error('Invalid embedding dimensions, storing without embedding', {
          episodeId,
          embeddingLength: embedding?.length,
          expected: 1024
        });

        return await this.storeEpisodeWithoutEmbedding(
          session, episodeId, { ...request, content: validatedContent }, entities, facts, timestamp, tenantContext
        );
      }

      // Create episode node with validated data types + tenant context
      try {
        await session.run(`
          CREATE (e:Episode {
            id: $id,
            content: $content,
            content_hash: $contentHash,
            summary: $summary,
            timestamp: datetime($timestamp),
            type: $type,
            importance: $importance,
            decay_rate: $decay_rate,
            embedding_json: $embeddingJson,
            embedding_dimensions: $dimensions,
            has_embedding: true,
            company_id: $companyId,
            app_id: $appId,
            user_id: $userId,
            session_id: $sessionId
          })
          RETURN e
        `, {
          id: episodeId,
          content: validatedContent,  // Use sanitized content
          summary,  // LLM-generated summary
          contentHash,  // For deduplication
          timestamp: timestamp.toISOString(),
          type: request.type || 'user_query',
          importance,
          decay_rate: this.calculateDecayRate(importance),
          embeddingJson: JSON.stringify(Array.from(embedding)),
          dimensions: embedding.length,
          // Phase 2: Tenant + user context
          companyId: tenantContext.companyId,
          appId: tenantContext.appId,
          userId: tenantContext.userId,
          sessionId: tenantContext.sessionId || null
        });
      } catch (neo4jError: any) {
        throw new GraphitiError(
          `Neo4j episode creation failed: ${neo4jError.message}`,
          'NEO4J_WRITE_ERROR',
          {
            episodeId,
            errorCode: neo4jError.code,
            contentLength: request.content.length,
            embeddingDimensions: embedding.length
          }
        );
      }

      // Store metadata separately to avoid type conflicts
      if (request.metadata && Object.keys(request.metadata).length > 0) {
        try {
          await session.run(`
            MATCH (e:Episode {id: $id})
            SET e.metadata_json = $metadataJson
            RETURN e
          `, {
            id: episodeId,
            metadataJson: JSON.stringify(request.metadata)
          });
        } catch (metadataError: any) {
          logger.warn('Failed to store episode metadata', {
            episodeId,
            error: metadataError.message
          });
          // Continue without metadata rather than failing entire operation
        }
      }

      // Store source information
      if (request.source) {
        await this.storeEpisodeSource(session, episodeId, request.source);
      }

      // Create or update entities (with tenant context)
      // NOTE: Neo4j sessions are NOT thread-safe - must execute sequentially on same session
      const storedEntities: ExtractedEntity[] = [];
      for (const entity of entities) {
        try {
          const stored = await this.storeOrUpdateEntity(session, entity, episodeId, tenantContext);
          storedEntities.push(stored);
        } catch (err: any) {
          logger.warn('Failed to store entity', { name: entity.name, error: err.message });
        }
      }

      // Store facts (with tenant context)
      // NOTE: Neo4j sessions are NOT thread-safe - must execute sequentially on same session
      const storedFacts: ExtractedFact[] = [];
      for (const fact of facts) {
        try {
          const stored = await this.storeFact(session, fact, tenantContext);
          storedFacts.push(stored);
        } catch (err: any) {
          logger.warn('Failed to store fact', { subject: fact.subject, error: err.message });
        }
      }

      // Create temporal edges to recent episodes (within tenant + user context)
      const edges = await this.createTemporalEdges(session, episodeId, timestamp, tenantContext);

      // Create causal edges if applicable (within tenant + user context)
      const causalEdges = await this.createCausalEdges(session, episodeId, request, tenantContext);
      edges.push(...causalEdges);

      // Neo4j sessions auto-commit when not in explicit transaction

      logger.info('Episode stored successfully', {
        episodeId,
        entities: storedEntities.length,
        facts: storedFacts.length,
        edges: edges.length
      });

      return {
        episode_id: episodeId,
        entities_extracted: storedEntities,
        facts_extracted: storedFacts,
        edges_created: edges
      };

    } catch (error) {
      // Neo4j sessions don't have rollback - transactions auto-rollback on error
      logger.error('Failed to store episode', { error, request });
      throw new GraphitiError('Episode storage failed', 'STORE_FAILED', error);
    } finally {
      await session.close();
    }
  }

  /**
   * Recall episodes based on query and filters
   * REFACTORED: Now includes token budget management and hierarchical response levels
   * Phase 2: Now includes user-level filtering for GDPR compliance
   *
   * Token Budget Architecture:
   * - Default: 4000 tokens (summary level, ~10 episodes)
   * - Summary: ~80 tokens/episode
   * - Medium: ~200 tokens/episode
   * - Full: ~800 tokens/episode
   *
   * Response Level Strategy:
   * - summary: Episode metadata + 200-char summary (for browsing/overview)
   * - medium: Metadata + 500-char preview + entity names (for context)
   * - full: Complete episode with all relationships (for detailed analysis)
   *
   * User-Level Filtering:
   * - Filters by tenant (company_id + app_id)
   * - Filters by user (user_id)
   * - Allows system data (user_id = 'system') to be visible to all users in same tenant
   */
  async recallEpisodes(
    request: RecallEpisodesRequest,
    tenantContext: EnhancedTenantContext
  ): Promise<RecallEpisodesResponse> {
    await this.initialize();

    const session = this.driver.session();
    try {
      // === TOKEN BUDGET INITIALIZATION ===
      const responseLevel: EpisodeResponseLevel = request.response_level || 'summary';
      const maxTokens = request.max_tokens || 4000;
      const tokenBudget = new TokenBudgetManager(maxTokens);

      // === HYBRID SCORING INITIALIZATION ===
      // Merge custom weights with defaults and extract query entities
      const scoringWeights = this.mergeWeights(request.scoring_weights);
      const queryEntities = this.extractQueryEntities(request.query);

      logger.info('Episode recall initiated with hybrid scoring', {
        query: request.query.substring(0, 100),
        responseLevel,
        maxTokens,
        maxResults: request.max_results || 10,
        queryEntities: queryEntities.length,
        scoringWeights
      });

      // Generate embedding for the query
      // Use 'document' type for queries to match stored episode embeddings
      const queryEmbeddingResult = await this.embeddingClient.generateEmbedding(
        request.query,
        { inputType: 'document' }
      );

      // Extract raw embedding array from VoyageAI result
      const queryEmbedding = queryEmbeddingResult.embedding;

      // Validate embedding is a proper array
      if (!Array.isArray(queryEmbedding) || queryEmbedding.length !== 1024) {
        throw new GraphitiError(
          `Invalid query embedding: expected 1024-dimensional array, got ${typeof queryEmbedding} with length ${queryEmbedding?.length}`,
          'INVALID_QUERY_EMBEDDING',
          {
            expected: 1024,
            received: queryEmbedding?.length,
            model: queryEmbeddingResult.model
          }
        );
      }

      // === QDRANT VECTOR SEARCH ===
      // Query Qdrant for REAL vector similarity scores
      // This replaces the broken text CONTAINS matching
      const vectorSimilarityScores = new Map<string, number>();
      let qdrantSearchUsed = false;

      if (this.qdrantClient) {
        try {
          // Build Qdrant filter for tenant isolation
          // Fixed: Use proper must for company/app isolation, should only for user flexibility
          const qdrantFilter: any = {
            must: [
              { key: 'company_id', match: { value: tenantContext.companyId } },
              { key: 'app_id', match: { value: tenantContext.appId } }
            ],
            should: [
              // Allow user's own memories, system memories, or unified-memory
              { key: 'user_id', match: { value: tenantContext.userId } },
              { key: 'user_id', match: { value: 'system' } },
              { key: 'user_id', match: { value: 'unified-memory' } }
            ]
          };

          // Search Qdrant with the query embedding
          const qdrantResults = await this.qdrantClient.search(this.qdrantCollectionName, {
            vector: queryEmbedding,
            limit: (request.max_results || 10) * 3, // Get more for filtering
            with_payload: true,
            score_threshold: 0.5, // Minimum similarity threshold (increased from 0.3 for better relevance)
            filter: qdrantFilter
          });

          // Extract episode IDs and similarity scores
          for (const result of qdrantResults) {
            const episodeId = result.payload?.episode_id as string ||
                             result.payload?.id as string ||
                             result.id?.toString();
            if (episodeId && result.score !== undefined) {
              vectorSimilarityScores.set(episodeId, result.score);
            }
          }

          qdrantSearchUsed = vectorSimilarityScores.size > 0;

          logger.info('[QDRANT-SEARCH] Vector search completed', {
            query: request.query.substring(0, 50),
            resultsFound: vectorSimilarityScores.size,
            topScore: qdrantResults[0]?.score,
            collection: this.qdrantCollectionName
          });
        } catch (qdrantError: any) {
          logger.warn('[QDRANT-SEARCH] Vector search failed, falling back to text matching', {
            error: qdrantError.message
          });
          // Continue with text matching fallback
        }
      }

      // Build the Cypher query with tenant + user filters
      // Note: Also include legacy tenant contexts for backwards compatibility with existing episodes
      let cypherQuery = `
        MATCH (e:Episode)
        WHERE (
          (e.company_id = $companyId AND e.app_id = $appId)
          OR e.company_id IN ['nexus-default', 'nexus-system', 'default', 'system', 'adverant']
        )
        AND (e.user_id = $userId OR e.user_id = 'system' OR e.user_id = 'unified-memory')
      `;

      const params: any = {
        // Tenant + user context (REQUIRED for security)
        companyId: tenantContext.companyId,
        appId: tenantContext.appId,
        userId: tenantContext.userId,
        // Search parameters
        searchTerm: request.query, // Add search term for content matching
        embedding: Array.from(queryEmbedding),  // Convert to plain array for Neo4j
        maxResults: request.max_results || 10,
        // Qdrant similarity buckets for Neo4j (if Qdrant search was used)
        highSimilarityIds: [] as string[],
        mediumSimilarityIds: [] as string[],
        lowSimilarityIds: [] as string[]
      };

      // Populate similarity buckets from Qdrant results
      if (qdrantSearchUsed) {
        for (const [episodeId, score] of vectorSimilarityScores.entries()) {
          if (score >= 0.7) {
            params.highSimilarityIds.push(episodeId);
          } else if (score >= 0.5) {
            params.mediumSimilarityIds.push(episodeId);
          } else if (score >= 0.3) {
            params.lowSimilarityIds.push(episodeId);
          }
        }
      }

      // Add time range filter
      if (request.time_range) {
        cypherQuery += ` AND e.timestamp >= datetime($startTime)
                        AND e.timestamp <= datetime($endTime)`;
        params.startTime = request.time_range.start.toISOString();
        params.endTime = request.time_range.end.toISOString();
      }

      // Add type filter
      if (request.type_filter?.length) {
        cypherQuery += ` AND e.type IN $types`;
        params.types = request.type_filter;
      }

      // Add entity filter
      if (request.entity_filter?.length) {
        cypherQuery += `
          AND EXISTS {
            MATCH (e)-[:MENTIONS]->(entity:Entity)
            WHERE entity.name IN $entityNames
          }
        `;
        params.entityNames = request.entity_filter;
      }

      // First check if any episodes exist
      const countResult = await session.run('MATCH (e:Episode) RETURN count(e) as count');
      const episodeCount = countResult.records[0]?.get('count').toNumber() || 0;

      if (episodeCount === 0) {
        logger.warn('No episodes found in Neo4j database');
        return {
          episodes: [],
          entities: [],
          totalCount: 0,
          returnedCount: 0,
          estimatedTokens: 0,
          responseLevel: params.responseLevel || 'summary',
          tokenLimitReached: false
        };
      }

      // Validate search parameters
      if (!params.searchTerm || typeof params.searchTerm !== 'string') {
        throw new GraphitiError(
          'Invalid search term for episode recall',
          'INVALID_SEARCH_QUERY',
          { query: request.query }
        );
      }

      // Production-grade query with REAL vector similarity from Qdrant
      // Falls back to text matching if Qdrant search wasn't available
      const baseRelevanceCalculation = qdrantSearchUsed ? `
        WITH e,
             CASE
               WHEN e.id IN $highSimilarityIds THEN 0.95
               WHEN e.id IN $mediumSimilarityIds THEN 0.75
               WHEN e.id IN $lowSimilarityIds THEN 0.55
               WHEN e.has_embedding = true AND toLower(e.content) CONTAINS toLower($searchTerm) THEN 0.50
               WHEN e.has_embedding = true AND e.type = $episodeType THEN 0.40
               WHEN e.has_embedding = true THEN 0.30
               ELSE 0.20
             END as base_similarity,
             e.timestamp as episode_timestamp,
             COALESCE(e.decay_rate, 0.01) as episode_decay_rate
      ` : `
        WITH e,
             CASE
               WHEN e.has_embedding = true AND toLower(e.content) CONTAINS toLower($searchTerm)
               THEN 0.95
               WHEN e.has_embedding = true AND e.type = $episodeType
               THEN 0.80
               WHEN e.has_embedding = true
               THEN 0.70
               ELSE 0.50
             END as base_similarity,
             e.timestamp as episode_timestamp,
             COALESCE(e.decay_rate, 0.01) as episode_decay_rate
      `;

      // Set episode type parameter with defensive default
      params.episodeType = request.type_filter?.[0] || 'user_query';

      // Simple query without complex calculations
      cypherQuery += baseRelevanceCalculation + `
        ORDER BY base_similarity DESC
        LIMIT toInteger($maxResults * 2)  // Get extra results for post-processing

        OPTIONAL MATCH (e)-[r:TEMPORAL|CAUSAL|REFERENCE]->(connected:Episode)
        WITH e, base_similarity, episode_timestamp, episode_decay_rate,
             collect(DISTINCT connected) as connected_episodes

        OPTIONAL MATCH (e)-[:MENTIONS]->(entity:Entity)
        WITH e, base_similarity, episode_timestamp, episode_decay_rate, connected_episodes,
             collect(DISTINCT entity) as entities

        OPTIONAL MATCH (e)-[:HAS_FACT]->(fact:Fact)
        WITH e, base_similarity, episode_timestamp, episode_decay_rate, connected_episodes,
             entities, collect(DISTINCT fact)[0..5] as facts

        RETURN e as episode,
               base_similarity,
               episode_timestamp,
               episode_decay_rate,
               connected_episodes,
               entities,
               facts
      `;

      // No need to set params.now since we're not using it in the query
      params.includeDecay = request.include_decay ?? true;

      const result = await session.run(cypherQuery, params);

      // === TOKEN-AWARE RESPONSE BUILDING WITH HYBRID SCORING ===
      const allEpisodes: Array<ScoredEpisode & {
        entities?: ExtractedEntity[];
        facts?: ExtractedFact[];
      }> = [];

      const allEntities = new Map<string, ExtractedEntity>();

      // Process results with hybrid scoring in application layer
      for (const record of result.records) {
        try {
          const episodeNode = record.get('episode');
          if (!episodeNode) continue;

          const neo4jBaseSimilarity = record.get('base_similarity') || 0.5;
          const connectedEpisodes = record.get('connected_episodes') || [];
          const entities = record.get('entities') || [];
          const facts = record.get('facts') || [];

          const episode = this.nodeToEpisode(episodeNode);

          // Use REAL Qdrant vector similarity if available, otherwise use Neo4j fallback
          const actualVectorSimilarity = qdrantSearchUsed
            ? (vectorSimilarityScores.get(episode.id) ?? neo4jBaseSimilarity)
            : neo4jBaseSimilarity;

          // Parse entities first (needed for hybrid scoring)
          const episodeEntities: ExtractedEntity[] = [];
          for (const entityNode of entities) {
            if (entityNode) {
              const entity = this.nodeToEntity(entityNode);
              episodeEntities.push(entity);
              allEntities.set(entity.id, entity);
            }
          }

          // Parse facts
          const episodeFacts: ExtractedFact[] = [];
          for (const factNode of facts) {
            if (factNode) {
              try {
                const fact = this.nodeToFact(factNode);
                episodeFacts.push(fact);
              } catch (factError) {
                logger.warn('Failed to parse fact node', { error: factError });
              }
            }
          }

          // === HYBRID SCORING ===
          // Calculate comprehensive score using:
          // - Vector similarity (semantic) - 40% - NOW USES REAL QDRANT SCORES
          // - Entity overlap (knowledge graph) - 25%
          // - Temporal decay (recency) - 20%
          // - Importance/salience - 15%
          const episodeWithEntities = { ...episode, entities: episodeEntities };
          const scoreBreakdown = this.calculateHybridScore(
            episodeWithEntities,
            actualVectorSimilarity, // Use REAL Qdrant score, not text matching
            queryEntities,
            scoringWeights
          );

          // Use hybrid final score as relevance_score
          const finalScore = scoreBreakdown.final_score;
          const decayFactor = scoreBreakdown.recency_factor;

          allEpisodes.push({
            ...episode,
            relevance_score: finalScore,
            decay_factor: decayFactor,
            score_breakdown: scoreBreakdown,
            entities: episodeEntities,
            facts: episodeFacts,
            connected_episodes: connectedEpisodes
              .filter((n: any) => n != null)
              .map((n: any) => this.nodeToEpisode(n))
          });

        } catch (recordError) {
          logger.warn('Failed to process episode record', { error: recordError });
          // Continue processing other records
        }
      }

      // Sort by hybrid relevance score (higher = more relevant)
      allEpisodes.sort((a, b) => b.relevance_score - a.relevance_score);

      logger.debug('Hybrid scoring complete', {
        totalEpisodes: allEpisodes.length,
        queryEntitiesUsed: queryEntities.length,
        topScore: allEpisodes[0]?.relevance_score,
        bottomScore: allEpisodes[allEpisodes.length - 1]?.relevance_score
      });

      // === VOYAGE AI RERANKING ===
      // Apply reranking to top candidates for more accurate relevance scoring
      // This significantly improves retrieval quality (0.248 → 0.85+ for exact matches)
      const maxResults = request.max_results || 10;
      if (allEpisodes.length > 1 && this.embeddingClient) {
        try {
          // Cast to VoyageAIUnifiedClient to access rerank method
          const unifiedClient = this.embeddingClient as VoyageAIUnifiedClient;

          // Only rerank top candidates (3x requested limit for efficiency)
          const candidatesForRerank = allEpisodes.slice(0, Math.min(maxResults * 3, 30));
          const documents = candidatesForRerank.map(e => e.content);

          const reranked = await unifiedClient.rerank(
            request.query,
            documents,
            maxResults
          );

          // Reorder episodes based on rerank scores
          const rerankedEpisodes: typeof allEpisodes = [];
          for (const result of reranked) {
            const episode = candidatesForRerank[result.index];
            if (episode) {
              // Update relevance score with rerank score
              episode.relevance_score = result.score;
              (episode as any).original_hybrid_score = episode.score_breakdown?.final_score;
              (episode as any).ranking_method = 'voyage_rerank';
              rerankedEpisodes.push(episode);
            }
          }

          // Replace top episodes with reranked ones, keep rest as fallback
          const remainingEpisodes = allEpisodes.filter(
            e => !rerankedEpisodes.some(r => r.id === e.id)
          );
          allEpisodes.splice(0, allEpisodes.length, ...rerankedEpisodes, ...remainingEpisodes);

          logger.info('Voyage AI reranking applied', {
            candidatesReranked: candidatesForRerank.length,
            resultsReturned: rerankedEpisodes.length,
            topRerankScore: rerankedEpisodes[0]?.relevance_score,
            query: request.query.substring(0, 50)
          });
        } catch (rerankError: any) {
          // Log but don't fail - fall back to hybrid scoring
          logger.warn('Voyage AI reranking failed, using hybrid scoring', {
            error: rerankError.message,
            episodeCount: allEpisodes.length
          });
        }
      }

      // === BUILD TOKEN-AWARE RESPONSE BASED ON LEVEL ===
      const responseData = await this.buildTokenAwareResponse(
        allEpisodes,
        Array.from(allEntities.values()),
        responseLevel,
        tokenBudget,
        params.maxResults || 10,
        session,
        tenantContext
      );

      // Add hybrid scoring metadata to response
      return {
        ...responseData,
        query_entities: queryEntities,
        scoring_weights_used: scoringWeights
      };

    } catch (error) {
      logger.error('Failed to recall episodes', { error, request });
      throw new GraphitiError('Episode recall failed', 'RECALL_FAILED', error);
    } finally {
      await session.close();
    }
  }

  /**
   * Build token-aware response based on response level
   * ARCHITECTURE: Implements hierarchical disclosure pattern for token budget control
   * Phase 2: Now includes tenant context for temporal context filtering
   *
   * Strategy:
   * 1. Start with highest relevance episodes
   * 2. Convert to appropriate format (summary/medium/full)
   * 3. Allocate tokens and stop when budget exhausted
   * 4. Return metadata about truncation
   *
   * @private
   */
  private async buildTokenAwareResponse(
    allEpisodes: Array<ScoredEpisode & {
      entities?: ExtractedEntity[];
      facts?: ExtractedFact[];
    }>,
    allEntities: ExtractedEntity[],
    responseLevel: EpisodeResponseLevel,
    tokenBudget: TokenBudgetManager,
    maxResults: number,
    session: Session,
    tenantContext: EnhancedTenantContext
  ): Promise<RecallEpisodesResponse> {
    const includedEpisodes: any[] = [];
    let tokenLimitReached = false;
    let processedCount = 0;

    // Process episodes until token budget exhausted or max results reached
    for (const episode of allEpisodes) {
      if (processedCount >= maxResults) {
        break;
      }

      // Convert episode to appropriate format and estimate tokens
      let episodeData: any;
      let estimatedTokens: number;

      switch (responseLevel) {
        case 'summary':
          episodeData = this.episodeToSummary(episode);
          estimatedTokens = estimateObjectTokens(episodeData);
          break;

        case 'medium':
          episodeData = this.episodeToMedium(episode);
          estimatedTokens = estimateObjectTokens(episodeData);
          break;

        case 'full':
          episodeData = episode;
          estimatedTokens = estimateObjectTokens(episode);
          break;
      }

      // Try to allocate tokens for this episode
      if (tokenBudget.allocate(estimatedTokens)) {
        includedEpisodes.push(episodeData);
        processedCount++;
      } else {
        // Token budget exhausted
        tokenLimitReached = true;
        logger.warn('Token budget exhausted during episode recall', {
          processedCount,
          maxResults,
          budgetStats: tokenBudget.getStats()
        });
        break;
      }
    }

    // Get temporal context for first episode (always as summaries)
    let temporalContext;
    if (includedEpisodes.length > 0 && allEpisodes.length > 0) {
      const firstEpisode = allEpisodes[0];
      const contextEpisodes = await this.getTemporalContext(
        session,
        firstEpisode.id,
        firstEpisode.timestamp,
        tenantContext
      );

      // Convert temporal context to summaries to save tokens
      temporalContext = {
        before: contextEpisodes.before.map(e => this.episodeToSummary({
          ...e,
          relevance_score: 0.5,
          decay_factor: 1.0
        })),
        after: contextEpisodes.after.map(e => this.episodeToSummary({
          ...e,
          relevance_score: 0.5,
          decay_factor: 1.0
        }))
      };
    }

    // Filter entities based on response level - include entities at all levels
    // 'full': all entities with complete details
    // 'medium': top 10 entities with name and type only
    // 'summary': top 5 entity names only
    const includedEntities = responseLevel === 'full'
      ? allEntities
      : responseLevel === 'medium'
        ? allEntities.slice(0, 10).map(e => ({
            name: e.name,
            type: e.type,
            mention_count: e.mention_count
          }))
        : allEntities.slice(0, 5).map(e => ({
            name: e.name,
            type: e.type
          }));

    // Collect all facts from episodes and deduplicate
    const allFacts = new Map<string, ExtractedFact>();
    for (const episode of allEpisodes) {
      if (episode.facts) {
        for (const fact of episode.facts) {
          if (!allFacts.has(fact.id)) {
            allFacts.set(fact.id, fact);
          }
        }
      }
    }

    // Filter facts based on response level
    const factsArray = Array.from(allFacts.values());
    const includedFacts = responseLevel === 'full'
      ? factsArray
      : responseLevel === 'medium'
        ? factsArray.slice(0, 10).map(f => ({
            subject: f.subject,
            predicate: f.predicate,
            object: f.object,
            confidence: f.confidence
          }))
        : factsArray.slice(0, 5).map(f => `${f.subject} ${f.predicate} ${f.object}`);

    const budgetStats = tokenBudget.getStats();

    logger.info('Token-aware response built', {
      responseLevel,
      totalEpisodes: allEpisodes.length,
      includedEpisodes: includedEpisodes.length,
      includedFacts: includedFacts.length,
      tokenLimitReached,
      budgetStats
    });

    return {
      episodes: includedEpisodes,
      entities: includedEntities,
      facts: includedFacts,
      temporal_context: temporalContext,
      totalCount: allEpisodes.length,
      returnedCount: includedEpisodes.length,
      estimatedTokens: budgetStats.used,
      responseLevel,
      tokenLimitReached
    };
  }

  /**
   * Convert full episode to summary format (< 80 tokens)
   * @private
   */
  private episodeToSummary(episode: ScoredEpisode & {
    entities?: ExtractedEntity[];
  }): EpisodeSummary {
    return {
      id: episode.id,
      summary: episode.summary || generateSummary(episode.content, 50),  // Use stored LLM summary if available
      timestamp: episode.timestamp,
      type: episode.type,
      relevance_score: episode.relevance_score,
      decay_factor: episode.decay_factor,
      importance: episode.importance,
      entity_count: episode.entities?.length || 0,
      has_facts: (episode.facts?.length || 0) > 0
    };
  }

  /**
   * Convert full episode to medium format (< 200 tokens)
   * @private
   */
  private episodeToMedium(episode: ScoredEpisode & {
    entities?: ExtractedEntity[];
  }): EpisodeMedium {
    const summary = this.episodeToSummary(episode);

    // Get content preview (first 500 chars)
    const contentPreview = episode.content.length > 500
      ? episode.content.substring(0, 497) + '...'
      : episode.content;

    // Get top 5 entity names only
    const topEntities = (episode.entities || [])
      .slice(0, 5)
      .map(e => e.name);

    // Get metadata keys only (not values)
    const metadataKeys = Object.keys(episode.metadata || {});

    return {
      ...summary,
      content_preview: contentPreview,
      top_entities: topEntities,
      metadata_keys: metadataKeys
    };
  }

  /**
   * Get episode by ID
   * Phase 2: Now includes tenant + user context validation
   */
  async getEpisodeById(
    episodeId: string,
    tenantContext: EnhancedTenantContext
  ): Promise<Episode | null> {
    const session = this.driver.session();
    try {
      const result = await session.run(`
        MATCH (e:Episode {id: $id})
        WHERE e.company_id = $companyId
          AND e.app_id = $appId
          AND (e.user_id = $userId OR e.user_id = 'system')
        OPTIONAL MATCH (e)-[:MENTIONS]->(entity:Entity)
        OPTIONAL MATCH (e)-[:HAS_FACT]->(fact:Fact)
        RETURN e,
               collect(DISTINCT entity) as entities,
               collect(DISTINCT fact) as facts
      `, {
        id: episodeId,
        companyId: tenantContext.companyId,
        appId: tenantContext.appId,
        userId: tenantContext.userId
      });

      if (result.records.length === 0) {
        return null;
      }

      const record = result.records[0];
      const episode = this.nodeToEpisode(record.get('e'));

      const entities = record.get('entities').map((n: any) => this.nodeToEntity(n));
      const facts = record.get('facts').map((n: any) => this.nodeToFact(n));

      episode.entities = entities;
      episode.facts = facts;

      return episode;

    } finally {
      await session.close();
    }
  }

  /**
   * Update episode importance
   * Phase 2: Now includes tenant + user context validation
   */
  async updateEpisodeImportance(
    episodeId: string,
    importance: number,
    tenantContext: EnhancedTenantContext
  ): Promise<void> {
    if (importance < 0 || importance > 1) {
      throw new GraphitiError('Importance must be between 0 and 1', 'INVALID_IMPORTANCE');
    }

    const session = this.driver.session();
    try {
      const result = await session.run(`
        MATCH (e:Episode {id: $id})
        WHERE e.company_id = $companyId
          AND e.app_id = $appId
          AND (e.user_id = $userId OR e.user_id = 'system')
        SET e.importance = $importance,
            e.decay_rate = $decay_rate
        RETURN e
      `, {
        id: episodeId,
        importance,
        decay_rate: this.calculateDecayRate(importance),
        companyId: tenantContext.companyId,
        appId: tenantContext.appId,
        userId: tenantContext.userId
      });

      if (result.records.length === 0) {
        throw new EpisodeNotFoundError(episodeId);
      }

      logger.info('Episode importance updated', { episodeId, importance });

    } finally {
      await session.close();
    }
  }

  /**
   * Get entity by ID
   * Phase 2: Now includes tenant context validation
   */
  async getEntity(
    entityId: string,
    tenantContext: EnhancedTenantContext
  ): Promise<ExtractedEntity | null> {
    const session = this.driver.session();
    try {
      const result = await session.run(`
        MATCH (n:Entity {id: $id})
        WHERE n.company_id = $companyId
          AND n.app_id = $appId
        RETURN n
      `, {
        id: entityId,
        companyId: tenantContext.companyId,
        appId: tenantContext.appId
      });

      if (result.records.length === 0) {
        return null;
      }

      return this.nodeToEntity(result.records[0].get('n'));

    } finally {
      await session.close();
    }
  }

  /**
   * Merge multiple entities into one
   * Phase 2: Now includes tenant context validation
   */
  async mergeEntities(
    entityIds: string[],
    tenantContext: EnhancedTenantContext
  ): Promise<ExtractedEntity> {
    if (entityIds.length < 2) {
      throw new GraphitiError('At least 2 entities required for merge', 'INVALID_MERGE');
    }

    const session = this.driver.session();
    try {
      // Get all entities to merge (within tenant context)
      const result = await session.run(`
        MATCH (e:Entity)
        WHERE e.id IN $ids
          AND e.company_id = $companyId
          AND e.app_id = $appId
        RETURN e
      `, {
        ids: entityIds,
        companyId: tenantContext.companyId,
        appId: tenantContext.appId
      });

      if (result.records.length !== entityIds.length) {
        throw new EntityResolutionError('Some entities not found', entityIds);
      }

      const entities = result.records.map(r => this.nodeToEntity(r.get('e')));

      // Determine the primary entity (highest salience)
      const primaryEntity = entities.reduce((a, b) =>
        a.salience > b.salience ? a : b
      );

      // Collect all aliases
      const allAliases = new Set<string>();
      entities.forEach(e => {
        allAliases.add(e.name);
        e.aliases?.forEach(a => allAliases.add(a));
      });
      allAliases.delete(primaryEntity.name);

      // Update the primary entity with merged data
      await session.run(`
        MATCH (primary:Entity {id: $primaryId})
        MATCH (other:Entity)
        WHERE other.id IN $otherIds

        // Transfer all relationships to primary
        MATCH (other)<-[r:MENTIONS]-(e:Episode)
        MERGE (primary)<-[:MENTIONS]-(e)

        // Update primary entity
        SET primary.aliases = $aliases,
            primary.mention_count = primary.mention_count + $additionalMentions,
            primary.last_seen = datetime($lastSeen)

        // Delete other entities
        DETACH DELETE other

        RETURN primary
      `, {
        primaryId: primaryEntity.id,
        otherIds: entityIds.filter(id => id !== primaryEntity.id),
        aliases: Array.from(allAliases),
        additionalMentions: entities
          .filter(e => e.id !== primaryEntity.id)
          .reduce((sum, e) => sum + e.mention_count, 0),
        lastSeen: new Date().toISOString()
      });

      primaryEntity.aliases = Array.from(allAliases);
      logger.info('Entities merged successfully', {
        primaryId: primaryEntity.id,
        mergedCount: entityIds.length
      });

      return primaryEntity;

    } catch (error) {
      logger.error('Failed to merge entities', { error, entityIds });
      throw new EntityResolutionError('Merge failed', entityIds);
    } finally {
      await session.close();
    }
  }

  /**
   * Get entity history (all episodes mentioning the entity)
   * Phase 2: Now includes tenant + user context filtering
   */
  async getEntityHistory(
    entityId: string,
    tenantContext: EnhancedTenantContext
  ): Promise<Episode[]> {
    const session = this.driver.session();
    try {
      const result = await session.run(`
        MATCH (n:Entity {id: $id})<-[:MENTIONS]-(e:Episode)
        WHERE n.company_id = $companyId
          AND n.app_id = $appId
          AND e.company_id = $companyId
          AND e.app_id = $appId
          AND (e.user_id = $userId OR e.user_id = 'system')
        RETURN e
        ORDER BY e.timestamp DESC
      `, {
        id: entityId,
        companyId: tenantContext.companyId,
        appId: tenantContext.appId,
        userId: tenantContext.userId
      });

      return result.records.map(r => this.nodeToEpisode(r.get('e')));

    } finally {
      await session.close();
    }
  }

  /**
   * Get facts related to a subject or object
   * Phase 2: Now includes tenant context filtering
   */
  async getFacts(
    subjectOrObject: string,
    tenantContext: EnhancedTenantContext
  ): Promise<ExtractedFact[]> {
    const session = this.driver.session();
    try {
      const result = await session.run(`
        MATCH (f:Fact)
        WHERE (f.subject = $term OR f.object = $term)
          AND f.company_id = $companyId
          AND f.app_id = $appId
        RETURN f
        ORDER BY f.confidence DESC
      `, {
        term: subjectOrObject,
        companyId: tenantContext.companyId,
        appId: tenantContext.appId
      });

      return result.records.map(r => this.nodeToFact(r.get('f')));

    } finally {
      await session.close();
    }
  }

  /**
   * Validate or invalidate a fact
   * Phase 2: Now includes tenant context validation
   */
  async validateFact(
    factId: string,
    isValid: boolean,
    tenantContext: EnhancedTenantContext
  ): Promise<void> {
    const session = this.driver.session();
    try {
      const result = await session.run(`
        MATCH (f:Fact {id: $id})
        WHERE f.company_id = $companyId
          AND f.app_id = $appId
        SET f.is_valid = $isValid,
            f.validated_at = datetime($now)
        RETURN f
      `, {
        id: factId,
        isValid,
        now: new Date().toISOString(),
        companyId: tenantContext.companyId,
        appId: tenantContext.appId
      });

      if (result.records.length === 0) {
        throw new GraphitiError('Fact not found', 'FACT_NOT_FOUND', { factId });
      }

      logger.info('Fact validation updated', { factId, isValid });

    } finally {
      await session.close();
    }
  }

  /**
   * Get temporal path between two episodes
   * Phase 2: Now includes tenant + user context filtering
   */
  async getTemporalPath(
    startEpisodeId: string,
    endEpisodeId: string,
    tenantContext: EnhancedTenantContext
  ): Promise<Episode[]> {
    const session = this.driver.session();
    try {
      const result = await session.run(`
        MATCH path = shortestPath(
          (start:Episode {id: $startId})-[:TEMPORAL*]-(end:Episode {id: $endId})
        )
        WHERE all(node IN nodes(path) WHERE
          node.company_id = $companyId
          AND node.app_id = $appId
          AND (node.user_id = $userId OR node.user_id = 'system')
        )
        RETURN nodes(path) as episodes
      `, {
        startId: startEpisodeId,
        endId: endEpisodeId,
        companyId: tenantContext.companyId,
        appId: tenantContext.appId,
        userId: tenantContext.userId
      });

      if (result.records.length === 0) {
        return [];
      }

      const episodes = result.records[0].get('episodes');
      return episodes.map((n: any) => this.nodeToEpisode(n));

    } finally {
      await session.close();
    }
  }

  /**
   * Get causal chain from an episode
   * Phase 2: Now includes tenant + user context filtering
   */
  async getCausalChain(
    episodeId: string,
    tenantContext: EnhancedTenantContext,
    depth: number = 3
  ): Promise<Episode[]> {
    const session = this.driver.session();
    try {
      const result = await session.run(`
        MATCH path = (start:Episode {id: $id})-[:CAUSAL*1..$depth]->(effect:Episode)
        WHERE start.company_id = $companyId
          AND start.app_id = $appId
          AND (start.user_id = $userId OR start.user_id = 'system')
          AND effect.company_id = $companyId
          AND effect.app_id = $appId
          AND (effect.user_id = $userId OR effect.user_id = 'system')
        RETURN DISTINCT effect
        ORDER BY length(path)
      `, {
        id: episodeId,
        depth,
        companyId: tenantContext.companyId,
        appId: tenantContext.appId,
        userId: tenantContext.userId
      });

      return result.records.map(r => this.nodeToEpisode(r.get('effect')));

    } finally {
      await session.close();
    }
  }

  /**
   * Consolidate old memories based on importance and decay
   * Phase 2: Now includes tenant context filtering
   */
  async consolidateMemories(
    before: Date,
    tenantContext: EnhancedTenantContext
  ): Promise<number> {
    const session = this.driver.session();
    try {
      // Find episodes to consolidate (within tenant context)
      const result = await session.run(`
        MATCH (e:Episode)
        WHERE e.timestamp < datetime($before)
        AND e.importance < $threshold
        AND e.company_id = $companyId
        AND e.app_id = $appId
        WITH e,
             duration.between(e.timestamp, datetime($now)).days as daysOld,
             e.importance * exp(-e.decay_rate * duration.between(e.timestamp, datetime($now)).days) as current_importance
        WHERE current_importance < $consolidation_threshold
        RETURN e
      `, {
        before: before.toISOString(),
        now: new Date().toISOString(),
        threshold: this.config.memory.importance_threshold,
        consolidation_threshold: 0.1,
        companyId: tenantContext.companyId,
        appId: tenantContext.appId
      });

      if (result.records.length === 0) {
        return 0;
      }

      // Group similar episodes
      const episodes = result.records.map(r => this.nodeToEpisode(r.get('e')));
      const groups = await this.groupSimilarEpisodes(session, episodes, tenantContext);

      // Create summary episodes for each group
      let consolidatedCount = 0;
      for (const group of groups) {
        if (group.length > 1) {
          await this.createSummaryEpisode(session, group, tenantContext);

          // Mark original episodes as consolidated
          await session.run(`
            MATCH (e:Episode)
            WHERE e.id IN $ids
            SET e.consolidated = true,
                e.consolidated_at = datetime($now)
          `, {
            ids: group.map(e => e.id),
            now: new Date().toISOString()
          });

          consolidatedCount += group.length;
        }
      }

      logger.info('Memory consolidation completed', {
        consolidatedCount,
        beforeDate: before
      });

      return consolidatedCount;

    } catch (error) {
      logger.error('Memory consolidation failed', { error, before });
      throw new GraphitiError('Consolidation failed', 'CONSOLIDATION_FAILED', error);
    } finally {
      await session.close();
    }
  }

  /**
   * Store episode without embedding (fallback method)
   * Phase 2: Now includes tenant + user context
   * Phase 4: Added LLM-based summarization
   * FIXED: Now actually stores entities and facts (was previously ignored!)
   */
  private async storeEpisodeWithoutEmbedding(
    session: any,
    episodeId: string,
    request: StoreEpisodeRequest,
    entities: ExtractedEntity[],
    facts: ExtractedFact[],
    timestamp: Date,
    tenantContext: EnhancedTenantContext
  ): Promise<StoreEpisodeResponse> {
    try {
      // Generate content hash for deduplication
      const contentHash = this.generateContentHash(request.content);

      // Generate LLM-based summary for the episode
      const episodeType = request.type || 'user_query';
      const summary = await this.generateEpisodeSummary(request.content, episodeType);

      // Create episode without embedding but with tenant context, content hash, and summary
      await session.run(`
        CREATE (e:Episode {
          id: $id,
          content: $content,
          content_hash: $contentHash,
          summary: $summary,
          timestamp: datetime($timestamp),
          type: $type,
          importance: $importance,
          decay_rate: $decay_rate,
          has_embedding: false,
          company_id: $companyId,
          app_id: $appId,
          user_id: $userId,
          session_id: $sessionId
        })
        RETURN e
      `, {
        id: episodeId,
        content: request.content,
        contentHash,
        summary,  // LLM-generated summary
        timestamp: timestamp.toISOString(),
        type: request.type || 'user_query',
        importance: 0.5,
        decay_rate: 0.01,
        companyId: tenantContext.companyId,
        appId: tenantContext.appId,
        userId: tenantContext.userId,
        sessionId: tenantContext.sessionId || null
      });

      // CRITICAL FIX: Actually store entities
      // NOTE: Neo4j sessions are NOT thread-safe - must execute sequentially on same session
      const storedEntities: ExtractedEntity[] = [];
      for (const entity of entities) {
        try {
          const stored = await this.storeOrUpdateEntity(session, entity, episodeId, tenantContext);
          storedEntities.push(stored);
        } catch (err: any) {
          logger.warn('Failed to store entity in fallback path', {
            episodeId,
            entityName: entity.name,
            error: err.message
          });
        }
      }

      // CRITICAL FIX: Actually store facts
      // NOTE: Neo4j sessions are NOT thread-safe - must execute sequentially on same session
      const storedFacts: ExtractedFact[] = [];
      for (const fact of facts) {
        try {
          const stored = await this.storeFact(session, fact, tenantContext);
          storedFacts.push(stored);
        } catch (err: any) {
          logger.warn('Failed to store fact in fallback path', {
            episodeId,
            factSubject: fact.subject,
            error: err.message
          });
        }
      }

      // Create temporal edges (was also missing!)
      let edges: any[] = [];
      try {
        edges = await this.createTemporalEdges(session, episodeId, timestamp, tenantContext);
      } catch (err: any) {
        logger.warn('Failed to create temporal edges in fallback path', {
          episodeId,
          error: err.message
        });
      }

      logger.info('Episode stored successfully (without embedding)', {
        episodeId,
        entities: storedEntities.length,
        facts: storedFacts.length,
        edges: edges.length
      });

      return {
        episode_id: episodeId,
        entities_extracted: storedEntities,
        facts_extracted: storedFacts,
        edges_created: edges,
        entities: storedEntities,
        facts: storedFacts,
        importance: 0.5
      };
    } catch (error: any) {
      throw new GraphitiError(
        'Failed to store episode without embedding',
        'STORE_FAILED_NO_EMBEDDING',
        { error: error.message }
      );
    }
  }

  /**
   * Get memory statistics
   * Phase 2: Now includes tenant context filtering
   */
  async getMemoryStats(
    tenantContext: EnhancedTenantContext
  ): Promise<{
    total_episodes: number;
    total_entities: number;
    total_facts: number;
    avg_importance: number;
    memory_health: number;
  }> {
    const session = this.driver.session();
    try {
      const result = await session.run(`
        MATCH (e:Episode)
        WHERE e.company_id = $companyId AND e.app_id = $appId
        WITH count(e) as episode_count, avg(e.importance) as avg_importance
        MATCH (n:Entity)
        WHERE n.company_id = $companyId AND n.app_id = $appId
        WITH episode_count, avg_importance, count(n) as entity_count
        MATCH (f:Fact)
        WHERE f.company_id = $companyId AND f.app_id = $appId
        WITH episode_count, avg_importance, entity_count, count(f) as fact_count

        // Calculate memory health based on various factors
        WITH episode_count, entity_count, fact_count, avg_importance,
             CASE
               WHEN episode_count = 0 THEN 0
               WHEN episode_count > $max_episodes THEN 0.5
               ELSE 1.0
             END * avg_importance as memory_health

        RETURN episode_count, entity_count, fact_count, avg_importance, memory_health
      `, {
        max_episodes: this.config.memory.max_episodes,
        companyId: tenantContext.companyId,
        appId: tenantContext.appId
      });

      if (result.records.length === 0) {
        return {
          total_episodes: 0,
          total_entities: 0,
          total_facts: 0,
          avg_importance: 0,
          memory_health: 0
        };
      }

      const record = result.records[0];
      return {
        total_episodes: record.get('episode_count').toNumber(),
        total_entities: record.get('entity_count').toNumber(),
        total_facts: record.get('fact_count').toNumber(),
        avg_importance: record.get('avg_importance'),
        memory_health: record.get('memory_health')
      };

    } finally {
      await session.close();
    }
  }

  // Private helper methods

  // ============================================
  // HYBRID SCORING SYSTEM
  // ============================================

  /**
   * Calculate hybrid relevance score using multiple signals
   *
   * Formula: score = (w1 * vector_similarity) + (w2 * entity_relevance) + (w3 * recency_factor) + (w4 * importance)
   *
   * Where:
   * - vector_similarity: 0-1 from semantic search
   * - entity_relevance: count of matching entities / total entities in query
   * - recency_factor: exponential decay (1.0 for today, ~0.5 for 7 days ago)
   * - importance: stored importance value (0-1)
   *
   * @param episode - The episode to score
   * @param vectorSimilarity - Raw vector similarity from embedding search (0-1)
   * @param queryEntities - Entities extracted from the query
   * @param weights - Configurable scoring weights
   * @returns HybridScoreBreakdown with all components and final score
   */
  private calculateHybridScore(
    episode: Episode & { entities?: ExtractedEntity[] },
    vectorSimilarity: number,
    queryEntities: string[],
    weights: HybridScoringWeights
  ): HybridScoreBreakdown {
    // 1. Vector similarity (already normalized 0-1)
    const normalizedVectorSimilarity = Math.max(0, Math.min(1, vectorSimilarity));

    // 2. Entity relevance: count of matching entities / total query entities
    const entityRelevance = this.calculateEntityOverlap(episode.entities || [], queryEntities);

    // 3. Recency factor: exponential decay based on age
    // Formula: e^(-days/halfLife) where halfLife = 7 days (0.5 at 7 days)
    const recencyFactor = this.calculateRecencyFactor(episode.timestamp);

    // 4. Importance: use stored importance or default to 0.5
    const importanceScore = Math.max(0, Math.min(1, episode.importance || 0.5));

    // Calculate weighted final score
    const finalScore =
      weights.vector_similarity * normalizedVectorSimilarity +
      weights.entity_relevance * entityRelevance +
      weights.recency_factor * recencyFactor +
      weights.importance * importanceScore;

    return {
      vector_similarity: normalizedVectorSimilarity,
      entity_relevance: entityRelevance,
      recency_factor: recencyFactor,
      importance: importanceScore,
      final_score: Math.max(0, Math.min(1, finalScore)), // Clamp to 0-1
      weights_applied: weights
    };
  }

  /**
   * Calculate entity overlap between episode entities and query entities
   *
   * @param episodeEntities - Entities associated with the episode
   * @param queryEntities - Entities extracted from the search query
   * @returns Score 0-1 representing entity overlap
   */
  private calculateEntityOverlap(
    episodeEntities: ExtractedEntity[],
    queryEntities: string[]
  ): number {
    if (queryEntities.length === 0) {
      // No query entities to match against - return neutral score
      return 0.5;
    }

    if (episodeEntities.length === 0) {
      // Episode has no entities - return low score
      return 0.1;
    }

    // Create lowercase set for case-insensitive matching
    const queryEntitySet = new Set(queryEntities.map(e => e.toLowerCase()));
    const episodeEntityNames = episodeEntities.map(e => e.name.toLowerCase());

    // Count matches
    let matchCount = 0;
    for (const entityName of episodeEntityNames) {
      // Check direct match
      if (queryEntitySet.has(entityName)) {
        matchCount++;
        continue;
      }
      // Check partial match (entity contains query term or vice versa)
      for (const queryEntity of queryEntitySet) {
        if (entityName.includes(queryEntity) || queryEntity.includes(entityName)) {
          matchCount += 0.5; // Partial match gets half credit
          break;
        }
      }
    }

    // Normalize by query entity count
    // Use Math.min to cap at 1.0 (episodes with many matching entities shouldn't exceed 1)
    return Math.min(1, matchCount / queryEntities.length);
  }

  /**
   * Calculate recency factor using exponential decay
   *
   * Formula: e^(-days/halfLife) where halfLife is tuned for 7-day half-life
   * Result: 1.0 for today, ~0.5 for 7 days ago, ~0.25 for 14 days ago
   *
   * @param timestamp - Episode timestamp
   * @param halfLifeDays - Number of days for score to decay to 0.5 (default: 7)
   * @returns Recency score 0-1
   */
  private calculateRecencyFactor(timestamp: Date, halfLifeDays: number = 7): number {
    const now = new Date();
    const episodeTime = timestamp instanceof Date ? timestamp : new Date(timestamp);

    // Calculate days since episode
    const msSinceEpisode = now.getTime() - episodeTime.getTime();
    const daysSinceEpisode = Math.max(0, msSinceEpisode / (1000 * 60 * 60 * 24));

    // Exponential decay: e^(-days * ln(2) / halfLife)
    // This ensures score = 0.5 at exactly halfLifeDays
    const decayConstant = Math.log(2) / halfLifeDays;
    const recencyFactor = Math.exp(-daysSinceEpisode * decayConstant);

    // Clamp to reasonable bounds (minimum 0.01 for very old episodes)
    return Math.max(0.01, Math.min(1, recencyFactor));
  }

  /**
   * Extract entities from a query string for overlap calculation
   * Uses lightweight extraction focused on finding matching terms
   *
   * @param query - Search query string
   * @returns Array of entity names found in query
   */
  private extractQueryEntities(query: string): string[] {
    const entities: string[] = [];

    // 1. Extract capitalized words/phrases (proper nouns)
    const capitalizedWords = query.match(/[A-Z][a-z]+(?:\s+[A-Z][a-z]+)*/g) || [];
    for (const word of capitalizedWords) {
      if (!this.isStopword(word) && word.length >= 3) {
        entities.push(word);
      }
    }

    // 2. Extract quoted strings (explicit entities)
    const quotedStrings = query.match(/"([^"]+)"|'([^']+)'/g) || [];
    for (const quoted of quotedStrings) {
      const cleaned = quoted.replace(/["']/g, '').trim();
      if (cleaned.length >= 2) {
        entities.push(cleaned);
      }
    }

    // 3. Extract technical terms (camelCase, snake_case, PascalCase)
    const technicalTerms = query.match(/[a-z]+[A-Z][a-zA-Z]*|[a-z]+_[a-z]+|[A-Z][a-zA-Z]*[A-Z][a-zA-Z]*/g) || [];
    for (const term of technicalTerms) {
      if (term.length >= 3) {
        entities.push(term);
      }
    }

    // 4. Extract significant words (longer words that might be domain terms)
    const words = query.toLowerCase().split(/\s+/);
    for (const word of words) {
      // Words 6+ characters that aren't common English words
      if (word.length >= 6 && !this.isCommonWord(word)) {
        entities.push(word);
      }
    }

    // Return unique entities
    return [...new Set(entities)];
  }

  /**
   * Check if a word is a common English word (not a significant entity)
   */
  private isCommonWord(word: string): boolean {
    const commonWords = new Set([
      'about', 'above', 'after', 'again', 'against', 'because', 'before',
      'between', 'during', 'except', 'inside', 'outside', 'should', 'through',
      'under', 'until', 'where', 'which', 'while', 'without', 'within',
      'would', 'could', 'might', 'please', 'thanks', 'really', 'always',
      'never', 'sometimes', 'usually', 'already', 'another', 'around',
      'become', 'before', 'behind', 'believe', 'besides', 'better', 'between'
    ]);
    return commonWords.has(word.toLowerCase());
  }

  /**
   * Merge custom scoring weights with defaults
   */
  private mergeWeights(customWeights?: Partial<HybridScoringWeights>): HybridScoringWeights {
    if (!customWeights) {
      return { ...DEFAULT_SCORING_WEIGHTS };
    }

    const merged = { ...DEFAULT_SCORING_WEIGHTS, ...customWeights };

    // Validate weights sum to approximately 1.0
    const sum = merged.vector_similarity + merged.entity_relevance +
                merged.recency_factor + merged.importance;

    if (Math.abs(sum - 1.0) > 0.01) {
      logger.warn('Hybrid scoring weights do not sum to 1.0, normalizing', {
        original: customWeights,
        sum
      });
      // Normalize weights to sum to 1.0
      merged.vector_similarity /= sum;
      merged.entity_relevance /= sum;
      merged.recency_factor /= sum;
      merged.importance /= sum;
    }

    return merged;
  }

  // ============================================
  // END HYBRID SCORING SYSTEM
  // ============================================

  /**
   * Extract entities from content using LLM-based extraction with regex fallback
   * Uses Claude Haiku via OpenRouter for intelligent entity recognition
   */
  private async extractEntities(content: string, preIdentified?: string[]): Promise<ExtractedEntity[]> {
    let entities: ExtractedEntity[] = [];

    // Try LLM-based extraction first if OpenRouter is available
    if (this.openRouterClient) {
      try {
        const llmEntities = await this.extractEntitiesLLM(content);
        if (llmEntities.length > 0) {
          // Merge with pre-identified entities
          entities = this.mergeWithPreIdentified(llmEntities, preIdentified, content);
        }
      } catch (error) {
        logger.warn('LLM entity extraction failed, falling back to regex', { error });
      }
    }

    // Fallback to regex-based extraction if LLM didn't produce results
    if (entities.length === 0) {
      entities = this.extractEntitiesWithRegex(content, preIdentified);
    }

    // TEMPORAL EXTRACTION: Extract dates, durations, recurring patterns
    // This runs AFTER LLM/regex extraction to add temporal entities
    if (this.temporalExtractor) {
      const temporalEntities = this.temporalExtractor.extract(content);
      const now = new Date();

      for (const temporal of temporalEntities) {
        // Avoid duplicates - check if we already have this temporal entity
        const exists = entities.some(e =>
          e.type === 'temporal' && e.name === temporal.text
        );

        if (!exists) {
          entities.push({
            id: uuidv4(),
            name: temporal.text,
            type: 'temporal',
            confidence: temporal.confidence,
            first_seen: now,
            last_seen: now,
            mention_count: 1,
            salience: 0.6, // Temporal entities have moderate importance
            temporalType: temporal.type,
            normalizedValue: temporal.normalizedValue,
            attributes: {
              position: temporal.position,
              extractionMethod: 'temporal'
            }
          });
        }
      }

      if (temporalEntities.length > 0) {
        logger.debug('[TEMPORAL-EXTRACTION] Extracted temporal entities', {
          count: temporalEntities.length,
          types: temporalEntities.map(t => t.type)
        });
      }
    }

    return entities;
  }

  /**
   * LLM-based entity extraction using Claude Haiku via OpenRouter
   * Provides smarter extraction with proper typing and confidence scores
   */
  /**
   * Extract entities using LLM - public for async worker access
   */
  public async extractEntitiesLLM(content: string): Promise<ExtractedEntity[]> {
    if (!this.openRouterClient) {
      return [];
    }

    // Truncate content to avoid token limits (max ~2000 chars for entity extraction)
    const truncatedContent = content.length > 2000
      ? content.substring(0, 2000) + '...'
      : content;

    const systemPrompt = `You are an expert entity extractor for a knowledge graph system. Extract named entities from the provided text.

ENTITY TYPES:
- person: Real people (e.g., "John Smith", "Elon Musk")
- organization: Companies, teams, institutions (e.g., "Google", "MIT", "Anthropic")
- location: Geographic places (e.g., "New York", "Silicon Valley")
- technology: Programming languages, frameworks, tools, platforms (e.g., "TypeScript", "React", "Docker", "PostgreSQL")
- file: File paths, file names, modules (e.g., "package.json", "index.ts", "/src/utils/helper.ts")
- function: Function names, method names, class names (e.g., "handleClick", "useState", "UserService")
- concept: Abstract concepts, patterns, methodologies (e.g., "microservices", "machine learning", "SOLID principles")
- other: Entities that don't fit other categories

EXTRACTION RULES:
1. Extract SPECIFIC named entities only - not generic terms
2. Skip common words, articles, pronouns, and stopwords
3. For code-related content, prioritize: files, functions, technologies
4. Assign confidence 0.0-1.0 based on how certain you are about the entity and type
5. Only extract entities mentioned in the text, don't infer or add external knowledge
6. Skip entities shorter than 3 characters
7. Prefer the most specific type (e.g., "React" is technology, not organization)

Return ONLY valid JSON object with entities array:
{"entities": [{"name": "EntityName", "type": "type", "confidence": 0.9}, ...]}

If no entities found, return: {"entities": []}`;

    const userPrompt = `Extract entities from this text:\n\n${truncatedContent}`;

    try {
      const response = await this.openRouterClient.post('/chat/completions', {
        model: 'anthropic/claude-3-5-haiku-20241022',  // Haiku: 3x faster for entity extraction
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt }
        ],
        temperature: 0.1,
        max_tokens: 1000
      });

      const messageContent = response.data?.choices?.[0]?.message?.content;
      if (!messageContent) {
        logger.debug('No content in LLM entity extraction response');
        return [];
      }

      // Parse the JSON response
      let parsedEntities: Array<{ name: string; type: string; confidence: number }>;
      try {
        // Handle both array and object responses
        const parsed = JSON.parse(messageContent);
        parsedEntities = Array.isArray(parsed) ? parsed : (parsed.entities || []);
      } catch (parseError) {
        // Try to extract JSON array from the response
        const jsonMatch = messageContent.match(/\[[\s\S]*\]/);
        if (jsonMatch) {
          parsedEntities = JSON.parse(jsonMatch[0]);
        } else {
          logger.debug('Could not parse LLM entity response', { content: messageContent });
          return [];
        }
      }

      // Convert to ExtractedEntity format
      const entities: ExtractedEntity[] = [];
      const validTypes = ['person', 'organization', 'location', 'concept', 'technology', 'file', 'function', 'other'];

      for (const entity of parsedEntities) {
        if (!entity.name || entity.name.length < 3) continue;

        // Validate and normalize type
        const type = validTypes.includes(entity.type)
          ? entity.type as ExtractedEntity['type']
          : 'other';

        // Validate confidence (use configurable threshold)
        const classificationConfig = getClassificationConfig();
        const confidence = typeof entity.confidence === 'number'
          ? Math.max(0, Math.min(1, entity.confidence))
          : classificationConfig.thresholds.mediumConfidence;

        // Skip low confidence entities (configurable threshold)
        if (confidence < classificationConfig.entity.minConfidence) {
          logger.info('Entity filtered: low confidence', {
            name: entity.name,
            type: entity.type,
            confidence,
            threshold: classificationConfig.entity.minConfidence
          });
          continue;
        }

        entities.push({
          id: uuidv4(),
          name: entity.name,
          type,
          confidence,
          first_seen: new Date(),
          last_seen: new Date(),
          mention_count: 1,
          salience: this.calculateSalience(entity.name, content)
        });
      }

      logger.debug('LLM entity extraction completed (pre-validation)', {
        inputLength: content.length,
        entitiesFound: entities.length
      });

      // CRITICAL FIX: Apply stopword validation to LLM output
      // The LLM is instructed to filter stopwords, but we must verify
      const validated = this.validateAndFilterEntities(entities, 'llm');

      logger.debug('LLM entity extraction completed (post-validation)', {
        beforeValidation: entities.length,
        afterValidation: validated.length
      });

      // PHASE 6: Apply semantic classification to refine entity types
      // This uses Voyage AI rerank-2.5 for superior accuracy
      if (this.semanticClassificationEnabled && this.semanticClassifier) {
        logger.debug('[SEMANTIC-CLASSIFICATION] Reclassifying LLM entities with Voyage AI reranking');

        const reclassifiedEntities: ExtractedEntity[] = [];
        for (const entity of validated) {
          try {
            const semanticResult = await this.classifyEntityTypeSemantic(entity.name, content);
            reclassifiedEntities.push({
              ...entity,
              type: semanticResult.type,
              confidence: Math.max(entity.confidence, semanticResult.confidence)
            });
          } catch (classificationError: any) {
            // Keep original type if semantic classification fails
            reclassifiedEntities.push(entity);
          }
        }

        logger.debug('[SEMANTIC-CLASSIFICATION] Reclassification complete', {
          entitiesProcessed: reclassifiedEntities.length
        });

        // Limit to configurable max entities by salience
        const entityConfig = getClassificationConfig().entity;
        return reclassifiedEntities
          .sort((a, b) => b.salience - a.salience)
          .slice(0, entityConfig.maxPerEpisode);
      }

      // Fallback: No semantic classification, use LLM types as-is
      const entityConfig = getClassificationConfig().entity;
      return validated
        .sort((a, b) => b.salience - a.salience)
        .slice(0, entityConfig.maxPerEpisode);

    } catch (error: any) {
      logger.warn('LLM entity extraction API call failed', {
        error: error.message,
        status: error.response?.status
      });
      throw error;
    }
  }

  /**
   * Merge LLM-extracted entities with pre-identified entities
   * FIXED: Now validates pre-identified entities against stopwords
   */
  private mergeWithPreIdentified(
    llmEntities: ExtractedEntity[],
    preIdentified: string[] | undefined,
    content: string
  ): ExtractedEntity[] {
    const entities = [...llmEntities];
    let skippedCount = 0;

    if (preIdentified) {
      for (const name of preIdentified) {
        // Length check
        if (name.length < 3) {
          skippedCount++;
          continue;
        }

        // CRITICAL FIX: Validate pre-identified entities against stopwords
        if (this.isStopword(name)) {
          logger.debug('Pre-identified entity filtered: stopword', { name });
          skippedCount++;
          continue;
        }

        // CRITICAL FIX: Validate against non-entity phrases
        if (this.isNonEntityPhrase(name)) {
          logger.debug('Pre-identified entity filtered: non-entity phrase', { name });
          skippedCount++;
          continue;
        }

        // Check if already exists
        if (!entities.find(e => e.name.toLowerCase() === name.toLowerCase())) {
          const type = this.classifyEntityType(name);
          entities.push({
            id: uuidv4(),
            name,
            type,
            confidence: 1.0, // Pre-identified entities get high confidence
            first_seen: new Date(),
            last_seen: new Date(),
            mention_count: 1,
            salience: this.calculateSalience(name, content)
          });
        }
      }

      if (skippedCount > 0) {
        logger.info('Pre-identified entities filtered', {
          total: preIdentified.length,
          skipped: skippedCount,
          accepted: preIdentified.length - skippedCount
        });
      }
    }

    // Re-sort and limit (configurable)
    const entityConfig = getClassificationConfig().entity;
    return entities
      .sort((a, b) => b.salience - a.salience)
      .slice(0, entityConfig.maxPerEpisode);
  }

  /**
   * Regex-based entity extraction (fallback method)
   * Used when LLM is unavailable or fails
   */
  private extractEntitiesWithRegex(content: string, preIdentified?: string[]): ExtractedEntity[] {
    const entities: ExtractedEntity[] = [];

    // Extract capitalized words as potential entities
    const words = content.match(/[A-Z][a-z]+(?:\s+[A-Z][a-z]+)*/g) || [];
    const uniqueWords = [...new Set(words)];

    for (const word of uniqueWords) {
      // Skip if it's a stopword
      if (this.isStopword(word)) {
        continue;
      }

      // Skip if too short (less than 3 characters)
      if (word.length < 3) {
        continue;
      }

      // Skip if it looks like a common phrase that's not an entity
      if (this.isNonEntityPhrase(word)) {
        continue;
      }

      const type = this.classifyEntityType(word);
      const confidence = this.calculateEntityConfidence(word, type);

      entities.push({
        id: uuidv4(),
        name: word,
        type,
        confidence,
        first_seen: new Date(),
        last_seen: new Date(),
        mention_count: 1,
        salience: this.calculateSalience(word, content)
      });
    }

    // Add pre-identified entities if provided (these bypass stopword filter)
    if (preIdentified) {
      for (const name of preIdentified) {
        // Skip if too short
        if (name.length < 3) continue;

        if (!entities.find(e => e.name.toLowerCase() === name.toLowerCase())) {
          const type = this.classifyEntityType(name);
          entities.push({
            id: uuidv4(),
            name,
            type,
            confidence: 1.0,
            first_seen: new Date(),
            last_seen: new Date(),
            mention_count: 1,
            salience: 0.8
          });
        }
      }
    }

    // Limit entities by salience to prevent noise (configurable)
    const entityConfig = getClassificationConfig().entity;
    return entities
      .sort((a, b) => b.salience - a.salience)
      .slice(0, entityConfig.maxPerEpisode);
  }

  /**
   * Check if a word is a stopword that shouldn't be an entity
   */
  private isStopword(word: string): boolean {
    const lowerWord = word.toLowerCase();

    // Check single words
    const words = lowerWord.split(/\s+/);
    for (const w of words) {
      if (ENTITY_STOPWORDS.has(w)) {
        return true;
      }
    }

    // Check the full phrase
    if (ENTITY_STOPWORDS.has(lowerWord)) {
      return true;
    }

    return false;
  }

  /**
   * Check if a phrase is a non-entity pattern (e.g., "Executive Summary", "Data Type")
   */
  private isNonEntityPhrase(phrase: string): boolean {
    const lower = phrase.toLowerCase();

    // Common non-entity patterns
    const nonEntityPatterns = [
      /^(add|create|update|delete|get|set|run|execute)\s+\w+$/i,
      /^(key|data|file|code|type|class|method|function|variable)\s+\w+$/i,
      /^\w+\s+(type|types|summary|overview|example|examples)$/i,
      /^(complete|appropriate|final|first|last|main|new|old)\s+\w+$/i,
      /^(the|a|an)\s+\w+$/i
    ];

    for (const pattern of nonEntityPatterns) {
      if (pattern.test(lower)) {
        return true;
      }
    }

    return false;
  }

  /**
   * Validate and filter entities against stopwords - defense-in-depth for LLM output
   * This is the critical validation layer that ensures garbage entities don't reach storage
   * Now includes Prometheus metrics tracking for observability
   */
  private validateAndFilterEntities(
    entities: ExtractedEntity[],
    source: 'llm' | 'regex' | 'pre-identified'
  ): ExtractedEntity[] {
    const metrics = getClassificationMetrics();
    const filtered: ExtractedEntity[] = [];
    const seen = new Set<string>();

    // Track filtering stats for batch metrics
    const filterStats = {
      stopword: 0,
      nonEntityPhrase: 0,
      duplicate: 0,
      tooShort: 0,
      numeric: 0,
      lowConfidence: 0
    };

    for (const entity of entities) {
      const nameLower = entity.name.toLowerCase().trim();

      // Skip duplicates (case-insensitive)
      if (seen.has(nameLower)) {
        logger.debug('Entity filtered: duplicate', { name: entity.name, source });
        filterStats.duplicate++;
        continue;
      }

      // Skip stopwords - THE CRITICAL CHECK that was missing from LLM path
      if (this.isStopword(entity.name)) {
        logger.debug('Entity filtered: stopword', { name: entity.name, source });
        filterStats.stopword++;
        continue;
      }

      // Skip non-entity phrases
      if (this.isNonEntityPhrase(entity.name)) {
        logger.debug('Entity filtered: non-entity phrase', { name: entity.name, source });
        filterStats.nonEntityPhrase++;
        continue;
      }

      // Skip very short names (redundant with earlier checks but defense-in-depth)
      if (entity.name.length < 3) {
        logger.debug('Entity filtered: too short', { name: entity.name, source });
        filterStats.tooShort++;
        continue;
      }

      // Skip names that are just numbers
      if (/^\d+$/.test(entity.name)) {
        logger.debug('Entity filtered: numeric only', { name: entity.name, source });
        filterStats.numeric++;
        continue;
      }

      seen.add(nameLower);
      filtered.push(entity);

      // Track accepted entity with its type and confidence
      metrics.trackEntityAccepted(entity.type, source, entity.confidence);
    }

    // Track batch validation metrics
    metrics.trackValidationBatch({
      source,
      total: entities.length,
      accepted: filtered.length,
      filtered: filterStats
    });

    if (filtered.length < entities.length) {
      logger.info('Entity validation filtered garbage', {
        source,
        before: entities.length,
        after: filtered.length,
        removed: entities.length - filtered.length,
        filterBreakdown: filterStats
      });
    }

    return filtered;
  }

  /**
   * Calculate confidence based on entity type and name quality
   * Uses configurable thresholds for all confidence values
   */
  private calculateEntityConfidence(name: string, type: ExtractedEntity['type']): number {
    const thresholds = getClassificationConfig().thresholds;
    let confidence = thresholds.baseConfidence;

    // Known organizations get higher confidence
    if (KNOWN_ORGANIZATIONS.has(name.toLowerCase())) {
      confidence = thresholds.highConfidence;
    }
    // Known locations get higher confidence
    else if (KNOWN_LOCATIONS.has(name.toLowerCase())) {
      // Slightly below high confidence for locations
      confidence = (thresholds.highConfidence + thresholds.mediumConfidence) / 2;
    }
    // Multi-word entities (might be proper nouns) get medium-high confidence
    else if (name.includes(' ') && type === 'person') {
      // But penalize if it looks like a location being misclassified
      if (KNOWN_LOCATIONS.has(name.toLowerCase())) {
        confidence = (thresholds.highConfidence + thresholds.mediumConfidence) / 2;
      } else {
        confidence = thresholds.mediumConfidence;
      }
    }

    return confidence;
  }

  private async extractFactsCore(content: string, episodeId: string): Promise<ExtractedFact[]> {
    // Enhanced fact extraction with quality filtering
    const facts: ExtractedFact[] = [];
    const seenFacts = new Set<string>(); // Deduplication

    // Pattern 1: "X is/are Y" patterns
    const isPatterns = content.match(/([A-Z][a-zA-Z]+(?:\s+[A-Z][a-zA-Z]+)?)\s+(?:is|are|was|were)\s+([^.!?,;]{5,50})(?:[.!?,;]|$)/gi) || [];

    for (const pattern of isPatterns) {
      const parts = pattern.match(/^([A-Z][a-zA-Z]+(?:\s+[A-Z][a-zA-Z]+)?)\s+(?:is|are|was|were)\s+(.+?)(?:[.!?,;]|$)/i);
      if (parts) {
        const subject = parts[1].trim();
        const object = parts[2].trim();

        // Skip if subject is a stopword
        if (ENTITY_STOPWORDS.has(subject.toLowerCase())) continue;

        // Skip very short or very long objects
        if (object.length < 5 || object.length > 100) continue;

        // Create content string
        const factContent = `${subject} is ${object}`;

        // Skip duplicates
        const factKey = `${subject.toLowerCase()}:${object.toLowerCase()}`;
        if (seenFacts.has(factKey)) continue;
        seenFacts.add(factKey);

        facts.push({
          id: uuidv4(),
          subject,
          predicate: 'is',
          object,
          content: factContent,
          confidence: 0.6,
          source_episode_id: episodeId,
          extracted_at: new Date()
        });
      }
    }

    // Pattern 2: "X uses/uses Y" patterns (technical facts)
    const usesPatterns = content.match(/([A-Z][a-zA-Z]+(?:\s+[A-Z][a-zA-Z]+)?)\s+(?:uses?|requires?|depends?\s+on)\s+([A-Z][a-zA-Z]+(?:\s+[A-Z][a-zA-Z]+)?)/gi) || [];

    for (const pattern of usesPatterns) {
      const parts = pattern.match(/^([A-Z][a-zA-Z]+(?:\s+[A-Z][a-zA-Z]+)?)\s+(?:uses?|requires?|depends?\s+on)\s+(.+?)$/i);
      if (parts) {
        const subject = parts[1].trim();
        const object = parts[2].trim();

        if (ENTITY_STOPWORDS.has(subject.toLowerCase())) continue;
        if (ENTITY_STOPWORDS.has(object.toLowerCase())) continue;

        const factContent = `${subject} uses ${object}`;

        const factKey = `${subject.toLowerCase()}:uses:${object.toLowerCase()}`;
        if (seenFacts.has(factKey)) continue;
        seenFacts.add(factKey);

        facts.push({
          id: uuidv4(),
          subject,
          predicate: 'uses',
          object,
          content: factContent,
          confidence: 0.7,
          source_episode_id: episodeId,
          extracted_at: new Date()
        });
      }
    }

    // Pattern 3: "decided to X" or "chose X over Y" (decision facts)
    const decisionPatterns = content.match(/(?:decided\s+to|chose|selected|opted\s+for)\s+([^.!?,;]{5,80})(?:[.!?,;]|$)/gi) || [];

    for (const pattern of decisionPatterns) {
      const parts = pattern.match(/^(?:decided\s+to|chose|selected|opted\s+for)\s+(.+?)(?:[.!?,;]|$)/i);
      if (parts) {
        const decision = parts[1].trim();
        if (decision.length < 5 || decision.length > 100) continue;

        const factContent = `Decision: ${decision}`;

        const factKey = `decision:${decision.toLowerCase()}`;
        if (seenFacts.has(factKey)) continue;
        seenFacts.add(factKey);

        facts.push({
          id: uuidv4(),
          subject: 'Decision',
          predicate: 'made',
          object: decision,
          content: factContent,
          confidence: 0.8,
          source_episode_id: episodeId,
          extracted_at: new Date()
        });
      }
    }

    // Limit to 10 facts per episode to prevent noise
    return facts.slice(0, 10);
  }

  /**
   * Extract facts from content - public wrapper for async worker
   * Returns simplified fact structure for background enrichment
   */
  public async extractFacts(
    content: string,
    _entityNames: string[]
  ): Promise<Array<{ subject: string; predicate: string; object: string; confidence: number }>> {
    // Generate temporary episode ID for extraction
    const tempEpisodeId = uuidv4();
    const facts = await this.extractFactsInternal(content, tempEpisodeId);

    // Return simplified structure
    return facts.map(f => ({
      subject: f.subject,
      predicate: f.predicate,
      object: f.object,
      confidence: f.confidence
    }));
  }

  /**
   * Internal fact extraction (original private method)
   */
  private async extractFactsInternal(content: string, episodeId: string): Promise<ExtractedFact[]> {
    // Delegate to the original implementation
    return this.extractFactsCore(content, episodeId);
  }

  private calculateImportance(content: string, entities: ExtractedEntity[], facts: ExtractedFact[]): number {
    // Calculate importance based on various factors
    let importance = 0.5; // Base importance

    // Factor in content length
    importance += Math.min(content.length / 1000, 0.2);

    // Factor in entity count
    importance += Math.min(entities.length * 0.05, 0.2);

    // Factor in fact count
    importance += Math.min(facts.length * 0.1, 0.1);

    return Math.min(importance, 1.0);
  }

  private calculateDecayRate(importance: number): number {
    // Higher importance = lower decay rate
    return 0.1 * (1 - importance);
  }

  private calculateSalience(entity: string, content: string): number {
    // Calculate how important this entity is in the content
    const mentions = (content.match(new RegExp(entity, 'gi')) || []).length;
    const position = content.indexOf(entity) / content.length;

    // Earlier position and more mentions = higher salience
    return Math.min((mentions * 0.2) + ((1 - position) * 0.3), 1.0);
  }

  /**
   * Classify entity type using semantic classification (Voyage AI reranking)
   * Falls back to LLM classification (Claude Sonnet 4.5) if semantic classification is disabled or fails
   *
   * This method uses Voyage AI's rerank-2.5 model for accurate entity classification.
   * Reranking is more accurate than embedding similarity because it uses a cross-encoder
   * architecture that considers the full context of the entity and its description.
   */
  private async classifyEntityTypeSemantic(
    name: string,
    context: string
  ): Promise<{ type: ExtractedEntity['type']; confidence: number; method: string }> {
    // Check LLM cache first (fast path - no API call needed)
    const cached = LLM_ENTITY_TYPE_CACHE.get(name.toLowerCase());
    if (cached && cached.confidence >= 0.9) {
      return {
        type: cached.type as ExtractedEntity['type'],
        confidence: cached.confidence,
        method: 'cache'
      };
    }

    // If semantic classification is enabled, try it first
    if (this.semanticClassificationEnabled && this.semanticClassifier) {
      try {
        // Use semantic classifier with Voyage AI reranking
        const heuristicType = this.classifyEntityType(name);
        const result: ClassificationResult = await this.semanticClassifier.classifyEntity(
          name,
          context,
          heuristicType as EntityType
        );

        logger.debug('[SEMANTIC-CLASSIFICATION] Entity classified', {
          name,
          type: result.type,
          confidence: result.confidence,
          method: result.method,
          heuristicHint: heuristicType
        });

        return {
          type: result.type as ExtractedEntity['type'],
          confidence: result.confidence,
          method: result.method
        };
      } catch (error: any) {
        logger.debug('[SEMANTIC-CLASSIFICATION] Voyage classification failed, trying LLM', {
          name,
          error: error.message
        });
        // Fall through to LLM classification
      }
    }

    // Use LLM classification (Claude Sonnet 4.5) as primary/fallback
    // This replaces hardcoded entity lists with dynamic LLM-based classification
    return await this.classifyEntityTypeLLM(name, context);
  }

  /**
   * Heuristic entity type classification (fast, local, no API calls)
   * Used as fallback when semantic classification is unavailable
   */
  private classifyEntityType(name: string): ExtractedEntity['type'] {
    // Entity type classification with known lists
    const lowerName = name.toLowerCase();

    // Check TECHNOLOGIES FIRST - prevents "React", "transformer" → "organization"
    if (KNOWN_TECHNOLOGIES.has(lowerName)) {
      return 'technology';
    }

    // Check known organizations (companies only)
    if (KNOWN_ORGANIZATIONS.has(lowerName)) {
      return 'organization';
    }

    // Check known locations (before person check to prevent misclassification)
    if (KNOWN_LOCATIONS.has(lowerName)) {
      return 'location';
    }

    // Check for file patterns (file paths, extensions, common file names)
    const filePatterns = /^([\w\-./]+\.(ts|js|tsx|jsx|py|rb|go|rs|java|cpp|c|h|json|yaml|yml|md|txt|html|css|scss|sql|sh|bash|dockerfile|env|gitignore|eslintrc|prettierrc)|package\.json|tsconfig\.json|index\.(ts|js)|\.env(\.\w+)?|[A-Z]?[a-z]+\.(ts|js|py))$/i;
    if (filePatterns.test(name) || name.includes('/') || name.startsWith('.')) {
      return 'file';
    }

    // Check for function patterns (camelCase, PascalCase methods, common function prefixes)
    const functionPatterns = /^(get|set|is|has|can|should|will|did|on|handle|fetch|create|update|delete|remove|add|find|search|load|save|validate|parse|format|render|use)[A-Z][a-zA-Z0-9]*$/;
    const classPatterns = /^[A-Z][a-zA-Z0-9]*(Service|Controller|Handler|Manager|Provider|Factory|Builder|Adapter|Wrapper|Helper|Util|Component|Hook|Store|Reducer|Action|Middleware|Guard|Interceptor|Resolver|Module|Config|Context|Client|Repository)$/;
    if (functionPatterns.test(name) || classPatterns.test(name)) {
      return 'function';
    }

    // Check for organization suffixes
    if (['inc', 'corp', 'llc', 'company', 'ltd', 'gmbh', 'co'].some(suffix => lowerName.includes(suffix))) {
      return 'organization';
    }

    // Check for location indicators
    if (['street', 'avenue', 'boulevard', 'road', 'city', 'country', 'state', 'county'].some(suffix => lowerName.includes(suffix))) {
      return 'location';
    }

    // Check if it looks like a tech product/framework (single capitalized word)
    const techPatterns = /^(React|Vue|Angular|Svelte|Next|Node|Deno|Python|TypeScript|JavaScript|Rust|Go|Docker|Kubernetes|Redis|MongoDB|PostgreSQL|Neo4j|GraphQL|REST|API|SDK|CLI|UI|UX|CSS|HTML|SQL|JSON|XML|YAML|Webpack|Vite|Rollup|Babel|ESLint|Prettier|Jest|Mocha|Cypress|Playwright|Express|Fastify|NestJS|Django|Flask|FastAPI|Spring|Laravel|Rails|Phoenix|Electron|Tauri|Qdrant|Pinecone|OpenAI|Anthropic|Claude|GPT|LLM|RAG|MCP|JWT|OAuth|CORS|gRPC|WebSocket|HTTP|HTTPS|TCP|UDP)$/i;
    if (techPatterns.test(name)) {
      return 'technology';
    }

    // Check if it looks like a person's name
    // But ONLY if it's not a known location and has name-like structure
    const words = name.split(' ');
    if (words.length === 2) {
      // Two-word name that's not a known location
      const looksLikeFirstName = /^[A-Z][a-z]{2,}$/.test(words[0]);
      const looksLikeLastName = /^[A-Z][a-z]{2,}$/.test(words[1]);

      // Additional check: first names rarely end with common location suffixes
      const locationSuffixes = ['view', 'park', 'hill', 'valley', 'beach', 'bay', 'lake', 'wood', 'land', 'ton', 'ville'];
      const hasLocationSuffix = locationSuffixes.some(s => words[1].toLowerCase().endsWith(s));

      if (looksLikeFirstName && looksLikeLastName && !hasLocationSuffix) {
        // Still could be a location - check against patterns
        if (!KNOWN_LOCATIONS.has(lowerName)) {
          return 'person';
        }
      }
    }

    // Default to 'other' for unclassified entities
    return 'other';
  }

  /**
   * LLM-based entity type classification using Claude Sonnet 4.5
   * This is the authoritative classifier - hardcoded lists are just cache optimization
   *
   * @param entityName - The entity name to classify
   * @param context - Optional context for better classification
   * @returns Classified type and confidence
   */
  private async classifyEntityTypeLLM(
    entityName: string,
    context?: string
  ): Promise<{ type: ExtractedEntity['type']; confidence: number; method: string }> {
    const lowerName = entityName.toLowerCase();

    // Check cache first (fast path)
    const cached = LLM_ENTITY_TYPE_CACHE.get(lowerName);
    if (cached) {
      return {
        type: cached.type as ExtractedEntity['type'],
        confidence: cached.confidence,
        method: 'cache'
      };
    }

    // If no OpenRouter client, fall back to heuristic
    if (!this.openRouterClient) {
      const heuristicType = this.classifyEntityType(entityName);
      return { type: heuristicType, confidence: 0.6, method: 'heuristic' };
    }

    // Use LLM for classification
    const prompt = `Classify this entity into exactly ONE type. Choose the MOST specific and accurate type.

Entity: "${entityName}"
${context ? `Context: "${context.substring(0, 300)}"` : ''}

Types:
- person: A human being (real or fictional). Examples: "Elon Musk", "Dr. Emily Chen", "Marie Curie"
- organization: A company, university, institution, conference, or group. Examples: "Google", "Stanford University", "NeurIPS", "W3C"
- location: A geographic place (city, country, region). Examples: "San Francisco", "California", "Tokyo"
- technology: Software, framework, language, library, or tech product. Examples: "React", "Python", "Kubernetes", "PostgreSQL", "transformer"
- concept: Abstract idea, methodology, or pattern. Examples: "microservices", "machine learning", "SOLID principles"
- file: A filename or file path. Examples: "index.ts", "package.json", ".env"
- function: A code function, method, or class name. Examples: "handleClick", "UserService", "fetchData"
- other: Only if none of the above apply

IMPORTANT:
- "transformer" is technology (neural network architecture), NOT organization
- Conference names like "NeurIPS" or "ICML" are organizations
- Universities like "Stanford" or "MIT" are organizations

Respond with ONLY valid JSON: {"type": "person|organization|location|technology|concept|file|function|other", "confidence": 0.0-1.0}`;

    try {
      const response = await this.openRouterClient.post('/chat/completions', {
        model: 'anthropic/claude-3-5-haiku-20241022',  // Haiku: faster single entity classification
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.0,
        max_tokens: 50,
        response_format: { type: 'json_object' }
      });

      const content = response.data?.choices?.[0]?.message?.content;
      if (!content) {
        throw new Error('No response content');
      }

      const parsed = JSON.parse(content);
      const validTypes = ['person', 'organization', 'location', 'concept', 'technology', 'file', 'function', 'other'];
      const type = validTypes.includes(parsed.type) ? parsed.type : 'other';
      const confidence = typeof parsed.confidence === 'number' ? Math.max(0, Math.min(1, parsed.confidence)) : 0.8;

      // Cache the result for future calls
      LLM_ENTITY_TYPE_CACHE.set(lowerName, { type, confidence });

      logger.debug('[LLM-CLASSIFICATION] Entity classified', {
        name: entityName,
        type,
        confidence,
        method: 'llm'
      });

      return {
        type: type as ExtractedEntity['type'],
        confidence,
        method: 'llm'
      };
    } catch (error: any) {
      logger.warn('[LLM-CLASSIFICATION] Classification failed, falling back to heuristic', {
        name: entityName,
        error: error.message
      });

      // Fallback to heuristic if LLM fails
      const heuristicType = this.classifyEntityType(entityName);
      return {
        type: heuristicType,
        confidence: 0.5,
        method: 'heuristic-fallback'
      };
    }
  }

  /**
   * Batch classify multiple entities in a single LLM call
   * Much more efficient than individual calls for multiple entities
   */
  private async batchClassifyEntitiesLLM(
    entities: Array<{ name: string }>,
    context?: string
  ): Promise<Map<string, { type: ExtractedEntity['type']; confidence: number }>> {
    const results = new Map<string, { type: ExtractedEntity['type']; confidence: number }>();

    // First, separate cached entities from unknown entities
    const unknownEntities: string[] = [];
    for (const entity of entities) {
      const cached = LLM_ENTITY_TYPE_CACHE.get(entity.name.toLowerCase());
      if (cached) {
        results.set(entity.name.toLowerCase(), {
          type: cached.type as ExtractedEntity['type'],
          confidence: cached.confidence
        });
      } else {
        unknownEntities.push(entity.name);
      }
    }

    // If all entities are cached, return early
    if (unknownEntities.length === 0) {
      return results;
    }

    // If no OpenRouter client, use heuristic for all unknown entities
    if (!this.openRouterClient) {
      for (const name of unknownEntities) {
        const heuristicType = this.classifyEntityType(name);
        results.set(name.toLowerCase(), { type: heuristicType, confidence: 0.6 });
      }
      return results;
    }

    // Batch LLM classification for unknown entities
    const entityList = unknownEntities.map(e => `"${e}"`).join(', ');
    const prompt = `Classify each entity into exactly ONE type. Choose the MOST specific type for each.

Entities: [${entityList}]
${context ? `Context: "${context.substring(0, 500)}"` : ''}

Types: person, organization, location, technology, concept, file, function, other

Rules:
- person: Human beings (e.g., "Elon Musk", "Dr. Emily Chen")
- organization: Companies, universities, conferences (e.g., "Google", "Stanford", "NeurIPS")
- location: Geographic places (e.g., "San Francisco", "Tokyo")
- technology: Software, frameworks, languages (e.g., "React", "Python", "transformer")
- concept: Abstract ideas/methodologies (e.g., "microservices", "machine learning")
- file/function: Code-related (e.g., "index.ts", "handleClick")

Respond with ONLY valid JSON object containing entities array:
{"entities": [{"name": "EntityName", "type": "type", "confidence": 0.0-1.0}, ...]}`;

    try {
      const response = await this.openRouterClient.post('/chat/completions', {
        model: 'anthropic/claude-3-5-haiku-20241022',  // Haiku: faster batch entity classification
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.0,
        max_tokens: 500,
        response_format: { type: 'json_object' }
      });

      const content = response.data?.choices?.[0]?.message?.content;
      if (!content) {
        throw new Error('No response content');
      }

      const parsed = JSON.parse(content);
      const entityResults = Array.isArray(parsed) ? parsed : (parsed.entities || []);
      const validTypes = ['person', 'organization', 'location', 'concept', 'technology', 'file', 'function', 'other'];

      for (const item of entityResults) {
        const type = validTypes.includes(item.type) ? item.type : 'other';
        const confidence = typeof item.confidence === 'number' ? Math.max(0, Math.min(1, item.confidence)) : 0.8;
        const lowerName = item.name.toLowerCase();

        results.set(lowerName, {
          type: type as ExtractedEntity['type'],
          confidence
        });

        // Cache for future calls
        LLM_ENTITY_TYPE_CACHE.set(lowerName, { type, confidence });
      }

      logger.debug('[LLM-BATCH-CLASSIFICATION] Entities classified', {
        count: entityResults.length,
        method: 'llm-batch'
      });
    } catch (error: any) {
      logger.warn('[LLM-BATCH-CLASSIFICATION] Batch classification failed, using heuristics', {
        error: error.message
      });

      // Fallback: classify each unknown entity with heuristic
      for (const name of unknownEntities) {
        if (!results.has(name.toLowerCase())) {
          const heuristicType = this.classifyEntityType(name);
          results.set(name.toLowerCase(), { type: heuristicType, confidence: 0.5 });
        }
      }
    }

    return results;
  }

  private async storeEpisodeSource(session: Session, episodeId: string, source: EpisodeSource): Promise<void> {
    await session.run(`
      MATCH (e:Episode {id: $episodeId})
      SET e.source_type = $sourceType,
          e.session_id = $sessionId,
          e.user_id = $userId,
          e.interaction_id = $interactionId
    `, {
      episodeId,
      sourceType: source.type,
      sessionId: source.session_id,
      userId: source.user_id,
      interactionId: source.interaction_id
    });

    // Link to documents if provided
    if (source.document_ids?.length) {
      await session.run(`
        MATCH (e:Episode {id: $episodeId})
        MATCH (d:Document)
        WHERE d.id IN $documentIds
        MERGE (e)-[:REFERENCES]->(d)
      `, {
        episodeId,
        documentIds: source.document_ids
      });
    }
  }

  private async storeOrUpdateEntity(
    session: Session,
    entity: ExtractedEntity,
    episodeId: string,
    tenantContext: EnhancedTenantContext
  ): Promise<ExtractedEntity> {
    // STEP 1: Entity Resolution - check for similar entities (fuzzy match)
    // This catches "Dr. Emily Chen" matching "Emily Chen" with >90% similarity
    if (this.entityResolver) {
      const existingEntities = await this.getExistingEntitiesForResolution(session, tenantContext);
      if (existingEntities.length > 0) {
        const mergeResult = await this.entityResolver.autoMerge(entity.name, existingEntities);
        if (mergeResult.merged && mergeResult.targetEntityId) {
          logger.info('[ENTITY-RESOLUTION] Merging entity via fuzzy match', {
            newEntity: entity.name,
            targetId: mergeResult.targetEntityId,
            targetName: mergeResult.targetEntityName,
            similarity: mergeResult.similarity,
            method: mergeResult.method
          });
          // Link to existing entity instead of creating duplicate
          return await this.linkToExistingEntity(session, mergeResult.targetEntityId, entity, episodeId, tenantContext);
        }
      }
    }

    // STEP 2: Check if entity already exists (exact match within tenant context)
    const existingResult = await session.run(`
      MATCH (n:Entity)
      WHERE (n.name = $name OR $name IN n.aliases)
        AND n.company_id = $companyId
        AND n.app_id = $appId
      RETURN n
    `, {
      name: entity.name,
      companyId: tenantContext.companyId,
      appId: tenantContext.appId
    });

    if (existingResult.records.length > 0) {
      // Update existing entity
      const existingEntity = this.nodeToEntity(existingResult.records[0].get('n'));

      await session.run(`
        MATCH (n:Entity {id: $id})
        MATCH (e:Episode {id: $episodeId})
        SET n.mention_count = n.mention_count + 1,
            n.last_seen = datetime($now),
            n.salience = (n.salience + $newSalience) / 2
        MERGE (e)-[:MENTIONS]->(n)
        RETURN n
      `, {
        id: existingEntity.id,
        episodeId,
        now: new Date().toISOString(),
        newSalience: entity.salience
      });

      existingEntity.mention_count++;
      existingEntity.last_seen = new Date();
      return existingEntity;

    } else {
      // Create new entity (with tenant context)
      await session.run(`
        CREATE (n:Entity {
          id: $id,
          name: $name,
          type: $type,
          confidence: $confidence,
          first_seen: datetime($firstSeen),
          last_seen: datetime($lastSeen),
          mention_count: $mentionCount,
          salience: $salience,
          company_id: $companyId,
          app_id: $appId
        })
        WITH n
        MATCH (e:Episode {id: $episodeId})
        MERGE (e)-[:MENTIONS]->(n)
        RETURN n
      `, {
        id: entity.id,
        name: entity.name,
        type: entity.type,
        confidence: entity.confidence,
        firstSeen: entity.first_seen.toISOString(),
        lastSeen: entity.last_seen.toISOString(),
        mentionCount: entity.mention_count,
        salience: entity.salience,
        episodeId,
        companyId: tenantContext.companyId,
        appId: tenantContext.appId
      });

      return entity;
    }
  }

  /**
   * Get existing entities for resolution (tenant-scoped, limited for performance)
   */
  private async getExistingEntitiesForResolution(
    session: Session,
    tenantContext: EnhancedTenantContext
  ): Promise<Array<{ id: string; name: string }>> {
    const result = await session.run(`
      MATCH (e:Entity)
      WHERE e.company_id = $companyId AND e.app_id = $appId
      RETURN e.id as id, e.name as name
      ORDER BY e.mention_count DESC
      LIMIT 500
    `, {
      companyId: tenantContext.companyId,
      appId: tenantContext.appId
    });

    return result.records.map(r => ({
      id: r.get('id'),
      name: r.get('name')
    }));
  }

  /**
   * Link new entity data to existing entity (merge via alias)
   */
  private async linkToExistingEntity(
    session: Session,
    existingEntityId: string,
    newEntity: ExtractedEntity,
    episodeId: string,
    tenantContext: EnhancedTenantContext
  ): Promise<ExtractedEntity> {
    // Add new name as alias, update mention count and salience
    const result = await session.run(`
      MATCH (e:Entity {id: $entityId})
      SET e.aliases = CASE
        WHEN $newName IN coalesce(e.aliases, []) THEN e.aliases
        ELSE coalesce(e.aliases, []) + $newName
      END,
      e.mention_count = coalesce(e.mention_count, 0) + 1,
      e.last_seen = datetime($now),
      e.salience = (coalesce(e.salience, 0.5) + $newSalience) / 2
      WITH e
      MATCH (ep:Episode {id: $episodeId})
      MERGE (ep)-[:MENTIONS]->(e)
      RETURN e
    `, {
      entityId: existingEntityId,
      newName: newEntity.name,
      now: new Date().toISOString(),
      newSalience: newEntity.salience,
      episodeId
    });

    if (result.records.length > 0) {
      const mergedEntity = this.nodeToEntity(result.records[0].get('e'));
      // Mark that this was a merged entity
      return { ...mergedEntity, merged: true } as ExtractedEntity;
    }

    // Fallback: return original entity if merge failed
    return newEntity;
  }

  private async storeFact(
    session: Session,
    fact: ExtractedFact,
    tenantContext: EnhancedTenantContext
  ): Promise<ExtractedFact> {
    await session.run(`
      CREATE (f:Fact {
        id: $id,
        subject: $subject,
        predicate: $predicate,
        object: $object,
        content: $content,
        confidence: $confidence,
        source_episode_id: $sourceEpisodeId,
        extracted_at: datetime($extractedAt),
        company_id: $companyId,
        app_id: $appId
      })
      WITH f
      MATCH (e:Episode {id: $sourceEpisodeId})
      MERGE (e)-[:HAS_FACT]->(f)
      RETURN f
    `, {
      id: fact.id,
      subject: fact.subject,
      predicate: fact.predicate,
      object: fact.object,
      content: fact.content,
      confidence: fact.confidence,
      sourceEpisodeId: fact.source_episode_id,
      extractedAt: fact.extracted_at.toISOString(),
      companyId: tenantContext.companyId,
      appId: tenantContext.appId
    });

    return fact;
  }

  private async createTemporalEdges(
    session: Session,
    episodeId: string,
    timestamp: Date,
    tenantContext: EnhancedTenantContext
  ): Promise<EpisodicEdge[]> {
    const edges: EpisodicEdge[] = [];

    // Find the most recent episode before this one (within tenant + user context)
    const result = await session.run(`
      MATCH (prev:Episode)
      WHERE prev.timestamp < datetime($timestamp)
      AND NOT prev.consolidated = true
      AND prev.company_id = $companyId
      AND prev.app_id = $appId
      AND (prev.user_id = $userId OR prev.user_id = 'system')
      WITH prev
      ORDER BY prev.timestamp DESC
      LIMIT 1

      MATCH (current:Episode {id: $episodeId})
      MERGE (prev)-[r:TEMPORAL {weight: 1.0}]->(current)
      RETURN prev.id as prevId
    `, {
      episodeId,
      timestamp: timestamp.toISOString(),
      companyId: tenantContext.companyId,
      appId: tenantContext.appId,
      userId: tenantContext.userId
    });

    if (result.records.length > 0) {
      edges.push({
        id: uuidv4(),
        source_episode_id: result.records[0].get('prevId'),
        target_episode_id: episodeId,
        type: 'temporal',
        weight: 1.0,
        created_at: new Date()
      });
    }

    return edges;
  }

  private async createCausalEdges(
    session: Session,
    episodeId: string,
    request: StoreEpisodeRequest,
    tenantContext: EnhancedTenantContext
  ): Promise<EpisodicEdge[]> {
    const edges: EpisodicEdge[] = [];

    // If this is a system response, link it causally to the previous user query (within tenant context)
    if (request.type === 'system_response' && request.source?.interaction_id) {
      const result = await session.run(`
        MATCH (query:Episode {interaction_id: $interactionId, type: 'user_query'})
        WHERE query.company_id = $companyId
          AND query.app_id = $appId
        MATCH (response:Episode {id: $episodeId})
        MERGE (query)-[r:CAUSAL {weight: 0.9}]->(response)
        RETURN query.id as queryId
      `, {
        episodeId,
        interactionId: request.source.interaction_id,
        companyId: tenantContext.companyId,
        appId: tenantContext.appId
      });

      if (result.records.length > 0) {
        edges.push({
          id: uuidv4(),
          source_episode_id: result.records[0].get('queryId'),
          target_episode_id: episodeId,
          type: 'causal',
          weight: 0.9,
          created_at: new Date()
        });
      }
    }

    return edges;
  }

  private async getTemporalContext(
    session: Session,
    _episodeId: string,
    timestamp: Date,
    tenantContext: EnhancedTenantContext
  ): Promise<{
    before: Episode[];
    after: Episode[];
  }> {
    // Get episodes before (within tenant + user context)
    const beforeResult = await session.run(`
      MATCH (e:Episode)
      WHERE e.timestamp < datetime($timestamp)
      AND NOT e.consolidated = true
      AND e.company_id = $companyId
      AND e.app_id = $appId
      AND (e.user_id = $userId OR e.user_id = 'system')
      RETURN e
      ORDER BY e.timestamp DESC
      LIMIT 3
    `, {
      timestamp: timestamp.toISOString(),
      companyId: tenantContext.companyId,
      appId: tenantContext.appId,
      userId: tenantContext.userId
    });

    // Get episodes after (within tenant + user context)
    const afterResult = await session.run(`
      MATCH (e:Episode)
      WHERE e.timestamp > datetime($timestamp)
      AND NOT e.consolidated = true
      AND e.company_id = $companyId
      AND e.app_id = $appId
      AND (e.user_id = $userId OR e.user_id = 'system')
      RETURN e
      ORDER BY e.timestamp ASC
      LIMIT 3
    `, {
      timestamp: timestamp.toISOString(),
      companyId: tenantContext.companyId,
      appId: tenantContext.appId,
      userId: tenantContext.userId
    });

    return {
      before: beforeResult.records.map(r => this.nodeToEpisode(r.get('e'))),
      after: afterResult.records.map(r => this.nodeToEpisode(r.get('e')))
    };
  }

  private async groupSimilarEpisodes(
    session: Session,
    episodes: Episode[],
    tenantContext: EnhancedTenantContext
  ): Promise<Episode[][]> {
    // Simple clustering based on embedding similarity
    // In production, use proper clustering algorithm
    const groups: Episode[][] = [];
    const used = new Set<string>();

    for (const episode of episodes) {
      if (used.has(episode.id)) continue;

      const group = [episode];
      used.add(episode.id);

      // Since we store embeddings as JSON, use content and temporal similarity (within tenant context)
      const result = await session.run(`
        MATCH (e1:Episode {id: $id})
        MATCH (e2:Episode)
        WHERE e2.id IN $candidateIds
        AND e2.company_id = $companyId
        AND e2.app_id = $appId
        AND (
          e1.type = e2.type  // Group by type
          OR abs(duration.between(e1.timestamp, e2.timestamp).hours) < 12  // Close in time
        )
        RETURN e2.id as similarId
      `, {
        id: episode.id,
        candidateIds: episodes.filter(e => !used.has(e.id)).map(e => e.id),
        companyId: tenantContext.companyId,
        appId: tenantContext.appId
      });

      for (const record of result.records) {
        const similarId = record.get('similarId');
        const similar = episodes.find(e => e.id === similarId);
        if (similar) {
          group.push(similar);
          used.add(similarId);
        }
      }

      groups.push(group);
    }

    return groups;
  }

  private async createSummaryEpisode(
    session: Session,
    episodes: Episode[],
    tenantContext: EnhancedTenantContext
  ): Promise<void> {
    // Create a summary of the episodes
    const summary = `Summary of ${episodes.length} related episodes from ${
      episodes[0].timestamp.toLocaleDateString()
    } to ${
      episodes[episodes.length - 1].timestamp.toLocaleDateString()
    }`;

    const summaryId = uuidv4();

    await session.run(`
      CREATE (s:Episode {
        id: $id,
        content: $content,
        timestamp: datetime($timestamp),
        type: 'summary',
        importance: $importance,
        decay_rate: 0.01,
        is_summary: true,
        summarized_count: $count,
        company_id: $companyId,
        app_id: $appId,
        user_id: 'system'
      })
      WITH s
      MATCH (e:Episode)
      WHERE e.id IN $episodeIds
      MERGE (e)-[:SUMMARIZED_IN]->(s)
    `, {
      id: summaryId,
      content: summary,
      timestamp: new Date().toISOString(),
      importance: episodes.reduce((sum, e) => sum + e.importance, 0) / episodes.length,
      count: episodes.length,
      episodeIds: episodes.map(e => e.id),
      companyId: tenantContext.companyId,
      appId: tenantContext.appId
    });
  }

  private nodeToEpisode(node: any): Episode {
    // Validate node structure
    if (!node || !node.properties) {
      throw new GraphitiError(
        'Invalid Neo4j node structure',
        'INVALID_NODE_DATA',
        { node: JSON.stringify(node).substring(0, 200) }
      );
    }

    const props = node.properties;

    // Validate required fields
    if (!props.id || !props.content) {
      throw new GraphitiError(
        'Episode node missing required fields',
        'INCOMPLETE_EPISODE_DATA',
        { id: props.id, hasContent: !!props.content }
      );
    }

    // Parse embedding from JSON with validation
    let embedding = null;
    if (props.embedding_json) {
      try {
        const parsed = JSON.parse(props.embedding_json);
        if (Array.isArray(parsed) && parsed.length === (props.embedding_dimensions || 1024)) {
          embedding = parsed;
        } else {
          throw new Error(
            `Dimension mismatch: expected ${props.embedding_dimensions}, got ${parsed?.length}`
          );
        }
      } catch (parseError: any) {
        throw new GraphitiError(
          `Failed to parse episode embedding: ${parseError.message}`,
          'EMBEDDING_PARSE_ERROR',
          { episodeId: props.id, dimensions: props.embedding_dimensions }
        );
      }
    }

    // Parse metadata from JSON with validation
    let metadata = {};
    if (props.metadata_json) {
      try {
        metadata = JSON.parse(props.metadata_json);
        if (typeof metadata !== 'object' || metadata === null) {
          throw new Error('Metadata must be an object');
        }
      } catch (parseError: any) {
        throw new GraphitiError(
          `Failed to parse episode metadata: ${parseError.message}`,
          'METADATA_PARSE_ERROR',
          { episodeId: props.id }
        );
      }
    }

    // Validate and parse timestamp
    let timestamp: Date;
    try {
      timestamp = new Date(props.timestamp);
      if (isNaN(timestamp.getTime())) {
        throw new Error('Invalid timestamp value');
      }
    } catch (dateError: any) {
      throw new GraphitiError(
        `Invalid episode timestamp: ${dateError.message}`,
        'TIMESTAMP_PARSE_ERROR',
        { episodeId: props.id, timestamp: props.timestamp }
      );
    }

    // Validate episode type - includes all MCP-compatible types
    const validTypes = [
      'user_query',
      'system_response',
      'document_interaction',
      'entity_mention',
      'summary',
      'event',          // MCP tool compatibility
      'observation',    // MCP tool compatibility
      'insight'         // MCP tool compatibility
    ];
    const episodeType = props.type || 'user_query';
    if (!validTypes.includes(episodeType)) {
      throw new GraphitiError(
        `Invalid episode type: ${episodeType}`,
        'INVALID_EPISODE_TYPE',
        { episodeId: props.id, type: episodeType, validTypes }
      );
    }

    return {
      id: props.id,
      content: props.content,
      timestamp,
      type: episodeType as Episode['type'],
      importance: typeof props.importance === 'number' ? props.importance : 0.5,
      decay_rate: typeof props.decay_rate === 'number' ? props.decay_rate : 0.1,
      entities: [],
      facts: [],
      metadata,
      embedding
    };
  }

  private nodeToEntity(node: any): ExtractedEntity {
    return {
      id: node.properties.id,
      name: node.properties.name,
      type: node.properties.type,
      confidence: node.properties.confidence,
      first_seen: new Date(node.properties.first_seen),
      last_seen: new Date(node.properties.last_seen),
      mention_count: node.properties.mention_count,
      salience: node.properties.salience,
      aliases: node.properties.aliases,
      attributes: node.properties.attributes
    };
  }

  private nodeToFact(node: any): ExtractedFact {
    // Generate content from subject/predicate/object if not stored
    const content = node.properties.content ||
      `${node.properties.subject} ${node.properties.predicate} ${node.properties.object}`;

    return {
      id: node.properties.id,
      subject: node.properties.subject,
      predicate: node.properties.predicate,
      object: node.properties.object,
      content,
      confidence: node.properties.confidence,
      source_episode_id: node.properties.source_episode_id,
      extracted_at: new Date(node.properties.extracted_at),
      validity_period: node.properties.validity_period
    };
  }

  /**
   * Validate and sanitize episode content
   * Ensures content meets requirements for embedding generation
   */
  private validateAndSanitizeContent(content: string): string {
    // Validate content is a string
    if (typeof content !== 'string') {
      throw new GraphitiError(
        'Episode content must be a string',
        'INVALID_CONTENT_TYPE',
        { receivedType: typeof content }
      );
    }

    // Remove control characters and normalize whitespace
    let sanitized = content
      .replace(/[\x00-\x1F\x7F-\x9F]/g, '') // Remove control characters
      .replace(/\s+/g, ' ')                 // Normalize whitespace
      .trim();

    // Validate length requirements
    if (sanitized.length < 10) {
      throw new GraphitiError(
        `Episode content too short: minimum 10 characters required, got ${sanitized.length}`,
        'CONTENT_TOO_SHORT',
        { length: sanitized.length, minimum: 10 }
      );
    }

    if (sanitized.length > 8000) {
      logger.warn('Episode content exceeds recommended length, truncating', {
        original: sanitized.length,
        truncated: 8000
      });
      sanitized = sanitized.substring(0, 8000);
    }

    return sanitized;
  }

  /**
   * Generate embedding with retry logic and caching
   * Implements content-hash based caching for deduplication
   * Falls back to exponential backoff for transient failures
   */
  private async generateEmbeddingWithRetry(
    content: string,
    maxRetries: number = 3
  ): Promise<number[]> {
    // Check embedding cache first (saves ~150ms for duplicate content)
    if (this.embeddingCache) {
      const cached = await this.embeddingCache.getEmbedding(content);
      if (cached) {
        logger.debug('[EMBEDDING-CACHE] Cache hit - returning cached embedding', {
          contentLength: content.length,
          model: cached.model,
          cachedAt: cached.timestamp
        });
        return cached.embedding;
      }
    }

    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        logger.debug('Attempting to generate embedding', {
          attempt,
          maxRetries,
          contentLength: content.length,
          cacheEnabled: !!this.embeddingCache
        });

        // Generate embedding with 'document' input type for consistency
        const embeddingResult = await this.embeddingClient.generateEmbedding(
          content,
          { inputType: 'document' }
        );

        // Extract raw embedding array from VoyageAI result object
        const embedding = embeddingResult.embedding;

        // Defensive type validation: ensure we have a proper number array
        if (!Array.isArray(embedding)) {
          throw new GraphitiError(
            `VoyageAI returned invalid type: expected array, got ${typeof embedding}`,
            'INVALID_EMBEDDING_TYPE',
            {
              expected: 'number[]',
              received: typeof embedding,
              model: embeddingResult.model,
              endpoint: embeddingResult.endpoint
            }
          );
        }

        // Validate dimensions match expected (1024 for voyage-3)
        if (embedding.length !== embeddingResult.dimensions) {
          logger.warn('Embedding dimension mismatch in VoyageAI response', {
            expected: embeddingResult.dimensions,
            actual: embedding.length,
            model: embeddingResult.model
          });
        }

        if (embedding.length !== 1024) {
          throw new GraphitiError(
            `Invalid embedding dimensions: expected 1024, got ${embedding.length}`,
            'INVALID_EMBEDDING_DIMENSIONS',
            {
              expected: 1024,
              received: embedding.length,
              model: embeddingResult.model,
              reportedDimensions: embeddingResult.dimensions
            }
          );
        }

        // Validate all elements are valid numbers
        const invalidElements = embedding.filter(e => typeof e !== 'number' || !isFinite(e));
        if (invalidElements.length > 0) {
          throw new GraphitiError(
            `Embedding contains ${invalidElements.length} invalid values (NaN/Infinity)`,
            'INVALID_EMBEDDING_VALUES',
            { invalidCount: invalidElements.length, total: embedding.length }
          );
        }

        logger.debug('Embedding generated and validated successfully', {
          attempt,
          dimensions: embedding.length,
          model: embeddingResult.model,
          endpoint: embeddingResult.endpoint,
          cacheEnabled: !!this.embeddingCache
        });

        // Cache the embedding for future use (non-blocking)
        if (this.embeddingCache) {
          this.embeddingCache.setEmbedding(content, embedding, embeddingResult.model).catch((cacheErr) => {
            logger.warn('[EMBEDDING-CACHE] Failed to cache embedding', {
              error: cacheErr.message,
              contentLength: content.length
            });
          });
        }

        return embedding;

      } catch (error: any) {
        lastError = error;

        logger.warn('Embedding generation attempt failed', {
          attempt,
          maxRetries,
          error: error.message,
          contentLength: content.length
        });

        if (attempt < maxRetries) {
          // Reduced backoff: 500ms, 1s, 1.5s (max 2s) - faster retries
          const delay = Math.min(500 * attempt, 2000);
          logger.debug('Retrying after delay', { delay, nextAttempt: attempt + 1 });
          await new Promise(resolve => setTimeout(resolve, delay));
        }
      }
    }

    // All retries exhausted
    throw new GraphitiError(
      `Failed to generate embedding after ${maxRetries} attempts: ${lastError?.message}`,
      'EMBEDDING_GENERATION_FAILED',
      { attempts: maxRetries, lastError: lastError?.message }
    );
  }

  /**
   * Cleanup resources
   */
  async close(): Promise<void> {
    await this.driver.close();
    logger.info('Graphiti service closed');
  }
}