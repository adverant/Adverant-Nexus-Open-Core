/**
 * Classification Configuration
 * Environment-configurable thresholds for entity extraction and classification
 *
 * All values can be overridden via environment variables for runtime tuning
 * without requiring code changes or redeployment.
 */

import { logger } from '../utils/logger';

export interface EntityConfig {
  /** Minimum confidence score to accept an entity (0.0-1.0). Default: 0.3 */
  minConfidence: number;

  /** Minimum entity name length in characters. Default: 3 */
  minNameLength: number;

  /** Maximum entities to extract per episode. Default: 20 */
  maxPerEpisode: number;

  /** Maximum entities to store per query. Default: 50 */
  maxPerQuery: number;

  /** Enable LLM-based entity extraction. Default: true */
  enableLlmExtraction: boolean;

  /** Fallback to regex if LLM fails. Default: true */
  enableRegexFallback: boolean;
}

export interface FactConfig {
  /** Minimum confidence score for facts (0.0-1.0). Default: 0.6 */
  minConfidence: number;

  /** Maximum facts to extract per episode. Default: 10 */
  maxPerEpisode: number;

  /** Minimum object length in facts (e.g., "X is Y" - Y min length). Default: 5 */
  minObjectLength: number;

  /** Maximum object length in facts. Default: 100 */
  maxObjectLength: number;
}

export interface ClassificationThresholds {
  /** High confidence threshold for known entities. Default: 0.95 */
  highConfidence: number;

  /** Medium confidence for multi-word names. Default: 0.7 */
  mediumConfidence: number;

  /** Base confidence for unknown entities. Default: 0.6 */
  baseConfidence: number;

  /** Minimum salience to include in results. Default: 0.1 */
  minSalience: number;
}

export interface ClassificationConfig {
  entity: EntityConfig;
  facts: FactConfig;
  thresholds: ClassificationThresholds;
}

/**
 * Parse environment variable as number with fallback
 */
function parseEnvNumber(envVar: string | undefined, defaultValue: number, min?: number, max?: number): number {
  if (!envVar) return defaultValue;

  const parsed = parseFloat(envVar);
  if (isNaN(parsed)) {
    logger.warn(`Invalid number in environment variable, using default`, {
      value: envVar,
      defaultValue
    });
    return defaultValue;
  }

  // Clamp to min/max if provided
  let result = parsed;
  if (min !== undefined && result < min) result = min;
  if (max !== undefined && result > max) result = max;

  return result;
}

/**
 * Parse environment variable as boolean
 */
function parseEnvBoolean(envVar: string | undefined, defaultValue: boolean): boolean {
  if (!envVar) return defaultValue;
  return envVar.toLowerCase() === 'true' || envVar === '1';
}

/**
 * Load classification configuration from environment variables
 * All values have sensible defaults and are validated
 */
export function loadClassificationConfig(): ClassificationConfig {
  const config: ClassificationConfig = {
    entity: {
      minConfidence: parseEnvNumber(process.env.ENTITY_MIN_CONFIDENCE, 0.3, 0, 1),
      minNameLength: parseEnvNumber(process.env.ENTITY_MIN_NAME_LENGTH, 3, 1, 50),
      maxPerEpisode: parseEnvNumber(process.env.MAX_ENTITIES_PER_EPISODE, 20, 1, 100),
      maxPerQuery: parseEnvNumber(process.env.MAX_ENTITIES_PER_QUERY, 50, 1, 200),
      enableLlmExtraction: parseEnvBoolean(process.env.ENABLE_LLM_ENTITY_EXTRACTION, true),
      enableRegexFallback: parseEnvBoolean(process.env.ENABLE_REGEX_ENTITY_FALLBACK, true)
    },
    facts: {
      minConfidence: parseEnvNumber(process.env.FACT_MIN_CONFIDENCE, 0.6, 0, 1),
      maxPerEpisode: parseEnvNumber(process.env.MAX_FACTS_PER_EPISODE, 10, 1, 50),
      minObjectLength: parseEnvNumber(process.env.FACT_MIN_OBJECT_LENGTH, 5, 1, 50),
      maxObjectLength: parseEnvNumber(process.env.FACT_MAX_OBJECT_LENGTH, 100, 10, 500)
    },
    thresholds: {
      highConfidence: parseEnvNumber(process.env.CLASSIFICATION_HIGH_CONFIDENCE, 0.95, 0, 1),
      mediumConfidence: parseEnvNumber(process.env.CLASSIFICATION_MEDIUM_CONFIDENCE, 0.7, 0, 1),
      baseConfidence: parseEnvNumber(process.env.CLASSIFICATION_BASE_CONFIDENCE, 0.6, 0, 1),
      minSalience: parseEnvNumber(process.env.CLASSIFICATION_MIN_SALIENCE, 0.1, 0, 1)
    }
  };

  logger.info('[CLASSIFICATION-CONFIG] Configuration loaded', {
    entity: config.entity,
    facts: config.facts,
    thresholds: config.thresholds
  });

  return config;
}

// Singleton instance with lazy initialization
let configInstance: ClassificationConfig | null = null;

/**
 * Get the classification config singleton
 * Configuration is loaded once and cached
 */
export function getClassificationConfig(): ClassificationConfig {
  if (!configInstance) {
    configInstance = loadClassificationConfig();
  }
  return configInstance;
}

/**
 * Reset configuration (for testing or runtime reload)
 */
export function resetClassificationConfig(): void {
  configInstance = null;
  logger.info('[CLASSIFICATION-CONFIG] Configuration reset - will reload on next access');
}

/**
 * Validate configuration values
 * Returns array of validation errors, empty if valid
 */
export function validateClassificationConfig(config: ClassificationConfig): string[] {
  const errors: string[] = [];

  // Entity validation
  if (config.entity.minConfidence >= config.thresholds.highConfidence) {
    errors.push('entity.minConfidence should be less than thresholds.highConfidence');
  }
  if (config.entity.maxPerEpisode > config.entity.maxPerQuery) {
    errors.push('entity.maxPerEpisode should not exceed entity.maxPerQuery');
  }

  // Facts validation
  if (config.facts.minObjectLength >= config.facts.maxObjectLength) {
    errors.push('facts.minObjectLength must be less than facts.maxObjectLength');
  }

  // Threshold validation
  if (config.thresholds.baseConfidence >= config.thresholds.mediumConfidence) {
    errors.push('thresholds.baseConfidence should be less than thresholds.mediumConfidence');
  }
  if (config.thresholds.mediumConfidence >= config.thresholds.highConfidence) {
    errors.push('thresholds.mediumConfidence should be less than thresholds.highConfidence');
  }

  if (errors.length > 0) {
    logger.warn('[CLASSIFICATION-CONFIG] Configuration validation warnings', { errors });
  }

  return errors;
}
