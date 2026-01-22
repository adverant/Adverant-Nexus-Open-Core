/**
 * Qdrant Collection Optimizer
 * Fixes indexing issues and optimizes collection settings for small-scale deployments
 */

import { QdrantClient } from '@qdrant/qdrant-js';
import { logger } from './logger';

export interface OptimizationConfig {
  forceIndexing?: boolean;
  indexingThreshold?: number;
  fullScanThreshold?: number;
  segmentNumber?: number;
  recreateIfNeeded?: boolean;
}

/**
 * Optimizes a Qdrant collection for proper vector indexing
 */
export class QdrantOptimizer {
  constructor(private client: QdrantClient) {}

  /**
   * Optimize collection for proper vector indexing
   */
  async optimizeCollection(
    collectionName: string,
    config: OptimizationConfig = {}
  ): Promise<void> {
    const {
      forceIndexing = true,
      indexingThreshold = 100,  // Index with as few as 100 vectors
      fullScanThreshold = 100,  // Use index for searches above 100 vectors
      segmentNumber = 1,        // Single segment for small collections
      recreateIfNeeded = false
    } = config;

    try {
      // Get current collection info
      const collectionInfo = await this.client.getCollection(collectionName);
      const { points_count, indexed_vectors_count, segments_count } = collectionInfo.result;

      logger.info(`Collection ${collectionName} status:`, {
        points: points_count,
        indexed: indexed_vectors_count,
        segments: segments_count
      });

      // Check if indexing is needed
      if (indexed_vectors_count === 0 && points_count > 0) {
        logger.warn(`Collection ${collectionName} has ${points_count} points but 0 indexed vectors`);

        if (recreateIfNeeded) {
          await this.recreateCollection(collectionName);
        } else {
          await this.forceReindex(collectionName);
        }
      }

      // Update collection parameters for small-scale deployment
      await this.updateCollectionParams(collectionName, {
        indexingThreshold,
        fullScanThreshold,
        segmentNumber
      });

      // Force segment optimization
      if (forceIndexing) {
        await this.optimizeSegments(collectionName);
      }

      // Verify indexing
      await this.verifyIndexing(collectionName);

    } catch (error: any) {
      throw new Error(
        `Failed to optimize collection ${collectionName}: ${error.message}. ` +
        `This may require manual intervention or collection recreation.`
      );
    }
  }

  /**
   * Force reindexing of all vectors
   */
  private async forceReindex(collectionName: string): Promise<void> {
    logger.info(`Forcing reindex for collection ${collectionName}`);

    try {
      // Update optimizer config to force indexing
      await this.client.updateCollection(collectionName, {
        optimizer_config: {
          indexing_threshold: 1,  // Index immediately
          memmap_threshold: 0,     // Keep in memory
          default_segment_number: 1
        }
      });

      // Wait for indexing
      await this.waitForIndexing(collectionName);

    } catch (error: any) {
      throw new Error(`Failed to force reindex: ${error.message}`);
    }
  }

  /**
   * Update collection parameters for optimal performance
   */
  private async updateCollectionParams(
    collectionName: string,
    params: {
      indexingThreshold: number;
      fullScanThreshold: number;
      segmentNumber: number;
    }
  ): Promise<void> {
    logger.info(`Updating collection parameters for ${collectionName}`);

    await this.client.updateCollection(collectionName, {
      optimizer_config: {
        deleted_threshold: 0.2,
        vacuum_min_vector_number: 100,
        default_segment_number: params.segmentNumber,
        indexing_threshold: params.indexingThreshold,
        flush_interval_sec: 1,  // Flush quickly for small deployments
        max_optimization_threads: 2
      },
      hnsw_config: {
        m: 16,
        ef_construct: 100,
        full_scan_threshold: params.fullScanThreshold,
        on_disk: false  // Keep in memory for small collections
      }
    });
  }

  /**
   * Optimize segments by merging
   */
  private async optimizeSegments(collectionName: string): Promise<void> {
    logger.info(`Optimizing segments for collection ${collectionName}`);

    try {
      // Trigger segment optimization
      await this.client.updateCollection(collectionName, {
        optimizer_config: {
          max_segment_size: 100000,  // Single segment for small collections
          memmap_threshold: 0,
          indexing_threshold: 1
        }
      });

      // Wait for optimization
      await new Promise(resolve => setTimeout(resolve, 2000));

    } catch (error: any) {
      logger.warn(`Segment optimization failed: ${error.message}`);
    }
  }

  /**
   * Wait for indexing to complete
   */
  private async waitForIndexing(
    collectionName: string,
    maxWaitMs: number = 30000
  ): Promise<void> {
    const startTime = Date.now();

    while (Date.now() - startTime < maxWaitMs) {
      const info = await this.client.getCollection(collectionName);
      const { indexed_vectors_count, points_count } = info.result;

      if (indexed_vectors_count >= points_count && points_count > 0) {
        logger.info(`Indexing complete: ${indexed_vectors_count}/${points_count} vectors indexed`);
        return;
      }

      logger.info(`Waiting for indexing: ${indexed_vectors_count}/${points_count} indexed`);
      await new Promise(resolve => setTimeout(resolve, 1000));
    }

    throw new Error(`Indexing timeout after ${maxWaitMs}ms`);
  }

  /**
   * Verify that vectors are properly indexed
   */
  private async verifyIndexing(collectionName: string): Promise<void> {
    const info = await this.client.getCollection(collectionName);
    const { indexed_vectors_count, points_count, status } = info.result;

    if (status !== 'green') {
      throw new Error(
        `Collection ${collectionName} is not healthy: Status=${status}. ` +
        `Check Qdrant logs for details.`
      );
    }

    if (points_count > 0 && indexed_vectors_count === 0) {
      throw new Error(
        `Collection ${collectionName} indexing failed: ` +
        `${points_count} points exist but 0 are indexed. ` +
        `This may require collection recreation with proper settings.`
      );
    }

    logger.info(`Collection ${collectionName} verified:`, {
      points: points_count,
      indexed: indexed_vectors_count,
      ratio: points_count > 0 ? (indexed_vectors_count / points_count * 100).toFixed(1) + '%' : 'N/A'
    });
  }

  /**
   * Recreate collection with optimal settings
   */
  private async recreateCollection(collectionName: string): Promise<void> {
    logger.warn(`Recreating collection ${collectionName} with optimal settings`);

    try {
      // Get existing collection config
      const oldInfo = await this.client.getCollection(collectionName);
      const vectorSize = oldInfo.result.config.params.vectors.size;

      // Delete and recreate
      await this.client.deleteCollection(collectionName);

      await this.client.createCollection(collectionName, {
        vectors: {
          size: vectorSize,
          distance: 'Cosine'
        },
        optimizers_config: {
          deleted_threshold: 0.2,
          vacuum_min_vector_number: 100,
          default_segment_number: 1,
          indexing_threshold: 100,  // Index immediately with small collections
          flush_interval_sec: 1,
          max_optimization_threads: 2
        },
        hnsw_config: {
          m: 16,
          ef_construct: 100,
          full_scan_threshold: 100,  // Use index for all searches
          on_disk: false
        },
        wal_config: {
          wal_capacity_mb: 32,
          wal_segments_ahead: 0
        }
      });

      logger.info(`Collection ${collectionName} recreated with optimal settings`);

    } catch (error: any) {
      throw new Error(
        `Failed to recreate collection: ${error.message}. ` +
        `Data loss may have occurred. Restore from backup if available.`
      );
    }
  }

  /**
   * Get detailed collection diagnostics
   */
  async getCollectionDiagnostics(collectionName: string): Promise<any> {
    try {
      const info = await this.client.getCollection(collectionName);
      const { result } = info;

      // Sample a few points to check vector presence
      const samplePoints = await this.client.scroll(collectionName, {
        limit: 5,
        with_vector: true
      });

      const diagnostics = {
        status: result.status,
        points_count: result.points_count,
        indexed_vectors_count: result.indexed_vectors_count,
        segments_count: result.segments_count,
        optimizer_status: result.optimizer_status,
        config: result.config,
        sample_vectors_present: samplePoints[0]?.length > 0,
        indexing_ratio: result.points_count > 0
          ? (result.indexed_vectors_count / result.points_count * 100).toFixed(1) + '%'
          : 'N/A'
      };

      return diagnostics;

    } catch (error: any) {
      throw new Error(`Failed to get diagnostics: ${error.message}`);
    }
  }
}

/**
 * Initialize and optimize Qdrant collections
 */
export async function initializeQdrantCollections(
  client: QdrantClient,
  collections: string[] = ['unified_content']
): Promise<void> {
  const optimizer = new QdrantOptimizer(client);

  for (const collectionName of collections) {
    try {
      // Check if collection exists
      const exists = await client.getCollection(collectionName)
        .then(() => true)
        .catch(() => false);

      if (!exists) {
        logger.info(`Creating collection ${collectionName}`);
        await client.createCollection(collectionName, {
          vectors: {
            size: 1024,  // Standard embedding size
            distance: 'Cosine'
          },
          optimizers_config: {
            indexing_threshold: 100,
            default_segment_number: 1
          },
          hnsw_config: {
            full_scan_threshold: 100,
            on_disk: false
          }
        });
      }

      // Optimize the collection
      await optimizer.optimizeCollection(collectionName, {
        forceIndexing: true,
        indexingThreshold: 100,
        fullScanThreshold: 100
      });

    } catch (error: any) {
      logger.error(`Failed to initialize collection ${collectionName}:`, error);
      throw error;
    }
  }
}