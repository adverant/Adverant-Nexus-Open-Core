/**
 * Middleware exports
 */

export {
  createCorrelationIdMiddleware,
  getCorrelationId,
  getRequestId,
  getCorrelationHeaders,
  CORRELATION_ID_HEADER,
  REQUEST_ID_HEADER,
  RequestWithLogger,
  CorrelationIdOptions,
} from './correlation-id';

export {
  createRequestLoggingMiddleware,
  RequestLoggingOptions,
} from './request-logging';

/**
 * Combined middleware for common use case
 */
import { Logger } from '../types';
import { createCorrelationIdMiddleware, CorrelationIdOptions } from './correlation-id';
import { createRequestLoggingMiddleware, RequestLoggingOptions } from './request-logging';

export function createLoggerMiddleware(
  logger: Logger,
  options: {
    correlation?: CorrelationIdOptions;
    logging?: RequestLoggingOptions;
  } = {}
) {
  return [
    createCorrelationIdMiddleware(logger, options.correlation),
    createRequestLoggingMiddleware(logger, options.logging),
  ];
}
