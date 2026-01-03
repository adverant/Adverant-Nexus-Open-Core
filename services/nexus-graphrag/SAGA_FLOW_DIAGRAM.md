# Saga Pattern Flow Diagram

## Memory Storage Saga - Complete Flow

```
┌─────────────────────────────────────────────────────────────────────────┐
│                         MEMORY STORAGE REQUEST                          │
│                                                                         │
│  storeMemory(memory, tenantContext, idempotencyKey?)                  │
└────────────────────────────────┬────────────────────────────────────────┘
                                 │
                                 ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                      SAGA COORDINATOR CREATED                           │
│                                                                         │
│  sagaId: saga-${timestamp}-${random}                                   │
│  steps: [generate-embedding, store-postgres, store-qdrant, store-neo4j]│
│  startTime: Date.now()                                                 │
└────────────────────────────────┬────────────────────────────────────────┘
                                 │
                                 ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                  STEP 1: GENERATE EMBEDDING                             │
│                                                                         │
│  Execute:                                                              │
│    ✓ VoyageAI.generateEmbedding(content)                              │
│    ✓ Return: { embedding: number[1024], model: 'voyage-3' }          │
│                                                                         │
│  Compensate: No-op (no side effects)                                  │
│                                                                         │
│  Config:                                                               │
│    - Timeout: 30s                                                      │
│    - Retries: 2 attempts, 1s backoff                                  │
│    - Non-blocking: Continues without embedding on failure              │
└────────────────────────────────┬────────────────────────────────────────┘
                                 │
                                 ▼
                     ┌───────────┴───────────┐
                     │                       │
                     ▼                       ▼
              ┌─────────────┐        ┌─────────────┐
              │  SUCCESS    │        │   FAILURE   │
              │             │        │             │
              │ Embedding   │        │ Continue    │
              │ Available   │        │ Without     │
              │             │        │ Embedding   │
              └──────┬──────┘        └──────┬──────┘
                     │                      │
                     └──────────┬───────────┘
                                │
                                ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                   STEP 2: STORE IN POSTGRESQL                           │
│                         (PRIMARY DATA STORE)                            │
│                                                                         │
│  Execute:                                                              │
│    ✓ DatabaseOperations.storeInPostgres()                             │
│    ✓ INSERT ... ON CONFLICT (id) DO UPDATE                           │
│    ✓ Idempotent: Same ID updates, doesn't error                       │
│    ✓ Return: { id, inserted: bool, updated: bool }                   │
│                                                                         │
│  Compensate:                                                           │
│    ✓ RollbackHandlers.rollbackPostgres()                              │
│    ✓ DELETE FROM unified_content WHERE id = $1                        │
│    ✓ Idempotent: Deleting non-existent record is safe                │
│                                                                         │
│  Config:                                                               │
│    - Timeout: 30s                                                      │
│    - Retries: 3 attempts, 1s backoff                                  │
│    - CRITICAL: Must succeed for operation to continue                  │
└────────────────────────────────┬────────────────────────────────────────┘
                                 │
                                 ▼
                     ┌───────────┴───────────┐
                     │                       │
                     ▼                       ▼
              ┌─────────────┐        ┌─────────────────────┐
              │  SUCCESS    │        │      FAILURE        │
              │             │        │                     │
              │ PostgreSQL  │        │ TRIGGER ROLLBACK    │
              │ Write OK    │        │                     │
              │             │        │ Compensate:         │
              │ Continue    │        │ - No steps yet      │
              │ to Step 3   │        │                     │
              └──────┬──────┘        │ Return Error        │
                     │               └─────────────────────┘
                     │
                     ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                    STEP 3: STORE IN QDRANT                              │
│                        (VECTOR STORE)                                   │
│                                                                         │
│  Execute:                                                              │
│    ✓ DatabaseOperations.storeInQdrant()                               │
│    ✓ qdrantClient.upsert(point)                                       │
│    ✓ Idempotent: Same ID overwrites previous                          │
│    ✓ Return: { id, status: 'created', operation_id }                 │
│                                                                         │
│  Compensate:                                                           │
│    ✓ RollbackHandlers.rollbackQdrant()                                │
│    ✓ qdrantClient.delete(point_id)                                    │
│    ✓ Idempotent: 404 not found is OK                                 │
│                                                                         │
│  Config:                                                               │
│    - Timeout: 30s                                                      │
│    - Retries: 3 attempts, 1s backoff                                  │
│    - Skipped if: No embedding available                               │
└────────────────────────────────┬────────────────────────────────────────┘
                                 │
                                 ▼
                     ┌───────────┴───────────┐
                     │                       │
                     ▼                       ▼
              ┌─────────────┐        ┌─────────────────────┐
              │  SUCCESS    │        │      FAILURE        │
              │             │        │                     │
              │ Qdrant      │        │ TRIGGER ROLLBACK    │
              │ Write OK    │        │                     │
              │             │        │ Compensate:         │
              │ Continue    │        │ 1. Delete Qdrant    │
              │ to Step 4   │        │ 2. Delete Postgres  │
              └──────┬──────┘        │                     │
                     │               │ Return Error        │
                     │               └─────────────────────┘
                     ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                    STEP 4: STORE IN NEO4J                               │
│                         (GRAPH STORE)                                   │
│                                                                         │
│  Execute:                                                              │
│    ✓ DatabaseOperations.storeInNeo4j()                                │
│    ✓ MERGE (m:Memory {id: $id}) ON CREATE SET ... ON MATCH SET ...   │
│    ✓ Idempotent: MERGE is naturally idempotent                        │
│    ✓ Link to related memories via graph relationships                 │
│    ✓ Return: { id, nodesCreated, relationshipsCreated }              │
│                                                                         │
│  Compensate:                                                           │
│    ✓ RollbackHandlers.rollbackNeo4j()                                 │
│    ✓ MATCH (m:Memory {id: $id}) DETACH DELETE m                      │
│    ✓ Idempotent: Deleting 0 nodes is safe                            │
│                                                                         │
│  Config:                                                               │
│    - Timeout: 30s                                                      │
│    - Retries: 3 attempts, 1s backoff                                  │
│    - Skipped if: Neo4j driver not available                           │
└────────────────────────────────┬────────────────────────────────────────┘
                                 │
                                 ▼
                     ┌───────────┴───────────┐
                     │                       │
                     ▼                       ▼
              ┌─────────────┐        ┌─────────────────────┐
              │  SUCCESS    │        │      FAILURE        │
              │             │        │                     │
              │ Neo4j       │        │ TRIGGER ROLLBACK    │
              │ Write OK    │        │                     │
              │             │        │ Compensate:         │
              │ All Steps   │        │ 1. Delete Neo4j     │
              │ Complete    │        │ 2. Delete Qdrant    │
              │             │        │ 3. Delete Postgres  │
              └──────┬──────┘        │                     │
                     │               │ Return Error        │
                     │               └─────────────────────┘
                     ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                      SAGA EXECUTION COMPLETE                            │
│                                                                         │
│  Result: {                                                             │
│    success: true,                                                      │
│    context: {                                                          │
│      sagaId,                                                           │
│      startTime,                                                        │
│      completedSteps: [                                                 │
│        { name: 'generate-embedding', result: {...}, duration: 234ms }, │
│        { name: 'store-postgres', result: {...}, duration: 45ms },     │
│        { name: 'store-qdrant', result: {...}, duration: 67ms },       │
│        { name: 'store-neo4j', result: {...}, duration: 42ms }         │
│      ],                                                                │
│      totalDuration: 388ms                                              │
│    }                                                                   │
│  }                                                                     │
│                                                                         │
│  Memory stored atomically across:                                      │
│    ✓ PostgreSQL (unified_content table)                               │
│    ✓ Qdrant (unified_content collection)                              │
│    ✓ Neo4j (Memory node with relationships)                           │
└─────────────────────────────────────────────────────────────────────────┘


═══════════════════════════════════════════════════════════════════════════
                            ROLLBACK SCENARIO
═══════════════════════════════════════════════════════════════════════════

┌─────────────────────────────────────────────────────────────────────────┐
│               FAILURE DETECTED AT STEP 3 (QDRANT)                       │
│                                                                         │
│  Error: Connection timeout to Qdrant service                          │
└────────────────────────────────┬────────────────────────────────────────┘
                                 │
                                 ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                    AUTOMATIC ROLLBACK TRIGGERED                         │
│                                                                         │
│  Saga Coordinator:                                                     │
│    ✓ Capture error context                                            │
│    ✓ Record failed step: 'store-qdrant'                               │
│    ✓ Begin rollback in REVERSE order                                  │
│    ✓ Executed steps: [generate-embedding, store-postgres]             │
└────────────────────────────────┬────────────────────────────────────────┘
                                 │
                                 ▼
┌─────────────────────────────────────────────────────────────────────────┐
│            ROLLBACK STEP 2: COMPENSATE STORE-POSTGRES                   │
│                                                                         │
│  RollbackHandlers.rollbackPostgres(memoryId, tenantContext)           │
│                                                                         │
│  SQL: DELETE FROM unified_content WHERE id = $1                        │
│                                                                         │
│  Result:                                                               │
│    ✓ 1 row deleted                                                     │
│    ✓ PostgreSQL state clean                                           │
│    ✓ Duration: 34ms                                                   │
└────────────────────────────────┬────────────────────────────────────────┘
                                 │
                                 ▼
┌─────────────────────────────────────────────────────────────────────────┐
│          ROLLBACK STEP 1: COMPENSATE GENERATE-EMBEDDING                 │
│                                                                         │
│  No-op: Embedding generation has no side effects                       │
│                                                                         │
│  Result:                                                               │
│    ✓ No action needed                                                 │
│    ✓ Duration: 0ms                                                    │
└────────────────────────────────┬────────────────────────────────────────┘
                                 │
                                 ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                    ROLLBACK COMPLETE - CLEAN STATE                      │
│                                                                         │
│  Result: {                                                             │
│    success: false,                                                     │
│    error: Error('Qdrant storage failed: Connection timeout'),          │
│    context: {                                                          │
│      sagaId,                                                           │
│      startTime,                                                        │
│      completedSteps: [                                                 │
│        { name: 'generate-embedding', ... },                            │
│        { name: 'store-postgres', ... }                                │
│      ],                                                                │
│      failedStep: {                                                     │
│        name: 'store-qdrant',                                           │
│        error: Error('Connection timeout'),                             │
│        duration: 30000 // timeout                                      │
│      },                                                                │
│      rollbackResults: [                                                │
│        { name: 'store-postgres', success: true, duration: 34ms },     │
│        { name: 'generate-embedding', success: true, duration: 0ms }   │
│      ],                                                                │
│      totalDuration: 30134ms                                            │
│    }                                                                   │
│  }                                                                     │
│                                                                         │
│  Final State:                                                          │
│    ✓ PostgreSQL: Memory NOT present (rolled back)                     │
│    ✓ Qdrant: Memory NOT present (never created)                       │
│    ✓ Neo4j: Memory NOT present (never attempted)                      │
│    ✓ Database state: CONSISTENT                                        │
│    ✓ User receives error with full context                            │
│    ✓ Retry is safe (idempotent operations)                            │
└─────────────────────────────────────────────────────────────────────────┘


═══════════════════════════════════════════════════════════════════════════
                          KEY GUARANTEES
═══════════════════════════════════════════════════════════════════════════

✅ ATOMICITY
   - All databases succeed OR all rollback
   - No partial writes possible

✅ IDEMPOTENCY
   - Every operation safe to retry
   - Same request produces same result
   - ON CONFLICT handling in PostgreSQL
   - Upsert operations in Qdrant
   - MERGE operations in Neo4j

✅ CONSISTENCY
   - Database state always consistent
   - Rollback ensures clean state
   - Verification available post-rollback

✅ DURABILITY
   - Wait for confirmations before continuing
   - PostgreSQL: Wait for commit
   - Qdrant: wait=true flag
   - Neo4j: Session guarantees

✅ ISOLATION
   - Tenant context enforced
   - Row Level Security in PostgreSQL
   - Filtered queries in Qdrant/Neo4j
   - No cross-tenant data leakage

✅ OBSERVABILITY
   - Complete audit trail
   - Detailed logging at each step
   - Context available for debugging
   - Metrics for monitoring

✅ RESILIENCE
   - Timeout protection (no hangs)
   - Automatic retry with backoff
   - Best-effort rollback
   - Graceful degradation
```
