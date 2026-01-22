import axios, { AxiosInstance } from 'axios';
import { logger } from '../utils/logger';
import { VoyageModelDiscovery } from './voyage-model-discovery';
import { OpenRouterModelSelector } from './openrouter-model-selector';

/**
 * Intelligent Document Classifier
 * Uses dynamic model selection from OpenRouter to classify documents
 * and automatically selects optimal Voyage AI embedding models
 */

export interface ClassificationResult {
  primaryType: 'text' | 'code' | 'finance' | 'law' | 'image' | 'multimodal' | 'general';
  confidence: number;
  language?: string;
  programmingLanguage?: string;
  topics?: string[];
  suggestedEmbeddingModel?: string;
  metadata?: Record<string, any>;
}

export interface ClassifierConfig {
  openRouterApiKey: string;
  openRouterBaseUrl?: string;
  voyageApiKey: string;
}

export class IntelligentClassifier {
  private httpClient: AxiosInstance;
  private voyageDiscovery: VoyageModelDiscovery;
  private openRouterSelector: OpenRouterModelSelector;

  constructor(config: ClassifierConfig) {
    if (!config.openRouterApiKey) {
      throw new Error(
        'OpenRouter API key is required for intelligent classification. ' +
        'This key enables dynamic model discovery and selection.'
      );
    }

    if (!config.voyageApiKey) {
      throw new Error(
        'Voyage AI API key is required for embedding model discovery. ' +
        'This key enables automatic detection of available embedding models.'
      );
    }

    // Initialize dynamic model selectors
    this.voyageDiscovery = new VoyageModelDiscovery(config.voyageApiKey);
    this.openRouterSelector = new OpenRouterModelSelector(config.openRouterApiKey);

    this.httpClient = axios.create({
      baseURL: config.openRouterBaseUrl || 'https://openrouter.ai/api/v1',
      timeout: 30000,
      headers: {
        'Authorization': `Bearer ${config.openRouterApiKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://graphrag.local',
        'X-Title': 'GraphRAG Dynamic Intelligent Classifier'
      }
    });

    this.httpClient.interceptors.response.use(
      response => response,
      error => {
        const errorDetails = {
          message: error.message,
          status: error.response?.status,
          data: error.response?.data,
          url: error.config?.url
        };

        logger.error('Classification API error', { error: errorDetails });

        throw new Error(
          `Classification failed: ${error.message}. ` +
          `Status: ${error.response?.status || 'N/A'}. ` +
          `Details: ${JSON.stringify(error.response?.data || 'No additional details')}. ` +
          `This error occurred during document classification.`
        );
      }
    );

    logger.info('Dynamic Intelligent Classifier initialized with model discovery');
  }

  /**
   * Classify document content using dynamically selected best model
   */
  async classifyDocument(content: string, mimeType?: string): Promise<ClassificationResult> {
    try {
      const startTime = Date.now();

      // Dynamically select the best classification model
      const selectedModel = await this.selectBestClassificationModel(content, mimeType);

      // Build classification prompt
      const prompt = this.buildClassificationPrompt(content, mimeType);

      const request = {
        model: selectedModel.id,
        messages: [
          {
            role: 'system',
            content: `You are an expert document classifier. Analyze the provided content and return a JSON classification result.

            Categories:
            - text: General text, articles, documentation
            - code: Programming code, scripts, configuration files
            - finance: Financial documents, reports, trading data
            - law: Legal documents, contracts, regulations
            - image: Image descriptions or image-based content
            - multimodal: Mixed content with multiple types
            - general: Unspecified or mixed content

            Return JSON in this exact format:
            {
              "primaryType": "category",
              "confidence": 0.0-1.0,
              "language": "detected language or null",
              "programmingLanguage": "if code, the language, else null",
              "topics": ["array", "of", "main", "topics"],
              "metadata": {
                "additionalInfo": "any relevant details"
              }
            }`
          },
          {
            role: 'user',
            content: prompt
          }
        ],
        temperature: 0.1,
        max_tokens: 500,
        response_format: { type: 'json_object' }
      };

      logger.debug('Classifying document with dynamic model', {
        model: selectedModel.id,
        modelReason: selectedModel.reason,
        contentLength: content.length,
        mimeType
      });

      const response = await this.httpClient.post('/chat/completions', request);

      const latency = Date.now() - startTime;

      // Parse the classification result
      const messageContent = response.data?.choices?.[0]?.message?.content;
      let classification: ClassificationResult;

      try {
        classification = JSON.parse(messageContent);
      } catch (parseError) {
        logger.warn('Failed to parse classification result, using defaults', {
          error: parseError,
          content: messageContent
        });

        classification = {
          primaryType: 'general',
          confidence: 0.5,
          topics: []
        };
      }

      // Dynamically suggest embedding model based on classification
      classification.suggestedEmbeddingModel = await this.suggestEmbeddingModelDynamic(classification.primaryType);

      logger.info('Document classified with dynamic model selection', {
        ...classification,
        model: selectedModel.id,
        latency
      });

      return classification;
    } catch (error) {
      logger.error('Failed to classify document, attempting fallback', { error });

      // Fallback: try with fallback model chain
      try {
        return await this.classifyDocumentWithFallback(content, mimeType);
      } catch (fallbackError) {
        logger.error('All classification attempts failed', { error: fallbackError });

        // Last resort: return default classification
        return {
          primaryType: 'general',
          confidence: 0.0,
          topics: [],
          suggestedEmbeddingModel: 'voyage-3'
        };
      }
    }
  }

  /**
   * Classify image content using dynamically selected vision models
   */
  async classifyImage(imageBase64: string, mimeType: string): Promise<ClassificationResult> {
    try {
      const startTime = Date.now();

      // Dynamically select best vision model
      const selectedModel = await this.openRouterSelector.selectBestModel({
        task: 'vision',
        requiresVision: true,
        minContextLength: 4096
      });

      const request = {
        model: selectedModel.id,
        messages: [
          {
            role: 'system',
            content: `You are an expert image analyzer. Analyze the provided image and return a JSON classification result.

            Determine if the image contains:
            - Code (screenshots of code, IDEs, terminals)
            - Financial data (charts, graphs, spreadsheets)
            - Legal documents (contracts, forms)
            - General images (photos, diagrams, illustrations)

            Return JSON in this format:
            {
              "primaryType": "code|finance|law|image|general",
              "confidence": 0.0-1.0,
              "topics": ["array", "of", "identified", "elements"],
              "metadata": {
                "description": "brief description of the image"
              }
            }`
          },
          {
            role: 'user',
            content: [
              {
                type: 'image_url',
                image_url: {
                  url: `data:${mimeType};base64,${imageBase64}`
                }
              },
              {
                type: 'text',
                text: 'Classify this image according to the instructions.'
              }
            ]
          }
        ],
        temperature: 0.1,
        max_tokens: 500,
        response_format: { type: 'json_object' }
      };

      logger.debug('Classifying image with dynamic vision model', {
        model: selectedModel.id,
        modelReason: selectedModel.reason,
        mimeType
      });

      const response = await this.httpClient.post('/chat/completions', request);

      const latency = Date.now() - startTime;
      const messageContent = response.data?.choices?.[0]?.message?.content;

      let classification: ClassificationResult;
      try {
        classification = JSON.parse(messageContent);
      } catch (parseError) {
        logger.warn('Failed to parse image classification, using defaults', {
          error: parseError
        });

        classification = {
          primaryType: 'image',
          confidence: 0.5,
          topics: []
        };
      }

      classification.suggestedEmbeddingModel = await this.suggestEmbeddingModelDynamic(classification.primaryType);

      logger.info('Image classified with dynamic vision model', {
        ...classification,
        model: selectedModel.id,
        latency
      });

      return classification;
    } catch (error) {
      logger.error('Failed to classify image', { error });

      return {
        primaryType: 'image',
        confidence: 0.0,
        topics: [],
        suggestedEmbeddingModel: 'voyage-3'
      };
    }
  }

  /**
   * Batch classify multiple documents
   */
  async classifyBatch(documents: Array<{ content: string; mimeType?: string }>): Promise<ClassificationResult[]> {
    const results: ClassificationResult[] = [];

    // Process in parallel with rate limiting
    const batchSize = 5; // Process 5 at a time
    for (let i = 0; i < documents.length; i += batchSize) {
      const batch = documents.slice(i, i + batchSize);
      const batchPromises = batch.map(doc =>
        doc.mimeType?.startsWith('image/')
          ? this.classifyImage(doc.content, doc.mimeType)
          : this.classifyDocument(doc.content, doc.mimeType)
      );

      const batchResults = await Promise.all(batchPromises);
      results.push(...batchResults);
    }

    return results;
  }

  /**
   * Build classification prompt based on content
   */
  private buildClassificationPrompt(content: string, mimeType?: string): string {
    const maxLength = 4000;
    const truncatedContent = content.length > maxLength
      ? content.substring(0, maxLength) + '...[truncated]'
      : content;

    let prompt = `Analyze and classify the following document:\n\n`;

    if (mimeType) {
      prompt += `MIME Type: ${mimeType}\n\n`;
    }

    prompt += `Content:\n${truncatedContent}`;

    return prompt;
  }

  /**
   * Dynamically select best classification model using OpenRouter
   */
  private async selectBestClassificationModel(content: string, mimeType?: string): Promise<{ id: string; reason: string }> {
    // Determine task type based on content hints
    let task: 'classification' | 'vision' | 'code' | 'fast' = 'classification';

    if (mimeType?.startsWith('image/')) {
      task = 'vision';
    } else if (content.length < 1000) {
      task = 'fast';
    } else {
      // Quick heuristic for code content
      const codeIndicators = ['function', 'const', 'import', 'class', 'def ', '```'];
      const hasCode = codeIndicators.some(ind => content.includes(ind));
      if (hasCode) {
        task = 'code';
      }
    }

    return this.openRouterSelector.selectBestModel({
      task,
      requiresVision: task === 'vision',
      minContextLength: content.length > 8000 ? 32000 : 4096
    });
  }

  /**
   * Fallback classification with model chain
   */
  private async classifyDocumentWithFallback(content: string, mimeType?: string): Promise<ClassificationResult> {
    const modelChain = await this.openRouterSelector.selectModelChain({
      task: 'classification',
      minContextLength: 4096
    }, 3);

    for (const model of modelChain) {
      try {
        logger.debug(`Attempting classification with fallback model: ${model.id}`);

        const prompt = this.buildClassificationPrompt(content, mimeType);
        const response = await this.httpClient.post('/chat/completions', {
          model: model.id,
          messages: [
            {
              role: 'system',
              content: `You are an expert document classifier. Return JSON classification.`
            },
            {
              role: 'user',
              content: prompt
            }
          ],
          temperature: 0.1,
          max_tokens: 500,
          response_format: { type: 'json_object' }
        });

        const classification = JSON.parse(response.data?.choices?.[0]?.message?.content);
        classification.suggestedEmbeddingModel = await this.suggestEmbeddingModelDynamic(classification.primaryType);

        logger.info(`Classification succeeded with fallback model: ${model.id}`);
        return classification;
      } catch (error) {
        logger.warn(`Fallback model ${model.id} failed, trying next`, { error });
        continue;
      }
    }

    throw new Error('All fallback classification models failed');
  }

  /**
   * Dynamically suggest embedding model using Voyage model discovery
   */
  private async suggestEmbeddingModelDynamic(primaryType: string): Promise<string> {
    try {
      const specializationMap: Record<string, 'general' | 'code' | 'finance' | 'law' | 'multimodal'> = {
        'text': 'general',
        'code': 'code',
        'finance': 'finance',
        'law': 'law',
        'image': 'general',
        'multimodal': 'multimodal',
        'general': 'general'
      };

      const specialization = specializationMap[primaryType] || 'general';
      const model = await this.voyageDiscovery.getModelBySpecialization(specialization);

      if (model) {
        logger.debug(`Dynamic embedding model suggestion: ${model.id} for ${primaryType}`);
        return model.id;
      }

      // Fallback to general model
      const generalModel = await this.voyageDiscovery.getModelBySpecialization('general');
      return generalModel?.id || 'voyage-3';
    } catch (error) {
      logger.error('Failed to dynamically suggest embedding model, using fallback', { error });
      return 'voyage-3';
    }
  }

  /**
   * Get classifier status including model cache information
   */
  async getStatus(): Promise<{
    openRouterCache: any;
    voyageCache: any;
    modelsAvailable: { openRouter: number; voyage: number };
  }> {
    const openRouterCache = this.openRouterSelector.getCacheStatus();
    const voyageCache = this.voyageDiscovery.getCacheStatus();
    const voyageModels = await this.voyageDiscovery.getAllModels();

    return {
      openRouterCache,
      voyageCache,
      modelsAvailable: {
        openRouter: openRouterCache.modelCount || 0,
        voyage: voyageModels.length
      }
    };
  }

  /**
   * Refresh model discovery caches
   */
  async refreshModels(): Promise<void> {
    logger.info('Refreshing all model discovery caches');
    await Promise.all([
      this.openRouterSelector.fetchModels(true),
      this.voyageDiscovery.refresh()
    ]);
    logger.info('Model discovery caches refreshed');
  }
}