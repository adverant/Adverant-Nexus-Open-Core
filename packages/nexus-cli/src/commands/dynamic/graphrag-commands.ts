/**
 * GraphRAG Service Commands
 *
 * Commands for interacting with the GraphRAG service
 */

import type { Command, CommandHandler } from '../../types/command.js';
import { createHTTPClient } from '../../core/transport/http-client.js';

// Tenant context helper
function getTenantHeaders(context: any) {
  const config = context.config || {};
  return {
    'X-Company-ID': config.companyId || 'adverant',
    'X-App-ID': config.appId || 'nexus-cli',
    'X-User-ID': config.userId || 'system',
  };
}

// Store Document
export const storeDocumentHandler: CommandHandler = async (args, context) => {
  const service = context.services.get('graphrag');
  if (!service) {
    return {
      success: false,
      error: 'GraphRAG service not found',
    };
  }

  const client = createHTTPClient({ baseUrl: service.apiUrl });

  const file = args.file as string;
  const title = args.title as string | undefined;
  const type = args.type as string | undefined;
  const tags = args.tags as string[] | undefined;

  if (!file) {
    return {
      success: false,
      error: '--file is required',
    };
  }

  try {
    const response = await client.post('/documents', {
      file,
      title,
      metadata: {
        type: type || 'document',
        tags: tags || [],
      },
    });

    return {
      success: true,
      data: response,
      message: 'Document stored successfully',
    };
  } catch (error: any) {
    return {
      success: false,
      error: error.message || 'Failed to store document',
    };
  }
};

// Query Documents
export const queryHandler: CommandHandler = async (args, context) => {
  const service = context.services.get('graphrag');
  if (!service) {
    return {
      success: false,
      error: 'GraphRAG service not found',
    };
  }

  const client = createHTTPClient({ baseUrl: service.apiUrl });

  const text = args.text as string;
  const limit = args.limit as number | undefined;

  if (!text) {
    return {
      success: false,
      error: '--text query is required',
    };
  }

  try {
    const response = await client.post('/query', {
      text,
      limit: limit || 10,
    });

    const count = response.results?.length || 0;
    return {
      success: true,
      data: response,
      message: `Found ${count} results`,
    };
  } catch (error: any) {
    return {
      success: false,
      error: error.message || 'Query failed',
    };
  }
};

// Store Memory
export const storeMemoryHandler: CommandHandler = async (args, context) => {
  const service = context.services.get('graphrag');
  if (!service) {
    return {
      success: false,
      error: 'GraphRAG service not found',
    };
  }

  const client = createHTTPClient({
    baseUrl: service.apiUrl,
    headers: getTenantHeaders(context),
  });

  const content = args.content as string;
  const tags = args.tags as string | undefined;

  if (!content) {
    return {
      success: false,
      error: '--content is required',
    };
  }

  try {
    // Use unified /api/v2/memory endpoint
    const response = await client.post('/api/v2/memory', {
      content,
      tags: tags ? tags.split(',').map(t => t.trim()) : [],
    });

    return {
      success: true,
      data: response,
      message: `Memory stored successfully (ID: ${response.memoryId || response.data?.memoryId})`,
    };
  } catch (error: any) {
    return {
      success: false,
      error: error.message || 'Failed to store memory',
    };
  }
};

// Recall Memories
export const recallHandler: CommandHandler = async (args, context) => {
  const service = context.services.get('graphrag');
  if (!service) {
    return {
      success: false,
      error: 'GraphRAG service not found',
    };
  }

  const client = createHTTPClient({
    baseUrl: service.apiUrl,
    headers: getTenantHeaders(context),
  });

  const query = args.query as string;
  const limit = args.limit as number | undefined;

  if (!query) {
    return {
      success: false,
      error: '--query is required',
    };
  }

  try {
    // Use unified enhanced retrieval endpoint
    const response = await client.post('/graphrag/api/retrieve/enhanced', {
      query,
      limit: limit || 5,
      includeEpisodic: true,
      includeDocuments: true,
    });

    const count = response.unified_memories?.length || response.memories?.length || 0;
    return {
      success: true,
      data: response,
      message: `Found ${count} relevant memories`,
    };
  } catch (error: any) {
    return {
      success: false,
      error: error.message || 'Memory recall failed',
    };
  }
};

// List Memories
export const listMemoriesHandler: CommandHandler = async (args, context) => {
  const service = context.services.get('graphrag');
  if (!service) {
    return {
      success: false,
      error: 'GraphRAG service not found',
    };
  }

  const client = createHTTPClient({
    baseUrl: service.apiUrl,
    headers: getTenantHeaders(context),
  });

  const _limit = args.limit as number | undefined;
  const _offset = args.offset as number | undefined;

  // DEPRECATED: List endpoint removed - use retrieve/enhanced with broad query
  console.warn('listMemories is deprecated. Use recall command instead.');
  return {
    success: true,
    data: { memories: [], deprecated: true },
    message: `List memories is deprecated. Use 'recall' command instead.`,
  };
};

// Enhanced Search (GraphRAG Enhanced)
export const enhancedSearchHandler: CommandHandler = async (args, context) => {
  const service = context.services.get('graphrag-enhanced') || context.services.get('graphrag');
  if (!service) {
    return {
      success: false,
      error: 'GraphRAG Enhanced service not found',
    };
  }

  const client = createHTTPClient({
    baseUrl: service.apiUrl,
    headers: getTenantHeaders(context),
  });

  const query = args.query as string;
  const enableEnhancement = args['enable-enhancement'] !== false;
  const enableCorrection = args['enable-correction'] !== false;
  const enableEval = args['enable-eval'] !== false;
  const topK = args['top-k'] as number | undefined;

  if (!query) {
    return {
      success: false,
      error: '--query is required',
    };
  }

  try {
    const response = await client.post('/enhanced/search', {
      query,
      userId: getTenantHeaders(context)['X-User-ID'],
      sessionId: `cli-${Date.now()}`,
      options: {
        enableQueryEnhancement: enableEnhancement,
        enableSelfCorrection: enableCorrection,
        enableRAGTriadEval: enableEval,
        topK: topK || 10,
        returnRawScores: true,
        includeIterationTrace: true,
      },
    });

    const count = response.results?.length || 0;
    const quality = response.quality?.overall || 0;
    return {
      success: true,
      data: response,
      message: `Found ${count} results (quality: ${(quality * 100).toFixed(1)}%)`,
    };
  } catch (error: any) {
    return {
      success: false,
      error: error.message || 'Enhanced search failed',
    };
  }
};

// Query Analysis
export const analyzeHandler: CommandHandler = async (args, context) => {
  const service = context.services.get('graphrag-enhanced') || context.services.get('graphrag');
  if (!service) {
    return {
      success: false,
      error: 'GraphRAG Enhanced service not found',
    };
  }

  const client = createHTTPClient({
    baseUrl: service.apiUrl,
    headers: getTenantHeaders(context),
  });

  const query = args.query as string;

  if (!query) {
    return {
      success: false,
      error: '--query is required',
    };
  }

  try {
    const response = await client.post('/enhanced/analyze', {
      query,
    });

    return {
      success: true,
      data: response,
      message: `Query analyzed - Route: ${response.routingDecision?.route}, Complexity: ${response.analysis?.complexity}`,
    };
  } catch (error: any) {
    return {
      success: false,
      error: error.message || 'Query analysis failed',
    };
  }
};

// RAG Triad Evaluation
export const evaluateHandler: CommandHandler = async (args, context) => {
  const service = context.services.get('graphrag-enhanced') || context.services.get('graphrag');
  if (!service) {
    return {
      success: false,
      error: 'GraphRAG Enhanced service not found',
    };
  }

  const client = createHTTPClient({
    baseUrl: service.apiUrl,
    headers: getTenantHeaders(context),
  });

  const query = args.query as string;
  const contextArg = args.context as string;
  const answer = args.answer as string;

  if (!query || !contextArg || !answer) {
    return {
      success: false,
      error: '--query, --context, and --answer are required',
    };
  }

  try {
    const response = await client.post('/enhanced/evaluate', {
      query,
      context: contextArg.split('|||').map(c => c.trim()),
      answer,
    });

    const overall = response.scores?.overall || 0;
    return {
      success: true,
      data: response,
      message: `Quality score: ${(overall * 100).toFixed(1)}% (Context: ${(response.scores?.contextRelevance * 100).toFixed(1)}%, Groundedness: ${(response.scores?.groundedness * 100).toFixed(1)}%, Answer: ${(response.scores?.answerRelevance * 100).toFixed(1)}%)`,
    };
  } catch (error: any) {
    return {
      success: false,
      error: error.message || 'Evaluation failed',
    };
  }
};

// GraphRAG Command Definitions
export const graphragCommands: Command[] = [
  {
    name: 'store-document',
    namespace: 'graphrag',
    description: 'Store a document in GraphRAG',
    handler: storeDocumentHandler,
    options: [
      {
        long: 'file',
        description: 'File path to store',
        type: 'file',
        required: true,
      },
      {
        long: 'title',
        description: 'Document title',
        type: 'string',
      },
    ],
    examples: [
      'nexus graphrag store-document --file report.pdf --title "Q4 Report"',
    ],
    usage: 'nexus graphrag store-document --file <path> [--title <title>]',
    category: 'graphrag',
  },
  {
    name: 'query',
    namespace: 'graphrag',
    description: 'Query documents in GraphRAG',
    handler: queryHandler,
    options: [
      {
        long: 'text',
        description: 'Query text',
        type: 'string',
        required: true,
      },
      {
        long: 'limit',
        description: 'Number of results',
        type: 'number',
        default: 10,
      },
    ],
    examples: [
      'nexus graphrag query --text "user authentication"',
    ],
    usage: 'nexus graphrag query --text <query> [--limit N]',
    category: 'graphrag',
  },
  {
    name: 'store-memory',
    namespace: 'graphrag',
    description: 'Store a memory in GraphRAG (code snippets, notes, documentation)',
    handler: storeMemoryHandler,
    options: [
      {
        long: 'content',
        description: 'Memory content',
        type: 'string',
        required: true,
      },
      {
        long: 'tags',
        description: 'Comma-separated tags',
        type: 'string',
      },
    ],
    examples: [
      'nexus graphrag store-memory --content "User auth uses JWT tokens" --tags "auth,jwt"',
    ],
    usage: 'nexus graphrag store-memory --content <text> [--tags <tags>]',
    category: 'graphrag',
  },
  {
    name: 'recall',
    namespace: 'graphrag',
    description: 'Recall memories using semantic search',
    handler: recallHandler,
    options: [
      {
        long: 'query',
        description: 'Search query',
        type: 'string',
        required: true,
      },
      {
        long: 'limit',
        description: 'Number of results',
        type: 'number',
        default: 5,
      },
    ],
    examples: [
      'nexus graphrag recall --query "How does authentication work?" --limit 3',
    ],
    usage: 'nexus graphrag recall --query <text> [--limit N]',
    category: 'graphrag',
  },
  {
    name: 'list-memories',
    namespace: 'graphrag',
    description: 'List all stored memories',
    handler: listMemoriesHandler,
    options: [
      {
        long: 'limit',
        description: 'Number of results',
        type: 'number',
        default: 20,
      },
      {
        long: 'offset',
        description: 'Offset for pagination',
        type: 'number',
        default: 0,
      },
    ],
    examples: [
      'nexus graphrag list-memories --limit 10',
    ],
    usage: 'nexus graphrag list-memories [--limit N] [--offset N]',
    category: 'graphrag',
  },
  {
    name: 'enhanced-search',
    namespace: 'graphrag',
    description: 'Enhanced search with query rewriting, HyDE, and self-correction',
    handler: enhancedSearchHandler,
    options: [
      {
        long: 'query',
        description: 'Search query',
        type: 'string',
        required: true,
      },
      {
        long: 'enable-enhancement',
        description: 'Enable query enhancement',
        type: 'boolean',
        default: true,
      },
      {
        long: 'enable-correction',
        description: 'Enable self-correction',
        type: 'boolean',
        default: true,
      },
      {
        long: 'enable-eval',
        description: 'Enable RAG Triad evaluation',
        type: 'boolean',
        default: true,
      },
      {
        long: 'top-k',
        description: 'Number of results',
        type: 'number',
        default: 10,
      },
    ],
    examples: [
      'nexus graphrag enhanced-search --query "JWT authentication implementation"',
      'nexus graphrag enhanced-search --query "How to deploy to K8s?" --enable-correction false',
    ],
    usage: 'nexus graphrag enhanced-search --query <text> [options]',
    category: 'graphrag',
  },
  {
    name: 'analyze',
    namespace: 'graphrag',
    description: 'Analyze query complexity and routing without search',
    handler: analyzeHandler,
    options: [
      {
        long: 'query',
        description: 'Query to analyze',
        type: 'string',
        required: true,
      },
    ],
    examples: [
      'nexus graphrag analyze --query "What is the refund policy?"',
    ],
    usage: 'nexus graphrag analyze --query <text>',
    category: 'graphrag',
  },
  {
    name: 'evaluate',
    namespace: 'graphrag',
    description: 'Evaluate RAG quality using RAG Triad metrics',
    handler: evaluateHandler,
    options: [
      {
        long: 'query',
        description: 'Original query',
        type: 'string',
        required: true,
      },
      {
        long: 'context',
        description: 'Retrieved context (separate with |||)',
        type: 'string',
        required: true,
      },
      {
        long: 'answer',
        description: 'Generated answer',
        type: 'string',
        required: true,
      },
    ],
    examples: [
      'nexus graphrag evaluate --query "What is JWT?" --context "JWT is a token standard|||Used for auth" --answer "JWT is a token standard used for authentication"',
    ],
    usage: 'nexus graphrag evaluate --query <text> --context <text> --answer <text>',
    category: 'graphrag',
  },
];
