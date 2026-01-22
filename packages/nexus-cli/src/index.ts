#!/usr/bin/env node

/**
 * Nexus CLI - Main Entry Point
 *
 * World-class CLI for Adverant-Nexus
 * Surpassing Claude Code and Gemini CLI
 */

import chalk from 'chalk';
import boxen from 'boxen';
// @ts-ignore - no types available
import updateNotifier from 'update-notifier';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { readFileSync } from 'fs';
import { runCLI } from './cli.js';
import { setupGlobalErrorHandlers } from './utils/error-handler.js';
import { logger } from './utils/logger.js';

// ESM compatibility for __dirname
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * Display banner
 */
function displayBanner(): void {
  const banner = chalk.cyan.bold(`
╔═══════════════════════════════════════════════════════════════╗
║                                                               ║
║              🧠  Adverant-Nexus CLI v2.0.0                   ║
║                                                               ║
║     World-Class CLI for 32+ Microservices & 70+ AI Tools     ║
║                                                               ║
╚═══════════════════════════════════════════════════════════════╝
  `);

  console.log(banner);
}

/**
 * Check for updates
 */
async function checkForUpdates(): Promise<void> {
  try {
    // Read package.json for version info
    const packageJsonPath = join(__dirname, '..', 'package.json');
    const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf-8'));

    const notifier = updateNotifier({
      pkg: packageJson,
      updateCheckInterval: 1000 * 60 * 60 * 24, // 24 hours
    });

    if (notifier.update) {
      const message = `
Update available ${chalk.dim(notifier.update.current)} → ${chalk.green(notifier.update.latest)}

Run ${chalk.cyan(`npm install -g ${packageJson.name}`)} to update
      `;

      console.log(
        boxen(message, {
          padding: 1,
          margin: 1,
          borderStyle: 'round',
          borderColor: 'yellow',
        })
      );
    }
  } catch (error) {
    // Silently fail update check
    logger.debug('Update check failed:', error);
  }
}

/**
 * Main entry point
 */
async function main(): Promise<void> {
  // Setup global error handlers first
  setupGlobalErrorHandlers(process.argv.includes('--verbose') || process.argv.includes('-v'));

  // Show banner unless --quiet or --no-banner
  if (!process.argv.includes('--quiet') && !process.argv.includes('-q') && !process.argv.includes('--no-banner')) {
    displayBanner();
  }

  // Check for updates (async, don't block)
  checkForUpdates().catch(() => {
    // Silently fail
  });

  // Handle special cases
  const args = process.argv.slice(2);

  // Show version
  if (args.includes('--version') || args.includes('-V')) {
    console.log('2.0.0');
    process.exit(0);
  }

  // Show help
  if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
    // Will be handled by Commander
  }

  // Run CLI
  try {
    await runCLI();
  } catch (error) {
    logger.error('CLI execution failed:', error);
    process.exit(1);
  }
}

// Execute main
main().catch((error) => {
  console.error(chalk.red.bold('Fatal error:'), error);
  process.exit(1);
});
