/**
 * GDPR Integration Tests
 *
 * Tests the complete GDPR compliance flow:
 * 1. Create test user data
 * 2. Export and verify data
 * 3. Delete and verify deletion
 *
 * Run with: npx tsx tests/gdpr-integration.test.ts
 */

import { Pool } from 'pg';
import { QdrantClient } from '@qdrant/js-client-rest';
import neo4j from 'neo4j-driver';
import { GDPRService } from '../src/services/gdpr-service';
import { config } from '../src/config';

// Test configuration
const TEST_TENANT_ID = 'test-tenant-gdpr';
const TEST_USER_ID = 'test-user-gdpr';

// Initialize database connections
const postgresPool = new Pool({
  host: config.database.postgres.host,
  port: config.database.postgres.port,
  database: config.database.postgres.database,
  user: config.database.postgres.user,
  password: config.database.postgres.password,
});

const qdrantClient = new QdrantClient({
  url: `http://${config.database.qdrant.host}:${config.database.qdrant.port}`,
  apiKey: config.database.qdrant.apiKey,
});

const neo4jDriver = neo4j.driver(
  config.database.neo4j.uri,
  neo4j.auth.basic(config.database.neo4j.user, config.database.neo4j.password)
);

const gdprService = new GDPRService(postgresPool, qdrantClient, neo4jDriver);

/**
 * Create test data for GDPR testing
 */
async function createTestData(): Promise<void> {
  console.log('\n📝 Creating test data...');

  // Create test memories in PostgreSQL
  const memoryQuery = `
    INSERT INTO unified_content (user_id, tenant_id, content_type, content, metadata, created_at)
    VALUES
      ($1, $2, 'memory', 'Test memory 1', '{"source": "test"}', NOW()),
      ($1, $2, 'memory', 'Test memory 2', '{"source": "test"}', NOW()),
      ($1, $2, 'document', 'Test document 1', '{"source": "test"}', NOW())
  `;
  await postgresPool.query(memoryQuery, [TEST_USER_ID, TEST_TENANT_ID]);
  console.log('✅ Created 3 records in PostgreSQL');

  // Create test vectors in Qdrant (if collection exists)
  try {
    const pointId = Date.now();
    await qdrantClient.upsert('unified_embeddings', {
      points: [
        {
          id: pointId,
          vector: Array(1024).fill(0.1), // Dummy 1024-dim vector
          payload: {
            user_id: TEST_USER_ID,
            tenant_id: TEST_TENANT_ID,
            content: 'Test vector content',
            content_type: 'memory',
          },
        },
      ],
    });
    console.log('✅ Created 1 vector in Qdrant');
  } catch (error) {
    console.warn('⚠️  Qdrant collection not found, skipping vector creation');
  }

  // Create test episodes in Neo4j
  const session = neo4jDriver.session();
  try {
    await session.run(
      `
      CREATE (e:Episode {
        id: randomUUID(),
        user_id: $userId,
        tenant_id: $tenantId,
        content: 'Test episode',
        created_at: datetime()
      })
      `,
      { userId: TEST_USER_ID, tenantId: TEST_TENANT_ID }
    );
    console.log('✅ Created 1 episode in Neo4j');
  } finally {
    await session.close();
  }

  console.log('✅ Test data creation complete\n');
}

/**
 * Test data export
 */
async function testExport(): Promise<void> {
  console.log('📤 Testing data export...');

  const exportData = await gdprService.exportUserData({
    userId: TEST_USER_ID,
    tenantId: TEST_TENANT_ID,
  });

  console.log('\nExport Results:');
  console.log('-------------------');
  console.log(`Total Records: ${exportData.metadata.totalRecords}`);
  console.log(`Memories: ${exportData.metadata.recordsByType.memories}`);
  console.log(`Documents: ${exportData.metadata.recordsByType.documents}`);
  console.log(`Vectors: ${exportData.metadata.recordsByType.vectors}`);
  console.log(`Episodes: ${exportData.metadata.recordsByType.episodes}`);
  console.log(`Entities: ${exportData.metadata.recordsByType.entities}`);

  // Verify data was exported
  if (exportData.metadata.totalRecords < 3) {
    throw new Error('❌ Export failed: Expected at least 3 records');
  }

  console.log('\n✅ Export test passed\n');
}

/**
 * Test data deletion
 */
async function testDeletion(): Promise<void> {
  console.log('🗑️  Testing data deletion...');

  const deletionReport = await gdprService.deleteUserData({
    userId: TEST_USER_ID,
    tenantId: TEST_TENANT_ID,
  });

  console.log('\nDeletion Results:');
  console.log('-------------------');
  console.log(`Total Deleted: ${deletionReport.totalDeleted}`);
  console.log('PostgreSQL:');
  console.log(`  - Memories: ${deletionReport.deletedCounts.postgres.memories}`);
  console.log(`  - Documents: ${deletionReport.deletedCounts.postgres.documents}`);
  console.log(`  - Total: ${deletionReport.deletedCounts.postgres.total}`);
  console.log(`Qdrant Vectors: ${deletionReport.deletedCounts.qdrant.vectors}`);
  console.log('Neo4j:');
  console.log(`  - Episodes: ${deletionReport.deletedCounts.neo4j.episodes}`);
  console.log(`  - Entities: ${deletionReport.deletedCounts.neo4j.entities}`);
  console.log(`  - Total: ${deletionReport.deletedCounts.neo4j.total}`);

  if (deletionReport.errors.length > 0) {
    console.warn('\n⚠️  Deletion errors:');
    deletionReport.errors.forEach((error) => {
      console.warn(`  - ${error.database}: ${error.error}`);
    });
  }

  // Verify deletion was successful
  if (deletionReport.totalDeleted < 3) {
    throw new Error('❌ Deletion failed: Expected at least 3 records deleted');
  }

  console.log('\n✅ Deletion test passed\n');
}

/**
 * Verify data is completely deleted
 */
async function verifyDeletion(): Promise<void> {
  console.log('🔍 Verifying complete deletion...');

  const exportData = await gdprService.exportUserData({
    userId: TEST_USER_ID,
    tenantId: TEST_TENANT_ID,
  });

  console.log(`\nRecords remaining: ${exportData.metadata.totalRecords}`);

  if (exportData.metadata.totalRecords > 0) {
    console.warn('⚠️  Some data still exists:');
    console.warn(`  - Memories: ${exportData.metadata.recordsByType.memories}`);
    console.warn(`  - Documents: ${exportData.metadata.recordsByType.documents}`);
    console.warn(`  - Vectors: ${exportData.metadata.recordsByType.vectors}`);
    console.warn(`  - Episodes: ${exportData.metadata.recordsByType.episodes}`);
    console.warn(`  - Entities: ${exportData.metadata.recordsByType.entities}`);
    throw new Error('❌ Deletion verification failed: Data still exists');
  }

  console.log('✅ Deletion verification passed - all data removed\n');
}

/**
 * Cleanup function
 */
async function cleanup(): Promise<void> {
  console.log('🧹 Cleaning up test data...');

  // Delete any remaining test data
  await postgresPool.query(
    'DELETE FROM unified_content WHERE user_id = $1 AND tenant_id = $2',
    [TEST_USER_ID, TEST_TENANT_ID]
  );

  const session = neo4jDriver.session();
  try {
    await session.run(
      'MATCH (n {user_id: $userId, tenant_id: $tenantId}) DETACH DELETE n',
      { userId: TEST_USER_ID, tenantId: TEST_TENANT_ID }
    );
  } finally {
    await session.close();
  }

  console.log('✅ Cleanup complete\n');
}

/**
 * Main test runner
 */
async function runTests(): Promise<void> {
  console.log('\n=================================');
  console.log('🧪 GDPR Integration Tests');
  console.log('=================================');

  try {
    // Cleanup any existing test data
    await cleanup();

    // Run test sequence
    await createTestData();
    await testExport();
    await testDeletion();
    await verifyDeletion();

    console.log('=================================');
    console.log('✅ ALL TESTS PASSED');
    console.log('=================================\n');
  } catch (error) {
    console.error('\n=================================');
    console.error('❌ TEST FAILED');
    console.error('=================================');
    console.error(error);
    console.error('\n');
    process.exit(1);
  } finally {
    // Close connections
    await postgresPool.end();
    await neo4jDriver.close();
  }
}

// Run tests if this file is executed directly
if (require.main === module) {
  runTests().catch((error) => {
    console.error('Fatal error:', error);
    process.exit(1);
  });
}

export { runTests };
