/**
 * Nexus Telemetry Express Middleware
 *
 * Automatically publishes telemetry events for all HTTP requests
 */

import { Request, Response, NextFunction } from 'express';
import { TelemetryPublisher } from './publisher';
import { TelemetryRequest } from './types';

// Extend Express Request to include multer's file property
interface MulterFile {
  fieldname: string;
  originalname: string;
  encoding: string;
  mimetype: string;
  size: number;
  buffer?: Buffer;
  path?: string;
}

interface MulterRequest extends Request {
  file?: MulterFile;
  files?: MulterFile[] | Record<string, MulterFile[]>;
}

/**
 * Operation inference map - maps URL patterns to semantic operations
 */
const OPERATION_PATTERNS: Array<{
  pattern: RegExp | string;
  operation: string;
}> = [
  // File operations
  { pattern: /\/process/, operation: 'file:process' },
  { pattern: /\/upload/, operation: 'file:upload' },
  { pattern: /\/download/, operation: 'file:download' },
  { pattern: /\/drive-url/, operation: 'file:drive-import' },

  // Query operations
  { pattern: /\/query/, operation: 'query:execute' },
  { pattern: /\/search/, operation: 'search:execute' },
  { pattern: /\/embed/, operation: 'embed:generate' },

  // Auth operations
  { pattern: /\/auth/, operation: 'auth:validate' },
  { pattern: /\/login/, operation: 'auth:login' },
  { pattern: /\/logout/, operation: 'auth:logout' },
  { pattern: /\/token/, operation: 'auth:token' },

  // Admin operations
  { pattern: /\/admin/, operation: 'admin:operation' },
  { pattern: /\/config/, operation: 'config:manage' },

  // Health and metrics
  { pattern: /\/health/, operation: 'health:check' },
  { pattern: /\/metrics/, operation: 'metrics:export' },
  { pattern: /\/ready/, operation: 'health:ready' },
  { pattern: /\/live/, operation: 'health:live' },

  // Job operations
  { pattern: /\/jobs/, operation: 'job:manage' },
  { pattern: /\/scan/, operation: 'security:scan' },

  // Orchestration
  { pattern: /\/orchestrate/, operation: 'orchestrate:workflow' },
  { pattern: /\/workflow/, operation: 'workflow:execute' }
];

/**
 * Resource type inference map
 */
const RESOURCE_PATTERNS: Array<{
  pattern: RegExp;
  type: string;
  idGroup?: number;
}> = [
  { pattern: /\/files?\/([a-f0-9-]+)/i, type: 'file', idGroup: 1 },
  { pattern: /\/documents?\/([a-f0-9-]+)/i, type: 'document', idGroup: 1 },
  { pattern: /\/users?\/([a-f0-9-]+)/i, type: 'user', idGroup: 1 },
  { pattern: /\/jobs?\/([a-f0-9-]+)/i, type: 'job', idGroup: 1 },
  { pattern: /\/orgs?\/([a-f0-9-]+)/i, type: 'organization', idGroup: 1 },
  { pattern: /\/scans?\/([a-f0-9-]+)/i, type: 'scan', idGroup: 1 }
];

/**
 * Infer semantic operation from request
 */
function inferOperation(req: Request): string {
  const path = req.path.toLowerCase();

  for (const { pattern, operation } of OPERATION_PATTERNS) {
    if (typeof pattern === 'string') {
      if (path.includes(pattern)) return operation;
    } else {
      if (pattern.test(path)) return operation;
    }
  }

  // Default: method:path-segments
  const pathParts = req.path.split('/').filter(Boolean);
  if (pathParts.length === 0) {
    return `${req.method.toLowerCase()}:root`;
  }
  return `${req.method.toLowerCase()}:${pathParts.slice(0, 2).join(':')}`;
}

/**
 * Infer resource type and ID from request path
 */
function inferResource(req: Request): { type?: string; id?: string } {
  const path = req.path;

  for (const { pattern, type, idGroup } of RESOURCE_PATTERNS) {
    const match = path.match(pattern);
    if (match) {
      return {
        type,
        id: idGroup && match[idGroup] ? match[idGroup] : undefined
      };
    }
  }

  return {};
}

/**
 * Extract filename from request
 */
function extractFilename(req: Request): string | undefined {
  // From multipart upload (cast to MulterRequest for multer's file property)
  const multerReq = req as MulterRequest;
  if (multerReq.file?.originalname) {
    return multerReq.file.originalname;
  }

  // From body
  const body = req.body as Record<string, unknown> | undefined;
  if (body?.filename && typeof body.filename === 'string') {
    return body.filename;
  }
  if (body?.fileName && typeof body.fileName === 'string') {
    return body.fileName;
  }

  // From query params
  if (req.query.filename && typeof req.query.filename === 'string') {
    return req.query.filename;
  }

  return undefined;
}

/**
 * Middleware options
 */
export interface TelemetryMiddlewareOptions {
  /**
   * Skip telemetry for certain paths (e.g., health checks)
   */
  skipPaths?: string[];

  /**
   * Custom operation inference function
   */
  inferOperation?: (req: Request) => string;

  /**
   * Include request body in metadata (careful with sensitive data)
   */
  includeBody?: boolean;

  /**
   * Include response body in metadata
   */
  includeResponseBody?: boolean;

  /**
   * Maximum metadata size in bytes
   */
  maxMetadataSize?: number;
}

const DEFAULT_SKIP_PATHS = ['/health', '/ready', '/live', '/metrics'];

/**
 * Create telemetry middleware for Express
 *
 * Usage:
 * ```typescript
 * const telemetry = new TelemetryPublisher({ redisUrl, serviceName });
 * app.use(createTelemetryMiddleware(telemetry));
 * ```
 */
export function createTelemetryMiddleware(
  publisher: TelemetryPublisher,
  options: TelemetryMiddlewareOptions = {}
) {
  const skipPaths = options.skipPaths ?? DEFAULT_SKIP_PATHS;
  const customInferOperation = options.inferOperation;
  const maxMetadataSize = options.maxMetadataSize ?? 10000;

  return function telemetryMiddleware(
    req: Request,
    res: Response,
    next: NextFunction
  ): void {
    // Skip telemetry for certain paths
    if (skipPaths.some(p => req.path.startsWith(p))) {
      return next();
    }

    const startTime = Date.now();

    // Extract or generate correlation ID
    const correlationId =
      (req.headers['x-correlation-id'] as string) ||
      (req.headers['x-request-id'] as string) ||
      publisher.generateUUIDv7();

    // Generate span ID for this request
    const spanId = publisher.generateUUIDv7();

    // Extract parent span if present
    const parentSpanId = req.headers['x-span-id'] as string | undefined;

    // Attach telemetry context to request
    const telemetryReq = req as Request & TelemetryRequest;
    telemetryReq.correlationId = correlationId;
    telemetryReq.spanId = spanId;
    telemetryReq.telemetryStartTime = startTime;

    // Set correlation headers on response
    res.setHeader('X-Correlation-ID', correlationId);
    res.setHeader('X-Span-ID', spanId);

    // Infer operation and resource
    const operation = customInferOperation
      ? customInferOperation(req)
      : inferOperation(req);
    const resource = inferResource(req);
    const filename = extractFilename(req);

    // Build metadata
    const metadata: Record<string, unknown> = {
      query: Object.keys(req.query).length > 0 ? req.query : undefined,
      contentType: req.headers['content-type'],
      contentLength: req.headers['content-length'],
      userAgent: req.headers['user-agent'],
      filename
    };

    // Optionally include body
    if (options.includeBody && req.body) {
      const bodyStr = JSON.stringify(req.body);
      if (bodyStr.length <= maxMetadataSize) {
        metadata.requestBody = req.body;
      } else {
        metadata.requestBodyTruncated = true;
        metadata.requestBodySize = bodyStr.length;
      }
    }

    // Remove undefined values
    Object.keys(metadata).forEach(key => {
      if (metadata[key] === undefined) {
        delete metadata[key];
      }
    });

    // Extract user context (assumes auth middleware has run)
    const userId = (req as unknown as Record<string, unknown>).userId as string | undefined;
    const orgId = (req as unknown as Record<string, unknown>).orgId as string | undefined;

    // Publish START event
    publisher.publish({
      correlationId,
      spanId,
      parentSpanId,
      method: req.method,
      path: req.path,
      operation,
      resourceType: resource.type,
      resourceId: resource.id,
      userId,
      orgId,
      phase: 'start',
      metadata
    });

    // Capture response completion
    res.on('finish', () => {
      const durationMs = Date.now() - startTime;
      const phase = res.statusCode >= 400 ? 'error' : 'end';

      // Build end event metadata
      const endMetadata: Record<string, unknown> = {
        ...metadata,
        responseSize: res.getHeader('content-length')
      };

      // Publish END event
      publisher.publish({
        correlationId,
        spanId,
        parentSpanId,
        method: req.method,
        path: req.path,
        operation,
        resourceType: resource.type,
        resourceId: resource.id,
        statusCode: res.statusCode,
        durationMs,
        userId,
        orgId,
        phase,
        metadata: endMetadata
      });
    });

    next();
  };
}

/**
 * Extract telemetry context from request
 */
export function getTelemetryContext(req: Request): TelemetryRequest | null {
  const telemetryReq = req as Request & Partial<TelemetryRequest>;

  if (!telemetryReq.correlationId) {
    return null;
  }

  return {
    correlationId: telemetryReq.correlationId,
    spanId: telemetryReq.spanId || '',
    telemetryStartTime: telemetryReq.telemetryStartTime || Date.now()
  };
}

/**
 * Create a child span for nested operations
 */
export function createChildSpan(
  publisher: TelemetryPublisher,
  parentContext: TelemetryRequest,
  operation: string
): string {
  const childSpanId = publisher.generateUUIDv7();

  publisher.publish({
    correlationId: parentContext.correlationId,
    spanId: childSpanId,
    parentSpanId: parentContext.spanId,
    operation,
    phase: 'start',
    method: 'INTERNAL',
    path: operation
  });

  return childSpanId;
}

/**
 * End a child span
 */
export function endChildSpan(
  publisher: TelemetryPublisher,
  parentContext: TelemetryRequest,
  childSpanId: string,
  operation: string,
  success: boolean,
  durationMs?: number
): void {
  publisher.publish({
    correlationId: parentContext.correlationId,
    spanId: childSpanId,
    parentSpanId: parentContext.spanId,
    operation,
    phase: success ? 'end' : 'error',
    method: 'INTERNAL',
    path: operation,
    durationMs
  });
}
