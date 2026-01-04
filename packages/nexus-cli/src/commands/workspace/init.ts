/**
 * Workspace Init Command
 *
 * Initialize .nexus.toml configuration in the current workspace
 */

import { Command } from 'commander';
import chalk from 'chalk';
import fs from 'fs-extra';
import path from 'path';
import inquirer from 'inquirer';

export function createWorkspaceInitCommand(): Command {
  const command = new Command('init')
    .description('Initialize .nexus.toml configuration')
    .option('--force', 'Overwrite existing config', false)
    .option('--defaults', 'Use default values without prompts', false)
    .action(async (options) => {
      try {
        const cwd = process.cwd();
        const configPath = path.join(cwd, '.nexus.toml');

        // Check if config already exists
        if (await fs.pathExists(configPath) && !options.force) {
          console.error(chalk.red('Error: .nexus.toml already exists'));
          console.log(chalk.gray('Use --force to overwrite'));
          process.exit(1);
        }

        let config: any;

        if (options.defaults) {
          config = getDefaultConfig();
        } else {
          config = await promptForConfig();
        }

        // Generate TOML content
        const tomlContent = generateToml(config);

        // Write config file
        await fs.writeFile(configPath, tomlContent, 'utf-8');

        console.log(chalk.green('\n✅ Workspace initialized successfully'));
        console.log(chalk.bold('Config file:'), configPath);
        console.log(chalk.gray('\nYou can now use Nexus CLI commands in this workspace'));

        process.exit(0);
      } catch (error) {
        console.error(chalk.red('Error:'), error instanceof Error ? error.message : String(error));
        process.exit(1);
      }
    });

  return command;
}

/**
 * Get default configuration
 */
function getDefaultConfig() {
  return {
    workspace: {
      name: path.basename(process.cwd()),
      type: 'typescript',
    },
    services: {
      apiUrl: 'http://localhost:9092',
      mcpUrl: 'http://localhost:9000',
      timeout: 30000,
    },
    defaults: {
      outputFormat: 'text',
      streaming: true,
      verbose: false,
    },
    agent: {
      maxIterations: 20,
      autoApproveSafe: true,
      workspace: '.',
    },
    nexus: {
      autoStore: true,
      memoryTags: [],
    },
  };
}

/**
 * Prompt user for configuration
 */
async function promptForConfig() {
  console.log(chalk.bold.cyan('\n🔧 Nexus Workspace Configuration\n'));

  const answers = await inquirer.prompt([
    {
      type: 'input',
      name: 'workspaceName',
      message: 'Workspace name:',
      default: path.basename(process.cwd()),
    },
    {
      type: 'list',
      name: 'projectType',
      message: 'Project type:',
      choices: ['typescript', 'python', 'go', 'rust', 'java'],
      default: 'typescript',
    },
    {
      type: 'input',
      name: 'apiUrl',
      message: 'API Gateway URL:',
      default: 'http://localhost:9092',
    },
    {
      type: 'input',
      name: 'mcpUrl',
      message: 'MCP Server URL:',
      default: 'http://localhost:9000',
    },
    {
      type: 'list',
      name: 'outputFormat',
      message: 'Default output format:',
      choices: ['text', 'json', 'yaml', 'table'],
      default: 'text',
    },
    {
      type: 'confirm',
      name: 'autoStore',
      message: 'Auto-store results in Nexus?',
      default: true,
    },
    {
      type: 'confirm',
      name: 'autoApproveSafe',
      message: 'Auto-approve safe agent commands?',
      default: true,
    },
  ]);

  return {
    workspace: {
      name: answers.workspaceName,
      type: answers.projectType,
    },
    services: {
      apiUrl: answers.apiUrl,
      mcpUrl: answers.mcpUrl,
      timeout: 30000,
    },
    defaults: {
      outputFormat: answers.outputFormat,
      streaming: true,
      verbose: false,
    },
    agent: {
      maxIterations: 20,
      autoApproveSafe: answers.autoApproveSafe,
      workspace: '.',
    },
    nexus: {
      autoStore: answers.autoStore,
      memoryTags: [],
    },
  };
}

/**
 * Generate TOML content from config object
 */
function generateToml(config: any): string {
  return `# Adverant-Nexus CLI Configuration
# Generated on ${new Date().toISOString()}

[workspace]
name = "${config.workspace.name}"
type = "${config.workspace.type}"

[services]
apiUrl = "${config.services.apiUrl}"
mcpUrl = "${config.services.mcpUrl}"
timeout = ${config.services.timeout}

[defaults]
outputFormat = "${config.defaults.outputFormat}"
streaming = ${config.defaults.streaming}
verbose = ${config.defaults.verbose}

[agent]
maxIterations = ${config.agent.maxIterations}
autoApproveSafe = ${config.agent.autoApproveSafe}
workspace = "${config.agent.workspace}"

[nexus]
autoStore = ${config.nexus.autoStore}
memoryTags = [${config.nexus.memoryTags.map((t: string) => `"${t}"`).join(', ')}]

# Add custom shortcuts below
# [[shortcuts]]
# name = "test"
# command = "sandbox execute --file tests/run.py"
`;
}

export default createWorkspaceInitCommand;
