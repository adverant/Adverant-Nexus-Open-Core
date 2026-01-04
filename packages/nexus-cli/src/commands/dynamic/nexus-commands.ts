/**
 * Nexus Command Generator
 *
 * Dynamically generates CLI commands from Nexus MCP tools
 * Exposes all 70+ Nexus tools as CLI commands
 */

import ora from 'ora';
import chalk from 'chalk';
import type { Command, CommandArgs, CommandContext, CommandResult } from '../../types/command.js';
import type { MCPTool } from '../../types/transport.js';
import { NexusClient, createNexusClient } from '../../core/nexus-client.js';
import { NexusToolExecutor, createNexusToolExecutor } from '../../core/nexus-tool-executor.js';
import { MCPToolMapper, createMCPToolMapper } from './mcp-tool-mapper.js';

export interface NexusCommandGeneratorConfig {
  mcpServerUrl?: string;
  nexusApiUrl?: string;
  autoDiscover?: boolean;
}

export class NexusCommandGenerator {
  private nexusClient: NexusClient;
  private toolExecutor: NexusToolExecutor;
  private toolMapper: MCPToolMapper;
  private commands: Command[] = [];
  private tools: MCPTool[] = [];

  constructor(private config: NexusCommandGeneratorConfig = {}) {
    // Initialize clients
    this.nexusClient = createNexusClient({
      baseUrl: config.nexusApiUrl || 'http://localhost:9092',
    });

    this.toolExecutor = createNexusToolExecutor(this.nexusClient);
    this.toolMapper = createMCPToolMapper();

    // Setup event listeners
    this.setupEventListeners();
  }

  /**
   * Setup event listeners for client events
   */
  private setupEventListeners(): void {
    // Health events
    this.nexusClient.on('health:degraded', () => {
      console.warn(chalk.yellow('⚠️  Nexus system unavailable - operations will be queued'));
    });

    this.nexusClient.on('health:recovered', () => {
      console.log(chalk.green('✅ Nexus system recovered - processing queued operations'));
    });

    // Queue events
    this.nexusClient.on('operation:queued', (op) => {
      console.log(chalk.yellow(`📋 Operation queued: ${op.operation}`));
    });
  }

  /**
   * Discover and generate commands from Nexus MCP tools
   */
  async discover(): Promise<Command[]> {
    const spinner = ora('Discovering Nexus MCP tools...').start();

    try {
      // Check Nexus health first
      const health = await this.nexusClient.checkHealth(true);

      if (!health.graphrag.healthy) {
        spinner.warn('Nexus system unavailable - commands will use fallback mode');
      } else {
        spinner.succeed(`Nexus system healthy (latency: ${health.graphrag.latency}ms)`);
      }

      // Fetch MCP tools from Nexus API
      this.tools = await this.fetchMCPTools();

      spinner.text = `Generating commands from ${this.tools.length} tools...`;

      // Generate commands from tools
      this.commands = this.generateCommands(this.tools);

      spinner.succeed(`Generated ${this.commands.length} Nexus commands across ${this.toolMapper.getCategories().length} categories`);

      return this.commands;
    } catch (error) {
      spinner.fail('Failed to discover Nexus tools');
      console.error(chalk.red('Error:'), error);

      // Return empty array but don't fail - allow CLI to continue
      return [];
    }
  }

  /**
   * Fetch MCP tools from Nexus API
   */
  private async fetchMCPTools(): Promise<MCPTool[]> {
    try {
      const response = await this.nexusClient.execute<{ tools: MCPTool[] }>(
        '/mcp/tools',
        'get'
      );

      return response.tools || [];
    } catch (error) {
      // Fallback: return predefined tool list
      return this.getDefaultTools();
    }
  }

  /**
   * Get default Nexus tools (fallback when API unavailable)
   */
  private getDefaultTools(): MCPTool[] {
    return [
      // Memory operations
      {
        name: 'nexus_store_memory',
        description: 'Store memory with content and tags',
        inputSchema: {
          type: 'object',
          properties: {
            content: { type: 'string', description: 'Memory content' },
            tags: { type: 'array', description: 'Tags for categorization' },
            metadata: { type: 'object', description: 'Additional metadata' },
          },
          required: ['content'],
        },
      },
      {
        name: 'nexus_recall_memory',
        description: 'Recall memories by query',
        inputSchema: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Search query' },
            limit: { type: 'number', description: 'Max results', default: 10 },
            score_threshold: { type: 'number', description: 'Minimum similarity score' },
          },
          required: ['query'],
        },
      },

      // Document operations
      {
        name: 'nexus_store_document',
        description: 'Store document in Nexus',
        inputSchema: {
          type: 'object',
          properties: {
            content: { type: 'string', description: 'Document content or file path' },
            title: { type: 'string', description: 'Document title' },
            type: {
              type: 'string',
              description: 'Document type',
              enum: ['code', 'markdown', 'text', 'structured', 'multimodal'],
            },
            tags: { type: 'array', description: 'Tags' },
          },
          required: ['content'],
        },
      },
      {
        name: 'nexus_retrieve',
        description: 'Retrieve documents by query',
        inputSchema: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Search query' },
            strategy: {
              type: 'string',
              description: 'Retrieval strategy',
              enum: ['semantic_chunks', 'graph_traversal', 'hybrid', 'adaptive'],
              default: 'semantic_chunks',
            },
            limit: { type: 'number', description: 'Max results', default: 10 },
            rerank: { type: 'boolean', description: 'Use reranking', default: false },
          },
          required: ['query'],
        },
      },

      // Knowledge graph
      {
        name: 'nexus_store_entity',
        description: 'Store entity in knowledge graph',
        inputSchema: {
          type: 'object',
          properties: {
            domain: { type: 'string', description: 'Entity domain' },
            entityType: { type: 'string', description: 'Entity type' },
            textContent: { type: 'string', description: 'Entity content' },
            tags: { type: 'array', description: 'Tags' },
          },
          required: ['domain', 'entityType', 'textContent'],
        },
      },
      {
        name: 'nexus_query_entities',
        description: 'Query entities from knowledge graph',
        inputSchema: {
          type: 'object',
          properties: {
            domain: { type: 'string', description: 'Entity domain' },
            entityType: { type: 'string', description: 'Entity type' },
            searchText: { type: 'string', description: 'Search text' },
            limit: { type: 'number', description: 'Max results', default: 20 },
          },
          required: ['domain'],
        },
      },

      // Code analysis
      {
        name: 'nexus_validate_code',
        description: 'Validate code with multi-model consensus',
        inputSchema: {
          type: 'object',
          properties: {
            code: { type: 'string', description: 'Code to validate' },
            language: { type: 'string', description: 'Programming language' },
            context: { type: 'string', description: 'Context description' },
            riskLevel: {
              type: 'string',
              description: 'Risk level',
              enum: ['low', 'medium', 'high', 'critical'],
              default: 'medium',
            },
          },
          required: ['code', 'language'],
        },
      },
      {
        name: 'nexus_analyze_code',
        description: 'Analyze code for issues and improvements',
        inputSchema: {
          type: 'object',
          properties: {
            code: { type: 'string', description: 'Code to analyze' },
            language: { type: 'string', description: 'Programming language' },
            depth: {
              type: 'string',
              description: 'Analysis depth',
              enum: ['quick', 'standard', 'deep'],
              default: 'standard',
            },
            focusAreas: { type: 'array', description: 'Areas to focus on' },
          },
          required: ['code', 'language'],
        },
      },

      // Multi-agent
      {
        name: 'nexus_orchestrate',
        description: 'Orchestrate multiple AI agents for complex tasks',
        inputSchema: {
          type: 'object',
          properties: {
            task: { type: 'string', description: 'Task description' },
            maxAgents: { type: 'number', description: 'Max agents to spawn' },
            timeout: { type: 'number', description: 'Timeout in ms', default: 60000 },
          },
          required: ['task'],
        },
      },

      // Learning
      {
        name: 'nexus_trigger_learning',
        description: 'Trigger progressive learning on a topic',
        inputSchema: {
          type: 'object',
          properties: {
            topic: { type: 'string', description: 'Learning topic' },
            priority: { type: 'number', description: 'Priority (1-10)' },
          },
          required: ['topic', 'priority'],
        },
      },
      {
        name: 'nexus_recall_knowledge',
        description: 'Recall learned knowledge',
        inputSchema: {
          type: 'object',
          properties: {
            topic: { type: 'string', description: 'Knowledge topic' },
            layer: {
              type: 'string',
              description: 'Knowledge layer',
              enum: ['OVERVIEW', 'PROCEDURES', 'TECHNIQUES', 'EXPERT', 'all'],
            },
            max_results: { type: 'number', description: 'Max results', default: 10 },
          },
          required: ['topic'],
        },
      },

      // Episodes
      {
        name: 'nexus_store_episode',
        description: 'Store episodic memory',
        inputSchema: {
          type: 'object',
          properties: {
            content: { type: 'string', description: 'Episode content' },
            type: {
              type: 'string',
              description: 'Episode type',
              enum: ['user_query', 'system_response', 'event', 'observation', 'insight'],
            },
            metadata: { type: 'object', description: 'Metadata' },
          },
          required: ['content', 'type'],
        },
      },
      {
        name: 'nexus_recall_episodes',
        description: 'Recall episodic memories',
        inputSchema: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Search query' },
            limit: { type: 'number', description: 'Max results', default: 10 },
            include_decay: { type: 'boolean', description: 'Include temporal decay' },
          },
          required: ['query'],
        },
      },

      // Health
      {
        name: 'nexus_health',
        description: 'Check Nexus system health',
        inputSchema: {
          type: 'object',
          properties: {
            detailed: { type: 'boolean', description: 'Detailed health info', default: false },
          },
        },
      },
    ];
  }

  /**
   * Generate commands from MCP tools
   */
  private generateCommands(tools: MCPTool[]): Command[] {
    const commands: Command[] = [];

    for (const tool of tools) {
      const handler = this.createCommandHandler(tool);
      const mapping = this.toolMapper.mapTool(tool, handler);
      commands.push(mapping.command);
    }

    return commands;
  }

  /**
   * Create command handler for a tool
   */
  private createCommandHandler(tool: MCPTool) {
    return async (args: CommandArgs, context: CommandContext): Promise<CommandResult> => {
      const spinner = ora(`Executing ${tool.name}...`).start();

      try {
        // Execute tool
        const result = await this.toolExecutor.execute(
          tool,
          args,
          {
            streaming: context.outputFormat === 'stream-json',
            onProgress: (progress) => {
              spinner.text = progress.message;
            },
            onError: (error) => {
              spinner.fail(error.message);
            },
          }
        );

        if (result.success) {
          spinner.succeed(`Completed in ${result.duration}ms`);

          return {
            success: true,
            data: result.data,
            metadata: {
              duration: result.duration,
              streaming: result.streaming,
            },
          };
        } else {
          spinner.fail('Execution failed');

          return {
            success: false,
            error: result.error,
            metadata: {
              duration: result.duration,
            },
          };
        }
      } catch (error) {
        spinner.fail('Execution error');

        return {
          success: false,
          error: error as Error,
        };
      }
    };
  }

  /**
   * Get all generated commands
   */
  getCommands(): Command[] {
    return this.commands;
  }

  /**
   * Get commands by category
   */
  getCommandsByCategory(category: string): Command[] {
    const mappings = this.toolMapper.getToolsByCategory(category);
    return mappings.map((m) => m.command);
  }

  /**
   * Get all categories
   */
  getCategories(): string[] {
    return this.toolMapper.getCategories();
  }

  /**
   * Refresh commands (re-discover tools)
   */
  async refresh(): Promise<Command[]> {
    this.toolMapper.clear();
    return this.discover();
  }

  /**
   * Start health monitoring
   */
  startHealthMonitoring(): void {
    this.nexusClient.startHealthChecks();
  }

  /**
   * Stop health monitoring
   */
  stopHealthMonitoring(): void {
    this.nexusClient.stopHealthChecks();
  }

  /**
   * Close and cleanup
   */
  close(): void {
    this.nexusClient.close();
    this.toolExecutor.close();
  }
}

/**
 * Create Nexus command generator instance
 */
export function createNexusCommandGenerator(
  config?: NexusCommandGeneratorConfig
): NexusCommandGenerator {
  return new NexusCommandGenerator(config);
}
