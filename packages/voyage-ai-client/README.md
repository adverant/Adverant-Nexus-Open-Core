# @nexus/voyage-ai-client

**Shared VoyageAI embedding client for the Unified Nexus platform**

This package provides a production-ready VoyageAI client with advanced features like dynamic model discovery, circuit breaker protection, multimodal support, and intelligent content type detection.

## Features

✅ **Dynamic Model Discovery** - Automatically discovers and uses the latest VoyageAI models
✅ **Circuit Breaker Protection** - Prevents cascading failures with automatic recovery
✅ **Multimodal Support** - Handles text, code, images, and other content types
✅ **Content Type Detection** - Automatically selects optimal models for your content
✅ **Automatic Endpoint Routing** - Routes to `/embeddings` or `/multimodalembeddings` as needed
✅ **Comprehensive Validation** - Validates all embeddings and API responses
✅ **Batch Operations** - Efficient batch embedding generation
✅ **Advanced Reranking** - Latest `rerank-2.5` model with automatic discovery and fallback support
✅ **TypeScript First** - Full type safety with comprehensive type definitions

## Installation

```bash
npm install @nexus/voyage-ai-client
```

Or add to `package.json`:

```json
{
  "dependencies": {
    "@nexus/voyage-ai-client": "workspace:*"
  }
}
```

## Basic Usage

```typescript
import { VoyageAIUnifiedClient } from '@nexus/voyage-ai-client';

const client = new VoyageAIUnifiedClient(process.env.VOYAGE_API_KEY);

// Generate embedding with automatic model selection
const result = await client.generateEmbedding('Hello, world!', {
  inputType: 'document',
  contentType: 'text'
});

console.log(result.embedding); // [0.123, 0.456, ...]
console.log(result.model);     // 'voyage-3'
console.log(result.dimensions); // 1024
```

## Advanced Usage

### Auto Content Type Detection

```typescript
const codeContent = `
  function hello() {
    console.log('Hello, world!');
  }
`;

// Auto-detects as 'code'
const contentType = client.detectContentType(codeContent);

const result = await client.generateEmbedding(codeContent, {
  inputType: 'document',
  contentType // 'code'
});
```

### Batch Operations

```typescript
const texts = [
  'Document 1',
  'Document 2',
  'Document 3'
];

const results = await client.generateEmbeddings(texts, {
  inputType: 'document',
  contentType: 'text'
});

// Returns array of EmbeddingResult[]
```

### Reranking

```typescript
const query = 'What is machine learning?';
const documents = [
  'Machine learning is a subset of AI...',
  'Deep learning uses neural networks...',
  'Python is a programming language...'
];

const reranked = await client.rerank(query, documents, 5);

// Returns documents sorted by relevance
reranked.forEach(result => {
  console.log(`Score: ${result.score}, Doc: ${result.document}`);
});
```

### Circuit Breaker Configuration

```typescript
import { createVoyageCircuitBreaker } from '@nexus/voyage-ai-client';

const customCircuitBreaker = createVoyageCircuitBreaker({
  failureThreshold: 3,  // Open after 3 failures
  successThreshold: 2,  // Close after 2 successes
  timeout: 30000        // 30 seconds
});

const client = new VoyageAIUnifiedClient(
  process.env.VOYAGE_API_KEY,
  customCircuitBreaker
);
```

### Custom Logger

```typescript
import { configureLogger } from '@nexus/voyage-ai-client';
import winston from 'winston';

const customLogger = winston.createLogger({
  level: 'debug',
  // ... your winston config
});

configureLogger(customLogger);
```

## Service-Specific Adapters

This shared client is designed to be wrapped by service-specific adapters:

### GraphRAG Adapter Example

```typescript
import { VoyageAIUnifiedClient } from '@nexus/voyage-ai-client';

export class GraphRAGEmbeddingAdapter {
  private client: VoyageAIUnifiedClient;

  constructor(apiKey: string) {
    this.client = new VoyageAIUnifiedClient(apiKey);
  }

  async embedContent(content: string, options?: { multimodal?: boolean }) {
    // Auto-detect content type
    const contentType = this.client.detectContentType(content);

    return this.client.generateEmbedding(content, {
      inputType: 'document',
      contentType
    });
  }
}
```

### LearningAgent Adapter Example (with caching)

```typescript
import { VoyageAIUnifiedClient, EmbeddingResult } from '@nexus/voyage-ai-client';

export class LearningAgentEmbeddingAdapter {
  private client: VoyageAIUnifiedClient;
  private cache: Map<string, CacheEntry>;

  constructor(apiKey: string) {
    this.client = new VoyageAIUnifiedClient(apiKey);
    this.cache = new Map();
  }

  async generateSchemaEmbedding(schemaText: string): Promise<EmbeddingResult> {
    // Check cache
    const cached = this.cache.get(schemaText);
    if (cached && !this.isExpired(cached)) {
      return cached.result;
    }

    // Generate embedding
    const result = await this.client.generateEmbedding(schemaText, {
      inputType: 'document',
      contentType: 'text'
    });

    // Cache result
    this.cache.set(schemaText, {
      result,
      timestamp: Date.now()
    });

    return result;
  }

  async generateQueryEmbedding(query: string): Promise<EmbeddingResult> {
    const cached = this.cache.get(query);
    if (cached && !this.isExpired(cached)) {
      return cached.result;
    }

    const result = await this.client.generateEmbedding(query, {
      inputType: 'query', // Important: query not document
      contentType: 'text'
    });

    this.cache.set(query, {
      result,
      timestamp: Date.now()
    });

    return result;
  }

  private isExpired(entry: CacheEntry): boolean {
    const ONE_HOUR = 3600000;
    return Date.now() - entry.timestamp > ONE_HOUR;
  }
}
```

## API Reference

### VoyageAIUnifiedClient

#### Constructor

```typescript
constructor(apiKey: string, circuitBreaker?: CircuitBreaker)
```

Creates a new VoyageAI client instance.

**Parameters:**
- `apiKey` (string, required): Your VoyageAI API key from https://voyageai.com
- `circuitBreaker` (CircuitBreaker, optional): Custom circuit breaker instance

**Throws:**
- `Error` if API key is not provided or empty

**Example:**
```typescript
const client = new VoyageAIUnifiedClient(process.env.VOYAGE_API_KEY);
```

#### Methods

##### `generateEmbedding()`

```typescript
async generateEmbedding(
  text: string,
  options: EmbeddingOptions
): Promise<EmbeddingResult>
```

Generate embedding vector for a single text input.

**Parameters:**
- `text` (string): Text to embed (max length depends on model, typically 4096-32000 tokens)
- `options` (EmbeddingOptions):
  - `inputType`: 'document' (for storage) | 'query' (for search) **[required]**
  - `contentType`: 'text' | 'code' | 'finance' | 'law' | 'multimodal' | 'general' [optional]
  - `truncate`: boolean - Auto-truncate if exceeds token limit [optional, default: false]

**Returns:** `Promise<EmbeddingResult>`
- `embedding` (number[]): Dense vector representation
- `model` (string): Model used (e.g., 'voyage-3')
- `dimensions` (number): Vector dimensions (e.g., 1024)
- `endpoint` (string): API endpoint used ('/embeddings' or '/multimodalembeddings')

**Throws:**
- `CircuitBreakerOpenError` if VoyageAI service is temporarily unavailable
- `AxiosError` for API errors (401 auth, 429 rate limit, etc.)
- `Error` for validation failures

**Example:**
```typescript
const result = await client.generateEmbedding('function add(a, b) { return a + b; }', {
  inputType: 'document',
  contentType: 'code'
});

console.log(result.embedding.length); // 1024
console.log(result.model);            // 'voyage-code-3'
```

##### `generateEmbeddings()`

```typescript
async generateEmbeddings(
  texts: string[],
  options: EmbeddingOptions
): Promise<EmbeddingResult[]>
```

Generate embeddings for multiple texts in a single API call. More efficient than calling `generateEmbedding()` multiple times.

**Parameters:**
- `texts` (string[]): Array of texts to embed
- `options` (EmbeddingOptions): Same as `generateEmbedding()`

**Returns:** `Promise<EmbeddingResult[]>` - Array of embedding results

**Performance:** Batching is 3-5x faster than sequential requests.

**Example:**
```typescript
const texts = [
  'First document about machine learning',
  'Second document about deep learning',
  'Third document about neural networks'
];

const results = await client.generateEmbeddings(texts, {
  inputType: 'document',
  contentType: 'text'
});

results.forEach((r, i) => {
  console.log(`Doc ${i}: ${r.dimensions}D vector from ${r.model}`);
});
```

##### `rerank()`

```typescript
async rerank(
  query: string,
  documents: string[],
  topK?: number
): Promise<RerankResult[]>
```

Rerank documents by relevance to a query using VoyageAI's latest reranking model (`rerank-2.5`). The client automatically discovers and selects the most accurate rerank model available.

**When to use:** After initial vector similarity search to improve relevance and ranking accuracy.

**Parameters:**
- `query` (string): Search query
- `documents` (string[]): Documents to rerank (up to 1000)
- `topK` (number, optional): Number of top results to return (default: all documents)

**Returns:** `Promise<RerankResult[]>` - Sorted by relevance score (descending)
- `index` (number): Original position in input array
- `score` (number): Relevance score (0-1, higher = more relevant)
- `document` (string): Original document text

**Example:**
```typescript
// 1. Get initial candidates from vector search
const candidates = await vectorDB.search(queryEmbedding, { limit: 50 });

// 2. Rerank for improved relevance
const reranked = await client.rerank(
  'What is machine learning?',
  candidates.map(c => c.content),
  10 // Top 10 only
);

// 3. Use top results
reranked.forEach(result => {
  console.log(`Score: ${result.score.toFixed(3)}, Doc: ${result.document}`);
});
```

##### `detectContentType()`

```typescript
detectContentType(content: string): 'text' | 'code' | 'markdown' | 'general'
```

Automatically detect content type based on patterns and syntax.

**Detection Rules:**
- `code`: Contains function keywords, class definitions, import statements
- `markdown`: Contains markdown syntax (##, *, -, links)
- `text`: Natural language text
- `general`: Fallback for mixed or unknown content

**Parameters:**
- `content` (string): Content to analyze

**Returns:** 'text' | 'code' | 'markdown' | 'general'

**Example:**
```typescript
const codeType = client.detectContentType('function hello() {}');
// Returns: 'code'

const textType = client.detectContentType('This is a natural language sentence.');
// Returns: 'text'

const mdType = client.detectContentType('# Heading\n\nParagraph with **bold**.');
// Returns: 'markdown'
```

##### `getAvailableModels()`

```typescript
async getAvailableModels(): Promise<VoyageModelInfo[]>
```

Get all available VoyageAI models with their capabilities. Results are cached for performance.

**Returns:** `Promise<VoyageModelInfo[]>`

**Example:**
```typescript
const models = await client.getAvailableModels();

models.forEach(model => {
  console.log(`${model.displayName}: ${model.dimensions}D, specialization: ${model.specialization}`);
});
```

##### `getBestModelForContentType()`

```typescript
async getBestModelForContentType(
  contentType: 'text' | 'code' | 'finance' | 'law' | 'multimodal' | 'general'
): Promise<VoyageModelInfo>
```

Get the best available model for a specific content type.

**Parameters:**
- `contentType`: Type of content

**Returns:** `Promise<VoyageModelInfo>` - Optimal model for content type

**Example:**
```typescript
const codeModel = await client.getBestModelForContentType('code');
console.log(codeModel.displayName); // 'voyage-code-3'
```

##### `refreshModels()`

```typescript
async refreshModels(): Promise<void>
```

Force refresh of the model discovery cache. Useful after VoyageAI releases new models.

**Example:**
```typescript
await client.refreshModels();
console.log('Model cache refreshed');
```

##### `testConnection()`

```typescript
async testConnection(): Promise<{
  model: string;
  success: boolean;
  latency: number;
  error?: string;
}[]>
```

Test connection to VoyageAI and verify API key validity by sending test embeddings to each model.

**Returns:** Array of test results per model

**Example:**
```typescript
const tests = await client.testConnection();

tests.forEach(test => {
  if (test.success) {
    console.log(`✅ ${test.model}: OK (${test.latency}ms)`);
  } else {
    console.log(`❌ ${test.model}: FAILED - ${test.error}`);
  }
});
```

##### `getStatus()`

```typescript
getStatus(): {
  modelDiscovery: {
    cached: boolean;
    modelCount: number;
    lastRefreshed: Date | null;
  };
}
```

Get client status including model discovery cache information.

**Returns:** Client status object

**Example:**
```typescript
const status = client.getStatus();
console.log(`Models cached: ${status.modelDiscovery.cached}`);
console.log(`Model count: ${status.modelDiscovery.modelCount}`);
```

### Types

```typescript
interface EmbeddingOptions {
  inputType: 'document' | 'query';
  contentType?: 'text' | 'code' | 'finance' | 'law' | 'multimodal' | 'general';
  truncate?: boolean;
}

interface EmbeddingResult {
  embedding: number[];
  model: string;
  dimensions: number;
  endpoint: string;
}

interface RerankResult {
  index: number;
  score: number;
  document?: string;
}

interface VoyageModelInfo {
  id: string;
  displayName: string;
  endpoint: string;
  dimensions: number;
  specialization: 'general' | 'code' | 'finance' | 'law' | 'multimodal';
  discoveryMethod: 'api_probe' | 'dimension_test' | 'documentation' | 'known_fallback';
  verified: boolean;
  lastVerified?: number;
}
```

## Circuit Breaker Protection

The client includes built-in circuit breaker protection to prevent cascading failures when VoyageAI is experiencing issues.

### Circuit States

1. **CLOSED** (Normal Operation)
   - All requests pass through to VoyageAI
   - Failure counter tracks consecutive failures

2. **OPEN** (Service Unavailable)
   - Requests are rejected immediately with `CircuitBreakerOpenError`
   - No requests sent to VoyageAI (prevents overload)
   - Automatically transitions to HALF_OPEN after timeout

3. **HALF_OPEN** (Testing Recovery)
   - Limited requests allowed to test if service recovered
   - Success → transition to CLOSED
   - Failure → transition back to OPEN

### Default Configuration

```typescript
{
  name: 'VoyageAI',
  failureThreshold: 5,      // Open after 5 consecutive failures
  successThreshold: 2,      // Close after 2 successes in half-open
  timeout: 60000           // Wait 60 seconds before retrying
}
```

### Custom Circuit Breaker

```typescript
import { CircuitBreaker } from '@nexus/voyage-ai-client';

const customBreaker = new CircuitBreaker({
  name: 'CustomVoyage',
  failureThreshold: 3,      // More sensitive
  successThreshold: 2,
  timeout: 30000,          // Retry sooner
  onStateChange: (state, name) => {
    console.log(`Circuit ${name} changed to ${state}`);
    // Send alert, update dashboard, etc.
  }
});

const client = new VoyageAIUnifiedClient(apiKey, customBreaker);
```

### Monitoring Circuit Breaker

```typescript
// Get current metrics
const metrics = circuitBreaker.getMetrics();
console.log(`State: ${metrics.state}`);
console.log(`Failure count: ${metrics.failureCount}`);
console.log(`Next attempt: ${metrics.nextAttempt}`);
console.log(`Last error: ${metrics.lastError}`);

// Get current state
const state = circuitBreaker.getState(); // 'CLOSED' | 'OPEN' | 'HALF_OPEN'

// Manual reset (use with caution)
circuitBreaker.reset();
```

## Error Handling

The client provides comprehensive error handling with detailed error messages:

### Common Errors

#### 1. Circuit Breaker Open

```typescript
import { CircuitBreakerOpenError } from '@nexus/voyage-ai-client';

try {
  const result = await client.generateEmbedding(text, options);
} catch (error) {
  if (error instanceof CircuitBreakerOpenError) {
    console.error('VoyageAI service temporarily unavailable');
    console.error(`Service: ${error.serviceName}`);
    console.error(`Retry at: ${error.nextAttemptTime.toISOString()}`);

    // Implement fallback strategy
    // - Use cached embeddings
    // - Queue for later processing
    // - Use alternative embedding service
  }
}
```

#### 2. Authentication Errors (401)

```typescript
try {
  const result = await client.generateEmbedding(text, options);
} catch (error) {
  if (error.response?.status === 401) {
    console.error('Invalid VoyageAI API key');
    console.error('Get your API key from https://voyageai.com');
    // Handle auth error: rotate keys, alert admin, etc.
  }
}
```

#### 3. Rate Limiting (429)

```typescript
try {
  const result = await client.generateEmbedding(text, options);
} catch (error) {
  if (error.response?.status === 429) {
    const retryAfter = error.response.headers['retry-after'];
    console.error(`Rate limit exceeded. Retry after ${retryAfter}s`);

    // Implement backoff strategy
    await new Promise(resolve => setTimeout(resolve, retryAfter * 1000));
    // Retry request
  }
}
```

#### 4. Validation Errors (400)

```typescript
try {
  const result = await client.generateEmbedding(text, options);
} catch (error) {
  if (error.response?.status === 400) {
    console.error('Invalid request:', error.response.data);
    // Common causes:
    // - Content exceeds token limit (use truncate: true)
    // - Invalid content type
    // - Malformed input
  }
}
```

### Complete Error Handling Example

```typescript
async function embedWithRetry(
  client: VoyageAIUnifiedClient,
  text: string,
  options: EmbeddingOptions,
  maxRetries = 3
): Promise<EmbeddingResult> {
  let lastError: Error;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await client.generateEmbedding(text, options);
    } catch (error: any) {
      lastError = error;

      // Don't retry circuit breaker errors
      if (error instanceof CircuitBreakerOpenError) {
        console.error(`Circuit open, will retry at ${error.nextAttemptTime}`);
        throw error;
      }

      // Don't retry auth errors
      if (error.response?.status === 401) {
        console.error('Authentication failed - check API key');
        throw error;
      }

      // Retry with exponential backoff for transient errors
      if (error.response?.status === 429 || error.response?.status >= 500) {
        const backoff = Math.pow(2, attempt) * 1000; // 2s, 4s, 8s
        console.warn(`Attempt ${attempt} failed, retrying in ${backoff}ms...`);
        await new Promise(resolve => setTimeout(resolve, backoff));
        continue;
      }

      // Don't retry validation errors
      throw error;
    }
  }

  throw new Error(`Failed after ${maxRetries} attempts: ${lastError.message}`);
}
```

### Error Types Reference

| Error | Status | Description | Retry? |
|-------|--------|-------------|--------|
| `CircuitBreakerOpenError` | N/A | Service temporarily unavailable | No (automatic) |
| Auth Error | 401 | Invalid API key | No |
| Rate Limit | 429 | Too many requests | Yes (with delay) |
| Validation Error | 400 | Invalid request | No |
| Server Error | 500-599 | VoyageAI server issue | Yes (with backoff) |
| Network Error | N/A | Connection timeout/failure | Yes (with backoff) |

## Best Practices

### 1. Always Use Correct `inputType`

```typescript
// ✅ Correct - storing documents
await client.generateEmbedding(document, { inputType: 'document' });

// ✅ Correct - searching
await client.generateEmbedding(searchQuery, { inputType: 'query' });

// ❌ Wrong - will produce suboptimal embeddings
await client.generateEmbedding(document, { inputType: 'query' });
```

### 2. Let Content Type Detection Work

```typescript
// ✅ Good - automatic detection
const contentType = client.detectContentType(content);

// ⚠️ Only specify manually if you're sure
const result = await client.generateEmbedding(content, {
  inputType: 'document',
  contentType: 'code' // Manual override
});
```

### 3. Use Batch Operations

```typescript
// ✅ Efficient - single API call
await client.generateEmbeddings([text1, text2, text3], options);

// ❌ Inefficient - three API calls
await client.generateEmbedding(text1, options);
await client.generateEmbedding(text2, options);
await client.generateEmbedding(text3, options);
```

## Architecture

This package follows the **Shared Core + Service Adapter** pattern:

```
┌─────────────────────────────────────────────────────────┐
│              Application Layer                           │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐ │
│  │  GraphRAG    │  │ LearningAgent │  │  MageAgent   │ │
│  │   Service    │  │   Service    │  │   Service    │ │
│  └──────┬───────┘  └──────┬───────┘  └──────┬───────┘ │
└─────────┼──────────────────┼──────────────────┼─────────┘
          │                  │                  │
          └──────────────────┴──────────────────┘
                             │
┌────────────────────────────▼──────────────────────────┐
│         Service-Specific Adapter Layer                 │
│  (GraphRAGAdapter, LearningAgentAdapter, etc.)         │
│  - Service-specific caching strategies                 │
│  - Domain-specific optimizations                       │
│  - Custom retry logic                                  │
└────────────────────────────▲──────────────────────────┘
                             │
┌────────────────────────────▼──────────────────────────┐
│    @nexus/voyage-ai-client (Shared Core)      │
│  - Dynamic model discovery                             │
│  - Circuit breaker protection                          │
│  - Automatic endpoint routing                          │
│  - Content type detection                              │
│  - Multimodal support                                  │
│  - Comprehensive validation                            │
└──────────────────────────────────────────────────────┘
```

## Contributing

When adding features to this shared client:

1. Ensure backward compatibility
2. Add comprehensive tests
3. Update TypeScript types
4. Document in README
5. Consider impact on all consuming services

## License

MIT

## Support

For issues or questions, see the [main repository](https://github.com/your-org/nexus).
