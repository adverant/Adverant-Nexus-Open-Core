/**
 * Damage Assessment Service - Multi-Model Vision Consensus
 *
 * Integrates MageAgent's multi-model consensus with vision models for
 * property damage detection and cost estimation.
 *
 * Architecture:
 * - Uses 3-5 vision models concurrently (GPT-4V, Claude Opus 4.6, Gemini 1.5 Pro)
 * - Structured prompts for damage detection
 * - Consensus engine to merge results
 * - Confidence scoring based on model agreement
 * - Cost estimation based on detected damages
 *
 * Design Patterns:
 * - Strategy Pattern: Different detection strategies (Detectron2 vs VLM)
 * - Adapter Pattern: Adapts OpenRouter vision models to damage detection
 * - Consensus Pattern: Merges multi-model outputs
 */

import { OpenRouterClient } from '../clients/openrouter-client';
import { graphRAGClient } from '../clients/graphrag-client';
import { logger } from '../utils/logger';
import { config } from '../config';

/**
 * Property context for damage assessment
 */
export interface PropertyContext {
  propertyId?: string;
  propertyType?: 'residential' | 'commercial' | 'industrial';
  location?: string;
  inspectionType?: 'move-in' | 'move-out' | 'routine' | 'incident';
  previousDamages?: Array<{
    type: string;
    location: string;
    repaired: boolean;
  }>;
}

/**
 * Individual damage detection from a single model
 */
export interface DamageDetection {
  type: 'structural' | 'surface' | 'fixtures' | 'mold_moisture' | 'other';
  severity: 'minor' | 'moderate' | 'severe' | 'critical';
  location: string;
  size?: {
    length?: number;
    width?: number;
    area?: number;
    unit: 'inches' | 'feet' | 'meters';
  };
  description: string;
  repairUrgency: 'immediate' | 'soon' | 'routine';
  confidence: number; // 0-1
}

/**
 * Cost estimate for damages
 */
export interface CostEstimate {
  totalEstimate: {
    min: number;
    max: number;
    currency: 'USD' | 'EUR' | 'GBP';
  };
  breakdown: Array<{
    damageType: string;
    cost: { min: number; max: number };
    laborHours?: number;
    materials?: string[];
  }>;
  disclaimers: string[];
}

/**
 * Single model's damage assessment result
 */
export interface ModelDamageResult {
  model: string;
  damages: DamageDetection[];
  confidence: number;
  processingTime: number;
  error?: string;
}

/**
 * Consensus result from multiple models
 */
export interface DamageConsensusResult {
  damages: DamageDetection[]; // Merged damages with consensus
  consensusStrength: number; // 0-1, how much models agreed
  confidenceScore: number; // 0-1, overall confidence
  modelResults: ModelDamageResult[];
  costEstimate?: CostEstimate;
  summary: string;
  uncertainties: string[];
}

/**
 * Complete damage assessment response
 */
export interface DamageAssessmentResult {
  requestId: string;
  imageUrl: string;
  propertyContext?: PropertyContext;
  consensus: DamageConsensusResult;
  timestamp: Date;
  processingTimeMs: number;
}

/**
 * Damage Assessment Service
 * Uses multi-model consensus for accurate damage detection
 */
export class DamageAssessmentService {
  private openRouterClient: OpenRouterClient;
  private visionModels: Array<{ id: string; name: string }>;

  constructor() {
    this.openRouterClient = new OpenRouterClient(
      config.openRouter.apiKey,
      config.openRouter.baseUrl,
      { filterFreeModels: true }
    );

    // Vision models for damage assessment (in order of preference)
    this.visionModels = [
      { id: 'openai/gpt-4-vision-preview', name: 'GPT-4 Vision' },
      { id: 'anthropic/claude-opus-4.6', name: 'Claude Opus 4.6' },
      { id: 'google/gemini-pro-vision', name: 'Gemini Pro Vision' }
    ];

    logger.info('[DamageAssessmentService] Initialized with vision models', {
      models: this.visionModels.map(m => m.name)
    });
  }

  /**
   * Assess damage in a single image using multi-model consensus
   *
   * @param imageUrl - Image URL (data URL or HTTP URL)
   * @param propertyContext - Optional property context for better assessment
   * @returns Damage assessment with consensus from multiple models
   */
  async assessDamage(
    imageUrl: string,
    propertyContext?: PropertyContext
  ): Promise<DamageAssessmentResult> {
    const startTime = Date.now();
    const requestId = `dmg_${Date.now()}_${Math.random().toString(36).substring(7)}`;

    logger.info('[DamageAssessment] Starting damage assessment', {
      requestId,
      propertyId: propertyContext?.propertyId,
      inspectionType: propertyContext?.inspectionType,
      models: this.visionModels.length
    });

    try {
      // Run damage detection with multiple models in parallel
      const modelResults = await this.runMultiModelDetection(imageUrl, propertyContext);

      // Apply consensus engine to merge results
      const consensus = await this.buildConsensus(modelResults);

      // Estimate repair costs based on detected damages
      const costEstimate = this.estimateCosts(consensus.damages);

      // Store assessment in GraphRAG for future reference
      await this.storeAssessment(requestId, consensus, propertyContext);

      const processingTimeMs = Date.now() - startTime;

      logger.info('[DamageAssessment] Assessment complete', {
        requestId,
        damagesDetected: consensus.damages.length,
        consensusStrength: consensus.consensusStrength,
        processingTimeMs
      });

      return {
        requestId,
        imageUrl,
        propertyContext,
        consensus: {
          ...consensus,
          costEstimate
        },
        timestamp: new Date(),
        processingTimeMs
      };
    } catch (error) {
      logger.error('[DamageAssessment] Assessment failed', {
        requestId,
        error: error instanceof Error ? error.message : 'Unknown error'
      });
      throw new Error(
        `Damage assessment failed: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }

  /**
   * Assess damage in multiple images (batch processing)
   *
   * @param imageUrls - Array of image URLs
   * @param propertyContext - Optional property context
   * @returns Array of damage assessments
   */
  async assessDamageBatch(
    imageUrls: string[],
    propertyContext?: PropertyContext
  ): Promise<DamageAssessmentResult[]> {
    logger.info('[DamageAssessment] Starting batch assessment', {
      imageCount: imageUrls.length,
      propertyId: propertyContext?.propertyId
    });

    // Process images in parallel (max 5 concurrent to avoid rate limits)
    const batchSize = 5;
    const results: DamageAssessmentResult[] = [];

    for (let i = 0; i < imageUrls.length; i += batchSize) {
      const batch = imageUrls.slice(i, i + batchSize);
      const batchResults = await Promise.all(
        batch.map(imageUrl => this.assessDamage(imageUrl, propertyContext))
      );
      results.push(...batchResults);
    }

    logger.info('[DamageAssessment] Batch assessment complete', {
      totalImages: imageUrls.length,
      totalDamages: results.reduce((sum, r) => sum + r.consensus.damages.length, 0)
    });

    return results;
  }

  /**
   * Run damage detection with multiple vision models in parallel
   */
  private async runMultiModelDetection(
    imageUrl: string,
    propertyContext?: PropertyContext
  ): Promise<ModelDamageResult[]> {
    const prompt = this.createDamageDetectionPrompt(propertyContext);

    // Run all models in parallel for speed
    const modelPromises = this.visionModels.map(async (model) => {
      const modelStartTime = Date.now();

      try {
        logger.debug(`[DamageAssessment] Calling ${model.name}`, { model: model.id });

        const visionRequest = this.openRouterClient.createVisionRequest(
          model.id,
          'You are an expert property inspector analyzing images for damage assessment.',
          imageUrl,
          prompt,
          {
            max_tokens: 2000,
            temperature: 0.1,
            response_format: { type: 'json_object' }
          }
        );

        const response = await this.openRouterClient.createCompletion(visionRequest);

        const processingTime = Date.now() - modelStartTime;

        // Parse response to extract damages
        const content = response.choices[0]?.message?.content || '{}';
        const parsed = this.parseDamageResponse(content, model.name);

        logger.info(`[DamageAssessment] ${model.name} completed`, {
          damages: parsed.length,
          processingTime
        });

        return {
          model: model.name,
          damages: parsed,
          confidence: this.calculateModelConfidence(parsed),
          processingTime
        };
      } catch (error) {
        logger.error(`[DamageAssessment] ${model.name} failed`, {
          error: error instanceof Error ? error.message : 'Unknown error'
        });

        return {
          model: model.name,
          damages: [],
          confidence: 0,
          processingTime: Date.now() - modelStartTime,
          error: error instanceof Error ? error.message : 'Unknown error'
        };
      }
    });

    const results = await Promise.all(modelPromises);

    // Filter out failed models
    const successfulResults = results.filter(r => !r.error && r.damages.length > 0);

    if (successfulResults.length === 0) {
      throw new Error('All vision models failed to detect damages');
    }

    return results;
  }

  /**
   * Build consensus from multiple model results
   */
  private async buildConsensus(
    modelResults: ModelDamageResult[]
  ): Promise<DamageConsensusResult> {
    // Group similar damages across models
    const damageGroups = this.groupSimilarDamages(modelResults);

    // Merge damages with consensus scoring
    const consensusDamages = this.mergeDamageGroups(damageGroups);

    // Calculate consensus strength (how much models agreed)
    const consensusStrength = this.calculateConsensusStrength(damageGroups, modelResults.length);

    // Calculate overall confidence score
    const confidenceScore = this.calculateOverallConfidence(consensusDamages, consensusStrength);

    // Generate summary
    const summary = this.generateSummary(consensusDamages);

    // Identify uncertainties (damages only detected by 1 model)
    const uncertainties = this.identifyUncertainties(damageGroups);

    logger.info('[DamageAssessment] Consensus built', {
      totalDamages: consensusDamages.length,
      consensusStrength,
      confidenceScore,
      uncertainties: uncertainties.length
    });

    return {
      damages: consensusDamages,
      consensusStrength,
      confidenceScore,
      modelResults,
      summary,
      uncertainties
    };
  }

  /**
   * Create structured prompt for damage detection
   */
  private createDamageDetectionPrompt(propertyContext?: PropertyContext): string {
    let contextInfo = '';
    if (propertyContext) {
      contextInfo = `\n\nProperty Context:
- Property Type: ${propertyContext.propertyType || 'unknown'}
- Inspection Type: ${propertyContext.inspectionType || 'general'}
- Location: ${propertyContext.location || 'unknown'}`;

      if (propertyContext.previousDamages && propertyContext.previousDamages.length > 0) {
        contextInfo += `\n- Previous Damages: ${propertyContext.previousDamages.map(d => `${d.type} (${d.location})`).join(', ')}`;
      }
    }

    return `Analyze this property image for damage assessment. Identify and categorize ALL visible damage.${contextInfo}

**CRITICAL**: Return ONLY valid JSON. No markdown, no code blocks, just pure JSON.

DAMAGE CATEGORIES:
1. structural - cracks, holes, water damage, foundation issues, structural failures
2. surface - stains, scratches, burns, paint damage, wall damage, floor damage
3. fixtures - broken items, missing components, damaged appliances, plumbing issues
4. mold_moisture - mold growth, water stains, moisture damage, dampness

For EACH damage found, provide:
- type: One of the 4 categories above
- severity: "minor" | "moderate" | "severe" | "critical"
- location: Describe where in the image (be specific: "upper left wall", "ceiling corner", "floor near door", etc.)
- size: Estimated dimensions {length, width, area, unit: "inches"|"feet"|"meters"}
- description: Detailed observation (what you see, color, texture, extent)
- repairUrgency: "immediate" | "soon" | "routine"
- confidence: 0.0 to 1.0 (your confidence in this detection)

Return JSON in this EXACT structure:
{
  "damages": [
    {
      "type": "structural",
      "severity": "severe",
      "location": "upper right corner of ceiling",
      "size": {"length": 12, "width": 8, "area": 96, "unit": "inches"},
      "description": "Large water stain with visible cracks radiating from center, brown discoloration",
      "repairUrgency": "immediate",
      "confidence": 0.95
    }
  ]
}

REQUIREMENTS:
- Detect ALL visible damages, even minor ones
- Be specific and detailed in descriptions
- Provide realistic size estimates
- Assess repair urgency accurately
- If NO damages visible, return {"damages": []}
- Return ONLY the JSON object, no explanations`;
  }

  /**
   * Parse damage response from model
   */
  private parseDamageResponse(content: string, modelName: string): DamageDetection[] {
    try {
      // Remove markdown code blocks if present
      let cleaned = content.trim();
      if (cleaned.startsWith('```json')) {
        cleaned = cleaned.replace(/```json\n?/g, '').replace(/```\n?$/g, '');
      } else if (cleaned.startsWith('```')) {
        cleaned = cleaned.replace(/```\n?/g, '');
      }

      const parsed = JSON.parse(cleaned);

      if (!parsed.damages || !Array.isArray(parsed.damages)) {
        logger.warn(`[DamageAssessment] Invalid response from ${modelName}: missing damages array`);
        return [];
      }

      // Validate and normalize each damage
      return parsed.damages
        .filter((d: any) => this.isValidDamage(d))
        .map((d: any) => this.normalizeDamage(d));
    } catch (error) {
      logger.error(`[DamageAssessment] Failed to parse response from ${modelName}`, {
        error: error instanceof Error ? error.message : 'Unknown error',
        content: content.substring(0, 200)
      });
      return [];
    }
  }

  /**
   * Validate damage object
   */
  private isValidDamage(damage: any): boolean {
    return (
      damage &&
      typeof damage === 'object' &&
      damage.type &&
      damage.severity &&
      damage.location &&
      damage.description &&
      damage.repairUrgency
    );
  }

  /**
   * Normalize damage object to standard format
   */
  private normalizeDamage(damage: any): DamageDetection {
    return {
      type: damage.type,
      severity: damage.severity,
      location: damage.location,
      size: damage.size || undefined,
      description: damage.description,
      repairUrgency: damage.repairUrgency,
      confidence: damage.confidence || 0.5
    };
  }

  /**
   * Calculate confidence for model's overall result
   */
  private calculateModelConfidence(damages: DamageDetection[]): number {
    if (damages.length === 0) return 0;
    const avgConfidence = damages.reduce((sum, d) => sum + d.confidence, 0) / damages.length;
    return avgConfidence;
  }

  /**
   * Group similar damages across models
   */
  private groupSimilarDamages(
    modelResults: ModelDamageResult[]
  ): Array<{ damages: Array<{ damage: DamageDetection; model: string }>; similarity: number }> {
    const groups: Array<{
      damages: Array<{ damage: DamageDetection; model: string }>;
      similarity: number;
    }> = [];

    // Collect all damages from all models
    const allDamages: Array<{ damage: DamageDetection; model: string }> = [];
    for (const result of modelResults) {
      for (const damage of result.damages) {
        allDamages.push({ damage, model: result.model });
      }
    }

    // Group damages by similarity
    for (const item of allDamages) {
      let foundGroup = false;

      for (const group of groups) {
        const firstDamage = group.damages[0].damage;
        const similarity = this.calculateDamageSimilarity(firstDamage, item.damage);

        if (similarity > 0.6) {
          // Damages are similar enough to group
          group.damages.push(item);
          group.similarity = Math.max(group.similarity, similarity);
          foundGroup = true;
          break;
        }
      }

      if (!foundGroup) {
        // Create new group
        groups.push({
          damages: [item],
          similarity: 1.0
        });
      }
    }

    return groups;
  }

  /**
   * Calculate similarity between two damages (0-1)
   */
  private calculateDamageSimilarity(d1: DamageDetection, d2: DamageDetection): number {
    let score = 0;

    // Type match (40% weight)
    if (d1.type === d2.type) score += 0.4;

    // Severity match (20% weight)
    if (d1.severity === d2.severity) score += 0.2;

    // Location similarity (30% weight) - simple keyword matching
    const loc1 = d1.location.toLowerCase();
    const loc2 = d2.location.toLowerCase();
    const commonWords = loc1.split(' ').filter(word => loc2.includes(word));
    const locationSimilarity = commonWords.length / Math.max(loc1.split(' ').length, loc2.split(' ').length);
    score += locationSimilarity * 0.3;

    // Description similarity (10% weight)
    const desc1 = d1.description.toLowerCase();
    const desc2 = d2.description.toLowerCase();
    const commonDescWords = desc1.split(' ').filter(word => desc2.includes(word));
    const descSimilarity = commonDescWords.length / Math.max(desc1.split(' ').length, desc2.split(' ').length);
    score += descSimilarity * 0.1;

    return Math.min(score, 1.0);
  }

  /**
   * Merge damage groups into consensus damages
   */
  private mergeDamageGroups(
    groups: Array<{ damages: Array<{ damage: DamageDetection; model: string }>; similarity: number }>
  ): DamageDetection[] {
    return groups.map(group => {
      // Damages detected by multiple models = HIGH confidence
      const modelCount = new Set(group.damages.map(d => d.model)).size;

      // Take most common values for each field
      const merged: DamageDetection = {
        type: this.mostCommon(group.damages.map(d => d.damage.type)),
        severity: this.mostCommon(group.damages.map(d => d.damage.severity)),
        location: this.mostDetailed(group.damages.map(d => d.damage.location)),
        description: this.mostDetailed(group.damages.map(d => d.damage.description)),
        repairUrgency: this.mostCommon(group.damages.map(d => d.damage.repairUrgency)),
        confidence: this.mergeConfidences(group.damages.map(d => d.damage.confidence), modelCount),
        size: this.mergeSize(group.damages.map(d => d.damage.size))
      };

      return merged;
    });
  }

  /**
   * Get most common value from array
   */
  private mostCommon<T>(values: T[]): T {
    const counts = new Map<T, number>();
    for (const value of values) {
      counts.set(value, (counts.get(value) || 0) + 1);
    }
    let maxCount = 0;
    let mostCommonValue = values[0];
    for (const [value, count] of counts) {
      if (count > maxCount) {
        maxCount = count;
        mostCommonValue = value;
      }
    }
    return mostCommonValue;
  }

  /**
   * Get most detailed (longest) description
   */
  private mostDetailed(descriptions: string[]): string {
    return descriptions.reduce((longest, current) =>
      current.length > longest.length ? current : longest
    , descriptions[0]);
  }

  /**
   * Merge confidences with boost for multi-model agreement
   */
  private mergeConfidences(confidences: number[], modelCount: number): number {
    const avgConfidence = confidences.reduce((sum, c) => sum + c, 0) / confidences.length;

    // Boost confidence if multiple models agree (up to 0.95 max)
    const agreementBoost = Math.min((modelCount - 1) * 0.15, 0.35);
    return Math.min(avgConfidence + agreementBoost, 0.95);
  }

  /**
   * Merge size estimates (average if available)
   */
  private mergeSize(
    sizes: Array<DamageDetection['size']>
  ): DamageDetection['size'] | undefined {
    const validSizes = sizes.filter(s => s !== undefined) as Array<{
      length?: number;
      width?: number;
      area?: number;
      unit: string;
    }>;

    if (validSizes.length === 0) return undefined;

    // Average all measurements
    const avgLength = validSizes.filter(s => s.length).reduce((sum, s) => sum + (s.length || 0), 0) / validSizes.filter(s => s.length).length;
    const avgWidth = validSizes.filter(s => s.width).reduce((sum, s) => sum + (s.width || 0), 0) / validSizes.filter(s => s.width).length;
    const avgArea = validSizes.filter(s => s.area).reduce((sum, s) => sum + (s.area || 0), 0) / validSizes.filter(s => s.area).length;

    return {
      length: isNaN(avgLength) ? undefined : Math.round(avgLength * 10) / 10,
      width: isNaN(avgWidth) ? undefined : Math.round(avgWidth * 10) / 10,
      area: isNaN(avgArea) ? undefined : Math.round(avgArea * 10) / 10,
      unit: this.mostCommon(validSizes.map(s => s.unit)) as any
    };
  }

  /**
   * Calculate consensus strength (how much models agreed)
   */
  private calculateConsensusStrength(
    groups: Array<{ damages: Array<{ damage: DamageDetection; model: string }> }>,
    totalModels: number
  ): number {
    if (groups.length === 0) return 0;

    // Calculate average model agreement per group
    const agreementScores = groups.map(group => {
      const modelCount = new Set(group.damages.map(d => d.model)).size;
      return modelCount / totalModels;
    });

    return agreementScores.reduce((sum, score) => sum + score, 0) / agreementScores.length;
  }

  /**
   * Calculate overall confidence score
   */
  private calculateOverallConfidence(
    damages: DamageDetection[],
    consensusStrength: number
  ): number {
    if (damages.length === 0) return 0;

    const avgDamageConfidence = damages.reduce((sum, d) => sum + d.confidence, 0) / damages.length;

    // Combine damage confidence with consensus strength
    return (avgDamageConfidence * 0.6) + (consensusStrength * 0.4);
  }

  /**
   * Generate human-readable summary
   */
  private generateSummary(damages: DamageDetection[]): string {
    if (damages.length === 0) {
      return 'No damages detected in the inspected area.';
    }

    const severityCounts = {
      critical: damages.filter(d => d.severity === 'critical').length,
      severe: damages.filter(d => d.severity === 'severe').length,
      moderate: damages.filter(d => d.severity === 'moderate').length,
      minor: damages.filter(d => d.severity === 'minor').length
    };

    const typeCounts = damages.reduce((acc, d) => {
      acc[d.type] = (acc[d.type] || 0) + 1;
      return acc;
    }, {} as Record<string, number>);

    let summary = `Detected ${damages.length} damage${damages.length > 1 ? 's' : ''}: `;

    const severityParts: string[] = [];
    if (severityCounts.critical > 0) severityParts.push(`${severityCounts.critical} critical`);
    if (severityCounts.severe > 0) severityParts.push(`${severityCounts.severe} severe`);
    if (severityCounts.moderate > 0) severityParts.push(`${severityCounts.moderate} moderate`);
    if (severityCounts.minor > 0) severityParts.push(`${severityCounts.minor} minor`);

    summary += severityParts.join(', ') + '. ';

    const typeParts = Object.entries(typeCounts).map(([type, count]) => `${count} ${type}`);
    summary += 'Types: ' + typeParts.join(', ') + '.';

    return summary;
  }

  /**
   * Identify uncertainties (damages only detected by 1 model)
   */
  private identifyUncertainties(
    groups: Array<{ damages: Array<{ damage: DamageDetection; model: string }> }>
  ): string[] {
    return groups
      .filter(group => new Set(group.damages.map(d => d.model)).size === 1)
      .map(group => {
        const damage = group.damages[0].damage;
        const model = group.damages[0].model;
        return `${damage.type} damage at ${damage.location} (only detected by ${model}, confidence: ${damage.confidence})`;
      });
  }

  /**
   * Estimate repair costs based on detected damages
   */
  private estimateCosts(damages: DamageDetection[]): CostEstimate {
    // Simple cost estimation model
    // In production, this would use historical data, location-based pricing, etc.

    const breakdown: Array<{
      damageType: string;
      cost: { min: number; max: number };
      laborHours?: number;
      materials?: string[];
    }> = [];

    let totalMin = 0;
    let totalMax = 0;

    for (const damage of damages) {
      const estimate = this.estimateSingleDamageCost(damage);
      breakdown.push(estimate);
      totalMin += estimate.cost.min;
      totalMax += estimate.cost.max;
    }

    return {
      totalEstimate: {
        min: Math.round(totalMin),
        max: Math.round(totalMax),
        currency: 'USD'
      },
      breakdown,
      disclaimers: [
        'Cost estimates are approximate and based on general industry averages',
        'Actual costs may vary based on location, materials, and contractor rates',
        'Hidden damages may be discovered during repair work',
        'Costs include both labor and materials',
        'Professional inspection recommended for accurate pricing'
      ]
    };
  }

  /**
   * Estimate cost for a single damage
   */
  private estimateSingleDamageCost(damage: DamageDetection): {
    damageType: string;
    cost: { min: number; max: number };
    laborHours?: number;
    materials?: string[];
  } {
    // Base costs by type and severity (USD)
    const baseCosts: Record<string, Record<string, { min: number; max: number; hours: number }>> = {
      structural: {
        critical: { min: 5000, max: 15000, hours: 40 },
        severe: { min: 2000, max: 8000, hours: 20 },
        moderate: { min: 500, max: 2000, hours: 8 },
        minor: { min: 100, max: 500, hours: 2 }
      },
      surface: {
        critical: { min: 1000, max: 3000, hours: 16 },
        severe: { min: 500, max: 1500, hours: 8 },
        moderate: { min: 150, max: 500, hours: 4 },
        minor: { min: 50, max: 150, hours: 1 }
      },
      fixtures: {
        critical: { min: 2000, max: 5000, hours: 20 },
        severe: { min: 800, max: 2000, hours: 10 },
        moderate: { min: 300, max: 800, hours: 4 },
        minor: { min: 100, max: 300, hours: 2 }
      },
      mold_moisture: {
        critical: { min: 3000, max: 10000, hours: 30 },
        severe: { min: 1500, max: 5000, hours: 15 },
        moderate: { min: 500, max: 1500, hours: 6 },
        minor: { min: 200, max: 500, hours: 3 }
      },
      other: {
        critical: { min: 1000, max: 3000, hours: 12 },
        severe: { min: 500, max: 1500, hours: 6 },
        moderate: { min: 200, max: 800, hours: 3 },
        minor: { min: 50, max: 200, hours: 1 }
      }
    };

    const typeBase = baseCosts[damage.type] || baseCosts.other;
    const severityBase = typeBase[damage.severity] || typeBase.minor;

    // Adjust for size if available
    let sizeMultiplier = 1.0;
    if (damage.size?.area) {
      // Scale cost based on area (larger = more expensive)
      const sqFt = damage.size.unit === 'feet' ? damage.size.area :
                   damage.size.unit === 'meters' ? damage.size.area * 10.764 :
                   damage.size.area / 144; // inches to sq ft

      if (sqFt > 50) sizeMultiplier = 2.0;
      else if (sqFt > 20) sizeMultiplier = 1.5;
      else if (sqFt > 10) sizeMultiplier = 1.2;
    }

    return {
      damageType: `${damage.severity} ${damage.type} - ${damage.location}`,
      cost: {
        min: Math.round(severityBase.min * sizeMultiplier),
        max: Math.round(severityBase.max * sizeMultiplier)
      },
      laborHours: Math.round(severityBase.hours * sizeMultiplier),
      materials: this.getMaterialsForDamage(damage)
    };
  }

  /**
   * Get typical materials needed for damage type
   */
  private getMaterialsForDamage(damage: DamageDetection): string[] {
    const materialMap: Record<string, string[]> = {
      structural: ['lumber', 'drywall', 'joint compound', 'primer', 'paint', 'structural reinforcements'],
      surface: ['primer', 'paint', 'sandpaper', 'patching compound', 'tape'],
      fixtures: ['replacement parts', 'plumbing supplies', 'electrical components', 'mounting hardware'],
      mold_moisture: ['mold remediation chemicals', 'dehumidifier', 'HEPA filters', 'protective equipment', 'sealant'],
      other: ['general repair materials']
    };

    return materialMap[damage.type] || materialMap.other;
  }

  /**
   * Store assessment in GraphRAG for future reference
   */
  private async storeAssessment(
    requestId: string,
    consensus: DamageConsensusResult,
    propertyContext?: PropertyContext
  ): Promise<void> {
    try {
      await graphRAGClient.storeMemory({
        content: JSON.stringify({
          requestId,
          damages: consensus.damages,
          summary: consensus.summary,
          consensusStrength: consensus.consensusStrength,
          confidenceScore: consensus.confidenceScore,
          propertyId: propertyContext?.propertyId,
          inspectionType: propertyContext?.inspectionType
        }),
        tags: [
          'damage-assessment',
          'vision-consensus',
          propertyContext?.propertyId || 'unknown-property',
          `inspection-${propertyContext?.inspectionType || 'general'}`
        ],
        metadata: {
          type: 'damage-assessment',
          timestamp: new Date().toISOString(),
          damageCount: consensus.damages.length,
          consensusStrength: consensus.consensusStrength
        }
      });

      logger.debug('[DamageAssessment] Assessment stored in GraphRAG', { requestId });
    } catch (error) {
      logger.error('[DamageAssessment] Failed to store assessment in GraphRAG', {
        requestId,
        error: error instanceof Error ? error.message : 'Unknown error'
      });
      // Don't throw - storage failure shouldn't fail the assessment
    }
  }

  /**
   * Get available vision models
   */
  getAvailableModels(): Array<{ id: string; name: string }> {
    return this.visionModels;
  }

  /**
   * Cleanup resources
   */
  async cleanup(): Promise<void> {
    await this.openRouterClient.cleanup();
  }
}

// Export singleton instance
export const damageAssessmentService = new DamageAssessmentService();
