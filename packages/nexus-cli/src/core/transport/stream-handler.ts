/**
 * Stream Handler
 *
 * Handles streaming responses (SSE and WebSocket streams)
 */

import type {
  StreamingTransport,
  StreamOptions,
  StreamChunk,
  TransportError,
} from '../../types/transport.js';
import { HTTPClient } from './http-client.js';
import { WebSocketClient } from './websocket-client.js';

export class StreamHandler implements StreamingTransport {
  private httpClient?: HTTPClient;
  private wsClient?: WebSocketClient;

  constructor(
    httpClient?: HTTPClient,
    wsClient?: WebSocketClient
  ) {
    this.httpClient = httpClient;
    this.wsClient = wsClient;
  }

  /**
   * Stream data from endpoint
   * Supports both SSE (HTTP) and WebSocket streams
   */
  async *stream<T = any>(
    path: string,
    options?: StreamOptions
  ): AsyncIterable<StreamChunk<T>> {
    // Determine if this is a WebSocket or HTTP stream
    if (path.startsWith('ws://') || path.startsWith('wss://')) {
      yield* this.streamWebSocket<T>(path, options);
    } else {
      yield* this.streamHTTP<T>(path, options);
    }
  }

  /**
   * Stream via Server-Sent Events (HTTP)
   */
  private async *streamHTTP<T>(
    path: string,
    options?: StreamOptions
  ): AsyncIterable<StreamChunk<T>> {
    const url = this.buildUrl(path, options?.params);
    const method = options?.method || 'GET';

    const requestInit: RequestInit = {
      method,
      headers: {
        'Accept': 'text/event-stream',
        'Cache-Control': 'no-cache',
        ...options?.headers,
      },
      signal: options?.signal,
    };

    if (method === 'POST' && options?.data) {
      requestInit.body = JSON.stringify(options.data);
      requestInit.headers = {
        ...requestInit.headers,
        'Content-Type': 'application/json',
      };
    }

    let response: Response;
    try {
      response = await fetch(url, requestInit);
    } catch (error) {
      yield {
        type: 'error',
        data: this.createError('STREAM_ERROR', (error as Error).message) as any,
      };
      return;
    }

    if (!response.ok) {
      yield {
        type: 'error',
        data: this.createError(
          'HTTP_ERROR',
          `HTTP ${response.status}: ${response.statusText}`
        ) as any,
        metadata: { statusCode: response.status },
      };
      return;
    }

    if (!response.body) {
      yield {
        type: 'error',
        data: this.createError('NO_BODY', 'Response has no body') as any,
      };
      return;
    }

    // Read stream
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    try {
      while (true) {
        const { done, value } = await reader.read();

        if (done) {
          yield { type: 'complete', data: null as any };
          break;
        }

        // Decode and buffer
        buffer += decoder.decode(value, { stream: true });

        // Process complete lines
        const lines = buffer.split('\n');
        buffer = lines.pop() || ''; // Keep incomplete line in buffer

        for (const line of lines) {
          if (!line.trim()) continue;

          // Parse SSE format
          if (line.startsWith('data: ')) {
            const data = line.slice(6);

            try {
              // Try to parse as JSON
              const parsed = JSON.parse(data);
              yield this.parseStreamChunk<T>(parsed);
            } catch {
              // Not JSON, yield as text
              yield {
                type: 'data',
                data: data as any,
              };
            }
          } else if (line.startsWith('event: ')) {
            // Event type (we'll include in next data chunk)
            continue;
          } else if (line.startsWith('id: ')) {
            // Event ID (we'll include in metadata)
            continue;
          }
        }
      }
    } catch (error) {
      yield {
        type: 'error',
        data: this.createError('STREAM_READ_ERROR', (error as Error).message) as any,
      };
    } finally {
      reader.releaseLock();
    }
  }

  /**
   * Stream via WebSocket
   */
  private async *streamWebSocket<T>(
    path: string,
    options?: StreamOptions
  ): AsyncIterable<StreamChunk<T>> {
    if (!this.wsClient) {
      yield {
        type: 'error',
        data: this.createError('NO_WS_CLIENT', 'WebSocket client not configured') as any,
      };
      return;
    }

    // Create queue for streaming chunks
    const queue: StreamChunk<T>[] = [];
    let completed = false;
    let error: TransportError | null = null;

    // Setup event handlers
    const dataHandler = (data: any) => {
      queue.push(this.parseStreamChunk<T>(data));
    };

    const errorHandler = (err: any) => {
      error = this.createError('WS_ERROR', err.message || 'WebSocket error');
      completed = true;
    };

    const completeHandler = () => {
      completed = true;
    };

    this.wsClient.on('data', dataHandler);
    this.wsClient.on('error', errorHandler);
    this.wsClient.on('complete', completeHandler);

    // Send initial request if data provided
    if (options?.data) {
      this.wsClient.send('stream', options.data);
    }

    // Yield chunks as they arrive
    try {
      while (!completed) {
        if (queue.length > 0) {
          yield queue.shift()!;
        } else {
          // Wait a bit before checking again
          await this.sleep(10);
        }
      }

      // Drain remaining queue
      while (queue.length > 0) {
        yield queue.shift()!;
      }

      if (error) {
        yield { type: 'error', data: error as any };
      } else {
        yield { type: 'complete', data: null as any };
      }
    } finally {
      // Cleanup handlers
      this.wsClient.off('data', dataHandler);
      this.wsClient.off('error', errorHandler);
      this.wsClient.off('complete', completeHandler);
    }
  }

  /**
   * Parse stream chunk from raw data
   */
  private parseStreamChunk<T>(data: any): StreamChunk<T> {
    // Check if data has type field
    if (typeof data === 'object' && data !== null && 'type' in data) {
      return {
        type: data.type,
        data: data.data,
        metadata: data.metadata,
      };
    }

    // Default to data type
    return {
      type: 'data',
      data,
    };
  }

  /**
   * Build full URL with query parameters
   */
  private buildUrl(path: string, params?: Record<string, any>): string {
    if (!params) return path;

    const url = new URL(path, 'http://localhost'); // Base doesn't matter for relative paths
    Object.entries(params).forEach(([key, value]) => {
      if (value !== undefined && value !== null) {
        url.searchParams.append(key, String(value));
      }
    });

    return url.toString();
  }

  /**
   * Create transport error
   */
  private createError(code: string, message: string): TransportError {
    const error = new Error(message) as TransportError;
    error.name = 'StreamError';
    error.code = code;
    error.retryable = false;
    return error;
  }

  /**
   * Sleep utility
   */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

/**
 * Parse stream-json format (newline-delimited JSON)
 */
export async function* parseStreamJSON<T = any>(
  stream: AsyncIterable<string>
): AsyncIterable<T> {
  for await (const chunk of stream) {
    const lines = chunk.split('\n').filter((line) => line.trim());

    for (const line of lines) {
      try {
        yield JSON.parse(line) as T;
      } catch (error) {
        // Skip invalid JSON lines
        continue;
      }
    }
  }
}

/**
 * Format data as stream-json (newline-delimited JSON)
 */
export function formatStreamJSON(data: any): string {
  return JSON.stringify(data) + '\n';
}
