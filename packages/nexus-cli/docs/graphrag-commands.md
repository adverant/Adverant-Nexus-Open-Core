# GraphRAG CLI Commands

Enhanced GraphRAG commands for the Nexus CLI with support for memory management, enhanced search, and RAG Triad evaluation.

## Overview

The GraphRAG CLI commands provide access to both the standard GraphRAG service and the GraphRAG Enhanced service with advanced RAG patterns.

## Configuration

### Tenant Context

All GraphRAG commands require tenant context headers. Configure these in your Nexus CLI config:

```json
{
  "companyId": "adverant",
  "appId": "nexus-cli",
  "userId": "your-user-id"
}
```

### Service Discovery

The CLI automatically detects available services:
- `graphrag` - Standard GraphRAG (Port 8090)
- `graphrag-enhanced` - Enhanced GraphRAG with Modular RAG patterns (Port 9051)

Commands that support enhanced features will automatically use `graphrag-enhanced` if available, falling back to standard `graphrag`.

## Commands

### Document Management

#### `store-document`
Store a document in GraphRAG for indexing and retrieval.

**Usage:**
```bash
nexus graphrag store-document --file <path> [--title <title>]
```

**Examples:**
```bash
nexus graphrag store-document --file report.pdf --title "Q4 Report"
nexus graphrag store-document --file docs/api-spec.md
```

#### `query`
Query documents using standard search.

**Usage:**
```bash
nexus graphrag query --text <query> [--limit N]
```

**Examples:**
```bash
nexus graphrag query --text "user authentication" --limit 10
nexus graphrag query --text "deployment instructions"
```

### Memory Management

#### `store-memory`
Store a memory (code snippet, note, documentation) in GraphRAG.

**Usage:**
```bash
nexus graphrag store-memory --content <text> [--tags <tags>]
```

**Examples:**
```bash
nexus graphrag store-memory --content "User auth uses JWT tokens with bcrypt hashing" --tags "auth,jwt,security"

nexus graphrag store-memory --content "API endpoint: POST /api/users/register" --tags "api,users"
```

#### `recall`
Recall memories using semantic search.

**Usage:**
```bash
nexus graphrag recall --query <text> [--limit N]
```

**Examples:**
```bash
nexus graphrag recall --query "How does authentication work?" --limit 3

nexus graphrag recall --query "user registration endpoint"
```

**Output:**
```json
{
  "memories": [
    {
      "content": "User auth uses JWT tokens...",
      "score": 0.73,
      "timestamp": "2025-12-26T14:26:16.601Z",
      "tags": ["auth", "jwt"]
    }
  ],
  "count": 1
}
```

#### `list-memories`
List all stored memories with pagination.

**Usage:**
```bash
nexus graphrag list-memories [--limit N] [--offset N]
```

**Examples:**
```bash
nexus graphrag list-memories --limit 10

nexus graphrag list-memories --limit 20 --offset 20
```

### Enhanced Search (GraphRAG Enhanced)

#### `enhanced-search`
Perform enhanced search with query rewriting, HyDE, and self-correction.

**Usage:**
```bash
nexus graphrag enhanced-search --query <text> [options]
```

**Options:**
- `--enable-enhancement` - Enable query enhancement (default: true)
- `--enable-correction` - Enable self-correction (default: true)
- `--enable-eval` - Enable RAG Triad evaluation (default: true)
- `--top-k` - Number of results (default: 10)

**Examples:**
```bash
# Full enhanced search
nexus graphrag enhanced-search --query "JWT authentication implementation"

# Disable self-correction for faster results
nexus graphrag enhanced-search --query "How to deploy to K8s?" --enable-correction false

# Custom result count
nexus graphrag enhanced-search --query "API documentation" --top-k 5
```

**Output:**
```json
{
  "results": [...],
  "enhancement": {
    "originalQuery": "JWT auth",
    "enhancedQuery": "JWT token-based authentication implementation with Express.js",
    "routingDecision": {
      "route": "full_pipeline",
      "confidence": 0.9
    }
  },
  "quality": {
    "contextRelevance": 0.88,
    "groundedness": 0.92,
    "answerRelevance": 0.85,
    "overall": 0.88
  },
  "iterations": [...]
}
```

#### `analyze`
Analyze query complexity and routing decision without performing search.

**Usage:**
```bash
nexus graphrag analyze --query <text>
```

**Examples:**
```bash
nexus graphrag analyze --query "What is the refund policy?"

nexus graphrag analyze --query "Compare PostgreSQL vs MongoDB for high-volume transactions"
```

**Output:**
```json
{
  "analysis": {
    "intent": "exploratory",
    "complexity": "complex",
    "keywords": ["postgresql", "mongodb", "high-volume", "transactions"]
  },
  "routingDecision": {
    "route": "full_pipeline",
    "reason": "Complex query requiring full enhancement",
    "confidence": 0.9,
    "estimatedLatencyMs": 2000
  }
}
```

#### `evaluate`
Evaluate RAG quality using RAG Triad metrics (Context Relevance, Groundedness, Answer Relevance).

**Usage:**
```bash
nexus graphrag evaluate --query <text> --context <text> --answer <text>
```

**Note:** Separate multiple context chunks with `|||`

**Examples:**
```bash
nexus graphrag evaluate \
  --query "What is JWT?" \
  --context "JWT is a token standard|||Used for authentication" \
  --answer "JWT is a token standard used for authentication"
```

**Output:**
```json
{
  "scores": {
    "contextRelevance": 0.95,
    "groundedness": 0.92,
    "answerRelevance": 0.88,
    "overall": 0.92
  },
  "diagnostics": {
    "irrelevantChunks": [],
    "unsupportedClaims": [],
    "unansweredAspects": [],
    "suggestions": ["Quality is excellent - no immediate improvements needed"]
  }
}
```

## Routing Decision Types

The `enhanced-search` and `analyze` commands use adaptive routing:

| Route | Trigger | Latency | Use Case |
|-------|---------|---------|----------|
| `direct_llm` | Greetings, simple chat | ~500ms | "Hello", "Thanks" |
| `keyword_only` | Error codes, IDs, exact matches | ~300ms | "ERROR_401", "user-123" |
| `semantic_only` | Conceptual, explanatory queries | ~600ms | "How does X work?" |
| `full_pipeline` | Complex, multi-part queries | ~2000ms | "Compare A vs B for use case C" |

## Quality Metrics

### RAG Triad Scores

The `enhanced-search` and `evaluate` commands provide RAG Triad quality metrics:

| Metric | Description | Weight |
|--------|-------------|--------|
| **Context Relevance** | Is retrieved context relevant to query? | 0.35 |
| **Groundedness** | Is answer supported by context? | 0.35 |
| **Answer Relevance** | Does answer address the query? | 0.30 |

**Quality Thresholds:**
- `>= 0.80` - Excellent quality
- `0.70 - 0.79` - Good quality
- `0.60 - 0.69` - Acceptable quality
- `< 0.60` - Poor quality (triggers self-correction)

## Performance

### Typical Latencies

| Operation | Latency |
|-----------|---------|
| `store-memory` | ~100-200ms |
| `recall` | ~400-600ms |
| `query` | ~200-500ms |
| `enhanced-search` (no correction) | ~400-800ms |
| `enhanced-search` (with correction) | ~800-1500ms |
| `analyze` | ~45ms |
| `evaluate` | ~200-400ms |

### Caching

Enhanced search commands benefit from caching:
- Query enhancements cached for 1 hour
- Routing decisions cached for 30 minutes
- Search results cached for 15 minutes

## Integration with GraphRAG Enhanced

### Query Enhancement Flow

1. **Original Query**: "how does auth work?"
2. **Enhanced Query**: "Explain JWT token-based authentication implementation with Express.js including bcrypt password hashing and validation"
3. **HyDE Document**: Hypothetical answer generated for better similarity matching
4. **Multi-Query**: 3 query variations created to increase recall
5. **Results**: 30-50% more relevant context retrieved

### Self-Correction Flow

1. Initial retrieval → Quality score: 0.65
2. Identify quality issues → "Context lacks code examples"
3. Refine query → "Show TypeScript code for JWT authentication"
4. Re-retrieve → Quality score: 0.88
5. Return best results

## Examples

### Store and Recall Code Snippets

```bash
# Store a code snippet
nexus graphrag store-memory \
  --content "Express registration endpoint uses bcrypt.hash(password, 10) for password hashing" \
  --tags "express,security,bcrypt,authentication"

# Recall similar code
nexus graphrag recall --query "How to hash passwords in Node.js?" --limit 3
```

### Enhanced Search with Quality Evaluation

```bash
# Search with full enhancement
nexus graphrag enhanced-search \
  --query "PostgreSQL connection pooling best practices" \
  --top-k 5
```

### Quality Evaluation Workflow

```bash
# Analyze query first
nexus graphrag analyze --query "What is the deployment process?"

# Perform search
nexus graphrag enhanced-search --query "What is the deployment process?"

# Evaluate quality
nexus graphrag evaluate \
  --query "What is the deployment process?" \
  --context "Deployment uses Kubernetes|||Docker containers are built first|||CI/CD pipeline automates deployment" \
  --answer "The deployment process uses Kubernetes with Docker containers. The CI/CD pipeline automates the deployment workflow."
```

## Troubleshooting

### Service Not Found

If you see "GraphRAG service not found":
1. Ensure GraphRAG service is running
2. Check service discovery configuration
3. Verify service is registered in Nexus CLI

### Authentication Errors

If you see "Unauthorized" or "Missing tenant context":
1. Configure tenant context in CLI config
2. Ensure `companyId`, `appId`, and `userId` are set
3. Verify API key is valid

### Low Quality Scores

If enhanced search returns low quality scores:
1. Try enabling self-correction (if disabled)
2. Use more specific queries
3. Check if relevant content exists in knowledge base

## API Integration

For programmatic access, use the Nexus API directly:

**Endpoint**: `https://api.adverant.ai`

**Required Headers**:
```
Authorization: Bearer <api-key>
X-Company-ID: <company-id>
X-App-ID: <app-id>
X-User-ID: <user-id>
```

See [GraphRAG API Documentation](../../services/nexus-graphrag/README.md) for details.
