# Shell Completions for Nexus CLI

This guide explains how to install and use shell completions for the Nexus CLI across Bash, Zsh, and Fish shells.

## Table of Contents

- [Overview](#overview)
- [Quick Installation](#quick-installation)
- [Manual Installation](#manual-installation)
  - [Bash](#bash)
  - [Zsh](#zsh)
  - [Fish](#fish)
- [Completion Features](#completion-features)
- [Usage Examples](#usage-examples)
- [Troubleshooting](#troubleshooting)
- [Updating Completions](#updating-completions)

## Overview

The Nexus CLI provides intelligent shell completions for all major shells:

- **Bash** - Bourne Again Shell (most common on Linux)
- **Zsh** - Z Shell (default on macOS)
- **Fish** - Friendly Interactive Shell

Completions provide:
- Command and subcommand suggestions
- Option flag completion with descriptions
- Dynamic completion of service names, sessions, plugins
- File path completion where appropriate
- Context-aware suggestions

## Quick Installation

### Automatic Installation (Recommended)

After installing the Nexus CLI, run:

```bash
npm run completions:install
```

This will auto-detect your shell and install the appropriate completions.

### Shell-Specific Installation

Install for a specific shell:

```bash
# Bash
npm run completions:install:bash

# Zsh
npm run completions:install:zsh

# Fish
npm run completions:install:fish
```

### Using the Installation Script Directly

```bash
# Auto-detect shell
./scripts/install-completions.sh

# Install for specific shell
./scripts/install-completions.sh --shell bash
./scripts/install-completions.sh --shell zsh
./scripts/install-completions.sh --shell fish

# List available completion files
./scripts/install-completions.sh --list
```

## Manual Installation

If automatic installation doesn't work, follow these manual steps:

### Bash

#### Option 1: System-wide (requires sudo)

```bash
sudo cp completions/nexus.bash /etc/bash_completion.d/nexus
```

#### Option 2: User-local (recommended)

```bash
# Create completions directory
mkdir -p ~/.local/share/bash-completion/completions

# Copy completion file
cp completions/nexus.bash ~/.local/share/bash-completion/completions/nexus

# Add to ~/.bashrc
echo '[ -f ~/.local/share/bash-completion/completions/nexus ] && source ~/.local/share/bash-completion/completions/nexus' >> ~/.bashrc

# Reload shell
source ~/.bashrc
```

#### macOS (Homebrew)

If you have bash-completion installed via Homebrew:

```bash
cp completions/nexus.bash $(brew --prefix)/etc/bash_completion.d/nexus
```

### Zsh

#### Option 1: Standard location

```bash
# Create completions directory
mkdir -p ~/.zsh/completions

# Copy completion file
cp completions/_nexus ~/.zsh/completions/_nexus

# Add to ~/.zshrc (if not already present)
cat >> ~/.zshrc << 'EOF'

# Nexus CLI completions
fpath=(~/.zsh/completions $fpath)
autoload -Uz compinit && compinit
EOF

# Reload shell
exec zsh

# Rebuild completion cache
rm -f ~/.zcompdump
compinit
```

#### Option 2: System-wide (requires sudo)

```bash
sudo cp completions/_nexus /usr/local/share/zsh/site-functions/_nexus
```

#### macOS (Homebrew)

```bash
# If using Homebrew's zsh
cp completions/_nexus $(brew --prefix)/share/zsh/site-functions/_nexus
```

### Fish

Fish completions are the easiest to install:

```bash
# Create Fish completions directory
mkdir -p ~/.config/fish/completions

# Copy completion file
cp completions/nexus.fish ~/.config/fish/completions/nexus.fish
```

Completions are active immediately in new Fish sessions!

## Completion Features

### Command Completion

All main commands are completed with descriptions:

```bash
nexus <TAB>
# Shows: version, config, workspace, services, nexus, agent, session, plugin, etc.
```

### Subcommand Completion

Each command group has intelligent subcommand completion:

```bash
nexus services <TAB>
# Shows: list, status, health, info, logs, start, stop, restart, ports

nexus nexus <TAB>
# Shows: list, categories, health, store-memory, recall-memory, etc.

nexus agent <TAB>
# Shows: run, list, status
```

### Option Completion

All options are completed with descriptions:

```bash
nexus --<TAB>
# Shows: --config, --profile, --output-format, --verbose, --quiet, etc.

nexus services list --output-format <TAB>
# Shows: text, json, yaml, table, stream-json
```

### Dynamic Completion

Completions intelligently fetch available resources:

```bash
# Service names (from running services)
nexus services start <TAB>
# Shows: graphrag, mageagent, api-gateway, etc.

# Session names (from saved sessions)
nexus session load <TAB>
# Shows: my-session-1, debug-session, etc.

# Plugin names (from installed plugins)
nexus plugin disable <TAB>
# Shows: my-plugin, test-plugin, etc.
```

### File Path Completion

File paths are completed where appropriate:

```bash
nexus nexus store-document <TAB>
# Shows: available files in current directory

nexus workspace init --path <TAB>
# Shows: available directories
```

## Usage Examples

### Example 1: Starting a Service

```bash
# Type the command
nexus services start <TAB>

# Completion shows available services:
# graphrag  mageagent  api-gateway  postgres  redis  neo4j

# Select one
nexus services start graphrag

# Continue with options
nexus services start graphrag --output-format <TAB>
# Shows: text json yaml table stream-json
```

### Example 2: Storing a Memory in Nexus

```bash
# Type the command
nexus nexus store-memory --<TAB>

# Completion shows options:
# --content  --tags  --importance  --verbose  --output-format

# Build the command
nexus nexus store-memory \
  --content "User prefers TypeScript strict mode" \
  --tags typescript,preferences \
  --importance 0.8
```

### Example 3: Loading a Session

```bash
# Type the command
nexus session load <TAB>

# Completion shows available sessions:
# refactoring-2024  debugging-session  feature-xyz

# Select one
nexus session load refactoring-2024
```

### Example 4: Using Nexus Tools

```bash
# List available Nexus tools
nexus nexus list --<TAB>
# Shows: --category, --verbose, --output-format

# Validate code with completion
nexus nexus validate-code \
  --language <TAB>  # Shows: typescript javascript python go rust java
  --risk-level <TAB>  # Shows: low medium high critical
```

## Troubleshooting

### Completions Not Working (Bash)

**Problem**: Tab completion doesn't work after installation.

**Solutions**:

1. Ensure bash-completion is installed:
   ```bash
   # Ubuntu/Debian
   sudo apt-get install bash-completion

   # macOS (Homebrew)
   brew install bash-completion@2
   ```

2. Verify the completion file is sourced:
   ```bash
   grep -r "nexus.bash" ~/.bashrc ~/.bash_profile
   ```

3. Reload your shell:
   ```bash
   source ~/.bashrc
   ```

### Completions Not Working (Zsh)

**Problem**: Tab completion doesn't work or shows "command not found: compdef".

**Solutions**:

1. Ensure compinit is called in ~/.zshrc:
   ```bash
   grep "compinit" ~/.zshrc
   ```

   If not found, add:
   ```bash
   autoload -Uz compinit && compinit
   ```

2. Rebuild the completion cache:
   ```bash
   rm -f ~/.zcompdump*
   exec zsh
   ```

3. Check fpath includes your completions directory:
   ```bash
   echo $fpath
   ```

### Completions Not Working (Fish)

**Problem**: Completions don't appear.

**Solutions**:

1. Verify the file is in the correct location:
   ```bash
   ls -la ~/.config/fish/completions/nexus.fish
   ```

2. Restart Fish:
   ```bash
   exec fish
   ```

3. Test completion directly:
   ```bash
   complete -C "nexus "
   ```

### Dynamic Completions Fail

**Problem**: Service names, session names, or plugin names don't complete.

**Cause**: The CLI command to fetch dynamic data failed (e.g., `nexus services list`).

**Solutions**:

1. Ensure Nexus CLI is installed and in PATH:
   ```bash
   which nexus
   nexus --version
   ```

2. Test the underlying command:
   ```bash
   nexus services list --output-format text
   ```

3. Check for errors:
   ```bash
   nexus services list 2>&1 | grep -i error
   ```

### Completions Show Old Commands

**Problem**: Completions show outdated or removed commands.

**Solution**: Reinstall completions (see [Updating Completions](#updating-completions)).

## Updating Completions

When you update the Nexus CLI, you may need to update completions:

### Automatic Update

```bash
npm run completions:install
```

### Manual Update

#### Bash
```bash
cp completions/nexus.bash ~/.local/share/bash-completion/completions/nexus
source ~/.bashrc
```

#### Zsh
```bash
cp completions/_nexus ~/.zsh/completions/_nexus
rm -f ~/.zcompdump
exec zsh
```

#### Fish
```bash
cp completions/nexus.fish ~/.config/fish/completions/nexus.fish
# Completions update automatically
```

## Advanced Usage

### Completion Cache (Zsh)

Zsh caches completions for performance. To force a refresh:

```bash
# Clear cache
rm -f ~/.zcompdump*

# Reload completions
compinit
```

### Debugging Completions (Zsh)

Enable verbose completion debugging:

```bash
# Add to ~/.zshrc temporarily
zstyle ':completion:*' verbose yes
zstyle ':completion:*:descriptions' format '%B%d%b'
```

### Custom Completion Paths

To install completions to a custom location:

#### Bash
```bash
# Copy to custom directory
cp completions/nexus.bash /path/to/custom/dir/nexus

# Source in ~/.bashrc
echo 'source /path/to/custom/dir/nexus' >> ~/.bashrc
```

#### Zsh
```bash
# Copy to custom directory
cp completions/_nexus /path/to/custom/dir/_nexus

# Add to fpath in ~/.zshrc
echo 'fpath=(/path/to/custom/dir $fpath)' >> ~/.zshrc
echo 'autoload -Uz compinit && compinit' >> ~/.zshrc
```

## Shell-Specific Features

### Bash Features

- Context-aware completion based on previous arguments
- Dynamic service/session/plugin name fetching
- File path completion with `_filedir`
- Option value suggestions

### Zsh Features

- Rich descriptions for all commands and options
- Advanced argument handling with `_arguments`
- Multiple completion strategies
- Cached completion for performance
- Color-coded suggestions

### Fish Features

- Inline descriptions as you type
- Real-time completion updates
- Fuzzy matching support
- Zero configuration needed

## Contributing

Found a bug or want to add completions for a new command?

1. Edit the appropriate completion file:
   - Bash: `completions/nexus.bash`
   - Zsh: `completions/_nexus`
   - Fish: `completions/nexus.fish`

2. Test your changes locally

3. Submit a pull request

## Support

If you encounter issues with completions:

1. Check this troubleshooting guide
2. Verify your shell version: `bash --version`, `zsh --version`, or `fish --version`
3. Open an issue on GitHub with:
   - Your shell and version
   - Installation method used
   - Error messages or unexpected behavior
   - Output of `echo $SHELL`

## License

Completions are part of the Nexus CLI and released under the MIT License.
