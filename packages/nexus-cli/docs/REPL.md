# Nexus CLI - Interactive REPL Mode

## Overview

The Nexus CLI REPL (Read-Eval-Print Loop) provides an interactive shell for exploring and executing commands with rich features like tab completion, command history, and session management.

## Features

### 1. Interactive Shell
- Read-eval-print loop with readline integration
- Persistent command history
- Tab completion for commands, options, and arguments
- Multi-line input support
- Error recovery (REPL doesn't crash on errors)

### 2. Namespace Support
- Switch between service namespaces using `use <namespace>`
- Namespace-aware prompt: `nexus:graphrag >`
- Execute commands in namespace context
- Global commands available from any namespace

### 3. Tab Completion
- Complete command names
- Complete namespace names
- Complete option flags (`--option`, `-o`)
- Complete file paths (for file/directory arguments)
- Context-aware completion based on current namespace
- Show help text for completions

### 4. Command History
- Persistent history saved to `~/.nexus/history`
- Up/down arrows for history navigation
- Reverse search with Ctrl+R
- History size limit: 1000 commands
- View history with `history` command
- Search history by query

### 5. Session Management
- Save current session: `save <name>`
- Load saved session: `load <name>`
- List all sessions: `sessions`
- Sessions stored in `~/.nexus/sessions/`
- Session includes:
  - Command history
  - Execution results
  - Context (workspace, config, environment)
  - Metadata (command counts, duration, tags)

### 6. Rich Output
- Multiple output formats:
  - Text (human-readable, default)
  - Tables (for array results)
  - Pretty-printed objects with colors
  - Streaming progress indicators
- Color-coded responses:
  - Success: green ✔
  - Error: red ✖
  - Warning: yellow ⚠
  - Info: blue ℹ
- Smart data rendering based on type

### 7. Built-in Commands
- `help` - Show available commands
- `services` - List discovered services
- `use <namespace>` - Switch to service namespace
- `history [limit]` - Show command history
- `clear` - Clear screen
- `save <name>` - Save current session
- `load <name>` - Load saved session
- `sessions` - List saved sessions
- `config` - Show current configuration
- `exit` / `quit` - Exit REPL

## Usage

### Starting REPL

```bash
nexus repl
```

### Welcome Banner

```
┌──────────────────────────────────────────────┐
│                                              │
│                 NEXUS CLI                    │
│                                              │
│            Version: 2.0.0                    │
│         Services: 23 discovered              │
│                                              │
│    Type help for available commands          │
│         Type exit to quit                    │
│                                              │
└──────────────────────────────────────────────┘

nexus >
```

### Basic Commands

```bash
# Show help
nexus > help

# List services
nexus > services

# Switch to a namespace
nexus > use graphrag
✔ Switched to namespace: graphrag

# Execute command in namespace
nexus:graphrag > store-document --file report.pdf --title "Q4 Report"
✔ Document stored successfully
id: doc_abc123

# View command history
nexus:graphrag > history
┌───┬─────────────────────────┬──────────────────────────┬─────────┬──────────┐
│ # │ command                 │ timestamp                │ success │ duration │
├───┼─────────────────────────┼──────────────────────────┼─────────┼──────────┤
│ 3 │ store-document ...      │ 2025-11-14T10:15:30.000Z │ ✔       │ 145ms    │
│ 2 │ use graphrag            │ 2025-11-14T10:15:20.000Z │ ✔       │ 1ms      │
│ 1 │ services                │ 2025-11-14T10:15:10.000Z │ ✔       │ 5ms      │
└───┴─────────────────────────┴──────────────────────────┴─────────┴──────────┘

# Save session
nexus:graphrag > save my-work
✔ Session saved: my-work

# View configuration
nexus:graphrag > config
namespace: graphrag
workspace: typescript
outputFormat: text
verbose: false
commandCount: 5
sessionDuration: 120s

# Exit
nexus:graphrag > exit
✔ Goodbye!
```

### Tab Completion

```bash
# Press Tab to see all commands
nexus > [TAB]
clear    config   exit     help     history  load     quit
save     services sessions use

# Press Tab to complete command
nexus > se[TAB]
nexus > services

# Press Tab to complete namespace
nexus > use gr[TAB]
nexus > use graphrag

# Press Tab to see command options
nexus:graphrag > query --[TAB]
--text    --limit   --strategy

# Press Tab with partial option
nexus:graphrag > query --li[TAB]
nexus:graphrag > query --limit
```

### Command History Navigation

```bash
# Use up arrow to navigate history
nexus > [UP]      # Shows previous command
nexus > [UP]      # Shows command before that
nexus > [DOWN]    # Navigate forward in history

# Ctrl+R for reverse search
nexus > [Ctrl+R]
(reverse-i-search)`query': query --text "authentication"
```

### Session Management

```bash
# Save current session
nexus > save analysis-session
✔ Session saved: analysis-session

# List all sessions
nexus > sessions
┌───────────────────┬──────────────────────────┬──────────────────────────┬──────────┬──────┐
│ name              │ created                  │ updated                  │ commands │ tags │
├───────────────────┼──────────────────────────┼──────────────────────────┼──────────┼──────┤
│ analysis-session  │ 2025-11-14T10:00:00.000Z │ 2025-11-14T10:30:00.000Z │ 25       │      │
│ debugging-work    │ 2025-11-13T15:20:00.000Z │ 2025-11-13T16:00:00.000Z │ 45       │      │
└───────────────────┴──────────────────────────┴──────────────────────────┴──────────┴──────┘

# Load a session
nexus > load analysis-session
✔ Session loaded: analysis-session
```

## Architecture

### Components

#### 1. REPL Core (`src/repl/repl.ts`)
- Main REPL loop
- Readline interface setup
- Event handlers (line, SIGINT, close)
- Built-in command handlers
- Session lifecycle management

#### 2. Completer (`src/repl/completer.ts`)
- Tab completion logic
- Context-aware suggestions
- Command/option/argument completion
- Namespace completion
- Help text for completions

#### 3. Evaluator (`src/repl/evaluator.ts`)
- Command parsing and tokenization
- Option parsing (--long, -short)
- Command type detection (builtin, service, namespace)
- Command execution
- Error handling

#### 4. Renderer (`src/repl/renderer.ts`)
- Result formatting
- Table rendering
- Object pretty-printing
- Color-coded output
- Welcome banner
- Prompt generation

#### 5. Context Manager (`src/core/session/context-manager.ts`)
- Current namespace tracking
- Workspace context
- Last command result
- Session metadata
- Context persistence

#### 6. History Manager (`src/core/session/history-manager.ts`)
- Command history storage
- Persistent history to disk
- History navigation (up/down)
- History search
- Size limit enforcement

#### 7. Session Manager (`src/core/session/session-manager.ts`)
- Session save/load/delete
- Session list
- Session export/import
- Resume last session
- Session metadata tracking

### Data Flow

```
User Input
    ↓
Readline (with tab completion)
    ↓
Evaluator (parse command)
    ↓
Command Handler (execute)
    ↓
Context Manager (update context)
    ↓
History Manager (add to history)
    ↓
Renderer (format result)
    ↓
Display to User
```

### File Structure

```
src/
├── repl/
│   ├── repl.ts              # Main REPL implementation
│   ├── completer.ts         # Tab completion
│   ├── evaluator.ts         # Command parsing & execution
│   ├── renderer.ts          # Output rendering
│   └── index.ts             # Module exports
│
├── core/session/
│   ├── context-manager.ts   # REPL context management
│   ├── history-manager.ts   # Command history
│   ├── session-manager.ts   # Session checkpointing
│   └── index.ts             # Module exports
│
└── utils/
    ├── spinner.ts           # Progress spinners
    ├── prompt.ts            # Interactive prompts
    ├── validation.ts        # Input validation
    └── index.ts             # Module exports
```

## Configuration

### REPL Settings (in .nexus.toml)

```toml
[repl]
history_size = 1000              # Maximum history size
history_file = "~/.nexus/history"
sessions_dir = "~/.nexus/sessions"
auto_save = false                # Auto-save session on exit
welcome_banner = true            # Show welcome banner on start

[defaults]
output_format = "text"           # Default output format in REPL
verbose = false                  # Verbose mode
```

### Environment Variables

```bash
NEXUS_REPL_HISTORY_SIZE=2000     # Override history size
NEXUS_REPL_NO_BANNER=1           # Disable welcome banner
VERBOSE=1                        # Enable verbose mode
DEBUG=1                          # Enable debug mode (show stack traces)
```

## Integration Example

```typescript
import { REPL } from './repl/index.js';

// Create REPL instance
const repl = new REPL({
  workspace: detectedWorkspace,
  config: loadedConfig,
  services: discoveredServices,
  commands: generatedCommands,
  version: '2.0.0',
});

// Start REPL
await repl.start();
```

## Testing

### Unit Tests

```bash
npm test src/repl/
npm test src/core/session/
npm test src/utils/
```

### Integration Tests

```bash
# Test REPL with mock services
npm test tests/integration/repl.test.ts
```

### Manual Testing

```bash
# Start REPL
npm run dev repl

# Test commands
nexus > help
nexus > services
nexus > use graphrag
nexus:graphrag > help
nexus:graphrab > [TAB]
```

## Best Practices

### 1. Command Design
- Keep commands concise and descriptive
- Use consistent naming across services
- Provide clear descriptions
- Include examples in help text

### 2. Error Handling
- Never crash the REPL on errors
- Show clear error messages
- Provide suggestions when possible
- Log errors for debugging

### 3. User Experience
- Fast tab completion (<50ms)
- Responsive prompt
- Clear visual feedback
- Helpful error messages

### 4. Performance
- Lazy-load commands
- Cache completion results
- Limit history size
- Efficient parsing

## Future Enhancements

### Planned Features
- [ ] Multi-line input with \ continuation
- [ ] Command aliases (shortcuts)
- [ ] Pipe support between commands
- [ ] Command chaining with &&, ||
- [ ] Variables ($var syntax)
- [ ] Script execution (run file)
- [ ] Auto-suggestions based on history
- [ ] Fuzzy command matching
- [ ] Syntax highlighting
- [ ] Command validation before execution

### Advanced Features
- [ ] REPL plugins
- [ ] Custom themes
- [ ] Macro recording
- [ ] Command templates
- [ ] Workspace-specific commands
- [ ] Remote REPL (connect to running services)
- [ ] REPL over SSH/WebSocket

## Troubleshooting

### History Not Persisting
```bash
# Check history file
ls -la ~/.nexus/history

# Check permissions
chmod 644 ~/.nexus/history
```

### Tab Completion Not Working
```bash
# Verify readline is properly initialized
# Check that completer function is registered
# Ensure commands are properly loaded
```

### Session Save/Load Issues
```bash
# Check sessions directory
ls -la ~/.nexus/sessions/

# Verify JSON format
cat ~/.nexus/sessions/<session-id>.json | jq .
```

## Resources

- [Node.js Readline Documentation](https://nodejs.org/api/readline.html)
- [Inquirer.js](https://github.com/SBoudrias/Inquirer.js)
- [Commander.js](https://github.com/tj/commander.js)
- [REPL Design Patterns](https://en.wikipedia.org/wiki/Read%E2%80%93eval%E2%80%93print_loop)

## Support

For issues or questions about the REPL:
- Open an issue on GitHub
- Check existing documentation
- Review example usage in `examples/repl-usage.ts`
