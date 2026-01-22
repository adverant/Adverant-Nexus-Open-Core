import { logger } from '../utils/logger';

/**
 * OpenTelemetry Tracing Configuration
 *
 * Exports traces to Jaeger via OTLP HTTP endpoint
 * Auto-instruments: Express, Axios, Redis, PostgreSQL, Neo4j
 *
 * IMPORTANT: This must be initialized BEFORE any other imports
 * to ensure proper instrumentation of all modules.
 *
 * NOTE: Gracefully degrades if OpenTelemetry packages are not available
 */
export function initializeTracing() {
  // Try to load OpenTelemetry modules dynamically
  try {
    // Dynamic imports to handle missing modules gracefully
    const { NodeSDK } = require('@opentelemetry/sdk-node');
    const { getNodeAutoInstrumentations } = require('@opentelemetry/auto-instrumentations-node');
    const { OTLPTraceExporter } = require('@opentelemetry/exporter-trace-otlp-http');
    const { Resource } = require('@opentelemetry/resources');
    const { SemanticResourceAttributes } = require('@opentelemetry/semantic-conventions');
    const { BatchSpanProcessor } = require('@opentelemetry/sdk-trace-base');

    const resource = new Resource({
      [SemanticResourceAttributes.SERVICE_NAME]: 'mageagent',
      [SemanticResourceAttributes.SERVICE_VERSION]: '2.1.0',
      [SemanticResourceAttributes.DEPLOYMENT_ENVIRONMENT]:
        process.env.NODE_ENV || 'development'
    });

    const traceExporter = new OTLPTraceExporter({
      url: process.env.OTEL_EXPORTER_OTLP_ENDPOINT ||
           'http://nexus-jaeger:4318/v1/traces',
      headers: {
        'Content-Type': 'application/json'
      }
    });

    const sdk = new NodeSDK({
      resource,
      spanProcessor: new BatchSpanProcessor(traceExporter, {
        maxQueueSize: 1000,
        maxExportBatchSize: 100,
        scheduledDelayMillis: 5000
      }) as any,
      instrumentations: [
        getNodeAutoInstrumentations({
          '@opentelemetry/instrumentation-fs': {
            enabled: false // Disable noisy file system traces
          },
          '@opentelemetry/instrumentation-http': {
            enabled: true,
            ignoreIncomingPaths: ['/health', '/ping', '/metrics'] // Don't trace health checks
          },
          '@opentelemetry/instrumentation-express': {
            enabled: true
          },
          '@opentelemetry/instrumentation-redis-4': {
            enabled: true
          },
          '@opentelemetry/instrumentation-pg': {
            enabled: true
          }
        })
      ]
    });

    sdk.start();

    logger.info('OpenTelemetry tracing initialized', {
      service: 'mageagent',
      endpoint: process.env.OTEL_EXPORTER_OTLP_ENDPOINT || 'http://nexus-jaeger:4318/v1/traces',
      environment: process.env.NODE_ENV
    });

    // Graceful shutdown
    process.on('SIGTERM', async () => {
      await sdk.shutdown();
      logger.info('OpenTelemetry SDK shut down successfully');
    });

    return sdk;
  } catch (error: any) {
    // OpenTelemetry packages not available or failed to initialize
    logger.warn('OpenTelemetry tracing disabled - modules not available', {
      error: error.message,
      code: error.code
    });
    return null;
  }
}
