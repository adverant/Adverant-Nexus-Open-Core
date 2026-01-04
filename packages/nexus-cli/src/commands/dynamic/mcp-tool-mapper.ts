/**
 * MCP Tool Mapper
 *
 * Maps MCP tool definitions to CLI commands
 * Parses tool schemas and generates command structures
 */

import type { Command, ArgumentDefinition, OptionDefinition } from '../../types/command.js';
import type { MCPTool } from '../../types/transport.js';

export interface MCPToolMapping {
  tool: MCPTool;
  command: Command;
  cliName: string;
  category: string;
}

export interface MCPToolParameter {
  name: string;
  type: string;
  description?: string;
  required?: boolean;
  default?: any;
  enum?: any[];
  properties?: Record<string, MCPToolParameter>;
  items?: MCPToolParameter;
}

export class MCPToolMapper {
  private toolMappings: Map<string, MCPToolMapping> = new Map();
  private categoryMap: Map<string, string[]> = new Map();

  /**
   * Map MCP tool to CLI command
   */
  mapTool(tool: MCPTool, handler: any): MCPToolMapping {
    const cliName = this.convertToCliName(tool.name);
    const category = this.inferCategory(tool.name);

    const command: Command = {
      name: cliName,
      namespace: 'nexus',
      description: tool.description || `Execute ${tool.name}`,
      handler,
      category,
      streaming: this.isStreamingTool(tool.name),
    };

    // Parse input schema and generate arguments/options
    const { args, options } = this.parseInputSchema(tool.inputSchema);
    command.args = args;
    command.options = options;

    // Generate usage examples
    command.examples = this.generateExamples(cliName, tool);
    command.usage = this.generateUsage(cliName, args, options);

    const mapping: MCPToolMapping = {
      tool,
      command,
      cliName,
      category,
    };

    this.toolMappings.set(tool.name, mapping);
    this.addToCategory(category, tool.name);

    return mapping;
  }

  /**
   * Map multiple tools at once
   */
  mapTools(tools: MCPTool[], handler: any): MCPToolMapping[] {
    return tools.map((tool) => this.mapTool(tool, handler));
  }

  /**
   * Convert MCP tool name to CLI-friendly name
   * Examples:
   *   nexus_store_memory -> store-memory
   *   nexus_recall_episodes -> recall-episodes
   *   mcp__MCP_DOCKER__nexus_health -> health
   */
  private convertToCliName(toolName: string): string {
    // Remove common prefixes
    let name = toolName
      .replace(/^mcp__MCP_DOCKER__nexus_/, '')
      .replace(/^nexus_/, '')
      .replace(/^mcp_/, '');

    // Convert snake_case to kebab-case
    name = name.replace(/_/g, '-');

    return name;
  }

  /**
   * Infer category from tool name
   */
  private inferCategory(toolName: string): string {
    const name = toolName.toLowerCase();

    // Memory operations
    if (name.includes('memory') || name.includes('recall') || name.includes('store')) {
      return 'memory';
    }

    // Knowledge graph
    if (
      name.includes('entity') ||
      name.includes('entities') ||
      name.includes('relationship') ||
      name.includes('graph')
    ) {
      return 'knowledge-graph';
    }

    // Code analysis
    if (
      name.includes('code') ||
      name.includes('validate') ||
      name.includes('analyze') ||
      name.includes('command')
    ) {
      return 'code-analysis';
    }

    // Multi-agent
    if (
      name.includes('orchestrate') ||
      name.includes('agent') ||
      name.includes('collaborate') ||
      name.includes('suggestion')
    ) {
      return 'multi-agent';
    }

    // Learning
    if (name.includes('learn') || name.includes('knowledge') || name.includes('layer')) {
      return 'learning';
    }

    // Episodes
    if (name.includes('episode')) {
      return 'episodes';
    }

    // Health and status
    if (name.includes('health') || name.includes('status') || name.includes('ingestion')) {
      return 'health';
    }

    // Document operations
    if (name.includes('document') || name.includes('retrieve') || name.includes('ingest')) {
      return 'documents';
    }

    return 'general';
  }

  /**
   * Check if a tool supports streaming
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
   * Parse JSON Schema input schema to CLI arguments and options
   */
  private parseInputSchema(schema: any): {
    args: ArgumentDefinition[];
    options: OptionDefinition[];
  } {
    if (!schema || !schema.properties) {
      return { args: [], options: [] };
    }

    const args: ArgumentDefinition[] = [];
    const options: OptionDefinition[] = [];
    const required = schema.required || [];

    for (const [name, prop] of Object.entries(schema.properties)) {
      const param = prop as MCPToolParameter;
      const isRequired = required.includes(name);

      // Create option definition
      const option: OptionDefinition = {
        long: `--${name.replace(/_/g, '-')}`,
        description: param.description || name,
        required: isRequired,
        type: this.mapJsonTypeToCliType(param.type, param),
      };

      // Add short form for common options
      if (name.length === 1 || ['query', 'file', 'path', 'id'].includes(name)) {
        option.short = `-${name[0]}`;
      }

      // Add default value
      if (param.default !== undefined) {
        option.default = param.default;
      }

      // Add choices/enum
      if (param.enum && param.enum.length > 0) {
        option.choices = param.enum;
      }

      options.push(option);
    }

    return { args, options };
  }

  /**
   * Map JSON Schema type to CLI argument type
   */
  private mapJsonTypeToCliType(
    jsonType: string,
    param: MCPToolParameter
  ): 'string' | 'number' | 'boolean' | 'array' | 'file' | 'directory' | 'url' | 'json' {
    switch (jsonType) {
      case 'string':
        // Check for special formats
        if (param.description?.toLowerCase().includes('file')) return 'file';
        if (param.description?.toLowerCase().includes('directory')) return 'directory';
        if (param.description?.toLowerCase().includes('url')) return 'url';
        return 'string';

      case 'number':
      case 'integer':
        return 'number';

      case 'boolean':
        return 'boolean';

      case 'array':
        return 'array';

      case 'object':
        return 'json';

      default:
        return 'string';
    }
  }

  /**
   * Generate usage string for command
   */
  private generateUsage(
    cliName: string,
    args: ArgumentDefinition[],
    options: OptionDefinition[]
  ): string {
    let usage = `nexus nexus ${cliName}`;

    // Add required options
    const requiredOptions = options.filter((opt) => opt.required);
    for (const opt of requiredOptions) {
      usage += ` ${opt.long} <value>`;
    }

    // Add optional options indicator
    if (options.some((opt) => !opt.required)) {
      usage += ' [options]';
    }

    return usage;
  }

  /**
   * Generate example commands
   */
  private generateExamples(cliName: string, tool: MCPTool): string[] {
    const examples: string[] = [];

    // Generate examples based on tool category
    const category = this.inferCategory(tool.name);

    switch (category) {
      case 'memory':
        if (cliName.includes('store')) {
          examples.push(
            `nexus nexus ${cliName} --content "User prefers TypeScript" --tags "preferences,typescript"`
          );
        } else if (cliName.includes('recall')) {
          examples.push(
            `nexus nexus ${cliName} --query "typescript patterns" --limit 10`
          );
        }
        break;

      case 'documents':
        if (cliName.includes('store')) {
          examples.push(
            `nexus nexus ${cliName} --file report.pdf --title "Q4 Report"`
          );
        } else if (cliName.includes('retrieve')) {
          examples.push(
            `nexus nexus ${cliName} --query "authentication" --strategy semantic_chunks`
          );
        }
        break;

      case 'knowledge-graph':
        if (cliName.includes('store-entity')) {
          examples.push(
            `nexus nexus ${cliName} --domain code --type class --content "User class"`
          );
        } else if (cliName.includes('query')) {
          examples.push(
            `nexus nexus ${cliName} --domain code --search "authentication"`
          );
        }
        break;

      case 'code-analysis':
        if (cliName.includes('validate-code')) {
          examples.push(
            `nexus nexus ${cliName} --file app.ts --risk-level high`
          );
        } else if (cliName.includes('analyze')) {
          examples.push(
            `nexus nexus ${cliName} --file app.ts --depth deep --focus security,performance`
          );
        }
        break;

      case 'multi-agent':
        if (cliName.includes('orchestrate')) {
          examples.push(
            `nexus nexus ${cliName} --task "Analyze codebase for security issues" --max-agents 5`
          );
        }
        break;

      case 'learning':
        if (cliName.includes('trigger')) {
          examples.push(
            `nexus nexus ${cliName} --topic "rust_async" --priority 9`
          );
        } else if (cliName.includes('recall')) {
          examples.push(
            `nexus nexus ${cliName} --topic "typescript_patterns" --layer EXPERT`
          );
        }
        break;

      case 'episodes':
        if (cliName.includes('store')) {
          examples.push(
            `nexus nexus ${cliName} --content "Fixed memory leak" --type insight`
          );
        } else if (cliName.includes('recall')) {
          examples.push(
            `nexus nexus ${cliName} --query "refactoring sessions" --limit 10`
          );
        }
        break;

      case 'health':
        if (cliName.includes('health')) {
          examples.push(`nexus nexus ${cliName} --detailed`);
        }
        break;
    }

    // Fallback generic example
    if (examples.length === 0) {
      examples.push(`nexus nexus ${cliName} [options]`);
    }

    return examples;
  }

  /**
   * Add tool to category
   */
  private addToCategory(category: string, toolName: string): void {
    if (!this.categoryMap.has(category)) {
      this.categoryMap.set(category, []);
    }
    this.categoryMap.get(category)!.push(toolName);
  }

  /**
   * Get all tools in a category
   */
  getToolsByCategory(category: string): MCPToolMapping[] {
    const toolNames = this.categoryMap.get(category) || [];
    return toolNames
      .map((name) => this.toolMappings.get(name))
      .filter((mapping): mapping is MCPToolMapping => mapping !== undefined);
  }

  /**
   * Get all categories
   */
  getCategories(): string[] {
    return Array.from(this.categoryMap.keys());
  }

  /**
   * Get tool mapping by name
   */
  getMapping(toolName: string): MCPToolMapping | undefined {
    return this.toolMappings.get(toolName);
  }

  /**
   * Get all tool mappings
   */
  getAllMappings(): MCPToolMapping[] {
    return Array.from(this.toolMappings.values());
  }

  /**
   * Clear all mappings
   */
  clear(): void {
    this.toolMappings.clear();
    this.categoryMap.clear();
  }
}

/**
 * Create a default MCP tool mapper instance
 */
export function createMCPToolMapper(): MCPToolMapper {
  return new MCPToolMapper();
}
