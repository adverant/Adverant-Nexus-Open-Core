/**
 * Type-safe API response interfaces for nexus-cli
 * Eliminates 'any' types and provides compile-time safety
 */

/**
 * Standard API response wrapper
 */
export interface ApiResponse<T> {
  success: boolean;
  data: T;
  message?: string;
  error?: string;
}

/**
 * User authentication response
 */
export interface AuthUser {
  id: string;
  name: string;
  email: string;
  role?: string;
}

export interface AuthVerifyResponse {
  valid: boolean;
  user?: AuthUser;
  expiresAt?: string;
}

/**
 * Plugin metadata
 */
export interface PluginMetadata {
  id: string;
  name: string;
  displayName: string;
  description: string;
  version: string;
  author: string;
  status: 'active' | 'inactive' | 'error';
  createdAt: string;
  updatedAt: string;
}

export interface PluginListResponse {
  plugins: PluginMetadata[];
  total: number;
  page: number;
  perPage: number;
}

/**
 * Plugin registration response
 */
export interface PluginRegistrationResponse {
  id: string;
  name: string;
  version: string;
  status: 'registered' | 'pending_approval';
  webhookUrl?: string;
}

/**
 * Deployment response
 */
export interface DeploymentInfo {
  id: string;
  pluginId: string;
  environment: 'staging' | 'production';
  status: 'deploying' | 'deployed' | 'failed';
  deployedAt: string;
  url?: string;
}

export interface DeploymentResponse {
  deployment: DeploymentInfo;
  message: string;
}

/**
 * Log entry from plugin execution
 */
export interface LogEntry {
  timestamp: string;
  level: 'debug' | 'info' | 'warn' | 'error';
  message: string;
  context?: Record<string, unknown>;
  pluginId?: string;
  executionId?: string;
}

export interface LogsResponse {
  logs: LogEntry[];
  total: number;
  hasMore: boolean;
}

/**
 * Type guard for API response
 */
export function isApiResponse<T>(data: unknown): data is ApiResponse<T> {
  return (
    typeof data === 'object' &&
    data !== null &&
    'success' in data &&
    typeof (data as ApiResponse<T>).success === 'boolean' &&
    'data' in data
  );
}

/**
 * Type guard for auth verify response
 */
export function isAuthVerifyResponse(data: unknown): data is AuthVerifyResponse {
  return (
    typeof data === 'object' &&
    data !== null &&
    'valid' in data &&
    typeof (data as AuthVerifyResponse).valid === 'boolean'
  );
}

/**
 * Type guard for plugin list response
 */
export function isPluginListResponse(data: unknown): data is PluginListResponse {
  return (
    typeof data === 'object' &&
    data !== null &&
    'plugins' in data &&
    Array.isArray((data as PluginListResponse).plugins)
  );
}

/**
 * Type guard for logs response
 */
export function isLogsResponse(data: unknown): data is LogsResponse {
  return (
    typeof data === 'object' &&
    data !== null &&
    'logs' in data &&
    Array.isArray((data as LogsResponse).logs)
  );
}

/**
 * Health check response for API availability
 */
export interface HealthCheckService {
  name: string;
  status: 'healthy' | 'unhealthy' | 'degraded';
  latency?: number;
  message?: string;
  version?: string;
}

export interface HealthCheckResponse {
  status: 'healthy' | 'unhealthy' | 'degraded';
  timestamp: string;
  services: HealthCheckService[];
  uptime?: number;
}

/**
 * Type guard for health check response
 */
export function isHealthCheckResponse(data: unknown): data is HealthCheckResponse {
  return (
    typeof data === 'object' &&
    data !== null &&
    'status' in data &&
    typeof (data as HealthCheckResponse).status === 'string' &&
    'services' in data &&
    Array.isArray((data as HealthCheckResponse).services)
  );
}
