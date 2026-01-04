/**
 * Mock Factories - Create mock objects for testing
 *
 * Phase 7-8: Comprehensive Test Suite
 *
 * Provides factories for:
 * - SandboxClient mocks
 * - Redis client mocks
 * - PostgreSQL pool mocks
 * - MinIO client mocks
 * - BullMQ job mocks
 */

import {
  SandboxClient,
  SandboxExecutionRequest,
  SandboxExecutionResult,
} from '../../clients/SandboxClient';
import { Job } from 'bullmq';

/**
 * Create mock SandboxClient
 */
export function createMockSandboxClient(overrides: Partial<SandboxClient> = {}): jest.Mocked<SandboxClient> {
  const mock: any = {
    execute: jest.fn().mockResolvedValue({
      success: true,
      stdout: 'mock output',
      stderr: '',
      exitCode: 0,
      executionTimeMs: 100,
      resourceUsage: {
        cpuTimeMs: 50,
        memoryPeakMb: 128,
      },
    } as SandboxExecutionResult),
    healthCheck: jest.fn().mockResolvedValue(true),
    getCircuitState: jest.fn().mockReturnValue('CLOSED'),
    resetCircuit: jest.fn(),
    ...overrides,
  };

  return mock;
}

/**
 * Create mock Redis client (ioredis)
 */
export interface MockRedisClient {
  get: jest.Mock;
  set: jest.Mock;
  setex: jest.Mock;
  del: jest.Mock;
  exists: jest.Mock;
  ttl: jest.Mock;
  keys: jest.Mock;
  hget: jest.Mock;
  hset: jest.Mock;
  hgetall: jest.Mock;
  hdel: jest.Mock;
  lpush: jest.Mock;
  rpush: jest.Mock;
  lpop: jest.Mock;
  rpop: jest.Mock;
  llen: jest.Mock;
  zadd: jest.Mock;
  zrange: jest.Mock;
  incr: jest.Mock;
  decr: jest.Mock;
  expire: jest.Mock;
  flushdb: jest.Mock;
  quit: jest.Mock;
  disconnect: jest.Mock;
}

export function createMockRedisClient(overrides: Partial<MockRedisClient> = {}): MockRedisClient {
  const storage = new Map<string, any>();

  const mock: MockRedisClient = {
    get: jest.fn((key: string) => Promise.resolve(storage.get(key) || null)),
    set: jest.fn((key: string, value: any) => {
      storage.set(key, value);
      return Promise.resolve('OK');
    }),
    setex: jest.fn((key: string, seconds: number, value: any) => {
      storage.set(key, value);
      return Promise.resolve('OK');
    }),
    del: jest.fn((key: string) => {
      storage.delete(key);
      return Promise.resolve(1);
    }),
    exists: jest.fn((key: string) => Promise.resolve(storage.has(key) ? 1 : 0)),
    ttl: jest.fn(() => Promise.resolve(-1)),
    keys: jest.fn((pattern: string) => Promise.resolve(Array.from(storage.keys()))),
    hget: jest.fn((key: string, field: string) => {
      const hash = storage.get(key) || {};
      return Promise.resolve(hash[field] || null);
    }),
    hset: jest.fn((key: string, field: string, value: any) => {
      const hash = storage.get(key) || {};
      hash[field] = value;
      storage.set(key, hash);
      return Promise.resolve(1);
    }),
    hgetall: jest.fn((key: string) => Promise.resolve(storage.get(key) || {})),
    hdel: jest.fn((key: string, field: string) => {
      const hash = storage.get(key) || {};
      delete hash[field];
      storage.set(key, hash);
      return Promise.resolve(1);
    }),
    lpush: jest.fn((key: string, value: any) => {
      const list = storage.get(key) || [];
      list.unshift(value);
      storage.set(key, list);
      return Promise.resolve(list.length);
    }),
    rpush: jest.fn((key: string, value: any) => {
      const list = storage.get(key) || [];
      list.push(value);
      storage.set(key, list);
      return Promise.resolve(list.length);
    }),
    lpop: jest.fn((key: string) => {
      const list = storage.get(key) || [];
      const value = list.shift();
      storage.set(key, list);
      return Promise.resolve(value || null);
    }),
    rpop: jest.fn((key: string) => {
      const list = storage.get(key) || [];
      const value = list.pop();
      storage.set(key, list);
      return Promise.resolve(value || null);
    }),
    llen: jest.fn((key: string) => {
      const list = storage.get(key) || [];
      return Promise.resolve(list.length);
    }),
    zadd: jest.fn(() => Promise.resolve(1)),
    zrange: jest.fn(() => Promise.resolve([])),
    incr: jest.fn((key: string) => {
      const value = parseInt(storage.get(key) || '0', 10) + 1;
      storage.set(key, value.toString());
      return Promise.resolve(value);
    }),
    decr: jest.fn((key: string) => {
      const value = parseInt(storage.get(key) || '0', 10) - 1;
      storage.set(key, value.toString());
      return Promise.resolve(value);
    }),
    expire: jest.fn(() => Promise.resolve(1)),
    flushdb: jest.fn(() => {
      storage.clear();
      return Promise.resolve('OK');
    }),
    quit: jest.fn(() => Promise.resolve('OK')),
    disconnect: jest.fn(() => Promise.resolve()),
    ...overrides,
  };

  return mock;
}

/**
 * Create mock PostgreSQL pool (pg)
 */
export interface MockPostgresPool {
  query: jest.Mock;
  connect: jest.Mock;
  end: jest.Mock;
}

export interface MockPostgresClient {
  query: jest.Mock;
  release: jest.Mock;
}

export function createMockPostgresPool(overrides: Partial<MockPostgresPool> = {}): MockPostgresPool {
  const mock: MockPostgresPool = {
    query: jest.fn((sql: string, params?: any[]) => {
      // Default: return empty result
      return Promise.resolve({
        rows: [],
        rowCount: 0,
        command: 'SELECT',
        fields: [],
      });
    }),
    connect: jest.fn(() => {
      const client: MockPostgresClient = {
        query: jest.fn((sql: string, params?: any[]) => {
          return Promise.resolve({
            rows: [],
            rowCount: 0,
            command: 'SELECT',
            fields: [],
          });
        }),
        release: jest.fn(),
      };
      return Promise.resolve(client);
    }),
    end: jest.fn(() => Promise.resolve()),
    ...overrides,
  };

  return mock;
}

/**
 * Create mock MinIO client
 */
export interface MockMinioClient {
  putObject: jest.Mock;
  getObject: jest.Mock;
  removeObject: jest.Mock;
  statObject: jest.Mock;
  listObjects: jest.Mock;
  bucketExists: jest.Mock;
  makeBucket: jest.Mock;
}

export function createMockMinioClient(overrides: Partial<MockMinioClient> = {}): MockMinioClient {
  const storage = new Map<string, Buffer>();

  const mock: MockMinioClient = {
    putObject: jest.fn((bucket: string, key: string, data: Buffer) => {
      storage.set(`${bucket}/${key}`, data);
      return Promise.resolve({ etag: 'mock-etag', versionId: null });
    }),
    getObject: jest.fn((bucket: string, key: string) => {
      const data = storage.get(`${bucket}/${key}`);
      if (!data) {
        return Promise.reject(new Error('Object not found'));
      }
      // Return readable stream
      const { Readable } = require('stream');
      return Promise.resolve(Readable.from(data));
    }),
    removeObject: jest.fn((bucket: string, key: string) => {
      storage.delete(`${bucket}/${key}`);
      return Promise.resolve();
    }),
    statObject: jest.fn((bucket: string, key: string) => {
      const data = storage.get(`${bucket}/${key}`);
      if (!data) {
        return Promise.reject(new Error('Object not found'));
      }
      return Promise.resolve({
        size: data.length,
        etag: 'mock-etag',
        lastModified: new Date(),
      });
    }),
    listObjects: jest.fn(() => {
      const { Readable } = require('stream');
      const stream = new Readable({ objectMode: true });
      stream.push(null); // Empty stream
      return stream;
    }),
    bucketExists: jest.fn(() => Promise.resolve(true)),
    makeBucket: jest.fn(() => Promise.resolve()),
    ...overrides,
  };

  return mock;
}

/**
 * Create mock BullMQ job
 */
export interface MockBullMQJob<T = any> {
  id: string;
  name: string;
  data: T;
  progress: jest.Mock;
  updateProgress: jest.Mock;
  log: jest.Mock;
  attemptsMade: number;
  timestamp: number;
  processedOn?: number;
  finishedOn?: number;
  returnvalue?: any;
  failedReason?: string;
}

export function createMockBullMQJob<T = any>(
  data: T,
  overrides: Partial<MockBullMQJob<T>> = {}
): MockBullMQJob<T> {
  const mock: MockBullMQJob<T> = {
    id: `mock-job-${Date.now()}`,
    name: 'mock-job',
    data,
    progress: jest.fn().mockReturnValue(0),
    updateProgress: jest.fn((progress: number) => Promise.resolve()),
    log: jest.fn((message: string) => Promise.resolve()),
    attemptsMade: 0,
    timestamp: Date.now(),
    ...overrides,
  };

  return mock;
}

/**
 * Create mock axios instance
 */
export interface MockAxiosInstance {
  get: jest.Mock;
  post: jest.Mock;
  put: jest.Mock;
  patch: jest.Mock;
  delete: jest.Mock;
  request: jest.Mock;
}

export function createMockAxiosInstance(overrides: Partial<MockAxiosInstance> = {}): MockAxiosInstance {
  const mock: MockAxiosInstance = {
    get: jest.fn(() => Promise.resolve({ data: {}, status: 200, statusText: 'OK', headers: {}, config: {} as any })),
    post: jest.fn(() => Promise.resolve({ data: {}, status: 200, statusText: 'OK', headers: {}, config: {} as any })),
    put: jest.fn(() => Promise.resolve({ data: {}, status: 200, statusText: 'OK', headers: {}, config: {} as any })),
    patch: jest.fn(() => Promise.resolve({ data: {}, status: 200, statusText: 'OK', headers: {}, config: {} as any })),
    delete: jest.fn(() => Promise.resolve({ data: {}, status: 200, statusText: 'OK', headers: {}, config: {} as any })),
    request: jest.fn(() => Promise.resolve({ data: {}, status: 200, statusText: 'OK', headers: {}, config: {} as any })),
    ...overrides,
  };

  return mock;
}
