#!/usr/bin/env bash
# Bash completion script for Nexus CLI
# Install: source this file or copy to /etc/bash_completion.d/nexus

_nexus_completions() {
    local cur prev words cword split
    _init_completion -s || return

    # Global options
    local global_opts="
        --config
        --profile
        --output-format -o
        --verbose -v
        --quiet -q
        --no-color
        --timeout
        --retries
        --help -h
        --version -V
    "

    # Main commands
    local commands="
        version
        config
        workspace
        services
        brain
        agent
        repl
        session
        plugin
        init
        deploy
        login
        register
        logs
        list
        help
    "

    # Service subcommands
    local service_cmds="
        list
        status
        health
        info
        logs
        start
        stop
        restart
        ports
    "

    # Brain subcommands (base commands, dynamic tools discovered at runtime)
    local brain_cmds="
        list
        categories
        refresh
        health
        store-memory
        recall-memory
        store-document
        store-episode
        store-pattern
        retrieve
        recall-episodes
        enhanced-retrieve
        store-entity
        query-entities
        create-entity-relationship
        validate-code
        validate-command
        analyze-code
        orchestrate
        trigger-learning
        recall-learned-knowledge
        inject-context
        get-suggestions
        ingest-url
        ingest-url-confirm
        check-ingestion-job
        validation-result
    "

    # Agent subcommands
    local agent_cmds="
        run
        list
        status
    "

    # Session subcommands
    local session_cmds="
        save
        load
        list
        resume
        import
        export
        delete
    "

    # Plugin subcommands
    local plugin_cmds="
        install
        uninstall
        list
        init
        enable
        disable
        info
    "

    # Workspace subcommands
    local workspace_cmds="
        init
        info
        validate
        git-status
        git-commit
    "

    # Get the command being completed
    local command=""
    local subcommand=""

    # Find the main command
    for ((i=1; i < cword; i++)); do
        if [[ "${words[i]}" != -* ]]; then
            if [[ -z "$command" ]]; then
                command="${words[i]}"
            elif [[ -z "$subcommand" ]]; then
                subcommand="${words[i]}"
            fi
        fi
    done

    # Handle --output-format completions
    if [[ "$prev" == "--output-format" || "$prev" == "-o" ]]; then
        COMPREPLY=($(compgen -W "text json yaml table stream-json" -- "$cur"))
        return 0
    fi

    # Handle --config completions (file paths)
    if [[ "$prev" == "--config" ]]; then
        _filedir
        return 0
    fi

    # Handle --profile completions (could be enhanced to read from config)
    if [[ "$prev" == "--profile" ]]; then
        COMPREPLY=($(compgen -W "default production staging development" -- "$cur"))
        return 0
    fi

    # Command-specific completions
    case "$command" in
        services)
            case "$subcommand" in
                "")
                    # Complete service subcommands
                    COMPREPLY=($(compgen -W "$service_cmds $global_opts" -- "$cur"))
                    ;;
                start|stop|restart|info|logs|status)
                    # Complete service names (try to get from nexus services list)
                    if command -v nexus &> /dev/null; then
                        local services=$(nexus services list --output-format text 2>/dev/null | awk '{print $1}' | tail -n +2)
                        COMPREPLY=($(compgen -W "$services $global_opts" -- "$cur"))
                    else
                        COMPREPLY=($(compgen -W "$global_opts" -- "$cur"))
                    fi
                    ;;
                *)
                    COMPREPLY=($(compgen -W "$global_opts" -- "$cur"))
                    ;;
            esac
            ;;

        brain)
            case "$subcommand" in
                "")
                    # Complete brain subcommands
                    COMPREPLY=($(compgen -W "$brain_cmds $global_opts" -- "$cur"))
                    ;;
                list)
                    # Brain list options
                    COMPREPLY=($(compgen -W "--category -c --verbose -v $global_opts" -- "$cur"))
                    ;;
                store-document|ingest-url)
                    # File path completion
                    if [[ "$cur" != -* ]]; then
                        _filedir
                    else
                        COMPREPLY=($(compgen -W "$global_opts" -- "$cur"))
                    fi
                    ;;
                *)
                    COMPREPLY=($(compgen -W "$global_opts" -- "$cur"))
                    ;;
            esac
            ;;

        agent)
            case "$subcommand" in
                "")
                    # Complete agent subcommands
                    COMPREPLY=($(compgen -W "$agent_cmds $global_opts" -- "$cur"))
                    ;;
                run)
                    # Agent run options
                    COMPREPLY=($(compgen -W "--task --timeout --max-iterations $global_opts" -- "$cur"))
                    ;;
                *)
                    COMPREPLY=($(compgen -W "$global_opts" -- "$cur"))
                    ;;
            esac
            ;;

        session)
            case "$subcommand" in
                "")
                    # Complete session subcommands
                    COMPREPLY=($(compgen -W "$session_cmds $global_opts" -- "$cur"))
                    ;;
                save)
                    COMPREPLY=($(compgen -W "--name --description $global_opts" -- "$cur"))
                    ;;
                load|resume|delete)
                    # Try to get session names
                    if command -v nexus &> /dev/null; then
                        local sessions=$(nexus session list --output-format text 2>/dev/null | awk '{print $1}' | tail -n +2)
                        COMPREPLY=($(compgen -W "$sessions $global_opts" -- "$cur"))
                    else
                        COMPREPLY=($(compgen -W "$global_opts" -- "$cur"))
                    fi
                    ;;
                import|export)
                    if [[ "$cur" != -* ]]; then
                        _filedir
                    else
                        COMPREPLY=($(compgen -W "$global_opts" -- "$cur"))
                    fi
                    ;;
                *)
                    COMPREPLY=($(compgen -W "$global_opts" -- "$cur"))
                    ;;
            esac
            ;;

        plugin)
            case "$subcommand" in
                "")
                    # Complete plugin subcommands
                    COMPREPLY=($(compgen -W "$plugin_cmds $global_opts" -- "$cur"))
                    ;;
                install)
                    COMPREPLY=($(compgen -W "--path --git --npm $global_opts" -- "$cur"))
                    ;;
                uninstall|enable|disable|info)
                    # Try to get plugin names
                    if command -v nexus &> /dev/null; then
                        local plugins=$(nexus plugin list --output-format text 2>/dev/null | awk '{print $1}' | tail -n +2)
                        COMPREPLY=($(compgen -W "$plugins $global_opts" -- "$cur"))
                    else
                        COMPREPLY=($(compgen -W "$global_opts" -- "$cur"))
                    fi
                    ;;
                *)
                    COMPREPLY=($(compgen -W "$global_opts" -- "$cur"))
                    ;;
            esac
            ;;

        workspace)
            case "$subcommand" in
                "")
                    # Complete workspace subcommands
                    COMPREPLY=($(compgen -W "$workspace_cmds $global_opts" -- "$cur"))
                    ;;
                init)
                    COMPREPLY=($(compgen -W "--name --template --path $global_opts" -- "$cur"))
                    ;;
                git-commit)
                    COMPREPLY=($(compgen -W "--message -m --amend --no-verify $global_opts" -- "$cur"))
                    ;;
                *)
                    COMPREPLY=($(compgen -W "$global_opts" -- "$cur"))
                    ;;
            esac
            ;;

        init)
            # Init command options
            COMPREPLY=($(compgen -W "--name --template --path --force $global_opts" -- "$cur"))
            ;;

        deploy)
            # Deploy command options
            COMPREPLY=($(compgen -W "--environment --service --all --dry-run $global_opts" -- "$cur"))
            ;;

        login)
            # Login command options
            COMPREPLY=($(compgen -W "--username --password --token --sso $global_opts" -- "$cur"))
            ;;

        logs)
            # Logs command options
            COMPREPLY=($(compgen -W "--service --follow -f --tail --since --until $global_opts" -- "$cur"))
            ;;

        "")
            # No command yet, complete main commands and global options
            COMPREPLY=($(compgen -W "$commands $global_opts" -- "$cur"))
            ;;

        *)
            # Unknown command, just complete global options
            COMPREPLY=($(compgen -W "$global_opts" -- "$cur"))
            ;;
    esac

    return 0
}

# Register the completion function
complete -F _nexus_completions nexus
