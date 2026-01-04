# Adverant-Nexus CLI Architecture

**Version**: 2.0.0
**Goal**: Build a production-grade CLI that surpasses Claude Code CLI and Gemini CLI

---

## Design Philosophy

The Adverant-Nexus CLI is designed with these core principles:

1. **Auto-Discovery**: Automatically discovers and integrates with all microservices and plugins
2. **Future-Proof**: New services and plugins are automatically supported without code changes
3. **Unified Interface**: Single CLI for all 32+ microservices, 500+ API endpoints
4. **Developer-First**: Optimized for both interactive exploration and scripting/automation
5. **Extensible**: Plugin system allows third-party extensions
6. **Intelligent**: Built-in ReAct loop for autonomous task execution

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                      Adverant-Nexus CLI (nexus)                 │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  ┌───────────────┐  ┌──────────────┐  ┌──────────────────┐   │
│  │  Interactive  │  │   Scripting  │  │  Autonomous      │   │
│  │  REPL Mode    │  │   Mode       │  │  Agent Mode      │   │
│  └───────┬───────┘  └──────┬───────┘  └────────┬─────────┘   │
│          │                  │                    │              │
│          └──────────────────┴────────────────────┘              │
│                              │                                  │
│                    ┌─────────▼───────────┐                     │
│                    │   Command Router    │                     │
│                    │   (Auto-Discovery)  │                     │
│                    └─────────┬───────────┘                     │
│                              │                                  │
│         ┌────────────────────┼────────────────────┐            │
│         │                    │                    │            │
│  ┌──────▼────────┐  ┌───────▼────────┐  ┌───────▼────────┐  │
│  │   Service     │  │    Nexus MCP   │  │    Plugin      │  │
│  │   Commands    │  │    Commands    │  │    Commands    │  │
│  │   (32 svcs)   │  │    (70+ tools) │  │   (Dynamic)    │  │
│  └──────┬────────┘  └───────┬────────┘  └───────┬────────┘  │
│         │                    │                    │            │
│         └────────────────────┼────────────────────┘            │
│                              │                                  │
│                    ┌─────────▼───────────┐                     │
│                    │  Transport Layer    │                     │
│                    │  HTTP | WS | MCP    │                     │
│                    └─────────┬───────────┘                     │
└──────────────────────────────┼──────────────────────────────────┘
                               │
                    ┌──────────▼───────────┐
                    │  Adverant-Nexus      │
                    │  Microservices       │
                    │  (32+ services)      │
                    └──────────────────────┘
```

---

## Core Components

### 1. Command Router (Auto-Discovery Engine)

**Responsibilities:**
- Scan docker-compose.yml to discover all services
- Query service /health and /openapi endpoints for API schemas
- Auto-generate command namespaces from service metadata
- Dynamically load plugin commands from ~/.nexus/plugins/
- Route commands to appropriate handlers

**Discovery Sources:**
```typescript
interface DiscoverySource {
  dockerCompose: {
    path: string[];                // Multiple compose files
    services: ServiceMetadata[];   // Parsed services
  };
  serviceSchemas: {
    openapi: OpenAPISpec[];        // Auto-discovered OpenAPI schemas
    graphql: GraphQLSchema[];      // Auto-discovered GraphQL schemas
  };
  mcpTools: {
    tools: MCPToolDefinition[];    // From nexus-mcp-server
    count: number;                 // 70+ Nexus tools
  };
  plugins: {
    local: Plugin[];               // From ~/.nexus/plugins/
    registered: Plugin[];          // From plugin registry
  };
}
```

**Auto-Generation Strategy:**
1. **Service Commands**: `nexus <service> <action> [args]`
   - Example: `nexus graphrag store-document --file report.pdf`
   - Example: `nexus mageagent orchestrate --task "Build a web scraper"`

2. **Nexus MCP Commands**: `nexus nexus <tool-name> [args]`
   - Example: `nexus nexus recall-memory --query "typescript patterns"`
   - Example: `nexus nexus code-validate --file app.ts --risk-level high`

3. **Plugin Commands**: `nexus plugin <plugin-name> <action> [args]`
   - Example: `nexus plugin my-custom-tool analyze --input data.json`

### 2. Service Commands (Namespace per Service)

**Structure:**
```
nexus/
├── commands/
│   ├── graphrag/          # GraphRAG service commands
│   │   ├── store-document.ts
│   │   ├── query.ts
│   │   ├── store-entity.ts
│   │   └── index.ts
│   ├── mageagent/         # MageAgent service commands
│   │   ├── orchestrate.ts
│   │   ├── analyze.ts
│   │   ├── validate.ts
│   │   └── index.ts
│   ├── sandbox/           # Sandbox service commands
│   │   ├── execute.ts
│   │   ├── list-languages.ts
│   │   └── index.ts
│   ├── videoagent/        # VideoAgent service commands
│   ├── geoagent/          # GeoAgent service commands
│   ├── orchestration/     # OrchestrationAgent commands
│   ├── learning/          # LearningAgent commands
│   ├── robotics/          # NexusRobotics commands
│   └── ... (32 total service namespaces)
```

**Auto-Generated from OpenAPI:**
Each service with an OpenAPI spec gets commands auto-generated:
```typescript
// Example: GraphRAG /documents endpoint → nexus graphrag store-document
interface ServiceCommand {
  name: string;                    // "store-document"
  namespace: string;               // "graphrag"
  endpoint: string;                // "POST /documents"
  params: ParameterSchema[];       // Auto-generated from OpenAPI
  examples: string[];              // Generated examples
  streaming: boolean;              // WebSocket support
}
```

### 3. Nexus MCP Commands

**All 70+ Nexus Tools Exposed:**
```bash
# Memory Operations
nexus nexus store-memory --content "..." --tags "tag1,tag2"
nexus nexus recall-memory --query "search query" --limit 10
nexus nexus store-document --file report.pdf --title "..."
nexus nexus retrieve --query "..." --strategy semantic_chunks

# Knowledge Graph
nexus nexus store-entity --domain code --type class --content "..."
nexus nexus query-entities --domain code --search "User"
nexus nexus create-relationship --source id1 --target id2 --type REFERENCES

# Code Analysis
nexus nexus validate-code --file app.ts --risk-level high --wait
nexus nexus analyze-code --file app.ts --depth deep --focus security,performance
nexus nexus validate-command --command "rm -rf /" --cwd /tmp

# Multi-Agent Orchestration
nexus nexus orchestrate --task "Analyze codebase for security issues" --max-agents 5
nexus nexus get-suggestions --context-id ctx_123

# Learning System
nexus nexus trigger-learning --topic "rust_async" --priority 9
nexus nexus recall-knowledge --topic "typescript_patterns" --layer EXPERT

# Episodes
nexus nexus store-episode --content "Fixed memory leak" --type insight
nexus nexus recall-episodes --query "refactoring sessions" --limit 10

# Health & Status
nexus nexus health --detailed
nexus nexus ingestion-status --job-id job_123
```

### 4. Plugin System

**Plugin Architecture:**
```typescript
interface NexusPlugin {
  name: string;
  version: string;
  description: string;
  author: string;

  // Plugin metadata
  commands: PluginCommand[];       // Commands exposed by plugin
  dependencies: string[];          // Required services
  permissions: Permission[];       // What plugin can access

  // Lifecycle hooks
  onLoad?: () => Promise<void>;
  onUnload?: () => Promise<void>;
  onCommand?: (cmd: Command) => Promise<Result>;

  // MCP integration
  mcpServer?: MCPServerConfig;     // Optional MCP server
}

interface PluginCommand {
  name: string;
  description: string;
  args: ArgumentSchema[];
  handler: (args: any, context: Context) => Promise<any>;
}
```

**Plugin Discovery:**
```
~/.nexus/
├── plugins/
│   ├── my-custom-plugin/
│   │   ├── plugin.json          # Plugin manifest
│   │   ├── commands/            # Command implementations
│   │   └── mcp/                 # Optional MCP server
│   └── another-plugin/
└── config.toml                  # Global CLI config
```

**Plugin Loading:**
1. Scan ~/.nexus/plugins/ for plugin.json manifests
2. Validate plugin permissions and dependencies
3. Dynamically load command handlers
4. Register commands in router
5. Start MCP servers if defined

### 5. Interactive REPL Mode

**Features:**
- **Tab Completion**: Auto-complete for all commands, services, and options
- **Command History**: Up/down arrows for history navigation
- **Context Awareness**: Remembers workspace, current service, etc.
- **Multiline Input**: Support for complex queries
- **Rich Output**: Tables, JSON, YAML, streaming progress
- **Session Checkpointing**: Save/resume sessions

**REPL Commands:**
```bash
nexus repl                       # Start interactive mode

# Inside REPL:
> help                           # Show all commands
> services                       # List all discovered services
> use graphrag                   # Switch to graphrag namespace
> store-document --file x.pdf    # Execute in current namespace
> history                        # Show command history
> save session-1                 # Save current session
> load session-1                 # Resume saved session
> config show                    # Show current configuration
> plugins list                   # List installed plugins
> exit                           # Exit REPL
```

### 6. Scripting Mode

**Headless Execution for CI/CD:**
```bash
# Non-interactive execution
nexus graphrag store-document --file report.pdf --title "Q4 Report"

# JSON output for parsing
nexus mageagent orchestrate \
  --task "Analyze codebase" \
  --output-format json \
  > result.json

# Streaming JSON for real-time monitoring
nexus videoagent process-video \
  --url "video.mp4" \
  --output-format stream-json \
  | jq '.progress'

# Pipe-friendly operations
cat files.txt | xargs -I {} nexus graphrag store-document --file {}

# Environment variable configuration
NEXUS_API_URL=http://localhost:9092 \
NEXUS_API_KEY=key_123 \
nexus mageagent orchestrate --task "..."

# Exit codes for error handling
nexus sandbox execute --code "print('hello')" --language python
echo $?  # 0 = success, non-zero = error
```

### 7. Autonomous Agent Mode

**ReAct Loop Integration:**
```bash
# Autonomous task execution with ReAct loop
nexus agent run --task "Fix all TypeScript errors in the project"

# With constraints
nexus agent run \
  --task "Implement user authentication" \
  --max-iterations 20 \
  --budget 50 \
  --workspace /path/to/project \
  --approve-commands  # Auto-approve safe commands

# Interactive approval mode (default)
nexus agent run --task "Refactor database schema"
# Prompts for approval at each step

# Streaming progress
nexus agent run \
  --task "Analyze security vulnerabilities" \
  --stream \
  --output-format stream-json
```

**ReAct Implementation:**
- Uses OrchestrationAgent (port 9109) for autonomous execution
- 20-iteration ReAct loop with thought-action-observation
- Integrated with all 70+ Nexus tools
- Codebase-aware planning
- Real-time streaming updates via WebSocket

### 8. Service Management Commands

**Infrastructure Control:**
```bash
# Service discovery
nexus services list                    # List all discovered services
nexus services status                  # Health status of all services
nexus services info <service>          # Detailed service info

# Container management (via docker-compose)
nexus services start [service]         # Start service(s)
nexus services stop [service]          # Stop service(s)
nexus services restart [service]       # Restart service(s)
nexus services logs <service> [--follow]  # View service logs

# Health monitoring
nexus services health --all            # Check all service health
nexus services health graphrag         # Check specific service
nexus services ping <service>          # Quick ping test

# Port mapping
nexus services ports                   # Show all port mappings
nexus services ports graphrag          # Show specific service ports

# Service details
nexus services env <service>           # Show environment variables
nexus services volumes                 # Show volume mappings
nexus services networks                # Show network configuration
```

### 9. Configuration Management

**Workspace-Aware Configuration:**
```
.nexus.toml                    # Project-specific config (like .claude/config)
~/.nexus/config.toml           # Global user config
~/.nexus/profiles/             # Multiple profile support
```

**Configuration Schema:**
```toml
# .nexus.toml - Project configuration

[workspace]
name = "my-project"
type = "typescript"            # Auto-detection available

[services]
api_url = "http://localhost:9092"
mcp_url = "http://localhost:9000"
timeout = 30000

[auth]
api_key = "${NEXUS_API_KEY}"   # Environment variable support
strategy = "api-key"           # api-key | oauth | jwt

[defaults]
output_format = "json"         # text | json | yaml | table | stream-json
streaming = true
verbose = false

[agent]
max_iterations = 20
auto_approve_safe = true
workspace = "."

[plugins]
enabled = ["my-plugin", "another-plugin"]
disabled = []

[nexus]
auto_store = true              # Auto-store results to Nexus
memory_tags = ["project:my-project"]

[[shortcuts]]
name = "qa"
command = "mageagent orchestrate --task 'Run quality analysis'"

[[shortcuts]]
name = "test"
command = "sandbox execute --file tests/run.py"
```

**Profile Management:**
```bash
nexus config list                      # Show current config
nexus config get services.api_url      # Get specific value
nexus config set defaults.output_format json
nexus config profiles list             # List all profiles
nexus config profiles use production   # Switch profile
nexus config init                      # Initialize .nexus.toml in current dir
```

### 10. Output Formats

**Multiple Output Modes:**
```bash
# Text output (default, human-readable)
nexus graphrag query --text "user authentication"

# JSON output (machine-parseable)
nexus mageagent orchestrate --task "..." --output-format json

# Streaming JSON (real-time events)
nexus videoagent process --url video.mp4 --output-format stream-json

# YAML output
nexus services list --output-format yaml

# Table output
nexus services status --output-format table
┌─────────────┬─────────┬────────────┬─────────┐
│ Service     │ Status  │ Health     │ Port    │
├─────────────┼─────────┼────────────┼─────────┤
│ graphrag    │ running │ healthy    │ 9090    │
│ mageagent   │ running │ healthy    │ 9080    │
│ sandbox     │ stopped │ -          │ -       │
└─────────────┴─────────┴────────────┴─────────┘

# Quiet mode (minimal output)
nexus sandbox execute --code "..." --quiet

# Verbose mode (debug info)
nexus mageagent orchestrate --task "..." --verbose
```

### 11. Streaming & Progress Tracking

**Real-Time Operations:**
```typescript
interface StreamingResponse {
  type: 'progress' | 'result' | 'error' | 'complete';
  timestamp: string;
  data: any;
  metadata?: {
    progress?: number;        // 0-100
    step?: string;
    eta?: number;
  };
}
```

**Streaming Commands:**
```bash
# WebSocket streaming with progress
nexus videoagent process-video --url video.mp4 --stream
⚙️  Processing frame 120/500 (24%)
⚙️  Processing frame 240/500 (48%)
⚙️  Processing frame 360/500 (72%)
✅ Complete: 500 frames processed

# Multi-agent orchestration with live updates
nexus nexus orchestrate --task "Analyze codebase" --stream
🤖 Agent spawned: security-analyst
⚙️  security-analyst: Scanning for SQL injection...
🤖 Agent spawned: performance-analyst
⚙️  performance-analyst: Profiling database queries...
✅ security-analyst complete: 3 findings
✅ performance-analyst complete: 5 recommendations
🎉 Orchestration complete: 8 total findings

# File ingestion with streaming
nexus graphrag ingest-folder --path ./docs/ --stream
⚙️  Discovered 150 files (45.2 MB)
⚙️  Processing file 30/150: guide.pdf
⚙️  Processing file 60/150: api-docs.md
✅ Complete: 150 files indexed
```

### 12. Context & Workspace Awareness

**Auto-Detection:**
```typescript
interface WorkspaceContext {
  cwd: string;
  projectType: 'typescript' | 'python' | 'go' | 'rust' | 'unknown';
  gitRepo: boolean;
  gitBranch?: string;
  dockerCompose: string[];     // Detected compose files
  nexusConfig: Config | null;  // .nexus.toml if exists

  // Service availability detection
  servicesAvailable: ServiceStatus[];
  nexusHealthy: boolean;
}
```

**Workspace Commands:**
```bash
# Workspace detection
nexus workspace info              # Show detected workspace info
nexus workspace init              # Initialize .nexus.toml
nexus workspace validate          # Validate configuration

# Git integration
nexus workspace git-status        # Show git status
nexus workspace git-diff          # Show changes (like Claude)
nexus workspace git-commit        # Commit with AI-generated message

# Service detection
nexus workspace services          # Show available services in workspace
nexus workspace docker-compose    # Show detected compose files
```

### 13. Help System (Auto-Generated)

**Comprehensive Documentation:**
```bash
# Global help
nexus --help
nexus -h

# Service-specific help
nexus graphrag --help
nexus graphrag store-document --help

# Nexus tool help
nexus nexus --help
nexus nexus recall-memory --help

# Plugin help
nexus plugin --help
nexus plugin my-plugin analyze --help

# Examples
nexus graphrag store-document --examples
nexus mageagent orchestrate --examples

# Interactive help (REPL mode)
> help graphrag
> help nexus orchestrate
> docs graphrag                  # Open service documentation
```

**Auto-Generated from Schemas:**
- Service help from OpenAPI specs
- Nexus tool help from MCP tool definitions
- Plugin help from plugin manifests
- Rich formatting with examples

### 14. Session Management

**Checkpointing Like Gemini:**
```bash
# Save current session
nexus session save my-session
nexus session save --auto       # Auto-generate name with timestamp

# List sessions
nexus session list

# Resume session
nexus session load my-session
nexus session resume            # Resume last session

# Session info
nexus session info my-session

# Delete session
nexus session delete my-session

# Export/import
nexus session export my-session > session.json
nexus session import < session.json
```

**Session Data:**
```typescript
interface Session {
  id: string;
  name: string;
  timestamp: Date;
  context: WorkspaceContext;
  history: Command[];
  results: Result[];
  nexusMemories: string[];      // Linked Nexus memory IDs
}
```

### 15. Advanced Features

#### A. Batch Operations
```bash
# Bulk document ingestion
nexus graphrag ingest-batch --files docs/*.pdf

# Parallel execution
nexus parallel \
  "nexus graphrag store-document --file {}" \
  docs/*.pdf

# Queue-based processing
nexus queue add "mageagent orchestrate --task 'Task 1'"
nexus queue add "mageagent orchestrate --task 'Task 2'"
nexus queue process --concurrency 3
```

#### B. Pipeline Support
```bash
# Pipe commands together
nexus graphrag query --text "user auth" --output-format json \
  | nexus mageagent analyze --input - \
  | jq '.recommendations'

# Custom pipelines
nexus pipeline create my-pipeline \
  --step "graphrag query" \
  --step "mageagent analyze" \
  --step "nexus store-document"

nexus pipeline run my-pipeline --input query.txt
```

#### C. Aliases & Shortcuts
```bash
# Create aliases
nexus alias create qa "mageagent orchestrate --task 'Quality analysis'"
nexus qa                         # Runs the alias

# Custom shortcuts (from .nexus.toml)
nexus @test                      # Runs configured test shortcut
nexus @deploy                    # Runs configured deploy shortcut
```

#### D. Watch Mode
```bash
# Watch files and execute on change
nexus watch "src/**/*.ts" \
  --exec "sandbox execute --file {file}"

# Watch service health
nexus watch-health --all --interval 5s
```

#### E. Notifications
```bash
# Send notifications on completion
nexus mageagent orchestrate --task "..." --notify slack
nexus mageagent orchestrate --task "..." --notify email
nexus mageagent orchestrate --task "..." --notify webhook:https://...
```

---

## Command Line Syntax

**General Structure:**
```bash
nexus [global-options] <command> [command-options] [arguments]
```

**Global Options:**
```bash
--config <path>           # Use specific config file
--profile <name>          # Use specific profile
--output-format <format>  # Output format (text|json|yaml|table|stream-json)
--verbose, -v             # Verbose output
--quiet, -q               # Minimal output
--no-color                # Disable colors
--help, -h                # Show help
--version, -V             # Show version
--timeout <ms>            # Request timeout
--retries <n>             # Number of retries
```

**Common Patterns:**
```bash
# Service namespace pattern
nexus <service> <action> [options]

# Nexus tool pattern
nexus nexus <tool> [options]

# Plugin pattern
nexus plugin <plugin> <action> [options]

# Service management pattern
nexus services <action> [service]

# Agent pattern
nexus agent <action> [options]

# Session pattern
nexus session <action> [name]
```

---

## Technology Stack

### Core Framework
- **Commander.js 11.x**: CLI framework with subcommands
- **Inquirer.js 9.x**: Interactive prompts
- **Ora 8.x**: Spinners and progress indicators
- **Chalk 5.x**: Terminal colors and formatting
- **Table 6.x**: Table formatting
- **Boxen 7.x**: Boxed messages

### Networking
- **Axios 1.6.x**: HTTP client for REST APIs
- **Socket.IO Client 4.x**: WebSocket client for streaming
- **@modelcontextprotocol/sdk 0.5.x**: MCP protocol support

### Parsing & Validation
- **Zod 3.x**: Schema validation
- **YAML 2.x**: YAML parsing
- **js-yaml 4.x**: YAML serialization
- **dotenv 16.x**: Environment variable management

### Auto-Discovery
- **OpenAPI Parser**: Parse OpenAPI 3.x specs
- **GraphQL Tools**: Parse GraphQL schemas
- **Docker Compose Parser**: Parse compose YAML
- **Glob 10.x**: File pattern matching

### Development
- **TypeScript 5.3.x**: Type safety
- **TSX**: TypeScript execution
- **ESLint + Prettier**: Code quality
- **Jest 29.x**: Testing framework
- **Vitest**: Fast unit tests

### Utilities
- **fs-extra 11.x**: Enhanced file operations
- **chokidar 3.x**: File watching
- **execa 8.x**: Process execution
- **p-queue 8.x**: Promise queue for concurrency control
- **conf 12.x**: Configuration management

---

## Project Structure

```
packages/nexus-cli/
├── src/
│   ├── index.ts                      # Main entry point
│   ├── cli.ts                        # CLI setup and routing
│   │
│   ├── core/
│   │   ├── discovery/
│   │   │   ├── service-discovery.ts  # Auto-discover services
│   │   │   ├── docker-parser.ts      # Parse docker-compose.yml
│   │   │   ├── openapi-parser.ts     # Parse OpenAPI schemas
│   │   │   ├── mcp-discovery.ts      # Discover MCP tools
│   │   │   └── plugin-discovery.ts   # Discover plugins
│   │   │
│   │   ├── router/
│   │   │   ├── command-router.ts     # Route commands
│   │   │   ├── namespace-manager.ts  # Manage namespaces
│   │   │   └── command-registry.ts   # Command registration
│   │   │
│   │   ├── transport/
│   │   │   ├── http-client.ts        # HTTP transport
│   │   │   ├── websocket-client.ts   # WebSocket transport
│   │   │   ├── mcp-client.ts         # MCP transport
│   │   │   └── stream-handler.ts     # Streaming response handler
│   │   │
│   │   ├── config/
│   │   │   ├── config-manager.ts     # Configuration management
│   │   │   ├── workspace-detector.ts # Detect workspace context
│   │   │   └── profile-manager.ts    # Profile management
│   │   │
│   │   └── session/
│   │       ├── session-manager.ts    # Session checkpointing
│   │       ├── history-manager.ts    # Command history
│   │       └── context-manager.ts    # Context persistence
│   │
│   ├── commands/
│   │   ├── services/                 # Service management commands
│   │   │   ├── list.ts
│   │   │   ├── status.ts
│   │   │   ├── start.ts
│   │   │   ├── stop.ts
│   │   │   ├── logs.ts
│   │   │   └── health.ts
│   │   │
│   │   ├── agent/                    # Autonomous agent commands
│   │   │   ├── run.ts
│   │   │   └── status.ts
│   │   │
│   │   ├── session/                  # Session management
│   │   │   ├── save.ts
│   │   │   ├── load.ts
│   │   │   ├── list.ts
│   │   │   └── delete.ts
│   │   │
│   │   ├── workspace/                # Workspace commands
│   │   │   ├── info.ts
│   │   │   ├── init.ts
│   │   │   └── validate.ts
│   │   │
│   │   ├── config/                   # Configuration commands
│   │   │   ├── list.ts
│   │   │   ├── get.ts
│   │   │   ├── set.ts
│   │   │   └── profiles.ts
│   │   │
│   │   └── dynamic/                  # Dynamically generated commands
│   │       ├── service-commands.ts   # Service-specific commands
│   │       ├── nexus-commands.ts     # Nexus MCP commands
│   │       └── plugin-commands.ts    # Plugin commands
│   │
│   ├── repl/
│   │   ├── repl.ts                   # Interactive REPL
│   │   ├── completer.ts              # Tab completion
│   │   ├── evaluator.ts              # Command evaluation
│   │   └── renderer.ts               # Output rendering
│   │
│   ├── plugins/
│   │   ├── plugin-loader.ts          # Plugin loading
│   │   ├── plugin-validator.ts       # Plugin validation
│   │   ├── plugin-manager.ts         # Plugin management
│   │   └── plugin-sdk.ts             # Plugin SDK
│   │
│   ├── output/
│   │   ├── formatters/
│   │   │   ├── text-formatter.ts
│   │   │   ├── json-formatter.ts
│   │   │   ├── yaml-formatter.ts
│   │   │   ├── table-formatter.ts
│   │   │   └── stream-formatter.ts
│   │   │
│   │   ├── renderers/
│   │   │   ├── terminal-renderer.ts
│   │   │   ├── progress-renderer.ts
│   │   │   └── stream-renderer.ts
│   │   │
│   │   └── output-manager.ts
│   │
│   ├── utils/
│   │   ├── logger.ts
│   │   ├── spinner.ts
│   │   ├── prompt.ts
│   │   ├── validation.ts
│   │   ├── error-handler.ts
│   │   └── retry.ts
│   │
│   └── types/
│       ├── service.ts
│       ├── command.ts
│       ├── config.ts
│       ├── plugin.ts
│       └── session.ts
│
├── tests/
│   ├── unit/
│   ├── integration/
│   └── e2e/
│
├── templates/
│   ├── plugin-template/             # Plugin template
│   └── workspace-template/          # Workspace template
│
├── docs/
│   ├── commands/                    # Command documentation
│   ├── plugins/                     # Plugin development guide
│   ├── examples/                    # Usage examples
│   └── api/                         # API documentation
│
├── package.json
├── tsconfig.json
├── ARCHITECTURE.md                  # This file
└── README.md
```

---

## Command Examples

### Service Commands
```bash
# GraphRAG
nexus graphrag store-document --file report.pdf --title "Q4 Report"
nexus graphrag query --text "user authentication patterns"
nexus graphrag store-entity --domain code --type class --content "User"
nexus graphrag health --detailed

# MageAgent
nexus mageagent orchestrate --task "Analyze codebase for security issues"
nexus mageagent analyze --input code.ts --focus security
nexus mageagent collaborate --agents 3 --task "Build API"

# Sandbox
nexus sandbox execute --code "print('hello')" --language python
nexus sandbox execute --file script.py --stream
nexus sandbox list-languages

# VideoAgent
nexus videoagent process-video --url video.mp4 --extract-scenes --stream
nexus videoagent analyze-frame --file frame.jpg

# GeoAgent
nexus geoagent proximity-search --lat 37.7749 --lon -122.4194 --radius 10km
nexus geoagent create-geofence --bounds "[[...]]" --name "san-francisco"

# OrchestrationAgent
nexus orchestration run --task "Implement user auth" --max-iterations 20
nexus orchestration status --id task_123

# LearningAgent
nexus learning trigger --topic "rust_async" --priority 9
nexus learning recall --topic "typescript_patterns" --layer EXPERT
```

### Nexus Commands
```bash
# Memory
nexus nexus store-memory --content "User prefers TypeScript" --tags "preferences"
nexus nexus recall-memory --query "typescript patterns" --limit 10

# Documents
nexus nexus store-document --file report.pdf --type code
nexus nexus retrieve --query "authentication" --strategy hybrid

# Knowledge Graph
nexus nexus store-entity --domain code --type function --content "authenticate()"
nexus nexus query-entities --domain code --search "auth"
nexus nexus create-relationship --source ent_1 --target ent_2 --type CALLS

# Code Analysis
nexus nexus validate-code --file app.ts --risk-level high
nexus nexus analyze-code --file app.ts --focus security,performance

# Multi-Agent
nexus nexus orchestrate --task "Security audit" --max-agents 5
nexus nexus get-suggestions --context-id ctx_123

# Learning
nexus nexus trigger-learning --topic "rust_concurrency" --priority 8
nexus nexus recall-knowledge --topic "async_patterns" --layer EXPERT

# Episodes
nexus nexus store-episode --content "Fixed memory leak" --type insight
nexus nexus recall-episodes --query "debugging sessions" --limit 5

# Health
nexus nexus health --detailed
nexus nexus ingestion-status --job-id job_123
```

### Service Management
```bash
# List and status
nexus services list
nexus services status
nexus services info graphrag

# Control
nexus services start graphrag
nexus services stop mageagent
nexus services restart sandbox

# Monitoring
nexus services logs graphrag --follow
nexus services health --all
nexus services ports

# Docker operations
nexus services volumes
nexus services networks
nexus services env graphrag
```

### Agent Mode
```bash
# Autonomous execution
nexus agent run --task "Fix TypeScript errors"
nexus agent run --task "Implement auth" --max-iterations 20
nexus agent run --task "Security audit" --approve-commands

# With streaming
nexus agent run --task "Refactor codebase" --stream

# Status
nexus agent status --id agent_123
nexus agent list
```

### Session Management
```bash
# Save/load
nexus session save my-work
nexus session load my-work
nexus session resume

# List and info
nexus session list
nexus session info my-work

# Export/import
nexus session export my-work > session.json
nexus session import < session.json
```

### Workspace
```bash
# Info and setup
nexus workspace info
nexus workspace init
nexus workspace validate

# Git integration
nexus workspace git-status
nexus workspace git-diff
nexus workspace git-commit --message "Update docs"

# Service detection
nexus workspace services
nexus workspace docker-compose
```

### Configuration
```bash
# View config
nexus config list
nexus config get services.api_url
nexus config set defaults.output_format json

# Profiles
nexus config profiles list
nexus config profiles use production
nexus config profiles create staging

# Init
nexus config init
```

### REPL Mode
```bash
# Start REPL
nexus repl

# Inside REPL
> help
> services
> use graphrag
> store-document --file report.pdf
> history
> save session-1
> exit
```

---

## Plugin Development Guide

### Creating a Plugin

**1. Initialize Plugin:**
```bash
nexus plugin init my-plugin --template typescript
```

**2. Plugin Structure:**
```
my-plugin/
├── plugin.json              # Plugin manifest
├── src/
│   ├── index.ts            # Main entry point
│   ├── commands/           # Command implementations
│   │   ├── analyze.ts
│   │   └── report.ts
│   └── mcp/                # Optional MCP server
│       └── server.ts
├── package.json
└── README.md
```

**3. Plugin Manifest (plugin.json):**
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

  "dependencies": ["graphrag", "mageagent"],

  "permissions": [
    "file:read",
    "network:http",
    "service:graphrag"
  ],

  "mcp": {
    "enabled": true,
    "command": "node dist/mcp/server.js"
  }
}
```

**4. Implement Commands:**
```typescript
// src/commands/analyze.ts
import { Command, Context } from '@adverant-nexus/cli-sdk';

export const analyzeCommand: Command = {
  name: 'analyze',
  description: 'Analyze data',

  async execute(args, context: Context) {
    const { input } = args;

    // Access Nexus services via context
    const result = await context.services.graphrag.query({
      text: `Analyze file: ${input}`
    });

    return {
      success: true,
      data: result
    };
  }
};
```

**5. Register Plugin:**
```bash
# Install locally
nexus plugin install ./my-plugin

# Publish to registry
nexus plugin publish my-plugin

# Install from registry
nexus plugin install my-plugin
```

### Plugin SDK

**API:**
```typescript
import {
  Command,
  Context,
  Plugin,
  PluginBuilder
} from '@adverant-nexus/cli-sdk';

export default PluginBuilder
  .create('my-plugin')
  .version('1.0.0')
  .description('My plugin')

  .command('analyze', {
    description: 'Analyze data',
    args: [{
      name: 'input',
      type: 'string',
      required: true
    }],
    handler: async (args, context) => {
      // Implementation
    }
  })

  .onLoad(async (context) => {
    // Initialize plugin
  })

  .onUnload(async () => {
    // Cleanup
  })

  .build();
```

---

## Comparison: Adverant-Nexus CLI vs Claude Code vs Gemini CLI

| Feature | Adverant-Nexus CLI | Claude Code | Gemini CLI |
|---------|-------------------|-------------|------------|
| **Auto-Discovery** | ✅ All services & plugins | ❌ Manual | ❌ Manual |
| **Service Commands** | ✅ 32+ services | ❌ Single agent | ❌ Single agent |
| **Nexus Tools** | ✅ 70+ tools exposed | ❌ N/A | ❌ N/A |
| **Plugin System** | ✅ Full SDK | ✅ Skills | ✅ Extensions |
| **MCP Integration** | ✅ Native | ✅ Native | ✅ Native |
| **Interactive REPL** | ✅ Full-featured | ❌ Chat only | ✅ Yes |
| **Streaming** | ✅ WebSocket + SSE | ✅ Yes | ✅ Yes |
| **Output Formats** | ✅ 5 formats | ✅ Text + JSON | ✅ Text + JSON |
| **ReAct Agent** | ✅ 20 iterations | ✅ Task agent | ❌ No |
| **Session Checkpointing** | ✅ Yes | ❌ No | ✅ Yes |
| **Service Management** | ✅ Full control | ❌ N/A | ❌ N/A |
| **Workspace Detection** | ✅ Auto | ✅ Auto | ✅ Auto |
| **Pipeline Support** | ✅ Yes | ❌ No | ❌ No |
| **Batch Operations** | ✅ Yes | ❌ No | ❌ No |
| **Multi-Agent** | ✅ 10+ agents | ❌ Single | ❌ Single |
| **Code Validation** | ✅ 3 models | ❌ No | ❌ No |
| **Health Monitoring** | ✅ All services | ❌ N/A | ❌ N/A |
| **Git Integration** | ✅ Built-in | ✅ Built-in | ✅ Via extension |
| **Watch Mode** | ✅ Yes | ❌ No | ❌ No |
| **Notifications** | ✅ Multiple | ❌ No | ❌ No |

**Verdict**: Adverant-Nexus CLI is **more powerful and comprehensive** than both Claude Code and Gemini CLI.

---

## Implementation Roadmap

### Phase 1: Core Framework (Week 1)
- ✅ CLI framework setup (Commander.js)
- ✅ Configuration management
- ✅ Workspace detection
- ✅ HTTP transport layer
- ✅ Output formatters (text, JSON, YAML, table)
- ✅ Error handling

### Phase 2: Service Discovery (Week 2)
- ✅ Docker Compose parser
- ✅ OpenAPI schema parser
- ✅ Service discovery engine
- ✅ Auto-command generation
- ✅ Service health monitoring

### Phase 3: Service Commands (Week 3)
- ✅ GraphRAG commands
- ✅ MageAgent commands
- ✅ Sandbox commands
- ✅ Service management commands
- ✅ Dynamic command registration

### Phase 4: Nexus MCP Integration (Week 4)
- ✅ MCP client implementation
- ✅ All 70+ Nexus tools exposed
- ✅ MCP tool discovery
- ✅ MCP command generation

### Phase 5: Streaming & Real-Time (Week 5)
- ✅ WebSocket client
- ✅ Streaming response handler
- ✅ Progress tracking
- ✅ Stream-JSON output format

### Phase 6: Interactive REPL (Week 6)
- ✅ REPL implementation
- ✅ Tab completion
- ✅ Command history
- ✅ Multiline input
- ✅ Context awareness

### Phase 7: Plugin System (Week 7)
- ✅ Plugin loader
- ✅ Plugin SDK
- ✅ Plugin discovery
- ✅ Plugin validation
- ✅ Plugin registry integration

### Phase 8: Agent Mode (Week 8)
- ✅ OrchestrationAgent integration
- ✅ ReAct loop implementation
- ✅ Interactive approval mode
- ✅ Streaming agent progress

### Phase 9: Advanced Features (Week 9)
- ✅ Session management
- ✅ Batch operations
- ✅ Pipeline support
- ✅ Watch mode
- ✅ Notifications

### Phase 10: Documentation & Testing (Week 10)
- ✅ Comprehensive documentation
- ✅ Unit tests
- ✅ Integration tests
- ✅ E2E tests
- ✅ Examples and tutorials

---

## Success Metrics

### Functionality
- ✅ All 32+ services accessible via CLI
- ✅ All 70+ Nexus tools exposed
- ✅ Plugin system operational
- ✅ Auto-discovery working
- ✅ Streaming operations supported

### Performance
- ✅ Command execution < 100ms (cached)
- ✅ Service discovery < 2s
- ✅ Streaming latency < 50ms
- ✅ REPL response < 50ms

### Usability
- ✅ Comprehensive help system
- ✅ Tab completion for all commands
- ✅ Rich output formatting
- ✅ Error messages with suggestions
- ✅ Examples for every command

### Extensibility
- ✅ Plugin SDK documented
- ✅ Third-party plugins loadable
- ✅ Custom commands registrable
- ✅ Service schemas parseable

### Developer Experience
- ✅ TypeScript type safety
- ✅ 100% test coverage
- ✅ CI/CD pipeline
- ✅ Published to npm
- ✅ Docker image available

---

## Conclusion

The Adverant-Nexus CLI is designed to be:

1. **More Powerful**: Exposes all 32+ services and 70+ Nexus tools
2. **More Intelligent**: Built-in ReAct agent, multi-agent orchestration, code validation
3. **More Extensible**: Plugin system, auto-discovery, MCP integration
4. **More Productive**: Streaming, batch operations, pipelines, watch mode
5. **Future-Proof**: Auto-discovers new services and plugins without code changes

**It surpasses both Claude Code CLI and Gemini CLI** in functionality, extensibility, and intelligence while maintaining excellent developer experience.
