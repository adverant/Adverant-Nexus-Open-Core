/**
 * MCP Transport Client
 *
 * Client for Model Context Protocol communication
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type {
  MCPTransport,
  MCPConfig,
  MCPTool,
  TransportError,
} from '../../types/transport.js';

export class MCPClient implements MCPTransport {
  private client: Client | null = null;
  private transport: StdioClientTransport | null = null;
  private connected: boolean = false;
  private config: MCPConfig | null = null;

  /**
   * Connect to MCP server
   */
  async connect(config: MCPConfig): Promise<void> {
    this.config = config;

    try {
      // Create stdio transport
      this.transport = new StdioClientTransport({
        command: config.command,
        args: config.args,
        env: config.env,
      });

      // Create client
      this.client = new Client(
        {
          name: 'adverant-nexus-cli',
          version: '2.0.0',
        },
        {
          capabilities: {
            tools: {},
            prompts: {},
            resources: {},
          },
        }
      );

      // Connect with timeout
      const connectPromise = this.client.connect(this.transport);

      if (config.timeout) {
        await this.withTimeout(connectPromise, config.timeout, 'MCP connection timeout');
      } else {
        await connectPromise;
      }

      this.connected = true;
    } catch (error) {
      this.cleanup();
      throw this.createError(
        'MCP_CONNECTION_ERROR',
        `Failed to connect to MCP server: ${(error as Error).message}`
      );
    }
  }

  /**
   * Disconnect from MCP server
   */
  async disconnect(): Promise<void> {
    this.cleanup();
  }

  /**
   * Call MCP method
   */
  async call<T = any>(method: string, params?: any): Promise<T> {
    if (!this.client || !this.connected) {
      throw this.createError('MCP_NOT_CONNECTED', 'MCP client not connected');
    }

    try {
      const result = await this.client.request(
        {
          method,
          params: params ?? {},
        },
        Object as any // Result class - using Object as a placeholder
      );

      return result as T;
    } catch (error) {
      throw this.createError(
        'MCP_CALL_ERROR',
        `MCP method call failed: ${(error as Error).message}`,
        { method, params }
      );
    }
  }

  /**
   * List available tools
   */
  async listTools(): Promise<MCPTool[]> {
    if (!this.client || !this.connected) {
      throw this.createError('MCP_NOT_CONNECTED', 'MCP client not connected');
    }

    try {
      const response = await this.client.listTools();

      return response.tools.map((tool: any) => ({
        name: tool.name,
        description: tool.description || '',
        inputSchema: tool.inputSchema,
        outputSchema: tool.outputSchema,
      }));
    } catch (error) {
      throw this.createError(
        'MCP_LIST_TOOLS_ERROR',
        `Failed to list MCP tools: ${(error as Error).message}`
      );
    }
  }

  /**
   * Execute MCP tool
   */
  async executeTool<T = any>(name: string, args?: any): Promise<T> {
    if (!this.client || !this.connected) {
      throw this.createError('MCP_NOT_CONNECTED', 'MCP client not connected');
    }

    try {
      const result = await this.client.callTool(
        {
          name,
          arguments: args ?? {},
        }
      );

      // Extract content from MCP response
      if (result && typeof result === 'object' && 'content' in result) {
        return (result as any).content as T;
      }

      return result as T;
    } catch (error) {
      throw this.createError(
        'MCP_TOOL_ERROR',
        `MCP tool execution failed: ${(error as Error).message}`,
        { tool: name, args }
      );
    }
  }

  /**
   * Check if client is connected
   */
  isConnected(): boolean {
    return this.connected && this.client !== null;
  }

  /**
   * Get list of available prompts
   */
  async listPrompts(): Promise<any[]> {
    if (!this.client || !this.connected) {
      throw this.createError('MCP_NOT_CONNECTED', 'MCP client not connected');
    }

    try {
      const response = await this.client.listPrompts();
      return response.prompts || [];
    } catch (error) {
      throw this.createError(
        'MCP_LIST_PROMPTS_ERROR',
        `Failed to list MCP prompts: ${(error as Error).message}`
      );
    }
  }

  /**
   * Get prompt
   */
  async getPrompt(name: string, args?: any): Promise<any> {
    if (!this.client || !this.connected) {
      throw this.createError('MCP_NOT_CONNECTED', 'MCP client not connected');
    }

    try {
      const result = await this.client.getPrompt(
        {
          name,
          arguments: args ?? {},
        }
      );

      return result;
    } catch (error) {
      throw this.createError(
        'MCP_GET_PROMPT_ERROR',
        `Failed to get MCP prompt: ${(error as Error).message}`,
        { prompt: name, args }
      );
    }
  }

  /**
   * List available resources
   */
  async listResources(): Promise<any[]> {
    if (!this.client || !this.connected) {
      throw this.createError('MCP_NOT_CONNECTED', 'MCP client not connected');
    }

    try {
      const response = await this.client.listResources();
      return response.resources || [];
    } catch (error) {
      throw this.createError(
        'MCP_LIST_RESOURCES_ERROR',
        `Failed to list MCP resources: ${(error as Error).message}`
      );
    }
  }

  /**
   * Read resource
   */
  async readResource(uri: string): Promise<any> {
    if (!this.client || !this.connected) {
      throw this.createError('MCP_NOT_CONNECTED', 'MCP client not connected');
    }

    try {
      const result = await this.client.readResource(
        { uri }
      );

      return result;
    } catch (error) {
      throw this.createError(
        'MCP_READ_RESOURCE_ERROR',
        `Failed to read MCP resource: ${(error as Error).message}`,
        { uri }
      );
    }
  }

  /**
   * Cleanup resources
   */
  private cleanup(): void {
    this.connected = false;

    if (this.client) {
      try {
        this.client.close();
      } catch (error) {
        // Ignore cleanup errors
      }
      this.client = null;
    }

    if (this.transport) {
      try {
        this.transport.close();
      } catch (error) {
        // Ignore cleanup errors
      }
      this.transport = null;
    }
  }

  /**
   * Execute promise with timeout
   */
  private async withTimeout<T>(
    promise: Promise<T>,
    timeoutMs: number,
    errorMessage: string
  ): Promise<T> {
    return Promise.race([
      promise,
      new Promise<T>((_, reject) =>
        setTimeout(() => reject(this.createError('MCP_TIMEOUT', errorMessage)), timeoutMs)
      ),
    ]);
  }

  /**
   * Create transport error
   */
  private createError(code: string, message: string, details?: any): TransportError {
    const error = new Error(message) as TransportError;
    error.name = 'MCPError';
    error.code = code;
    error.details = details;
    error.retryable = code === 'MCP_TIMEOUT' || code === 'MCP_CONNECTION_ERROR';
    return error;
  }

  /**
   * Get MCP server info
   */
  async getServerInfo(): Promise<any> {
    if (!this.client || !this.connected) {
      throw this.createError('MCP_NOT_CONNECTED', 'MCP client not connected');
    }

    try {
      // MCP servers expose their info during connection
      // Return cached config and connection state
      return {
        command: this.config?.command,
        args: this.config?.args,
        connected: this.connected,
      };
    } catch (error) {
      throw this.createError(
        'MCP_SERVER_INFO_ERROR',
        `Failed to get MCP server info: ${(error as Error).message}`
      );
    }
  }
}
