#!/usr/bin/env bash
# Installation script for Nexus CLI shell completions
# Automatically detects shell and installs appropriate completion file

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

# Get the directory where this script is located
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
COMPLETIONS_DIR="$(cd "${SCRIPT_DIR}/../completions" && pwd)"

# Helper functions
print_info() {
    echo -e "${CYAN}ℹ${NC} $1"
}

print_success() {
    echo -e "${GREEN}✓${NC} $1"
}

print_warning() {
    echo -e "${YELLOW}⚠${NC} $1"
}

print_error() {
    echo -e "${RED}✗${NC} $1"
}

print_header() {
    echo -e "${BLUE}═══════════════════════════════════════════════════════${NC}"
    echo -e "${BLUE}  Nexus CLI - Shell Completions Installer${NC}"
    echo -e "${BLUE}═══════════════════════════════════════════════════════${NC}"
    echo
}

# Detect current shell
detect_shell() {
    local shell_name

    # Try SHELL environment variable first
    if [ -n "$SHELL" ]; then
        shell_name=$(basename "$SHELL")
    else
        # Fallback to parent process
        shell_name=$(ps -p $$ -o comm= 2>/dev/null || echo "unknown")
    fi

    echo "$shell_name"
}

# Install Bash completions
install_bash() {
    print_info "Installing Bash completions..."

    local completion_file="${COMPLETIONS_DIR}/nexus.bash"
    local installed=0

    # Try system-wide installation (requires sudo)
    if [ -w /etc/bash_completion.d ] || [ "$(id -u)" -eq 0 ]; then
        print_info "Installing to /etc/bash_completion.d/ (system-wide)"
        cp "$completion_file" /etc/bash_completion.d/nexus
        print_success "Installed to /etc/bash_completion.d/nexus"
        installed=1
    elif [ -d /usr/local/etc/bash_completion.d ] && [ -w /usr/local/etc/bash_completion.d ]; then
        # macOS/Homebrew location
        print_info "Installing to /usr/local/etc/bash_completion.d/ (Homebrew)"
        cp "$completion_file" /usr/local/etc/bash_completion.d/nexus
        print_success "Installed to /usr/local/etc/bash_completion.d/nexus"
        installed=1
    fi

    # User-local installation
    local user_dir="${HOME}/.local/share/bash-completion/completions"
    mkdir -p "$user_dir"
    cp "$completion_file" "${user_dir}/nexus"
    print_success "Installed to ${user_dir}/nexus"
    installed=1

    # Add to .bashrc if not already present
    local bashrc="${HOME}/.bashrc"
    if [ -f "$bashrc" ]; then
        if ! grep -q "nexus.bash" "$bashrc" 2>/dev/null; then
            echo "" >> "$bashrc"
            echo "# Nexus CLI completions" >> "$bashrc"
            echo "[ -f \"${user_dir}/nexus\" ] && source \"${user_dir}/nexus\"" >> "$bashrc"
            print_success "Added source command to ~/.bashrc"
        fi
    fi

    if [ $installed -eq 1 ]; then
        print_success "Bash completions installed successfully!"
        print_info "Run 'source ~/.bashrc' or restart your shell to activate"
        return 0
    else
        print_error "Failed to install Bash completions"
        print_manual_bash
        return 1
    fi
}

# Install Zsh completions
install_zsh() {
    print_info "Installing Zsh completions..."

    local completion_file="${COMPLETIONS_DIR}/_nexus"
    local installed=0

    # Find zsh fpath directories
    local fpath_dirs=(
        "${HOME}/.zsh/completions"
        "${HOME}/.local/share/zsh/site-functions"
        "/usr/local/share/zsh/site-functions"
    )

    # Try to install to first writable directory
    for dir in "${fpath_dirs[@]}"; do
        if [ -d "$dir" ] && [ -w "$dir" ]; then
            cp "$completion_file" "${dir}/_nexus"
            print_success "Installed to ${dir}/_nexus"
            installed=1
            break
        elif [ ! -d "$dir" ]; then
            # Try to create directory
            if mkdir -p "$dir" 2>/dev/null; then
                cp "$completion_file" "${dir}/_nexus"
                print_success "Created ${dir} and installed completion"
                installed=1
                break
            fi
        fi
    done

    # If no standard location worked, install to custom location
    if [ $installed -eq 0 ]; then
        local custom_dir="${HOME}/.zsh/completions"
        mkdir -p "$custom_dir"
        cp "$completion_file" "${custom_dir}/_nexus"
        print_success "Installed to ${custom_dir}/_nexus"

        # Add to fpath in .zshrc
        local zshrc="${HOME}/.zshrc"
        if [ -f "$zshrc" ]; then
            if ! grep -q "${custom_dir}" "$zshrc" 2>/dev/null; then
                echo "" >> "$zshrc"
                echo "# Nexus CLI completions" >> "$zshrc"
                echo "fpath=(${custom_dir} \$fpath)" >> "$zshrc"
                echo "autoload -Uz compinit && compinit" >> "$zshrc"
                print_success "Added fpath to ~/.zshrc"
            fi
        fi
        installed=1
    fi

    if [ $installed -eq 1 ]; then
        print_success "Zsh completions installed successfully!"
        print_info "Run 'exec zsh' or restart your shell to activate"
        print_info "You may need to run 'rm -f ~/.zcompdump; compinit' to rebuild completion cache"
        return 0
    else
        print_error "Failed to install Zsh completions"
        print_manual_zsh
        return 1
    fi
}

# Install Fish completions
install_fish() {
    print_info "Installing Fish completions..."

    local completion_file="${COMPLETIONS_DIR}/nexus.fish"
    local fish_dir="${HOME}/.config/fish/completions"

    # Create Fish completions directory
    mkdir -p "$fish_dir"

    # Copy completion file
    cp "$completion_file" "${fish_dir}/nexus.fish"
    print_success "Installed to ${fish_dir}/nexus.fish"

    print_success "Fish completions installed successfully!"
    print_info "Completions are active immediately in new Fish sessions"
    return 0
}

# Manual installation instructions for Bash
print_manual_bash() {
    cat << EOF

${YELLOW}Manual Installation Instructions for Bash:${NC}

1. Copy the completion file:
   ${CYAN}cp "${COMPLETIONS_DIR}/nexus.bash" ~/.local/share/bash-completion/completions/nexus${NC}

2. Add to your ~/.bashrc:
   ${CYAN}echo 'source ~/.local/share/bash-completion/completions/nexus' >> ~/.bashrc${NC}

3. Reload your shell:
   ${CYAN}source ~/.bashrc${NC}

EOF
}

# Manual installation instructions for Zsh
print_manual_zsh() {
    cat << EOF

${YELLOW}Manual Installation Instructions for Zsh:${NC}

1. Create completions directory:
   ${CYAN}mkdir -p ~/.zsh/completions${NC}

2. Copy the completion file:
   ${CYAN}cp "${COMPLETIONS_DIR}/_nexus" ~/.zsh/completions/_nexus${NC}

3. Add to your ~/.zshrc:
   ${CYAN}echo 'fpath=(~/.zsh/completions \$fpath)' >> ~/.zshrc${NC}
   ${CYAN}echo 'autoload -Uz compinit && compinit' >> ~/.zshrc${NC}

4. Reload your shell:
   ${CYAN}exec zsh${NC}

EOF
}

# Manual installation instructions for Fish
print_manual_fish() {
    cat << EOF

${YELLOW}Manual Installation Instructions for Fish:${NC}

1. Copy the completion file:
   ${CYAN}cp "${COMPLETIONS_DIR}/nexus.fish" ~/.config/fish/completions/nexus.fish${NC}

2. Completions are active immediately in new Fish sessions

EOF
}

# Main installation function
install_for_shell() {
    local shell_name="$1"

    case "$shell_name" in
        bash)
            install_bash
            ;;
        zsh)
            install_zsh
            ;;
        fish)
            install_fish
            ;;
        *)
            print_error "Unsupported shell: $shell_name"
            print_info "Supported shells: bash, zsh, fish"
            return 1
            ;;
    esac
}

# Show all available completions
show_available() {
    echo
    print_info "Available completion files:"
    echo
    ls -lh "$COMPLETIONS_DIR" | tail -n +2 | while read -r line; do
        echo "  $line"
    done
    echo
}

# Main script
main() {
    print_header

    # Parse arguments
    local shell_arg=""
    local auto_detect=1

    while [ $# -gt 0 ]; do
        case "$1" in
            --shell|-s)
                shell_arg="$2"
                auto_detect=0
                shift 2
                ;;
            --list|-l)
                show_available
                exit 0
                ;;
            --help|-h)
                cat << EOF
${CYAN}Nexus CLI Shell Completions Installer${NC}

${YELLOW}Usage:${NC}
  $0 [options]

${YELLOW}Options:${NC}
  -s, --shell SHELL    Install for specific shell (bash, zsh, fish)
  -l, --list           List available completion files
  -h, --help           Show this help message

${YELLOW}Examples:${NC}
  $0                   Auto-detect shell and install
  $0 --shell bash      Install for Bash
  $0 --shell zsh       Install for Zsh
  $0 --shell fish      Install for Fish

${YELLOW}Supported Shells:${NC}
  • Bash  - Bourne Again Shell
  • Zsh   - Z Shell
  • Fish  - Friendly Interactive Shell

EOF
                exit 0
                ;;
            *)
                print_error "Unknown option: $1"
                print_info "Use --help for usage information"
                exit 1
                ;;
        esac
    done

    # Detect or use specified shell
    local target_shell
    if [ $auto_detect -eq 1 ]; then
        target_shell=$(detect_shell)
        print_info "Detected shell: $target_shell"
    else
        target_shell="$shell_arg"
        print_info "Installing for: $target_shell"
    fi

    # Install completions
    if install_for_shell "$target_shell"; then
        echo
        print_success "Installation complete!"
        echo
        print_info "To install for other shells, run:"
        echo "  ${CYAN}$0 --shell <bash|zsh|fish>${NC}"
        echo
    else
        exit 1
    fi
}

# Run main function
main "$@"
