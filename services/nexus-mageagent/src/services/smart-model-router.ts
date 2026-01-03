import { AgentRole } from '../agents/base-agent';
import { getProfiler, AgentPerformanceProfiler } from './agent-performance-profiler';
import { logger } from '../utils/logger';

export interface ModelSelectionCriteria {
  role: AgentRole;
  complexity: 'simple' | 'medium' | 'complex' | 'extreme';
  optimizeFor?: 'latency' | 'cost' | 'quality' | 'efficiency';
  maxCost?: number;
  maxLatencyMs?: number;
  minQuality?: number;
}

export interface ModelRecommendation {
  model: string;
  reason: string;
  expectedLatencyMs: number;
  expectedCostUsd: number;
  expectedQuality: number;
  costEfficiencyScore: number;
  confidence: number;
}

/**
 * Smart Model Router - Intelligently selects models based on historical performance
 *
 * Uses agent performance profiler data to make cost-quality tradeoff decisions
 * Can reduce costs by 30-50% while maintaining quality by routing simple tasks
 * to cheaper models and complex tasks to premium models
 */
export class SmartModelRouter {
  private profiler: AgentPerformanceProfiler;

  // Model cost estimates (per 1M tokens)
  private modelCosts: Record<string, number> = {
    'anthropic/claude-opus-4': 15.0,
    'anthropic/claude-3.7-sonnet': 3.0,
    'anthropic/claude-3.5-sonnet': 3.0,
    'anthropic/claude-3-haiku': 0.25,
    'openai/gpt-4o': 5.0,
    'openai/gpt-4o-mini': 0.15,
    'google/gemini-2.0-flash': 0.5,
    'google/gemini-pro': 1.5,
    'meta-llama/llama-3.1-405b': 5.0,
    'meta-llama/llama-3.1-70b': 0.9
  };

  // Fallback chains by role
  private fallbackChains: Record<AgentRole, string[]> = {
    [AgentRole.RESEARCH]: [
      'anthropic/claude-opus-4',
      'anthropic/claude-3.7-sonnet',
      'openai/gpt-4o',
      'google/gemini-2.0-flash'
    ],
    [AgentRole.CODING]: [
      'anthropic/claude-3.7-sonnet',
      'openai/gpt-4o',
      'anthropic/claude-3.5-sonnet',
      'google/gemini-2.0-flash'
    ],
    [AgentRole.REVIEW]: [
      'anthropic/claude-opus-4',
      'openai/gpt-4o',
      'anthropic/claude-3.5-sonnet'
    ],
    [AgentRole.SYNTHESIS]: [
      'anthropic/claude-3.7-sonnet',
      'anthropic/claude-3.5-sonnet',
      'google/gemini-2.0-flash'
    ],
    [AgentRole.SPECIALIST]: [
      'anthropic/claude-opus-4',
      'anthropic/claude-3.7-sonnet',
      'openai/gpt-4o'
    ]
  };

  constructor(profiler?: AgentPerformanceProfiler) {
    try {
      this.profiler = profiler || getProfiler();
    } catch (error) {
      // Profiler not initialized yet - will use fallback logic
      logger.warn('AgentPerformanceProfiler not available, using fallback model selection');
      this.profiler = null as any;
    }
  }

  /**
   * Select optimal model based on criteria and historical performance
   */
  async selectModel(criteria: ModelSelectionCriteria): Promise<ModelRecommendation> {
    try {
      // Try to get recommendations from historical data
      if (this.profiler) {
        const bestModels = await this.profiler.getBestModels(
          criteria.role,
          criteria.complexity,
          10,
          criteria.optimizeFor || 'efficiency'
        );

        // Apply filters based on constraints
        const filtered = bestModels.filter(stats => {
          if (criteria.maxCost && stats.avgCostUsd > criteria.maxCost) return false;
          if (criteria.maxLatencyMs && stats.p95LatencyMs > criteria.maxLatencyMs) return false;
          if (criteria.minQuality && stats.avgQualityScore < criteria.minQuality) return false;
          return true;
        });

        if (filtered.length > 0) {
          const selected = filtered[0];
          return {
            model: selected.model,
            reason: this.generateReason(selected, criteria),
            expectedLatencyMs: selected.p95LatencyMs,
            expectedCostUsd: selected.avgCostUsd,
            expectedQuality: selected.avgQualityScore,
            costEfficiencyScore: selected.costEfficiencyScore,
            confidence: this.calculateConfidence(selected.totalExecutions)
          };
        }
      }

      // Fallback to rule-based selection
      return this.selectModelFallback(criteria);
    } catch (error) {
      logger.error('Failed to select model', {
        error: error instanceof Error ? error.message : String(error),
        criteria
      });

      // Final fallback
      return this.selectModelFallback(criteria);
    }
  }

  /**
   * Rule-based model selection fallback
   */
  private selectModelFallback(criteria: ModelSelectionCriteria): ModelRecommendation {
    let selectedModel: string;
    let reason: string;

    // Select based on complexity and optimization goal
    if (criteria.complexity === 'simple' || criteria.optimizeFor === 'cost') {
      // Use cheapest capable model
      if (criteria.role === AgentRole.CODING) {
        selectedModel = 'anthropic/claude-3-haiku';
        reason = 'Simple task with cost optimization - using efficient Haiku model';
      } else {
        selectedModel = 'google/gemini-2.0-flash';
        reason = 'Simple task with cost optimization - using fast Gemini Flash';
      }
    } else if (criteria.complexity === 'extreme' || criteria.minQuality && criteria.minQuality > 0.9) {
      // Use premium model
      selectedModel = 'anthropic/claude-opus-4';
      reason = 'Extreme complexity or high quality requirement - using premium Opus 4 model';
    } else if (criteria.complexity === 'complex') {
      // Use mid-tier premium model
      if (criteria.role === AgentRole.CODING) {
        selectedModel = 'anthropic/claude-3.7-sonnet';
        reason = 'Complex coding task - using Claude 3.7 Sonnet for optimal balance';
      } else {
        selectedModel = 'openai/gpt-4o';
        reason = 'Complex task - using GPT-4o for strong reasoning';
      }
    } else {
      // Medium complexity - use balanced model
      selectedModel = 'anthropic/claude-3.5-sonnet';
      reason = 'Medium complexity - using Claude 3.5 Sonnet for good balance';
    }

    return {
      model: selectedModel,
      reason,
      expectedLatencyMs: this.estimateLatency(selectedModel, criteria.complexity),
      expectedCostUsd: this.estimateCost(selectedModel, 2000), // Assume 2k tokens
      expectedQuality: this.estimateQuality(selectedModel, criteria.complexity),
      costEfficiencyScore: 0,
      confidence: 0.5 // Lower confidence for fallback
    };
  }

  /**
   * Generate human-readable reason for model selection
   */
  private generateReason(stats: any, criteria: ModelSelectionCriteria): string {
    const parts: string[] = [];

    if (criteria.optimizeFor === 'cost') {
      parts.push(`Most cost-efficient model for ${criteria.role} tasks`);
    } else if (criteria.optimizeFor === 'latency') {
      parts.push(`Fastest model for ${criteria.role} tasks`);
    } else if (criteria.optimizeFor === 'quality') {
      parts.push(`Highest quality model for ${criteria.role} tasks`);
    } else {
      parts.push(`Best efficiency (quality/cost) for ${criteria.role} tasks`);
    }

    parts.push(`Based on ${stats.totalExecutions} historical executions`);
    parts.push(`Success rate: ${(stats.successRate * 100).toFixed(1)}%`);
    parts.push(`Avg latency: ${stats.p95LatencyMs}ms (p95)`);
    parts.push(`Avg cost: $${stats.avgCostUsd.toFixed(4)}`);

    return parts.join('. ');
  }

  /**
   * Calculate confidence based on sample size
   */
  private calculateConfidence(executions: number): number {
    if (executions >= 100) return 0.95;
    if (executions >= 50) return 0.85;
    if (executions >= 20) return 0.75;
    if (executions >= 10) return 0.65;
    return 0.5;
  }

  /**
   * Estimate latency for a model (fallback)
   */
  private estimateLatency(model: string, complexity: string): number {
    const baseLatency: Record<string, number> = {
      'anthropic/claude-opus-4': 15000,
      'anthropic/claude-3.7-sonnet': 8000,
      'anthropic/claude-3.5-sonnet': 6000,
      'anthropic/claude-3-haiku': 3000,
      'openai/gpt-4o': 10000,
      'openai/gpt-4o-mini': 4000,
      'google/gemini-2.0-flash': 3500,
      'google/gemini-pro': 7000
    };

    const multiplier: Record<string, number> = {
      'simple': 0.5,
      'medium': 1.0,
      'complex': 2.0,
      'extreme': 4.0
    };

    return (baseLatency[model] || 8000) * (multiplier[complexity] || 1.0);
  }

  /**
   * Estimate cost for a model
   */
  private estimateCost(model: string, tokens: number): number {
    const costPer1M = this.modelCosts[model] || 3.0;
    return (tokens / 1_000_000) * costPer1M;
  }

  /**
   * Estimate quality for a model (fallback)
   */
  private estimateQuality(model: string, complexity: string): number {
    const modelQuality: Record<string, number> = {
      'anthropic/claude-opus-4': 0.95,
      'anthropic/claude-3.7-sonnet': 0.90,
      'anthropic/claude-3.5-sonnet': 0.88,
      'anthropic/claude-3-haiku': 0.82,
      'openai/gpt-4o': 0.92,
      'openai/gpt-4o-mini': 0.85,
      'google/gemini-2.0-flash': 0.85,
      'google/gemini-pro': 0.89
    };

    const complexityPenalty: Record<string, number> = {
      'simple': 0,
      'medium': -0.02,
      'complex': -0.05,
      'extreme': -0.08
    };

    const base = modelQuality[model] || 0.85;
    const penalty = complexityPenalty[complexity] || 0;

    return Math.max(0.6, Math.min(1.0, base + penalty));
  }

  /**
   * Get fallback chain for a role
   */
  getFallbackChain(role: AgentRole): string[] {
    return this.fallbackChains[role] || this.fallbackChains[AgentRole.SPECIALIST];
  }
}

// Singleton
let routerInstance: SmartModelRouter | null = null;

export function getSmartModelRouter(): SmartModelRouter {
  if (!routerInstance) {
    routerInstance = new SmartModelRouter();
  }
  return routerInstance;
}
