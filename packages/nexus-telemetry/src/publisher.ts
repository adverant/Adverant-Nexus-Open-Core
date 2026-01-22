/**
 * Nexus Telemetry Publisher
 *
 * Fire-and-forget telemetry event publisher using Redis Streams
 */

import Redis from 'ioredis';
import { Counter, Histogram } from 'prom-client';
import {
  TelemetryEvent,
  TelemetryEventInput,
  TelemetryPublisherConfig
} from './types';

// Default configuration
const DEFAULT_STREAM_KEY = 'nexus:telemetry:events';
const DEFAULT_MAX_STREAM_LENGTH = 100000;

// Prometheus metrics
const publishedCounter = new Counter({
  name: 'nexus_telemetry_events_published_total',
  help: 'Total telemetry events published',
  labelNames: ['service', 'operation', 'phase']
});

const publishErrorCounter = new Counter({
  name: 'nexus_telemetry_publish_errors_total',
  help: 'Total telemetry publish errors',
  labelNames: ['service', 'error_type']
});

const publishLatencyHistogram = new Histogram({
  name: 'nexus_telemetry_publish_latency_seconds',
  help: 'Latency of telemetry event publishing',
  buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1]
});

/**
 * TelemetryPublisher - Publishes events to Redis Streams
 *
 * Features:
 * - Fire-and-forget publishing (non-blocking)
 * - UUIDv7 generation for time-ordered IDs
 * - Automatic stream capping
 * - Prometheus metrics integration
 */
export class TelemetryPublisher {
  private redis: Redis;
  private serviceName: string;
  private instanceId: string;
  private streamKey: string;
  private maxStreamLength: number;
  private enableMetrics: boolean;
  private connected: boolean = false;

  constructor(config: TelemetryPublisherConfig) {
    this.serviceName = config.serviceName;
    this.instanceId = config.instanceId || process.env.HOSTNAME || 'local';
    this.streamKey = config.streamKey || DEFAULT_STREAM_KEY;
    this.maxStreamLength = config.maxStreamLength || DEFAULT_MAX_STREAM_LENGTH;
    this.enableMetrics = config.enableMetrics ?? true;

    // Parse Redis URL and create connection
    this.redis = new Redis(config.redisUrl, {
      maxRetriesPerRequest: 3,
      retryStrategy: (times: number) => {
        if (times > 3) return null; // Stop retrying
        return Math.min(times * 100, 2000);
      },
      enableReadyCheck: true,
      lazyConnect: true
    });

    // Connection event handlers
    this.redis.on('connect', () => {
      this.connected = true;
    });

    this.redis.on('error', (err) => {
      console.error('[Telemetry] Redis error:', err.message);
      if (this.enableMetrics) {
        publishErrorCounter.inc({
          service: this.serviceName,
          error_type: 'connection'
        });
      }
    });

    this.redis.on('close', () => {
      this.connected = false;
    });

    // Connect eagerly
    this.redis.connect().catch((err) => {
      console.error('[Telemetry] Failed to connect to Redis:', err.message);
    });
  }

  /**
   * Publish a telemetry event to Redis Streams
   * This is fire-and-forget - errors are logged but don't throw
   */
  publish(input: TelemetryEventInput): void {
    const startTime = Date.now();

    // Build full event with defaults
    const event: TelemetryEvent = {
      eventId: this.generateUUIDv7(),
      correlationId: input.correlationId || this.generateUUIDv7(),
      service: this.serviceName,
      instance: this.instanceId,
      timestamp: new Date().toISOString(),
      phase: input.phase || 'start',
      method: input.method || 'UNKNOWN',
      path: input.path || '/',
      operation: input.operation || 'unknown',
      ...input
    } as TelemetryEvent;

    // Fire-and-forget publish
    this.publishToStream(event)
      .then(() => {
        if (this.enableMetrics) {
          publishedCounter.inc({
            service: this.serviceName,
            operation: event.operation,
            phase: event.phase
          });
          publishLatencyHistogram.observe((Date.now() - startTime) / 1000);
        }
      })
      .catch((err) => {
        console.error('[Telemetry] Publish error:', err.message);
        if (this.enableMetrics) {
          publishErrorCounter.inc({
            service: this.serviceName,
            error_type: 'publish'
          });
        }
      });
  }

  /**
   * Publish event to Redis Stream with capping
   */
  private async publishToStream(event: TelemetryEvent): Promise<string> {
    if (!this.connected) {
      throw new Error('Redis not connected');
    }

    const messageId = await this.redis.xadd(
      this.streamKey,
      'MAXLEN',
      '~',
      this.maxStreamLength.toString(),
      '*',
      'event',
      JSON.stringify(event)
    );

    return messageId as string;
  }

  /**
   * Generate UUIDv7 - time-ordered UUID for natural sorting
   *
   * Format: tttttttt-tttt-7xxx-yxxx-xxxxxxxxxxxx
   * Where t = timestamp bits, x = random bits, y = variant bits
   */
  generateUUIDv7(): string {
    const timestamp = Date.now();

    // Convert timestamp to hex (48 bits = 12 hex chars)
    const timestampHex = timestamp.toString(16).padStart(12, '0');

    // Generate random bytes for remaining bits
    const randomHex = this.generateRandomHex(16);

    // Build UUID v7 format
    const uuid = [
      timestampHex.slice(0, 8),                              // time_high (32 bits)
      timestampHex.slice(8, 12),                             // time_mid (16 bits)
      '7' + randomHex.slice(0, 3),                           // version (4) + rand_a (12)
      this.setVariantBits(randomHex.slice(3, 7)),            // variant (2) + rand_b (14)
      randomHex.slice(7, 19)                                 // rand_c (48 bits)
    ].join('-');

    return uuid;
  }

  /**
   * Generate random hex string
   */
  private generateRandomHex(length: number): string {
    let result = '';
    for (let i = 0; i < length; i++) {
      result += Math.floor(Math.random() * 16).toString(16);
    }
    return result;
  }

  /**
   * Set variant bits (10xx) for UUID
   */
  private setVariantBits(hex: string): string {
    const firstChar = parseInt(hex[0], 16);
    const variantChar = ((firstChar & 0x3) | 0x8).toString(16);
    return variantChar + hex.slice(1);
  }

  /**
   * Get current stream length
   */
  async getStreamLength(): Promise<number> {
    if (!this.connected) return 0;
    return this.redis.xlen(this.streamKey);
  }

  /**
   * Get stream info for monitoring
   */
  async getStreamInfo(): Promise<Record<string, unknown> | null> {
    if (!this.connected) return null;

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
   * Check if publisher is connected
   */
  isConnected(): boolean {
    return this.connected;
  }

  /**
   * Close the Redis connection
   */
  async close(): Promise<void> {
    await this.redis.quit();
    this.connected = false;
  }
}

/**
 * Create a telemetry publisher with simple configuration
 */
export function createTelemetryPublisher(
  redisUrl: string,
  serviceName: string,
  options?: Partial<TelemetryPublisherConfig>
): TelemetryPublisher {
  return new TelemetryPublisher({
    redisUrl,
    serviceName,
    ...options
  });
}
