# Nexus MCP Tool Integration

## Overview

The Nexus CLI now exposes all 70+ Nexus MCP tools through a dynamic command generation system. This integration provides seamless access to Nexus's memory, knowledge graph, code analysis, multi-agent orchestration, and learning capabilities.

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    Nexus CLI (nexus)                        │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  ┌─────────────────────────────────────────────────────┐   │
│  │         Nexus Command Generator                      │   │
│  │  - Auto-discovers MCP tools                         │   │
│  │  - Generates CLI commands dynamically               │   │
│  │  - Maps tool schemas to CLI arguments               │   │
│  └────────────┬────────────────────────────────────────┘   │
│               │                                             │
│  ┌────────────▼──────────┐    ┌──────────────────────┐    │
│  │   MCP Tool Mapper     │    │  Nexus Tool Executor │    │
│  │  - Tool → Command     │    │  - Parameter         │    │
│  │  - Schema parsing     │    │    validation        │    │
│  │  - Category mapping   │    │  - Streaming support │    │
│  └───────────────────────┘    └──────────┬───────────┘    │
│                                           │                 │
│                               ┌───────────▼──────────┐     │
│                               │   Nexus Client       │     │
│                               │  - HTTP transport    │     │
│                               │  - Health checks     │     │
│                               │  - Operation queue   │     │
│                               │  - Auto-retry        │     │
│                               └───────────┬──────────┘     │
└─────────────────────────────────────────────┼──────────────┘
                                              │
                                ┌─────────────▼──────────┐
                                │  Nexus API Gateway     │
                                │  (Port 9092)           │
                                └────────────────────────┘
```

## Components

### 1. Nexus Client (`src/core/nexus-client.ts`)

Manages connections to the Nexus API Gateway with robust error handling and graceful degradation.

**Features:**
- HTTP transport with axios
- Automatic health checks (configurable interval)
- Operation queuing when Nexus unavailable
- Exponential backoff retry logic
- Event-driven architecture (EventEmitter)
- Queue processing on recovery

**Health Check System:**
```typescript
const health = await nexusClient.checkHealth(true);
// Returns: { graphrag, mageagent, learningagent }

// Events emitted:
// - 'health:degraded' - Nexus becomes unavailable
// - 'health:recovered' - Nexus comes back online
// - 'operation:queued' - Operation queued due to unavailability
// - 'queue:processing' - Processing queued operations
```

**Graceful Degradation:**
```
Normal Operation → Nexus Unavailable → Operations Queued → Nexus Recovers → Queue Processed
       ✅                  ⚠️                 📋                 ✅                ✅
```

### 2. MCP Tool Mapper (`src/commands/dynamic/mcp-tool-mapper.ts`)

Transforms MCP tool definitions into CLI command structures.

**Key Functions:**
- **Tool Name Conversion**: `nexus_store_memory` → `store-memory`
- **Category Inference**: Automatically categorizes tools (memory, documents, code-analysis, etc.)
- **Schema Parsing**: JSON Schema → CLI arguments/options
- **Example Generation**: Creates contextual usage examples
- **Type Mapping**: JSON types → CLI argument types

**Categories:**
- `memory` - Memory storage and recall
- `documents` - Document operations
- `knowledge-graph` - Entity and relationship management
- `code-analysis` - Code validation and analysis
- `multi-agent` - Agent orchestration
- `learning` - Progressive learning system
- `episodes` - Episodic memory
- `health` - System health and status

### 3. Nexus Tool Executor (`src/core/nexus-tool-executor.ts`)

Executes Nexus tools with parameter validation and progress tracking.

**Features:**
- Parameter validation against tool schemas
- Type checking and coercion
- Streaming operation support
- Progress polling for long operations
- Error handling with detailed messages
- Execution metrics (duration, status)

**Streaming Support:**
Tools that support streaming (orchestrate, ingest, validate_code, analyze_code) automatically poll for progress and emit status updates.

### 4. Nexus Command Generator (`src/commands/dynamic/nexus-commands.ts`)

Orchestrates discovery and command generation.

**Workflow:**
1. Connect to Nexus API Gateway
2. Check system health
3. Fetch MCP tool definitions
4. Map tools to CLI commands
5. Register commands with CLI
6. Start health monitoring

**Auto-Discovery:**
- Fetches tools from `/mcp/tools` endpoint
- Falls back to predefined tool list if unavailable
- Supports refresh command to re-discover tools

### 5. Nexus Commands Index (`src/commands/nexus/index.ts`)

Main entry point for the `nexus` namespace.

**Commands:**
- `nexus nexus <tool-name>` - Execute a Nexus tool
- `nexus nexus list` - List all available tools
- `nexus nexus list --category <name>` - List tools by category
- `nexus nexus categories` - List all categories
- `nexus nexus refresh` - Re-discover tools from MCP server

## Usage Examples

### Memory Operations

```bash
# Store memory
nexus nexus store-memory \
  --content "User prefers TypeScript strict mode" \
  --tags "preferences,typescript"

# Recall memories
nexus nexus recall-memory \
  --query "typescript patterns" \
  --limit 10 \
  --score-threshold 0.3
```

### Document Operations

```bash
# Store document
nexus nexus store-document \
  --content "$(cat report.md)" \
  --title "Q4 Report" \
  --type markdown \
  --tags "report,q4"

# Retrieve documents
nexus nexus retrieve \
  --query "authentication patterns" \
  --strategy semantic_chunks \
  --limit 5 \
  --rerank
```

### Knowledge Graph

```bash
# Store entity
nexus nexus store-entity \
  --domain code \
  --entity-type class \
  --text-content "User authentication class" \
  --tags "auth,user"

# Query entities
nexus nexus query-entities \
  --domain code \
  --entity-type class \
  --search-text "auth"

# Create relationship
nexus nexus create-entity-relationship \
  --source-entity-id ent_123 \
  --target-entity-id ent_456 \
  --relationship-type REFERENCES \
  --weight 0.9
```

### Code Analysis

```bash
# Validate code (multi-model consensus)
nexus nexus validate-code \
  --code "$(cat app.ts)" \
  --language typescript \
  --risk-level high \
  --context "User authentication endpoint"

# Analyze code (single model)
nexus nexus analyze-code \
  --code "$(cat app.ts)" \
  --language typescript \
  --depth deep \
  --focus-areas "security,performance,error-handling"

# Validate shell command
nexus nexus validate-command \
  --command "rm -rf node_modules && npm install" \
  --cwd /path/to/project
```

### Multi-Agent Orchestration

```bash
# Orchestrate multiple agents
nexus nexus orchestrate \
  --task "Analyze codebase for security vulnerabilities" \
  --max-agents 5 \
  --timeout 120000

# Get AI suggestions
nexus nexus get-suggestions \
  --context-id ctx_abc123
```

### Learning System

```bash
# Trigger learning
nexus nexus trigger-learning \
  --topic "rust_async_programming" \
  --priority 9

# Recall learned knowledge
nexus nexus recall-knowledge \
  --topic "typescript_patterns" \
  --layer EXPERT \
  --max-results 10
```

### Episodes

```bash
# Store episode
nexus nexus store-episode \
  --content "Fixed memory leak in StreamingStoragePipeline" \
  --type insight

# Recall episodes
nexus nexus recall-episodes \
  --query "memory leak fixes" \
  --limit 10 \
  --include-decay
```

### Health & Status

```bash
# Check Nexus health
nexus nexus health --detailed

# Check ingestion status
nexus nexus ingestion-status --job-id job_abc123
```

## Tool Discovery

### List All Tools

```bash
nexus nexus list
```

Output:
```
┌──────────────────────────┬────────────────────────────────────────┬──────────────────┐
│ Command                  │ Description                            │ Category         │
├──────────────────────────┼────────────────────────────────────────┼──────────────────┤
│ store-memory             │ Store memory with content and tags     │ memory           │
│ recall-memory            │ Recall memories by query               │ memory           │
│ store-document           │ Store document in Nexus                │ documents        │
│ retrieve                 │ Retrieve documents by query            │ documents        │
│ store-entity             │ Store entity in knowledge graph        │ knowledge-graph  │
│ query-entities           │ Query entities from knowledge graph    │ knowledge-graph  │
│ validate-code            │ Validate code with multi-model         │ code-analysis    │
│ analyze-code             │ Analyze code for issues                │ code-analysis    │
│ orchestrate              │ Orchestrate multiple AI agents         │ multi-agent      │
│ trigger-learning         │ Trigger progressive learning           │ learning         │
│ recall-knowledge         │ Recall learned knowledge               │ learning         │
│ store-episode            │ Store episodic memory                  │ episodes         │
│ recall-episodes          │ Recall episodic memories               │ episodes         │
│ health                   │ Check Nexus system health              │ health           │
└──────────────────────────┴────────────────────────────────────────┴──────────────────┘

Total: 70+ commands
```

### List by Category

```bash
nexus nexus list --category code-analysis
```

### List Categories

```bash
nexus nexus categories
```

Output:
```
┌──────────────────┬────────────┐
│ Category         │ Tool Count │
├──────────────────┼────────────┤
│ memory           │ 10         │
│ documents        │ 8          │
│ knowledge-graph  │ 12         │
│ code-analysis    │ 5          │
│ multi-agent      │ 6          │
│ learning         │ 5          │
│ episodes         │ 5          │
│ health           │ 3          │
│ general          │ 16         │
└──────────────────┴────────────┘
```

## Error Handling

### Nexus Unavailable

When Nexus system is unavailable, operations are automatically queued:

```bash
$ nexus nexus store-memory --content "test"
⚠️  Nexus system unavailable - operations will be queued
📋 Operation queued: POST /nexus/memory/store
```

When Nexus recovers:

```bash
✅ Nexus system recovered - processing queued operations
⚙️  Processing queued operation: POST /nexus/memory/store
✅ Queue processed: 3 completed, 0 remaining
```

### Parameter Validation

Invalid parameters are caught early:

```bash
$ nexus nexus store-entity --domain code
❌ Invalid parameters: Required parameter 'entityType' is missing, Required parameter 'textContent' is missing
```

### Type Validation

Type mismatches are reported clearly:

```bash
$ nexus nexus recall-memory --query test --limit abc
❌ Invalid parameters: Parameter 'limit' must be a number (received: string)
```

## Streaming Operations

Long-running operations show real-time progress:

```bash
$ nexus nexus orchestrate --task "Security audit" --stream

⚙️  Executing nexus_orchestrate...
🤖 Agent spawned: security-analyst (role: specialist)
⚙️  security-analyst: Analyzing authentication module...
🤖 Agent spawned: performance-analyst (role: research)
⚙️  performance-analyst: Profiling database queries...
✅ security-analyst complete: 5 findings
⚙️  performance-analyst: Found 3 bottlenecks...
✅ performance-analyst complete: 3 recommendations
🤖 Agent spawned: synthesis-agent (role: synthesis)
⚙️  synthesis-agent: Combining findings...
🎉 Orchestration complete
✅ Completed in 45230ms
```

## Output Formats

### JSON Output

```bash
nexus nexus recall-memory --query "typescript" --output-format json
```

### Table Output (default)

```bash
nexus nexus list --category memory
```

### Stream JSON (for long operations)

```bash
nexus nexus orchestrate --task "..." --output-format stream-json
```

## Health Monitoring

The Nexus Client automatically monitors system health in the background:

**Automatic Health Checks:**
- Runs every 30 seconds (configurable)
- Emits events on status changes
- Queues operations when unhealthy
- Auto-processes queue on recovery

**Manual Health Check:**

```bash
nexus nexus health --detailed
```

Output:
```json
{
  "graphrag": {
    "healthy": true,
    "latency": 45,
    "collections": ["memories", "documents", "episodes"]
  },
  "mageagent": {
    "healthy": true,
    "latency": 120,
    "activeAgents": 3
  },
  "learningagent": {
    "healthy": true,
    "queuedLearning": 2
  }
}
```

## Configuration

### Environment Variables

```bash
# Nexus API URL
export NEXUS_NEXUS_API_URL=http://localhost:9092

# MCP Server URL (for tool discovery)
export NEXUS_MCP_SERVER_URL=http://localhost:9000

# Health check interval (ms)
export NEXUS_HEALTH_CHECK_INTERVAL=30000

# Request timeout (ms)
export NEXUS_REQUEST_TIMEOUT=30000

# Max retries
export NEXUS_MAX_RETRIES=3
```

### Programmatic Configuration

```typescript
import { registerNexusCommands } from './commands/nexus';

await registerNexusCommands(program, {
  nexusApiUrl: 'http://localhost:9092',
  autoDiscover: true,
});
```

## Integration with Main CLI

To integrate Nexus commands into your main CLI:

```typescript
import { Command } from 'commander';
import { registerNexusCommands } from './commands/nexus';

const program = new Command();

// ... other commands ...

// Register Nexus commands
await registerNexusCommands(program);

program.parse();
```

## Performance

**Command Generation:**
- Tool discovery: < 2s
- Command registration: < 100ms per tool
- Total initialization: < 3s for 70+ tools

**Command Execution:**
- Health check: < 50ms
- Simple operations: < 200ms
- Streaming operations: First response < 1s
- Code validation (3 models): 8-28s

**Memory Usage:**
- Nexus Client: ~5MB
- Command Registry: ~2MB for 70 commands
- Total overhead: < 10MB

## Troubleshooting

### Nexus System Not Available

```bash
$ nexus nexus list
⚠️  Nexus system unavailable - commands will use fallback mode
✅ Generated 70 Nexus commands across 8 categories
```

**Solution:** Ensure Nexus services are running:
```bash
docker ps | grep nexus
docker logs nexus-graphrag
docker logs nexus-api-gateway
```

### Tools Not Discovered

```bash
$ nexus nexus refresh
⚠️  No Nexus tools discovered - Nexus system may be unavailable
```

**Solution:** Check Nexus API Gateway:
```bash
curl http://localhost:9092/health
curl http://localhost:9092/mcp/tools
```

### Operation Timeout

```bash
$ nexus nexus orchestrate --task "..." --timeout 5000
❌ Operation timeout after 5000ms
```

**Solution:** Increase timeout:
```bash
nexus nexus orchestrate --task "..." --timeout 120000
```

## Future Enhancements

1. **WebSocket Streaming**: Real-time bidirectional streaming for long operations
2. **Batch Operations**: Execute multiple tools in parallel
3. **Tool Composition**: Chain tools together in pipelines
4. **Auto-completion**: Shell completion for all Nexus commands
5. **Tool Aliases**: Custom aliases for frequently used tools
6. **Configuration Profiles**: Save and switch between Nexus API configurations

## Contributing

To add new Nexus tools:

1. Tools are auto-discovered from the MCP server
2. No code changes needed - tools appear automatically
3. Refresh with `nexus nexus refresh`

To extend the mapper:

1. Edit `src/commands/dynamic/mcp-tool-mapper.ts`
2. Add category inference rules
3. Add example generation patterns

## License

MIT
