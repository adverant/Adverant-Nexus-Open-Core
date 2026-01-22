/**
 * Session Import Command
 *
 * Import session from JSON file or stdin
 */

import { Command } from 'commander';
import chalk from 'chalk';
import fs from 'fs-extra';
import SessionStorage from '../../core/session/session-storage.js';

export function createSessionImportCommand(): Command {
  const command = new Command('import')
    .description('Import session from JSON')
    .argument('[file]', 'JSON file path (default: stdin)')
    .action(async (file: string | undefined) => {
      try {
        const storage = new SessionStorage();

        let json: string;

        if (file) {
          json = await fs.readFile(file, 'utf-8');
        } else {
          // Read from stdin
          json = await readStdin();
        }

        const session = await storage.import(json);

        console.log(chalk.green('✅ Session imported successfully'));
        console.log(chalk.bold('Name:'), session.name);
        console.log(chalk.bold('ID:'), session.id);

        process.exit(0);
      } catch (error) {
        console.error(chalk.red('Error:'), error instanceof Error ? error.message : String(error));
        process.exit(1);
      }
    });

  return command;
}

/**
 * Read data from stdin
 */
async function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];

    process.stdin.on('data', (chunk) => {
      chunks.push(chunk);
    });

    process.stdin.on('end', () => {
      resolve(Buffer.concat(chunks).toString('utf-8'));
    });

    process.stdin.on('error', reject);
  });
}

export default createSessionImportCommand;
