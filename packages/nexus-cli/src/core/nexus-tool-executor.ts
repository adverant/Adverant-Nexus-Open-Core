/**
 * Nexus Tool Executor
 *
 * Executes Nexus MCP tools with streaming support
 * Handles parameter validation, progress tracking, and error handling
 */

import { EventEmitter } from 'eventemitter3';
import type { MCPTool } from '../types/transport.js';
import type { NexusClient } from './nexus-client.js';

export interface ToolExecutionOptions {
  streaming?: boolean;
  timeout?: number;
  onProgress?: (progress: ToolProgress) => void;
  onError?: (error: Error) => void;
  onComplete?: (result: any) => void;
}

export interface ToolProgress {
  type: 'progress' | 'status' | 'agent' | 'file' | 'complete';
  message: string;
  progress?: number; // 0-100
  metadata?: any;
  timestamp: Date;
}

export interface ToolExecutionResult {
  success: boolean;
  data?: any;
  error?: Error;
  duration: number;
  streaming: boolean;
  metadata?: {
    toolName: string;
    streamed?: boolean;
    chunks?: number;
  };
}

export interface ValidationResult {
  valid: boolean;
  errors: ValidationError[];
}

export interface ValidationError {
  field: string;
  message: string;
  expected?: string;
  received?: any;
}

export class NexusToolExecutor extends EventEmitter {
  constructor(private nexusClient: NexusClient) {
    super();
  }

  /**
   * Execute a Nexus MCP tool
   */
  async execute(
    tool: MCPTool,
    params: any,
    options: ToolExecutionOptions = {}
  ): Promise<ToolExecutionResult> {
    const startTime = Date.now();

    try {
      // Validate parameters
      const validation = this.validateParameters(tool, params);
      if (!validation.valid) {
        throw new Error(
          `Invalid parameters: ${validation.errors.map((e) => e.message).join(', ')}`
        );
      }

      // Transform parameters to match tool schema
      const transformedParams = this.transformParameters(tool, params);

      // Check if tool supports streaming
      const isStreaming = Boolean(options.streaming && this.isStreamingTool(tool.name));

      let result: any;

      if (isStreaming) {
        result = await this.executeStreaming(tool, transformedParams, options);
      } else {
        result = await this.executeStandard(tool, transformedParams, options);
      }

      const duration = Date.now() - startTime;

      return {
        success: true,
        data: result,
        duration,
        streaming: isStreaming,
        metadata: {
          toolName: tool.name,
          streamed: isStreaming,
        },
      };
    } catch (error) {
      const duration = Date.now() - startTime;

      return {
        success: false,
        error: error as Error,
        duration,
        streaming: false,
        metadata: {
          toolName: tool.name,
        },
      };
    }
  }

  /**
   * Execute tool with standard HTTP request
   */
  private async executeStandard(
    tool: MCPTool,
    params: any,
    options: ToolExecutionOptions
  ): Promise<any> {
    this.emit('execution:start', { tool: tool.name, params });

    try {
      // Determine endpoint based on tool name
      const endpoint = this.getToolEndpoint(tool.name);

      // Execute via Nexus Client
      const result = await this.nexusClient.execute(
        endpoint,
        'post',
        params,
        {
          queueOnFailure: true,
        }
      );

      this.emit('execution:complete', { tool: tool.name, result });

      if (options.onComplete) {
        options.onComplete(result);
      }

      return result;
    } catch (error) {
      this.emit('execution:error', { tool: tool.name, error });

      if (options.onError) {
        options.onError(error as Error);
      }

      throw error;
    }
  }

  /**
   * Execute tool with streaming support
   */
  private async executeStreaming(
    tool: MCPTool,
    params: any,
    options: ToolExecutionOptions
  ): Promise<any> {
    this.emit('execution:start', { tool: tool.name, params, streaming: true });

    try {
      const endpoint = this.getToolEndpoint(tool.name);

      // For streaming, we need to handle WebSocket or SSE
      // This is a simplified implementation - in production, you'd use WebSocket
      const result = await this.nexusClient.execute(
        endpoint,
        'post',
        params,
        {
          queueOnFailure: true,
        }
      );

      // Simulate streaming progress if the tool returns a job ID
      if (result.jobId || result.validationId || result.taskId) {
        await this.pollForProgress(result, options);
      }

      this.emit('execution:complete', { tool: tool.name, result });

      if (options.onComplete) {
        options.onComplete(result);
      }

      return result;
    } catch (error) {
      this.emit('execution:error', { tool: tool.name, error });

      if (options.onError) {
        options.onError(error as Error);
      }

      throw error;
    }
  }

  /**
   * Poll for operation progress (for long-running operations)
   */
  private async pollForProgress(
    initialResult: any,
    options: ToolExecutionOptions
  ): Promise<void> {
    const jobId = initialResult.jobId || initialResult.validationId || initialResult.taskId;
    if (!jobId) return;

    const maxAttempts = 60; // 5 minutes with 5s intervals
    let attempts = 0;

    while (attempts < maxAttempts) {
      try {
        const statusEndpoint = this.getStatusEndpoint(initialResult);
        const status = await this.nexusClient.execute(statusEndpoint, 'get', undefined, {
          params: { id: jobId },
        });

        // Emit progress
        if (options.onProgress && status.progress !== undefined) {
          const progress: ToolProgress = {
            type: 'progress',
            message: status.message || `Processing... ${status.progress}%`,
            progress: status.progress,
            timestamp: new Date(),
            metadata: status,
          };

          options.onProgress(progress);
          this.emit('execution:progress', progress);
        }

        // Check if complete
        if (status.status === 'completed' || status.status === 'complete') {
          break;
        }

        // Check if failed
        if (status.status === 'failed' || status.status === 'error') {
          throw new Error(status.error || 'Operation failed');
        }

        // Wait before next poll
        await this.sleep(5000);
        attempts += 1;
      } catch (error) {
        if (attempts >= maxAttempts - 1) {
          throw error;
        }
        await this.sleep(5000);
        attempts += 1;
      }
    }
  }

  /**
   * Get API endpoint for a tool
   */
  private getToolEndpoint(toolName: string): string {
    // Map tool names to API endpoints
    const toolToEndpoint: Record<string, string> = {
      // Memory operations
      nexus_store_memory: '/nexus/memory/store',
      nexus_recall_memory: '/nexus/memory/recall',
      nexus_store_document: '/nexus/documents/store',
      nexus_retrieve: '/nexus/documents/retrieve',

      // Knowledge graph
      nexus_store_entity: '/nexus/entities/store',
      nexus_query_entities: '/nexus/entities/query',
      nexus_create_entity_relationship: '/nexus/entities/relationships',

      // Code analysis
      nexus_validate_code: '/nexus/code/validate',
      nexus_analyze_code: '/nexus/code/analyze',
      nexus_validate_command: '/nexus/command/validate',

      // Multi-agent
      nexus_orchestrate: '/nexus/agents/orchestrate',
      nexus_get_suggestions: '/nexus/agents/suggestions',

      // Learning
      nexus_trigger_learning: '/nexus/learning/trigger',
      nexus_recall_knowledge: '/nexus/learning/recall',

      // Episodes
      nexus_store_episode: '/nexus/episodes/store',
      nexus_recall_episodes: '/nexus/episodes/recall',

      // Health
      nexus_health: '/nexus/health',
      nexus_ingestion_status: '/nexus/ingestion/status',
    };

    // Check for exact match
    if (toolToEndpoint[toolName]) {
      return toolToEndpoint[toolName];
    }

    // Try without prefix
    const withoutPrefix = toolName.replace(/^(mcp__MCP_DOCKER__|nexus_)/, '');
    if (toolToEndpoint[`nexus_${withoutPrefix}`]) {
      return toolToEndpoint[`nexus_${withoutPrefix}`];
    }

    // Default fallback
    return `/nexus/${withoutPrefix.replace(/_/g, '/')}`;
  }

  /**
   * Get status endpoint for polling
   */
  private getStatusEndpoint(initialResult: any): string {
    if (initialResult.jobId) {
      return '/nexus/ingestion/status';
    }
    if (initialResult.validationId) {
      return '/nexus/code/validation-status';
    }
    if (initialResult.taskId) {
      return '/nexus/agents/status';
    }
    return '/nexus/status';
  }

  /**
   * Check if tool supports streaming
   */
  private isStreamingTool(toolName: string): boolean {
    const streamingTools = [
      'orchestrate',
      'ingest',
      'validate_code',
      'analyze_code',
      'process',
      'batch',
    ];

    return streamingTools.some((keyword) => toolName.toLowerCase().includes(keyword));
  }

  /**
   * Validate parameters against tool schema
   */
  private validateParameters(tool: MCPTool, params: any): ValidationResult {
    const errors: ValidationError[] = [];

    if (!tool.inputSchema || !tool.inputSchema.properties) {
      return { valid: true, errors: [] };
    }

    const schema = tool.inputSchema;
    const required = schema.required || [];

    // Check required parameters
    for (const field of required) {
      if (params[field] === undefined || params[field] === null) {
        errors.push({
          field,
          message: `Required parameter '${field}' is missing`,
          expected: 'non-null value',
          received: params[field],
        });
      }
    }

    // Validate parameter types
    for (const [field, value] of Object.entries(params)) {
      if (value === undefined || value === null) continue;

      const fieldSchema = schema.properties[field];
      if (!fieldSchema) continue;

      const typeError = this.validateType(field, value, fieldSchema);
      if (typeError) {
        errors.push(typeError);
      }
    }

    return {
      valid: errors.length === 0,
      errors,
    };
  }

  /**
   * Validate a single parameter type
   */
  private validateType(field: string, value: any, schema: any): ValidationError | null {
    const expectedType = schema.type;
    const actualType = Array.isArray(value) ? 'array' : typeof value;

    switch (expectedType) {
      case 'string':
        if (typeof value !== 'string') {
          return {
            field,
            message: `Parameter '${field}' must be a string`,
            expected: 'string',
            received: actualType,
          };
        }
        break;

      case 'number':
      case 'integer':
        if (typeof value !== 'number') {
          return {
            field,
            message: `Parameter '${field}' must be a number`,
            expected: 'number',
            received: actualType,
          };
        }
        break;

      case 'boolean':
        if (typeof value !== 'boolean') {
          return {
            field,
            message: `Parameter '${field}' must be a boolean`,
            expected: 'boolean',
            received: actualType,
          };
        }
        break;

      case 'array':
        if (!Array.isArray(value)) {
          return {
            field,
            message: `Parameter '${field}' must be an array`,
            expected: 'array',
            received: actualType,
          };
        }
        break;

      case 'object':
        if (typeof value !== 'object' || Array.isArray(value)) {
          return {
            field,
            message: `Parameter '${field}' must be an object`,
            expected: 'object',
            received: actualType,
          };
        }
        break;
    }

    // Check enum constraints
    if (schema.enum && !schema.enum.includes(value)) {
      return {
        field,
        message: `Parameter '${field}' must be one of: ${schema.enum.join(', ')}`,
        expected: schema.enum.join(', '),
        received: value,
      };
    }

    return null;
  }

  /**
   * Transform CLI parameters to match tool schema
   */
  private transformParameters(tool: MCPTool, params: any): any {
    const transformed: any = {};

    for (const [key, value] of Object.entries(params)) {
      // Skip undefined values
      if (value === undefined) continue;

      // Convert kebab-case to snake_case
      const toolKey = key.replace(/-/g, '_');

      // Parse arrays from comma-separated strings
      if (typeof value === 'string' && value.includes(',')) {
        transformed[toolKey] = value.split(',').map((v) => v.trim());
      } else {
        transformed[toolKey] = value;
      }
    }

    return transformed;
  }

  /**
   * Sleep utility
   */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Close and cleanup
   */
  close(): void {
    this.removeAllListeners();
  }
}

/**
 * Create a Nexus tool executor instance
 */
export function createNexusToolExecutor(nexusClient: NexusClient): NexusToolExecutor {
  return new NexusToolExecutor(nexusClient);
}
