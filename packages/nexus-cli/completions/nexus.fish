# Fish completion script for Nexus CLI
# Install: Copy to ~/.config/fish/completions/nexus.fish

# Remove any existing completions
complete -c nexus -e

# Global options
complete -c nexus -l config -d 'Use specific config file' -r -F
complete -c nexus -l profile -d 'Use specific profile' -x -a 'default production staging development'
complete -c nexus -s o -l output-format -d 'Output format' -x -a 'text json yaml table stream-json'
complete -c nexus -s v -l verbose -d 'Verbose output (debug level)'
complete -c nexus -s q -l quiet -d 'Minimal output (errors only)'
complete -c nexus -l no-color -d 'Disable colors'
complete -c nexus -l timeout -d 'Request timeout in milliseconds' -x
complete -c nexus -l retries -d 'Number of retries' -x
complete -c nexus -s h -l help -d 'Show help information'
complete -c nexus -s V -l version -d 'Show version information'

# Main commands
complete -c nexus -f -n __fish_use_subcommand -a version -d 'Show version information'
complete -c nexus -f -n __fish_use_subcommand -a config -d 'Configuration management'
complete -c nexus -f -n __fish_use_subcommand -a workspace -d 'Workspace management'
complete -c nexus -f -n __fish_use_subcommand -a services -d 'Service management'
complete -c nexus -f -n __fish_use_subcommand -a brain -d 'Brain MCP tools'
complete -c nexus -f -n __fish_use_subcommand -a agent -d 'Autonomous agent management'
complete -c nexus -f -n __fish_use_subcommand -a repl -d 'Start interactive REPL mode'
complete -c nexus -f -n __fish_use_subcommand -a session -d 'Session management'
complete -c nexus -f -n __fish_use_subcommand -a plugin -d 'Plugin management'
complete -c nexus -f -n __fish_use_subcommand -a init -d 'Initialize new workspace or project'
complete -c nexus -f -n __fish_use_subcommand -a deploy -d 'Deploy services to environment'
complete -c nexus -f -n __fish_use_subcommand -a login -d 'Authenticate with Nexus platform'
complete -c nexus -f -n __fish_use_subcommand -a register -d 'Register new account'
complete -c nexus -f -n __fish_use_subcommand -a logs -d 'View service logs'
complete -c nexus -f -n __fish_use_subcommand -a list -d 'List available resources'
complete -c nexus -f -n __fish_use_subcommand -a help -d 'Display help for command'

# Services subcommands
complete -c nexus -f -n '__fish_seen_subcommand_from services' -a list -d 'List all available services'
complete -c nexus -f -n '__fish_seen_subcommand_from services' -a status -d 'Show service status'
complete -c nexus -f -n '__fish_seen_subcommand_from services' -a health -d 'Check service health'
complete -c nexus -f -n '__fish_seen_subcommand_from services' -a info -d 'Display detailed service information'
complete -c nexus -f -n '__fish_seen_subcommand_from services' -a logs -d 'View service logs'
complete -c nexus -f -n '__fish_seen_subcommand_from services' -a start -d 'Start one or more services'
complete -c nexus -f -n '__fish_seen_subcommand_from services' -a stop -d 'Stop one or more services'
complete -c nexus -f -n '__fish_seen_subcommand_from services' -a restart -d 'Restart one or more services'
complete -c nexus -f -n '__fish_seen_subcommand_from services' -a ports -d 'Show service port mappings'

# Dynamic service name completion for services commands
complete -c nexus -f -n '__fish_seen_subcommand_from services; and __fish_seen_subcommand_from start stop restart info logs status' -a '(nexus services list --output-format text 2>/dev/null | tail -n +2 | awk \'{print $1}\')'

# Brain subcommands
complete -c nexus -f -n '__fish_seen_subcommand_from brain' -a list -d 'List all available Brain tools'
complete -c nexus -f -n '__fish_seen_subcommand_from brain' -a categories -d 'List Brain tool categories'
complete -c nexus -f -n '__fish_seen_subcommand_from brain' -a refresh -d 'Refresh Brain tools from MCP server'
complete -c nexus -f -n '__fish_seen_subcommand_from brain' -a health -d 'Check Brain system health'
complete -c nexus -f -n '__fish_seen_subcommand_from brain' -a store-memory -d 'Store a memory/fact in Brain'
complete -c nexus -f -n '__fish_seen_subcommand_from brain' -a recall-memory -d 'Recall memories from Brain'
complete -c nexus -f -n '__fish_seen_subcommand_from brain' -a store-document -d 'Store a document in Brain'
complete -c nexus -f -n '__fish_seen_subcommand_from brain' -a store-episode -d 'Store an episode/event'
complete -c nexus -f -n '__fish_seen_subcommand_from brain' -a store-pattern -d 'Store a learned pattern'
complete -c nexus -f -n '__fish_seen_subcommand_from brain' -a retrieve -d 'Advanced retrieval with multiple strategies'
complete -c nexus -f -n '__fish_seen_subcommand_from brain' -a recall-episodes -d 'Recall past episodes with temporal context'
complete -c nexus -f -n '__fish_seen_subcommand_from brain' -a enhanced-retrieve -d 'Unified retrieval across all memory types'
complete -c nexus -f -n '__fish_seen_subcommand_from brain' -a store-entity -d 'Store entity in knowledge graph'
complete -c nexus -f -n '__fish_seen_subcommand_from brain' -a query-entities -d 'Query knowledge graph entities'
complete -c nexus -f -n '__fish_seen_subcommand_from brain' -a create-entity-relationship -d 'Create relationship between entities'
complete -c nexus -f -n '__fish_seen_subcommand_from brain' -a validate-code -d 'Multi-model code validation'
complete -c nexus -f -n '__fish_seen_subcommand_from brain' -a validate-command -d 'Validate shell commands before execution'
complete -c nexus -f -n '__fish_seen_subcommand_from brain' -a analyze-code -d 'Fast single-model code analysis'
complete -c nexus -f -n '__fish_seen_subcommand_from brain' -a orchestrate -d 'Multi-agent orchestration for complex tasks'
complete -c nexus -f -n '__fish_seen_subcommand_from brain' -a trigger-learning -d 'Trigger progressive learning on topics'
complete -c nexus -f -n '__fish_seen_subcommand_from brain' -a recall-learned-knowledge -d 'Retrieve learned knowledge'
complete -c nexus -f -n '__fish_seen_subcommand_from brain' -a inject-context -d 'Manually inject context for operations'
complete -c nexus -f -n '__fish_seen_subcommand_from brain' -a get-suggestions -d 'Get AI suggestions for operations'
complete -c nexus -f -n '__fish_seen_subcommand_from brain' -a ingest-url -d 'Ingest files from URL'
complete -c nexus -f -n '__fish_seen_subcommand_from brain' -a ingest-url-confirm -d 'Confirm and start URL ingestion'
complete -c nexus -f -n '__fish_seen_subcommand_from brain' -a check-ingestion-job -d 'Check ingestion job status'
complete -c nexus -f -n '__fish_seen_subcommand_from brain' -a validation-result -d 'Get code validation results'

# Brain list options
complete -c nexus -n '__fish_seen_subcommand_from brain; and __fish_seen_subcommand_from list' -s c -l category -d 'Filter by category' -x
complete -c nexus -n '__fish_seen_subcommand_from brain; and __fish_seen_subcommand_from list' -s v -l verbose -d 'Show detailed information'

# Brain store-memory options
complete -c nexus -n '__fish_seen_subcommand_from brain; and __fish_seen_subcommand_from store-memory' -l content -d 'Memory content' -x
complete -c nexus -n '__fish_seen_subcommand_from brain; and __fish_seen_subcommand_from store-memory' -l tags -d 'Tags (comma-separated)' -x
complete -c nexus -n '__fish_seen_subcommand_from brain; and __fish_seen_subcommand_from store-memory' -l importance -d 'Importance (0-1)' -x

# Brain recall-memory/retrieve options
complete -c nexus -n '__fish_seen_subcommand_from brain; and __fish_seen_subcommand_from recall-memory retrieve' -l query -d 'Search query' -x
complete -c nexus -n '__fish_seen_subcommand_from brain; and __fish_seen_subcommand_from recall-memory retrieve' -l limit -d 'Maximum results' -x
complete -c nexus -n '__fish_seen_subcommand_from brain; and __fish_seen_subcommand_from recall-memory retrieve' -l threshold -d 'Score threshold' -x

# Brain code analysis options
complete -c nexus -n '__fish_seen_subcommand_from brain; and __fish_seen_subcommand_from validate-code analyze-code' -l code -d 'Code to analyze' -x
complete -c nexus -n '__fish_seen_subcommand_from brain; and __fish_seen_subcommand_from validate-code analyze-code' -l language -d 'Programming language' -x -a 'typescript javascript python go rust java'
complete -c nexus -n '__fish_seen_subcommand_from brain; and __fish_seen_subcommand_from validate-code analyze-code' -l risk-level -d 'Risk level' -x -a 'low medium high critical'

# Brain orchestrate options
complete -c nexus -n '__fish_seen_subcommand_from brain; and __fish_seen_subcommand_from orchestrate' -l task -d 'Task description' -x
complete -c nexus -n '__fish_seen_subcommand_from brain; and __fish_seen_subcommand_from orchestrate' -l max-agents -d 'Maximum agents' -x
complete -c nexus -n '__fish_seen_subcommand_from brain; and __fish_seen_subcommand_from orchestrate' -l timeout -d 'Timeout in ms' -x

# Agent subcommands
complete -c nexus -f -n '__fish_seen_subcommand_from agent' -a run -d 'Run an autonomous agent'
complete -c nexus -f -n '__fish_seen_subcommand_from agent' -a list -d 'List available agents'
complete -c nexus -f -n '__fish_seen_subcommand_from agent' -a status -d 'Show agent status'

# Agent run options
complete -c nexus -n '__fish_seen_subcommand_from agent; and __fish_seen_subcommand_from run' -l task -d 'Task description' -x
complete -c nexus -n '__fish_seen_subcommand_from agent; and __fish_seen_subcommand_from run' -l timeout -d 'Timeout in seconds' -x
complete -c nexus -n '__fish_seen_subcommand_from agent; and __fish_seen_subcommand_from run' -l max-iterations -d 'Maximum iterations' -x

# Session subcommands
complete -c nexus -f -n '__fish_seen_subcommand_from session' -a save -d 'Save current session'
complete -c nexus -f -n '__fish_seen_subcommand_from session' -a load -d 'Load a saved session'
complete -c nexus -f -n '__fish_seen_subcommand_from session' -a list -d 'List all saved sessions'
complete -c nexus -f -n '__fish_seen_subcommand_from session' -a resume -d 'Resume a session'
complete -c nexus -f -n '__fish_seen_subcommand_from session' -a import -d 'Import session from file'
complete -c nexus -f -n '__fish_seen_subcommand_from session' -a export -d 'Export session to file'
complete -c nexus -f -n '__fish_seen_subcommand_from session' -a delete -d 'Delete a saved session'

# Session save options
complete -c nexus -n '__fish_seen_subcommand_from session; and __fish_seen_subcommand_from save' -l name -d 'Session name' -x
complete -c nexus -n '__fish_seen_subcommand_from session; and __fish_seen_subcommand_from save' -l description -d 'Session description' -x

# Dynamic session name completion
complete -c nexus -f -n '__fish_seen_subcommand_from session; and __fish_seen_subcommand_from load resume delete' -a '(nexus session list --output-format text 2>/dev/null | tail -n +2 | awk \'{print $1}\')'

# Plugin subcommands
complete -c nexus -f -n '__fish_seen_subcommand_from plugin' -a install -d 'Install a plugin'
complete -c nexus -f -n '__fish_seen_subcommand_from plugin' -a uninstall -d 'Uninstall a plugin'
complete -c nexus -f -n '__fish_seen_subcommand_from plugin' -a list -d 'List installed plugins'
complete -c nexus -f -n '__fish_seen_subcommand_from plugin' -a init -d 'Initialize a new plugin'
complete -c nexus -f -n '__fish_seen_subcommand_from plugin' -a enable -d 'Enable a plugin'
complete -c nexus -f -n '__fish_seen_subcommand_from plugin' -a disable -d 'Disable a plugin'
complete -c nexus -f -n '__fish_seen_subcommand_from plugin' -a info -d 'Show plugin information'

# Plugin install options
complete -c nexus -n '__fish_seen_subcommand_from plugin; and __fish_seen_subcommand_from install' -l path -d 'Install from path' -r -F
complete -c nexus -n '__fish_seen_subcommand_from plugin; and __fish_seen_subcommand_from install' -l git -d 'Install from git repository' -x
complete -c nexus -n '__fish_seen_subcommand_from plugin; and __fish_seen_subcommand_from install' -l npm -d 'Install from npm' -x

# Dynamic plugin name completion
complete -c nexus -f -n '__fish_seen_subcommand_from plugin; and __fish_seen_subcommand_from uninstall enable disable info' -a '(nexus plugin list --output-format text 2>/dev/null | tail -n +2 | awk \'{print $1}\')'

# Workspace subcommands
complete -c nexus -f -n '__fish_seen_subcommand_from workspace' -a init -d 'Initialize workspace'
complete -c nexus -f -n '__fish_seen_subcommand_from workspace' -a info -d 'Show workspace information'
complete -c nexus -f -n '__fish_seen_subcommand_from workspace' -a validate -d 'Validate workspace configuration'
complete -c nexus -f -n '__fish_seen_subcommand_from workspace' -a git-status -d 'Show git status'
complete -c nexus -f -n '__fish_seen_subcommand_from workspace' -a git-commit -d 'Commit changes'

# Workspace init options
complete -c nexus -n '__fish_seen_subcommand_from workspace; and __fish_seen_subcommand_from init' -l name -d 'Workspace name' -x
complete -c nexus -n '__fish_seen_subcommand_from workspace; and __fish_seen_subcommand_from init' -l template -d 'Template to use' -x
complete -c nexus -n '__fish_seen_subcommand_from workspace; and __fish_seen_subcommand_from init' -l path -d 'Workspace path' -r -F

# Workspace git-commit options
complete -c nexus -n '__fish_seen_subcommand_from workspace; and __fish_seen_subcommand_from git-commit' -s m -l message -d 'Commit message' -x
complete -c nexus -n '__fish_seen_subcommand_from workspace; and __fish_seen_subcommand_from git-commit' -l amend -d 'Amend previous commit'
complete -c nexus -n '__fish_seen_subcommand_from workspace; and __fish_seen_subcommand_from git-commit' -l no-verify -d 'Skip git hooks'

# Init command options
complete -c nexus -n '__fish_seen_subcommand_from init' -l name -d 'Project name' -x
complete -c nexus -n '__fish_seen_subcommand_from init' -l template -d 'Template to use' -x
complete -c nexus -n '__fish_seen_subcommand_from init' -l path -d 'Project path' -r -F
complete -c nexus -n '__fish_seen_subcommand_from init' -l force -d 'Force overwrite existing files'

# Deploy command options
complete -c nexus -n '__fish_seen_subcommand_from deploy' -l environment -d 'Target environment' -x -a 'development staging production'
complete -c nexus -n '__fish_seen_subcommand_from deploy' -l service -d 'Specific service to deploy' -x
complete -c nexus -n '__fish_seen_subcommand_from deploy' -l all -d 'Deploy all services'
complete -c nexus -n '__fish_seen_subcommand_from deploy' -l dry-run -d 'Perform dry run without actual deployment'

# Login command options
complete -c nexus -n '__fish_seen_subcommand_from login' -l username -d 'Username' -x
complete -c nexus -n '__fish_seen_subcommand_from login' -l password -d 'Password' -x
complete -c nexus -n '__fish_seen_subcommand_from login' -l token -d 'Authentication token' -x
complete -c nexus -n '__fish_seen_subcommand_from login' -l sso -d 'Use SSO authentication'

# Logs command options
complete -c nexus -n '__fish_seen_subcommand_from logs' -l service -d 'Service name' -x
complete -c nexus -n '__fish_seen_subcommand_from logs' -s f -l follow -d 'Follow log output'
complete -c nexus -n '__fish_seen_subcommand_from logs' -l tail -d 'Number of lines to show' -x
complete -c nexus -n '__fish_seen_subcommand_from logs' -l since -d 'Show logs since timestamp' -x
complete -c nexus -n '__fish_seen_subcommand_from logs' -l until -d 'Show logs until timestamp' -x
