/**
 * OpenTelemetry Tracing for FileProcessAgent
 *
 * NOTE: OpenTelemetry is OPTIONAL. If packages are not installed, tracing is disabled.
 * To enable tracing, install: npm install @opentelemetry/sdk-node @opentelemetry/auto-instrumentations-node
 *
 * Distributed tracing for:
 * - HTTP requests (Express)
 * - Database operations (PostgreSQL, Redis)
 * - External API calls (MageAgent, GraphRAG, VoyageAI)
 * - Job processing lifecycle
 */

import { logger } from './logger';

// Stub interfaces for when OpenTelemetry is not available
interface StubSpan {
  setAttribute(key: string, value: any): void;
  setStatus(status: any): void;
  recordException(error: Error): void;
  addEvent(name: string, attributes?: any): void;
  end(): void;
}

const stubSpan: StubSpan = {
  setAttribute: () => {},
  setStatus: () => {},
  recordException: () => {},
  addEvent: () => {},
  end: () => {},
};

export type Span = StubSpan;

/**
 * Initialize tracing (stub - OpenTelemetry packages not installed)
 * To enable full tracing, install OpenTelemetry packages and uncomment imports
 */
export function initTracing(): void {
  logger.info('OpenTelemetry tracing disabled (packages not installed)');
  logger.info('To enable tracing, run: npm install @opentelemetry/sdk-node @opentelemetry/auto-instrumentations-node');
}

/**
 * Shutdown tracing (stub)
 */
export async function shutdownTracing(): Promise<void> {
  // No-op when tracing is disabled
}

/**
 * Create a span (stub - returns no-op span)
 */
export function createSpan(_name: string, _attributes?: Record<string, string | number | boolean>): Span {
  return stubSpan;
}

/**
 * Wrap async function with tracing span (stub - just executes function)
 */
export async function traceAsync<T>(
  _name: string,
  fn: () => Promise<T>,
  _attributes?: Record<string, string | number | boolean>
): Promise<T> {
  return await fn();
}

/**
 * Wrap sync function with tracing span (stub - just executes function)
 */
export function traceSync<T>(
  _name: string,
  fn: () => T,
  _attributes?: Record<string, string | number | boolean>
): T {
  return fn();
}

/**
 * Add custom attributes to current span (stub - no-op)
 */
export function addSpanAttributes(_attributes: Record<string, string | number | boolean>): void {
  // No-op
}

/**
 * Add event to current span (stub - no-op)
 */
export function addSpanEvent(_name: string, _attributes?: Record<string, string | number | boolean>): void {
  // No-op
}

/**
 * Record exception in current span (stub - no-op)
 */
export function recordSpanException(_error: Error): void {
  // No-op
}

/**
 * Example usage patterns
 */

/*
// Example 1: Trace async function
import { traceAsync } from './utils/tracing';

async function processDocument(docId: string) {
  return await traceAsync(
    'process-document',
    async () => {
      // Do work
      return result;
    },
    {
      'document.id': docId,
      'document.type': 'pdf',
    }
  );
}

// Example 2: Manual span control
import { createSpan } from './utils/tracing';

async function complexOperation() {
  const span = createSpan('complex-operation');

  try {
    // Step 1
    span.addEvent('step-1-started');
    await step1();
    span.addEvent('step-1-completed');

    // Step 2
    span.setAttribute('step2.input', inputSize);
    await step2();

    span.setStatus({ code: SpanStatusCode.OK });
  } catch (error) {
    span.recordException(error as Error);
    span.setStatus({ code: SpanStatusCode.ERROR });
    throw error;
  } finally {
    span.end();
  }
}

// Example 3: Add attributes to current span
import { addSpanAttributes } from './utils/tracing';

async function handler(req, res) {
  addSpanAttributes({
    'user.id': req.user.id,
    'request.size': req.body.length,
  });

  // Continue processing...
}
*/
