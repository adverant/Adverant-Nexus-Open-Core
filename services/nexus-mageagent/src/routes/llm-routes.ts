/**
 * LLM Routes for VPS Admin Dashboard
 * Provides OpenRouter chat completions and model listing with search/filter capabilities
 *
 * Root Cause Analysis:
 * - Problem: Frontend had API key exposed in client-side bundle (security risk)
 * - Solution: Backend proxy keeps API key server-side
 * - Architecture Decision: Use existing mageagent OpenRouterClient instead of creating new proxy
 *
 * Refactoring Strategy:
 * - Leverage existing OpenRouterClient with robust error handling and circuit breaker
 * - Add dedicated chat endpoint for VPS Admin Dashboard troubleshooting
 * - Add models listing endpoint with filtering and search capabilities
 * - Follow mageagent's established patterns (asyncHandler, ApiResponse, custom errors)
 */

import { Router, Request, Response } from 'express';
import { OpenRouterClient, CompletionRequest } from '../clients/openrouter-client';
import { logger } from '../utils/logger';
import { ApiResponse } from '../utils/api-response';
import { ValidationError, NotFoundError, ErrorFactory } from '../utils/errors';
import { asyncHandler } from '../middleware/error-handler';
import { apiRateLimiters } from '../middleware/security';

const router = Router();

// Initialize OpenRouter client (shared instance from main server)
let openRouterClient: OpenRouterClient | null = null;

/**
 * Initialize LLM routes with OpenRouter client instance
 * Called from main server initialization
 */
export function initializeLLMRoutes(client: OpenRouterClient): Router {
  openRouterClient = client;
  logger.info('[LLM Routes] Initialized with OpenRouter client');
  return router;
}

// ============================================================================
// HEALTH CHECK ENDPOINT
// ============================================================================

/**
 * GET /api/health
 * Health check endpoint for Kubernetes liveness/readiness probes
 *
 * Returns:
 * {
 *   status: 'healthy',
 *   service: 'mageagent',
 *   timestamp: ISO 8601 timestamp,
 *   openrouter: boolean (client initialized)
 * }
 */
router.get('/health', (_req: Request, res: Response) => {
  res.status(200).json({
    status: 'healthy',
    service: 'mageagent',
    timestamp: new Date().toISOString(),
    openrouter: openRouterClient !== null
  });
});

// ============================================================================
// MODELS ENDPOINT
// ============================================================================

/**
 * GET /llm/models
 * List available OpenRouter models with optional filtering and search
 *
 * Query Parameters:
 * - search: string - Search in model ID, name, or description (case-insensitive)
 * - minContext: number - Minimum context length required
 * - maxContext: number - Maximum context length required
 * - modality: string - Filter by modality (e.g., 'text', 'image', 'text+image')
 * - provider: string - Filter models from specific provider
 * - includeFreeModels: boolean - Include free models (default: false)
 * - limit: number - Maximum number of results to return (default: 100)
 *
 * Returns:
 * {
 *   success: true,
 *   data: {
 *     models: OpenRouterModel[],
 *     totalCount: number,
 *     filteredCount: number
 *   }
 * }
 */
router.get('/models',
  apiRateLimiters.general,
  asyncHandler(async (req: Request, res: Response) => {
    if (!openRouterClient) {
      throw ErrorFactory.serviceUnavailable('OpenRouter client');
    }

    // Parse query parameters with validation
    const search = req.query.search as string | undefined;
    const minContext = req.query.minContext ? parseInt(req.query.minContext as string, 10) : undefined;
    const maxContext = req.query.maxContext ? parseInt(req.query.maxContext as string, 10) : undefined;
    const modality = req.query.modality as string | undefined;
    const provider = req.query.provider as string | undefined;
    const includeFreeModels = req.query.includeFreeModels === 'true';
    const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : 100;

    // Validate numeric parameters
    if (minContext !== undefined && (isNaN(minContext) || minContext < 0)) {
      throw new ValidationError('minContext must be a positive number', {
        acceptedFields: ['minContext'],
        context: { provided: req.query.minContext }
      });
    }

    if (maxContext !== undefined && (isNaN(maxContext) || maxContext < 0)) {
      throw new ValidationError('maxContext must be a positive number', {
        acceptedFields: ['maxContext'],
        context: { provided: req.query.maxContext }
      });
    }

    if (limit && (isNaN(limit) || limit < 1 || limit > 1000)) {
      throw new ValidationError('limit must be between 1 and 1000', {
        acceptedFields: ['limit'],
        context: { provided: req.query.limit }
      });
    }

    logger.info('[LLM Routes] Listing models with filters', {
      search,
      minContext,
      maxContext,
      modality,
      provider,
      includeFreeModels,
      limit
    });

    // Fetch all available models
    let models = await openRouterClient.listAvailableModels({ includeFreeModels });
    const totalCount = models.length;

    // Apply filters
    let filteredModels = models;

    // Search filter (matches ID, name, or description)
    if (search) {
      const searchLower = search.toLowerCase();
      filteredModels = filteredModels.filter(model =>
        model.id.toLowerCase().includes(searchLower) ||
        model.name.toLowerCase().includes(searchLower) ||
        (model.description?.toLowerCase().includes(searchLower) ?? false)
      );
    }

    // Context length filters
    if (minContext !== undefined) {
      filteredModels = filteredModels.filter(model => model.context_length >= minContext);
    }

    if (maxContext !== undefined) {
      filteredModels = filteredModels.filter(model => model.context_length <= maxContext);
    }

    // Modality filter
    if (modality) {
      filteredModels = filteredModels.filter(model =>
        model.architecture.modality.toLowerCase() === modality.toLowerCase()
      );
    }

    // Provider filter (matches start of model ID)
    if (provider) {
      const providerLower = provider.toLowerCase();
      filteredModels = filteredModels.filter(model =>
        model.id.toLowerCase().startsWith(providerLower + '/')
      );
    }

    // Apply limit
    const limitedModels = filteredModels.slice(0, limit);

    logger.info('[LLM Routes] Models filtered', {
      totalCount,
      filteredCount: filteredModels.length,
      returnedCount: limitedModels.length
    });

    return ApiResponse.success(res, {
      models: limitedModels,
      totalCount,
      filteredCount: filteredModels.length
    });
  })
);

// ============================================================================
// CHAT ENDPOINT
// ============================================================================

/**
 * POST /llm/chat
 * Send chat completion request to OpenRouter API
 *
 * Request Body:
 * {
 *   model: string - Model ID (e.g., 'anthropic/claude-sonnet-4-5-20250514')
 *   messages: Array<{role: 'system'|'user'|'assistant', content: string}> - Conversation history
 *   temperature?: number - Sampling temperature (0-2, default: 0.7)
 *   max_tokens?: number - Maximum tokens to generate (default: 4000)
 *   top_p?: number - Nucleus sampling parameter (0-1)
 *   stream?: boolean - Whether to stream the response (default: false)
 * }
 *
 * Returns:
 * {
 *   success: true,
 *   data: {
 *     message: string - Assistant's response
 *     model: string - Model ID that was used
 *     usage: {
 *       prompt_tokens: number,
 *       completion_tokens: number,
 *       total_tokens: number
 *     }
 *   }
 * }
 */
router.post('/chat',
  apiRateLimiters.llm,
  asyncHandler(async (req: Request, res: Response) => {
    if (!openRouterClient) {
      throw ErrorFactory.serviceUnavailable('OpenRouter client');
    }

    const { model, messages, temperature = 0.7, max_tokens = 4000, top_p, stream = false } = req.body;

    // Validate required fields
    if (!model || typeof model !== 'string') {
      throw new ValidationError('model is required and must be a string', {
        acceptedFields: ['model'],
        context: { hint: 'Specify a valid OpenRouter model ID like "anthropic/claude-sonnet-4-5-20250514"' }
      });
    }

    if (!messages || !Array.isArray(messages) || messages.length === 0) {
      throw new ValidationError('messages is required and must be a non-empty array', {
        acceptedFields: ['messages'],
        context: { hint: 'Provide an array of message objects with role and content fields' }
      });
    }

    // Validate message format
    for (const msg of messages) {
      if (!msg.role || !msg.content) {
        throw new ValidationError('Each message must have role and content fields', {
          acceptedFields: ['messages[].role', 'messages[].content'],
          context: { invalidMessage: msg }
        });
      }

      if (!['system', 'user', 'assistant'].includes(msg.role)) {
        throw new ValidationError(`Invalid message role: ${msg.role}`, {
          acceptedFields: ['messages[].role'],
          context: {
            invalidRole: msg.role,
            validRoles: ['system', 'user', 'assistant']
          }
        });
      }
    }

    // Validate optional numeric parameters
    if (temperature !== undefined && (typeof temperature !== 'number' || temperature < 0 || temperature > 2)) {
      throw new ValidationError('temperature must be a number between 0 and 2', {
        acceptedFields: ['temperature'],
        context: { provided: temperature }
      });
    }

    if (max_tokens !== undefined && (typeof max_tokens !== 'number' || max_tokens < 1)) {
      throw new ValidationError('max_tokens must be a positive number', {
        acceptedFields: ['max_tokens'],
        context: { provided: max_tokens }
      });
    }

    if (top_p !== undefined && (typeof top_p !== 'number' || top_p < 0 || top_p > 1)) {
      throw new ValidationError('top_p must be a number between 0 and 1', {
        acceptedFields: ['top_p'],
        context: { provided: top_p }
      });
    }

    logger.info('[LLM Routes] Chat completion request', {
      model,
      messageCount: messages.length,
      temperature,
      max_tokens,
      stream
    });

    // Prepare completion request
    const completionRequest: CompletionRequest = {
      model,
      messages,
      temperature,
      max_tokens,
      top_p,
      stream
    };

    // Make request to OpenRouter (circuit breaker handles timeouts and retries)
    const response = await openRouterClient.createCompletion(completionRequest);

    // Extract assistant message
    const assistantMessage = response.choices?.[0]?.message?.content;

    if (!assistantMessage) {
      logger.error('[LLM Routes] No response from OpenRouter API', { response });
      throw new NotFoundError('No response from LLM', {
        context: { model, messageCount: messages.length }
      });
    }

    logger.info('[LLM Routes] Chat completion successful', {
      model: response.model,
      usage: response.usage
    });

    return ApiResponse.success(res, {
      message: assistantMessage,
      model: response.model,
      usage: response.usage
    });
  })
);

// ============================================================================
// HEALTH CHECK
// ============================================================================

/**
 * GET /llm/health
 * Check if OpenRouter client is initialized and configured
 */
router.get('/health',
  asyncHandler(async (_req: Request, res: Response) => {
    return ApiResponse.success(res, {
      configured: !!openRouterClient,
      status: openRouterClient ? 'ready' : 'not_initialized'
    });
  })
);

export { router as llmRoutes };
