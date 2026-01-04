/**
 * Usage Tracking Middleware for FileProcess
 *
 * Production-grade middleware that tracks API usage and reports to nexus-auth.
 * Implements fire-and-forget pattern for non-blocking usage reporting.
 *
 * Features:
 * - Actual token counting (not just estimation)
 * - Cost allocation per API key
 * - Rate limiting integration signals
 * - Batch reporting for high-throughput scenarios
 * - Multi-tenancy context extraction
 *
 * Architecture:
 * 1. Intercepts response completion via res.on('finish')
 * 2. Calculates actual/estimated token usage
 * 3. Sends async report to nexus-auth /internal/track-usage
 * 4. Never blocks the response to the user
 */

import { Request, Response, NextFunction } from 'express';
import { logger } from '../utils/logger';

// ============================================================================
// Configuration
// ============================================================================

const SERVICE_NAME = 'fileprocess';

const USAGE_TRACKING_CONFIG = {
  // nexus-auth internal endpoint (Kubernetes service DNS)
  trackingEndpoint: process.env.USAGE_TRACKING_URL || 'http://nexus-auth:9101/internal/track-usage',

  // Batch settings
  batchSize: parseInt(process.env.USAGE_BATCH_SIZE || '10', 10),
  batchFlushIntervalMs: parseInt(process.env.USAGE_BATCH_FLUSH_MS || '5000', 10),

  // Feature flags
  enableBatching: process.env.USAGE_ENABLE_BATCHING === 'true',
  enableDetailedMetrics: process.env.USAGE_DETAILED_METRICS !== 'false',

  // Token estimation settings (fallback when actual counts unavailable)
  charsPerToken: 4, // Average characters per token

  // Request timeout for tracking calls
  trackingTimeoutMs: parseInt(process.env.USAGE_TRACKING_TIMEOUT_MS || '5000', 10),

  // Retry settings
  maxRetries: parseInt(process.env.USAGE_MAX_RETRIES || '2', 10),
  retryDelayMs: parseInt(process.env.USAGE_RETRY_DELAY_MS || '1000', 10),
};

// ============================================================================
// Types
// ============================================================================

interface TenantContext {
  userId?: string;
  companyId?: string;
  appId?: string;
  requestId?: string;
  sessionId?: string;
}

interface UsageReport {
  userId: string;
  apiKeyId?: string;
  organizationId?: string;
  appId?: string;
  appUserId?: string;
  externalUserId?: string;
  departmentId?: string;
  region?: string;
  complianceMode?: string;
  courseId?: string;
  projectContext?: Record<string, unknown>;
  service: string;
  operation: string;
  model?: string;
  // Plugin tracking fields
  pluginType?: string;
  pluginId?: string;
  pluginName?: string;
  inputTokens: number;
  outputTokens: number;
  embeddingCount: number;
  gpuSeconds: number;
  storageBytes: number;
  bandwidthBytes: number;
  requestId?: string;
  sessionId?: string;
  ipAddress?: string;
  durationMs: number;
  httpStatus: number;
  metadata?: Record<string, unknown>;
}

interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  embeddingCount: number;
  model?: string;
}

// Extended Express Request with token tracking
interface TrackedRequest extends Request {
  tenantContext?: TenantContext;
  _usageTracking?: {
    startTime: number;
    inputTokens?: number;
    outputTokens?: number;
    embeddingCount?: number;
    model?: string;
    operation?: string;
    requestBody?: unknown;
    responseBody?: unknown;
    gpuSeconds?: number;
    storageBytes?: number;
    bandwidthBytes?: number;
  };
}

// Extended Express Response with body capture
interface TrackedResponse extends Response {
  _body?: string;
}

// ============================================================================
// Batch Queue (for high-throughput scenarios)
// ============================================================================

const usageQueue: UsageReport[] = [];
let batchFlushTimer: NodeJS.Timeout | null = null;

/**
 * Add report to batch queue
 */
function queueReport(report: UsageReport): void {
  usageQueue.push(report);

  if (usageQueue.length >= USAGE_TRACKING_CONFIG.batchSize) {
    flushBatch();
  } else if (!batchFlushTimer) {
    batchFlushTimer = setTimeout(flushBatch, USAGE_TRACKING_CONFIG.batchFlushIntervalMs);
  }
}

/**
 * Flush batch of reports to nexus-auth
 */
async function flushBatch(): Promise<void> {
  if (batchFlushTimer) {
    clearTimeout(batchFlushTimer);
    batchFlushTimer = null;
  }

  if (usageQueue.length === 0) return;

  const batch = usageQueue.splice(0, USAGE_TRACKING_CONFIG.batchSize);

  logger.debug('Flushing usage batch', { batchSize: batch.length });

  // Send each report individually (nexus-auth expects single reports)
  await Promise.allSettled(
    batch.map((report) => sendUsageReport(report))
  );
}

// ============================================================================
// Token Counting
// ============================================================================

/**
 * Estimate tokens from text content
 */
function estimateTokens(text: string | undefined | null): number {
  if (!text) return 0;
  const cleanText = typeof text === 'string' ? text : JSON.stringify(text);
  return Math.ceil(cleanText.length / USAGE_TRACKING_CONFIG.charsPerToken);
}

/**
 * Calculate token usage from request and response
 */
function calculateTokenUsage(req: TrackedRequest, res: TrackedResponse): TokenUsage {
  const tracking = req._usageTracking;

  // Check if actual tokens were set by handler
  if (tracking?.inputTokens !== undefined || tracking?.outputTokens !== undefined) {
    return {
      inputTokens: tracking.inputTokens || 0,
      outputTokens: tracking.outputTokens || 0,
      embeddingCount: tracking.embeddingCount || 0,
      model: tracking.model,
    };
  }

  // Fallback: estimate from content
  const inputText = tracking?.requestBody
    ? JSON.stringify(tracking.requestBody)
    : JSON.stringify(req.body);

  const outputText = res._body || '';

  return {
    inputTokens: estimateTokens(inputText),
    outputTokens: estimateTokens(outputText),
    embeddingCount: tracking?.embeddingCount || 0,
    model: tracking?.model,
  };
}

// ============================================================================
// Operation Detection
// ============================================================================

/**
 * Detect operation type from request path and method
 */
function detectOperation(req: Request): string {
  const path = req.path.toLowerCase();
  const method = req.method.toUpperCase();

  // FileProcess API operations
  if (path.includes('/process')) {
    if (path.includes('/url')) return 'process_url';
    return 'process_upload';
  }
  if (path.includes('/jobs')) {
    if (method === 'DELETE') return 'job_cancel';
    if (method === 'GET' && path.includes('/')) return 'job_status';
    return 'job_list';
  }
  if (path.includes('/queue')) return 'queue_stats';
  if (path.includes('/artifacts')) {
    if (method === 'POST') return 'artifact_upload';
    if (method === 'GET') return 'artifact_download';
    if (method === 'DELETE') return 'artifact_delete';
    return 'artifact_list';
  }

  // Document operations
  if (path.includes('/document')) {
    return method === 'POST' ? 'document_store' : 'document_retrieve';
  }

  // Default
  return `${method.toLowerCase()}_${path.split('/').filter(Boolean).pop() || 'unknown'}`;
}

// ============================================================================
// Usage Report Sending
// ============================================================================

/**
 * Send usage report to nexus-auth with retry logic
 */
async function sendUsageReport(report: UsageReport, retryCount = 0): Promise<void> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), USAGE_TRACKING_CONFIG.trackingTimeoutMs);

  try {
    const response = await fetch(USAGE_TRACKING_CONFIG.trackingEndpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Internal-Request': 'true',
        'X-Source': `nexus-${SERVICE_NAME}`,
      },
      body: JSON.stringify(report),
      signal: controller.signal,
    });

    clearTimeout(timeout);

    if (response.status === 204 || response.ok) {
      logger.info('[Usage Tracking] Report sent successfully', {
        userId: report.userId,
        operation: report.operation,
        inputTokens: report.inputTokens,
        outputTokens: report.outputTokens,
        durationMs: report.durationMs,
        httpStatus: response.status,
      });
      return;
    }

    const errorBody = await response.text().catch(() => 'unknown');
    logger.warn('Usage tracking endpoint returned error', {
      status: response.status,
      error: errorBody,
      userId: report.userId,
      operation: report.operation,
    });

    if (response.status >= 500 && retryCount < USAGE_TRACKING_CONFIG.maxRetries) {
      await new Promise((resolve) => setTimeout(resolve, USAGE_TRACKING_CONFIG.retryDelayMs));
      return sendUsageReport(report, retryCount + 1);
    }
  } catch (error) {
    clearTimeout(timeout);

    const errorMessage = error instanceof Error ? error.message : String(error);

    if (errorMessage.includes('abort')) {
      logger.debug('Usage tracking request timed out', {
        userId: report.userId,
        operation: report.operation,
        timeout: USAGE_TRACKING_CONFIG.trackingTimeoutMs,
      });
    } else {
      logger.warn('Failed to send usage report', {
        error: errorMessage,
        userId: report.userId,
        operation: report.operation,
        retryCount,
      });
    }

    if (retryCount < USAGE_TRACKING_CONFIG.maxRetries) {
      await new Promise((resolve) => setTimeout(resolve, USAGE_TRACKING_CONFIG.retryDelayMs));
      return sendUsageReport(report, retryCount + 1);
    }
  }
}

// ============================================================================
// Middleware Implementation
// ============================================================================

/**
 * Check if path should be exempt from tracking
 */
function isExemptPath(path: string): boolean {
  const exemptPaths = [
    '/health',
    '/healthz',
    '/ready',
    '/readiness',
    '/liveness',
    '/startup',
    '/metrics',
    '/ping',
    '/',
  ];

  return exemptPaths.some(
    (exempt) => path === exempt || path.startsWith(`${exempt}/`)
  );
}

/**
 * Extract user ID from request context
 */
function extractUserId(req: TrackedRequest): string | undefined {
  if (req.tenantContext?.userId) {
    return req.tenantContext.userId;
  }

  const headerUserId = req.headers['x-user-id'];
  if (typeof headerUserId === 'string' && headerUserId) {
    return headerUserId;
  }

  const apiKeyUserId = req.headers['x-api-key-user-id'];
  if (typeof apiKeyUserId === 'string' && apiKeyUserId) {
    return apiKeyUserId;
  }

  return undefined;
}

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function extractApiKeyId(req: TrackedRequest): string | undefined {
  const apiKeyId = req.headers['x-api-key-id'];
  if (typeof apiKeyId === 'string' && apiKeyId && UUID_REGEX.test(apiKeyId)) {
    return apiKeyId;
  }
  return undefined;
}

function extractAppUserId(req: TrackedRequest): string | undefined {
  const appUserId = req.headers['x-app-user-id'];
  return typeof appUserId === 'string' ? appUserId : undefined;
}

function extractExternalUserId(req: TrackedRequest): string | undefined {
  const externalUserId = req.headers['x-external-user-id'];
  return typeof externalUserId === 'string' ? externalUserId : undefined;
}

function extractPluginType(req: TrackedRequest): string | undefined {
  const pluginType = req.headers['x-plugin-type'];
  if (typeof pluginType === 'string' && (pluginType === 'core' || pluginType === 'marketplace')) {
    return pluginType;
  }
  return 'core';
}

function extractPluginId(req: TrackedRequest): string | undefined {
  const pluginId = req.headers['x-plugin-id'];
  return typeof pluginId === 'string' ? pluginId : undefined;
}

function extractPluginName(req: TrackedRequest): string | undefined {
  const pluginName = req.headers['x-plugin-name'];
  return typeof pluginName === 'string' ? pluginName : undefined;
}

function extractHeader(req: TrackedRequest, headerName: string): string | undefined {
  const value = req.headers[headerName];
  return typeof value === 'string' ? value : undefined;
}

function extractProjectContext(req: TrackedRequest): Record<string, unknown> | undefined {
  if (req.body && typeof req.body === 'object' && req.body.projectContext) {
    return req.body.projectContext as Record<string, unknown>;
  }

  const headerContext = req.headers['x-project-context'];
  if (typeof headerContext === 'string') {
    try {
      return JSON.parse(headerContext) as Record<string, unknown>;
    } catch {
      return undefined;
    }
  }

  return undefined;
}

/**
 * Usage tracking middleware
 */
export function usageTrackingMiddleware(
  req: TrackedRequest,
  res: TrackedResponse,
  next: NextFunction
): void {
  if (isExemptPath(req.path)) {
    return next();
  }

  req._usageTracking = {
    startTime: Date.now(),
    requestBody: req.body,
  };

  const originalJson = res.json.bind(res);
  res.json = function (body: unknown): Response {
    res._body = typeof body === 'string' ? body : JSON.stringify(body);

    if (req._usageTracking) {
      req._usageTracking.responseBody = body;
    }

    return originalJson(body);
  };

  res.on('finish', () => {
    const userId = extractUserId(req);
    if (!userId) {
      logger.debug('[Usage Tracking] Skipping - no userId', {
        path: req.path,
      });
      return;
    }

    const durationMs = Date.now() - (req._usageTracking?.startTime || Date.now());
    const tokenUsage = calculateTokenUsage(req, res);
    const operation = req._usageTracking?.operation || detectOperation(req);

    const report: UsageReport = {
      userId,
      apiKeyId: extractApiKeyId(req),
      organizationId: req.tenantContext?.companyId,
      appId: req.tenantContext?.appId,
      appUserId: extractAppUserId(req),
      externalUserId: extractExternalUserId(req),
      departmentId: extractHeader(req, 'x-department-id'),
      region: extractHeader(req, 'x-region'),
      complianceMode: extractHeader(req, 'x-compliance-mode'),
      courseId: extractHeader(req, 'x-course-id'),
      projectContext: extractProjectContext(req),
      service: SERVICE_NAME,
      operation,
      model: tokenUsage.model,
      pluginType: extractPluginType(req),
      pluginId: extractPluginId(req),
      pluginName: extractPluginName(req),
      inputTokens: tokenUsage.inputTokens,
      outputTokens: tokenUsage.outputTokens,
      embeddingCount: tokenUsage.embeddingCount,
      gpuSeconds: req._usageTracking?.gpuSeconds || 0,
      storageBytes: req._usageTracking?.storageBytes || 0,
      bandwidthBytes: req._usageTracking?.bandwidthBytes || 0,
      requestId: req.tenantContext?.requestId || extractHeader(req, 'x-request-id'),
      sessionId: req.tenantContext?.sessionId || extractHeader(req, 'x-session-id'),
      ipAddress: req.ip,
      durationMs,
      httpStatus: res.statusCode,
      metadata: USAGE_TRACKING_CONFIG.enableDetailedMetrics
        ? {
            method: req.method,
            path: req.path,
            userAgent: req.get('user-agent'),
            contentLength: req.get('content-length'),
          }
        : undefined,
    };

    logger.info('[Usage Tracking] Sending report', {
      userId,
      apiKeyId: report.apiKeyId ? `${report.apiKeyId.substring(0, 8)}...` : undefined,
      operation,
      pluginName: report.pluginName,
      path: req.path,
    });

    if (USAGE_TRACKING_CONFIG.enableBatching) {
      queueReport(report);
    } else {
      sendUsageReport(report).catch((err) => {
        logger.error('[Usage Tracking] Unexpected error sending report', {
          error: err instanceof Error ? err.message : String(err),
          userId,
          operation,
        });
      });
    }
  });

  next();
}

// ============================================================================
// Public Helpers for Handlers
// ============================================================================

export function setTokenUsage(
  req: TrackedRequest,
  usage: {
    inputTokens?: number;
    outputTokens?: number;
    embeddingCount?: number;
    model?: string;
  }
): void {
  if (!req._usageTracking) {
    req._usageTracking = { startTime: Date.now() };
  }

  if (usage.inputTokens !== undefined) {
    req._usageTracking.inputTokens = usage.inputTokens;
  }
  if (usage.outputTokens !== undefined) {
    req._usageTracking.outputTokens = usage.outputTokens;
  }
  if (usage.embeddingCount !== undefined) {
    req._usageTracking.embeddingCount = usage.embeddingCount;
  }
  if (usage.model !== undefined) {
    req._usageTracking.model = usage.model;
  }
}

export function setOperation(req: TrackedRequest, operation: string): void {
  if (!req._usageTracking) {
    req._usageTracking = { startTime: Date.now() };
  }
  req._usageTracking.operation = operation;
}

export function setResourceUsage(
  req: TrackedRequest,
  usage: {
    gpuSeconds?: number;
    storageBytes?: number;
    bandwidthBytes?: number;
  }
): void {
  if (!req._usageTracking) {
    req._usageTracking = { startTime: Date.now() };
  }

  if (usage.gpuSeconds !== undefined) {
    req._usageTracking.gpuSeconds = usage.gpuSeconds;
  }
  if (usage.storageBytes !== undefined) {
    req._usageTracking.storageBytes = usage.storageBytes;
  }
  if (usage.bandwidthBytes !== undefined) {
    req._usageTracking.bandwidthBytes = usage.bandwidthBytes;
  }
}

// ============================================================================
// Graceful Shutdown
// ============================================================================

export async function flushPendingReports(): Promise<void> {
  logger.info('Flushing pending usage reports', { queueSize: usageQueue.length });
  await flushBatch();
}

process.on('beforeExit', async () => {
  await flushPendingReports();
});
