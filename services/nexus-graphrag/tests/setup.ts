/**
 * Test Setup File
 * Runs before all tests to configure the test environment
 */

/// <reference path="./globals.d.ts" />

import { expect, beforeAll, afterAll, jest } from '@jest/globals';
import dotenv from 'dotenv';
import path from 'path';

// Load test environment variables
dotenv.config({ path: path.join(__dirname, '../.env.test') });

// Set test environment
process.env.NODE_ENV = 'test';

// Configure test timeouts
if (!process.env.TEST_TIMEOUT) {
  process.env.TEST_TIMEOUT = '30000';
}

// Mock console methods to reduce noise during tests
if (process.env.SILENT_TESTS === 'true') {
  global.console.log = jest.fn();
  global.console.info = jest.fn();
  global.console.warn = jest.fn();
  // Keep console.error for important messages
}

// Add custom matchers
expect.extend({
  toHaveRealData(received: any) {
    const pass = received !== null &&
                 received !== undefined &&
                 received !== '' &&
                 (typeof received !== 'object' || Object.keys(received).length > 0);

    return {
      pass,
      message: () =>
        pass
          ? `Expected ${received} not to have real data`
          : `Expected ${received} to have real data`
    };
  }
});

// Global test utilities
global.testUtils = {
  delay: (ms: number) => new Promise(resolve => setTimeout(resolve, ms)),

  retry: async (fn: () => Promise<any>, retries = 3, delay = 1000) => {
    for (let i = 0; i < retries; i++) {
      try {
        return await fn();
      } catch (error) {
        if (i === retries - 1) throw error;
        await global.testUtils.delay(delay);
      }
    }
  },

  randomString: (length = 10) => {
    return Math.random().toString(36).substring(2, 2 + length);
  },

  measureTime: async (fn: () => Promise<any>) => {
    const start = performance.now();
    const result = await fn();
    const duration = performance.now() - start;
    return { result, duration };
  }
};

// Setup test database connections
beforeAll(async () => {
  // Ensure test databases are ready
  const { TestConnections } = await import('./test-config');
  const connections = TestConnections.getInstance();

  // Wait for services to be healthy
  let retries = 30;
  while (retries > 0) {
    const healthy = await connections.healthCheck();
    if (healthy) break;

    retries--;
    await global.testUtils.delay(2000);
  }

  if (retries === 0) {
    throw new Error('Test services failed to become healthy');
  }
});

// Cleanup after all tests
afterAll(async () => {
  const { TestConnections } = await import('./test-config');
  const connections = TestConnections.getInstance();
  await connections.cleanup();
});

// Handle unhandled rejections
process.on('unhandledRejection', (reason) => {
  console.error('Unhandled Rejection in tests:', reason);
});