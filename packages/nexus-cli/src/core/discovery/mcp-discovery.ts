/**
 * MCP Discovery
 *
 * Discovers MCP tools from nexus-mcp-server and converts them to CLI commands
 */

import axios from 'axios';
import type { ServiceCommand, CommandParameter } from '../../types/service.js';

export interface MCPTool {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, MCPProperty>;
    required?: string[];
  };
}

export interface MCPProperty {
  type: 'string' | 'number' | 'boolean' | 'array' | 'object';
  description?: string;
  enum?: any[];
  default?: any;
  items?: MCPProperty;
  properties?: Record<string, MCPProperty>;
}

export interface MCPDiscoveryOptions {
  mcpUrl?: string;
  timeout?: number;
  headers?: Record<string, string>;
}

/**
 * Discover all MCP tools from nexus-mcp-server
 */
export async function discoverMCPTools(
  options: MCPDiscoveryOptions = {}
): Promise<MCPTool[]> {
  const {
    mcpUrl = 'http://localhost:9000',
    timeout = 5000,
    headers = {}
  } = options;

  try {
    // Try to fetch tools list from MCP server
    // Note: MCP uses stdio protocol, so we need to call the API gateway instead
    const gatewayUrl = mcpUrl.replace(':9000', ':9092'); // Use API Gateway

    const response = await axios.get(`${gatewayUrl}/api/tools`, {
      timeout,
      headers: {
        'Accept': 'application/json',
        ...headers
      }
    });

    if (response.status === 200 && Array.isArray(response.data)) {
      return response.data;
    }

    // Fallback: return hardcoded list of known Nexus tools
    return getKnownNexusTools();
  } catch (error) {
    console.warn('Could not fetch MCP tools from server, using fallback list');
    return getKnownNexusTools();
  }
}

/**
 * Convert MCP tool to CLI command
 */
export function mcpToolToCommand(tool: MCPTool): ServiceCommand {
  const params = extractMCPParameters(tool.inputSchema);

  // Generate command name (nexus_ prefix → nexus namespace)
  const commandName = tool.name
    .replace(/^nexus_/, '')
    .replace(/_/g, '-');

  // Generate examples
  const examples = generateMCPExamples(commandName, params);

  return {
    name: commandName,
    namespace: 'nexus',
    description: tool.description,
    endpoint: `/api/tools/${tool.name}`,
    method: 'POST',
    params,
    streaming: isStreamingTool(tool.name),
    examples
  };
}

/**
 * Extract parameters from MCP input schema
 */
function extractMCPParameters(schema: MCPTool['inputSchema']): CommandParameter[] {
  const params: CommandParameter[] = [];
  const required = new Set(schema.required || []);

  for (const [name, prop] of Object.entries(schema.properties)) {
    params.push({
      name,
      type: mapMCPType(prop.type),
      required: required.has(name),
      description: prop.description || '',
      default: prop.default,
      enum: prop.enum,
      format: inferFormat(name, prop)
    });
  }

  return params;
}

/**
 * Map MCP type to CLI parameter type
 */
function mapMCPType(type: string): CommandParameter['type'] {
  const typeMap: Record<string, CommandParameter['type']> = {
    'string': 'string',
    'number': 'number',
    'boolean': 'boolean',
    'array': 'array',
    'object': 'object'
  };

  return typeMap[type] || 'string';
}

/**
 * Infer format from parameter name and properties
 */
function inferFormat(name: string, prop: MCPProperty): string | undefined {
  // File parameters
  if (name.includes('file') || name.includes('path')) {
    return 'file';
  }

  // URL parameters
  if (name.includes('url') || name.includes('endpoint')) {
    return 'url';
  }

  // JSON parameters
  if (prop.type === 'object' || prop.type === 'array') {
    return 'json';
  }

  return undefined;
}

/**
 * Check if tool supports streaming
 */
function isStreamingTool(name: string): boolean {
  const streamingTools = [
    'nexus_orchestrate',
    'nexus_validate_code',
    'nexus_ingest_url',
    'nexus_enhanced_retrieve',
    'nexus_multi_agent_orchestrate'
  ];

  return streamingTools.includes(name);
}

/**
 * Generate usage examples for MCP command
 */
function generateMCPExamples(
  commandName: string,
  params: CommandParameter[]
): string[] {
  const examples: string[] = [];

  // Basic example
  const requiredParams = params.filter(p => p.required);
  if (requiredParams.length > 0) {
    const paramStr = requiredParams
      .map(p => {
        if (p.type === 'boolean') {
          return `--${p.name}`;
        } else if (p.format === 'file') {
          return `--${p.name} /path/to/file`;
        } else if (p.enum && p.enum.length > 0) {
          return `--${p.name} ${p.enum[0]}`;
        } else {
          const exampleValue = getExampleValue(p.name, p.type);
          return `--${p.name} "${exampleValue}"`;
        }
      })
      .join(' ');

    examples.push(`nexus nexus ${commandName} ${paramStr}`);
  } else {
    examples.push(`nexus nexus ${commandName}`);
  }

  // Streaming example
  if (isStreamingTool(`nexus_${commandName.replace(/-/g, '_')}`)) {
    examples.push(`nexus nexus ${commandName} ${requiredParams.map(p => `--${p.name} <value>`).join(' ')} --stream`);
  }

  // JSON output example
  examples.push(`nexus nexus ${commandName} --output-format json`);

  return examples.slice(0, 3);
}

/**
 * Get example value for parameter
 */
function getExampleValue(name: string, type: string): string {
  const examples: Record<string, string> = {
    'query': 'search query',
    'content': 'content text',
    'title': 'document title',
    'domain': 'code',
    'type': 'function',
    'task': 'analyze codebase',
    'topic': 'typescript_patterns',
    'code': 'function example() {}',
    'language': 'typescript',
    'file': '/path/to/file',
    'url': 'https://example.com',
    'limit': '10',
    'maxAgents': '5',
    'priority': '8'
  };

  if (examples[name]) {
    return examples[name];
  }

  if (type === 'number') {
    return '10';
  }

  if (type === 'boolean') {
    return 'true';
  }

  return 'value';
}

/**
 * Get hardcoded list of known Nexus tools (fallback)
 */
function getKnownNexusTools(): MCPTool[] {
  return [
    // Memory Operations
    {
      name: 'nexus_store_memory',
      description: 'Store a memory with tags and metadata',
      inputSchema: {
        type: 'object',
        properties: {
          content: { type: 'string', description: 'Memory content' },
          tags: { type: 'array', description: 'Tags for categorization' },
          metadata: { type: 'object', description: 'Additional metadata' }
        },
        required: ['content']
      }
    },
    {
      name: 'nexus_recall_memory',
      description: 'Search and recall memories',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search query' },
          limit: { type: 'number', description: 'Maximum results', default: 10 },
          score_threshold: { type: 'number', description: 'Minimum similarity score', default: 0.3 }
        },
        required: ['query']
      }
    },
    {
      name: 'nexus_store_document',
      description: 'Store a document with embeddings',
      inputSchema: {
        type: 'object',
        properties: {
          content: { type: 'string', description: 'Document content' },
          title: { type: 'string', description: 'Document title' },
          metadata: { type: 'object', description: 'Document metadata' }
        },
        required: ['content', 'title']
      }
    },
    {
      name: 'nexus_retrieve',
      description: 'Retrieve documents using advanced strategies',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search query' },
          strategy: {
            type: 'string',
            description: 'Retrieval strategy',
            enum: ['semantic_chunks', 'graph_traversal', 'hybrid', 'adaptive'],
            default: 'semantic_chunks'
          },
          limit: { type: 'number', description: 'Maximum results', default: 10 },
          rerank: { type: 'boolean', description: 'Use Cohere reranking', default: false }
        },
        required: ['query']
      }
    },

    // Knowledge Graph
    {
      name: 'nexus_store_entity',
      description: 'Store an entity in knowledge graph',
      inputSchema: {
        type: 'object',
        properties: {
          domain: { type: 'string', description: 'Domain (code, medical, legal, etc.)' },
          entityType: { type: 'string', description: 'Entity type' },
          textContent: { type: 'string', description: 'Entity content' },
          tags: { type: 'array', description: 'Tags' },
          metadata: { type: 'object', description: 'Metadata' }
        },
        required: ['domain', 'entityType', 'textContent']
      }
    },
    {
      name: 'nexus_query_entities',
      description: 'Query entities in knowledge graph',
      inputSchema: {
        type: 'object',
        properties: {
          domain: { type: 'string', description: 'Domain filter' },
          entityType: { type: 'string', description: 'Entity type filter' },
          searchText: { type: 'string', description: 'Search text' },
          limit: { type: 'number', description: 'Maximum results', default: 20 }
        },
        required: []
      }
    },

    // Code Analysis
    {
      name: 'nexus_validate_code',
      description: 'Multi-model code validation with consensus (3 models)',
      inputSchema: {
        type: 'object',
        properties: {
          code: { type: 'string', description: 'Code to validate' },
          language: { type: 'string', description: 'Programming language' },
          context: { type: 'string', description: 'Additional context' },
          riskLevel: {
            type: 'string',
            description: 'Risk level',
            enum: ['low', 'medium', 'high', 'critical'],
            default: 'medium'
          }
        },
        required: ['code', 'language']
      }
    },
    {
      name: 'nexus_analyze_code',
      description: 'Fast single-model code analysis',
      inputSchema: {
        type: 'object',
        properties: {
          code: { type: 'string', description: 'Code to analyze' },
          language: { type: 'string', description: 'Programming language' },
          depth: {
            type: 'string',
            description: 'Analysis depth',
            enum: ['quick', 'standard', 'deep'],
            default: 'standard'
          },
          focusAreas: { type: 'array', description: 'Focus areas (security, performance, etc.)' }
        },
        required: ['code', 'language']
      }
    },

    // Multi-Agent
    {
      name: 'nexus_orchestrate',
      description: 'Spawn multiple AI agents for complex tasks',
      inputSchema: {
        type: 'object',
        properties: {
          task: { type: 'string', description: 'Task description' },
          maxAgents: { type: 'number', description: 'Maximum agents', default: 5 },
          timeout: { type: 'number', description: 'Timeout in ms', default: 60000 },
          context: { type: 'object', description: 'Additional context' }
        },
        required: ['task']
      }
    },

    // Learning System
    {
      name: 'nexus_trigger_learning',
      description: 'Trigger progressive learning on topic',
      inputSchema: {
        type: 'object',
        properties: {
          topic: { type: 'string', description: 'Topic to learn' },
          priority: { type: 'number', description: 'Priority (1-10)', default: 5 },
          trigger: {
            type: 'string',
            description: 'Trigger reason',
            enum: ['user_request', 'code_execution_failure', 'knowledge_gap_detected'],
            default: 'user_request'
          },
          context: { type: 'object', description: 'Additional context' }
        },
        required: ['topic']
      }
    },
    {
      name: 'nexus_recall_knowledge',
      description: 'Retrieve learned knowledge',
      inputSchema: {
        type: 'object',
        properties: {
          topic: { type: 'string', description: 'Topic to recall' },
          layer: {
            type: 'string',
            description: 'Knowledge layer',
            enum: ['OVERVIEW', 'PROCEDURES', 'TECHNIQUES', 'EXPERT', 'all'],
            default: 'all'
          },
          max_results: { type: 'number', description: 'Maximum results', default: 10 }
        },
        required: ['topic']
      }
    },

    // Episodes
    {
      name: 'nexus_store_episode',
      description: 'Store session event/observation',
      inputSchema: {
        type: 'object',
        properties: {
          content: { type: 'string', description: 'Episode content' },
          type: {
            type: 'string',
            description: 'Episode type',
            enum: ['user_query', 'system_response', 'event', 'observation', 'insight'],
            default: 'observation'
          },
          metadata: { type: 'object', description: 'Episode metadata' }
        },
        required: ['content']
      }
    },
    {
      name: 'nexus_recall_episodes',
      description: 'Recall past session events',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search query' },
          limit: { type: 'number', description: 'Maximum results', default: 10 },
          include_decay: { type: 'boolean', description: 'Apply temporal decay', default: true },
          type_filter: { type: 'array', description: 'Filter by episode types' }
        },
        required: ['query']
      }
    },

    // Health & Status
    {
      name: 'nexus_health',
      description: 'Check Nexus system health',
      inputSchema: {
        type: 'object',
        properties: {
          detailed: { type: 'boolean', description: 'Include detailed metrics', default: false }
        },
        required: []
      }
    },
    {
      name: 'nexus_ingestion_status',
      description: 'Check ingestion job status',
      inputSchema: {
        type: 'object',
        properties: {
          job_id: { type: 'string', description: 'Ingestion job ID' }
        },
        required: ['job_id']
      }
    }
  ];
}

/**
 * Convert all MCP tools to commands
 */
export async function discoverMCPCommands(
  options: MCPDiscoveryOptions = {}
): Promise<ServiceCommand[]> {
  const tools = await discoverMCPTools(options);
  return tools.map(tool => mcpToolToCommand(tool));
}
