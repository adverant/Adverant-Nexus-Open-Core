/**
 * Test Helpers - Common utilities for testing
 *
 * Phase 7-8: Comprehensive Test Suite
 *
 * Provides:
 * - Mock Express request/response objects
 * - Mock Multer file objects
 * - Async polling utilities
 * - Database cleanup helpers
 * - Test data generation
 */

import { Request, Response } from 'express';
import { Readable } from 'stream';

/**
 * Create mock Express request object
 */
export function createMockRequest(overrides: Partial<Request> = {}): Partial<Request> {
  const req: Partial<Request> = {
    body: {},
    params: {},
    query: {},
    headers: {},
    method: 'GET',
    url: '/',
    ...overrides,
  };

  return req;
}

/**
 * Create mock Express response object with full method chain support
 */
export function createMockResponse(): Partial<Response> & {
  _status?: number;
  _json?: any;
  _sent?: boolean;
} {
  const res: any = {
    _status: 200,
    _json: null,
    _sent: false,
  };

  res.status = jest.fn((code: number) => {
    res._status = code;
    return res;
  });

  res.json = jest.fn((data: any) => {
    res._json = data;
    res._sent = true;
    return res;
  });

  res.send = jest.fn((data: any) => {
    res._json = data;
    res._sent = true;
    return res;
  });

  res.sendStatus = jest.fn((code: number) => {
    res._status = code;
    res._sent = true;
    return res;
  });

  res.set = jest.fn(() => res);
  res.header = jest.fn(() => res);
  res.type = jest.fn(() => res);

  return res;
}

/**
 * Create mock Multer file object
 */
export interface MockFileOptions {
  fieldname?: string;
  originalname?: string;
  encoding?: string;
  mimetype?: string;
  size?: number;
  buffer?: Buffer;
  destination?: string;
  filename?: string;
  path?: string;
}

export function createMockFile(options: MockFileOptions = {}): Express.Multer.File {
  const buffer = options.buffer || Buffer.from('test file content');

  return {
    fieldname: options.fieldname || 'file',
    originalname: options.originalname || 'test.pdf',
    encoding: options.encoding || '7bit',
    mimetype: options.mimetype || 'application/pdf',
    size: options.size || buffer.length,
    buffer,
    destination: options.destination || '/tmp',
    filename: options.filename || 'test.pdf',
    path: options.path || '/tmp/test.pdf',
    stream: Readable.from(buffer),
  } as Express.Multer.File;
}

/**
 * Wait for a condition to become true (with timeout)
 *
 * Useful for testing async operations, eventual consistency, etc.
 *
 * @example
 * await waitForCondition(() => cache.has('key'), 5000, 100);
 */
export async function waitForCondition(
  condition: () => boolean | Promise<boolean>,
  timeoutMs = 5000,
  pollIntervalMs = 100
): Promise<void> {
  const startTime = Date.now();

  while (Date.now() - startTime < timeoutMs) {
    const result = await Promise.resolve(condition());

    if (result) {
      return;
    }

    await sleep(pollIntervalMs);
  }

  throw new Error(
    `Condition not met within ${timeoutMs}ms (polled every ${pollIntervalMs}ms)`
  );
}

/**
 * Sleep for specified milliseconds
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Generate random string for unique test data
 */
export function randomString(length = 8): string {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let result = '';

  for (let i = 0; i < length; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }

  return result;
}

/**
 * Generate unique test user ID
 */
export function generateTestUserId(): string {
  return `test-user-${Date.now()}-${randomString(6)}`;
}

/**
 * Generate unique test tenant ID
 */
export function generateTestTenantId(): string {
  return `test-tenant-${Date.now()}-${randomString(6)}`;
}

/**
 * Generate unique test job ID
 */
export function generateTestJobId(): string {
  return `test-job-${Date.now()}-${randomString(8)}`;
}

/**
 * Create base64 encoded file content
 */
export function createBase64File(content: string): string {
  return Buffer.from(content).toString('base64');
}

/**
 * Create buffer from base64 string
 */
export function base64ToBuffer(base64: string): Buffer {
  return Buffer.from(base64, 'base64');
}

/**
 * Measure execution time of a function
 */
export async function measureTime<T>(
  fn: () => Promise<T>
): Promise<{ result: T; durationMs: number }> {
  const startTime = Date.now();
  const result = await fn();
  const durationMs = Date.now() - startTime;

  return { result, durationMs };
}

/**
 * Retry a function until it succeeds or max retries reached
 */
export async function retry<T>(
  fn: () => Promise<T>,
  maxRetries = 3,
  delayMs = 1000
): Promise<T> {
  let lastError: Error | null = null;

  for (let i = 0; i < maxRetries; i++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error as Error;

      if (i < maxRetries - 1) {
        await sleep(delayMs);
      }
    }
  }

  throw new Error(
    `Failed after ${maxRetries} retries. Last error: ${lastError?.message}`
  );
}

/**
 * Assert that a promise rejects with specific error message
 */
export async function expectToReject(
  fn: () => Promise<any>,
  expectedMessage?: string | RegExp
): Promise<void> {
  let didReject = false;
  let error: Error | null = null;

  try {
    await fn();
  } catch (e) {
    didReject = true;
    error = e as Error;
  }

  if (!didReject) {
    throw new Error('Expected promise to reject, but it resolved');
  }

  if (expectedMessage && error) {
    if (typeof expectedMessage === 'string') {
      if (!error.message.includes(expectedMessage)) {
        throw new Error(
          `Expected error message to include "${expectedMessage}", but got "${error.message}"`
        );
      }
    } else {
      if (!expectedMessage.test(error.message)) {
        throw new Error(
          `Expected error message to match ${expectedMessage}, but got "${error.message}"`
        );
      }
    }
  }
}

/**
 * Create spy on console methods (useful for testing logging)
 */
export interface ConsoleSpy {
  log: jest.SpyInstance;
  error: jest.SpyInstance;
  warn: jest.SpyInstance;
  info: jest.SpyInstance;
  restore: () => void;
}

export function spyOnConsole(): ConsoleSpy {
  const logSpy = jest.spyOn(console, 'log').mockImplementation();
  const errorSpy = jest.spyOn(console, 'error').mockImplementation();
  const warnSpy = jest.spyOn(console, 'warn').mockImplementation();
  const infoSpy = jest.spyOn(console, 'info').mockImplementation();

  return {
    log: logSpy,
    error: errorSpy,
    warn: warnSpy,
    info: infoSpy,
    restore: () => {
      logSpy.mockRestore();
      errorSpy.mockRestore();
      warnSpy.mockRestore();
      infoSpy.mockRestore();
    },
  };
}

/**
 * Suppress console output during tests (restore after test)
 */
export function suppressConsole(): () => void {
  const originalLog = console.log;
  const originalError = console.error;
  const originalWarn = console.warn;
  const originalInfo = console.info;

  console.log = jest.fn();
  console.error = jest.fn();
  console.warn = jest.fn();
  console.info = jest.fn();

  return () => {
    console.log = originalLog;
    console.error = originalError;
    console.warn = originalWarn;
    console.info = originalInfo;
  };
}
