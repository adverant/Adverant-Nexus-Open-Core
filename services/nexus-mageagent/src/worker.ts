import { config } from './config';
import { logger } from './utils/logger';
import { OpenRouterClient } from './clients/openrouter-client';
import { GraphRAGClient, graphRAGClient } from './clients/graphrag-client';
import { databaseManager } from './database/database-manager';
import { AgentWorker } from './agents/agent-worker';
import { WorkerPool } from './orchestration/worker-pool';

/**
 * MageAgent Worker Process
 * Handles agent task execution separate from the main orchestrator
 */
async function startWorker() {
  try {
    logger.info('Starting MageAgent worker process...');
    
    // Initialize database connections
    await databaseManager.initialize();
    logger.info('Connected to databases');
    
    // Initialize OpenRouter client
    const openRouterClient = new OpenRouterClient(
      config.openRouter.apiKey,
      config.openRouter.baseUrl
    );
    
    // Create worker pool
    const workerPool = new WorkerPool({
      openRouterClient,
      graphRAGClient,
      maxWorkers: config.orchestration.maxConcurrentAgents
    });
    
    // Start worker
    const worker = new AgentWorker({
      id: `worker-${process.pid}`,
      workerPool,
      logger
    });
    
    await worker.start();
    logger.info(`MageAgent worker ${worker.id} started successfully`);
    
    // Handle shutdown
    process.on('SIGTERM', async () => {
      logger.info('SIGTERM received, shutting down worker...');
      await worker.stop();
      await databaseManager.cleanup();
      process.exit(0);
    });
    
    process.on('SIGINT', async () => {
      logger.info('SIGINT received, shutting down worker...');
      await worker.stop();
      process.exit(0);
    });
    
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const errorStack = error instanceof Error ? error.stack : undefined;

    logger.error('Failed to start MageAgent worker:', {
      message: errorMessage,
      stack: errorStack
    });
    process.exit(1);
  }
}

// Start the worker
startWorker();
