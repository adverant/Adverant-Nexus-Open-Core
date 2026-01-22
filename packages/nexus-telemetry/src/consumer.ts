/**
 * Nexus Telemetry Consumer
 *
 * Consumes telemetry events from Redis Streams for orchestration
 */

import Redis from 'ioredis';
import { Counter, Gauge, Histogram } from 'prom-client';
import {
  TelemetryEvent,
  TelemetryConsumerConfig,
  StreamMessage
} from './types';

// Default configuration
const DEFAULT_STREAM_KEY = 'nexus:telemetry:events';
const DEFAULT_CONSUMER_GROUP = 'orchestrator';
const DEFAULT_BATCH_SIZE = 100;
const DEFAULT_BLOCK_TIMEOUT = 5000;

// Prometheus metrics
const consumedCounter = new Counter({
  name: 'nexus_telemetry_events_consumed_total',
  help: 'Total telemetry events consumed',
  labelNames: ['service', 'operation', 'phase']
});

const consumeErrorCounter = new Counter({
  name: 'nexus_telemetry_consume_errors_total',
  help: 'Total telemetry consume errors',
  labelNames: ['error_type']
});

const processLatencyHistogram = new Histogram({
  name: 'nexus_telemetry_process_latency_seconds',
  help: 'Latency of telemetry event processing',
  buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5]
});

const streamLagGauge = new Gauge({
  name: 'nexus_telemetry_stream_lag',
  help: 'Number of unprocessed events in stream'
});

const pendingMessagesGauge = new Gauge({
  name: 'nexus_telemetry_pending_messages',
  help: 'Number of pending (unacknowledged) messages'
});

/**
 * Event handler callback type
 */
export type EventHandler = (event: TelemetryEvent) => Promise<void>;

/**
 * TelemetryConsumer - Consumes events from Redis Streams
 *
 * Features:
 * - Consumer group support for horizontal scaling
 * - Automatic message acknowledgment
 * - Pending message recovery
 * - Prometheus metrics integration
 */
export class TelemetryConsumer {
  private redis: Redis;
  private streamKey: string;
  private consumerGroup: string;
  private consumerName: string;
  private batchSize: number;
  private blockTimeout: number;
  private running: boolean = false;
  private handler: EventHandler | null = null;

  constructor(config: TelemetryConsumerConfig) {
    this.streamKey = config.streamKey || DEFAULT_STREAM_KEY;
    this.consumerGroup = config.consumerGroup || DEFAULT_CONSUMER_GROUP;
    this.consumerName = config.consumerName || process.env.HOSTNAME || `consumer-${Date.now()}`;
    this.batchSize = config.batchSize || DEFAULT_BATCH_SIZE;
    this.blockTimeout = config.blockTimeout || DEFAULT_BLOCK_TIMEOUT;

    // Create Redis connection
    this.redis = new Redis(config.redisUrl, {
      maxRetriesPerRequest: null, // Required for blocking commands
      enableReadyCheck: true,
      lazyConnect: true
    });

    this.redis.on('error', (err) => {
      console.error('[TelemetryConsumer] Redis error:', err.message);
      consumeErrorCounter.inc({ error_type: 'connection' });
    });
  }

  /**
   * Start consuming events
   */
  async start(handler: EventHandler): Promise<void> {
    this.handler = handler;

    // Connect to Redis
    await this.redis.connect();

    // Ensure consumer group exists
    await this.ensureConsumerGroup();

    // Process any pending messages first
    await this.processPendingMessages();

    // Start main consume loop
    this.running = true;
    this.consumeLoop().catch((err) => {
      console.error('[TelemetryConsumer] Fatal error in consume loop:', err);
      this.running = false;
    });

    console.log(`[TelemetryConsumer] Started consuming from ${this.streamKey} as ${this.consumerName}`);
  }

  /**
   * Stop consuming events
   */
  async stop(): Promise<void> {
    this.running = false;
    // Allow current batch to complete
    await new Promise(resolve => setTimeout(resolve, 100));
    await this.redis.quit();
    console.log('[TelemetryConsumer] Stopped');
  }

  /**
   * Ensure consumer group exists
   */
  private async ensureConsumerGroup(): Promise<void> {
    try {
      await this.redis.xgroup('CREATE', this.streamKey, this.consumerGroup, '0', 'MKSTREAM');
      console.log(`[TelemetryConsumer] Created consumer group: ${this.consumerGroup}`);
    } catch (err: unknown) {
      const error = err as Error;
      if (!error.message.includes('BUSYGROUP')) {
        throw err;
      }
      // Group already exists, which is fine
    }
  }

  /**
   * Process pending messages (messages that were delivered but not acknowledged)
   */
  private async processPendingMessages(): Promise<void> {
    try {
      // Get pending entries for this consumer
      const pendingInfo = await this.redis.xpending(
        this.streamKey,
        this.consumerGroup,
        '-',
        '+',
        '100',
        this.consumerName
      );

      if (!pendingInfo || pendingInfo.length === 0) {
        return;
      }

      console.log(`[TelemetryConsumer] Processing ${pendingInfo.length} pending messages`);
      pendingMessagesGauge.set(pendingInfo.length);

      // Claim and process each pending message
      for (const pending of pendingInfo as Array<[string, string, number, number]>) {
        const messageId = pending[0];
        try {
          const messages = await this.redis.xclaim(
            this.streamKey,
            this.consumerGroup,
            this.consumerName,
            0, // Min idle time
            messageId
          );

          for (const message of messages as Array<[string, string[]]>) {
            await this.processMessage(message[0], message[1]);
          }
        } catch (err) {
          console.error(`[TelemetryConsumer] Error processing pending message ${messageId}:`, err);
        }
      }
    } catch (err) {
      console.error('[TelemetryConsumer] Error processing pending messages:', err);
    }
  }

  /**
   * Main consume loop
   */
  private async consumeLoop(): Promise<void> {
    while (this.running) {
      try {
        // Read new messages from stream
        const results = await this.redis.xreadgroup(
          'GROUP',
          this.consumerGroup,
          this.consumerName,
          'COUNT',
          this.batchSize.toString(),
          'BLOCK',
          this.blockTimeout.toString(),
          'STREAMS',
          this.streamKey,
          '>' // Only new messages
        );

        if (!results) {
          // Timeout, no new messages
          continue;
        }

        // Process each stream's messages
        for (const [, messages] of results as Array<[string, Array<[string, string[]]>]>) {
          for (const [messageId, fields] of messages) {
            await this.processMessage(messageId, fields);
          }
        }

        // Update lag metric
        await this.updateLagMetric();
      } catch (err) {
        if (this.running) {
          console.error('[TelemetryConsumer] Error in consume loop:', err);
          consumeErrorCounter.inc({ error_type: 'consume' });
          // Brief pause before retry
          await new Promise(resolve => setTimeout(resolve, 1000));
        }
      }
    }
  }

  /**
   * Process a single message
   */
  private async processMessage(messageId: string, fields: string[]): Promise<void> {
    const startTime = Date.now();

    try {
      // Parse event from fields
      const eventJson = this.getFieldValue(fields, 'event');
      if (!eventJson) {
        console.warn(`[TelemetryConsumer] Message ${messageId} missing event field`);
        await this.acknowledge(messageId);
        return;
      }

      const event: TelemetryEvent = JSON.parse(eventJson);

      // Call handler
      if (this.handler) {
        await this.handler(event);
      }

      // Update metrics
      consumedCounter.inc({
        service: event.service,
        operation: event.operation,
        phase: event.phase
      });

      processLatencyHistogram.observe((Date.now() - startTime) / 1000);

      // Acknowledge message
      await this.acknowledge(messageId);
    } catch (err) {
      console.error(`[TelemetryConsumer] Error processing message ${messageId}:`, err);
      consumeErrorCounter.inc({ error_type: 'process' });

      // Still acknowledge to prevent infinite retry
      // In production, you might want a dead letter queue
      await this.acknowledge(messageId);
    }
  }

  /**
   * Get field value from Redis stream message fields
   */
  private getFieldValue(fields: string[], key: string): string | undefined {
    for (let i = 0; i < fields.length; i += 2) {
      if (fields[i] === key) {
        return fields[i + 1];
      }
    }
    return undefined;
  }

  /**
   * Acknowledge a message
   */
  private async acknowledge(messageId: string): Promise<void> {
    await this.redis.xack(this.streamKey, this.consumerGroup, messageId);
  }

  /**
   * Update stream lag metric
   */
  private async updateLagMetric(): Promise<void> {
    try {
      const info = await this.redis.xinfo('GROUPS', this.streamKey) as Array<Array<string | number>>;
      for (let i = 0; i < info.length; i++) {
        const groupInfo = info[i];
        if (groupInfo[1] === this.consumerGroup) {
          // lag is at index 15 in XINFO GROUPS response
          const lag = groupInfo[15] as number;
          if (typeof lag === 'number') {
            streamLagGauge.set(lag);
          }
          break;
        }
      }
    } catch {
      // Ignore errors in metric update
    }
  }

  /**
   * Get stream info for monitoring
   */
  async getStreamInfo(): Promise<Record<string, unknown> | null> {
    try {
      const info = await this.redis.xinfo('STREAM', this.streamKey) as Array<string | number | unknown>;
      const result: Record<string, unknown> = {};

      for (let i = 0; i < info.length; i += 2) {
        result[info[i] as string] = info[i + 1];
      }

      return result;
    } catch {
      return null;
    }
  }

  /**
   * Get consumer group info
   */
  async getConsumerGroupInfo(): Promise<Record<string, unknown> | null> {
    try {
      const groups = await this.redis.xinfo('GROUPS', this.streamKey) as Array<Array<string | number>>;

      for (const group of groups) {
        const groupArray = group;
        if (groupArray[1] === this.consumerGroup) {
          return {
            name: groupArray[1],
            consumers: groupArray[3],
            pending: groupArray[5],
            lastDeliveredId: groupArray[7]
          };
        }
      }

      return null;
    } catch {
      return null;
    }
  }

  /**
   * Check if consumer is running
   */
  isRunning(): boolean {
    return this.running;
  }
}

/**
 * Create a telemetry consumer with simple configuration
 */
export function createTelemetryConsumer(
  redisUrl: string,
  options?: Partial<TelemetryConsumerConfig>
): TelemetryConsumer {
  return new TelemetryConsumer({
    redisUrl,
    ...options
  });
}
