/**
 * Example Nexus Plugin
 *
 * This plugin demonstrates all plugin capabilities:
 * - Custom tools for MageAgent
 * - Custom agents
 * - Document processors for GraphRAG
 * - API routes
 * - Lifecycle hooks
 */

import {
  NexusPlugin,
  Tool,
  Agent,
  DocumentProcessor,
  Route,
} from '@adverant/nexus-plugin-system';

/**
 * Example Tool: String Reverser
 */
const reverseStringTool: Tool = {
  name: 'reverse-string',
  description: 'Reverses a string',
  parameters: {
    type: 'object',
    properties: {
      input: {
        type: 'string',
        description: 'The string to reverse',
      },
    },
    required: ['input'],
  },
  execute: async ({ input }: { input: string }) => {
    return {
      reversed: input.split('').reverse().join(''),
      length: input.length,
    };
  },
};

/**
 * Example Tool: Word Counter
 */
const wordCountTool: Tool = {
  name: 'count-words',
  description: 'Counts words in a text',
  parameters: {
    type: 'object',
    properties: {
      text: {
        type: 'string',
        description: 'The text to analyze',
      },
    },
    required: ['text'],
  },
  execute: async ({ text }: { text: string }) => {
    const words = text.trim().split(/\s+/);
    const characters = text.length;
    const lines = text.split('\n').length;

    return {
      words: words.length,
      characters,
      lines,
      averageWordLength: (characters / words.length).toFixed(2),
    };
  },
};

/**
 * Example Agent: Simple Summarizer
 */
const summarizerAgent: Agent = {
  name: 'simple-summarizer',
  description: 'Summarizes text to a specified length',
  capabilities: ['text-summarization', 'content-analysis'],
  execute: async (task) => {
    const { instruction, context } = task;
    const text = context?.text || instruction;

    // Simple truncation-based summary (in real plugin, use LLM)
    const maxLength = context?.maxLength || 100;
    const summary =
      text.length > maxLength ? text.substring(0, maxLength) + '...' : text;

    return {
      taskId: task.id,
      status: 'success',
      output: summary,
      metadata: {
        originalLength: text.length,
        summaryLength: summary.length,
        compressionRatio: (summary.length / text.length).toFixed(2),
      },
    };
  },
};

/**
 * Example Document Processor: Plain Text
 */
const textProcessor: DocumentProcessor = {
  name: 'plain-text-processor',
  mimeTypes: ['text/plain', 'text/markdown'],
  process: async (document) => {
    const text =
      typeof document.content === 'string'
        ? document.content
        : document.content.toString('utf-8');

    // Split into chunks of ~500 characters
    const chunkSize = 500;
    const chunks = [];

    for (let i = 0; i < text.length; i += chunkSize) {
      chunks.push({
        id: `${document.id}-chunk-${Math.floor(i / chunkSize)}`,
        text: text.substring(i, i + chunkSize),
        metadata: {
          position: Math.floor(i / chunkSize),
          length: Math.min(chunkSize, text.length - i),
        },
      });
    }

    return {
      text,
      chunks,
      metadata: {
        length: text.length,
        chunkCount: chunks.length,
        mimeType: document.mimeType,
        filename: document.filename,
      },
    };
  },
};

/**
 * Example API Route: Plugin Info
 */
const infoRoute: Route = {
  method: 'GET',
  path: '/api/v1/plugins/example/info',
  handler: async (req, res) => {
    res.json({
      plugin: '@nexus-plugin/example',
      version: '1.0.0',
      status: 'active',
      capabilities: {
        tools: ['reverse-string', 'count-words'],
        agents: ['simple-summarizer'],
        processors: ['plain-text-processor'],
      },
      uptime: process.uptime(),
    });
  },
};

/**
 * Example API Route: Echo Endpoint
 */
const echoRoute: Route = {
  method: 'POST',
  path: '/api/v1/plugins/example/echo',
  handler: async (req, res) => {
    res.json({
      echo: req.body,
      timestamp: new Date().toISOString(),
    });
  },
};

/**
 * Main Plugin Export
 */
const examplePlugin: NexusPlugin = {
  metadata: {
    name: '@nexus-plugin/example',
    version: '1.0.0',
    apiVersion: '1.0',
    description: 'Example plugin demonstrating all Nexus plugin capabilities',
    author: 'Adverant',
    license: 'Apache-2.0',
    repository: 'https://github.com/adverant/Adverant-Nexus-Open-Core',
    keywords: ['example', 'demo', 'tutorial'],
    homepage: 'https://github.com/adverant/Adverant-Nexus-Open-Core/tree/main/examples/example-plugin',
  },

  hooks: {
    onLoad: async () => {
      console.log('[Example Plugin] Loaded successfully');
    },

    onStart: async () => {
      console.log('[Example Plugin] Started');
      console.log('[Example Plugin] Registered 2 tools, 1 agent, 1 processor, 2 routes');
    },

    onStop: async () => {
      console.log('[Example Plugin] Stopping...');
      console.log('[Example Plugin] Stopped');
    },

    onConfigChange: async (config) => {
      console.log('[Example Plugin] Config changed:', config);
    },
  },

  capabilities: {
    mageagent: {
      tools: [reverseStringTool, wordCountTool],
      agents: [summarizerAgent],
    },

    graphrag: {
      processors: [textProcessor],
    },

    api: {
      routes: [infoRoute, echoRoute],
    },
  },

  config: {
    enabled: true,
    options: {
      maxTextLength: 10000,
      debugMode: false,
    },
  },
};

export default examplePlugin;
