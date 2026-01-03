#!/usr/bin/env tsx
/**
 * Migration Script: Migrate Document Chunks to unified_content
 *
 * This script copies existing document chunks from the 'chunks' Qdrant collection
 * to the 'unified_content' collection with content_type='document_chunk'.
 *
 * This enables documents to be searchable via /api/memory/recall alongside
 * episodic memories.
 *
 * Usage:
 *   npx tsx scripts/migrate-chunks-to-unified.ts           # Run migration
 *   npx tsx scripts/migrate-chunks-to-unified.ts --dry-run # Preview without migrating
 *   npx tsx scripts/migrate-chunks-to-unified.ts --verbose # Show detailed progress
 */

import { QdrantClient } from '@qdrant/js-client-rest';
import { randomUUID } from 'crypto';

// Configuration
const QDRANT_URL = process.env.QDRANT_URL || 'http://localhost:6333';
const QDRANT_API_KEY = process.env.QDRANT_API_KEY || undefined;
const DRY_RUN = process.argv.includes('--dry-run');
const VERBOSE = process.argv.includes('--verbose');
const BATCH_SIZE = 100;

// Colors for console output
const colors = {
  reset: '\x1b[0m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  cyan: '\x1b[36m',
  dim: '\x1b[2m',
};

function log(message: string, color: string = colors.reset) {
  console.log(`${color}${message}${colors.reset}`);
}

function logVerbose(message: string) {
  if (VERBOSE) {
    console.log(`${colors.dim}  ${message}${colors.reset}`);
  }
}

interface MigrationStats {
  totalChunks: number;
  migratedChunks: number;
  skippedChunks: number;
  failedChunks: number;
  documentsProcessed: Set<string>;
}

async function main() {
  log('\n========================================', colors.cyan);
  log('  Document Chunks Migration Script', colors.cyan);
  log('========================================\n', colors.cyan);

  if (DRY_RUN) {
    log('Running in DRY RUN mode - no changes will be made\n', colors.yellow);
  }

  // Initialize Qdrant client
  log(`Connecting to Qdrant at ${QDRANT_URL}...`, colors.dim);
  const qdrantClient = new QdrantClient({
    url: QDRANT_URL,
    apiKey: QDRANT_API_KEY,
  });

  // Verify collections exist
  try {
    const collections = await qdrantClient.getCollections();
    const collectionNames = collections.collections.map(c => c.name);

    if (!collectionNames.includes('chunks')) {
      log('ERROR: "chunks" collection does not exist', colors.red);
      process.exit(1);
    }

    if (!collectionNames.includes('unified_content')) {
      log('ERROR: "unified_content" collection does not exist', colors.red);
      log('This collection should be created by the GraphRAG service on startup.', colors.dim);
      process.exit(1);
    }

    log('Collections verified\n', colors.green);
  } catch (error: any) {
    log(`ERROR: Failed to connect to Qdrant: ${error.message}`, colors.red);
    process.exit(1);
  }

  // Get chunk count
  const chunksInfo = await qdrantClient.getCollection('chunks');
  const totalPoints = chunksInfo.points_count || 0;
  log(`Found ${totalPoints} chunks to migrate\n`, colors.cyan);

  if (totalPoints === 0) {
    log('No chunks to migrate. Exiting.', colors.yellow);
    process.exit(0);
  }

  // Initialize stats
  const stats: MigrationStats = {
    totalChunks: totalPoints,
    migratedChunks: 0,
    skippedChunks: 0,
    failedChunks: 0,
    documentsProcessed: new Set(),
  };

  // Scroll through all chunks and migrate
  let offset: string | number | undefined = undefined;
  let batchNumber = 0;

  while (true) {
    batchNumber++;
    log(`Processing batch ${batchNumber}...`, colors.dim);

    // Scroll to get next batch
    const scrollResult = await qdrantClient.scroll('chunks', {
      limit: BATCH_SIZE,
      offset: offset,
      with_payload: true,
      with_vector: true,
    });

    const points = scrollResult.points || [];
    if (points.length === 0) {
      break;
    }

    // Check if any of these chunks already exist in unified_content by chunk_id in payload
    const existingCheck = await Promise.all(
      points.map(async (point) => {
        try {
          // Search for existing entry with this chunk_id in payload
          const searchResult = await qdrantClient.scroll('unified_content', {
            limit: 1,
            filter: {
              must: [
                { key: 'content_type', match: { value: 'document_chunk' } },
                { key: 'chunk_id', match: { value: point.id as string } }
              ]
            },
            with_payload: false
          });
          return (searchResult.points?.length || 0) > 0;
        } catch {
          return false;
        }
      })
    );

    // Prepare points for unified_content
    const newPoints = points
      .map((point, index) => {
        if (existingCheck[index]) {
          stats.skippedChunks++;
          logVerbose(`Skipping chunk ${point.id} (already exists)`);
          return null;
        }

        const payload = point.payload || {};
        const documentId = payload.document_id as string;

        if (documentId) {
          stats.documentsProcessed.add(documentId);
        }

        return {
          id: randomUUID(),  // Generate new UUID for unified_content
          vector: point.vector as number[],
          payload: {
            content_type: 'document_chunk',
            content: payload.content || '',
            document_id: documentId,
            chunk_id: point.id,
            position: payload.position || { start: 0, end: 0 },
            page_number: (payload.metadata as any)?.pageNumber || null,
            title: (payload.metadata as any)?.title || null,
            tags: (payload.metadata as any)?.tags || [],
            type: payload.type || 'paragraph',
            tokens: payload.tokens || 0,
            timestamp: new Date().toISOString(),
            // Tenant context - documents are system-level
            company_id: 'adverant',
            app_id: 'fileprocess',
            user_id: 'system',
          },
        };
      })
      .filter((p): p is NonNullable<typeof p> => p !== null);

    // Upsert to unified_content
    if (newPoints.length > 0 && !DRY_RUN) {
      try {
        await qdrantClient.upsert('unified_content', {
          wait: true,
          points: newPoints,
        });
        stats.migratedChunks += newPoints.length;
        logVerbose(`Migrated ${newPoints.length} chunks`);
      } catch (error: any) {
        log(`ERROR migrating batch: ${error.message}`, colors.red);
        stats.failedChunks += newPoints.length;
      }
    } else if (newPoints.length > 0) {
      stats.migratedChunks += newPoints.length;
      logVerbose(`[DRY RUN] Would migrate ${newPoints.length} chunks`);
    }

    // Update offset for next batch
    offset = scrollResult.next_page_offset;
    if (!offset) {
      break;
    }

    // Progress update every 5 batches
    if (batchNumber % 5 === 0) {
      const progress = ((stats.migratedChunks + stats.skippedChunks + stats.failedChunks) / stats.totalChunks * 100).toFixed(1);
      log(`Progress: ${progress}% (${stats.migratedChunks} migrated, ${stats.skippedChunks} skipped)`, colors.dim);
    }
  }

  // Print summary
  log('\n========================================', colors.cyan);
  log('  Migration Summary', colors.cyan);
  log('========================================\n', colors.cyan);

  log(`Total chunks in source:    ${stats.totalChunks}`, colors.dim);
  log(`Chunks migrated:           ${stats.migratedChunks}`, colors.green);
  log(`Chunks skipped (existing): ${stats.skippedChunks}`, colors.yellow);
  log(`Chunks failed:             ${stats.failedChunks}`, stats.failedChunks > 0 ? colors.red : colors.dim);
  log(`Documents processed:       ${stats.documentsProcessed.size}`, colors.dim);

  if (DRY_RUN) {
    log('\n[DRY RUN] No changes were made to the database.', colors.yellow);
  } else {
    log('\nMigration complete!', colors.green);
    log('Document chunks are now searchable via /api/memory/recall', colors.dim);
  }

  log('');
}

// Run the migration
main().catch((error) => {
  console.error('Migration failed:', error);
  process.exit(1);
});
