/**
 * Decay Functions for Nexus Memory Lens
 *
 * Implements Ebbinghaus forgetting curve with spaced repetition
 * and stability-based memory consolidation.
 */

import winston from 'winston';

const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json()
  ),
  defaultMeta: { service: 'decay-functions' },
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
 * Ebbinghaus forgetting curve parameters
 */
export interface EbbinghausParams {
  /** Stability of the memory (0-1) */
  stability: number;
  /** Time since last access in hours */
  hoursSinceAccess: number;
  /** Time constant (tau) in hours, default 168 (1 week) */
  timeConstant?: number;
  /** Importance baseline (0-1) */
  importance?: number;
}

/**
 * Retrievability result
 */
export interface RetrievabilityResult {
  /** Current retrievability score (0-1) */
  retrievability: number;
  /** Stability after this calculation */
  stability: number;
  /** Whether memory is in danger zone (< 0.3) */
  needsReinforcement: boolean;
  /** Recommended review interval in hours */
  optimalReviewInterval: number;
}

/**
 * Calculate retrievability using Ebbinghaus forgetting curve
 *
 * Formula: R(t) = S × e^(-t/τ) + I
 *
 * Where:
 * - R = Retrievability (0-1)
 * - S = Stability (0-1)
 * - t = Time since last access (hours)
 * - τ = Time constant (default 168 hours / 1 week)
 * - I = Importance baseline (0-1)
 *
 * @param params - Ebbinghaus parameters
 * @returns Retrievability result
 */
export function calculateEbbinghaus(params: EbbinghausParams): RetrievabilityResult {
  const {
    stability,
    hoursSinceAccess,
    timeConstant = 168, // 1 week default
    importance = 0.0
  } = params;

  // Validate inputs
  if (stability < 0 || stability > 1) {
    logger.warn('Invalid stability value, clamping to [0, 1]', { stability });
  }
  const clampedStability = Math.max(0, Math.min(1, stability));

  if (hoursSinceAccess < 0) {
    logger.warn('Negative time since access, using 0', { hoursSinceAccess });
  }
  const clampedTime = Math.max(0, hoursSinceAccess);

  if (importance < 0 || importance > 1) {
    logger.warn('Invalid importance value, clamping to [0, 1]', { importance });
  }
  const clampedImportance = Math.max(0, Math.min(1, importance));

  // Calculate decay exponent
  const exponent = -clampedTime / timeConstant;

  // Calculate retrievability
  const decayFactor = Math.exp(exponent);
  const retrievability = Math.max(0, Math.min(1,
    clampedStability * decayFactor + clampedImportance
  ));

  // Determine if reinforcement needed (retrievability < 0.3)
  const needsReinforcement = retrievability < 0.3;

  // Calculate optimal review interval using stability
  const optimalReviewInterval = calculateOptimalReviewInterval({
    currentStability: clampedStability,
    retrievability
  });

  return {
    retrievability,
    stability: clampedStability,
    needsReinforcement,
    optimalReviewInterval
  };
}

/**
 * Calculate stability boost after successful recall
 *
 * Implements spaced repetition principle:
 * - Successful recall increases stability
 * - Boost amount depends on current stability and retrievability
 * - Lower retrievability = bigger boost (more effort = more learning)
 *
 * @param currentStability - Current stability (0-1)
 * @param retrievabilityAtRecall - Retrievability when recalled (0-1)
 * @returns New stability value (0-1)
 */
export function calculateStabilityBoost(
  currentStability: number,
  retrievabilityAtRecall: number
): number {
  // Validate inputs
  const clampedStability = Math.max(0, Math.min(1, currentStability));
  const clampedRetrievability = Math.max(0, Math.min(1, retrievabilityAtRecall));

  // Calculate boost factor
  // Lower retrievability = higher boost (spaced repetition principle)
  // Formula: boost = 0.1 + (1 - R) × 0.3
  const boostFactor = 0.1 + (1 - clampedRetrievability) * 0.3;

  // Apply boost with ceiling at 1.0
  const newStability = Math.min(1.0, clampedStability + boostFactor);

  logger.debug('Stability boost calculated', {
    currentStability: clampedStability,
    retrievabilityAtRecall: clampedRetrievability,
    boostFactor,
    newStability
  });

  return newStability;
}

/**
 * Calculate optimal review interval for spaced repetition
 *
 * Uses the SuperMemo-2 algorithm adapted for continuous time.
 *
 * @param params - Parameters for interval calculation
 * @returns Optimal review interval in hours
 */
export function calculateOptimalReviewInterval(params: {
  currentStability: number;
  retrievability: number;
}): number {
  const { currentStability, retrievability } = params;

  // Validate inputs
  const clampedStability = Math.max(0, Math.min(1, currentStability));
  const clampedRetrievability = Math.max(0, Math.min(1, retrievability));

  // Base intervals (in hours)
  const baseIntervals = [
    1,      // 1 hour
    6,      // 6 hours
    24,     // 1 day
    72,     // 3 days
    168,    // 1 week
    336,    // 2 weeks
    720,    // 1 month
    2160    // 3 months
  ];

  // Calculate interval index based on stability
  // Higher stability = longer intervals
  const stabilityIndex = Math.floor(clampedStability * (baseIntervals.length - 1));

  // Get base interval
  const baseInterval = baseIntervals[stabilityIndex];

  // Adjust based on retrievability
  // Lower retrievability = shorter interval (review sooner)
  const retrievabilityMultiplier = 0.5 + (clampedRetrievability * 0.5);

  const optimalInterval = Math.round(baseInterval * retrievabilityMultiplier);

  logger.debug('Optimal review interval calculated', {
    currentStability: clampedStability,
    retrievability: clampedRetrievability,
    stabilityIndex,
    baseInterval,
    retrievabilityMultiplier,
    optimalInterval
  });

  return optimalInterval;
}

/**
 * Batch calculate retrievability for multiple memories
 *
 * @param memories - Array of memory objects with stability and timestamp
 * @param referenceTime - Reference time for calculation (default: now)
 * @returns Array of retrievability results
 */
export function batchCalculateRetrievability(
  memories: Array<{
    id: string;
    stability: number;
    lastAccessed: Date;
    importance?: number;
  }>,
  referenceTime: Date = new Date()
): Map<string, RetrievabilityResult> {
  const results = new Map<string, RetrievabilityResult>();
  const refTimeMs = referenceTime.getTime();

  for (const memory of memories) {
    const hoursSinceAccess = (refTimeMs - memory.lastAccessed.getTime()) / (1000 * 60 * 60);

    const result = calculateEbbinghaus({
      stability: memory.stability,
      hoursSinceAccess,
      importance: memory.importance
    });

    results.set(memory.id, result);
  }

  logger.info('Batch retrievability calculation completed', {
    memoryCount: memories.length,
    needsReinforcementCount: Array.from(results.values()).filter(r => r.needsReinforcement).length
  });

  return results;
}

/**
 * Calculate decay rate from importance
 *
 * Higher importance = slower decay
 *
 * @param importance - Importance score (0-1)
 * @returns Decay rate constant
 */
export function calculateDecayRate(importance: number): number {
  const clampedImportance = Math.max(0, Math.min(1, importance));

  // Formula: decay_rate = 0.1 × (1 - importance)
  // Important memories (importance=1) decay at rate 0.0
  // Unimportant memories (importance=0) decay at rate 0.1
  const decayRate = 0.1 * (1 - clampedImportance);

  return decayRate;
}

/**
 * Simulate memory trajectory over time
 *
 * Useful for understanding how memories will decay and
 * when they should be reviewed.
 *
 * @param params - Simulation parameters
 * @returns Array of time points with retrievability values
 */
export function simulateMemoryTrajectory(params: {
  initialStability: number;
  importance: number;
  maxHours: number;
  intervalHours: number;
}): Array<{ hours: number; retrievability: number; needsReview: boolean }> {
  const { initialStability, importance, maxHours, intervalHours } = params;
  const trajectory: Array<{ hours: number; retrievability: number; needsReview: boolean }> = [];

  let currentHours = 0;

  while (currentHours <= maxHours) {
    const result = calculateEbbinghaus({
      stability: initialStability,
      hoursSinceAccess: currentHours,
      importance
    });

    trajectory.push({
      hours: currentHours,
      retrievability: result.retrievability,
      needsReview: result.needsReinforcement
    });

    currentHours += intervalHours;
  }

  return trajectory;
}
