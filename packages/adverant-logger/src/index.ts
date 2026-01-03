/**
 * @adverant/logger
 * Unified logging package for Nexus stack services
 */

export { createLogger, defaultLogger } from './logger';
export {
  createCorrelationIdMiddleware,
  createRequestLoggingMiddleware,
  getCorrelationId,
  getRequestId,
  getCorrelationHeaders,
  CORRELATION_ID_HEADER,
  REQUEST_ID_HEADER,
} from './middleware';
export type {
  Logger,
  LoggerConfig,
  LogMetadata,
  LogLevel,
  LogFormat,
  CorrelationIdConfig,
} from './types';
