/**
 * Workspace Info Command
 *
 * Display workspace information including detected project type,
 * git status, docker-compose files, and available services
 */

import { Command } from 'commander';
import chalk from 'chalk';
import fs from 'fs-extra';
import path from 'path';
import { execa } from 'execa';
import glob from 'fast-glob';

export function createWorkspaceInfoCommand(): Command {
  const command = new Command('info')
    .description('Show workspace information')
    .option('--output-format <format>', 'Output format (text|json)', 'text')
    .action(async (options) => {
      try {
        const cwd = process.cwd();
        const info = await gatherWorkspaceInfo(cwd);

        if (options.outputFormat === 'json') {
          console.log(JSON.stringify(info, null, 2));
        } else {
          displayWorkspaceInfo(info);
        }

        process.exit(0);
      } catch (error) {
        console.error(chalk.red('Error:'), error instanceof Error ? error.message : String(error));
        process.exit(1);
      }
    });

  return command;
}

/**
 * Gather workspace information
 */
async function gatherWorkspaceInfo(cwd: string) {
  const info: any = {
    path: cwd,
    projectType: await detectProjectType(cwd),
    git: await getGitInfo(cwd),
    dockerCompose: await findDockerComposeFiles(cwd),
    config: await findNexusConfig(cwd),
    packageInfo: await getPackageInfo(cwd),
  };

  return info;
}

/**
 * Detect project type based on files
 */
async function detectProjectType(cwd: string): Promise<string> {
  if (await fs.pathExists(path.join(cwd, 'package.json'))) {
    return 'typescript/javascript';
  }
  if (await fs.pathExists(path.join(cwd, 'requirements.txt')) ||
      await fs.pathExists(path.join(cwd, 'pyproject.toml'))) {
    return 'python';
  }
  if (await fs.pathExists(path.join(cwd, 'go.mod'))) {
    return 'go';
  }
  if (await fs.pathExists(path.join(cwd, 'Cargo.toml'))) {
    return 'rust';
  }
  if (await fs.pathExists(path.join(cwd, 'pom.xml')) ||
      await fs.pathExists(path.join(cwd, 'build.gradle'))) {
    return 'java';
  }
  return 'unknown';
}

/**
 * Get git information
 */
async function getGitInfo(cwd: string) {
  try {
    const isGit = await fs.pathExists(path.join(cwd, '.git'));
    if (!isGit) {
      return { enabled: false };
    }

    const branch = await execa('git', ['branch', '--show-current'], { cwd });
    const remote = await execa('git', ['remote', 'get-url', 'origin'], { cwd }).catch(() => null);
    const status = await execa('git', ['status', '--porcelain'], { cwd });

    return {
      enabled: true,
      branch: branch.stdout.trim(),
      remote: remote?.stdout.trim() || null,
      hasChanges: status.stdout.trim().length > 0,
    };
  } catch (error) {
    return { enabled: false, error: 'Git not available' };
  }
}

/**
 * Find docker-compose files
 */
async function findDockerComposeFiles(cwd: string): Promise<string[]> {
  const patterns = [
    'docker-compose.yml',
    'docker-compose.yaml',
    'docker/docker-compose*.yml',
    'docker/docker-compose*.yaml',
  ];

  const files = await glob(patterns, {
    cwd,
    absolute: false,
  });

  return files;
}

/**
 * Find .nexus.toml config
 */
async function findNexusConfig(cwd: string) {
  const configPath = path.join(cwd, '.nexus.toml');
  const exists = await fs.pathExists(configPath);

  if (!exists) {
    return { found: false };
  }

  return {
    found: true,
    path: configPath,
  };
}

/**
 * Get package information
 */
async function getPackageInfo(cwd: string) {
  const packageJsonPath = path.join(cwd, 'package.json');

  if (await fs.pathExists(packageJsonPath)) {
    const pkg = await fs.readJson(packageJsonPath);
    return {
      name: pkg.name,
      version: pkg.version,
      description: pkg.description,
    };
  }

  return null;
}

/**
 * Display workspace info
 */
function displayWorkspaceInfo(info: any): void {
  console.log(chalk.bold.cyan('\n📁 Workspace Information\n'));

  console.log(chalk.bold('Path:'), info.path);
  console.log(chalk.bold('Project Type:'), info.projectType);

  if (info.packageInfo) {
    console.log(chalk.bold('\nPackage:'));
    console.log(chalk.gray(`  Name: ${info.packageInfo.name}`));
    console.log(chalk.gray(`  Version: ${info.packageInfo.version}`));
    if (info.packageInfo.description) {
      console.log(chalk.gray(`  Description: ${info.packageInfo.description}`));
    }
  }

  console.log(chalk.bold('\nGit:'));
  if (info.git.enabled) {
    console.log(chalk.green('  ✓ Git repository'));
    console.log(chalk.gray(`  Branch: ${info.git.branch}`));
    if (info.git.remote) {
      console.log(chalk.gray(`  Remote: ${info.git.remote}`));
    }
    console.log(
      info.git.hasChanges
        ? chalk.yellow('  ⚠ Has uncommitted changes')
        : chalk.green('  ✓ Clean working tree')
    );
  } else {
    console.log(chalk.gray('  Not a git repository'));
  }

  console.log(chalk.bold('\nDocker Compose:'));
  if (info.dockerCompose.length > 0) {
    console.log(chalk.green(`  ✓ Found ${info.dockerCompose.length} file(s)`));
    info.dockerCompose.forEach((file: string) => {
      console.log(chalk.gray(`    - ${file}`));
    });
  } else {
    console.log(chalk.gray('  No docker-compose files found'));
  }

  console.log(chalk.bold('\nNexus Configuration:'));
  if (info.config.found) {
    console.log(chalk.green('  ✓ .nexus.toml found'));
    console.log(chalk.gray(`  Path: ${info.config.path}`));
  } else {
    console.log(chalk.gray('  No .nexus.toml found'));
    console.log(chalk.gray('  Run "nexus workspace init" to create one'));
  }
}

export default createWorkspaceInfoCommand;
