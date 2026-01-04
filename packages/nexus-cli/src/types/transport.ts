/**
 * Transport Type Definitions
 *
 * Types for HTTP, WebSocket, and MCP transport layers
 */

import type { AuthConfig } from './config.js';

export interface TransportConfig {
  baseUrl: string;
  timeout?: number;
  retries?: number;
  headers?: Record<string, string>;
  auth?: AuthConfig;
}

export interface HTTPTransport {
  get<T = any>(path: string, options?: RequestOptions): Promise<T>;
  post<T = any>(path: string, data?: any, options?: RequestOptions): Promise<T>;
  put<T = any>(path: string, data?: any, options?: RequestOptions): Promise<T>;
  patch<T = any>(path: string, data?: any, options?: RequestOptions): Promise<T>;
  delete<T = any>(path: string, options?: RequestOptions): Promise<T>;
}

export interface RequestOptions {
  params?: Record<string, any>;
  headers?: Record<string, string>;
  timeout?: number;
  retries?: number;
  signal?: AbortSignal;
}

export interface WebSocketTransport {
  connect(url: string, options?: WSOptions): Promise<void>;
  disconnect(): Promise<void>;
  send(event: string, data: any): void;
  on(event: string, handler: WSEventHandler): void;
  off(event: string, handler?: WSEventHandler): void;
  isConnected(): boolean;
}

export interface WSOptions {
  reconnect?: boolean;
  reconnectDelay?: number;
  maxReconnectAttempts?: number;
  timeout?: number;
}

export type WSEventHandler = (data: any) => void;

export interface MCPTransport {
  connect(config: MCPConfig): Promise<void>;
  disconnect(): Promise<void>;
  call<T = any>(method: string, params?: any): Promise<T>;
  listTools(): Promise<MCPTool[]>;
  executeTool<T = any>(name: string, args?: any): Promise<T>;
}

export interface MCPConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  timeout?: number;
}

export interface MCPTool {
  name: string;
  description: string;
  inputSchema: any;
  outputSchema?: any;
}

export interface StreamingTransport {
  stream<T = any>(
    path: string,
    options?: StreamOptions
  ): AsyncIterable<StreamChunk<T>>;
}

export interface StreamOptions extends RequestOptions {
  method?: 'GET' | 'POST';
  data?: any;
}

export interface StreamChunk<T = any> {
  type: 'data' | 'progress' | 'error' | 'complete';
  data: T;
  metadata?: any;
}

export interface TransportError extends Error {
  code: string;
  statusCode?: number;
  details?: any;
  retryable?: boolean;
}

export interface RetryConfig {
  maxAttempts: number;
  initialDelay: number;
  maxDelay: number;
  factor: number;
  retryableErrors?: string[];
}

export interface RequestMetrics {
  startTime: number;
  endTime?: number;
  duration?: number;
  retries: number;
  success: boolean;
  error?: TransportError;
}
