/**
 * WebSocket Transport Client
 *
 * WebSocket client with auto-reconnect and event handling
 */

import { io, Socket } from 'socket.io-client';
import EventEmitter from 'eventemitter3';
import type {
  WebSocketTransport,
  WSOptions,
  WSEventHandler,
  TransportError,
} from '../../types/transport.js';

export class WebSocketClient implements WebSocketTransport {
  private socket: Socket | null = null;
  private emitter: EventEmitter;
  private url: string = '';
  private options: WSOptions;
  private reconnectAttempts: number = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private messageBuffer: Array<{ event: string; data: any }> = [];
  private connected: boolean = false;

  constructor() {
    this.emitter = new EventEmitter();
    this.options = {
      reconnect: true,
      reconnectDelay: 1000,
      maxReconnectAttempts: 10,
      timeout: 30000,
    };
  }

  /**
   * Connect to WebSocket server
   */
  async connect(url: string, options?: WSOptions): Promise<void> {
    this.url = url;
    this.options = { ...this.options, ...options };

    return new Promise((resolve, reject) => {
      try {
        this.socket = io(url, {
          transports: ['websocket', 'polling'],
          timeout: this.options.timeout,
          reconnection: false, // We handle reconnection manually
        });

        // Setup event handlers
        this.setupEventHandlers();

        // Wait for connection
        const timeout = setTimeout(() => {
          reject(this.createError('CONNECTION_TIMEOUT', 'Connection timeout'));
        }, this.options.timeout);

        this.socket.once('connect', () => {
          clearTimeout(timeout);
          this.connected = true;
          this.reconnectAttempts = 0;
          this.flushMessageBuffer();
          resolve();
        });

        this.socket.once('connect_error', (error: Error) => {
          clearTimeout(timeout);
          reject(this.createError('CONNECTION_ERROR', error.message));
        });
      } catch (error) {
        reject(this.createError('CONNECTION_ERROR', (error as Error).message));
      }
    });
  }

  /**
   * Disconnect from WebSocket server
   */
  async disconnect(): Promise<void> {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    if (this.socket) {
      this.socket.removeAllListeners();
      this.socket.disconnect();
      this.socket = null;
    }

    this.connected = false;
    this.messageBuffer = [];
    this.emitter.removeAllListeners();
  }

  /**
   * Send event to server
   */
  send(event: string, data: any): void {
    if (!this.socket || !this.connected) {
      // Buffer message if not connected
      if (this.options.reconnect) {
        this.messageBuffer.push({ event, data });
      } else {
        throw this.createError('NOT_CONNECTED', 'WebSocket not connected');
      }
      return;
    }

    this.socket.emit(event, data);
  }

  /**
   * Register event handler
   */
  on(event: string, handler: WSEventHandler): void {
    this.emitter.on(event, handler);

    // Also listen on socket if connected
    if (this.socket) {
      this.socket.on(event, handler);
    }
  }

  /**
   * Unregister event handler
   */
  off(event: string, handler?: WSEventHandler): void {
    if (handler) {
      this.emitter.off(event, handler);
      if (this.socket) {
        this.socket.off(event, handler);
      }
    } else {
      this.emitter.removeAllListeners(event);
      if (this.socket) {
        this.socket.removeAllListeners(event);
      }
    }
  }

  /**
   * Check if WebSocket is connected
   */
  isConnected(): boolean {
    return this.connected && this.socket !== null && this.socket.connected;
  }

  /**
   * Setup event handlers for connection lifecycle
   */
  private setupEventHandlers(): void {
    if (!this.socket) return;

    // Connection established
    this.socket.on('connect', () => {
      this.connected = true;
      this.reconnectAttempts = 0;
      this.emitter.emit('connected');
      this.flushMessageBuffer();
    });

    // Connection lost
    this.socket.on('disconnect', (reason: string) => {
      this.connected = false;
      this.emitter.emit('disconnected', { reason });

      // Attempt reconnection if enabled
      if (this.options.reconnect && reason !== 'io client disconnect') {
        this.attemptReconnect();
      }
    });

    // Connection error
    this.socket.on('connect_error', (error: Error) => {
      this.emitter.emit('error', this.createError('CONNECTION_ERROR', error.message));

      if (this.options.reconnect) {
        this.attemptReconnect();
      }
    });

    // Heartbeat/ping-pong
    this.socket.on('ping', () => {
      this.emitter.emit('ping');
    });

    this.socket.on('pong', (latency: number) => {
      this.emitter.emit('pong', { latency });
    });

    // Forward all other events to emitter
    this.socket.onAny((event: string, ...args: any[]) => {
      if (!['connect', 'disconnect', 'connect_error', 'ping', 'pong'].includes(event)) {
        this.emitter.emit(event, ...args);
      }
    });
  }

  /**
   * Attempt to reconnect with exponential backoff
   */
  private attemptReconnect(): void {
    if (
      this.options.maxReconnectAttempts &&
      this.reconnectAttempts >= this.options.maxReconnectAttempts
    ) {
      this.emitter.emit(
        'error',
        this.createError('MAX_RECONNECT_ATTEMPTS', 'Maximum reconnection attempts reached')
      );
      return;
    }

    // Clear existing timer
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
    }

    // Calculate delay with exponential backoff
    const delay = Math.min(
      (this.options.reconnectDelay ?? 1000) * Math.pow(2, this.reconnectAttempts),
      30000 // Max 30 seconds
    );

    this.reconnectAttempts++;
    this.emitter.emit('reconnecting', {
      attempt: this.reconnectAttempts,
      delay,
    });

    this.reconnectTimer = setTimeout(() => {
      this.connect(this.url, this.options).catch((error) => {
        this.emitter.emit('error', error);
      });
    }, delay);
  }

  /**
   * Flush buffered messages
   */
  private flushMessageBuffer(): void {
    if (!this.socket || !this.connected) return;

    while (this.messageBuffer.length > 0) {
      const message = this.messageBuffer.shift();
      if (message) {
        this.socket.emit(message.event, message.data);
      }
    }
  }

  /**
   * Create transport error
   */
  private createError(code: string, message: string): TransportError {
    const error = new Error(message) as TransportError;
    error.name = 'WebSocketError';
    error.code = code;
    error.retryable = code !== 'MAX_RECONNECT_ATTEMPTS';
    return error;
  }

  /**
   * Get connection state for debugging
   */
  getState(): {
    connected: boolean;
    reconnectAttempts: number;
    bufferedMessages: number;
  } {
    return {
      connected: this.connected,
      reconnectAttempts: this.reconnectAttempts,
      bufferedMessages: this.messageBuffer.length,
    };
  }
}
