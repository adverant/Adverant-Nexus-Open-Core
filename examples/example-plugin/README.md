# @nexus-plugin/example

Example plugin for Adverant Nexus Open Core. This plugin demonstrates all available plugin capabilities and serves as a template for building your own plugins.

## Features

This plugin showcases:

- ✅ **Custom Tools**: 2 tools for MageAgent (`reverse-string`, `count-words`)
- ✅ **Custom Agents**: 1 agent (`simple-summarizer`)
- ✅ **Document Processors**: 1 processor for plain text files
- ✅ **API Routes**: 2 custom API endpoints
- ✅ **Lifecycle Hooks**: onLoad, onStart, onStop, onConfigChange
- ✅ **Configuration**: Plugin-specific config options

## Installation

```bash
npm install @nexus-plugin/example
```

That's it! The plugin is automatically discovered and loaded by Nexus.

## Usage

### Tools

#### reverse-string

Reverses a string:

```typescript
{
  "tool": "reverse-string",
  "parameters": {
    "input": "hello world"
  }
}

// Returns:
{
  "reversed": "dlrow olleh",
  "length": 11
}
```

#### count-words

Counts words, characters, and lines:

```typescript
{
  "tool": "count-words",
  "parameters": {
    "text": "This is an example text with multiple words."
  }
}

// Returns:
{
  "words": 8,
  "characters": 45,
  "lines": 1,
  "averageWordLength": "5.62"
}
```

### Agent

#### simple-summarizer

Summarizes text to a specified length:

```typescript
{
  "agent": "simple-summarizer",
  "task": {
    "instruction": "Summarize this text",
    "context": {
      "text": "Long text here...",
      "maxLength": 100
    }
  }
}
```

### Document Processor

The `plain-text-processor` automatically processes:
- `text/plain` files
- `text/markdown` files

Documents are chunked into ~500 character segments for efficient retrieval.

### API Routes

#### GET /api/v1/plugins/example/info

Returns plugin information:

```bash
curl http://localhost:8090/api/v1/plugins/example/info
```

Response:
```json
{
  "plugin": "@nexus-plugin/example",
  "version": "1.0.0",
  "status": "active",
  "capabilities": {
    "tools": ["reverse-string", "count-words"],
    "agents": ["simple-summarizer"],
    "processors": ["plain-text-processor"]
  },
  "uptime": 12345.67
}
```

#### POST /api/v1/plugins/example/echo

Echo endpoint for testing:

```bash
curl -X POST http://localhost:8090/api/v1/plugins/example/echo \
  -H "Content-Type: application/json" \
  -d '{"message": "hello"}'
```

Response:
```json
{
  "echo": {
    "message": "hello"
  },
  "timestamp": "2026-01-03T12:00:00.000Z"
}
```

## Configuration

Configure the plugin via environment variables or config file:

### Environment Variables

```bash
# .env
NEXUS_PLUGIN_EXAMPLE_MAX_TEXT_LENGTH=10000
NEXUS_PLUGIN_EXAMPLE_DEBUG_MODE=true
```

### Config File

```json
{
  "plugins": {
    "@nexus-plugin/example": {
      "enabled": true,
      "options": {
        "maxTextLength": 10000,
        "debugMode": true
      }
    }
  }
}
```

## Development

### Building

```bash
npm run build
```

### Type Checking

```bash
npm run typecheck
```

### Watch Mode

```bash
npm run build:watch
```

## Plugin Structure

```
example-plugin/
├── src/
│   └── index.ts          # Main plugin file
├── dist/                 # Built output (generated)
├── package.json          # Plugin metadata
├── tsconfig.json         # TypeScript config
└── README.md            # This file
```

## Customizing This Template

1. **Copy the directory**:
   ```bash
   cp -r examples/example-plugin my-plugin
   cd my-plugin
   ```

2. **Update package.json**:
   - Change `name` to `@nexus-plugin/your-plugin-name`
   - Update `description`, `author`, `repository`
   - Update `version` to `1.0.0`

3. **Modify src/index.ts**:
   - Replace example tools/agents with your implementations
   - Update plugin metadata
   - Add your custom logic

4. **Build and test**:
   ```bash
   npm install
   npm run build
   ```

5. **Publish to npm**:
   ```bash
   npm publish --access public
   ```

## Plugin Development Guide

See the [full plugin development guide](../../docs/plugins/development.md) for:
- Detailed API reference
- Best practices
- Testing strategies
- Publishing guidelines

## License

Apache-2.0 - See LICENSE for details

## Support

- Documentation: [docs/plugins/](../../docs/plugins/)
- Discord: https://discord.gg/adverant
- GitHub Issues: https://github.com/adverant/Adverant-Nexus-Open-Core/issues
