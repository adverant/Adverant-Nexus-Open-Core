/**
 * Semantic Entity Classifier using Voyage AI Reranking
 *
 * This classifier uses Voyage AI's rerank-2.5 (state-of-the-art reranker) to
 * classify entities into semantic categories. Instead of naive cosine similarity,
 * it leverages the cross-encoder architecture of reranking models for superior
 * classification accuracy.
 *
 * Key Features:
 * - Uses VoyageAIUnifiedClient with auto model selection
 * - Leverages rerank-2.5 for classification (NOT manual embedding similarity)
 * - Circuit breaker protection for resilience
 * - Comprehensive metrics tracking
 * - Content-type aware model selection (code, finance, law, multimodal)
 * - Hybrid classification: rerank primary, embedding similarity fallback
 */

import { VoyageAIUnifiedClient, RerankResult } from '../clients/voyage-ai-unified-client';
import { logger } from '../utils/logger';
import { getClassificationMetrics } from '../metrics/classification-metrics';

/**
 * Entity classification result with confidence and method transparency
 */
export interface ClassificationResult {
  type: EntityType;
  confidence: number;
  method: 'semantic-rerank' | 'semantic-embedding' | 'hybrid' | 'fallback-heuristic';
  rerankScore?: number;
  embeddingScore?: number;
  alternatives?: Array<{ type: EntityType; score: number }>;
}

/**
 * Supported entity types for classification
 */
export type EntityType =
  | 'person'
  | 'organization'
  | 'location'
  | 'technology'
  | 'concept'
  | 'file'
  | 'function'
  | 'other';

/**
 * Category definitions for reranking-based classification
 * Each category has multiple definition strings that the reranker compares against
 */
const CATEGORY_DEFINITIONS: Record<EntityType, string[]> = {
  person: [
    'A human being, individual, or named person such as John Smith, Dr. Williams, CEO Jane Doe',
    'Someone who performs actions, has a role, or is referenced by their name in conversation',
    'People including employees, customers, users, executives, developers, or any human individual'
  ],
  organization: [
    'A company, corporation, business, institution, or organization such as Google, Microsoft, OpenAI, Anthropic',
    'Universities, government agencies, non-profits, startups, or any formal organizational entity',
    'Companies and businesses including tech firms, financial institutions, legal firms, healthcare organizations'
  ],
  location: [
    'A geographic place, city, country, region, or physical location such as Seattle, San Francisco, California',
    'Countries like United States, Japan, Germany; cities; states; addresses; landmarks',
    'Physical or virtual locations including offices, data centers, regions, or geographic coordinates'
  ],
  technology: [
    'Software framework, programming language, library, or technical tool such as React, Python, TypeScript, Docker, Kubernetes',
    'Databases like PostgreSQL, Neo4j, Redis; APIs; protocols; technical standards; software systems',
    'Technical concepts including microservices, REST APIs, GraphQL, machine learning frameworks, cloud services',
    'Consumer technology products: smartphones (iPhone, Android, Pixel, Galaxy), tablets (iPad), computers (MacBook, Surface, Chromebook)',
    'Operating systems and platforms: iOS, macOS, Windows, Linux, Android, ChromeOS, watchOS, tvOS, HarmonyOS',
    'Smart devices and AI assistants: Alexa, Siri, Google Assistant, Cortana, Echo, smart speakers, wearables (Apple Watch, AirPods)',
    'AI products and services: ChatGPT, Claude, Gemini, Copilot, DALL-E, Midjourney, Stable Diffusion',
    'Browsers and apps: Chrome, Firefox, Safari, Edge, Slack, Discord, Notion, Figma, Spotify, Netflix'
  ],
  concept: [
    'Abstract idea, methodology, pattern, theory, or conceptual framework such as agile methodology, design patterns',
    'Business concepts like market strategy, customer journey, ROI; technical patterns like SOLID, DRY, KISS',
    'Philosophical or methodological concepts including best practices, principles, paradigms, or abstract ideas'
  ],
  file: [
    'A file path, filename, or document reference such as config.ts, package.json, README.md, .env',
    'Source code files, configuration files, documentation files, or any filesystem artifacts',
    'Paths like /src/index.ts, ./components/Button.tsx, or relative file references'
  ],
  function: [
    'A programming function, method, class, or code construct such as processData(), UserService class, handleClick()',
    'Code identifiers including function names, method names, class names, or interface names',
    'Programming constructs like async functions, hooks (useState, useEffect), or API endpoints'
  ],
  other: [
    'Miscellaneous entity that does not fit into other categories',
    'Unknown or ambiguous entity type requiring human review',
    'Catch-all category for entities that cannot be confidently classified'
  ]
};

/**
 * Content type hints for optimal model selection
 * Used to select specialized Voyage AI models (code, finance, law) for better embeddings
 */
const CONTENT_TYPE_HINTS: Record<EntityType, 'code' | 'finance' | 'law' | 'text' | 'general'> = {
  technology: 'code',
  file: 'code',
  function: 'code',
  organization: 'general',
  person: 'general',
  location: 'general',
  concept: 'general',
  other: 'general'
};

// Export for use in model selection
export { CONTENT_TYPE_HINTS };

/**
 * Semantic Entity Classifier using Voyage AI Reranking
 */
export class SemanticClassifier {
  private voyageClient: VoyageAIUnifiedClient;
  private categoryEmbeddings: Map<EntityType, number[]> | null = null;
  private initialized = false;
  private metrics = getClassificationMetrics();

  constructor(voyageClient: VoyageAIUnifiedClient) {
    this.voyageClient = voyageClient;
    logger.info('[SEMANTIC-CLASSIFIER] Initialized with Voyage AI reranking support');
  }

  /**
   * Initialize embedding cache for fallback classification
   * Pre-computes embeddings for each category definition
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;

    const startTime = Date.now();
    logger.info('[SEMANTIC-CLASSIFIER] Initializing category embeddings for fallback mode');

    try {
      this.categoryEmbeddings = new Map();

      // Pre-compute embeddings for each category (for fallback mode)
      const categories = Object.keys(CATEGORY_DEFINITIONS) as EntityType[];

      for (const category of categories) {
        const definitions = CATEGORY_DEFINITIONS[category];
        const combinedText = definitions.join(' ');

        try {
          const result = await this.voyageClient.generateEmbedding(combinedText, {
            inputType: 'document',
            contentType: 'general'
          });
          this.categoryEmbeddings.set(category, result.embedding);
        } catch (error: any) {
          logger.warn(`[SEMANTIC-CLASSIFIER] Failed to generate embedding for category: ${category}`, {
            error: error.message
          });
        }
      }

      this.initialized = true;
      const latency = Date.now() - startTime;

      logger.info('[SEMANTIC-CLASSIFIER] Initialization complete', {
        categories: Array.from(this.categoryEmbeddings.keys()),
        latency
      });
    } catch (error: any) {
      logger.error('[SEMANTIC-CLASSIFIER] Failed to initialize', { error: error.message });
      // Continue without fallback embeddings - reranking still works
      this.initialized = true;
    }
  }

  /**
   * Classify an entity using Voyage AI reranking
   *
   * Primary method: Uses rerank-2.5 to compare entity against category definitions
   * Fallback: Uses embedding similarity if reranking fails
   *
   * @param entityName - The entity name to classify
   * @param context - Surrounding context for better classification
   * @param preHint - Optional hint about likely category (from heuristics)
   */
  async classifyEntity(
    entityName: string,
    context: string,
    preHint?: EntityType
  ): Promise<ClassificationResult> {
    await this.initialize();

    const startTime = Date.now();

    // Construct query for reranking
    const query = this.buildClassificationQuery(entityName, context);

    // Build documents: one per category with its definitions
    const categories = Object.keys(CATEGORY_DEFINITIONS) as EntityType[];
    const documents = categories.map(category => {
      const definitions = CATEGORY_DEFINITIONS[category];
      return `Category: ${category.toUpperCase()}\n${definitions.join('\n')}`;
    });

    try {
      // PRIMARY CLASSIFICATION: Use reranking
      const rerankResults = await this.voyageClient.rerank(query, documents, categories.length);

      if (rerankResults.length > 0) {
        const result = this.processRerankResults(rerankResults, categories, preHint);
        const latency = Date.now() - startTime;

        // Track metrics
        this.metrics.trackEntityAccepted(
          result.type as any,
          'llm',
          result.confidence
        );

        logger.debug('[SEMANTIC-CLASSIFIER] Classification via reranking', {
          entityName,
          result: result.type,
          confidence: result.confidence,
          method: result.method,
          latency
        });

        return result;
      }

      // FALLBACK: Use embedding similarity
      return await this.classifyViaEmbedding(entityName, context, preHint);
    } catch (error: any) {
      logger.warn('[SEMANTIC-CLASSIFIER] Reranking failed, using embedding fallback', {
        entityName,
        error: error.message
      });

      return await this.classifyViaEmbedding(entityName, context, preHint);
    }
  }

  /**
   * Build a classification query for the reranker
   */
  private buildClassificationQuery(entityName: string, context: string): string {
    // Truncate context to avoid overwhelming the reranker
    const truncatedContext = context.substring(0, 500);

    return `Classify the entity "${entityName}" based on the following context:\n\n${truncatedContext}\n\nWhat type of entity is "${entityName}"?`;
  }

  /**
   * Process rerank results into a classification result
   */
  private processRerankResults(
    rerankResults: RerankResult[],
    categories: EntityType[],
    preHint?: EntityType
  ): ClassificationResult {
    // Sort by score descending
    const sorted = rerankResults.sort((a, b) => b.score - a.score);

    // Get top result
    const topResult = sorted[0];
    const topCategory = categories[topResult.index];
    let confidence = this.calibrateConfidence(topResult.score);

    // If preHint matches and has high score, boost confidence
    if (preHint && topCategory === preHint && topResult.score > 0.5) {
      confidence = Math.min(1.0, confidence * 1.1);
    }

    // Check for ambiguity (top two very close)
    const alternatives: Array<{ type: EntityType; score: number }> = [];
    if (sorted.length >= 2) {
      const scoreDiff = sorted[0].score - sorted[1].score;
      if (scoreDiff < 0.1) {
        // Close call - reduce confidence
        confidence *= 0.9;
        alternatives.push({
          type: categories[sorted[1].index],
          score: sorted[1].score
        });
      }
    }

    // Add more alternatives for transparency
    for (let i = 1; i < Math.min(3, sorted.length); i++) {
      if (!alternatives.find(a => a.type === categories[sorted[i].index])) {
        alternatives.push({
          type: categories[sorted[i].index],
          score: sorted[i].score
        });
      }
    }

    return {
      type: topCategory,
      confidence,
      method: 'semantic-rerank',
      rerankScore: topResult.score,
      alternatives
    };
  }

  /**
   * Fallback: Classify using embedding similarity
   */
  private async classifyViaEmbedding(
    entityName: string,
    context: string,
    preHint?: EntityType
  ): Promise<ClassificationResult> {
    if (!this.categoryEmbeddings || this.categoryEmbeddings.size === 0) {
      // Final fallback: heuristic classification
      return this.classifyViaHeuristics(entityName, context, preHint);
    }

    try {
      // Detect content type for optimal model selection
      const contentType = this.detectContentTypeFromEntity(entityName, context);

      // Generate embedding for entity + context
      const queryText = `${entityName}: ${context.substring(0, 300)}`;
      const queryResult = await this.voyageClient.generateEmbedding(queryText, {
        inputType: 'query',
        contentType
      });

      // Compare to all category embeddings
      const similarities: Array<{ category: EntityType; similarity: number }> = [];

      for (const [category, categoryEmbedding] of this.categoryEmbeddings) {
        const similarity = this.cosineSimilarity(queryResult.embedding, categoryEmbedding);
        similarities.push({ category, similarity });
      }

      // Sort by similarity descending
      similarities.sort((a, b) => b.similarity - a.similarity);

      const topMatch = similarities[0];
      let confidence = this.calibrateEmbeddingConfidence(topMatch.similarity);

      // Boost if matches preHint
      if (preHint && topMatch.category === preHint) {
        confidence = Math.min(1.0, confidence * 1.1);
      }

      const alternatives = similarities.slice(1, 4).map(s => ({
        type: s.category,
        score: s.similarity
      }));

      return {
        type: topMatch.category,
        confidence,
        method: 'semantic-embedding',
        embeddingScore: topMatch.similarity,
        alternatives
      };
    } catch (error: any) {
      logger.warn('[SEMANTIC-CLASSIFIER] Embedding fallback failed', {
        entityName,
        error: error.message
      });

      return this.classifyViaHeuristics(entityName, context, preHint);
    }
  }

  /**
   * Final fallback: Heuristic classification based on patterns
   */
  private classifyViaHeuristics(
    entityName: string,
    context: string,
    preHint?: EntityType
  ): ClassificationResult {
    // If we have a preHint, use it with lower confidence
    if (preHint) {
      return {
        type: preHint,
        confidence: 0.5,
        method: 'fallback-heuristic'
      };
    }

    // Pattern-based heuristics
    const nameLower = entityName.toLowerCase();
    const contextLower = context.toLowerCase();

    // File patterns
    if (/\.\w{2,4}$/.test(entityName) || /\//.test(entityName)) {
      return { type: 'file', confidence: 0.7, method: 'fallback-heuristic' };
    }

    // Function patterns
    if (/\(\)$/.test(entityName) || /^[a-z][a-zA-Z]*[A-Z]/.test(entityName)) {
      return { type: 'function', confidence: 0.6, method: 'fallback-heuristic' };
    }

    // Organization patterns (ends with Inc, Corp, Ltd, etc.)
    if (/\b(inc|corp|ltd|llc|gmbh|plc|company|co)\b/i.test(entityName)) {
      return { type: 'organization', confidence: 0.8, method: 'fallback-heuristic' };
    }

    // Technology patterns (common tech names)
    const techPatterns = /\b(api|sdk|framework|library|database|server|client|service|docker|kubernetes|react|angular|vue|node|python|java|typescript|javascript)\b/i;
    if (techPatterns.test(nameLower) || techPatterns.test(contextLower)) {
      return { type: 'technology', confidence: 0.6, method: 'fallback-heuristic' };
    }

    // Person patterns (common titles)
    if (/^(dr|mr|mrs|ms|prof|ceo|cto|cfo)\b/i.test(entityName)) {
      return { type: 'person', confidence: 0.7, method: 'fallback-heuristic' };
    }

    // Default to 'other' with low confidence
    return { type: 'other', confidence: 0.3, method: 'fallback-heuristic' };
  }

  /**
   * Detect content type from entity for optimal model selection
   */
  private detectContentTypeFromEntity(
    entityName: string,
    context: string
  ): 'code' | 'finance' | 'law' | 'text' | 'general' {
    const combined = `${entityName} ${context}`.toLowerCase();

    // Code indicators
    const codePatterns = /\b(function|class|interface|async|await|const|let|var|return|import|export|npm|yarn|git|docker|kubernetes|api|endpoint|database|sql|mongodb|redis)\b/;
    if (codePatterns.test(combined)) {
      return 'code';
    }

    // Finance indicators
    const financePatterns = /\b(revenue|profit|loss|investment|portfolio|stock|bond|dividend|market|trading|financial|fiscal|quarterly|earnings|budget)\b/;
    if (financePatterns.test(combined)) {
      return 'finance';
    }

    // Law indicators
    const lawPatterns = /\b(legal|court|judge|attorney|plaintiff|defendant|verdict|lawsuit|contract|agreement|statute|regulation|compliance|liability)\b/;
    if (lawPatterns.test(combined)) {
      return 'law';
    }

    return 'general';
  }

  /**
   * Calibrate rerank score to confidence (0-1)
   * Now uses linear scaling with context-aware adjustments instead of step functions
   * This provides more granular confidence values that reflect actual similarity
   */
  private calibrateConfidence(
    rerankScore: number,
    context?: {
      entityType?: string;
      contentLength?: number;
      hasContext?: boolean;
    }
  ): number {
    // Base: Use linear scaling from rerank score (more granular than step function)
    // This avoids the issue where everything clusters at 0.9
    let confidence = rerankScore;

    // Apply context-aware adjustments if context is provided
    if (context) {
      // Boost for longer content (more context = higher confidence)
      if (context.hasContext && context.contentLength && context.contentLength > 100) {
        confidence += 0.03;
      }

      // Type-specific adjustments based on classification reliability
      // Organizations and technologies have more distinctive patterns
      const typeBonus: Record<string, number> = {
        'organization': 0.05,  // Very distinctive (Inc., Corp., etc.)
        'technology': 0.03,    // Fairly distinctive (API, SDK, etc.)
        'location': 0.02,      // Moderate (cities, countries)
        'person': 0.0,         // No adjustment (names vary widely)
        'concept': -0.03,      // Harder to classify accurately
        'other': -0.05         // Fallback category gets penalty
      };
      confidence += typeBonus[context.entityType || 'other'] || 0;
    }

    // Apply slight smoothing to avoid extreme values
    // This maps the raw score to a slightly compressed range
    confidence = 0.15 + (confidence * 0.80);

    // Clamp to valid range [0.1, 0.98]
    return Math.max(0.1, Math.min(0.98, confidence));
  }

  /**
   * Calibrate embedding similarity to confidence
   * Cosine similarity for classification typically ranges 0.5-0.9
   * Now uses linear scaling with entity type adjustments
   */
  private calibrateEmbeddingConfidence(
    similarity: number,
    entityType?: string
  ): number {
    // Linear scaling from similarity score
    let confidence = similarity;

    // Apply type-specific adjustments
    const typeBonus: Record<string, number> = {
      'organization': 0.05,
      'technology': 0.03,
      'location': 0.02,
      'person': 0.0,
      'concept': -0.02,
      'other': -0.05
    };
    confidence += typeBonus[entityType || 'other'] || 0;

    // Compress to realistic range
    confidence = 0.20 + (confidence * 0.75);

    // Clamp to valid range
    return Math.max(0.15, Math.min(0.95, confidence));
  }

  /**
   * Calculate cosine similarity between two vectors
   */
  private cosineSimilarity(a: number[], b: number[]): number {
    if (a.length !== b.length) {
      logger.warn('[SEMANTIC-CLASSIFIER] Dimension mismatch in cosine similarity', {
        aDim: a.length,
        bDim: b.length
      });
      return 0;
    }

    let dotProduct = 0;
    let normA = 0;
    let normB = 0;

    for (let i = 0; i < a.length; i++) {
      dotProduct += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }

    if (normA === 0 || normB === 0) return 0;

    return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
  }

  /**
   * Batch classify multiple entities for efficiency
   */
  async classifyEntities(
    entities: Array<{ name: string; context: string; preHint?: EntityType }>
  ): Promise<ClassificationResult[]> {
    await this.initialize();

    // Process in parallel with concurrency limit
    const BATCH_SIZE = 5;
    const results: ClassificationResult[] = [];

    for (let i = 0; i < entities.length; i += BATCH_SIZE) {
      const batch = entities.slice(i, i + BATCH_SIZE);
      const batchResults = await Promise.all(
        batch.map(e => this.classifyEntity(e.name, e.context, e.preHint))
      );
      results.push(...batchResults);
    }

    return results;
  }

  /**
   * Get classification statistics
   */
  getStats(): {
    initialized: boolean;
    categoryCount: number;
    embeddingsFallbackReady: boolean;
  } {
    return {
      initialized: this.initialized,
      categoryCount: Object.keys(CATEGORY_DEFINITIONS).length,
      embeddingsFallbackReady: this.categoryEmbeddings !== null && this.categoryEmbeddings.size > 0
    };
  }
}

/**
 * Singleton instance management
 */
let semanticClassifierInstance: SemanticClassifier | null = null;

/**
 * Get or create the semantic classifier instance
 */
export function getSemanticClassifier(voyageClient: VoyageAIUnifiedClient): SemanticClassifier {
  if (!semanticClassifierInstance) {
    semanticClassifierInstance = new SemanticClassifier(voyageClient);
    logger.info('[SEMANTIC-CLASSIFIER] Created singleton instance');
  }
  return semanticClassifierInstance;
}

/**
 * Reset the singleton instance (for testing)
 */
export function resetSemanticClassifier(): void {
  semanticClassifierInstance = null;
  logger.info('[SEMANTIC-CLASSIFIER] Reset singleton instance');
}
