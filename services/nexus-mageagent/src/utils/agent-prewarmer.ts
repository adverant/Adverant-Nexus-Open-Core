import { OpenRouterClient } from '../clients/openrouter-client';
import { logger } from './logger';

export interface PrewarmConfig {
  models: string[];
  testPrompt?: string;
  timeout?: number;
}

/**
 * Agent Pre-Warmer - Eliminates cold start penalty for frequently used models
 *
 * Pre-warms models by sending test requests on service startup
 * This ensures the first real user request gets optimal performance
 */
export class AgentPrewarmer {
  private readonly defaultTestPrompt = 'Hello, this is a warmup test. Please respond with "ready".';

  constructor(private openRouterClient: OpenRouterClient) {}

  /**
   * Pre-warm models by sending test requests
   */
  async prewarmModels(config: PrewarmConfig): Promise<void> {
    const { models, testPrompt = this.defaultTestPrompt, timeout = 30000 } = config;

    logger.info('Starting model pre-warming', {
      modelCount: models.length,
      models
    });

    const results = await Promise.allSettled(
      models.map(model => this.prewarmSingleModel(model, testPrompt, timeout))
    );

    const successful = results.filter(r => r.status === 'fulfilled').length;
    const failed = results.filter(r => r.status === 'rejected').length;

    logger.info('Model pre-warming completed', {
      total: models.length,
      successful,
      failed
    });

    // Log failures
    results.forEach((result, index) => {
      if (result.status === 'rejected') {
        logger.warn('Failed to pre-warm model', {
          model: models[index],
          error: result.reason
        });
      }
    });
  }

  /**
   * Pre-warm a single model
   */
  private async prewarmSingleModel(
    model: string,
    prompt: string,
    timeout: number
  ): Promise<void> {
    const startTime = Date.now();

    try {
      await Promise.race([
        this.openRouterClient.chat({
          model,
          messages: [{ role: 'user', content: prompt }],
          max_tokens: 50,
          temperature: 0.1
        }),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('Pre-warm timeout')), timeout)
        )
      ]);

      const duration = Date.now() - startTime;
      logger.info('Model pre-warmed successfully', {
        model,
        durationMs: duration
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error('Model pre-warm failed', {
        model,
        error: errorMessage
      });
      throw error;
    }
  }

  /**
   * Get top N most-used models from performance history
   */
  async getTopModels(limit: number = 5): Promise<string[]> {
    // TODO: Query agent_performance_metrics table for most-used models
    // For now, return sensible defaults
    return [
      'anthropic/claude-opus-4.6',
      'anthropic/claude-3-haiku',
      'openai/gpt-4o',
      'openai/gpt-4o-mini',
      'google/gemini-2.0-flash'
    ].slice(0, limit);
  }
}

/**
 * Pre-warm top N models on service startup
 */
export async function prewarmTopModels(
  openRouterClient: OpenRouterClient,
  limit: number = 5
): Promise<void> {
  const prewarmer = new AgentPrewarmer(openRouterClient);
  const topModels = await prewarmer.getTopModels(limit);

  await prewarmer.prewarmModels({
    models: topModels,
    timeout: 30000
  });
}
