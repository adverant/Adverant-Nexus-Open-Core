/**
 * Correlation ID Middleware
 * Generates or extracts correlation IDs for request tracing
 */

import { Request, Response, NextFunction } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { Logger } from '../types';

export const CORRELATION_ID_HEADER = 'x-correlation-id';
export const REQUEST_ID_HEADER = 'x-request-id';

export interface RequestWithLogger extends Request {
  correlationId?: string;
  requestId?: string;
  logger?: Logger;
}

export interface CorrelationIdOptions {
  headerName?: string;
  generateIfMissing?: boolean;
  includeInResponse?: boolean;
}

/**
 * Create correlation ID middleware
 */
export function createCorrelationIdMiddleware(
  logger: Logger,
  options: CorrelationIdOptions = {}
) {
  const {
    headerName = CORRELATION_ID_HEADER,
    generateIfMissing = true,
    includeInResponse = true,
  } = options;

  return (req: Request, res: Response, next: NextFunction): void => {
    // Extract or generate correlation ID
    let correlationId = extractCorrelationId(req, headerName);

    if (!correlationId && generateIfMissing) {
      correlationId = uuidv4();
    }

    // Generate unique request ID
    const requestId = uuidv4();

    // Attach to request
    const extendedReq = req as RequestWithLogger;
    extendedReq.correlationId = correlationId;
    extendedReq.requestId = requestId;

    // Create request-scoped logger with correlation context
    extendedReq.logger = logger.child({
      correlationId,
      requestId,
    });

    // Add to response headers
    if (includeInResponse && correlationId) {
      res.setHeader(headerName, correlationId);
      res.setHeader(REQUEST_ID_HEADER, requestId);
    }

    next();
  };
}

/**
 * Extract correlation ID from request headers
 */
function extractCorrelationId(req: Request, headerName: string): string | undefined {
  // Check primary header
  let correlationId = req.headers[headerName];

  if (correlationId) {
    return Array.isArray(correlationId) ? correlationId[0] : correlationId;
  }

  // Check alternative headers
  const alternativeHeaders = [
    'x-request-id',
    'x-trace-id',
    'x-b3-traceid', // Zipkin
    'traceparent', // W3C Trace Context
  ];

  for (const altHeader of alternativeHeaders) {
    const value = req.headers[altHeader];
    if (value) {
      return Array.isArray(value) ? value[0] : value;
    }
  }

  return undefined;
}

/**
 * Get correlation ID from request
 */
export function getCorrelationId(req: Request): string | undefined {
  return (req as RequestWithLogger).correlationId;
}

/**
 * Get request ID from request
 */
export function getRequestId(req: Request): string | undefined {
  return (req as RequestWithLogger).requestId;
}

/**
 * Get correlation headers for propagation to downstream services
 */
export function getCorrelationHeaders(req: Request): Record<string, string> {
  const correlationId = getCorrelationId(req);
  const requestId = getRequestId(req);

  const headers: Record<string, string> = {};

  if (correlationId) {
    headers[CORRELATION_ID_HEADER] = correlationId;
  }

  if (requestId) {
    headers[REQUEST_ID_HEADER] = requestId;
  }

  return headers;
}
