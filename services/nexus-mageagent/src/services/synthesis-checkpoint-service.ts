/**
 * Synthesis Checkpoint Service - Write-Ahead Log for Crash Recovery
 *
 * Implements industry-standard WAL pattern to prevent data loss during synthesis.
 * Architecture: Redis-backed checkpoint → Dual-write to Qdrant + Neo4j
 *
 * Design Pattern: Write-Ahead Log (WAL)
 * - PostgreSQL: WAL prevents data loss during crashes
 * - Kafka: Commit log enables replay
 * - Redis: AOF (Append-Only File) for persistence
 *
 * Recovery Guarantee: If container crashes after checkpoint write,
 * synthesis result can be reconstructed from Redis on restart.
 */

import { Redis } from 'ioredis';
import { logger } from '../utils/logger';
import { v4 as uuidv4 } from 'uuid';

export interface SynthesisCheckpoint {
  checkpointId: string;
  taskId: string;
  synthesisResult: string;
  agentCount: number;
  consensusStrength: number;
  timestamp: Date;
  status: 'pending' | 'committed' | 'failed';
  metadata: {
    model: string;
    inputSize: number;
    outputSize: number;
  };
}

export class SynthesisCheckpointService {
  private redis: Redis;
  private readonly CHECKPOINT_PREFIX = 'synthesis:checkpoint:';
  private readonly CHECKPOINT_TTL = 86400; // 24 hours

  constructor(redisClient: Redis) {
    if (!redisClient) {
      throw new Error(
        'SynthesisCheckpointService requires Redis client.\n' +
        'Redis is mandatory for WAL-based crash recovery.\n' +
        'Configure REDIS_HOST and REDIS_PORT in environment.'
      );
    }

    this.redis = redisClient;
    logger.info('SynthesisCheckpointService initialized', {
      checkpointTTL: this.CHECKPOINT_TTL,
      pattern: 'Write-Ahead Log (WAL)'
    });
  }

  /**
   * CRITICAL: Write checkpoint BEFORE committing synthesis result
   *
   * This is the WAL "write-ahead" phase - checkpoint persisted to Redis
   * BEFORE Neo4j episode or Qdrant document write begins.
   *
   * If container crashes after this call, synthesis result can be recovered.
   */
  async createCheckpoint(
    taskId: string,
    synthesisResult: string,
    metadata: Partial<SynthesisCheckpoint['metadata']> & {
      agentCount?: number;
      consensusStrength?: number;
    }
  ): Promise<string> {
    const checkpointId = `${taskId}-${uuidv4()}`;

    const checkpoint: SynthesisCheckpoint = {
      checkpointId,
      taskId,
      synthesisResult,
      agentCount: metadata.agentCount || 0,
      consensusStrength: metadata.consensusStrength || 0,
      timestamp: new Date(),
      status: 'pending',
      metadata: {
        model: metadata.model || 'unknown',
        inputSize: metadata.inputSize || 0,
        outputSize: metadata.outputSize || synthesisResult.length
      }
    };

    const key = this.getCheckpointKey(taskId);

    try {
      // ATOMIC: Write checkpoint to Redis with TTL
      await this.redis.setex(
        key,
        this.CHECKPOINT_TTL,
        JSON.stringify(checkpoint)
      );

      logger.info('Synthesis checkpoint created', {
        checkpointId,
        taskId,
        resultSize: synthesisResult.length,
        ttl: this.CHECKPOINT_TTL
      });

      return checkpointId;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error('CRITICAL: Failed to create synthesis checkpoint', {
        taskId,
        checkpointId,
        error: errorMessage,
        resultSize: synthesisResult.length
      });

      throw new Error(
        `Synthesis checkpoint creation failed for task ${taskId}:\n` +
        `Error: ${errorMessage}\n` +
        `This prevents crash recovery - synthesis result may be lost if container crashes.`
      );
    }
  }

  /**
   * Mark checkpoint as committed after successful persistence
   *
   * Called AFTER Neo4j episode + Qdrant document writes succeed.
   * Updates checkpoint status to 'committed' (enables garbage collection).
   */
  async commitCheckpoint(taskId: string): Promise<void> {
    const key = this.getCheckpointKey(taskId);

    try {
      const data = await this.redis.get(key);
      if (!data) {
        logger.warn('Checkpoint not found for commit', { taskId });
        return;
      }

      const checkpoint: SynthesisCheckpoint = JSON.parse(data);
      checkpoint.status = 'committed';

      // Update checkpoint with committed status (keeps for recovery audit)
      await this.redis.setex(
        key,
        this.CHECKPOINT_TTL,
        JSON.stringify(checkpoint)
      );

      logger.debug('Synthesis checkpoint committed', {
        taskId,
        checkpointId: checkpoint.checkpointId
      });
    } catch (error) {
      logger.warn('Failed to commit checkpoint (non-fatal)', {
        taskId,
        error: error instanceof Error ? error.message : String(error)
      });
      // Non-fatal - checkpoint still exists for recovery
    }
  }

  /**
   * Recover synthesis result from checkpoint after crash
   *
   * Recovery Path:
   * 1. Container crashes during synthesis persistence
   * 2. Container restarts
   * 3. Orchestrator checks for pending checkpoints on startup
   * 4. Recovers synthesis result from Redis checkpoint
   * 5. Completes persistence (episode + document writes)
   */
  async recoverCheckpoint(taskId: string): Promise<SynthesisCheckpoint | null> {
    const key = this.getCheckpointKey(taskId);

    try {
      const data = await this.redis.get(key);
      if (!data) {
        return null;
      }

      const checkpoint: SynthesisCheckpoint = JSON.parse(data);

      // Only recover pending checkpoints (committed = already persisted)
      if (checkpoint.status !== 'pending') {
        logger.debug('Checkpoint already committed, skipping recovery', {
          taskId,
          status: checkpoint.status
        });
        return null;
      }

      logger.info('Recovered pending synthesis checkpoint', {
        taskId,
        checkpointId: checkpoint.checkpointId,
        resultSize: checkpoint.synthesisResult.length,
        age: Date.now() - new Date(checkpoint.timestamp).getTime()
      });

      return checkpoint;
    } catch (error) {
      logger.error('Failed to recover synthesis checkpoint', {
        taskId,
        error: error instanceof Error ? error.message : String(error)
      });
      return null;
    }
  }

  /**
   * List all pending checkpoints (crash recovery audit)
   */
  async listPendingCheckpoints(): Promise<SynthesisCheckpoint[]> {
    try {
      const pattern = `${this.CHECKPOINT_PREFIX}*`;
      const keys = await this.redis.keys(pattern);

      const checkpoints: SynthesisCheckpoint[] = [];

      for (const key of keys) {
        const data = await this.redis.get(key);
        if (!data) continue;

        const checkpoint: SynthesisCheckpoint = JSON.parse(data);
        if (checkpoint.status === 'pending') {
          checkpoints.push(checkpoint);
        }
      }

      return checkpoints;
    } catch (error) {
      logger.error('Failed to list pending checkpoints', {
        error: error instanceof Error ? error.message : String(error)
      });
      return [];
    }
  }

  /**
   * Delete checkpoint after successful recovery and persistence
   */
  async deleteCheckpoint(taskId: string): Promise<void> {
    const key = this.getCheckpointKey(taskId);
    await this.redis.del(key);

    logger.debug('Checkpoint deleted', { taskId });
  }

  private getCheckpointKey(taskId: string): string {
    return `${this.CHECKPOINT_PREFIX}${taskId}`;
  }
}
