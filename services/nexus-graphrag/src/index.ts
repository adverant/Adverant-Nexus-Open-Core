import { GraphRAGAPI } from './api';
import { logger } from './utils/logger';
import { DatabaseManager } from './database/database-manager';
import { config } from './config';

/**
 * Validate system health before starting service
 * Ensures all critical components are operational
 */
async function validateSystemHealth(dbManager: DatabaseManager): Promise<void> {
  logger.info('Running system health validations...');

  const validations = [
    {
      name: 'Database Connection',
      fn: async () => {
        const client = await dbManager.postgres.connect();
        await client.query('SELECT 1');
        client.release();
      }
    },
    {
      name: 'Unified Content Table',
      fn: async () => {
        const client = await dbManager.postgres.connect();
        try {
          const result = await client.query(`
            SELECT EXISTS (
              SELECT 1 FROM information_schema.tables
              WHERE table_schema = 'graphrag' AND table_name = 'unified_content'
            )
          `);

          if (!result.rows[0].exists) {
            throw new Error(
              'unified_content table does not exist. ' +
              'Run migrations: docker exec nexus-graphrag npx tsx src/database/migration-runner.ts'
            );
          }

          // Verify critical columns
          const columnsResult = await client.query(`
            SELECT column_name FROM information_schema.columns
            WHERE table_schema = 'graphrag' AND table_name = 'unified_content'
            AND column_name IN ('id', 'content_type', 'content', 'embedding_generated')
          `);

          if (columnsResult.rows.length < 4) {
            throw new Error(
              'unified_content table missing required columns. ' +
              'Expected: id, content_type, content, embedding_generated'
            );
          }
        } finally {
          client.release();
        }
      }
    },
    {
      name: 'Voyage AI API Key',
      fn: async () => {
        const apiKey = process.env.VOYAGE_API_KEY;
        if (!apiKey) {
          throw new Error(
            'VOYAGE_API_KEY environment variable not set. ' +
            'Embeddings will fail. Set this key for full functionality.'
          );
        }
        if (!apiKey.startsWith('pa-')) {
          logger.warn('Voyage AI API key format unexpected (should start with "pa-")');
        }
      }
    },
    {
      name: 'Neo4j Connection',
      fn: async () => {
        if (dbManager.neo4j) {
          const session = dbManager.neo4j.session();
          try {
            await session.run('RETURN 1');
          } finally {
            await session.close();
          }
        } else {
          logger.warn('Neo4j driver not initialized');
        }
      }
    },
    {
      name: 'Qdrant Connection',
      fn: async () => {
        if (dbManager.qdrant) {
          await dbManager.qdrant.getCollections();
        } else {
          logger.warn('Qdrant client not initialized');
        }
      }
    }
  ];

  let validationsFailed = 0;

  for (const validation of validations) {
    try {
      await validation.fn();
      logger.info(`✓ ${validation.name} - OK`);
    } catch (error: any) {
      logger.error(`✗ ${validation.name} - FAILED`, { error: error.message });
      validationsFailed++;

      // Fail fast on critical validations
      if (validation.name === 'Database Connection' || validation.name === 'Unified Content Table') {
        throw new Error(`Critical validation failed: ${validation.name} - ${error.message}`);
      }
    }
  }

  if (validationsFailed > 0) {
    logger.warn(`${validationsFailed} non-critical validations failed, but continuing startup`);
  }

  logger.info('All critical system health validations passed');
}

async function startServer() {
  try {
    logger.info('Starting GraphRAG service...');

    // Initialize database connections
    const dbManager = new DatabaseManager(config.database);
    await dbManager.initialize();
    logger.info('Database connections established');

    // Validate system health (fail fast if critical components missing)
    await validateSystemHealth(dbManager);

    // Initialize GraphRAG API
    const graphRAGAPI = new GraphRAGAPI();
    await graphRAGAPI.start();

    logger.info('GraphRAG service started successfully');
    
    // Graceful shutdown
    process.on('SIGTERM', async () => {
      logger.info('SIGTERM received, shutting down gracefully...');
      await dbManager.close();
      process.exit(0);
    });
    
    process.on('SIGINT', async () => {
      logger.info('SIGINT received, shutting down gracefully...');
      await dbManager.close();
      process.exit(0);
    });
    
  } catch (error) {
    logger.error('FATAL ERROR starting GraphRAG service', {
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined
    });
    process.exit(1);
  }
}

// Start the server
startServer();
