/**
 * Workspace Git Status Command
 *
 * Show git status similar to Claude Code CLI
 */

import { Command } from 'commander';
import chalk from 'chalk';
import { execa } from 'execa';
import Table from 'cli-table3';

export function createWorkspaceGitStatusCommand(): Command {
  const command = new Command('git-status')
    .description('Show git status')
    .option('--output-format <format>', 'Output format (text|json|table)', 'text')
    .action(async (options) => {
      try {
        const status = await getGitStatus();

        if (options.outputFormat === 'json') {
          console.log(JSON.stringify(status, null, 2));
        } else if (options.outputFormat === 'table') {
          displayStatusTable(status);
        } else {
          displayStatusText(status);
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
 * Get git status information
 */
async function getGitStatus() {
  try {
    // Check if in git repo
    await execa('git', ['rev-parse', '--git-dir']);

    const branch = await execa('git', ['branch', '--show-current']);
    const statusOutput = await execa('git', ['status', '--porcelain']);
    const remote = await execa('git', ['remote', 'get-url', 'origin']).catch(() => null);

    // Parse status
    const files = parseGitStatus(statusOutput.stdout);

    // Get commit info
    const lastCommit = await execa('git', ['log', '-1', '--format=%H|%s|%an|%ar']);
    const [hash, message, author, time] = lastCommit.stdout.split('|');

    return {
      branch: branch.stdout.trim(),
      remote: remote?.stdout.trim() || null,
      files,
      lastCommit: {
        hash: hash.substring(0, 8),
        message,
        author,
        time,
      },
      hasChanges: files.length > 0,
    };
  } catch (error) {
    throw new Error('Not a git repository');
  }
}

/**
 * Parse git status porcelain output
 */
function parseGitStatus(output: string) {
  if (!output.trim()) return [];

  const files: any[] = [];
  const lines = output.split('\n').filter(l => l.trim());

  for (const line of lines) {
    const status = line.substring(0, 2);
    const file = line.substring(3);

    let type: string;
    if (status.includes('M')) type = 'modified';
    else if (status.includes('A')) type = 'added';
    else if (status.includes('D')) type = 'deleted';
    else if (status.includes('R')) type = 'renamed';
    else if (status.includes('C')) type = 'copied';
    else if (status.includes('?')) type = 'untracked';
    else type = 'unknown';

    files.push({ file, status: status.trim(), type });
  }

  return files;
}

/**
 * Display status as text
 */
function displayStatusText(status: any): void {
  console.log(chalk.bold.cyan('\n📊 Git Status\n'));

  console.log(chalk.bold('Branch:'), status.branch);

  if (status.remote) {
    console.log(chalk.bold('Remote:'), status.remote);
  }

  console.log(chalk.bold('\nLast Commit:'));
  console.log(chalk.gray(`  ${status.lastCommit.hash} - ${status.lastCommit.message}`));
  console.log(chalk.gray(`  by ${status.lastCommit.author} ${status.lastCommit.time}`));

  if (status.hasChanges) {
    console.log(chalk.bold.yellow('\n⚠️  Changes:\n'));

    const grouped = groupFilesByType(status.files);

    if (grouped.modified.length > 0) {
      console.log(chalk.yellow('  Modified:'));
      grouped.modified.forEach((f: any) => {
        console.log(chalk.gray(`    ${f.file}`));
      });
    }

    if (grouped.added.length > 0) {
      console.log(chalk.green('  Added:'));
      grouped.added.forEach((f: any) => {
        console.log(chalk.gray(`    ${f.file}`));
      });
    }

    if (grouped.deleted.length > 0) {
      console.log(chalk.red('  Deleted:'));
      grouped.deleted.forEach((f: any) => {
        console.log(chalk.gray(`    ${f.file}`));
      });
    }

    if (grouped.untracked.length > 0) {
      console.log(chalk.gray('  Untracked:'));
      grouped.untracked.forEach((f: any) => {
        console.log(chalk.gray(`    ${f.file}`));
      });
    }

    console.log(
      chalk.yellow(`\n  Total: ${status.files.length} file(s) with changes`)
    );
  } else {
    console.log(chalk.green('\n✓ Working tree clean'));
  }
}

/**
 * Display status as table
 */
function displayStatusTable(status: any): void {
  if (!status.hasChanges) {
    console.log(chalk.green('✓ Working tree clean'));
    return;
  }

  const table = new Table({
    head: [chalk.bold('File'), chalk.bold('Status'), chalk.bold('Type')],
    colWidths: [50, 10, 12],
  });

  status.files.forEach((file: any) => {
    table.push([
      file.file,
      file.status,
      getTypeDisplay(file.type),
    ]);
  });

  console.log(table.toString());
}

/**
 * Group files by type
 */
function groupFilesByType(files: any[]) {
  return {
    modified: files.filter(f => f.type === 'modified'),
    added: files.filter(f => f.type === 'added'),
    deleted: files.filter(f => f.type === 'deleted'),
    untracked: files.filter(f => f.type === 'untracked'),
  };
}

/**
 * Get colored type display
 */
function getTypeDisplay(type: string): string {
  switch (type) {
    case 'modified':
      return chalk.yellow('Modified');
    case 'added':
      return chalk.green('Added');
    case 'deleted':
      return chalk.red('Deleted');
    case 'untracked':
      return chalk.gray('Untracked');
    default:
      return type;
  }
}

export default createWorkspaceGitStatusCommand;
