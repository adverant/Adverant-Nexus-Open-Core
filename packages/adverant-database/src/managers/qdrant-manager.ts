/**
 * Qdrant Manager
 * Handles Qdrant vector database connection and operations
 */

import { QdrantClient } from '@qdrant/js-client-rest';
import { createLogger } from '@adverant/logger';
import { createRetry } from '@adverant/resilience';
import type { QdrantConfig, HealthCheckResult } from '../types';

const logger = createLogger({ service: 'adverant-database' });

export class QdrantManager {
  private client: QdrantClient | null = null;
  private config: QdrantConfig;
  private retry = createRetry({
    maxRetries: 3,
    initialDelay: 1000,
    backoffStrategy: 'exponential',
  });

  constructor(config: QdrantConfig) {
    this.config = config;
  }

  /**
   * Initialize Qdrant client
   */
  async initialize(): Promise<void> {
    try {
      this.client = new QdrantClient({
        url: this.config.url,
        apiKey: this.config.apiKey,
        timeout: this.config.timeout || 60000, // Increased from 30s to 60s for slow responses
      });

      // Test connection
      await this.retry.execute(async () => {
        if (!this.client) throw new Error('Client not initialized');
        await this.client.getCollections();
      });

      logger.info('Qdrant connected successfully', {
        url: this.config.url,
      });

      // Initialize collections if specified
      if (this.config.collections && this.config.collections.length > 0) {
        await this.initializeCollections(this.config.collections);
      }
    } catch (error) {
      logger.error('Qdrant initialization failed', {
        error: error instanceof Error ? error.message : 'Unknown error',
        url: this.config.url,
      });
      throw error;
    }
  }

  /**
   * Initialize collections with vector dimensions
   */
  private async initializeCollections(
    collections: Array<{ name: string; vectorSize: number; distance?: string }>
  ): Promise<void> {
    if (!this.client) {
      throw new Error('Qdrant client not initialized');
    }

    for (const collection of collections) {
      try {
        const exists = await this.collectionExists(collection.name);

        if (!exists) {
          await this.client.createCollection(collection.name, {
            vectors: {
              size: collection.vectorSize,
              distance: (collection.distance || 'Cosine') as 'Cosine' | 'Euclid' | 'Dot' | 'Manhattan',
            } as any,
          });

          logger.info('Qdrant collection created', {
            name: collection.name,
            vectorSize: collection.vectorSize,
            distance: collection.distance || 'Cosine',
          });
        } else {
          logger.debug('Qdrant collection already exists', {
            name: collection.name,
          });
        }
      } catch (error) {
        logger.error('Failed to initialize Qdrant collection', {
          collection: collection.name,
          error: error instanceof Error ? error.message : 'Unknown error',
        });
        throw error;
      }
    }
  }

  /**
   * Check if a collection exists
   */
  async collectionExists(collectionName: string): Promise<boolean> {
    if (!this.client) {
      throw new Error('Qdrant client not initialized');
    }

    try {
      const collections = await this.client.getCollections();
      return collections.collections.some((c) => c.name === collectionName);
    } catch (error) {
      logger.error('Failed to check collection existence', {
        collection: collectionName,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
      return false;
    }
  }

  /**
   * Create a collection
   */
  async createCollection(
    name: string,
    vectorSize: number,
    distance: 'Cosine' | 'Euclid' | 'Dot' = 'Cosine'
  ): Promise<void> {
    if (!this.client) {
      throw new Error('Qdrant client not initialized');
    }

    try {
      await this.client.createCollection(name, {
        vectors: {
          size: vectorSize,
          distance,
        },
      });

      logger.info('Qdrant collection created', { name, vectorSize, distance });
    } catch (error) {
      logger.error('Failed to create Qdrant collection', {
        collection: name,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
      throw error;
    }
  }

  /**
   * Delete a collection
   */
  async deleteCollection(name: string): Promise<void> {
    if (!this.client) {
      throw new Error('Qdrant client not initialized');
    }

    try {
      await this.client.deleteCollection(name);
      logger.info('Qdrant collection deleted', { name });
    } catch (error) {
      logger.error('Failed to delete Qdrant collection', {
        collection: name,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
      throw error;
    }
  }

  /**
   * Upsert points (vectors) into a collection
   */
  async upsert(
    collectionName: string,
    points: Array<{
      id: string | number;
      vector: number[];
      payload?: Record<string, any>;
    }>
  ): Promise<void> {
    if (!this.client) {
      throw new Error('Qdrant client not initialized');
    }

    try {
      await this.client.upsert(collectionName, {
        wait: true,
        points,
      });

      logger.debug('Qdrant points upserted', {
        collection: collectionName,
        count: points.length,
      });
    } catch (error) {
      logger.error('Failed to upsert Qdrant points', {
        collection: collectionName,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
      throw error;
    }
  }

  /**
   * Search for similar vectors
   */
  async search(
    collectionName: string,
    vector: number[],
    limit: number = 10,
    filter?: Record<string, any>,
    scoreThreshold?: number
  ): Promise<Array<{
    id: string | number;
    score: number;
    payload?: Record<string, any>;
  }>> {
    if (!this.client) {
      throw new Error('Qdrant client not initialized');
    }

    try {
      const result = await this.client.search(collectionName, {
        vector,
        limit,
        filter,
        score_threshold: scoreThreshold,
        with_payload: true,
      });

      return result.map((hit) => ({
        id: hit.id,
        score: hit.score,
        payload: hit.payload || undefined,
      }));
    } catch (error) {
      logger.error('Qdrant search failed', {
        collection: collectionName,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
      throw error;
    }
  }

  /**
   * Retrieve points by IDs
   */
  async retrieve(
    collectionName: string,
    ids: Array<string | number>,
    withVector: boolean = false
  ): Promise<Array<{
    id: string | number;
    vector?: number[];
    payload?: Record<string, any>;
  }>> {
    if (!this.client) {
      throw new Error('Qdrant client not initialized');
    }

    try {
      const result = await this.client.retrieve(collectionName, {
        ids,
        with_vector: withVector,
        with_payload: true,
      });

      return result.map((point) => ({
        id: point.id,
        vector: point.vector as number[] | undefined,
        payload: point.payload || undefined,
      }));
    } catch (error) {
      logger.error('Failed to retrieve Qdrant points', {
        collection: collectionName,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
      throw error;
    }
  }

  /**
   * Delete points by IDs
   */
  async delete(collectionName: string, ids: Array<string | number>): Promise<void> {
    if (!this.client) {
      throw new Error('Qdrant client not initialized');
    }

    try {
      await this.client.delete(collectionName, {
        wait: true,
        points: ids,
      });

      logger.debug('Qdrant points deleted', {
        collection: collectionName,
        count: ids.length,
      });
    } catch (error) {
      logger.error('Failed to delete Qdrant points', {
        collection: collectionName,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
      throw error;
    }
  }

  /**
   * Delete points by filter
   */
  async deleteByFilter(collectionName: string, filter: Record<string, any>): Promise<void> {
    if (!this.client) {
      throw new Error('Qdrant client not initialized');
    }

    try {
      await this.client.delete(collectionName, {
        wait: true,
        filter,
      });

      logger.debug('Qdrant points deleted by filter', {
        collection: collectionName,
      });
    } catch (error) {
      logger.error('Failed to delete Qdrant points by filter', {
        collection: collectionName,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
      throw error;
    }
  }

  /**
   * Get collection info
   */
  async getCollectionInfo(collectionName: string): Promise<{
    vectorsCount: number;
    pointsCount: number;
    segments: number;
    status: string;
  }> {
    if (!this.client) {
      throw new Error('Qdrant client not initialized');
    }

    try {
      const info = await this.client.getCollection(collectionName);

      return {
        vectorsCount: info.indexed_vectors_count || info.points_count || 0,
        pointsCount: info.points_count || 0,
        segments: info.segments_count || 0,
        status: info.status,
      };
    } catch (error) {
      logger.error('Failed to get Qdrant collection info', {
        collection: collectionName,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
      throw error;
    }
  }

  /**
   * Scroll through points in a collection
   */
  async scroll(
    collectionName: string,
    limit: number = 100,
    offset?: string | number,
    filter?: Record<string, any>
  ): Promise<{
    points: Array<{
      id: string | number;
      vector?: number[];
      payload?: Record<string, any>;
    }>;
    nextOffset?: string | number;
  }> {
    if (!this.client) {
      throw new Error('Qdrant client not initialized');
    }

    try {
      const result = await this.client.scroll(collectionName, {
        limit,
        offset,
        filter,
        with_payload: true,
        with_vector: false,
      });

      return {
        points: result.points.map((point) => ({
          id: point.id,
          vector: point.vector as number[] | undefined,
          payload: point.payload || undefined,
        })),
        nextOffset: result.next_page_offset as string | number | undefined,
      };
    } catch (error) {
      logger.error('Failed to scroll Qdrant collection', {
        collection: collectionName,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
      throw error;
    }
  }

  /**
   * Health check
   */
  async healthCheck(): Promise<HealthCheckResult> {
    if (!this.client) {
      return {
        healthy: false,
        error: 'Client not initialized',
      };
    }

    const startTime = Date.now();

    try {
      const collections = await this.client.getCollections();
      const latency = Date.now() - startTime;

      return {
        healthy: true,
        latency,
        details: {
          collections: collections.collections.map((c) => c.name),
          collectionCount: collections.collections.length,
        },
      };
    } catch (error) {
      return {
        healthy: false,
        latency: Date.now() - startTime,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  /**
   * Get the underlying client (for advanced usage)
   */
  getClient(): QdrantClient | null {
    return this.client;
  }
}
