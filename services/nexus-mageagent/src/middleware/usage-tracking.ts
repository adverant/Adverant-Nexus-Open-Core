/**
 * Usage Tracking Middleware for MageAgent
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
  pluginType?: string;   // 'core' or 'marketplace'
  pluginId?: string;     // Plugin identifier
  pluginName?: string;   // Human-readable plugin name
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
  // Future enhancement: Add batch endpoint to nexus-auth
  await Promise.allSettled(
    batch.map((report) => sendUsageReport(report))
  );
}

// ============================================================================
// Token Counting
// ============================================================================

/**
 * Estimate tokens from text content
 * Uses simple character-based estimation as fallback
 */
function estimateTokens(text: string | undefined | null): number {
  if (!text) return 0;
  const cleanText = typeof text === 'string' ? text : JSON.stringify(text);
  return Math.ceil(cleanText.length / USAGE_TRACKING_CONFIG.charsPerToken);
}

/**
 * Extract actual token usage from LLM response
 * Different models report usage differently
 */
function extractActualTokenUsage(responseBody: unknown, model?: string): TokenUsage | null {
  if (!responseBody || typeof responseBody !== 'object') return null;

  const body = responseBody as Record<string, unknown>;

  // OpenRouter format
  if (body.usage && typeof body.usage === 'object') {
    const usage = body.usage as Record<string, unknown>;
    return {
      inputTokens: typeof usage.prompt_tokens === 'number' ? usage.prompt_tokens : 0,
      outputTokens: typeof usage.completion_tokens === 'number' ? usage.completion_tokens : 0,
      embeddingCount: 0,
      model: typeof body.model === 'string' ? body.model : model,
    };
  }

  // Anthropic format
  if (body.usage && typeof body.usage === 'object') {
    const usage = body.usage as Record<string, unknown>;
    if (usage.input_tokens !== undefined) {
      return {
        inputTokens: typeof usage.input_tokens === 'number' ? usage.input_tokens : 0,
        outputTokens: typeof usage.output_tokens === 'number' ? usage.output_tokens : 0,
        embeddingCount: 0,
        model: typeof body.model === 'string' ? body.model : model,
      };
    }
  }

  // OpenAI embedding format
  if (body.data && Array.isArray(body.data) && body.object === 'list') {
    return {
      inputTokens: estimateTokens(JSON.stringify(body)),
      outputTokens: 0,
      embeddingCount: body.data.length,
      model: typeof body.model === 'string' ? body.model : model,
    };
  }

  // VoyageAI embedding format
  if (body.data && Array.isArray(body.data)) {
    const data = body.data as unknown[];
    if (data.length > 0 && typeof data[0] === 'object' && data[0] !== null) {
      const firstItem = data[0] as Record<string, unknown>;
      if (Array.isArray(firstItem.embedding)) {
        return {
          inputTokens: typeof body.usage === 'object' && body.usage !== null
            ? (body.usage as Record<string, number>).total_tokens || 0
            : 0,
          outputTokens: 0,
          embeddingCount: data.length,
          model: typeof body.model === 'string' ? body.model : model,
        };
      }
    }
  }

  return null;
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

  // Try to extract from response body
  if (tracking?.responseBody) {
    const actual = extractActualTokenUsage(tracking.responseBody, tracking.model);
    if (actual) return actual;
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

  // MageAgent API operations
  if (path.includes('/orchestrate')) return 'orchestrate';
  if (path.includes('/analyze')) return 'analyze';
  if (path.includes('/synthesize')) return 'synthesize';
  if (path.includes('/collaborate')) return 'collaborate';
  if (path.includes('/competition')) return 'competition';

  // Memory operations
  if (path.includes('/memory') || path.includes('/recall')) {
    return method === 'POST' ? 'memory_store' : 'memory_recall';
  }

  // Document operations
  if (path.includes('/document')) {
    return method === 'POST' ? 'document_store' : 'document_retrieve';
  }

  // Episode operations
  if (path.includes('/episode')) return 'episode';

  // Entity operations
  if (path.includes('/entity') || path.includes('/entities')) {
    return method === 'POST' ? 'entity_store' : 'entity_query';
  }

  // LLM operations
  if (path.includes('/llm') || path.includes('/chat') || path.includes('/complete')) {
    return 'llm_inference';
  }

  // Search operations
  if (path.includes('/search')) return 'search';

  // Model selection
  if (path.includes('/model')) return 'model_select';

  // Validation
  if (path.includes('/validate')) {
    if (path.includes('/code')) return 'validate_code';
    if (path.includes('/command')) return 'validate_command';
    return 'validate';
  }

  // FileProcess operations
  if (path.includes('/fileprocess')) return 'file_process';

  // VideoAgent operations
  if (path.includes('/video')) return 'video_process';

  // Geospatial operations
  if (path.includes('/geo') || path.includes('/earth') || path.includes('/bigquery')) {
    return 'geospatial';
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
        'X-Source': 'nexus-mageagent',
      },
      body: JSON.stringify(report),
      signal: controller.signal,
    });

    clearTimeout(timeout);

    // 204 No Content is success
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

    // Log error but don't throw (fire-and-forget)
    const errorBody = await response.text().catch(() => 'unknown');
    logger.warn('Usage tracking endpoint returned error', {
      status: response.status,
      error: errorBody,
      userId: report.userId,
      operation: report.operation,
    });

    // Retry on server errors
    if (response.status >= 500 && retryCount < USAGE_TRACKING_CONFIG.maxRetries) {
      await new Promise((resolve) => setTimeout(resolve, USAGE_TRACKING_CONFIG.retryDelayMs));
      return sendUsageReport(report, retryCount + 1);
    }
  } catch (error) {
    clearTimeout(timeout);

    const errorMessage = error instanceof Error ? error.message : String(error);

    // Don't log abort errors as warnings (expected on timeout)
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

    // Retry on network errors
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
 * Usage tracking middleware - tracks API usage and reports to nexus-auth
 *
 * Usage:
 * 1. Add middleware AFTER body parsing, BEFORE API routes
 * 2. Optionally set req._usageTracking.inputTokens/outputTokens in handlers
 * 3. Optionally call setTokenUsage() helper for actual counts
 */
export function usageTrackingMiddleware(
  req: TrackedRequest,
  res: TrackedResponse,
  next: NextFunction
): void {
  // Skip health check and metrics endpoints
  if (isExemptPath(req.path)) {
    return next();
  }

  // Initialize tracking context
  req._usageTracking = {
    startTime: Date.now(),
    requestBody: req.body,
  };

  // Capture response body for token calculation
  const originalJson = res.json.bind(res);
  res.json = function (body: unknown): Response {
    res._body = typeof body === 'string' ? body : JSON.stringify(body);

    // Also capture in tracking for token extraction
    if (req._usageTracking) {
      req._usageTracking.responseBody = body;
    }

    return originalJson(body);
  };

  // Track on response completion
  res.on('finish', () => {
    // Don't track if no user context
    const userId = extractUserId(req);
    if (!userId) {
      logger.info('[Usage Tracking] Skipping - no userId', {
        path: req.path,
        headers: {
          'x-user-id': req.headers['x-user-id'],
          'x-api-key-user-id': req.headers['x-api-key-user-id'],
        }
      });
      return;
    }

    const durationMs = Date.now() - (req._usageTracking?.startTime || Date.now());
    const tokenUsage = calculateTokenUsage(req, res);
    const operation = req._usageTracking?.operation || detectOperation(req);

    const report: UsageReport = {
      // User identification
      userId,
      apiKeyId: extractApiKeyId(req),
      organizationId: req.tenantContext?.companyId,
      appId: req.tenantContext?.appId,
      appUserId: extractAppUserId(req),
      externalUserId: extractExternalUserId(req),

      // Journey-specific fields
      departmentId: extractHeader(req, 'x-department-id'),
      region: extractHeader(req, 'x-region'),
      complianceMode: extractHeader(req, 'x-compliance-mode'),
      courseId: extractHeader(req, 'x-course-id'),
      projectContext: extractProjectContext(req),

      // Service and operation
      service: 'mageagent',
      operation,
      model: tokenUsage.model,

      // Plugin tracking
      pluginType: extractPluginType(req),
      pluginId: extractPluginId(req),
      pluginName: extractPluginName(req),

      // Usage metrics
      inputTokens: tokenUsage.inputTokens,
      outputTokens: tokenUsage.outputTokens,
      embeddingCount: tokenUsage.embeddingCount,
      gpuSeconds: req._usageTracking?.gpuSeconds || 0,
      storageBytes: req._usageTracking?.storageBytes || 0,
      bandwidthBytes: req._usageTracking?.bandwidthBytes || 0,

      // Request metadata
      requestId: req.tenantContext?.requestId || extractHeader(req, 'x-request-id'),
      sessionId: req.tenantContext?.sessionId || extractHeader(req, 'x-session-id'),
      ipAddress: req.ip,
      durationMs,
      httpStatus: res.statusCode,

      // Additional metadata
      metadata: USAGE_TRACKING_CONFIG.enableDetailedMetrics
        ? {
            method: req.method,
            path: req.path,
            userAgent: req.get('user-agent'),
            contentLength: req.get('content-length'),
          }
        : undefined,
    };

    // Send report (fire-and-forget)
    logger.info('[Usage Tracking] Sending report', {
      userId,
      apiKeyId: report.apiKeyId ? `${report.apiKeyId.substring(0, 8)}...` : undefined,
      operation,
      pluginType: report.pluginType,
      pluginId: report.pluginId,
      pluginName: report.pluginName,
      inputTokens: tokenUsage.inputTokens,
      outputTokens: tokenUsage.outputTokens,
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
// Helper Functions
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
  // From tenant context (JWT or headers)
  if (req.tenantContext?.userId) {
    return req.tenantContext.userId;
  }

  // From X-User-ID header
  const headerUserId = req.headers['x-user-id'];
  if (typeof headerUserId === 'string' && headerUserId) {
    return headerUserId;
  }

  // From API key validation context (set by API gateway)
  const apiKeyUserId = req.headers['x-api-key-user-id'];
  if (typeof apiKeyUserId === 'string' && apiKeyUserId) {
    return apiKeyUserId;
  }

  return undefined;
}

/**
 * UUID validation regex
 */
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Extract API key ID from request
 *
 * IMPORTANT: The database expects a UUID for api_key_id.
 * Only return the API key ID if it's a valid UUID (set by API gateway after validation).
 * Do NOT generate a non-UUID string from the API key - it will cause database errors.
 */
function extractApiKeyId(req: TrackedRequest): string | undefined {
  // API key ID is typically set by the API gateway after validation
  const apiKeyId = req.headers['x-api-key-id'];
  if (typeof apiKeyId === 'string' && apiKeyId && UUID_REGEX.test(apiKeyId)) {
    return apiKeyId;
  }

  // Note: We cannot derive the API key UUID from the raw API key header.
  // The API gateway should set X-API-Key-ID after validating the key.
  // For now, return undefined if no valid UUID is available.
  // The usage report will still be stored, just without api_key_id attribution.
  return undefined;
}

/**
 * Extract app user ID (for multi-tenant apps with many end users)
 */
function extractAppUserId(req: TrackedRequest): string | undefined {
  const appUserId = req.headers['x-app-user-id'];
  return typeof appUserId === 'string' ? appUserId : undefined;
}

/**
 * Extract external user ID (from app's own system)
 */
function extractExternalUserId(req: TrackedRequest): string | undefined {
  const externalUserId = req.headers['x-external-user-id'];
  return typeof externalUserId === 'string' ? externalUserId : undefined;
}

/**
 * Extract plugin type from request headers
 * Expected values: 'core' or 'marketplace'
 */
function extractPluginType(req: TrackedRequest): string | undefined {
  const pluginType = req.headers['x-plugin-type'];
  if (typeof pluginType === 'string' && (pluginType === 'core' || pluginType === 'marketplace')) {
    return pluginType;
  }
  // Default to 'core' if no plugin type specified
  return 'core';
}

/**
 * Extract plugin ID from request headers
 */
function extractPluginId(req: TrackedRequest): string | undefined {
  const pluginId = req.headers['x-plugin-id'];
  return typeof pluginId === 'string' ? pluginId : undefined;
}

/**
 * Extract plugin name from request headers
 */
function extractPluginName(req: TrackedRequest): string | undefined {
  const pluginName = req.headers['x-plugin-name'];
  return typeof pluginName === 'string' ? pluginName : undefined;
}

/**
 * Extract header value as string
 */
function extractHeader(req: TrackedRequest, headerName: string): string | undefined {
  const value = req.headers[headerName];
  return typeof value === 'string' ? value : undefined;
}

/**
 * Extract project context from request body or headers
 */
function extractProjectContext(req: TrackedRequest): Record<string, unknown> | undefined {
  // From request body
  if (req.body && typeof req.body === 'object' && req.body.projectContext) {
    return req.body.projectContext as Record<string, unknown>;
  }

  // From header (JSON encoded)
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

// ============================================================================
// Public Helpers for Handlers
// ============================================================================

/**
 * Set actual token usage in request tracking context
 * Call this from handlers when you have actual token counts
 */
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

/**
 * Set operation name in request tracking context
 */
export function setOperation(req: TrackedRequest, operation: string): void {
  if (!req._usageTracking) {
    req._usageTracking = { startTime: Date.now() };
  }
  req._usageTracking.operation = operation;
}

/**
 * Set additional resource usage metrics
 */
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

/**
 * Flush pending usage reports on shutdown
 */
export async function flushPendingReports(): Promise<void> {
  logger.info('Flushing pending usage reports', { queueSize: usageQueue.length });
  await flushBatch();
}

// Register shutdown handler
process.on('beforeExit', async () => {
  await flushPendingReports();
});

// ============================================================================
// Export Summary
// ============================================================================

/**
 * Exports:
 *
 * - usageTrackingMiddleware: Main middleware - add after body parsing, before API routes
 * - setTokenUsage: Helper to set actual token counts from handlers
 * - setOperation: Helper to set operation name from handlers
 * - setResourceUsage: Helper to set GPU/storage/bandwidth metrics
 * - flushPendingReports: Call on graceful shutdown to flush batch queue
 *
 * Configuration via environment variables:
 * - USAGE_TRACKING_URL: Override nexus-auth endpoint
 * - USAGE_ENABLE_BATCHING: Enable batch reporting (default: false)
 * - USAGE_BATCH_SIZE: Reports per batch (default: 10)
 * - USAGE_BATCH_FLUSH_MS: Batch flush interval (default: 5000)
 * - USAGE_DETAILED_METRICS: Include extra metadata (default: true)
 * - USAGE_TRACKING_TIMEOUT_MS: Request timeout (default: 5000)
 * - USAGE_MAX_RETRIES: Max retry attempts (default: 2)
 *
 * Usage Example:
 * ```typescript
 * import { usageTrackingMiddleware, setTokenUsage } from './middleware/usage-tracking';
 *
 * // Add middleware
 * app.use(usageTrackingMiddleware);
 *
 * // In handler (optional - for actual token counts)
 * app.post('/api/orchestrate', async (req, res) => {
 *   const result = await orchestrate(req.body);
 *
 *   // Set actual token usage if known
 *   setTokenUsage(req, {
 *     inputTokens: result.usage.input_tokens,
 *     outputTokens: result.usage.output_tokens,
 *     model: result.model,
 *   });
 *
 *   res.json(result);
 * });
 * ```
 */
