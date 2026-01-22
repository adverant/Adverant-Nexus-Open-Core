/**
 * Interaction Capture Middleware
 * Automatically captures all LLM interactions through HTTP API
 */

import { Request, Response, NextFunction } from 'express';
import { logger } from '../utils/logger';
import { InteractionService } from '../capture/interaction-service';
import { CaptureInteractionRequest, PlatformType, TaskType } from '../capture/interaction-types';
import { v4 as uuidv4 } from 'uuid';

export interface InteractionCaptureContext {
  startTime: number;
  sessionId: string;
  platform: PlatformType;
  userMessage?: string;
  modelUsed?: string;
  storedDocumentIds?: string[];
  retrievedDocumentIds?: string[];
  memoryIds?: string[];
  entityIds?: string[];
}

/**
 * Middleware to capture HTTP API interactions
 */
export function createInteractionCaptureMiddleware(interactionService: InteractionService) {
  return async (req: Request, res: Response, next: NextFunction) => {
    // Skip if not enabled or if it's a health check
    if (req.path.includes('/health') || req.path.includes('/metrics')) {
      return next();
    }

    const startTime = Date.now();

    // Extract platform from headers
    const platform = (req.headers['x-platform'] as PlatformType) || 'custom';
    const sessionId = (req.headers['x-session-id'] as string) || uuidv4();
    // Thread ID and User ID available in headers if needed:
    // req.headers['x-thread-id'], req.headers['x-user-id']

    // Create context for this request
    const context: InteractionCaptureContext = {
      startTime,
      sessionId,
      platform,
      userMessage: extractUserMessage(req),
      storedDocumentIds: [],
      retrievedDocumentIds: [],
      memoryIds: [],
      entityIds: []
    };

    // Attach context to request for downstream handlers
    (req as any).interactionContext = context;

    // Intercept response
    const originalJson = res.json.bind(res);
    const originalSend = res.send.bind(res);

    // Response body will be captured via intercept functions below
    let responseCaptured = false;

    res.json = function(body: any) {
      if (!responseCaptured) {
        responseCaptured = true;
        captureInteraction(req, res, body, context, interactionService).catch(err => {
          logger.error('Failed to capture interaction in middleware', { error: err });
        });
      }
      return originalJson(body);
    };

    res.send = function(body: any) {
      if (!responseCaptured) {
        responseCaptured = true;
        captureInteraction(req, res, body, context, interactionService).catch(err => {
          logger.error('Failed to capture interaction in middleware', { error: err });
        });
      }
      return originalSend(body);
    };

    next();
  };
}

/**
 * Extract user message from request
 */
function extractUserMessage(req: Request): string {
  // Try different request patterns
  if (req.body.query) return req.body.query;
  if (req.body.content) return req.body.content;
  if (req.body.message) return req.body.message;
  if (req.body.text) return req.body.text;
  if (req.body.userMessage) return req.body.userMessage;

  // Fallback: summarize request
  return `${req.method} ${req.path}`;
}

/**
 * Extract assistant response from response body
 */
function extractAssistantResponse(responseBody: any): string {
  if (!responseBody) return '';

  if (typeof responseBody === 'string') return responseBody;

  // Try different response patterns
  if (responseBody.content) return JSON.stringify(responseBody.content);
  if (responseBody.result) return JSON.stringify(responseBody.result);
  if (responseBody.data) return JSON.stringify(responseBody.data);
  if (responseBody.message) return responseBody.message;
  if (responseBody.response) return responseBody.response;

  // Fallback: stringify entire response
  return JSON.stringify(responseBody);
}

/**
 * Capture the complete interaction
 */
async function captureInteraction(
  req: Request,
  res: Response,
  responseBody: any,
  context: InteractionCaptureContext,
  interactionService: InteractionService
): Promise<void> {
  try {
    const completedAt = new Date();
    const startedAt = new Date(context.startTime);
    const latencyMs = Date.now() - context.startTime;

    // Extract cross-references from response
    if (responseBody) {
      if (responseBody.documentId) {
        context.storedDocumentIds?.push(responseBody.documentId);
      }
      if (responseBody.id) {
        // Could be a document, memory, or entity
        if (req.path.includes('/document')) {
          context.storedDocumentIds?.push(responseBody.id);
        } else if (req.path.includes('/memory')) {
          context.memoryIds?.push(responseBody.id);
        } else if (req.path.includes('/entit')) {
          context.entityIds?.push(responseBody.id);
        }
      }
      if (responseBody.chunks) {
        // Retrieval operation
        context.retrievedDocumentIds = responseBody.chunks
          .map((c: any) => c.document_id)
          .filter((id: any) => id);
      }
    }

    const captureRequest: CaptureInteractionRequest = {
      platform: context.platform,
      platformVersion: req.headers['x-platform-version'] as string,
      userId: req.headers['x-user-id'] as string,
      sessionId: context.sessionId,
      threadId: req.headers['x-thread-id'] as string,
      userMessage: context.userMessage || extractUserMessage(req),
      assistantResponse: extractAssistantResponse(responseBody),
      modelUsed: context.modelUsed || req.headers['x-model-used'] as string,
      modelProvider: req.headers['x-model-provider'] as string,
      domain: req.headers['x-domain'] as string,
      taskType: inferTaskType(req),
      tokensPrompt: extractTokenCount(req.body),
      tokensCompletion: extractTokenCount(responseBody),
      costUsd: extractCost(responseBody),
      latencyMs,
      cacheHit: responseBody?.metadata?.cacheHit || false,
      errorOccurred: res.statusCode >= 400,
      errorMessage: res.statusCode >= 400 ? extractErrorMessage(responseBody) : undefined,
      storedDocumentIds: context.storedDocumentIds?.filter(id => id),
      retrievedDocumentIds: context.retrievedDocumentIds?.filter(id => id),
      memoryIds: context.memoryIds?.filter(id => id),
      entityIds: context.entityIds?.filter(id => id),
      startedAt,
      completedAt
    };

    await interactionService.capture(captureRequest);

    logger.debug('HTTP interaction captured', {
      sessionId: context.sessionId,
      path: req.path,
      latencyMs
    });
  } catch (error) {
    logger.error('Failed to capture HTTP interaction', {
      error,
      path: req.path,
      method: req.method
    });
    // Don't throw - capturing failures shouldn't break the API
  }
}

/**
 * Infer task type from request path and body
 */
function inferTaskType(req: Request): TaskType | undefined {
  const path = req.path.toLowerCase();

  if (path.includes('/store') || path.includes('/create')) return 'generation';
  if (path.includes('/retrieve') || path.includes('/search') || path.includes('/recall')) return 'retrieval';
  if (path.includes('/classif')) return 'classification';
  if (path.includes('/analyz')) return 'analysis';
  if (path.includes('/code')) return 'coding';

  return undefined;
}

/**
 * Extract token count from body (if available)
 */
function extractTokenCount(body: any): number | undefined {
  if (!body) return undefined;

  if (body.tokens) return body.tokens;
  if (body.usage?.total_tokens) return body.usage.total_tokens;
  if (body.metadata?.tokens) return body.metadata.tokens;

  return undefined;
}

/**
 * Extract cost from response (if available)
 */
function extractCost(responseBody: any): number | undefined {
  if (!responseBody) return undefined;

  if (responseBody.cost) return responseBody.cost;
  if (responseBody.usage?.cost_usd) return responseBody.usage.cost_usd;
  if (responseBody.metadata?.cost) return responseBody.metadata.cost;

  return undefined;
}

/**
 * Extract error message from response
 */
function extractErrorMessage(responseBody: any): string {
  if (!responseBody) return 'Unknown error';

  if (typeof responseBody === 'string') return responseBody;
  if (responseBody.error) {
    if (typeof responseBody.error === 'string') return responseBody.error;
    if (responseBody.error.message) return responseBody.error.message;
  }
  if (responseBody.message) return responseBody.message;

  return JSON.stringify(responseBody);
}
