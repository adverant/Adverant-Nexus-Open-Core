#!/usr/bin/env ts-node
/**
 * Geo Memory Ingestion Script
 *
 * CRITICAL: This script ingests existing geo-tagged memories from PostgreSQL
 * into Qdrant (vector DB) and Neo4j (graph DB) to enable:
 *
 * 1. Semantic Search on Maps - Find memories by meaning, not just keywords
 * 2. Relationship Visualization - See connections between locations as arcs
 * 3. Temporal Animation - Play back data evolution over time
 * 4. Entity Discovery - Click marker to see linked people, events, places
 *
 * Data Flow:
 * PostgreSQL (source) → Voyage AI (embeddings) → Qdrant + Neo4j (targets)
 *
 * Usage:
 *   npx ts-node src/scripts/ingest-geo-memories.ts
 *
 * Requirements:
 *   - PostgreSQL database with graphrag.memories table
 *   - VOYAGE_API_KEY environment variable
 *   - Qdrant running (default: localhost:6333)
 *   - Neo4j running (default: bolt://localhost:7687)
 */

import { Pool } from 'pg';
import { QdrantClient } from '@qdrant/js-client-rest';
import neo4j, { Driver, Session } from 'neo4j-driver';
import { config } from 'dotenv';
import { VoyageAIUnifiedClient } from '../clients/voyage-ai-unified-client';
import { logger } from '../utils/logger';

// Load environment variables
config();

// ============================================================================
// CONFIGURATION
// ============================================================================

const CONFIG = {
  // Batch sizes for processing
  EMBEDDING_BATCH_SIZE: 20, // Voyage AI limit per request
  QDRANT_BATCH_SIZE: 100,
  NEO4J_BATCH_SIZE: 50,

  // Relationship thresholds
  NEARBY_DISTANCE_KM: 50, // Create NEARBY relationships for locations within 50km

  // Collections/Indexes
  QDRANT_COLLECTION: 'memories',
  QDRANT_DIMENSIONS: 1024,

  // Tenant context for multi-tenant isolation
  DEFAULT_TENANT: {
    companyId: 'adverant',
    appId: 'nexus-dashboard',
    userId: 'system-ingestion',
  },
};

// ============================================================================
// TYPES
// ============================================================================

interface GeoMemory {
  id: string;
  content: string;
  tags: string[];
  metadata: {
    latitude?: string;
    longitude?: string;
    city?: string;
    country?: string;
    placeName?: string;
    type?: string;
    source?: string;
    [key: string]: unknown;
  };
  created_at: Date;
}

interface IngestionStats {
  totalMemories: number;
  embeddingsGenerated: number;
  qdrantInserted: number;
  neo4jNodesCreated: number;
  neo4jRelationshipsCreated: number;
  errors: string[];
  startTime: Date;
  endTime?: Date;
}

// ============================================================================
// DATABASE CLIENTS
// ============================================================================

let postgresPool: Pool;
let qdrantClient: QdrantClient;
let neo4jDriver: Driver;
let voyageClient: VoyageAIUnifiedClient;

async function initializeClients(): Promise<void> {
  console.log('🔧 Initializing database clients...');

  // PostgreSQL - support both DATABASE_URL and individual env vars
  if (process.env.DATABASE_URL) {
    postgresPool = new Pool({
      connectionString: process.env.DATABASE_URL,
    });
  } else {
    postgresPool = new Pool({
      host: process.env.POSTGRES_HOST || 'localhost',
      port: parseInt(process.env.POSTGRES_PORT || '5432', 10),
      database: process.env.POSTGRES_DB || 'nexus',
      user: process.env.POSTGRES_USER || 'nexus',
      password: process.env.POSTGRES_PASSWORD || 'password',
      options: `-c search_path=${process.env.POSTGRES_SCHEMA || 'graphrag'},public`,
    });
  }
  await postgresPool.query('SELECT 1'); // Test connection
  console.log('  ✅ PostgreSQL connected');

  // Qdrant
  qdrantClient = new QdrantClient({
    url: process.env.QDRANT_URL || 'http://localhost:6333',
  });
  // Ensure collection exists
  await ensureQdrantCollection();
  console.log('  ✅ Qdrant connected');

  // Neo4j
  const neo4jUri = process.env.NEO4J_URI || 'bolt://localhost:7687';
  const neo4jUser = process.env.NEO4J_USER || 'neo4j';
  const neo4jPassword = process.env.NEO4J_PASSWORD || 'password';
  neo4jDriver = neo4j.driver(neo4jUri, neo4j.auth.basic(neo4jUser, neo4jPassword));
  await neo4jDriver.verifyConnectivity();
  console.log('  ✅ Neo4j connected');

  // Voyage AI
  const voyageApiKey = process.env.VOYAGE_API_KEY;
  if (!voyageApiKey) {
    throw new Error('VOYAGE_API_KEY environment variable is required');
  }
  voyageClient = new VoyageAIUnifiedClient(voyageApiKey);
  console.log('  ✅ Voyage AI initialized');
}

async function ensureQdrantCollection(): Promise<void> {
  try {
    const collections = await qdrantClient.getCollections();
    const exists = collections.collections.some((c) => c.name === CONFIG.QDRANT_COLLECTION);

    if (!exists) {
      console.log(`  📦 Creating Qdrant collection: ${CONFIG.QDRANT_COLLECTION}`);
      await qdrantClient.createCollection(CONFIG.QDRANT_COLLECTION, {
        vectors: {
          size: CONFIG.QDRANT_DIMENSIONS,
          distance: 'Cosine',
        },
      });

      // Create payload indexes for geo filtering
      await qdrantClient.createPayloadIndex(CONFIG.QDRANT_COLLECTION, {
        field_name: 'latitude',
        field_schema: 'float',
      });
      await qdrantClient.createPayloadIndex(CONFIG.QDRANT_COLLECTION, {
        field_name: 'longitude',
        field_schema: 'float',
      });
      await qdrantClient.createPayloadIndex(CONFIG.QDRANT_COLLECTION, {
        field_name: 'type',
        field_schema: 'keyword',
      });
      await qdrantClient.createPayloadIndex(CONFIG.QDRANT_COLLECTION, {
        field_name: 'city',
        field_schema: 'keyword',
      });
      await qdrantClient.createPayloadIndex(CONFIG.QDRANT_COLLECTION, {
        field_name: 'country',
        field_schema: 'keyword',
      });

      console.log(`  ✅ Created collection with geo indexes`);
    } else {
      console.log(`  ℹ️  Collection ${CONFIG.QDRANT_COLLECTION} already exists`);
    }
  } catch (error: any) {
    console.error('  ❌ Failed to ensure Qdrant collection:', error.message);
    throw error;
  }
}

// ============================================================================
// FETCH GEO MEMORIES FROM POSTGRESQL
// ============================================================================

async function fetchGeoMemories(): Promise<GeoMemory[]> {
  console.log('\n📥 Fetching geo-tagged memories from PostgreSQL...');

  const result = await postgresPool.query(`
    SELECT id, content, tags, metadata, created_at
    FROM graphrag.memories
    WHERE metadata->>'latitude' IS NOT NULL
      AND metadata->>'longitude' IS NOT NULL
    ORDER BY created_at DESC
  `);

  console.log(`  Found ${result.rows.length} geo-tagged memories`);

  return result.rows.map((row) => ({
    id: row.id,
    content: row.content,
    tags: row.tags || [],
    metadata: typeof row.metadata === 'string' ? JSON.parse(row.metadata) : row.metadata,
    created_at: row.created_at,
  }));
}

// ============================================================================
// GENERATE EMBEDDINGS VIA VOYAGE AI
// ============================================================================

async function generateEmbeddings(
  memories: GeoMemory[],
  stats: IngestionStats
): Promise<Map<string, number[]>> {
  console.log('\n🧠 Generating embeddings via Voyage AI...');

  const embeddings = new Map<string, number[]>();
  const batches = chunkArray(memories, CONFIG.EMBEDDING_BATCH_SIZE);

  for (let i = 0; i < batches.length; i++) {
    const batch = batches[i];
    console.log(`  Processing batch ${i + 1}/${batches.length} (${batch.length} memories)`);

    for (const memory of batch) {
      try {
        const result = await voyageClient.generateEmbedding(memory.content, {
          inputType: 'document',
          contentType: 'text',
        });

        if (result.embedding && result.embedding.length === CONFIG.QDRANT_DIMENSIONS) {
          embeddings.set(memory.id, result.embedding);
          stats.embeddingsGenerated++;
        } else {
          stats.errors.push(`Invalid embedding for ${memory.id}: ${result.embedding?.length} dims`);
        }
      } catch (error: any) {
        stats.errors.push(`Embedding error for ${memory.id}: ${error.message}`);
        console.error(`    ❌ Failed to embed ${memory.id}: ${error.message}`);
      }

      // Rate limiting - small delay between requests
      await sleep(100);
    }
  }

  console.log(`  ✅ Generated ${embeddings.size} embeddings`);
  return embeddings;
}

// ============================================================================
// INSERT INTO QDRANT WITH GEO PAYLOAD
// ============================================================================

async function insertIntoQdrant(
  memories: GeoMemory[],
  embeddings: Map<string, number[]>,
  stats: IngestionStats
): Promise<void> {
  console.log('\n📊 Inserting vectors into Qdrant...');

  const points: Array<{
    id: string;
    vector: number[];
    payload: Record<string, unknown>;
  }> = [];

  for (const memory of memories) {
    const embedding = embeddings.get(memory.id);
    if (!embedding) continue;

    const lat = parseFloat(memory.metadata.latitude || '0');
    const lng = parseFloat(memory.metadata.longitude || '0');

    points.push({
      id: memory.id,
      vector: embedding,
      payload: {
        content: memory.content,
        tags: memory.tags,
        latitude: lat,
        longitude: lng,
        city: memory.metadata.city || null,
        country: memory.metadata.country || null,
        placeName: memory.metadata.placeName || null,
        type: memory.metadata.type || 'memory',
        source: memory.metadata.source || 'graphrag',
        created_at: memory.created_at.toISOString(),
        // Tenant context
        company_id: CONFIG.DEFAULT_TENANT.companyId,
        app_id: CONFIG.DEFAULT_TENANT.appId,
      },
    });
  }

  // Insert in batches
  const batches = chunkArray(points, CONFIG.QDRANT_BATCH_SIZE);

  for (let i = 0; i < batches.length; i++) {
    const batch = batches[i];
    console.log(`  Inserting batch ${i + 1}/${batches.length} (${batch.length} points)`);

    try {
      await qdrantClient.upsert(CONFIG.QDRANT_COLLECTION, {
        wait: true,
        points: batch,
      });
      stats.qdrantInserted += batch.length;
    } catch (error: any) {
      stats.errors.push(`Qdrant batch ${i + 1} error: ${error.message}`);
      console.error(`    ❌ Failed to insert batch: ${error.message}`);
    }
  }

  console.log(`  ✅ Inserted ${stats.qdrantInserted} points into Qdrant`);
}

// ============================================================================
// CREATE NEO4J NODES AND RELATIONSHIPS
// ============================================================================

async function insertIntoNeo4j(memories: GeoMemory[], stats: IngestionStats): Promise<void> {
  console.log('\n🔗 Creating nodes in Neo4j...');

  const session: Session = neo4jDriver.session();

  try {
    // Step 1: Create Memory nodes with geo properties
    const batches = chunkArray(memories, CONFIG.NEO4J_BATCH_SIZE);

    for (let i = 0; i < batches.length; i++) {
      const batch = batches[i];
      console.log(`  Creating nodes batch ${i + 1}/${batches.length} (${batch.length} nodes)`);

      const nodesData = batch.map((m) => ({
        id: m.id,
        content: m.content.substring(0, 1000), // Truncate for Neo4j
        latitude: parseFloat(m.metadata.latitude || '0'),
        longitude: parseFloat(m.metadata.longitude || '0'),
        city: m.metadata.city || 'Unknown',
        country: m.metadata.country || 'Unknown',
        placeName: m.metadata.placeName || null,
        type: m.metadata.type || 'memory',
        created_at: m.created_at.toISOString(),
      }));

      try {
        const result = await session.run(
          `
          UNWIND $nodes AS node
          MERGE (m:Memory {id: node.id})
          ON CREATE SET
            m.content = node.content,
            m.latitude = node.latitude,
            m.longitude = node.longitude,
            m.city = node.city,
            m.country = node.country,
            m.placeName = node.placeName,
            m.type = node.type,
            m.created_at = datetime(node.created_at)
          ON MATCH SET
            m.latitude = node.latitude,
            m.longitude = node.longitude,
            m.city = node.city,
            m.country = node.country,
            m.updated_at = datetime()
          RETURN count(m) as created
        `,
          { nodes: nodesData }
        );

        stats.neo4jNodesCreated += batch.length;
      } catch (error: any) {
        stats.errors.push(`Neo4j nodes batch ${i + 1} error: ${error.message}`);
        console.error(`    ❌ Failed to create nodes: ${error.message}`);
      }
    }

    console.log(`  ✅ Created ${stats.neo4jNodesCreated} Memory nodes`);

    // Step 2: Create NEARBY relationships for proximate locations
    console.log('\n  Creating NEARBY relationships (within 50km)...');

    try {
      // Use Haversine formula in Cypher to find nearby memories
      const nearbyResult = await session.run(`
        MATCH (a:Memory), (b:Memory)
        WHERE a.id < b.id  // Avoid duplicate relationships
          AND a.latitude IS NOT NULL
          AND b.latitude IS NOT NULL
          AND a.longitude IS NOT NULL
          AND b.longitude IS NOT NULL
        WITH a, b,
          // Haversine formula for distance in km
          6371 * 2 * ASIN(SQRT(
            HAVERSIN(RADIANS(b.latitude - a.latitude)) +
            COS(RADIANS(a.latitude)) * COS(RADIANS(b.latitude)) *
            HAVERSIN(RADIANS(b.longitude - a.longitude))
          )) AS distance_km
        WHERE distance_km <= $maxDistance
        MERGE (a)-[r:NEARBY]->(b)
        ON CREATE SET r.distance_km = distance_km
        ON MATCH SET r.distance_km = distance_km
        RETURN count(r) as relationships
      `, { maxDistance: CONFIG.NEARBY_DISTANCE_KM });

      const relationshipsCreated = nearbyResult.records[0]?.get('relationships')?.toNumber() || 0;
      stats.neo4jRelationshipsCreated += relationshipsCreated;
      console.log(`    ✅ Created ${relationshipsCreated} NEARBY relationships`);
    } catch (error: any) {
      stats.errors.push(`NEARBY relationships error: ${error.message}`);
      console.error(`    ❌ Failed to create NEARBY relationships: ${error.message}`);
    }

    // Step 3: Create SAME_CITY relationships
    console.log('  Creating SAME_CITY relationships...');

    try {
      const sameCityResult = await session.run(`
        MATCH (a:Memory), (b:Memory)
        WHERE a.id < b.id
          AND a.city IS NOT NULL
          AND a.city = b.city
          AND a.city <> 'Unknown'
        MERGE (a)-[r:SAME_CITY]->(b)
        ON CREATE SET r.city = a.city
        RETURN count(r) as relationships
      `);

      const sameCityCreated = sameCityResult.records[0]?.get('relationships')?.toNumber() || 0;
      stats.neo4jRelationshipsCreated += sameCityCreated;
      console.log(`    ✅ Created ${sameCityCreated} SAME_CITY relationships`);
    } catch (error: any) {
      stats.errors.push(`SAME_CITY relationships error: ${error.message}`);
      console.error(`    ❌ Failed to create SAME_CITY relationships: ${error.message}`);
    }

    // Step 4: Create TYPE-based relationships (e.g., GEOFENCE, VEHICLE)
    console.log('  Creating SAME_TYPE relationships...');

    try {
      const sameTypeResult = await session.run(`
        MATCH (a:Memory), (b:Memory)
        WHERE a.id < b.id
          AND a.type IS NOT NULL
          AND a.type = b.type
          AND a.type <> 'memory'
        MERGE (a)-[r:SAME_TYPE]->(b)
        ON CREATE SET r.type = a.type
        RETURN count(r) as relationships
      `);

      const sameTypeCreated = sameTypeResult.records[0]?.get('relationships')?.toNumber() || 0;
      stats.neo4jRelationshipsCreated += sameTypeCreated;
      console.log(`    ✅ Created ${sameTypeCreated} SAME_TYPE relationships`);
    } catch (error: any) {
      stats.errors.push(`SAME_TYPE relationships error: ${error.message}`);
      console.error(`    ❌ Failed to create SAME_TYPE relationships: ${error.message}`);
    }

    // Step 5: Create indexes for efficient querying
    console.log('  Creating Neo4j indexes...');

    try {
      await session.run(`
        CREATE INDEX memory_id IF NOT EXISTS FOR (m:Memory) ON (m.id)
      `);
      await session.run(`
        CREATE INDEX memory_city IF NOT EXISTS FOR (m:Memory) ON (m.city)
      `);
      await session.run(`
        CREATE INDEX memory_type IF NOT EXISTS FOR (m:Memory) ON (m.type)
      `);
      await session.run(`
        CREATE INDEX memory_coords IF NOT EXISTS FOR (m:Memory) ON (m.latitude, m.longitude)
      `);
      console.log('    ✅ Indexes created');
    } catch (error: any) {
      // Indexes might already exist, which is fine
      console.log(`    ℹ️  Index creation: ${error.message}`);
    }
  } finally {
    await session.close();
  }
}

// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================

function chunkArray<T>(array: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < array.length; i += size) {
    chunks.push(array.slice(i, i + size));
  }
  return chunks;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function formatDuration(startTime: Date, endTime: Date): string {
  const ms = endTime.getTime() - startTime.getTime();
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  return minutes > 0 ? `${minutes}m ${seconds % 60}s` : `${seconds}s`;
}

// ============================================================================
// MAIN EXECUTION
// ============================================================================

async function main(): Promise<void> {
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('       🌍 GEO MEMORY INGESTION PIPELINE');
  console.log('       PostgreSQL → Voyage AI → Qdrant + Neo4j');
  console.log('═══════════════════════════════════════════════════════════════\n');

  const stats: IngestionStats = {
    totalMemories: 0,
    embeddingsGenerated: 0,
    qdrantInserted: 0,
    neo4jNodesCreated: 0,
    neo4jRelationshipsCreated: 0,
    errors: [],
    startTime: new Date(),
  };

  try {
    // Initialize all database connections
    await initializeClients();

    // Step 1: Fetch geo memories from PostgreSQL
    const memories = await fetchGeoMemories();
    stats.totalMemories = memories.length;

    if (memories.length === 0) {
      console.log('\n⚠️  No geo-tagged memories found in PostgreSQL.');
      console.log('   Run seed-widget-showcase-data.ts first to create test data.');
      return;
    }

    // Step 2: Generate embeddings via Voyage AI
    const embeddings = await generateEmbeddings(memories, stats);

    // Step 3: Insert into Qdrant with geo payload
    await insertIntoQdrant(memories, embeddings, stats);

    // Step 4: Create Neo4j nodes and relationships
    await insertIntoNeo4j(memories, stats);

    // Done!
    stats.endTime = new Date();

    console.log('\n═══════════════════════════════════════════════════════════════');
    console.log('       ✅ INGESTION COMPLETE');
    console.log('═══════════════════════════════════════════════════════════════');
    console.log(`\n📊 Statistics:`);
    console.log(`   Total memories:        ${stats.totalMemories}`);
    console.log(`   Embeddings generated:  ${stats.embeddingsGenerated}`);
    console.log(`   Qdrant points:         ${stats.qdrantInserted}`);
    console.log(`   Neo4j nodes:           ${stats.neo4jNodesCreated}`);
    console.log(`   Neo4j relationships:   ${stats.neo4jRelationshipsCreated}`);
    console.log(`   Duration:              ${formatDuration(stats.startTime, stats.endTime)}`);

    if (stats.errors.length > 0) {
      console.log(`\n⚠️  Errors (${stats.errors.length}):`);
      stats.errors.slice(0, 10).forEach((e) => console.log(`   - ${e}`));
      if (stats.errors.length > 10) {
        console.log(`   ... and ${stats.errors.length - 10} more`);
      }
    }

    console.log('\n🎯 Next Steps:');
    console.log('   1. Verify Qdrant: curl http://localhost:6333/collections/memories');
    console.log('   2. Verify Neo4j:  MATCH (m:Memory) RETURN count(m)');
    console.log('   3. Test API:      POST /geo/memories with bounds');
    console.log('   4. View on map:   Open Data Explorer in dashboard\n');
  } catch (error: any) {
    console.error('\n❌ Fatal error:', error.message);
    console.error(error.stack);
    process.exit(1);
  } finally {
    // Cleanup
    if (postgresPool) await postgresPool.end();
    if (neo4jDriver) await neo4jDriver.close();
    console.log('\n🔌 Database connections closed.');
  }
}

// Run the script
main().catch(console.error);
