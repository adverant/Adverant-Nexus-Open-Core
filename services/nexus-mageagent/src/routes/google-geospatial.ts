/**
 * Google Geospatial AI Routes
 *
 * Provides REST API endpoints for Google Cloud geospatial services:
 * - Earth Engine: Satellite imagery analysis
 * - Vertex AI: Geospatial machine learning
 * - BigQuery GIS: Large-scale spatial analytics
 */

import { Router, Request, Response, NextFunction } from 'express';
import { GoogleEarthEngineClient } from '../clients/google-earth-engine-client';
import { GoogleVertexAIClient } from '../clients/google-vertex-ai-client';
import { GoogleBigQueryGISClient } from '../clients/google-bigquery-gis-client';
import { logger } from '../utils/logger';

const router = Router();

// Initialize clients (singleton pattern for efficiency)
let eeClient: GoogleEarthEngineClient | null = null;
let vertexClient: GoogleVertexAIClient | null = null;
let bigQueryClient: GoogleBigQueryGISClient | null = null;

/**
 * Get or initialize Earth Engine client
 */
const getEarthEngineClient = (): GoogleEarthEngineClient => {
  if (!eeClient) {
    eeClient = new GoogleEarthEngineClient();
    logger.info('Google Earth Engine client initialized');
  }
  return eeClient;
};

/**
 * Get or initialize Vertex AI client
 */
const getVertexAIClient = (): GoogleVertexAIClient => {
  if (!vertexClient) {
    vertexClient = new GoogleVertexAIClient();
    logger.info('Google Vertex AI client initialized');
  }
  return vertexClient;
};

/**
 * Get or initialize BigQuery GIS client
 */
const getBigQueryClient = (): GoogleBigQueryGISClient => {
  if (!bigQueryClient) {
    bigQueryClient = new GoogleBigQueryGISClient();
    logger.info('Google BigQuery GIS client initialized');
  }
  return bigQueryClient;
};

// ============================================================================
// EARTH ENGINE ROUTES
// ============================================================================

/**
 * POST /google/earth-engine
 * Execute Earth Engine operations
 */
router.post('/earth-engine', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { operation, ...params } = req.body;

    if (!operation) {
      return res.status(400).json({
        error: 'Missing required parameter: operation',
        validOperations: ['analyze', 'time_series', 'get_image', 'list_collections']
      });
    }

    const client = getEarthEngineClient();
    let result;

    switch (operation) {
      case 'analyze':
        logger.info('Executing Earth Engine regional analysis', {
          collection: params.imageCollection,
          bands: params.bands,
          reducer: params.reducer
        });
        result = await client.analyzeRegion(params);
        break;

      case 'time_series':
        logger.info('Extracting Earth Engine time series', {
          collection: params.imageCollection,
          interval: params.interval,
          dateRange: `${params.startDate} to ${params.endDate}`
        });
        result = await client.getTimeSeries(params);
        break;

      case 'get_image':
        logger.info('Fetching Earth Engine image', {
          assetId: params.assetId
        });
        result = await client.getImage(params);
        break;

      case 'list_collections':
        logger.info('Listing Earth Engine collections', {
          query: params.query || 'all'
        });
        result = await client.listCollections(params.query);
        break;

      default:
        return res.status(400).json({
          error: `Unknown Earth Engine operation: ${operation}`,
          validOperations: ['analyze', 'time_series', 'get_image', 'list_collections']
        });
    }

    return res.json(result);
  } catch (error) {
    logger.error('Earth Engine operation failed:', error);
    return next(error);
  }
});

// ============================================================================
// VERTEX AI ROUTES
// ============================================================================

/**
 * POST /google/vertex-ai
 * Execute Vertex AI operations
 */
router.post('/vertex-ai', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { operation, ...params } = req.body;

    if (!operation) {
      return res.status(400).json({
        error: 'Missing required parameter: operation',
        validOperations: ['predict', 'batch_predict', 'list_models', 'get_model']
      });
    }

    const client = getVertexAIClient();
    let result;

    switch (operation) {
      case 'predict':
        logger.info('Running Vertex AI prediction', {
          model: params.model,
          instanceCount: params.instances?.length || 0
        });
        result = await client.predict(params);
        break;

      case 'batch_predict':
        logger.info('Submitting Vertex AI batch prediction job', {
          model: params.modelName,
          inputUri: params.inputUri
        });
        result = await client.batchPredict(
          params.modelName,
          params.inputUri,
          params.outputUri
        );
        break;

      case 'list_models':
        logger.info('Listing Vertex AI models');
        result = await client.listModels();
        break;

      case 'get_model':
        logger.info('Getting Vertex AI model details', {
          model: params.modelName
        });
        result = await client.getModel(params.modelName);
        break;

      default:
        return res.status(400).json({
          error: `Unknown Vertex AI operation: ${operation}`,
          validOperations: ['predict', 'batch_predict', 'list_models', 'get_model']
        });
    }

    return res.json(result);
  } catch (error) {
    logger.error('Vertex AI operation failed:', error);
    return next(error);
  }
});

// ============================================================================
// BIGQUERY GIS ROUTES
// ============================================================================

/**
 * POST /google/bigquery
 * Execute BigQuery GIS operations
 */
router.post('/bigquery', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { operation, ...params } = req.body;

    if (!operation) {
      return res.status(400).json({
        error: 'Missing required parameter: operation',
        validOperations: ['spatial_query', 'spatial_join', 'import_geojson', 'export_geojson', 'list_tables', 'get_table_metadata']
      });
    }

    const client = getBigQueryClient();
    let result;

    switch (operation) {
      case 'spatial_query':
        logger.info('Executing BigQuery spatial query', {
          queryLength: params.query?.length || 0,
          location: params.location || 'US'
        });
        result = await client.executeSpatialQuery(params);
        break;

      case 'spatial_join':
        logger.info('Performing BigQuery spatial join', {
          leftTable: params.leftTable,
          rightTable: params.rightTable,
          predicate: params.spatialPredicate,
          joinType: params.joinType
        });
        result = await client.spatialJoin(params);
        break;

      case 'import_geojson':
        logger.info('Importing GeoJSON to BigQuery', {
          tableName: params.tableName,
          featureCount: params.geoJsonData?.features?.length || 0
        });
        await client.importGeoJSON(
          params.tableName,
          params.geoJsonData,
          params.geomColumn
        );
        result = {
          success: true,
          message: `Successfully imported ${params.geoJsonData?.features?.length || 0} features to ${params.tableName}`
        };
        break;

      case 'export_geojson':
        logger.info('Exporting BigQuery table to GeoJSON', {
          tableName: params.tableName,
          filters: params.filters || 'none'
        });
        result = await client.exportToGeoJSON(
          params.tableName,
          params.geomColumn,
          params.filters
        );
        break;

      case 'list_tables':
        logger.info('Listing BigQuery tables');
        result = await client.listTables();
        break;

      case 'get_table_metadata':
        logger.info('Getting BigQuery table metadata', {
          tableName: params.tableName
        });
        result = await client.getTableMetadata(params.tableName);
        break;

      default:
        return res.status(400).json({
          error: `Unknown BigQuery operation: ${operation}`,
          validOperations: ['spatial_query', 'spatial_join', 'import_geojson', 'export_geojson', 'list_tables', 'get_table_metadata']
        });
    }

    return res.json(result);
  } catch (error) {
    logger.error('BigQuery operation failed:', error);
    return next(error);
  }
});

// ============================================================================
// HEALTH CHECK
// ============================================================================

/**
 * GET /google/health
 * Check health of all Google Cloud services
 */
router.get('/health', async (_req: Request, res: Response) => {
  try {
    const healthChecks = await Promise.allSettled([
      getEarthEngineClient().checkHealth(),
      getVertexAIClient().checkHealth(),
      getBigQueryClient().checkHealth()
    ]);

    const eeHealth = healthChecks[0].status === 'fulfilled' && healthChecks[0].value;
    const vertexHealth = healthChecks[1].status === 'fulfilled' && healthChecks[1].value;
    const bigQueryHealth = healthChecks[2].status === 'fulfilled' && healthChecks[2].value;

    const healthy = eeHealth && vertexHealth && bigQueryHealth;

    res.status(healthy ? 200 : 503).json({
      healthy,
      services: {
        earthEngine: {
          healthy: eeHealth,
          endpoint: 'https://earthengine.googleapis.com/v1'
        },
        vertexAI: {
          healthy: vertexHealth,
          endpoint: 'us-central1-aiplatform.googleapis.com'
        },
        bigQuery: {
          healthy: bigQueryHealth,
          endpoint: 'https://bigquery.googleapis.com/bigquery/v2'
        }
      },
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    logger.error('Google services health check failed:', error);
    res.status(503).json({
      healthy: false,
      error: (error as Error).message,
      timestamp: new Date().toISOString()
    });
  }
});

// ============================================================================
// CLEANUP ON SERVER SHUTDOWN
// ============================================================================

/**
 * Cleanup Google clients on server shutdown
 */
export const cleanupGoogleClients = async (): Promise<void> => {
  logger.info('Cleaning up Google Cloud clients...');

  try {
    if (eeClient) {
      await eeClient.cleanup();
      eeClient = null;
    }

    if (vertexClient) {
      await vertexClient.cleanup();
      vertexClient = null;
    }

    if (bigQueryClient) {
      await bigQueryClient.cleanup();
      bigQueryClient = null;
    }

    logger.info('Google Cloud clients cleaned up successfully');
  } catch (error) {
    logger.error('Error cleaning up Google Cloud clients:', error);
  }
};

export default router;
