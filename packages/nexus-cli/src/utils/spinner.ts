/**
 * Spinner Utilities for Nexus CLI
 *
 * Provides spinners and progress indicators for long-running operations
 */

import ora, { Ora, Options as OraOptions } from 'ora';
import chalk from 'chalk';
import type { ProgressController, ProgressOptions } from '../types/output.js';

export class SpinnerManager {
  private currentSpinner: Ora | null = null;

  /**
   * Create and start a spinner
   */
  start(options: string | ProgressOptions): ProgressController {
    // Stop existing spinner if any
    this.stop();

    const message = typeof options === 'string' ? options : options.message || 'Loading...';
    const spinner = typeof options === 'string' ? 'dots' : options.spinner ? 'dots' : undefined;

    this.currentSpinner = ora({
      text: message,
      spinner: spinner as any,
      color: 'cyan',
    }).start();

    return this.createController(this.currentSpinner);
  }

  /**
   * Create a progress controller from an ora spinner
   */
  private createController(spinner: Ora): ProgressController {
    return {
      update: (progress: number | ProgressOptions) => {
        if (typeof progress === 'number') {
          spinner.text = `${spinner.text} (${Math.round(progress)}%)`;
        } else {
          if (progress.message) {
            spinner.text = progress.message;
          }
          if (progress.showPercentage && progress.current !== undefined && progress.total !== undefined) {
            const percentage = Math.round((progress.current / progress.total) * 100);
            spinner.text = `${progress.message || spinner.text} (${percentage}%)`;
          }
        }
      },

      succeed: (message?: string) => {
        spinner.succeed(message || spinner.text);
        this.currentSpinner = null;
      },

      fail: (message?: string) => {
        spinner.fail(message || spinner.text);
        this.currentSpinner = null;
      },

      warn: (message?: string) => {
        spinner.warn(message || spinner.text);
        this.currentSpinner = null;
      },

      info: (message?: string) => {
        spinner.info(message || spinner.text);
        this.currentSpinner = null;
      },

      stop: () => {
        spinner.stop();
        this.currentSpinner = null;
      },
    };
  }

  /**
   * Stop current spinner if any
   */
  stop(): void {
    if (this.currentSpinner) {
      this.currentSpinner.stop();
      this.currentSpinner = null;
    }
  }

  /**
   * Quick success message with checkmark
   */
  success(message: string): void {
    ora().succeed(chalk.green(message));
  }

  /**
   * Quick error message with cross
   */
  error(message: string): void {
    ora().fail(chalk.red(message));
  }

  /**
   * Quick warning message
   */
  warn(message: string): void {
    ora().warn(chalk.yellow(message));
  }

  /**
   * Quick info message
   */
  info(message: string): void {
    ora().info(chalk.blue(message));
  }
}

// Singleton instance
export const spinner = new SpinnerManager();

/**
 * Create a simple spinner with a message
 */
export function createSpinner(message: string): ProgressController {
  return spinner.start(message);
}

/**
 * Execute an async function with a spinner
 */
export async function withSpinner<T>(
  message: string,
  fn: () => Promise<T>,
  successMessage?: string,
  errorMessage?: string
): Promise<T> {
  const s = spinner.start(message);

  try {
    const result = await fn();
    s.succeed(successMessage || message);
    return result;
  } catch (error) {
    s.fail(errorMessage || `${message} failed`);
    throw error;
  }
}
