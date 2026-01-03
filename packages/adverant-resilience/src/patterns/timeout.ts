/**
 * Timeout Pattern
 * Execute operations with time limits
 */

import { TimeoutOptions } from '../types';

export class TimeoutError extends Error {
  constructor(message: string, public readonly timeoutMs: number) {
    super(message);
    this.name = 'TimeoutError';
    Error.captureStackTrace(this, this.constructor);
  }
}

/**
 * Execute function with timeout
 */
export async function withTimeout<T>(
  fn: () => Promise<T>,
  options: TimeoutOptions
): Promise<T> {
  const { timeout, timeoutError, onTimeout } = options;

  return Promise.race([
    fn(),
    new Promise<T>((_, reject) => {
      setTimeout(() => {
        onTimeout?.();
        const error = timeoutError || new TimeoutError(
          `Operation timed out after ${timeout}ms`,
          timeout
        );
        reject(error);
      }, timeout);
    }),
  ]);
}

/**
 * Create timeout wrapper
 */
export function createTimeout(defaultTimeout: number) {
  return async <T>(
    fn: () => Promise<T>,
    timeout?: number
  ): Promise<T> => {
    return withTimeout(fn, { timeout: timeout || defaultTimeout });
  };
}
