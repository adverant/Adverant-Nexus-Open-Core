/**
 * Direct Redis Queue Implementation
 *
 * Simple, compatible queue using native Redis operations.
 * Compatible with both TypeScript (API) and Go (Worker).
 */

import { Redis } from 'ioredis';
import { v4 as uuidv4 } from 'uuid';

export interface QueueJob {
    id: string;
    type: string;
    payload: any;
    createdAt: Date;
    attempts?: number;
    maxRetries?: number;
}

export class RedisQueue {
    private redis: Redis;
    private queueKey: string;
    private processingKey: string;
    private completedKey: string;
    private failedKey: string;

    constructor(redis: Redis, queueName: string = 'fileprocess:jobs') {
        this.redis = redis;
        this.queueKey = queueName;
        this.processingKey = `${queueName}:processing`;
        this.completedKey = `${queueName}:completed`;
        this.failedKey = `${queueName}:failed`;
    }

    /**
     * Add a job to the queue
     */
    async addJob(type: string, payload: any): Promise<string> {
        console.log(`[RedisQueue] Adding job to queue: ${this.queueKey}`);
        const job: QueueJob = {
            id: uuidv4(),
            type,
            payload,
            createdAt: new Date(),
            attempts: 0,
            maxRetries: 3
        };

        console.log(`[RedisQueue] Job created: ${job.id}`);

        // Store job data
        console.log(`[RedisQueue] Storing job data in hash: ${this.queueKey}:data`);
        await this.redis.hset(
            `${this.queueKey}:data`,
            job.id,
            JSON.stringify(job)
        );
        console.log(`[RedisQueue] Job data stored`);

        // Push job ID to queue
        console.log(`[RedisQueue] Pushing job ID to LIST: ${this.queueKey}`);
        const listLength = await this.redis.lpush(this.queueKey, job.id);
        console.log(`[RedisQueue] Job pushed to LIST, new length: ${listLength}`);

        // Publish event for monitoring
        await this.redis.publish(`${this.queueKey}:events`, JSON.stringify({
            event: 'job:added',
            jobId: job.id,
            timestamp: new Date().toISOString()
        }));

        console.log(`[RedisQueue] Job ${job.id} added successfully`);
        return job.id;
    }

    /**
     * Get job by ID
     */
    async getJob(jobId: string): Promise<QueueJob | null> {
        const data = await this.redis.hget(`${this.queueKey}:data`, jobId);
        return data ? JSON.parse(data) : null;
    }

    /**
     * Update job status
     */
    async updateJobStatus(jobId: string, status: 'processing' | 'completed' | 'failed', result?: any): Promise<void> {
        const job = await this.getJob(jobId);
        if (!job) return;

        if (status === 'processing') {
            // Move to processing set
            await this.redis.sadd(this.processingKey, jobId);
        } else if (status === 'completed') {
            // Remove from processing
            await this.redis.srem(this.processingKey, jobId);
            // Add to completed set
            await this.redis.sadd(this.completedKey, jobId);
            // Store result
            if (result) {
                await this.redis.hset(
                    `${this.queueKey}:results`,
                    jobId,
                    JSON.stringify(result)
                );
            }
        } else if (status === 'failed') {
            // Remove from processing
            await this.redis.srem(this.processingKey, jobId);
            // Add to failed set
            await this.redis.sadd(this.failedKey, jobId);
            // Store error
            if (result) {
                await this.redis.hset(
                    `${this.queueKey}:errors`,
                    jobId,
                    JSON.stringify(result)
                );
            }
        }

        // Publish event
        await this.redis.publish(`${this.queueKey}:events`, JSON.stringify({
            event: `job:${status}`,
            jobId,
            timestamp: new Date().toISOString()
        }));
    }

    /**
     * Get job result
     */
    async getJobResult(jobId: string): Promise<any> {
        const result = await this.redis.hget(`${this.queueKey}:results`, jobId);
        return result ? JSON.parse(result) : null;
    }

    /**
     * Get queue statistics
     */
    async getStats(): Promise<{
        waiting: number;
        processing: number;
        completed: number;
        failed: number;
    }> {
        const [waiting, processing, completed, failed] = await Promise.all([
            this.redis.llen(this.queueKey),
            this.redis.scard(this.processingKey),
            this.redis.scard(this.completedKey),
            this.redis.scard(this.failedKey)
        ]);

        return { waiting, processing, completed, failed };
    }

    /**
     * Clean up old completed/failed jobs (housekeeping)
     */
    async cleanup(olderThanHours: number = 24): Promise<void> {
        const cutoffTime = Date.now() - (olderThanHours * 60 * 60 * 1000);

        // Get all completed and failed job IDs
        const [completedIds, failedIds] = await Promise.all([
            this.redis.smembers(this.completedKey),
            this.redis.smembers(this.failedKey)
        ]);

        const allIds = [...completedIds, ...failedIds];

        for (const jobId of allIds) {
            const job = await this.getJob(jobId);
            if (job && new Date(job.createdAt).getTime() < cutoffTime) {
                // Remove job data
                await this.redis.hdel(`${this.queueKey}:data`, jobId);
                await this.redis.hdel(`${this.queueKey}:results`, jobId);
                await this.redis.hdel(`${this.queueKey}:errors`, jobId);

                // Remove from sets
                await this.redis.srem(this.completedKey, jobId);
                await this.redis.srem(this.failedKey, jobId);
            }
        }
    }
}