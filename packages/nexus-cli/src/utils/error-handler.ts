/**
 * Comprehensive Error Handler for Nexus CLI
 *
 * Provides custom error types, error formatting, and user-friendly
 * error messages with proper exit codes.
 */

import chalk from 'chalk';
import { logger } from './logger.js';
import { isHttpError, isNetworkError, getErrorMessage, getHttpStatus } from '../types/errors.js';

/**
 * Base error class for all CLI errors
 */
export class NexusError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly exitCode: number = 1,
    public readonly context?: Record<string, unknown>
  ) {
    super(message);
    this.name = 'NexusError';
    Error.captureStackTrace(this, this.constructor);
  }
}

/**
 * Configuration errors
 */
export class ConfigurationError extends NexusError {
  constructor(message: string, context?: Record<string, unknown>) {
    super(message, 'CONFIG_ERROR', 1, context);
    this.name = 'ConfigurationError';
  }
}

/**
 * Validation errors
 */
export class ValidationError extends NexusError {
  constructor(message: string, context?: Record<string, unknown>) {
    super(message, 'VALIDATION_ERROR', 1, context);
    this.name = 'ValidationError';
  }
}

/**
 * Service connection errors
 */
export class ServiceConnectionError extends NexusError {
  constructor(message: string, context?: Record<string, unknown>) {
    super(message, 'SERVICE_CONNECTION_ERROR', 1, context);
    this.name = 'ServiceConnectionError';
  }
}

/**
 * Authentication errors
 */
export class AuthenticationError extends NexusError {
  constructor(message: string, context?: Record<string, unknown>) {
    super(message, 'AUTHENTICATION_ERROR', 1, context);
    this.name = 'AuthenticationError';
  }
}

/**
 * Command execution errors
 */
export class CommandExecutionError extends NexusError {
  constructor(message: string, context?: Record<string, unknown>) {
    super(message, 'COMMAND_EXECUTION_ERROR', 1, context);
    this.name = 'CommandExecutionError';
  }
}

/**
 * Plugin errors
 */
export class PluginError extends NexusError {
  constructor(message: string, context?: Record<string, unknown>) {
    super(message, 'PLUGIN_ERROR', 1, context);
    this.name = 'PluginError';
  }
}

/**
 * Workspace errors
 */
export class WorkspaceError extends NexusError {
  constructor(message: string, context?: Record<string, unknown>) {
    super(message, 'WORKSPACE_ERROR', 1, context);
    this.name = 'WorkspaceError';
  }
}

/**
 * Map error types to exit codes
 */
const EXIT_CODE_MAP: Record<string, number> = {
  CONFIG_ERROR: 1,
  VALIDATION_ERROR: 1,
  SERVICE_CONNECTION_ERROR: 2,
  AUTHENTICATION_ERROR: 3,
  COMMAND_EXECUTION_ERROR: 4,
  PLUGIN_ERROR: 5,
  WORKSPACE_ERROR: 6,
  UNKNOWN_ERROR: 1,
};

/**
 * Get exit code for an error
 */
export function getExitCode(error: unknown): number {
  if (error instanceof NexusError) {
    return error.exitCode;
  }

  if (isHttpError(error)) {
    const status = getHttpStatus(error);
    if (status === 401 || status === 403) {
      return EXIT_CODE_MAP.AUTHENTICATION_ERROR;
    }
    if (status && status >= 500) {
      return EXIT_CODE_MAP.SERVICE_CONNECTION_ERROR;
    }
    return EXIT_CODE_MAP.COMMAND_EXECUTION_ERROR;
  }

  if (isNetworkError(error)) {
    return EXIT_CODE_MAP.SERVICE_CONNECTION_ERROR;
  }

  return EXIT_CODE_MAP.UNKNOWN_ERROR;
}

/**
 * Format error for display
 */
export function formatError(error: unknown, verbose: boolean = false): string {
  const lines: string[] = [];

  // Error type and message
  if (error instanceof NexusError) {
    lines.push(chalk.red.bold(`${error.name}: ${error.message}`));

    // Add context if available
    if (error.context && Object.keys(error.context).length > 0) {
      lines.push('');
      lines.push(chalk.yellow('Context:'));
      for (const [key, value] of Object.entries(error.context)) {
        lines.push(`  ${chalk.gray(key)}: ${JSON.stringify(value)}`);
      }
    }

    // Add stack trace in verbose mode
    if (verbose && error.stack) {
      lines.push('');
      lines.push(chalk.gray('Stack Trace:'));
      lines.push(chalk.gray(error.stack));
    }
  } else if (isHttpError(error)) {
    const status = getHttpStatus(error);
    const message = getErrorMessage(error);

    lines.push(chalk.red.bold(`HTTP Error (${status}): ${message}`));

    // Add response data if available
    if (verbose && error.response?.data) {
      lines.push('');
      lines.push(chalk.yellow('Response:'));
      lines.push(JSON.stringify(error.response.data, null, 2));
    }
  } else if (isNetworkError(error)) {
    lines.push(chalk.red.bold(`Network Error: ${error.message}`));
    lines.push('');
    lines.push(chalk.yellow('Suggestions:'));
    lines.push('  • Check if the Nexus services are running');
    lines.push('  • Verify network connectivity');
    lines.push('  • Check the API URL configuration');

    if (error.code === 'ECONNREFUSED') {
      lines.push('');
      lines.push(chalk.gray('Hint: Connection refused. Is the service running?'));
    }
  } else {
    const message = getErrorMessage(error);
    lines.push(chalk.red.bold(`Error: ${message}`));

    // Add stack trace in verbose mode
    if (verbose && error instanceof Error && error.stack) {
      lines.push('');
      lines.push(chalk.gray('Stack Trace:'));
      lines.push(chalk.gray(error.stack));
    }
  }

  return lines.join('\n');
}

/**
 * Handle error and exit
 */
export function handleError(error: unknown, verbose: boolean = false): never {
  const formatted = formatError(error, verbose);
  console.error(formatted);

  const exitCode = getExitCode(error);

  // Log to file if logger has file output
  logger.error(`Exiting with code ${exitCode}: ${getErrorMessage(error)}`);

  process.exit(exitCode);

  // This will never be reached but TypeScript needs it
  throw new Error('Process should have exited');
}

/**
 * Global error handler for uncaught exceptions
 */
export function setupGlobalErrorHandlers(verbose: boolean = false): void {
  process.on('uncaughtException', (error: Error) => {
    logger.error('Uncaught Exception:', error);
    handleError(error, verbose);
  });

  process.on('unhandledRejection', (reason: unknown) => {
    logger.error('Unhandled Promise Rejection:', reason);
    handleError(reason, verbose);
  });

  // Handle SIGINT gracefully
  process.on('SIGINT', () => {
    console.log('\n' + chalk.yellow('Interrupted by user'));
    process.exit(130);
  });

  // Handle SIGTERM gracefully
  process.on('SIGTERM', () => {
    console.log('\n' + chalk.yellow('Terminated'));
    process.exit(143);
  });
}

/**
 * Create error with suggestions
 */
export function createErrorWithSuggestions(
  message: string,
  suggestions: string[],
  ErrorClass: typeof NexusError = NexusError
): NexusError {
  const fullMessage = `${message}\n\nSuggestions:\n${suggestions.map((s) => `  • ${s}`).join('\n')}`;
  return new ErrorClass(fullMessage, 'ERROR_WITH_SUGGESTIONS');
}

/**
 * Wrap async function with error handling
 */
export function wrapAsyncError<T extends (...args: any[]) => Promise<any>>(
  fn: T,
  verbose: boolean = false
): T {
  return (async (...args: any[]) => {
    try {
      return await fn(...args);
    } catch (error) {
      handleError(error, verbose);
    }
  }) as T;
}
