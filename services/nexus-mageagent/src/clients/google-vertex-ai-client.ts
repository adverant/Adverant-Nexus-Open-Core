import { PredictionServiceClient, EndpointServiceClient } from '@google-cloud/aiplatform';
import { GoogleAuth } from 'google-auth-library';
import { logger } from '../utils/logger';
import { config } from '../config';
import { createCircuitBreaker, ServiceCircuitBreaker } from '../utils/circuit-breaker';

/**
 * Request interface for Vertex AI geospatial predictions
 */
export interface VertexAIGeospatialRequest {
  model: string;
  instances: Array<{
    image?: string; // base64 or GCS URL (gs://bucket/path/to/image.tif)
    location?: { lat: number; lng: number };
    features?: Array<'LAND_COVER' | 'BUILDING_DETECTION' | 'ROAD_EXTRACTION' | 'CHANGE_DETECTION'>;
  }>;
  parameters?: Record<string, any>;
}

/**
 * Response interface for Vertex AI predictions
 */
export interface VertexAIPredictionResult {
  predictions: Array<{
    displayName: string;
    confidence: number;
    bbox?: number[]; // [x_min, y_min, x_max, y_max]
    geometry?: GeoJSON.Geometry;
    properties?: Record<string, any>;
  }>;
  metadata: {
    modelName: string;
    processingTime: number;
    resourcesUsed: {
      predictionUnits: number;
    };
  };
}

/**
 * Model information interface
 */
export interface VertexAIModel {
  name: string;
  displayName: string;
  description?: string;
  createTime?: string;
  updateTime?: string;
}

/**
 * Google Vertex AI Client - FUTURE CUSTOM MODEL DEPLOYMENT
 *
 * ⚠️  IMPORTANT: This client is RESERVED for future custom geospatial model deployment.
 * It is NOT used as a fallback for GeospatialPredictionService.
 *
 * Current Status: Connectivity verified, awaiting model deployment
 * Purpose: Deploy custom-trained geospatial models once sufficient data is collected
 *
 * Future Capabilities (Post-Model Deployment):
 * - Building detection from satellite/aerial imagery
 * - Land cover classification (custom-trained on project data)
 * - Road network extraction
 * - Change detection between time periods
 * - Domain-specific geospatial models (trained on collected predictions)
 *
 * Current Geospatial Predictions: Use GeospatialPredictionService (OpenRouter/LLMs)
 *
 * Features:
 * - Single and batch predictions
 * - Model management (list, get details)
 * - Circuit breaker for reliability
 * - Extended timeout for AI inference (120 seconds)
 * - Automatic retries
 *
 * Integration Strategy:
 * 1. Phase 1 (Current): OpenRouter LLMs handle all predictions
 * 2. Phase 2 (Data Collection): Gather prediction data and ground truth
 * 3. Phase 3 (Model Training): Train custom Vertex AI models on collected data
 * 4. Phase 4 (Deployment): Deploy models and integrate into prediction service
 * 5. Phase 5 (Hybrid): Use both LLMs (reasoning) and custom models (accuracy)
 */
export class GoogleVertexAIClient {
  private predictionClient: typeof PredictionServiceClient.prototype;
  private endpointClient: typeof EndpointServiceClient.prototype;
  private circuitBreaker: ServiceCircuitBreaker;
  private projectId: string;
  private region: string;
  private initialized: boolean = false;

  constructor() {
    this.projectId = config.googleCloud?.projectId || '';
    this.region = config.googleCloud?.vertexAI?.region || 'us-central1';

    if (!this.projectId) {
      logger.warn('Google Cloud Project ID not configured. Vertex AI client will fail on requests.');
    }

    const auth = new GoogleAuth({
      keyFile: config.googleCloud?.keyFile,
      scopes: ['https://www.googleapis.com/auth/cloud-platform']
    });

    // Initialize Prediction Service Client
    this.predictionClient = new PredictionServiceClient({
      apiEndpoint: `${this.region}-aiplatform.googleapis.com`,
      authClient: auth as any
    });

    // Initialize Endpoint Service Client (for model management)
    this.endpointClient = new EndpointServiceClient({
      apiEndpoint: `${this.region}-aiplatform.googleapis.com`,
      authClient: auth as any
    });

    // Initialize circuit breaker with longer timeout for AI inference
    this.circuitBreaker = createCircuitBreaker('GoogleVertexAI', async (fn: Function) => {
      return await fn();
    }, {
      timeout: 120000, // 2 minutes for AI inference
      errorThresholdPercentage: 30,
      resetTimeout: 120000,
      volumeThreshold: 5
    });

    logger.info(`GoogleVertexAIClient initialized for project: ${this.projectId}, region: ${this.region}`);
  }

  /**
   * Initialize Vertex AI connection
   * Must be called before using the client
   */
  async initialize(): Promise<void> {
    if (this.initialized) {
      return;
    }

    try {
      // Verify connectivity by checking if we can access the region
      await this.checkHealth();
      this.initialized = true;
      logger.info('Google Vertex AI client initialized successfully');
    } catch (error) {
      logger.error('Failed to initialize Google Vertex AI client:', error);
      throw new Error(`Vertex AI initialization failed: ${(error as Error).message}`);
    }
  }

  /**
   * Check if Vertex AI service is healthy and accessible
   */
  async checkHealth(): Promise<boolean> {
    try {
      // Make a simple request to verify connectivity
      const parent = `projects/${this.projectId}/locations/${this.region}`;
      await this.endpointClient.listEndpoints({ parent, pageSize: 1 } as any);
      return true;
    } catch (error) {
      logger.error('Vertex AI health check failed:', error);
      return false;
    }
  }

  /**
   * Run geospatial prediction
   *
   * Execute AI predictions on geospatial data such as:
   * - Detecting buildings in satellite imagery
   * - Classifying land cover types
   * - Extracting road networks
   * - Identifying changes between images
   *
   * @param request - Prediction request with model and instances
   * @returns Prediction results with confidence scores and geometries
   */
  async predict(request: VertexAIGeospatialRequest): Promise<VertexAIPredictionResult> {
    return this.circuitBreaker.fire(async () => {
      const startTime = Date.now();

      // Construct endpoint path
      const endpoint = this.predictionClient.projectLocationEndpointPath(
        this.projectId,
        this.region,
        request.model
      );

      logger.info(`Running Vertex AI prediction with model: ${request.model} for ${request.instances.length} instance(s)`);

      // Convert instances to the format expected by Vertex AI
      const formattedInstances = request.instances.map(instance => {
        const fields: any = {};

        if (instance.image) {
          fields.image = { stringValue: instance.image };
        }

        if (instance.location) {
          fields.location = {
            structValue: {
              fields: {
                lat: { numberValue: instance.location.lat },
                lng: { numberValue: instance.location.lng }
              }
            }
          };
        }

        if (instance.features) {
          fields.features = {
            listValue: {
              values: instance.features.map(f => ({ stringValue: f }))
            }
          };
        }

        return {
          structValue: { fields }
        };
      });

      // Format parameters if provided
      let formattedParameters;
      if (request.parameters) {
        formattedParameters = {
          structValue: {
            fields: Object.entries(request.parameters).reduce((acc, [key, value]) => {
              if (typeof value === 'number') {
                acc[key] = { numberValue: value };
              } else if (typeof value === 'string') {
                acc[key] = { stringValue: value };
              } else if (typeof value === 'boolean') {
                acc[key] = { boolValue: value };
              }
              return acc;
            }, {} as any)
          }
        };
      }

      try {
        const [response] = await this.predictionClient.predict({
          endpoint,
          instances: formattedInstances,
          parameters: formattedParameters
        });

        const processingTime = Date.now() - startTime;

        // Parse predictions from response
        const predictions = (response.predictions || []).map((prediction: any) => {
          const pred = prediction.structValue?.fields || prediction;

          return {
            displayName: pred.displayName?.stringValue || pred.displayName || 'unknown',
            confidence: pred.confidence?.numberValue || pred.confidence || 0,
            bbox: pred.bbox?.listValue?.values?.map((v: any) => v.numberValue) || pred.bbox,
            geometry: pred.geometry?.structValue || pred.geometry,
            properties: pred.properties?.structValue?.fields || pred.properties || {}
          };
        });

        logger.info(`Vertex AI prediction completed in ${processingTime}ms with ${predictions.length} prediction(s)`);

        return {
          predictions,
          metadata: {
            modelName: request.model,
            processingTime,
            resourcesUsed: {
              predictionUnits: response.metadata?.predictionUnits || 0
            }
          }
        };
      } catch (error) {
        logger.error(`Vertex AI prediction failed for model ${request.model}:`, error);
        throw new Error(`Vertex AI prediction error: ${(error as Error).message}`);
      }
    });
  }

  /**
   * Batch predict for large-scale processing
   *
   * Process large datasets asynchronously by submitting a batch job.
   * Results are written to Cloud Storage.
   *
   * @param modelName - Model endpoint name
   * @param inputUri - GCS URI with input data (e.g., gs://bucket/input.jsonl)
   * @param outputUri - GCS URI prefix for output (e.g., gs://bucket/output/)
   * @returns Job name for monitoring
   */
  async batchPredict(
    modelName: string,
    inputUri: string,
    outputUri: string
  ): Promise<string> {
    return this.circuitBreaker.fire(async () => {
      const parent = `projects/${this.projectId}/locations/${this.region}`;
      const endpoint = this.predictionClient.projectLocationEndpointPath(
        this.projectId,
        this.region,
        modelName
      );

      logger.info(`Submitting batch prediction job: ${modelName}`);
      logger.info(`  Input: ${inputUri}`);
      logger.info(`  Output: ${outputUri}`);

      try {
        const [operation] = await this.predictionClient.batchPredictionJob({
          parent,
          batchPredictionJob: {
            displayName: `batch-prediction-${Date.now()}`,
            model: endpoint,
            inputConfig: {
              instancesFormat: 'jsonl',
              gcsSource: { uris: [inputUri] }
            },
            outputConfig: {
              predictionsFormat: 'jsonl',
              gcsDestination: { outputUriPrefix: outputUri }
            }
          }
        } as any);

        const jobName = operation.name || '';
        logger.info(`Batch prediction job submitted: ${jobName}`);

        return jobName;
      } catch (error) {
        logger.error('Failed to submit batch prediction job:', error);
        throw new Error(`Batch prediction error: ${(error as Error).message}`);
      }
    });
  }

  /**
   * List available models in the region
   *
   * @returns List of deployed models with their metadata
   */
  async listModels(): Promise<VertexAIModel[]> {
    return this.circuitBreaker.fire(async () => {
      const parent = `projects/${this.projectId}/locations/${this.region}`;

      try {
        const [endpoints] = await this.endpointClient.listEndpoints({ parent } as any);

        return (endpoints || []).map((endpoint: any) => ({
          name: endpoint.name || '',
          displayName: endpoint.displayName || '',
          description: endpoint.description,
          createTime: endpoint.createTime,
          updateTime: endpoint.updateTime
        }));
      } catch (error) {
        logger.error('Failed to list Vertex AI models:', error);
        throw new Error(`List models error: ${(error as Error).message}`);
      }
    });
  }

  /**
   * Get detailed information about a specific model
   *
   * @param modelName - Model endpoint name
   * @returns Model details
   */
  async getModel(modelName: string): Promise<VertexAIModel> {
    return this.circuitBreaker.fire(async () => {
      const name = this.predictionClient.projectLocationEndpointPath(
        this.projectId,
        this.region,
        modelName
      );

      try {
        const [endpoint] = await this.endpointClient.getEndpoint({ name } as any);

        return {
          name: endpoint.name || '',
          displayName: endpoint.displayName || '',
          description: endpoint.description,
          createTime: endpoint.createTime,
          updateTime: endpoint.updateTime
        };
      } catch (error) {
        logger.error(`Failed to get model details for ${modelName}:`, error);
        throw new Error(`Get model error: ${(error as Error).message}`);
      }
    });
  }

  /**
   * Clean up resources
   * Call this when shutting down the client
   */
  async cleanup(): Promise<void> {
    logger.info('Cleaning up Google Vertex AI client resources');
    await this.predictionClient.close();
    await this.endpointClient.close();
    this.initialized = false;
  }
}
