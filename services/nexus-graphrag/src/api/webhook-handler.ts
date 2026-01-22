/**
 * Webhook Handler for External Platforms
 * Receives interaction data from Gemini CLI, Codex, Cursor, and other platforms
 */

import { Router, Request, Response } from 'express';
import * as crypto from 'crypto';
import { logger } from '../utils/logger';
import { InteractionService } from '../capture/interaction-service';
import { WebhookInteractionPayload, RegisterWebhookRequest, CaptureInteractionRequest } from '../capture/interaction-types';
import { config } from '../config';

export function createWebhookRouter(interactionService: InteractionService): Router {
  const router = Router();

  /**
   * Register a new webhook for a platform
   */
  router.post('/webhooks/register', async (req: Request, res: Response) => {
    try {
      const request: RegisterWebhookRequest = req.body;

      if (!request.platformName || !request.apiKey) {
        return res.status(400).json({
          error: 'platformName and apiKey are required'
        });
      }

      // Hash the API key for storage
      const apiKeyHash = hashApiKey(request.apiKey);

      // Store webhook configuration in database
      const query = `
        INSERT INTO graphrag.platform_webhooks (platform_name, webhook_url, api_key_hash, metadata)
        VALUES ($1, $2, $3, $4)
        ON CONFLICT (platform_name)
        DO UPDATE SET
          webhook_url = EXCLUDED.webhook_url,
          api_key_hash = EXCLUDED.api_key_hash,
          metadata = EXCLUDED.metadata,
          updated_at = NOW()
        RETURNING id, platform_name, enabled
      `;

      const result = await interactionService['postgresPool'].query(query, [
        request.platformName,
        request.webhookUrl,
        apiKeyHash,
        JSON.stringify(request.metadata || {})
      ]);

      logger.info('Webhook registered', {
        platform: request.platformName,
        hasUrl: !!request.webhookUrl
      });

      return res.json({
        success: true,
        webhook: {
          id: result.rows[0].id,
          platformName: result.rows[0].platform_name,
          enabled: result.rows[0].enabled
        },
        message: 'Webhook registered successfully'
      });
    } catch (error) {
      logger.error('Failed to register webhook', { error });
      return res.status(500).json({
        error: 'Failed to register webhook',
        details: (error as Error).message
      });
    }
  });

  /**
   * Receive interaction from external platform webhook
   */
  router.post('/webhooks/interaction', async (req: Request, res: Response) => {
    try {
      const payload: WebhookInteractionPayload = req.body;

      // Validate signature if enabled
      if (config.interactionCapture.enableSignatureValidation) {
        const isValid = validateSignature(
          req.headers['x-webhook-signature'] as string,
          req.body,
          config.interactionCapture.webhookSecret
        );

        if (!isValid) {
          logger.warn('Invalid webhook signature', {
            platform: payload.platform,
            ip: req.ip
          });
          return res.status(401).json({
            error: 'Invalid signature'
          });
        }
      }

      // Validate timestamp (prevent replay attacks)
      const now = Date.now();
      const payloadAge = now - payload.timestamp;
      if (payloadAge > 5 * 60 * 1000) { // 5 minutes
        return res.status(400).json({
          error: 'Payload timestamp too old (possible replay attack)'
        });
      }

      // Capture interaction
      const captureRequest: CaptureInteractionRequest = {
        platform: payload.platform,
        platformVersion: payload.platformVersion,
        userId: payload.userId,
        sessionId: payload.sessionId,
        threadId: payload.threadId,
        parentInteractionId: payload.parentInteractionId,
        userMessage: payload.userMessage,
        assistantResponse: payload.assistantResponse,
        toolCalls: payload.toolCalls,
        systemPrompt: payload.systemPrompt,
        modelUsed: payload.modelUsed,
        modelProvider: payload.modelProvider,
        domain: payload.domain,
        taskType: payload.taskType,
        tokensPrompt: payload.tokensPrompt,
        tokensCompletion: payload.tokensCompletion,
        tokensTotal: payload.tokensTotal,
        costUsd: payload.costUsd,
        latencyMs: payload.latencyMs,
        cacheHit: payload.cacheHit,
        errorOccurred: payload.errorOccurred,
        errorMessage: payload.errorMessage,
        errorCode: payload.errorCode,
        storedDocumentIds: payload.storedDocumentIds,
        retrievedDocumentIds: payload.retrievedDocumentIds,
        memoryIds: payload.memoryIds,
        entityIds: payload.entityIds,
        startedAt: payload.startedAt,
        completedAt: payload.completedAt
      };

      const result = await interactionService.capture(captureRequest);

      logger.info('Webhook interaction received', {
        platform: payload.platform,
        sessionId: payload.sessionId,
        interactionId: result.interactionId
      });

      return res.json({
        success: true,
        interactionId: result.interactionId,
        message: 'Interaction captured successfully'
      });
    } catch (error) {
      logger.error('Failed to process webhook interaction', { error });
      return res.status(500).json({
        error: 'Failed to process interaction',
        details: (error as Error).message
      });
    }
  });

  /**
   * Get webhook status
   */
  router.get('/webhooks/:platformName/status', async (req: Request, res: Response) => {
    try {
      const { platformName } = req.params;

      const query = `
        SELECT platform_name, enabled, last_ping, last_error, error_count, metadata
        FROM graphrag.platform_webhooks
        WHERE platform_name = $1
      `;

      const result = await interactionService['postgresPool'].query(query, [platformName]);

      if (result.rows.length === 0) {
        return res.status(404).json({
          error: 'Webhook not found'
        });
      }

      return res.json({
        webhook: {
          platformName: result.rows[0].platform_name,
          enabled: result.rows[0].enabled,
          lastPing: result.rows[0].last_ping,
          lastError: result.rows[0].last_error,
          errorCount: result.rows[0].error_count,
          metadata: result.rows[0].metadata
        }
      });
    } catch (error) {
      logger.error('Failed to get webhook status', { error });
      return res.status(500).json({
        error: 'Failed to get webhook status',
        details: (error as Error).message
      });
    }
  });

  /**
   * Ping webhook to test connectivity
   */
  router.post('/webhooks/:platformName/ping', async (req: Request, res: Response) => {
    try {
      const { platformName } = req.params;

      // Update last ping time
      const query = `
        UPDATE graphrag.platform_webhooks
        SET last_ping = NOW(), error_count = 0, last_error = NULL
        WHERE platform_name = $1
        RETURNING platform_name, last_ping
      `;

      const result = await interactionService['postgresPool'].query(query, [platformName]);

      if (result.rows.length === 0) {
        return res.status(404).json({
          error: 'Webhook not found'
        });
      }

      logger.info('Webhook pinged', { platform: platformName });

      return res.json({
        success: true,
        platformName: result.rows[0].platform_name,
        lastPing: result.rows[0].last_ping,
        message: 'Webhook is healthy'
      });
    } catch (error) {
      logger.error('Failed to ping webhook', { error });
      return res.status(500).json({
        error: 'Failed to ping webhook',
        details: (error as Error).message
      });
    }
  });

  /**
   * Disable/enable webhook
   */
  router.patch('/webhooks/:platformName/toggle', async (req: Request, res: Response) => {
    try {
      const { platformName } = req.params;
      const { enabled } = req.body;

      if (typeof enabled !== 'boolean') {
        return res.status(400).json({
          error: 'enabled field must be a boolean'
        });
      }

      const query = `
        UPDATE graphrag.platform_webhooks
        SET enabled = $1, updated_at = NOW()
        WHERE platform_name = $2
        RETURNING platform_name, enabled
      `;

      const result = await interactionService['postgresPool'].query(query, [enabled, platformName]);

      if (result.rows.length === 0) {
        return res.status(404).json({
          error: 'Webhook not found'
        });
      }

      logger.info('Webhook toggled', {
        platform: platformName,
        enabled
      });

      return res.json({
        success: true,
        platformName: result.rows[0].platform_name,
        enabled: result.rows[0].enabled
      });
    } catch (error) {
      logger.error('Failed to toggle webhook', { error });
      return res.status(500).json({
        error: 'Failed to toggle webhook',
        details: (error as Error).message
      });
    }
  });

  /**
   * List all registered webhooks
   */
  router.get('/webhooks', async (_req: Request, res: Response) => {
    try {
      const query = `
        SELECT platform_name, enabled, last_ping, error_count, created_at
        FROM graphrag.platform_webhooks
        ORDER BY created_at DESC
      `;

      const result = await interactionService['postgresPool'].query(query);

      return res.json({
        webhooks: result.rows.map(row => ({
          platformName: row.platform_name,
          enabled: row.enabled,
          lastPing: row.last_ping,
          errorCount: row.error_count,
          createdAt: row.created_at
        })),
        total: result.rows.length
      });
    } catch (error) {
      logger.error('Failed to list webhooks', { error });
      return res.status(500).json({
        error: 'Failed to list webhooks',
        details: (error as Error).message
      });
    }
  });

  return router;
}

/**
 * Validate webhook signature using HMAC
 */
function validateSignature(signature: string, payload: any, secret: string): boolean {
  if (!signature) return false;

  const expectedSignature = crypto
    .createHmac('sha256', secret)
    .update(JSON.stringify(payload))
    .digest('hex');

  return crypto.timingSafeEqual(
    Buffer.from(signature),
    Buffer.from(expectedSignature)
  );
}

/**
 * Hash API key for storage
 */
function hashApiKey(apiKey: string): string {
  return crypto
    .createHash('sha256')
    .update(apiKey)
    .digest('hex');
}

/**
 * Generate webhook signature for outgoing webhooks
 */
export function generateWebhookSignature(payload: any, secret: string): string {
  return crypto
    .createHmac('sha256', secret)
    .update(JSON.stringify(payload))
    .digest('hex');
}
