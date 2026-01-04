/**
 * Service Type Definitions
 *
 * Types for service discovery, metadata, and interactions
 */

export interface ServiceMetadata {
  name: string;
  displayName: string;
  description: string;
  version?: string;
  status: ServiceStatus;

  // Network configuration
  container: string;
  ports: PortMapping[];
  healthEndpoint?: string;

  // API configuration
  apiUrl: string;
  wsUrl?: string;
  openApiSpec?: string;
  graphqlSchema?: string;

  // Service capabilities
  capabilities: ServiceCapability[];
  dependencies: string[];

  // Environment
  environment: Record<string, string>;
}

export enum ServiceStatus {
  RUNNING = 'running',
  STOPPED = 'stopped',
  STARTING = 'starting',
  STOPPING = 'stopping',
  UNHEALTHY = 'unhealthy',
  UNKNOWN = 'unknown',
}

export interface PortMapping {
  host: number;
  container: number;
  protocol?: 'tcp' | 'udp';
}

export interface ServiceCapability {
  name: string;
  type: 'rest' | 'websocket' | 'graphql' | 'grpc' | 'mcp';
  endpoint: string;
  methods?: string[];
}

export interface ServiceHealth {
  healthy: boolean;
  status: ServiceStatus;
  latency?: number;
  lastCheck: Date;
  message?: string;
  details?: Record<string, any>;
}

export interface ServiceCommand {
  name: string;
  namespace: string;
  description: string;
  endpoint: string;
  method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';
  params: CommandParameter[];
  streaming: boolean;
  examples: string[];
}

export interface CommandParameter {
  name: string;
  type: 'string' | 'number' | 'boolean' | 'array' | 'object' | 'file';
  required: boolean;
  description: string;
  default?: any;
  enum?: any[];
  format?: string;
}

export interface DockerComposeService {
  image?: string;
  build?: {
    context: string;
    dockerfile: string;
  };
  container_name?: string;
  ports?: string[];
  environment?: Record<string, string> | string[];
  volumes?: string[];
  networks?: string[];
  depends_on?: string[] | Record<string, any>;
  healthcheck?: {
    test: string | string[];
    interval?: string;
    timeout?: string;
    retries?: number;
  };
}

export interface DockerComposeConfig {
  version: string;
  services: Record<string, DockerComposeService>;
  networks?: Record<string, any>;
  volumes?: Record<string, any>;
}
