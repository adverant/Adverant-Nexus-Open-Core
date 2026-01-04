/**
 * Progress Renderer
 *
 * Renders progress indicators (spinners, progress bars)
 */

import ora, { Ora } from 'ora';
import { Listr, ListrTask } from 'listr2';
import chalk from 'chalk';
import logSymbols from 'log-symbols';
import type { ProgressOptions, ProgressController } from '../../types/output.js';

export class ProgressRenderer {
  private noColor: boolean = false;

  constructor() {
    this.noColor = !!process.env.NO_COLOR;
  }

  /**
   * Create progress controller (spinner or progress bar)
   */
  create(options: ProgressOptions): ProgressController {
    if (options.total !== undefined && options.total > 0) {
      return this.createProgressBar(options);
    } else {
      return this.createSpinner(options);
    }
  }

  /**
   * Create spinner
   */
  private createSpinner(options: ProgressOptions): ProgressController {
    const spinner = ora({
      text: options.message || 'Loading...',
      spinner: options.spinner !== false ? 'dots' : undefined,
      color: this.noColor ? undefined : 'cyan',
    });

    if (process.stdout.isTTY) {
      spinner.start();
    }

    return {
      update: (progressOrOptions: number | ProgressOptions) => {
        if (typeof progressOrOptions === 'object') {
          if (progressOrOptions.message) {
            spinner.text = progressOrOptions.message;
          }
        } else {
          // Progress percentage
          if (options.showPercentage) {
            spinner.text = `${options.message} (${Math.round(progressOrOptions)}%)`;
          }
        }
      },

      succeed: (message?: string) => {
        if (process.stdout.isTTY) {
          spinner.succeed(message || options.message);
        } else {
          console.log(`${logSymbols.success} ${message || options.message}`);
        }
      },

      fail: (message?: string) => {
        if (process.stdout.isTTY) {
          spinner.fail(message || options.message);
        } else {
          console.log(`${logSymbols.error} ${message || options.message}`);
        }
      },

      warn: (message?: string) => {
        if (process.stdout.isTTY) {
          spinner.warn(message || options.message);
        } else {
          console.log(`${logSymbols.warning} ${message || options.message}`);
        }
      },

      info: (message?: string) => {
        if (process.stdout.isTTY) {
          spinner.info(message || options.message);
        } else {
          console.log(`${logSymbols.info} ${message || options.message}`);
        }
      },

      stop: () => {
        if (process.stdout.isTTY) {
          spinner.stop();
        }
      },
    };
  }

  /**
   * Create progress bar
   */
  private createProgressBar(options: ProgressOptions): ProgressController {
    const total = options.total || 100;
    let current = options.current || 0;
    const startTime = Date.now();

    const renderBar = () => {
      if (!process.stdout.isTTY) return;

      const percent = (current / total) * 100;
      const barLength = 30;
      const filled = Math.round((barLength * current) / total);
      const empty = barLength - filled;

      const bar = this.noColor
        ? `[${'='.repeat(filled)}${' '.repeat(empty)}]`
        : `[${chalk.cyan('='.repeat(filled))}${' '.repeat(empty)}]`;

      let output = `${bar} ${Math.round(percent)}%`;

      if (options.showPercentage !== false) {
        output += ` ${current}/${total}`;
      }

      if (options.showETA && current > 0) {
        const elapsed = Date.now() - startTime;
        const rate = current / elapsed;
        const remaining = total - current;
        const eta = remaining / rate;
        const seconds = Math.round(eta / 1000);
        output += ` ETA: ${seconds}s`;
      }

      if (options.message) {
        output += ` ${options.message}`;
      }

      // Clear line and write
      process.stdout.write('\r\x1b[K' + output);
    };

    // Initial render
    renderBar();

    return {
      update: (progressOrOptions: number | ProgressOptions) => {
        if (typeof progressOrOptions === 'number') {
          current = progressOrOptions;
        } else {
          if (progressOrOptions.current !== undefined) {
            current = progressOrOptions.current;
          }
          if (progressOrOptions.message) {
            options.message = progressOrOptions.message;
          }
        }
        renderBar();
      },

      succeed: (message?: string) => {
        current = total;
        renderBar();
        if (process.stdout.isTTY) {
          process.stdout.write('\n');
        }
        console.log(`${logSymbols.success} ${message || 'Complete'}`);
      },

      fail: (message?: string) => {
        if (process.stdout.isTTY) {
          process.stdout.write('\n');
        }
        console.log(`${logSymbols.error} ${message || 'Failed'}`);
      },

      warn: (message?: string) => {
        if (process.stdout.isTTY) {
          process.stdout.write('\n');
        }
        console.log(`${logSymbols.warning} ${message || 'Warning'}`);
      },

      info: (message?: string) => {
        if (process.stdout.isTTY) {
          process.stdout.write('\n');
        }
        console.log(`${logSymbols.info} ${message || 'Info'}`);
      },

      stop: () => {
        if (process.stdout.isTTY) {
          process.stdout.write('\n');
        }
      },
    };
  }

  /**
   * Create task list with progress
   */
  createTaskList<T = any>(
    tasks: Array<{
      title: string;
      task: (ctx: T, task: any) => any;
    }>,
    options?: {
      concurrent?: boolean;
      exitOnError?: boolean;
    }
  ): {
    run: (ctx?: T) => Promise<T>;
  } {
    const listr = new Listr<T>(
      tasks.map((t) => ({
        title: t.title,
        task: t.task,
      })),
      {
        concurrent: options?.concurrent ?? false,
        exitOnError: options?.exitOnError ?? true,
        rendererOptions: {
          collapseSubtasks: false,
        },
      }
    );

    return {
      run: async (ctx?: T) => {
        return await listr.run(ctx);
      },
    };
  }

  /**
   * Simple progress bar (no dependencies)
   */
  renderSimpleProgress(current: number, total: number, message?: string): void {
    const percent = (current / total) * 100;
    const barLength = 30;
    const filled = Math.round((barLength * current) / total);
    const empty = barLength - filled;

    const bar = this.noColor
      ? `[${'='.repeat(filled)}${' '.repeat(empty)}]`
      : `[${chalk.cyan('='.repeat(filled))}${' '.repeat(empty)}]`;

    const output = `${bar} ${Math.round(percent)}% ${current}/${total} ${message || ''}`;

    if (process.stdout.isTTY) {
      process.stdout.write('\r\x1b[K' + output);
    } else {
      console.log(output);
    }
  }

  /**
   * Multi-line progress (for multiple concurrent operations)
   */
  createMultiProgress(
    items: Array<{ id: string; message: string }>
  ): {
    update: (id: string, progress: number, message?: string) => void;
    complete: (id: string, message?: string) => void;
    fail: (id: string, message?: string) => void;
    close: () => void;
  } {
    const states = new Map<string, { progress: number; message: string; status: string }>();

    items.forEach((item) => {
      states.set(item.id, {
        progress: 0,
        message: item.message,
        status: 'pending',
      });
    });

    const render = () => {
      if (!process.stdout.isTTY) return;

      // Move cursor up to start
      const lines = states.size;
      if (lines > 0) {
        process.stdout.write(`\x1b[${lines}A`);
      }

      // Render each line
      states.forEach((state, id) => {
        const barLength = 20;
        const filled = Math.round((barLength * state.progress) / 100);
        const empty = barLength - filled;

        const bar = this.noColor
          ? `[${'='.repeat(filled)}${' '.repeat(empty)}]`
          : `[${chalk.cyan('='.repeat(filled))}${' '.repeat(empty)}]`;

        let symbol = '○';
        if (state.status === 'complete') {
          symbol = this.noColor ? '✓' : chalk.green('✓');
        } else if (state.status === 'failed') {
          symbol = this.noColor ? '✗' : chalk.red('✗');
        } else if (state.status === 'running') {
          symbol = this.noColor ? '⚙' : chalk.cyan('⚙');
        }

        const output = `${symbol} ${bar} ${Math.round(state.progress)}% ${state.message}`;
        process.stdout.write('\r\x1b[K' + output + '\n');
      });
    };

    // Initial render
    items.forEach(() => console.log());
    render();

    return {
      update: (id: string, progress: number, message?: string) => {
        const state = states.get(id);
        if (state) {
          state.progress = progress;
          state.status = 'running';
          if (message) state.message = message;
          render();
        }
      },

      complete: (id: string, message?: string) => {
        const state = states.get(id);
        if (state) {
          state.progress = 100;
          state.status = 'complete';
          if (message) state.message = message;
          render();
        }
      },

      fail: (id: string, message?: string) => {
        const state = states.get(id);
        if (state) {
          state.status = 'failed';
          if (message) state.message = message;
          render();
        }
      },

      close: () => {
        // Move cursor to end
        if (process.stdout.isTTY) {
          console.log();
        }
      },
    };
  }

  /**
   * Set no-color mode
   */
  setNoColor(noColor: boolean): void {
    this.noColor = noColor;
  }
}

export const progressRenderer = new ProgressRenderer();
