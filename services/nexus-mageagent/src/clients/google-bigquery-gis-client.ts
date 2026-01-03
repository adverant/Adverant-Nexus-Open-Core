import { BigQuery, Query } from '@google-cloud/bigquery';
import { GoogleAuth } from 'google-auth-library';
import { logger } from '../utils/logger';
import { config } from '../config';
import { createCircuitBreaker, ServiceCircuitBreaker } from '../utils/circuit-breaker';

/**
 * Request interface for BigQuery spatial queries
 */
export interface BigQuerySpatialQueryRequest {
  query: string;
  location?: string; // BigQuery location (US, EU, etc.)
  parameters?: Array<{
    name: string;
    value: any;
    type: 'STRING' | 'INT64' | 'FLOAT64' | 'BOOL' | 'GEOGRAPHY';
  }>;
  maxResults?: number;
}

/**
 * Request interface for spatial joins
 */
export interface BigQuerySpatialJoinRequest {
  leftTable: string;
  rightTable: string;
  joinType: 'INNER' | 'LEFT' | 'RIGHT' | 'FULL';
  spatialPredicate: 'INTERSECTS' | 'CONTAINS' | 'WITHIN' | 'DISTANCE';
  distance?: number; // meters, required for DISTANCE predicate
  leftGeomColumn?: string;
  rightGeomColumn?: string;
}

/**
 * Google BigQuery GIS Client
 *
 * Provides access to Google BigQuery for large-scale spatial analytics:
 * - Execute spatial SQL queries with ST_* functions
 * - Perform spatial joins at petabyte scale
 * - Import/export GeoJSON data
 * - Manage datasets and tables
 *
 * Features:
 * - Parameterized queries for safety
 * - Support for all BigQuery Geography functions
 * - Automatic dataset management
 * - Circuit breaker for reliability
 * - Result pagination
 */
export class GoogleBigQueryGISClient {
  private client: BigQuery;
  private circuitBreaker: ServiceCircuitBreaker;
  private projectId: string;
  private datasetId: string;
  private initialized: boolean = false;

  constructor() {
    this.projectId = config.googleCloud?.projectId || '';
    this.datasetId = config.googleCloud?.bigQuery?.datasetId || 'geoagent_spatial';

    if (!this.projectId) {
      logger.warn('Google Cloud Project ID not configured. BigQuery GIS client will fail on requests.');
    }

    const auth = new GoogleAuth({
      keyFile: config.googleCloud?.keyFile,
      scopes: ['https://www.googleapis.com/auth/bigquery', 'https://www.googleapis.com/auth/cloud-platform']
    });

    this.client = new BigQuery({
      projectId: this.projectId,
      authClient: auth as any
    });

    // Initialize circuit breaker
    this.circuitBreaker = createCircuitBreaker('GoogleBigQueryGIS', async (fn: Function) => {
      return await fn();
    }, {
      timeout: 60000, // 60 seconds for queries
      errorThresholdPercentage: 30,
      resetTimeout: 120000,
      volumeThreshold: 5
    });

    logger.info(`GoogleBigQueryGISClient initialized for project: ${this.projectId}, dataset: ${this.datasetId}`);
  }

  /**
   * Initialize BigQuery connection
   * Must be called before using the client
   */
  async initialize(): Promise<void> {
    if (this.initialized) {
      return;
    }

    try {
      // Verify connectivity and ensure dataset exists
      await this.ensureDataset();
      await this.checkHealth();
      this.initialized = true;
      logger.info('Google BigQuery GIS client initialized successfully');
    } catch (error) {
      logger.error('Failed to initialize Google BigQuery GIS client:', error);
      throw new Error(`BigQuery GIS initialization failed: ${(error as Error).message}`);
    }
  }

  /**
   * Check if BigQuery service is healthy and accessible
   */
  async checkHealth(): Promise<boolean> {
    try {
      // Simple query to verify connectivity
      const [datasets] = await this.client.getDatasets();
      return datasets.length >= 0;
    } catch (error) {
      logger.error('BigQuery GIS health check failed:', error);
      return false;
    }
  }

  /**
   * Execute spatial query
   *
   * Run SQL queries with BigQuery Geography functions:
   * - ST_GEOGPOINT, ST_GEOGFROMTEXT, ST_GEOGFROMGEOJSON
   * - ST_INTERSECTS, ST_CONTAINS, ST_WITHIN, ST_DISTANCE
   * - ST_BUFFER, ST_CENTROID, ST_AREA, ST_LENGTH
   * - ST_UNION, ST_INTERSECTION, ST_DIFFERENCE
   *
   * @param request - Query request with SQL and parameters
   * @returns Query results
   */
  async executeSpatialQuery(request: BigQuerySpatialQueryRequest): Promise<any[]> {
    return this.circuitBreaker.fire(async () => {
      logger.info(`Executing BigQuery spatial query (max ${request.maxResults || 1000} results)`);
      logger.debug(`Query: ${request.query.substring(0, 200)}...`);

      const queryOptions: Query = {
        query: request.query,
        location: request.location || 'US',
        maxResults: request.maxResults || 1000
      };

      // Add parameterized query support
      if (request.parameters && request.parameters.length > 0) {
        queryOptions.params = request.parameters.reduce((acc, param) => {
          acc[param.name] = param.value;
          return acc;
        }, {} as Record<string, any>);
      }

      try {
        const [rows] = await this.client.query(queryOptions);
        logger.info(`Query returned ${rows.length} row(s)`);
        return rows;
      } catch (error) {
        logger.error('BigQuery spatial query failed:', error);
        throw new Error(`BigQuery query error: ${(error as Error).message}`);
      }
    });
  }

  /**
   * Perform spatial join between two tables
   *
   * Join tables based on spatial relationships:
   * - INTERSECTS: Geometries intersect
   * - CONTAINS: Left geometry contains right
   * - WITHIN: Left geometry within right
   * - DISTANCE: Within specified distance (meters)
   *
   * @param request - Spatial join parameters
   * @returns Joined results
   */
  async spatialJoin(request: BigQuerySpatialJoinRequest): Promise<any[]> {
    const leftGeom = request.leftGeomColumn || 'geom';
    const rightGeom = request.rightGeomColumn || 'geom';

    // Build spatial condition based on predicate
    let spatialCondition: string;
    switch (request.spatialPredicate) {
      case 'INTERSECTS':
        spatialCondition = `ST_INTERSECTS(left.${leftGeom}, right.${rightGeom})`;
        break;
      case 'CONTAINS':
        spatialCondition = `ST_CONTAINS(left.${leftGeom}, right.${rightGeom})`;
        break;
      case 'WITHIN':
        spatialCondition = `ST_WITHIN(left.${leftGeom}, right.${rightGeom})`;
        break;
      case 'DISTANCE':
        if (!request.distance) {
          throw new Error('Distance parameter required for DISTANCE predicate');
        }
        spatialCondition = `ST_DISTANCE(left.${leftGeom}, right.${rightGeom}) <= ${request.distance}`;
        break;
      default:
        throw new Error(`Unsupported spatial predicate: ${request.spatialPredicate}`);
    }

    const query = `
      SELECT left.*, right.*
      FROM \`${this.projectId}.${this.datasetId}.${request.leftTable}\` AS left
      ${request.joinType} JOIN \`${this.projectId}.${this.datasetId}.${request.rightTable}\` AS right
      ON ${spatialCondition}
    `;

    logger.info(
      `Performing spatial join: ${request.leftTable} ${request.joinType} JOIN ${request.rightTable} ON ${request.spatialPredicate}`
    );

    return this.executeSpatialQuery({ query });
  }

  /**
   * Import GeoJSON data to BigQuery
   *
   * @param tableName - Target table name
   * @param geoJsonData - GeoJSON FeatureCollection
   * @param geomColumn - Name of geometry column (default: 'geom')
   */
  async importGeoJSON(
    tableName: string,
    geoJsonData: GeoJSON.FeatureCollection,
    geomColumn: string = 'geom'
  ): Promise<void> {
    return this.circuitBreaker.fire(async () => {
      const dataset = this.client.dataset(this.datasetId);
      const table = dataset.table(tableName);

      logger.info(`Importing ${geoJsonData.features.length} features to ${this.datasetId}.${tableName}`);

      // Transform GeoJSON features to BigQuery rows
      const rows = geoJsonData.features.map(feature => {
        const row: any = {
          [geomColumn]: JSON.stringify(feature.geometry),
          properties: feature.properties || {}
        };

        // Flatten properties into top-level columns
        if (feature.properties) {
          Object.entries(feature.properties).forEach(([key, value]) => {
            row[key] = value;
          });
        }

        return row;
      });

      try {
        // Insert rows (BigQuery will auto-create table if needed)
        await table.insert(rows);
        logger.info(`Successfully imported ${rows.length} features to ${tableName}`);
      } catch (error) {
        logger.error(`Failed to import GeoJSON to ${tableName}:`, error);
        throw new Error(`GeoJSON import error: ${(error as Error).message}`);
      }
    });
  }

  /**
   * Export data to GeoJSON
   *
   * @param tableName - Source table name
   * @param geomColumn - Name of geometry column (default: 'geom')
   * @param filters - Optional WHERE clause filters
   * @returns GeoJSON FeatureCollection
   */
  async exportToGeoJSON(
    tableName: string,
    geomColumn: string = 'geom',
    filters?: string
  ): Promise<GeoJSON.FeatureCollection> {
    const whereClause = filters ? `WHERE ${filters}` : '';

    const query = `
      SELECT
        ST_ASGEOJSON(${geomColumn}) as geometry,
        TO_JSON_STRING(STRUCT(* EXCEPT(${geomColumn}))) as properties
      FROM \`${this.projectId}.${this.datasetId}.${tableName}\`
      ${whereClause}
    `;

    logger.info(`Exporting ${tableName} to GeoJSON ${filters ? `with filters: ${filters}` : ''}`);

    const rows = await this.executeSpatialQuery({ query });

    const features: GeoJSON.Feature[] = rows.map((row: any) => ({
      type: 'Feature',
      geometry: JSON.parse(row.geometry),
      properties: JSON.parse(row.properties)
    }));

    logger.info(`Exported ${features.length} features from ${tableName}`);

    return {
      type: 'FeatureCollection',
      features
    };
  }

  /**
   * Create dataset if it doesn't exist
   */
  async ensureDataset(): Promise<void> {
    try {
      const [datasets] = await this.client.getDatasets();
      const exists = datasets.some(ds => ds.id === this.datasetId);

      if (!exists) {
        logger.info(`Creating BigQuery dataset: ${this.datasetId}`);
        await this.client.createDataset(this.datasetId, {
          location: 'US'
        });
        logger.info(`Dataset ${this.datasetId} created successfully`);
      } else {
        logger.debug(`Dataset ${this.datasetId} already exists`);
      }
    } catch (error) {
      logger.error(`Failed to ensure dataset ${this.datasetId}:`, error);
      throw new Error(`Dataset creation error: ${(error as Error).message}`);
    }
  }

  /**
   * Create a spatial table with proper schema
   *
   * @param tableName - Table name to create
   * @param schema - Table schema definition
   */
  async createSpatialTable(
    tableName: string,
    schema: Array<{ name: string; type: string; mode?: string }>
  ): Promise<void> {
    return this.circuitBreaker.fire(async () => {
      const dataset = this.client.dataset(this.datasetId);

      logger.info(`Creating spatial table: ${this.datasetId}.${tableName}`);

      try {
        await dataset.createTable(tableName, {
          schema
        });

        logger.info(`Table ${tableName} created successfully`);
      } catch (error) {
        if ((error as any).code === 409) {
          logger.warn(`Table ${tableName} already exists`);
        } else {
          logger.error(`Failed to create table ${tableName}:`, error);
          throw error;
        }
      }
    });
  }

  /**
   * Drop a table
   *
   * @param tableName - Table name to drop
   */
  async dropTable(tableName: string): Promise<void> {
    return this.circuitBreaker.fire(async () => {
      const dataset = this.client.dataset(this.datasetId);
      const table = dataset.table(tableName);

      logger.info(`Dropping table: ${this.datasetId}.${tableName}`);

      try {
        await table.delete();
        logger.info(`Table ${tableName} dropped successfully`);
      } catch (error) {
        logger.error(`Failed to drop table ${tableName}:`, error);
        throw new Error(`Drop table error: ${(error as Error).message}`);
      }
    });
  }

  /**
   * List tables in the dataset
   *
   * @returns List of table names
   */
  async listTables(): Promise<string[]> {
    return this.circuitBreaker.fire(async () => {
      const dataset = this.client.dataset(this.datasetId);

      try {
        const [tables] = await dataset.getTables();
        return tables.map(table => table.id || '');
      } catch (error) {
        logger.error('Failed to list tables:', error);
        throw new Error(`List tables error: ${(error as Error).message}`);
      }
    });
  }

  /**
   * Get table metadata
   *
   * @param tableName - Table name
   * @returns Table metadata including schema and row count
   */
  async getTableMetadata(tableName: string): Promise<any> {
    return this.circuitBreaker.fire(async () => {
      const dataset = this.client.dataset(this.datasetId);
      const table = dataset.table(tableName);

      try {
        const [metadata] = await table.getMetadata();
        return {
          id: metadata.id,
          type: metadata.type,
          schema: metadata.schema,
          numRows: metadata.numRows,
          numBytes: metadata.numBytes,
          creationTime: metadata.creationTime,
          lastModifiedTime: metadata.lastModifiedTime,
          location: metadata.location
        };
      } catch (error) {
        logger.error(`Failed to get metadata for table ${tableName}:`, error);
        throw new Error(`Get metadata error: ${(error as Error).message}`);
      }
    });
  }

  /**
   * Clean up resources
   * Call this when shutting down the client
   */
  async cleanup(): Promise<void> {
    logger.info('Cleaning up Google BigQuery GIS client resources');
    // BigQuery client doesn't need explicit cleanup
    this.initialized = false;
  }
}
