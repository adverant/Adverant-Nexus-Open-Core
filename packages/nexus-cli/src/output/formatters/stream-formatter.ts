/**
 * Stream Formatter
 *
 * Stream-JSON formatter for real-time event output
 */

import type {
  OutputFormatter,
  FormatOptions,
  OutputFormat,
  StreamEvent,
  StreamMetadata,
} from '../../types/output.js';

export class StreamFormatter implements OutputFormatter {
  readonly format: OutputFormat = 'stream-json';

  /**
   * Format result as stream-json (newline-delimited JSON)
   */
  formatResult(result: any, options?: FormatOptions): string {
    // For single results, wrap in data event
    const event: StreamEvent = {
      type: 'data',
      timestamp: new Date().toISOString(),
      data: result,
    };

    return this.formatEvent(event);
  }

  /**
   * Check if formatter supports given format
   */
  supports(format: OutputFormat): boolean {
    return format === 'stream-json';
  }

  /**
   * Format stream event
   */
  formatEvent(event: StreamEvent): string {
    // Newline-delimited JSON
    return JSON.stringify(event) + '\n';
  }

  /**
   * Format progress event
   */
  formatProgress(
    current: number,
    total: number,
    message?: string,
    metadata?: Partial<StreamMetadata>
  ): string {
    const progress = total > 0 ? (current / total) * 100 : 0;

    const event: StreamEvent = {
      type: 'progress',
      timestamp: new Date().toISOString(),
      data: message || `Processing ${current}/${total}`,
      metadata: {
        progress,
        current,
        total,
        ...metadata,
      },
    };

    return this.formatEvent(event);
  }

  /**
   * Format data event
   */
  formatData(data: any, metadata?: Partial<StreamMetadata>): string {
    const event: StreamEvent = {
      type: 'data',
      timestamp: new Date().toISOString(),
      data,
      metadata,
    };

    return this.formatEvent(event);
  }

  /**
   * Format result event
   */
  formatResultEvent(result: any, metadata?: Partial<StreamMetadata>): string {
    const event: StreamEvent = {
      type: 'result',
      timestamp: new Date().toISOString(),
      data: result,
      metadata,
    };

    return this.formatEvent(event);
  }

  /**
   * Format error event
   */
  formatError(error: Error | string, metadata?: Partial<StreamMetadata>): string {
    const errorData =
      typeof error === 'string'
        ? { message: error }
        : {
            name: error.name,
            message: error.message,
            stack: error.stack?.split('\n'),
          };

    const event: StreamEvent = {
      type: 'error',
      timestamp: new Date().toISOString(),
      data: errorData,
      metadata,
    };

    return this.formatEvent(event);
  }

  /**
   * Format complete event
   */
  formatComplete(summary?: any, metadata?: Partial<StreamMetadata>): string {
    const event: StreamEvent = {
      type: 'complete',
      timestamp: new Date().toISOString(),
      data: summary || { status: 'completed' },
      metadata,
    };

    return this.formatEvent(event);
  }

  /**
   * Format step event
   */
  formatStep(step: string, metadata?: Partial<StreamMetadata>): string {
    const event: StreamEvent = {
      type: 'progress',
      timestamp: new Date().toISOString(),
      data: step,
      metadata: {
        step,
        ...metadata,
      },
    };

    return this.formatEvent(event);
  }

  /**
   * Parse stream-json line
   */
  parseEvent(line: string): StreamEvent | null {
    try {
      const event = JSON.parse(line);

      // Validate event structure
      if (
        typeof event === 'object' &&
        event !== null &&
        'type' in event &&
        'timestamp' in event &&
        'data' in event
      ) {
        return event as StreamEvent;
      }

      return null;
    } catch {
      return null;
    }
  }

  /**
   * Parse stream of newline-delimited JSON
   */
  async *parseStream(stream: AsyncIterable<string>): AsyncIterable<StreamEvent> {
    for await (const chunk of stream) {
      const lines = chunk.split('\n').filter((line) => line.trim());

      for (const line of lines) {
        const event = this.parseEvent(line);
        if (event) {
          yield event;
        }
      }
    }
  }

  /**
   * Format batch of events
   */
  formatBatch(events: StreamEvent[]): string {
    return events.map((event) => this.formatEvent(event)).join('');
  }

  /**
   * Create event builder
   */
  createEventBuilder(): StreamEventBuilder {
    return new StreamEventBuilder(this);
  }

  /**
   * Calculate ETA
   */
  calculateETA(current: number, total: number, startTime: number): number {
    if (current === 0) return 0;

    const elapsed = Date.now() - startTime;
    const rate = current / elapsed; // items per ms
    const remaining = total - current;

    return remaining / rate; // ms remaining
  }

  /**
   * Calculate rate
   */
  calculateRate(current: number, startTime: number): number {
    const elapsed = Date.now() - startTime;
    if (elapsed === 0) return 0;

    return (current / elapsed) * 1000; // items per second
  }
}

/**
 * Stream event builder for convenience
 */
export class StreamEventBuilder {
  private startTime: number = Date.now();
  private formatter: StreamFormatter;

  constructor(formatter: StreamFormatter) {
    this.formatter = formatter;
  }

  /**
   * Emit progress event
   */
  progress(current: number, total: number, message?: string): string {
    const eta = this.formatter.calculateETA(current, total, this.startTime);
    const rate = this.formatter.calculateRate(current, this.startTime);

    return this.formatter.formatProgress(current, total, message, {
      eta,
      rate,
    });
  }

  /**
   * Emit data event
   */
  data(data: any): string {
    return this.formatter.formatData(data);
  }

  /**
   * Emit result event
   */
  result(result: any): string {
    return this.formatter.formatResultEvent(result);
  }

  /**
   * Emit error event
   */
  error(error: Error | string): string {
    return this.formatter.formatError(error);
  }

  /**
   * Emit complete event
   */
  complete(summary?: any): string {
    const duration = Date.now() - this.startTime;
    return this.formatter.formatComplete(summary, { eta: 0, rate: 0 });
  }

  /**
   * Emit step event
   */
  step(step: string): string {
    return this.formatter.formatStep(step);
  }

  /**
   * Reset start time
   */
  reset(): void {
    this.startTime = Date.now();
  }
}

export const streamFormatter = new StreamFormatter();
