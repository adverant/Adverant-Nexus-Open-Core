/**
 * Score Calculator for Nexus Memory Lens
 *
 * Implements fused scoring formula combining semantic, temporal,
 * frequency, and importance signals with query-adaptive weights.
 */

import winston from 'winston';

const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json()
  ),
  defaultMeta: { service: 'score-calculator' },
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
 * Scoring weights configuration
 */
export interface ScoringWeights {
  semantic: number;   // Weight for semantic similarity
  temporal: number;   // Weight for temporal relevance
  frequency: number;  // Weight for access frequency
  importance: number; // Weight for user-assigned importance
}

/**
 * Default scoring weights
 */
export const DEFAULT_WEIGHTS: ScoringWeights = {
  semantic: 0.40,
  temporal: 0.30,
  frequency: 0.15,
  importance: 0.15
};

/**
 * Query-adaptive weight adjustments
 */
export interface QueryIntent {
  isRecent?: boolean;      // Query asks for "recent" or "latest"
  isFrequent?: boolean;    // Query asks for "common" or "frequent"
  isImportant?: boolean;   // Query asks for "important" or "critical"
  isExact?: boolean;       // Query asks for exact matches
}

/**
 * Score components
 */
export interface ScoreComponents {
  semantic: number;     // Semantic similarity score (0-1)
  temporal: number;     // Temporal relevance score (0-1)
  frequency: number;    // Access frequency score (0-1)
  importance: number;   // Importance score (0-1)
}

/**
 * Fused score result
 */
export interface FusedScoreResult {
  /** Final fused score (0-1) */
  fusedScore: number;
  /** Individual score components */
  components: ScoreComponents;
  /** Weights used for this calculation */
  weights: ScoringWeights;
  /** Whether fallback weights were used */
  usedAdaptiveWeights: boolean;
}

/**
 * Calculate fused score from components
 *
 * Formula: FusedScore = (semantic × w1) + (temporal × w2) + (frequency × w3) + (importance × w4)
 *
 * @param components - Individual score components
 * @param weights - Scoring weights (defaults to DEFAULT_WEIGHTS)
 * @returns Fused score result
 */
export function calculateFusedScore(
  components: ScoreComponents,
  weights: ScoringWeights = DEFAULT_WEIGHTS
): FusedScoreResult {
  // Validate components
  const validatedComponents = validateComponents(components);

  // Validate and normalize weights
  const normalizedWeights = normalizeWeights(weights);

  // Calculate weighted sum
  const fusedScore =
    validatedComponents.semantic * normalizedWeights.semantic +
    validatedComponents.temporal * normalizedWeights.temporal +
    validatedComponents.frequency * normalizedWeights.frequency +
    validatedComponents.importance * normalizedWeights.importance;

  // Clamp to [0, 1]
  const clampedScore = Math.max(0, Math.min(1, fusedScore));

  logger.debug('Fused score calculated', {
    components: validatedComponents,
    weights: normalizedWeights,
    fusedScore: clampedScore
  });

  return {
    fusedScore: clampedScore,
    components: validatedComponents,
    weights: normalizedWeights,
    usedAdaptiveWeights: false
  };
}

/**
 * Calculate fused score with query-adaptive weights
 *
 * Analyzes query intent and adjusts weights accordingly:
 * - "latest/recent" → boost temporal weight to 0.50
 * - "common/frequent" → boost frequency weight to 0.40
 * - "important/critical" → boost importance weight to 0.40
 * - "exact/specific" → boost semantic weight to 0.60
 *
 * @param components - Individual score components
 * @param queryIntent - Detected query intent
 * @param baseWeights - Base weights to start from
 * @returns Fused score with adaptive weights
 */
export function calculateAdaptiveFusedScore(
  components: ScoreComponents,
  queryIntent: QueryIntent,
  baseWeights: ScoringWeights = DEFAULT_WEIGHTS
): FusedScoreResult {
  // Start with base weights
  let adaptiveWeights = { ...baseWeights };

  // Apply intent-based adjustments
  if (queryIntent.isRecent) {
    adaptiveWeights = {
      semantic: 0.30,
      temporal: 0.50,
      frequency: 0.10,
      importance: 0.10
    };
    logger.debug('Applied recent query weights', { adaptiveWeights });
  } else if (queryIntent.isFrequent) {
    adaptiveWeights = {
      semantic: 0.30,
      temporal: 0.20,
      frequency: 0.40,
      importance: 0.10
    };
    logger.debug('Applied frequent query weights', { adaptiveWeights });
  } else if (queryIntent.isImportant) {
    adaptiveWeights = {
      semantic: 0.30,
      temporal: 0.20,
      frequency: 0.10,
      importance: 0.40
    };
    logger.debug('Applied important query weights', { adaptiveWeights });
  } else if (queryIntent.isExact) {
    adaptiveWeights = {
      semantic: 0.60,
      temporal: 0.20,
      frequency: 0.10,
      importance: 0.10
    };
    logger.debug('Applied exact query weights', { adaptiveWeights });
  }

  // Calculate score with adaptive weights
  const result = calculateFusedScore(components, adaptiveWeights);

  return {
    ...result,
    usedAdaptiveWeights: true
  };
}

/**
 * Detect query intent from text
 *
 * Simple keyword-based detection. In production, use NLU/LLM.
 *
 * @param queryText - Query text to analyze
 * @returns Detected query intent
 */
export function detectQueryIntent(queryText: string): QueryIntent {
  const lowerQuery = queryText.toLowerCase();

  const intent: QueryIntent = {
    isRecent: /\b(recent|latest|new|today|yesterday|this week|last week)\b/i.test(lowerQuery),
    isFrequent: /\b(common|frequent|often|usually|typically|always)\b/i.test(lowerQuery),
    isImportant: /\b(important|critical|urgent|key|essential|priority)\b/i.test(lowerQuery),
    isExact: /\b(exact|exactly|specific|precisely|particular)\b/i.test(lowerQuery)
  };

  logger.debug('Query intent detected', { queryText, intent });

  return intent;
}

/**
 * Validate and clamp score components to [0, 1]
 */
function validateComponents(components: ScoreComponents): ScoreComponents {
  return {
    semantic: Math.max(0, Math.min(1, components.semantic || 0)),
    temporal: Math.max(0, Math.min(1, components.temporal || 0)),
    frequency: Math.max(0, Math.min(1, components.frequency || 0)),
    importance: Math.max(0, Math.min(1, components.importance || 0))
  };
}

/**
 * Normalize weights to sum to 1.0
 */
function normalizeWeights(weights: ScoringWeights): ScoringWeights {
  const sum = weights.semantic + weights.temporal + weights.frequency + weights.importance;

  if (sum === 0) {
    logger.warn('All weights are zero, using default weights');
    return DEFAULT_WEIGHTS;
  }

  if (Math.abs(sum - 1.0) < 0.01) {
    // Already normalized
    return weights;
  }

  // Normalize
  const normalized = {
    semantic: weights.semantic / sum,
    temporal: weights.temporal / sum,
    frequency: weights.frequency / sum,
    importance: weights.importance / sum
  };

  logger.debug('Weights normalized', {
    original: weights,
    sum,
    normalized
  });

  return normalized;
}

/**
 * Calculate temporal score from recency
 *
 * Uses exponential decay based on age.
 *
 * @param ageHours - Age of memory in hours
 * @param halfLifeHours - Half-life for decay (default: 168 hours = 1 week)
 * @returns Temporal score (0-1)
 */
export function calculateTemporalScore(
  ageHours: number,
  halfLifeHours: number = 168
): number {
  if (ageHours < 0) {
    logger.warn('Negative age, using 0', { ageHours });
    ageHours = 0;
  }

  // Exponential decay: score = e^(-age/halfLife)
  const score = Math.exp(-ageHours / halfLifeHours);

  return Math.max(0, Math.min(1, score));
}

/**
 * Calculate frequency score from access count
 *
 * Uses logarithmic scaling to handle wide range of counts.
 *
 * @param accessCount - Number of times accessed
 * @param maxCount - Maximum count for normalization (default: 100)
 * @returns Frequency score (0-1)
 */
export function calculateFrequencyScore(
  accessCount: number,
  maxCount: number = 100
): number {
  if (accessCount < 0) {
    logger.warn('Negative access count, using 0', { accessCount });
    accessCount = 0;
  }

  // Logarithmic scaling: score = log(count + 1) / log(maxCount + 1)
  const score = Math.log(accessCount + 1) / Math.log(maxCount + 1);

  return Math.max(0, Math.min(1, score));
}

/**
 * Batch calculate fused scores for multiple items
 *
 * @param items - Array of items with score components
 * @param weights - Scoring weights to use
 * @returns Map of item IDs to fused scores
 */
export function batchCalculateFusedScores(
  items: Array<{
    id: string;
    components: ScoreComponents;
  }>,
  weights: ScoringWeights = DEFAULT_WEIGHTS
): Map<string, FusedScoreResult> {
  const results = new Map<string, FusedScoreResult>();

  for (const item of items) {
    const result = calculateFusedScore(item.components, weights);
    results.set(item.id, result);
  }

  logger.info('Batch fused scores calculated', {
    itemCount: items.length,
    weights
  });

  return results;
}

/**
 * Calculate score boost from user feedback
 *
 * When user explicitly accesses or marks a memory as useful,
 * boost its importance score.
 *
 * @param currentImportance - Current importance (0-1)
 * @param feedbackType - Type of feedback
 * @returns New importance score (0-1)
 */
export function applyUserFeedback(
  currentImportance: number,
  feedbackType: 'access' | 'star' | 'pin' | 'delete'
): number {
  const clampedImportance = Math.max(0, Math.min(1, currentImportance));

  let newImportance = clampedImportance;

  switch (feedbackType) {
    case 'access':
      // Small boost for access
      newImportance = Math.min(1.0, clampedImportance + 0.05);
      break;
    case 'star':
      // Medium boost for starring
      newImportance = Math.min(1.0, clampedImportance + 0.2);
      break;
    case 'pin':
      // Large boost for pinning (always important)
      newImportance = 1.0;
      break;
    case 'delete':
      // Mark as unimportant
      newImportance = 0.0;
      break;
  }

  logger.debug('User feedback applied', {
    currentImportance: clampedImportance,
    feedbackType,
    newImportance
  });

  return newImportance;
}
