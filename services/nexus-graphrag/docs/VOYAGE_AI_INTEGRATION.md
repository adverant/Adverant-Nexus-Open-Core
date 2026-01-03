# VoyageAI Integration Guide - GraphRAG Service

This document explains how GraphRAG integrates with VoyageAI for embedding generation, using the shared `@nexus/voyage-ai-client` package.

## Architecture Overview

```
┌─────────────────────────────────────────────────────┐
│              GraphRAG Application                    │
│  (Document Storage, Retrieval, Knowledge Graph)      │
└──────────────────────┬──────────────────────────────┘
                       │
┌──────────────────────▼──────────────────────────────┐
│     GraphRAGEmbeddingAdapter                         │
│  (Service-specific adapter layer)                    │
│  - Auto content-type detection                       │
│  - Multimodal support                                │
│  - No caching (relies on Qdrant)                     │
│  - GraphRAG-optimized logging                        │
└──────────────────────┬──────────────────────────────┘
                       │
┌──────────────────────▼──────────────────────────────┐
│     VoyageAIUnifiedClient                            │
│  (Shared client from @nexus/voyage-ai-client)│
│  - Dynamic model discovery                           │
│  - Circuit breaker protection                        │
│  - Automatic endpoint routing                        │
│  - Batch processing                                  │
│  - Reranking support                                 │
└──────────────────────────────────────────────────────┘
```

## Quick Start

### Basic Usage

```typescript
import { GraphRAGEmbeddingAdapter } from './clients/GraphRAGEmbeddingAdapter';

// Initialize adapter (typically done once at startup)
const embedAdapter = new GraphRAGEmbeddingAdapter(process.env.VOYAGE_API_KEY!);

// Embed a document
const result = await embedAdapter.embedContent('Your document text here');

console.log(result.embedding);  // [0.123, 0.456, ...]
console.log(result.model);      // 'voyage-3'
console.log(result.dimensions); // 1024
```

### Configuration

The adapter is initialized in [src/index.ts:54](../src/index.ts#L54):

```typescript
// Initialize VoyageAI embedding adapter
const embedAdapter = new GraphRAGEmbeddingAdapter(voyageApiKey);
logger.info('VoyageAI embedding adapter initialized');

// Test connection on startup
try {
  const connectionTests = await embedAdapter.testConnection();
  const allPassed = connectionTests.every(test => test.success);

  if (allPassed) {
    logger.info('VoyageAI connection test passed');
  } else {
    logger.warn('Some VoyageAI models failed connection test', {
      tests: connectionTests
    });
  }
} catch (error) {
  logger.error('VoyageAI connection test failed', { error });
}
```

### Environment Variables

```bash
# Required
VOYAGE_API_KEY=your_voyage_api_key_here

# Get your API key from: https://voyageai.com
```

## GraphRAGEmbeddingAdapter API

### Primary Methods

#### `embedContent(content, options?)`

Embed content with automatic content type detection. This is the **primary method** for GraphRAG document embedding.

```typescript
interface GraphRAGEmbeddingOptions {
  contentType?: 'text' | 'code' | 'finance' | 'law' | 'multimodal' | 'general';
  inputType?: 'document' | 'query';
  truncate?: boolean;
  multimodal?: boolean;
}

async embedContent(
  content: string,
  options?: GraphRAGEmbeddingOptions
): Promise<EmbeddingResult>
```

**Example:**
```typescript
// Auto-detection (recommended)
const result = await embedAdapter.embedContent(documentText);

// Manual override
const codeResult = await embedAdapter.embedContent(codeSnippet, {
  contentType: 'code',
  truncate: true  // Auto-truncate if too long
});

// Multimodal content
const multiResult = await embedAdapter.embedContent(content, {
  multimodal: true
});
```

**Auto Content-Type Detection:**
- **Code**: Detects function keywords, class definitions, imports
- **Markdown**: Detects markdown syntax (headers, lists, links)
- **Text**: Natural language content
- **General**: Fallback for mixed content

#### `embedBatch(contents, options?)`

Embed multiple documents efficiently in a single API call. **3-5x faster** than sequential `embedContent()` calls.

```typescript
async embedBatch(
  contents: string[],
  options?: GraphRAGEmbeddingOptions
): Promise<EmbeddingResult[]>
```

**Example:**
```typescript
const documents = [
  'First document about AI',
  'Second document about ML',
  'Third document about DL'
];

const results = await embedAdapter.embedBatch(documents);

results.forEach((result, index) => {
  console.log(`Doc ${index}: ${result.dimensions}D from ${result.model}`);
});
```

**Performance:**
- Batch size: Up to 128 documents recommended
- Latency: ~200ms per batch vs ~150ms per single request
- Use batch for: Bulk document ingestion, reindexing

#### `embedQuery(query, options?)`

Embed a search query using the optimal 'query' input type.

```typescript
async embedQuery(
  query: string,
  options?: Omit<GraphRAGEmbeddingOptions, 'inputType'>
): Promise<EmbeddingResult>
```

**Example:**
```typescript
// For search/retrieval operations
const queryEmbedding = await embedAdapter.embedQuery(
  'What is machine learning?'
);

// Search Qdrant with query embedding
const searchResults = await qdrantClient.search(
  'documents',
  queryEmbedding.embedding,
  { limit: 10 }
);
```

**Important:** Always use `embedQuery()` for search queries and `embedContent()` for documents. Using the wrong input type significantly degrades performance.

#### `rerank(query, documents, topK?)`

Rerank search results by relevance using VoyageAI's reranking model.

```typescript
async rerank(
  query: string,
  documents: string[],
  topK?: number
): Promise<RerankResult[]>
```

**Example:**
```typescript
// 1. Initial vector search (broad recall)
const queryEmbedding = await embedAdapter.embedQuery(userQuery);
const candidates = await qdrantClient.search(
  'documents',
  queryEmbedding.embedding,
  { limit: 50 }  // Get 50 candidates
);

// 2. Rerank for precision
const reranked = await embedAdapter.rerank(
  userQuery,
  candidates.map(c => c.payload.content),
  10  // Return top 10
);

// 3. Use reranked results
reranked.forEach((result, rank) => {
  console.log(`#${rank + 1} (score ${result.score}): ${result.document}`);
});
```

**When to use reranking:**
- ✅ After vector similarity search
- ✅ When precision is critical
- ✅ For user-facing search results
- ❌ NOT for initial filtering (too expensive)

### Utility Methods

#### `getAvailableModels()`

Get list of all available VoyageAI models.

```typescript
const models = await embedAdapter.getAvailableModels();
models.forEach(model => {
  console.log(`${model.displayName}: ${model.dimensions}D`);
});
```

#### `testConnection()`

Test connection to VoyageAI and verify API key.

```typescript
const tests = await embedAdapter.testConnection();
tests.forEach(test => {
  console.log(`${test.model}: ${test.success ? 'OK' : 'FAILED'} (${test.latency}ms)`);
});
```

#### `getStatus()`

Get adapter status including model cache information.

```typescript
const status = embedAdapter.getStatus();
console.log(`Models cached: ${status.modelDiscovery.cached}`);
console.log(`Model count: ${status.modelDiscovery.modelCount}`);
```

### Legacy API Compatibility

For backward compatibility with old code:

```typescript
// Old API (still supported)
await embedAdapter.generateEmbedding(text, {
  inputType: 'document',
  contentType: 'text'
});

// New API (recommended)
await embedAdapter.embedContent(text);
```

## Integration Points

### 1. Document Storage

When storing documents in GraphRAG:

```typescript
import { EntityManager } from './graphrag/entity-manager';

async function storeDocument(content: string, metadata: any) {
  // 1. Generate embedding
  const embedding = await embedAdapter.embedContent(content);

  // 2. Store in Qdrant
  await qdrantClient.upsert('documents', {
    points: [{
      id: uuid(),
      vector: embedding.embedding,
      payload: {
        content,
        metadata,
        model: embedding.model,
        dimensions: embedding.dimensions
      }
    }]
  });

  // 3. Store entity in Neo4j
  await entityManager.create({
    domain: 'documents',
    entityType: 'document',
    textContent: content,
    metadata
  });
}
```

### 2. Semantic Search

When performing semantic search:

```typescript
async function semanticSearch(query: string, limit: number = 10) {
  // 1. Embed query
  const queryEmbedding = await embedAdapter.embedQuery(query);

  // 2. Vector search (broad recall)
  const candidates = await qdrantClient.search(
    'documents',
    queryEmbedding.embedding,
    { limit: limit * 5 }  // Get 5x more for reranking
  );

  // 3. Rerank for precision
  const reranked = await embedAdapter.rerank(
    query,
    candidates.map(c => c.payload.content),
    limit
  );

  // 4. Return top results
  return reranked.map((r, index) => ({
    rank: index + 1,
    score: r.score,
    document: r.document,
    originalIndex: r.index
  }));
}
```

### 3. Bulk Ingestion

When ingesting many documents:

```typescript
async function bulkIngest(documents: Array<{ content: string, metadata: any }>) {
  const BATCH_SIZE = 100;

  for (let i = 0; i < documents.length; i += BATCH_SIZE) {
    const batch = documents.slice(i, i + BATCH_SIZE);

    // 1. Batch embed
    const embeddings = await embedAdapter.embedBatch(
      batch.map(d => d.content)
    );

    // 2. Batch upsert to Qdrant
    await qdrantClient.upsert('documents', {
      points: embeddings.map((emb, idx) => ({
        id: uuid(),
        vector: emb.embedding,
        payload: {
          content: batch[idx].content,
          metadata: batch[idx].metadata,
          model: emb.model
        }
      }))
    });

    logger.info(`Ingested batch ${i / BATCH_SIZE + 1}`, {
      count: batch.length,
      total: documents.length
    });
  }
}
```

## Circuit Breaker Protection

The adapter includes circuit breaker protection through the shared client:

### What It Does

- **Prevents cascading failures** when VoyageAI is experiencing issues
- **Automatically opens** after 5 consecutive failures
- **Automatically recovers** by testing after 60-second timeout
- **Fails fast** when circuit is open (no wasted requests)

### Circuit States

| State | Behavior | Next State |
|-------|----------|------------|
| CLOSED | All requests pass through | OPEN (after 5 failures) |
| OPEN | Requests rejected immediately | HALF_OPEN (after timeout) |
| HALF_OPEN | Test requests allowed | CLOSED (2 successes) or OPEN (failure) |

### Handling Circuit Breaker Errors

```typescript
import { CircuitBreakerOpenError } from '../../../../packages/voyage-ai-client/dist';

try {
  const result = await embedAdapter.embedContent(text);
} catch (error) {
  if (error instanceof CircuitBreakerOpenError) {
    logger.error('VoyageAI circuit breaker open', {
      service: error.serviceName,
      nextAttempt: error.nextAttemptTime
    });

    // Fallback strategies:
    // 1. Return cached embedding if available
    // 2. Queue for later processing
    // 3. Use alternative embedding service
    // 4. Return error to client with retry-after
  } else {
    logger.error('Embedding failed', { error });
    throw error;
  }
}
```

### Monitoring Circuit State

```typescript
// Access circuit breaker from shared utils
import { voyageCircuitBreaker } from '../utils/circuit-breaker';

// Get current state
const state = voyageCircuitBreaker.getState();
console.log(`Circuit state: ${state}`); // CLOSED | OPEN | HALF_OPEN

// Get detailed metrics
const metrics = voyageCircuitBreaker.getMetrics();
console.log('Circuit metrics:', {
  state: metrics.state,
  failureCount: metrics.failureCount,
  nextAttempt: metrics.nextAttempt,
  lastError: metrics.lastError
});
```

## Error Handling

### Common Errors

#### 1. Invalid API Key (401)

```typescript
try {
  await embedAdapter.embedContent(text);
} catch (error) {
  if (error.response?.status === 401) {
    logger.error('Invalid VoyageAI API key - check VOYAGE_API_KEY env var');
    // Action: Alert admin, rotate keys
  }
}
```

#### 2. Rate Limiting (429)

```typescript
try {
  await embedAdapter.embedContent(text);
} catch (error) {
  if (error.response?.status === 429) {
    const retryAfter = error.response.headers['retry-after'];
    logger.warn(`Rate limited, retry after ${retryAfter}s`);
    // Action: Implement backoff, queue request
  }
}
```

#### 3. Content Too Long (400)

```typescript
try {
  // Enable auto-truncation
  await embedAdapter.embedContent(veryLongText, {
    truncate: true  // Automatically truncate to model's token limit
  });
} catch (error) {
  if (error.response?.status === 400) {
    logger.error('Content validation failed', {
      error: error.response.data
    });
  }
}
```

#### 4. Circuit Breaker Open

```typescript
import { CircuitBreakerOpenError } from '../../../../packages/voyage-ai-client/dist';

try {
  await embedAdapter.embedContent(text);
} catch (error) {
  if (error instanceof CircuitBreakerOpenError) {
    // Circuit is open, service temporarily unavailable
    logger.warn('VoyageAI service unavailable', {
      nextAttempt: error.nextAttemptTime
    });

    // Return cached result or queue for later
    return getCachedEmbedding(text);
  }
}
```

## Best Practices

### 1. Use Auto Content-Type Detection

```typescript
// ✅ Good: Let adapter detect content type
const result = await embedAdapter.embedContent(content);

// ❌ Avoid: Hardcoding content type
const result = await embedAdapter.embedContent(content, {
  contentType: 'text'  // May not be optimal
});
```

### 2. Use Correct Input Types

```typescript
// ✅ Correct: Documents for storage
await embedAdapter.embedContent(document, {
  inputType: 'document'
});

// ✅ Correct: Queries for search
await embedAdapter.embedQuery(searchQuery);

// ❌ Wrong: Query type for documents
await embedAdapter.embedContent(document, {
  inputType: 'query'  // Will produce suboptimal embeddings!
});
```

### 3. Batch for Bulk Operations

```typescript
// ✅ Efficient: Single batch API call
const results = await embedAdapter.embedBatch(documents);

// ❌ Inefficient: Multiple sequential calls
for (const doc of documents) {
  await embedAdapter.embedContent(doc);  // 100x slower!
}
```

### 4. Always Rerank User-Facing Results

```typescript
// ✅ Good: Vector search + reranking
const candidates = await vectorSearch(query, 50);
const final = await embedAdapter.rerank(query, candidates, 10);

// ❌ Suboptimal: Vector search only
const results = await vectorSearch(query, 10);
```

### 5. Handle Circuit Breaker Gracefully

```typescript
// ✅ Good: Fallback strategy
try {
  return await embedAdapter.embedContent(text);
} catch (error) {
  if (error instanceof CircuitBreakerOpenError) {
    return await getCachedEmbedding(text);
  }
  throw error;
}

// ❌ Bad: Ignore circuit breaker
try {
  return await embedAdapter.embedContent(text);
} catch (error) {
  return null;  // Silent failure!
}
```

## Performance Optimization

### Caching Strategy

GraphRAG **does not cache embeddings** at the adapter level. Instead:

- **Qdrant** serves as the persistent vector cache
- **Neo4j** stores entity relationships
- Embeddings are regenerated only when content changes

### Batch Sizing

Optimal batch sizes for different operations:

| Operation | Recommended Batch Size | Reason |
|-----------|----------------------|---------|
| Bulk ingestion | 100-128 | Balances throughput and memory |
| Real-time updates | 1-10 | Minimize latency |
| Reindexing | 128 | Maximize throughput |

### Model Selection

Let the adapter choose models automatically:

```typescript
// Adapter automatically selects:
// - voyage-code-3 for code
// - voyage-3 for text
// - voyage-finance-2 for finance
// - voyage-law-2 for legal
// - voyage-multimodal-3 for multimodal
```

## Monitoring and Debugging

### Logging

The adapter uses Winston logger configured in [src/utils/logger.ts](../src/utils/logger.ts).

**Log Levels:**
- `info`: Successful operations, state changes
- `warn`: Recoverable errors, circuit breaker events
- `error`: Fatal errors, API failures
- `debug`: Detailed operation metrics (enable for debugging)

### Key Metrics

Monitor these metrics for health:

```typescript
// Embedding latency
logger.debug('Content embedded successfully', {
  model: result.model,
  dimensions: result.dimensions,
  latency  // Time in milliseconds
});

// Batch efficiency
logger.info('Batch embedding completed', {
  batchSize: contents.length,
  latency
});

// Circuit breaker state
logger.info(`Circuit breaker '${name}' state transition`, {
  from: oldState,
  to: newState
});
```

### Health Check

Add to GraphRAG health endpoint:

```typescript
// GET /health
app.get('/health', async (req, res) => {
  try {
    // Test VoyageAI connection
    const voyageTests = await embedAdapter.testConnection();
    const voyageHealthy = voyageTests.every(t => t.success);

    // Check circuit breaker
    const circuitState = voyageCircuitBreaker.getState();

    res.json({
      status: voyageHealthy && circuitState === 'CLOSED' ? 'healthy' : 'degraded',
      voyage: {
        healthy: voyageHealthy,
        circuitState,
        tests: voyageTests
      }
    });
  } catch (error) {
    res.status(503).json({
      status: 'unhealthy',
      error: error.message
    });
  }
});
```

## Migration Guide

### From Old VoyageAIClient

If migrating from the old client:

```typescript
// OLD: services/graphrag/src/clients/VoyageAIClient.ts
import { VoyageAIClient } from './clients/VoyageAIClient';
const client = new VoyageAIClient(apiKey);
await client.generateEmbedding(text, { inputType: 'document' });

// NEW: services/graphrag/src/clients/GraphRAGEmbeddingAdapter.ts
import { GraphRAGEmbeddingAdapter } from './clients/GraphRAGEmbeddingAdapter';
const adapter = new GraphRAGEmbeddingAdapter(apiKey);
await adapter.embedContent(text);  // Simpler API!
```

**Benefits:**
- ✅ Automatic content type detection
- ✅ Shared circuit breaker across services
- ✅ Dynamic model discovery
- ✅ Better error handling
- ✅ Simplified API

## Troubleshooting

### Issue: "Circuit breaker is OPEN"

**Cause:** VoyageAI service is experiencing issues or 5 consecutive requests failed.

**Solution:**
1. Check VoyageAI status: https://status.voyageai.com
2. Verify API key is valid
3. Check network connectivity
4. Review recent error logs
5. Wait for automatic recovery (60 seconds)

### Issue: "Invalid API key"

**Cause:** `VOYAGE_API_KEY` environment variable is missing or incorrect.

**Solution:**
```bash
# Verify environment variable
echo $VOYAGE_API_KEY

# Get new API key from
# https://voyageai.com/dashboard
```

### Issue: Slow embedding performance

**Possible causes:**
1. Not using batch API for multiple documents
2. Circuit breaker in HALF_OPEN state (testing recovery)
3. Network latency to VoyageAI

**Solution:**
```typescript
// Use batch API
const results = await embedAdapter.embedBatch(documents);

// Check circuit state
const state = voyageCircuitBreaker.getState();
```

### Issue: Content validation errors

**Cause:** Content exceeds model token limit or contains invalid characters.

**Solution:**
```typescript
// Enable auto-truncation
await embedAdapter.embedContent(longText, {
  truncate: true
});

// Or manually truncate before embedding
const truncated = longText.substring(0, 30000);
await embedAdapter.embedContent(truncated);
```

## References

- [Shared VoyageAI Client README](../../../../packages/voyage-ai-client/README.md)
- [GraphRAGEmbeddingAdapter Source](../src/clients/GraphRAGEmbeddingAdapter.ts)
- [Circuit Breaker Implementation](../src/utils/circuit-breaker.ts)
- [VoyageAI API Documentation](https://docs.voyageai.com)
- [VoyageAI Dashboard](https://voyageai.com/dashboard)

## Support

For issues or questions:
1. Check circuit breaker state
2. Review error logs
3. Test connection: `await embedAdapter.testConnection()`
4. Verify API key validity
5. Check VoyageAI service status

## License

MIT
