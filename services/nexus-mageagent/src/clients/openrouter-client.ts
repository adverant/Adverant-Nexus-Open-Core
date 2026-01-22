import axios, { AxiosInstance } from 'axios';
import axiosRetry from 'axios-retry';
import { Agent as HttpAgent } from 'http';
import { Agent as HttpsAgent } from 'https';
import { logger } from '../utils/logger';
import CircuitBreaker from 'opossum';
import { ErrorFactory, ExternalServiceError } from '../utils/errors';

export interface OpenRouterModel {
  id: string;
  name: string;
  description?: string;
  pricing: {
    prompt: number;
    completion: number;
    image?: number;
  };
  context_length: number;
  architecture: {
    modality: string;
    tokenizer: string;
    instruct_type?: string;
  };
  top_provider: {
    context_length?: number;
    max_completion_tokens?: number;
    is_moderated?: boolean;
  };
  per_request_limits?: {
    prompt_tokens?: number;
    completion_tokens?: number;
  };
}

/**
 * Message content types for multimodal support (text + vision)
 */
export type MessageContent =
  | string // Simple text content
  | Array<{ // Multimodal content array
      type: 'text' | 'image_url';
      text?: string;
      image_url?: {
        url: string; // base64 data URL or HTTP URL
        detail?: 'auto' | 'low' | 'high';
      };
    }>;

export interface CompletionRequest {
  model: string;
  messages: Array<{
    role: 'system' | 'user' | 'assistant';
    content: MessageContent; // Now supports both string and multimodal
  }>;
  max_tokens?: number;
  temperature?: number;
  top_p?: number;
  stream?: boolean;
  stop?: string[];
  frequency_penalty?: number;
  presence_penalty?: number;
  repetition_penalty?: number;
  seed?: number;
  tools?: any[];
  tool_choice?: any;
  response_format?: { type: 'json_object' };
  // OpenRouter specific
  transforms?: string[];
  models?: string[]; // Fallback models
  route?: 'fallback' | 'weighted';
}

export interface CompletionResponse {
  id: string;
  choices: Array<{
    message: {
      role: string;
      content: string;
      tool_calls?: any[];
    };
    finish_reason: string;
  }>;
  model: string;
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

export class OpenRouterClient {
  private httpClient: AxiosInstance;
  private circuitBreaker: CircuitBreaker;
  private modelCache: Map<string, OpenRouterModel> = new Map();
  private filterFreeModels: boolean;
  // PHASE 3 FIX: Keep references to HTTP agents for proper cleanup
  private httpAgent: HttpAgent;
  private httpsAgent: HttpsAgent;

  constructor(
    private apiKey: string,
    private baseUrl: string,
    options?: { filterFreeModels?: boolean; maxTimeout?: number }
  ) {
    if (!apiKey) {
      throw ErrorFactory.configurationError(
        'OpenRouter API key is required but not provided',
        {
          environment: process.env.OPENROUTER_API_KEY ? 'set but invalid' : 'not set',
          action: 'Set valid OPENROUTER_API_KEY environment variable',
          documentation: 'https://openrouter.ai/keys'
        }
      );
    }

    // CRITICAL: Always filter free models by default
    this.filterFreeModels = options?.filterFreeModels !== false;

    // REFACTORING FIX: Align timeout with TaskManager max timeout (1.8M ms = 30 min)
    // Previously: 300000ms (5 min) caused failures for long-running tasks
    // Root Cause: HTTP timeout < Task timeout = guaranteed failures
    // Solution: Use adaptive timeout up to 30 minutes to match TaskManager
    const maxTimeout = options?.maxTimeout || 1800000; // 30 minutes default, aligned with TaskManager

    // PHASE 3 FIX: Create HTTP/HTTPS agents with proper connection pooling
    // This prevents connection leaks and enables proper cleanup on shutdown
    this.httpAgent = new HttpAgent({
      keepAlive: true,
      keepAliveMsecs: 30000, // 30 seconds keep-alive
      maxSockets: 50, // Max concurrent connections
      maxFreeSockets: 10, // Max idle connections
      timeout: maxTimeout,
      scheduling: 'fifo'
    });

    this.httpsAgent = new HttpsAgent({
      keepAlive: true,
      keepAliveMsecs: 30000,
      maxSockets: 50,
      maxFreeSockets: 10,
      timeout: maxTimeout,
      scheduling: 'fifo'
    });

    this.httpClient = axios.create({
      baseURL: this.baseUrl,
      headers: {
        'Authorization': `Bearer ${this.apiKey}`,
        'HTTP-Referer': 'https://adverant.ai',
        'X-Title': 'MageAgent Multi-Model Orchestrator',
        'Content-Type': 'application/json'
      },
      timeout: maxTimeout, // Adaptive timeout: 30 min max for extreme complexity tasks
      httpAgent: this.httpAgent, // PHASE 3: Use custom agents for connection pooling
      httpsAgent: this.httpsAgent
    });
    
    // Add retry logic
    axiosRetry(this.httpClient, {
      retries: 3,
      retryDelay: axiosRetry.exponentialDelay,
      retryCondition: (error) => {
        return axiosRetry.isNetworkOrIdempotentRequestError(error) ||
          [429, 502, 503, 504].includes(error.response?.status || 0);
      }
    });
    
    // Setup circuit breaker with aligned timeout
    // REFACTORING FIX: Circuit breaker timeout must match HTTP client timeout
    // Previous mismatch caused premature circuit breaks for valid long-running requests
    this.circuitBreaker = new CircuitBreaker(
      this.makeRequest.bind(this),
      {
        timeout: maxTimeout, // Aligned with HTTP client: 30 minutes for extreme tasks
        errorThresholdPercentage: 50,
        resetTimeout: 30000,
        volumeThreshold: 10
      }
    );
    
    this.circuitBreaker.on('open', () => {
      logger.error('OpenRouter circuit breaker opened');
    });
    
    this.circuitBreaker.on('halfOpen', () => {
      logger.warn('OpenRouter circuit breaker half-open, testing...');
    });
  }
  
  /**
   * Check if a model is free (should be filtered out)
   */
  private isFreeModel(model: OpenRouterModel): boolean {
    // Check if model ID contains ':free' suffix
    if (model.id.includes(':free')) {
      return true;
    }

    // Check if pricing is exactly zero for both prompt and completion
    if (model.pricing.prompt === 0 && model.pricing.completion === 0) {
      return true;
    }

    // Additional checks for known free model patterns
    const freePatterns = [
      /free$/i,
      /\bfree\b/i,
      /-free-/i,
    ];

    return freePatterns.some(pattern => pattern.test(model.id));
  }

  async listAvailableModels(options?: { includeFreeModels?: boolean }): Promise<OpenRouterModel[]> {
    try {
      const response = await this.httpClient.get('/models');
      let models = response.data.data as OpenRouterModel[];

      // CRITICAL: Filter out free models unless explicitly requested
      const shouldFilterFree = this.filterFreeModels && !options?.includeFreeModels;
      if (shouldFilterFree) {
        const beforeCount = models.length;
        models = models.filter(model => !this.isFreeModel(model));
        const filteredCount = beforeCount - models.length;

        if (filteredCount > 0) {
          logger.info(`Filtered out ${filteredCount} free models (policy: no free models allowed)`, {
            totalModels: beforeCount,
            paidModels: models.length
          });
        }
      }

      // Cache models
      models.forEach(model => {
        this.modelCache.set(model.id, model);
      });

      logger.info(`Loaded ${models.length} paid models from OpenRouter`);
      return models;
    } catch (error) {
      const errorDetails = {
        message: error instanceof Error ? error.message : 'Unknown error',
        code: (error as any).code,
        response: (error as any).response?.data,
        status: (error as any).response?.status,
        apiKey: this.apiKey ? `${this.apiKey.substring(0, 10)}...` : 'not set',
        endpoint: `${this.baseUrl}/models`,
        timestamp: new Date().toISOString()
      };

      logger.error('OpenRouter model listing failed:', errorDetails);

      throw new Error(
        `OpenRouter API Fatal Error:\n` +
        `Status: ${errorDetails.status || 'No Response'}\n` +
        `Message: ${errorDetails.message}\n` +
        `Response: ${JSON.stringify(errorDetails.response || 'No response body')}\n` +
        `API Key: ${errorDetails.apiKey}\n` +
        `Endpoint: ${errorDetails.endpoint}\n` +
        `Timestamp: ${errorDetails.timestamp}\n` +
        `Action Required: Verify API key is valid and has sufficient credits`
      );
    }
  }
  
  async createCompletion(request: CompletionRequest): Promise<CompletionResponse> {
    // CRITICAL: Validate model is not free before making request
    if (this.filterFreeModels) {
      const modelInfo = this.modelCache.get(request.model);
      if (modelInfo && this.isFreeModel(modelInfo)) {
        throw ErrorFactory.validationError(
          `Attempted to use free model '${request.model}'. Free models are not allowed by policy.`,
          ['model'],
          {
            providedModel: request.model,
            suggestion: 'Please select a paid model from the /models endpoint'
          }
        );
      }

      // Also check fallback models if specified
      if (request.models && request.models.length > 0) {
        for (const fallbackModel of request.models) {
          const fallbackInfo = this.modelCache.get(fallbackModel);
          if (fallbackInfo && this.isFreeModel(fallbackInfo)) {
            logger.warn(`Removing free fallback model from chain: ${fallbackModel}`);
            request.models = request.models.filter(m => m !== fallbackModel);
          }
        }
      }
    }

    return this.circuitBreaker.fire(request) as Promise<CompletionResponse>;
  }
  
  private async makeRequest(request: CompletionRequest): Promise<CompletionResponse> {
    const startTime = Date.now();
    
    try {
      // Log request details (without sensitive content)
      logger.debug('OpenRouter completion request', {
        model: request.model,
        messageCount: request.messages.length,
        maxTokens: request.max_tokens,
        temperature: request.temperature,
        stream: request.stream
      });
      
      const response = await this.httpClient.post('/chat/completions', request);
      
      const latency = Date.now() - startTime;
      logger.info('OpenRouter completion successful', {
        model: request.model,
        actualModel: response.data.model,
        usage: response.data.usage,
        latencyMs: latency
      });
      
      return response.data;
    } catch (error) {
      const latency = Date.now() - startTime;
      
      // Enhanced error logging
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      const status = (error as any).response?.status;
      const statusText = (error as any).response?.statusText;
      const responseData = (error as any).response?.data;
      const errorDetails = responseData?.error?.message || errorMessage;

      logger.error('OpenRouter API error', {
        error: errorMessage,
        status: status,
        statusText: statusText,
        data: responseData,
        model: request.model,
        latencyMs: latency
      });

      // Throw comprehensive error as ExternalServiceError for proper handling
      throw new ExternalServiceError(
        'OpenRouter',
        errorDetails || errorMessage,
        status || 500,
        {
          model: request.model,
          statusText: statusText || 'No Response',
          responseBody: responseData,
          requestSize: JSON.stringify(request.messages).length,
          latency,
          endpoint: `${this.baseUrl}/chat/completions`,
          timestamp: new Date().toISOString(),
          possibleCauses: [
            'Invalid or expired API key',
            'Insufficient credits in OpenRouter account',
            `Model ${request.model} not available`,
            'Rate limit exceeded',
            'Request too large for model'
          ],
          action: 'Check OpenRouter dashboard at https://openrouter.ai/activity',
          originalError: error instanceof Error ? error.message : String(error)
        }
      );
    }
  }
  
  async *streamCompletion(request: CompletionRequest): AsyncGenerator<string, void, unknown> {
    const streamRequest = { ...request, stream: true };
    
    try {
      const response = await this.httpClient.post('/chat/completions', streamRequest, {
        responseType: 'stream'
      });
      
      const stream = response.data;
      let buffer = '';
      
      for await (const chunk of stream) {
        buffer += chunk.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';
        
        for (const line of lines) {
          if (line.trim() === '') continue;
          if (line.trim() === 'data: [DONE]') return;
          
          if (line.startsWith('data: ')) {
            try {
              const data = JSON.parse(line.slice(6));
              const content = data.choices?.[0]?.delta?.content;
              if (content) {
                yield content;
              }
            } catch (e) {
              logger.warn('Failed to parse streaming chunk:', e);
            }
          }
        }
      }
    } catch (error) {
      logger.error('OpenRouter streaming error:', error);
      throw error;
    }
  }
  
  async testConnection(): Promise<boolean> {
    const startTime = Date.now();
    try {
      // Set aggressive timeout for health check
      const testClient = axios.create({
        baseURL: this.baseUrl,
        timeout: 5000, // 5 second timeout for health check
        headers: {
          'Authorization': `Bearer ${this.apiKey}`,
          'HTTP-Referer': 'https://adverant.ai',
          'X-Title': 'MageAgent Health Check'
        }
      });

      const response = await testClient.get('/models');
      const models = response.data?.data || [];

      if (models.length === 0) {
        throw new Error('No models available - API key may be invalid or have no permissions');
      }

      logger.info(`OpenRouter connection verified: ${models.length} models available (${Date.now() - startTime}ms)`);
      return true;
    } catch (error) {
      const errorDetails = {
        message: error instanceof Error ? error.message : 'Unknown',
        status: (error as any).response?.status,
        latency: Date.now() - startTime,
        apiKeyPrefix: this.apiKey ? this.apiKey.substring(0, 10) : 'not set'
      };

      logger.error('OpenRouter connection test failed:', errorDetails);

      throw new Error(
        `OpenRouter Connection Test Failed:\n` +
        `Status: ${errorDetails.status || 'No Response'}\n` +
        `Message: ${errorDetails.message}\n` +
        `Latency: ${errorDetails.latency}ms\n` +
        `API Key: ${errorDetails.apiKeyPrefix}...\n` +
        `Action: Verify API key at https://openrouter.ai/keys`
      );
    }
  }
  
  getModel(modelId: string): OpenRouterModel | undefined {
    return this.modelCache.get(modelId);
  }
  
  estimateCost(model: string, promptTokens: number, completionTokens: number): number {
    const modelInfo = this.modelCache.get(model);
    if (!modelInfo) return 0;
    
    const promptCost = (promptTokens / 1000000) * modelInfo.pricing.prompt;
    const completionCost = (completionTokens / 1000000) * modelInfo.pricing.completion;
    
    return promptCost + completionCost;
  }
  
  selectModelsForTask(
    _task: string,
    requirements: {
      maxCost?: number;
      minContextLength?: number;
      modalities?: string[];
      preferredProviders?: string[];
    }
  ): OpenRouterModel[] {
    const models = Array.from(this.modelCache.values());
    
    return models
      .filter(model => {
        // Filter by context length
        if (requirements.minContextLength && 
            model.context_length < requirements.minContextLength) {
          return false;
        }
        
        // Filter by modality
        if (requirements.modalities && 
            !requirements.modalities.includes(model.architecture.modality)) {
          return false;
        }
        
        // Filter by cost (rough estimate)
        if (requirements.maxCost) {
          const estimatedCost = this.estimateCost(model.id, 1000, 1000);
          if (estimatedCost > requirements.maxCost) {
            return false;
          }
        }
        
        return true;
      })
      .sort((a, b) => {
        // Sort by cost (cheapest first)
        const costA = this.estimateCost(a.id, 1000, 1000);
        const costB = this.estimateCost(b.id, 1000, 1000);
        return costA - costB;
      })
      .slice(0, 10); // Return top 10 candidates
  }

  /**
   * Create a vision request with image and text prompt
   *
   * @param model - Vision-capable model (e.g., gpt-4-vision, claude-3.5-sonnet)
   * @param systemPrompt - System instructions for the model
   * @param imageUrl - Image URL (data URL or HTTP URL)
   * @param userPrompt - User's text prompt about the image
   * @param options - Additional completion options
   * @returns CompletionRequest ready to send
   */
  createVisionRequest(
    model: string,
    systemPrompt: string,
    imageUrl: string,
    userPrompt: string,
    options?: Partial<CompletionRequest>
  ): CompletionRequest {
    return {
      model,
      messages: [
        {
          role: 'system',
          content: systemPrompt
        },
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: userPrompt
            },
            {
              type: 'image_url',
              image_url: {
                url: imageUrl,
                detail: 'high' // High detail for damage assessment
              }
            }
          ]
        }
      ],
      max_tokens: options?.max_tokens || 2000,
      temperature: options?.temperature || 0.1, // Low temperature for factual assessment
      ...options
    };
  }

  /**
   * PHASE 3 FIX: Cleanup method to destroy HTTP agents and close connections
   * Prevents memory leaks from lingering HTTP/HTTPS connections
   */
  async cleanup(): Promise<void> {
    try {
      logger.info('Cleaning up OpenRouterClient...');

      // Clear model cache to free memory
      this.modelCache.clear();

      // Close circuit breaker (stops monitoring)
      if (this.circuitBreaker) {
        this.circuitBreaker.shutdown();
      }

      // Destroy HTTP agents to close all keep-alive connections
      // This is CRITICAL for preventing connection leaks
      this.httpAgent.destroy();
      this.httpsAgent.destroy();

      logger.info('OpenRouterClient cleanup complete', {
        modelCacheCleared: true,
        httpAgentsDestroyed: true,
        circuitBreakerShutdown: true
      });
    } catch (error) {
      logger.error('Error during OpenRouterClient cleanup', {
        error: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  }
}
