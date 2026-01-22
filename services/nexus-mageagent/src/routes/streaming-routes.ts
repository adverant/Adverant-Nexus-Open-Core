/**
 * Streaming Routes - WebSocket-Integrated API Endpoints
 * Implements real-time streaming for all orchestration endpoints
 */

import { Router, Request, Response } from 'express';
import { Orchestrator } from '../orchestration/orchestrator';
import { StreamingOrchestrator, createStreamingOrchestrator } from '../orchestration/streaming-orchestrator';
import { getEnhancedWebSocketManager } from '../websocket/enhanced-websocket-manager';
import { logger } from '../utils/logger';
import { sanitizeErrorMessage } from '../utils/security';
import { v4 as uuidv4 } from 'uuid';

const router = Router();

let streamingOrchestrator: StreamingOrchestrator | null = null;

export function initializeStreamingRoutes(orchestrator: Orchestrator): Router {
  streamingOrchestrator = createStreamingOrchestrator(orchestrator);
  return router;
}

/**
 * Enhanced orchestration endpoint with streaming support
 */
router.post('/orchestrate', async (req: Request, res: Response): Promise<Response | void> => {
  try {
    if (!streamingOrchestrator) {
      return res.status(503).json({
        error: 'Streaming orchestrator not initialized'
      });
    }

    const { task, options = {} } = req.body;

    if (!task) {
      return res.status(400).json({
        error: 'Task is required',
        message: 'Please provide a task field',
        accepted_fields: ['task', 'prompt', 'query', 'objective']
      });
    }

    // Generate task ID
    const taskId = options.taskId || uuidv4();

    // Check if streaming is requested
    const shouldStream = options.stream === true;

    if (shouldStream) {
      // Get WebSocket session ID from headers or query
      const sessionId = req.headers['x-session-id'] as string ||
                       req.query.sessionId as string;

      // Start streaming orchestration
      const streamingOptions = {
        ...options,
        stream: true,
        sessionId,
        taskId
      };

      // Start async streaming (non-blocking)
      streamingOrchestrator.orchestrateWithStreaming(task, streamingOptions)
        .then(_result => {
          logger.info('Streaming orchestration completed', { taskId });
        })
        .catch(error => {
          logger.error('Streaming orchestration failed', {
            taskId,
            error: error instanceof Error ? error.message : String(error)
          });
        });

      // Return immediately with streaming info
      return res.json({
        success: true,
        taskId,
        status: 'streaming',
        message: 'Task is being processed with real-time streaming',
        streaming: {
          enabled: true,
          subscribe: {
            namespace: '/',
            room: `task:${taskId}`,
            events: ['task_stream', 'task_created', 'task_progress', 'task_completed']
          }
        }
      });

    } else {
      // Standard synchronous execution
      const result = await streamingOrchestrator.orchestrateWithStreaming(task, {
        ...options,
        stream: false,
        taskId
      });

      return res.json({
        success: true,
        taskId,
        status: 'completed',
        result
      });
    }

  } catch (error) {
    logger.error('Orchestration failed', {
      error: sanitizeErrorMessage(error, process.env.NODE_ENV === 'development'),
      task: req.body.task
    });

    res.status(500).json({
      error: 'Orchestration failed',
      message: sanitizeErrorMessage(error, process.env.NODE_ENV === 'development')
    });
  }
});

/**
 * Enhanced competition endpoint with real-time streaming
 */
router.post('/competition', async (req: Request, res: Response): Promise<Response | void> => {
  try {
    if (!streamingOrchestrator) {
      return res.status(503).json({
        error: 'Streaming orchestrator not initialized'
      });
    }

    const { challenge, competitorCount = 3, models, stream = false } = req.body;

    if (!challenge) {
      return res.status(400).json({
        error: 'Challenge is required',
        message: 'Please provide a challenge field',
        accepted_fields: ['challenge', 'prompt', 'task', 'question']
      });
    }

    const competitionId = uuidv4();

    if (stream) {
      // Start async streaming competition
      streamingOrchestrator.runCompetitionWithStreaming(challenge, {
        competitorCount,
        models,
        competitionId
      })
        .then(_result => {
          logger.info('Streaming competition completed', { competitionId });
        })
        .catch(error => {
          logger.error('Streaming competition failed', {
            competitionId,
            error: error instanceof Error ? error.message : String(error)
          });
        });

      // Return immediately with streaming info
      return res.json({
        success: true,
        competitionId,
        status: 'streaming',
        message: 'Competition is running with real-time updates',
        streaming: {
          enabled: true,
          subscribe: {
            events: [
              'competition_started',
              'agent_update',
              'competition_completed',
              'competition_error'
            ]
          }
        }
      });

    } else {
      // Standard execution
      const result = await streamingOrchestrator.runCompetitionWithStreaming(challenge, {
        competitorCount,
        models,
        stream: false
      });

      return res.json({
        success: true,
        competitionId,
        status: 'completed',
        result
      });
    }

  } catch (error) {
    logger.error('Competition failed', {
      error: sanitizeErrorMessage(error, process.env.NODE_ENV === 'development'),
      challenge: req.body.challenge
    });

    res.status(500).json({
      error: 'Competition failed',
      message: sanitizeErrorMessage(error, process.env.NODE_ENV === 'development')
    });
  }
});

/**
 * Get active streaming tasks
 */
router.get('/streaming/tasks', (_req: Request, res: Response): Response | void => {
  try {
    if (!streamingOrchestrator) {
      return res.status(503).json({
        error: 'Streaming orchestrator not initialized'
      });
    }

    const activeStreams = streamingOrchestrator.getActiveStreams();
    const tasks = Array.from(activeStreams.entries()).map(([taskId, context]) => ({
      taskId,
      startTime: context.startTime,
      duration: context.getDuration(),
      eventCount: context.eventCount,
      eventRate: context.getEventRate(),
      options: context.options
    }));

    res.json({
      count: tasks.length,
      tasks,
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    logger.error('Failed to get streaming tasks', {
      error: error instanceof Error ? error.message : String(error)
    });

    res.status(500).json({
      error: 'Failed to get streaming tasks',
      message: sanitizeErrorMessage(error, process.env.NODE_ENV === 'development')
    });
  }
});

/**
 * Stop a streaming task
 */
router.post('/streaming/stop/:taskId', async (req: Request, res: Response): Promise<Response | void> => {
  try {
    if (!streamingOrchestrator) {
      return res.status(503).json({
        error: 'Streaming orchestrator not initialized'
      });
    }

    const { taskId } = req.params;

    await streamingOrchestrator.stopStream(taskId);

    res.json({
      success: true,
      taskId,
      message: 'Stream stopped successfully',
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    logger.error('Failed to stop stream', {
      taskId: req.params.taskId,
      error: error instanceof Error ? error.message : String(error)
    });

    res.status(500).json({
      error: 'Failed to stop stream',
      message: sanitizeErrorMessage(error, process.env.NODE_ENV === 'development')
    });
  }
});

/**
 * WebSocket connection info endpoint
 */
router.get('/streaming/info', (req: Request, res: Response) => {
  try {
    const wsManager = getEnhancedWebSocketManager();
    const health = wsManager.getHealthStatus();
    const metrics = wsManager.getMetrics();

    res.json({
      websocket: {
        url: `ws://${req.hostname}:${process.env.PORT || 8080}`,
        namespaces: {
          main: '/',
          stream: '/stream',
          control: '/control'
        },
        transports: ['websocket', 'polling'],
        reconnection: true,
        health,
        metrics: {
          activeSessions: metrics.activeSessions,
          activeStreams: metrics.activeStreams,
          totalSubscriptions: metrics.totalSubscriptions,
          messagesIn: metrics.messagesIn,
          messagesOut: metrics.messagesOut,
          errorRate: metrics.errorRate
        }
      },
      streaming: {
        supported: true,
        features: [
          'real-time task updates',
          'agent output streaming',
          'competition live updates',
          'bidirectional communication',
          'automatic reconnection',
          'backpressure handling'
        ]
      },
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    logger.error('Failed to get streaming info', {
      error: error instanceof Error ? error.message : String(error)
    });

    res.status(500).json({
      error: 'Failed to get streaming info',
      message: sanitizeErrorMessage(error, process.env.NODE_ENV === 'development')
    });
  }
});

/**
 * Create WebSocket session (for clients that need pre-authentication)
 */
router.post('/streaming/session', (req: Request, res: Response) => {
  try {
    const sessionToken = uuidv4();
    const reconnectToken = uuidv4();

    // Store session tokens (implement your auth logic here)

    res.json({
      success: true,
      session: {
        token: sessionToken,
        reconnectToken,
        expires: new Date(Date.now() + 3600000).toISOString(), // 1 hour
        websocketUrl: `ws://${req.hostname}:${process.env.PORT || 8080}`,
        instructions: 'Connect to WebSocket and send session token in handshake'
      }
    });

  } catch (error) {
    logger.error('Failed to create streaming session', {
      error: error instanceof Error ? error.message : String(error)
    });

    res.status(500).json({
      error: 'Failed to create streaming session',
      message: sanitizeErrorMessage(error, process.env.NODE_ENV === 'development')
    });
  }
});

export default router;