/**
 * Nexus Plugin System Types
 *
 * Defines the plugin interface and discovery system for Adverant Nexus Open Core.
 * Plugins can extend GraphRAG, MageAgent, and API capabilities.
 */

/**
 * Plugin metadata - identifies the plugin and its compatibility
 */
export interface PluginMetadata {
  /** Unique plugin name (must match package.json name) */
  name: string;

  /** Semantic version */
  version: string;

  /** Nexus API version compatibility (e.g., "1.0", "1.x") */
  apiVersion: string;

  /** Human-readable description */
  description: string;

  /** Plugin author */
  author: string;

  /** License (e.g., "Apache-2.0", "MIT") */
  license: string;

  /** Repository URL */
  repository?: string;

  /** Keywords for discovery */
  keywords?: string[];

  /** Homepage URL */
  homepage?: string;
}

/**
 * Plugin lifecycle hooks
 */
export interface PluginHooks {
  /** Called when plugin is loaded (before onStart) */
  onLoad?: () => Promise<void> | void;

  /** Called when Nexus starts */
  onStart?: () => Promise<void> | void;

  /** Called when Nexus stops */
  onStop?: () => Promise<void> | void;

  /** Called on configuration change */
  onConfigChange?: (config: PluginConfig) => Promise<void> | void;
}

/**
 * Plugin configuration
 */
export interface PluginConfig {
  /** Whether plugin is enabled */
  enabled: boolean;

  /** Plugin-specific configuration */
  options?: Record<string, any>;
}

/**
 * Document processor for GraphRAG
 */
export interface DocumentProcessor {
  /** Processor name */
  name: string;

  /** Supported MIME types */
  mimeTypes: string[];

  /** Process document and extract text/metadata */
  process: (document: Document) => Promise<ProcessedDocument>;
}

/**
 * Input document
 */
export interface Document {
  /** Document ID */
  id: string;

  /** Document content (Buffer for binary, string for text) */
  content: Buffer | string;

  /** MIME type */
  mimeType: string;

  /** Original filename */
  filename?: string;

  /** Additional metadata */
  metadata?: Record<string, any>;
}

/**
 * Processed document output
 */
export interface ProcessedDocument {
  /** Extracted text content */
  text: string;

  /** Document chunks for embedding */
  chunks: DocumentChunk[];

  /** Extracted entities */
  entities?: Entity[];

  /** Extracted metadata */
  metadata: Record<string, any>;
}

/**
 * Document chunk
 */
export interface DocumentChunk {
  /** Chunk ID */
  id: string;

  /** Chunk text */
  text: string;

  /** Chunk metadata */
  metadata: {
    /** Page number (if applicable) */
    page?: number;

    /** Position in document */
    position: number;

    /** Character count */
    length: number;

    /** Additional metadata */
    [key: string]: any;
  };
}

/**
 * Extracted entity
 */
export interface Entity {
  /** Entity name */
  name: string;

  /** Entity type */
  type: string;

  /** Confidence score (0-1) */
  confidence?: number;

  /** Entity metadata */
  metadata?: Record<string, any>;
}

/**
 * Custom retriever for GraphRAG
 */
export interface Retriever {
  /** Retriever name */
  name: string;

  /** Retrieve relevant documents */
  retrieve: (query: RetrievalQuery) => Promise<RetrievalResult[]>;
}

/**
 * Retrieval query
 */
export interface RetrievalQuery {
  /** Query text */
  query: string;

  /** Maximum results */
  limit?: number;

  /** Minimum similarity score */
  minScore?: number;

  /** Filters */
  filters?: Record<string, any>;
}

/**
 * Retrieval result
 */
export interface RetrievalResult {
  /** Document ID */
  id: string;

  /** Document content */
  content: string;

  /** Similarity score */
  score: number;

  /** Document metadata */
  metadata?: Record<string, any>;
}

/**
 * Custom agent for MageAgent
 */
export interface Agent {
  /** Agent name */
  name: string;

  /** Agent description */
  description: string;

  /** Agent capabilities */
  capabilities?: string[];

  /** Execute agent task */
  execute: (task: AgentTask) => Promise<AgentResult>;
}

/**
 * Agent task
 */
export interface AgentTask {
  /** Task ID */
  id: string;

  /** Task instruction */
  instruction: string;

  /** Task context */
  context?: Record<string, any>;

  /** Available tools */
  tools?: Tool[];
}

/**
 * Agent execution result
 */
export interface AgentResult {
  /** Task ID */
  taskId: string;

  /** Result status */
  status: 'success' | 'failure' | 'partial';

  /** Result output */
  output: string;

  /** Execution metadata */
  metadata?: {
    /** Token usage */
    tokens?: number;

    /** Execution time (ms) */
    duration?: number;

    /** Model used */
    model?: string;

    /** Additional metadata */
    [key: string]: any;
  };

  /** Error (if status is failure) */
  error?: string;
}

/**
 * Custom tool for MageAgent
 */
export interface Tool {
  /** Tool name */
  name: string;

  /** Tool description */
  description: string;

  /** Tool parameters (JSON Schema) */
  parameters: {
    type: 'object';
    properties: Record<string, any>;
    required?: string[];
  };

  /** Execute tool */
  execute: (params: Record<string, any>) => Promise<any>;
}

/**
 * Custom API route
 */
export interface Route {
  /** HTTP method */
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

  /** Route path */
  path: string;

  /** Route handler */
  handler: (req: RouteRequest, res: RouteResponse) => Promise<void> | void;

  /** Middleware */
  middleware?: Middleware[];
}

/**
 * Route request
 */
export interface RouteRequest {
  /** Request method */
  method: string;

  /** Request path */
  path: string;

  /** URL parameters */
  params: Record<string, string>;

  /** Query parameters */
  query: Record<string, string>;

  /** Request body */
  body: any;

  /** Request headers */
  headers: Record<string, string>;

  /** Authenticated user (if any) */
  user?: any;
}

/**
 * Route response
 */
export interface RouteResponse {
  /** Set response status */
  status: (code: number) => RouteResponse;

  /** Send JSON response */
  json: (data: any) => void;

  /** Send text response */
  send: (data: string) => void;

  /** Set response header */
  setHeader: (name: string, value: string) => RouteResponse;
}

/**
 * API middleware
 */
export interface Middleware {
  /** Middleware name */
  name: string;

  /** Middleware handler */
  handler: (req: RouteRequest, res: RouteResponse, next: () => void) => Promise<void> | void;
}

/**
 * Plugin capabilities
 */
export interface PluginCapabilities {
  /** GraphRAG extensions */
  graphrag?: {
    /** Custom document processors */
    processors?: DocumentProcessor[];

    /** Custom retrievers */
    retrievers?: Retriever[];
  };

  /** MageAgent extensions */
  mageagent?: {
    /** Custom agents */
    agents?: Agent[];

    /** Custom tools */
    tools?: Tool[];
  };

  /** API extensions */
  api?: {
    /** Custom routes */
    routes?: Route[];

    /** Middleware */
    middleware?: Middleware[];
  };
}

/**
 * Complete plugin interface
 */
export interface NexusPlugin {
  /** Plugin metadata */
  metadata: PluginMetadata;

  /** Plugin lifecycle hooks */
  hooks: PluginHooks;

  /** Plugin capabilities (optional) */
  capabilities?: PluginCapabilities;

  /** Plugin configuration (optional) */
  config?: PluginConfig;
}

/**
 * Plugin discovery system
 */
export interface PluginDiscovery {
  /** Scan for installed plugins */
  discover(): Promise<PluginMetadata[]>;

  /** Load plugin by name */
  load(name: string): Promise<NexusPlugin>;

  /** Get all loaded plugins */
  getLoaded(): NexusPlugin[];

  /** Unload plugin by name */
  unload(name: string): Promise<void>;

  /** Reload plugin by name */
  reload(name: string): Promise<NexusPlugin>;
}

/**
 * Plugin loader options
 */
export interface PluginLoaderOptions {
  /** Auto-load plugins on discovery */
  autoLoad?: boolean;

  /** Plugin search paths */
  searchPaths?: string[];

  /** Plugin name pattern (regex) */
  pattern?: RegExp;

  /** Nexus API version for compatibility check */
  apiVersion: string;
}

/**
 * Plugin validation error
 */
export class PluginValidationError extends Error {
  constructor(
    message: string,
    public readonly pluginName: string,
    public readonly validationErrors: string[]
  ) {
    super(message);
    this.name = 'PluginValidationError';
  }
}

/**
 * Plugin compatibility error
 */
export class PluginCompatibilityError extends Error {
  constructor(
    message: string,
    public readonly pluginName: string,
    public readonly requiredApiVersion: string,
    public readonly actualApiVersion: string
  ) {
    super(message);
    this.name = 'PluginCompatibilityError';
  }
}
