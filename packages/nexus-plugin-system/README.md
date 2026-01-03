# @adverant/nexus-plugin-system

Plugin system for Adverant Nexus Open Core. Enables seamless extension of GraphRAG, MageAgent, and API capabilities through npm-installable plugins.

## Features

- **Zero-Config Discovery**: Automatically discovers installed plugins
- **npm-Based Installation**: Install plugins with `npm install @nexus-plugin/name`
- **Type-Safe API**: Full TypeScript support with comprehensive types
- **Hot Reloading**: Reload plugins without restarting Nexus
- **Version Compatibility**: Automatic API version checking
- **Lifecycle Hooks**: onLoad, onStart, onStop, onConfigChange

## Installation

```bash
npm install @adverant/nexus-plugin-system
```

## Quick Start

### Discovering and Loading Plugins

```typescript
import { PluginDiscovery } from '@adverant/nexus-plugin-system';

// Create discovery instance
const discovery = new PluginDiscovery({
  autoLoad: true, // Automatically load discovered plugins
  apiVersion: '1.0',
});

// Discover installed plugins
const plugins = await discovery.discover();
console.log(`Found ${plugins.length} plugins`);

// Start all loaded plugins
await discovery.startAll();
```

### Installing a Plugin

```bash
# Install any Nexus plugin
npm install @nexus-plugin/example

# That's it! Plugin is automatically discovered and loaded
```

### Accessing Loaded Plugins

```typescript
// Get all loaded plugins
const loadedPlugins = discovery.getLoaded();

// Manually load a specific plugin
const plugin = await discovery.load('@nexus-plugin/custom-agent');

// Unload a plugin
await discovery.unload('@nexus-plugin/custom-agent');

// Reload a plugin (useful for development)
const reloaded = await discovery.reload('@nexus-plugin/custom-agent');
```

## Plugin Discovery

The system automatically discovers plugins matching these patterns:

- **Scoped packages**: `@nexus-plugin/*`
- **Unscoped packages**: `nexus-plugin-*`

### Discovery Process

1. Scans `node_modules` for matching packages
2. Reads plugin metadata from `package.json`
3. Validates plugin structure
4. Checks API version compatibility
5. Loads plugin if `autoLoad` is enabled

## Plugin Capabilities

Plugins can extend Nexus in several ways:

### 1. Document Processors (GraphRAG)

Add custom document processing for new file types:

```typescript
const pdfProcessor: DocumentProcessor = {
  name: 'pdf-processor',
  mimeTypes: ['application/pdf'],
  process: async (document) => {
    // Extract text from PDF
    return {
      text: extractedText,
      chunks: documentChunks,
      entities: extractedEntities,
      metadata: { pages: 10 },
    };
  },
};
```

### 2. Custom Retrievers (GraphRAG)

Implement custom retrieval strategies:

```typescript
const semanticRetriever: Retriever = {
  name: 'semantic-retriever',
  retrieve: async (query) => {
    // Custom retrieval logic
    return results;
  },
};
```

### 3. Custom Agents (MageAgent)

Create specialized agents:

```typescript
const sqlAgent: Agent = {
  name: 'sql-agent',
  description: 'Generates and executes SQL queries',
  execute: async (task) => {
    // Agent logic
    return {
      taskId: task.id,
      status: 'success',
      output: 'SELECT * FROM users',
    };
  },
};
```

### 4. Custom Tools (MageAgent)

Add new tools for agents:

```typescript
const weatherTool: Tool = {
  name: 'get-weather',
  description: 'Get current weather for a location',
  parameters: {
    type: 'object',
    properties: {
      location: { type: 'string' },
    },
    required: ['location'],
  },
  execute: async ({ location }) => {
    // Tool logic
    return { temperature: 72, condition: 'sunny' };
  },
};
```

### 5. API Routes

Extend the Nexus API:

```typescript
const customRoute: Route = {
  method: 'GET',
  path: '/api/v1/custom',
  handler: async (req, res) => {
    res.json({ success: true, data: 'Custom endpoint' });
  },
};
```

## Plugin Types

Full TypeScript types are exported:

```typescript
import type {
  NexusPlugin,
  PluginMetadata,
  PluginHooks,
  PluginCapabilities,
  DocumentProcessor,
  Retriever,
  Agent,
  Tool,
  Route,
} from '@adverant/nexus-plugin-system';
```

## Error Handling

The plugin system includes specialized error types:

```typescript
import { PluginValidationError, PluginCompatibilityError } from '@adverant/nexus-plugin-system';

try {
  await discovery.load('invalid-plugin');
} catch (error) {
  if (error instanceof PluginValidationError) {
    console.error('Validation errors:', error.validationErrors);
  } else if (error instanceof PluginCompatibilityError) {
    console.error(`API version mismatch: ${error.requiredApiVersion} != ${error.actualApiVersion}`);
  }
}
```

## Creating a Plugin

See the [Plugin Development Guide](../../docs/plugins/development.md) for detailed instructions.

Quick example:

```typescript
import { NexusPlugin } from '@adverant/nexus-plugin-system';

const myPlugin: NexusPlugin = {
  metadata: {
    name: '@nexus-plugin/my-plugin',
    version: '1.0.0',
    apiVersion: '1.0',
    description: 'My awesome plugin',
    author: 'Your Name',
    license: 'Apache-2.0',
  },

  hooks: {
    onLoad: async () => {
      console.log('Plugin loaded');
    },
    onStart: async () => {
      console.log('Plugin started');
    },
    onStop: async () => {
      console.log('Plugin stopped');
    },
  },

  capabilities: {
    mageagent: {
      tools: [
        /* your tools */
      ],
    },
  },
};

export default myPlugin;
```

## API Reference

### PluginDiscovery

#### Constructor

```typescript
new PluginDiscovery(options?: {
  autoLoad?: boolean;
  searchPaths?: string[];
  pattern?: RegExp;
  apiVersion?: string;
});
```

#### Methods

- `discover(): Promise<PluginMetadata[]>` - Discover all installed plugins
- `load(name: string): Promise<NexusPlugin>` - Load a specific plugin
- `unload(name: string): Promise<void>` - Unload a plugin
- `reload(name: string): Promise<NexusPlugin>` - Reload a plugin
- `getLoaded(): NexusPlugin[]` - Get all loaded plugins
- `startAll(): Promise<void>` - Start all loaded plugins
- `stopAll(): Promise<void>` - Stop all loaded plugins

## License

Apache-2.0 - See LICENSE for details

## Contributing

See [CONTRIBUTING.md](../../CONTRIBUTING.md) for contribution guidelines.

## Support

- GitHub Discussions: https://github.com/adverant/Adverant-Nexus-Open-Core/discussions
- Discord: https://discord.gg/adverant
- Documentation: https://github.com/adverant/Adverant-Nexus-Open-Core/tree/main/docs
