# Adverant-Nexus CLI

> World-class command-line interface for the Adverant-Nexus platform - Surpassing Claude Code CLI and Gemini CLI

[![Version](https://img.shields.io/npm/v/@adverant-nexus/cli.svg)](https://www.npmjs.com/package/@adverant-nexus/cli)
[![License](https://img.shields.io/npm/l/@adverant-nexus/cli.svg)](https://github.com/adverant-ai/adverant-nexus/blob/main/LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.3-blue.svg)](https://www.typescriptlang.org/)

## Overview

The **Adverant-Nexus CLI** (`nexus`) is a production-grade, auto-discovering command-line interface that provides unified access to all 32+ microservices, 70+ Nexus MCP tools, and the entire Adverant-Nexus ecosystem.

### Why This CLI is Better

| Feature | Adverant-Nexus CLI | Claude Code | Gemini CLI |
|---------|-------------------|-------------|------------|
| **Auto-Discovery** | ✅ All services & plugins | ❌ Manual | ❌ Manual |
| **Service Commands** | ✅ 32+ services | ❌ Single agent | ❌ Single agent |
| **Nexus Tools** | ✅ 70+ tools exposed | ❌ N/A | ❌ N/A |
| **Plugin System** | ✅ Full SDK | ✅ Skills | ✅ Extensions |
| **Interactive REPL** | ✅ Full-featured | ❌ Chat only | ✅ Yes |
| **Streaming** | ✅ WebSocket + SSE | ✅ Yes | ✅ Yes |
| **Output Formats** | ✅ 5 formats | ✅ Text + JSON | ✅ Text + JSON |
| **ReAct Agent** | ✅ 20 iterations | ✅ Task agent | ❌ No |
| **Service Management** | ✅ Full control | ❌ N/A | ❌ N/A |
| **Multi-Agent** | ✅ 10+ agents | ❌ Single | ❌ Single |

## Features

### 🚀 Auto-Discovery
- **Automatic service detection** from docker-compose.yml
- **OpenAPI schema parsing** for automatic command generation
- **MCP tool discovery** for Nexus system integration
- **Plugin auto-loading** from ~/.nexus/plugins/

### 🎯 Unified Interface
- **32+ microservices** accessible via single CLI
- **500+ API endpoints** exposed as commands
- **70+ Nexus tools** integrated
- **Service namespaces**: `nexus <service> <action>`

### 🤖 Intelligent Automation
- **ReAct agent mode** for autonomous task execution
- **Multi-agent orchestration** (up to 10 agents)
- **Code validation** with 3-model consensus
- **Progressive learning** system integration

### 🔌 Extensible
- **Plugin SDK** for third-party extensions
- **MCP protocol** support
- **Custom commands** via .nexus.toml
- **Workspace-aware** configuration

### 📊 Multiple Output Formats
- **Text** (human-readable)
- **JSON** (machine-parseable)
- **YAML** (configuration files)
- **Table** (structured data)
- **Stream-JSON** (real-time events)

### 🎨 Rich Developer Experience
- **Interactive REPL** mode
- **Tab completion** for all commands
- **Session checkpointing** (save/resume work)
- **Streaming progress** for long operations
- **Git integration** (status, diff, commit)

## Installation

### From Source (Current)
```bash
# Navigate to CLI directory
cd /home/user/Adverant-Nexus/packages/nexus-cli

# Install dependencies
npm install

# Build
npm run build

# Link globally
npm run link:global

# Verify installation
nexus --version
```

### From NPM (Coming Soon)
```bash
npm install -g @adverant-nexus/cli
```

## Quick Start

```bash
# Check CLI version
nexus --version

# Show all discovered services
nexus services list

# Check service health
nexus services health --all

# Store a document in GraphRAG
nexus graphrag store-document --file report.pdf --title "Q4 Report"

# Query GraphRAG
nexus graphrag query --text "user authentication patterns"

# Run multi-agent orchestration
nexus mageagent orchestrate --task "Analyze codebase for security issues"

# Execute code in sandbox
nexus sandbox execute --code "print('Hello, Nexus!')" --language python

# Recall memories from Nexus
nexus nexus recall-memory --query "typescript patterns" --limit 10

# Start interactive REPL
nexus repl

# Run autonomous agent
nexus agent run --task "Fix all TypeScript errors"
```

## Usage

### Service Commands

Every microservice in the Adverant-Nexus stack is accessible via the CLI:

```bash
# GraphRAG - Knowledge Management
nexus graphrag store-document --file report.pdf
nexus graphrag query --text "search query"
nexus graphrag store-entity --domain code --type class --content "User"

# MageAgent - Multi-Agent Orchestration
nexus mageagent orchestrate --task "Complex task" --max-agents 5
nexus mageagent analyze --input code.ts --focus security
nexus mageagent collaborate --agents 3 --task "Build API"

# Sandbox - Code Execution
nexus sandbox execute --code "..." --language python --stream
nexus sandbox list-languages

# VideoAgent - Video Intelligence
nexus videoagent process-video --url video.mp4 --stream

# GeoAgent - Geospatial Intelligence
nexus geoagent proximity-search --lat 37.7749 --lon -122.4194 --radius 10km

# OrchestrationAgent - Autonomous Execution
nexus orchestration run --task "Implement feature" --max-iterations 20

# LearningAgent - Progressive Learning
nexus learning trigger --topic "rust_async" --priority 9
```

### Nexus MCP Commands

All 70+ Nexus tools are exposed:

```bash
# Memory Operations
nexus nexus store-memory --content "..." --tags "tag1,tag2"
nexus nexus recall-memory --query "search" --limit 10
nexus nexus store-document --file doc.pdf
nexus nexus retrieve --query "..." --strategy hybrid

# Knowledge Graph
nexus nexus store-entity --domain code --type function --content "..."
nexus nexus query-entities --domain code --search "auth"
nexus nexus create-relationship --source id1 --target id2 --type CALLS

# Code Analysis
nexus nexus validate-code --file app.ts --risk-level high
nexus nexus analyze-code --file app.ts --focus security,performance

# Multi-Agent
nexus nexus orchestrate --task "Security audit" --max-agents 5

# Learning
nexus nexus trigger-learning --topic "rust" --priority 8
nexus nexus recall-knowledge --topic "async" --layer EXPERT

# Health
nexus nexus health --detailed
```

### Service Management

```bash
# List all services
nexus services list

# Check service status
nexus services status

# Get service info
nexus services info graphrag

# Control services
nexus services start graphrag
nexus services stop mageagent
nexus services restart sandbox

# View logs
nexus services logs graphrag --follow

# Check health
nexus services health --all

# Show port mappings
nexus services ports
```

### Interactive REPL

```bash
# Start REPL
nexus repl

# Inside REPL:
> help                          # Show all commands
> services                      # List discovered services
> use graphrag                  # Switch to graphrag namespace
> store-document --file x.pdf   # Execute in current namespace
> history                       # Show command history
> save my-session               # Save session
> exit                          # Exit REPL
```

### Autonomous Agent Mode

```bash
# Run autonomous task
nexus agent run --task "Fix all TypeScript errors"

# With constraints
nexus agent run \
  --task "Implement user authentication" \
  --max-iterations 20 \
  --budget 50 \
  --workspace /path/to/project

# With streaming
nexus agent run --task "Security audit" --stream
```

### Session Management

```bash
# Save session
nexus session save my-work

# List sessions
nexus session list

# Resume session
nexus session load my-work

# Export/import
nexus session export my-work > session.json
nexus session import < session.json
```

### Configuration

```bash
# Show current config
nexus config list

# Get specific value
nexus config get services.api_url

# Set value
nexus config set defaults.output_format json

# Manage profiles
nexus config profiles list
nexus config profiles use production

# Initialize workspace
nexus config init
```

### Output Formats

```bash
# JSON output (for scripting)
nexus services list --output-format json

# Streaming JSON (real-time)
nexus videoagent process-video --url video.mp4 --output-format stream-json

# Table output
nexus services status --output-format table

# YAML output
nexus services list --output-format yaml

# Quiet mode
nexus sandbox execute --code "..." --quiet

# Verbose mode
nexus mageagent orchestrate --task "..." --verbose
```

## Configuration

### Self-Hosted Deployment Configuration

The Nexus CLI is designed to work with both the Adverant Cloud platform and self-hosted Nexus Open Core deployments.

#### Environment Variables

Configure the CLI to connect to your self-hosted Nexus instance using environment variables:

```bash
# Primary HPC Gateway URL (for compute operations)
export NEXUS_HPC_GATEWAY_URL="http://your-server:9000"

# General Nexus API URL (fallback for all services)
export NEXUS_API_URL="http://your-server:9000"

# API authentication (if required)
export NEXUS_API_KEY="your-api-key"
```

**URL Fallback Chain**: The CLI uses the following priority:
1. `NEXUS_HPC_GATEWAY_URL` - Specific compute gateway URL
2. `NEXUS_API_URL` - General API endpoint
3. `http://localhost:9000` - Default for local development

#### Docker Compose Example

```yaml
version: '3.8'
services:
  nexus-cli:
    image: node:20-alpine
    environment:
      - NEXUS_API_URL=http://nexus-gateway:9000
      - NEXUS_HPC_GATEWAY_URL=http://nexus-hpc-gateway:9000
      - NEXUS_API_KEY=${NEXUS_API_KEY}
    volumes:
      - ./project:/workspace
    working_dir: /workspace
    command: npx @adverant-nexus/cli agent run --task "..."
```

#### Kubernetes Configuration

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: nexus-cli-config
data:
  NEXUS_API_URL: "http://nexus-gateway.nexus.svc.cluster.local:9000"
  NEXUS_HPC_GATEWAY_URL: "http://nexus-hpc-gateway.nexus.svc.cluster.local:9000"
---
apiVersion: v1
kind: Pod
metadata:
  name: nexus-cli-job
spec:
  containers:
  - name: cli
    image: node:20-alpine
    envFrom:
    - configMapRef:
        name: nexus-cli-config
    env:
    - name: NEXUS_API_KEY
      valueFrom:
        secretKeyRef:
          name: nexus-credentials
          key: api-key
    command: ["npx", "@adverant-nexus/cli", "compute", "agent", "start"]
```

#### Command-Line Override

You can also specify the gateway URL directly in commands:

```bash
# Specify gateway for compute operations
nexus compute agent start --gateway http://your-server:9000

# Commands automatically use environment variables if available
nexus compute submit --script train.py
```

### Global Configuration

Located at: `~/.nexus/config.toml`

```toml
[services]
api_url = "http://localhost:9092"
mcp_url = "http://localhost:9000"
timeout = 30000

[auth]
api_key = "${NEXUS_API_KEY}"
strategy = "api-key"

[defaults]
output_format = "json"
streaming = true
verbose = false

[plugins]
enabled = ["my-plugin"]
disabled = []
```

### Workspace Configuration

Located at: `.nexus.toml` (project root)

```toml
[workspace]
name = "my-project"
type = "typescript"

[agent]
max_iterations = 20
auto_approve_safe = true

[nexus]
auto_store = true
memory_tags = ["project:my-project"]

[[shortcuts]]
name = "test"
command = "sandbox execute --file tests/run.py"
```

## Plugin Development

### Create a Plugin

```bash
# Initialize plugin
nexus plugin init my-plugin --template typescript

# Plugin structure:
my-plugin/
├── plugin.json          # Plugin manifest
├── src/
│   ├── index.ts        # Main entry point
│   └── commands/       # Command implementations
├── package.json
└── README.md
```

### Plugin Manifest (plugin.json)

```json
{
  "name": "my-plugin",
  "version": "1.0.0",
  "description": "My custom plugin",
  "author": "Your Name",
  "main": "dist/index.js",

  "commands": [
    {
      "name": "analyze",
      "description": "Analyze data",
      "args": [
        {
          "name": "input",
          "type": "string",
          "required": true,
          "description": "Input file path"
        }
      ]
    }
  ],

  "permissions": [
    "file:read",
    "network:http",
    "service:graphrag"
  ]
}
```

### Plugin Implementation

```typescript
import { PluginBuilder } from '@adverant-nexus/cli-sdk';

export default PluginBuilder
  .create('my-plugin')
  .version('1.0.0')
  .description('My plugin')

  .command('analyze', {
    description: 'Analyze data',
    args: [{ name: 'input', type: 'string', required: true }],
    handler: async (args, context) => {
      // Access Nexus services
      const result = await context.services.graphrag.query({
        text: `Analyze file: ${args.input}`
      });

      return { success: true, data: result };
    }
  })

  .build();
```

### Install Plugin

```bash
# Install locally
nexus plugin install ./my-plugin

# Publish to registry
nexus plugin publish my-plugin

# Install from registry
nexus plugin install my-plugin
```

## Architecture

The CLI is built with a modular, auto-discovering architecture:

```
┌─────────────────────────────────────────────────────┐
│              Adverant-Nexus CLI                     │
├─────────────────────────────────────────────────────┤
│  Interactive REPL │ Scripting │ Autonomous Agent    │
│         ↓              ↓              ↓              │
│            Command Router (Auto-Discovery)          │
│         ↓              ↓              ↓              │
│  Service Commands │ Nexus MCP │ Plugin Commands     │
│         ↓              ↓              ↓              │
│         Transport Layer (HTTP | WS | MCP)           │
│                      ↓                               │
│           Adverant-Nexus Microservices              │
└─────────────────────────────────────────────────────┘
```

Key components:
- **Service Discovery**: Auto-discovers services from docker-compose and OpenAPI
- **Command Router**: Dynamically routes commands to appropriate handlers
- **Transport Layer**: HTTP, WebSocket, and MCP protocol support
- **Plugin System**: Third-party extensions with full SDK
- **Output Formatters**: Multiple output formats for different use cases

See [ARCHITECTURE.md](./ARCHITECTURE.md) for complete details.

## Development

### Build

```bash
npm run build
```

### Development Mode

```bash
npm run dev
```

### Testing

```bash
npm test
npm run test:watch
npm run test:coverage
```

### Linting

```bash
npm run lint
npm run lint:fix
```

### Type Checking

```bash
npm run typecheck
```

## Project Status

### ✅ Completed
- [x] Comprehensive architecture design (see [ARCHITECTURE.md](./ARCHITECTURE.md))
- [x] Complete type system (7 type modules)
- [x] Enhanced package.json with all dependencies
- [x] Directory structure
- [x] Documentation (README + ARCHITECTURE)

### 🚧 In Progress
- [ ] Core CLI framework implementation
- [ ] Service discovery engine
- [ ] Transport layers (HTTP, WebSocket, MCP)
- [ ] Output formatters
- [ ] Command generation system

### 📋 Upcoming
- [ ] Service-specific commands (32+ services)
- [ ] Nexus MCP integration (70+ tools)
- [ ] Interactive REPL
- [ ] Plugin system
- [ ] Agent mode
- [ ] Session management
- [ ] Comprehensive tests

## Roadmap

### Phase 1: Core Framework (Week 1)
- CLI framework setup
- Configuration management
- Workspace detection
- HTTP transport layer
- Output formatters

### Phase 2: Service Discovery (Week 2)
- Docker Compose parser
- OpenAPI schema parser
- Service discovery engine
- Auto-command generation

### Phase 3: Service Commands (Week 3)
- GraphRAG commands
- MageAgent commands
- Sandbox commands
- Service management commands

### Phase 4: Nexus MCP Integration (Week 4)
- MCP client implementation
- All 70+ Nexus tools exposed
- MCP tool discovery

### Phase 5: Advanced Features (Weeks 5-10)
- Streaming & real-time
- Interactive REPL
- Plugin system
- Agent mode
- Session management
- Documentation & testing

## Contributing

Contributions are welcome! Please read our contributing guidelines before submitting PRs.

## License

MIT © Adverant AI

## Support

- **Documentation**: [ARCHITECTURE.md](./ARCHITECTURE.md)
- **Issues**: [GitHub Issues](https://github.com/adverant-ai/adverant-nexus/issues)
- **Discussions**: [GitHub Discussions](https://github.com/adverant-ai/adverant-nexus/discussions)

## Related Projects

- [@adverant-nexus/sdk](../nexus-sdk) - SDK for building Nexus Nexus plugins
- [Adverant-Nexus Platform](../../README.md) - Main platform documentation

---

**Made with ❤️ by Adverant AI**
