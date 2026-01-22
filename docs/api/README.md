# API Reference

Complete REST API documentation for Adverant Nexus GraphRAG and MageAgent services.

---

## Base URLs

**GraphRAG Service**:
```
Local: http://localhost:8090
Production: https://api.adverant.ai/graphrag
```

**MageAgent Service**:
```
Local: http://localhost:8080
Production: https://api.adverant.ai/mageagent
```

---

## Authentication

All API requests require Company ID and App ID headers:

```bash
curl -X POST http://localhost:8090/graphrag/api/v1/documents \
  -H "Content-Type: application/json" \
  -H "X-Company-ID: your-company-id" \
  -H "X-App-ID: your-app-id" \
  -d '{"content": "Document text", "metadata": {}}'
```

**For hosted version**: Also include `Authorization: Bearer {api-key}`

---

## Rate Limits

| Tier | Requests/Month | Rate Limit |
|------|----------------|------------|
| **Free** | 1,000 | 10/minute |
| **Pro** | 50,000 | 100/minute |
| **Enterprise** | Unlimited | Custom |

---

## GraphRAG API

### Store Document

**POST** `/graphrag/api/v1/documents`

Store a document in triple-layer storage (PostgreSQL + Neo4j + Qdrant).

**Request Body**:
```json
{
  "content": "string (required)",
  "metadata": {
    "title": "string",
    "author": "string",
    "date": "ISO 8601 timestamp",
    "tags": ["string"],
    "custom_field": "any JSON value"
  },
  "companyId": "string (optional, uses header if omitted)",
  "appId": "string (optional, uses header if omitted)"
}
```

**Response** (201 Created):
```json
{
  "documentId": "uuid",
  "status": "stored",
  "vectorId": "string",
  "graphNodeId": "string",
  "timestamp": "ISO 8601"
}
```

**Example**:
```bash
curl -X POST http://localhost:8090/graphrag/api/v1/documents \
  -H "Content-Type: application/json" \
  -H "X-Company-ID: demo" \
  -H "X-App-ID: test" \
  -d '{
    "content": "Adverant Nexus uses triple-layer storage: PostgreSQL for structured data, Neo4j for relationships, and Qdrant for vector search.",
    "metadata": {
      "title": "Architecture Overview",
      "tags": ["documentation", "architecture"]
    }
  }'
```

---

### Retrieve Documents (Enhanced Search)

**POST** `/graphrag/api/retrieve/enhanced`

Semantic search across all documents using vector similarity + graph traversal.

**Request Body**:
```json
{
  "query": "string (required)",
  "limit": "integer (default: 10, max: 100)",
  "filters": {
    "metadata_field": "exact match",
    "metadata_field": { "$in": ["value1", "value2"] },
    "metadata_field": { "$gte": "value", "$lte": "value" }
  },
  "includeEpisodic": "boolean (default: false)",
  "companyId": "string (optional)",
  "appId": "string (optional)"
}
```

**Response** (200 OK):
```json
{
  "results": [
    {
      "id": "uuid",
      "content": "string",
      "metadata": {},
      "score": 0.92,
      "source": "vector" | "graph" | "episodic"
    }
  ],
  "total": 42,
  "took": 127
}
```

**Example**:
```bash
curl -X POST http://localhost:8090/graphrag/api/retrieve/enhanced \
  -H "Content-Type: application/json" \
  -H "X-Company-ID: demo" \
  -H "X-App-ID: test" \
  -d '{
    "query": "How does Nexus store knowledge?",
    "limit": 5,
    "filters": {
      "tags": { "$in": ["documentation"] }
    }
  }'
```

---

### Get Document by ID

**GET** `/graphrag/api/v1/documents/{documentId}`

Retrieve a specific document by ID.

**Response** (200 OK):
```json
{
  "id": "uuid",
  "content": "string",
  "metadata": {},
  "createdAt": "ISO 8601",
  "updatedAt": "ISO 8601"
}
```

---

### Update Document

**PUT** `/graphrag/api/v1/documents/{documentId}`

Update document content or metadata.

**Request Body**:
```json
{
  "content": "string (optional)",
  "metadata": {} (optional, merges with existing)
}
```

---

### Delete Document

**DELETE** `/graphrag/api/v1/documents/{documentId}`

Permanently delete a document from all storage layers.

**Response** (204 No Content)

---

### Bulk Operations

**POST** `/graphrag/api/v1/documents/bulk`

Store multiple documents in a single request (up to 100 documents).

**Request Body**:
```json
{
  "documents": [
    {
      "content": "string",
      "metadata": {}
    }
  ]
}
```

**Response** (201 Created):
```json
{
  "stored": 95,
  "failed": 5,
  "documentIds": ["uuid1", "uuid2"],
  "errors": [
    {
      "index": 42,
      "error": "Content too large"
    }
  ]
}
```

---

## MageAgent API

### Create Task

**POST** `/api/v1/tasks`

Create an async AI task with multi-agent orchestration.

**Request Body**:
```json
{
  "prompt": "string (required)",
  "model": "string (optional, default: gpt-4o-mini)",
  "stream": "boolean (optional, default: false)",
  "context": {
    "useGraphRAG": "boolean",
    "graphragQuery": "string",
    "additionalContext": "string"
  },
  "tools": ["string"],
  "companyId": "string (optional)",
  "appId": "string (optional)"
}
```

**Response** (202 Accepted):
```json
{
  "taskId": "uuid",
  "status": "pending" | "processing" | "completed" | "failed",
  "createdAt": "ISO 8601",
  "estimatedCompletionTime": 30
}
```

**Example**:
```bash
curl -X POST http://localhost:8080/api/v1/tasks \
  -H "Content-Type: application/json" \
  -H "X-Company-ID: demo" \
  -H "X-App-ID: test" \
  -d '{
    "prompt": "Summarize the key features of Adverant Nexus",
    "model": "claude-3-5-sonnet-20241022",
    "context": {
      "useGraphRAG": true,
      "graphragQuery": "Adverant Nexus features"
    }
  }'
```

---

### Get Task Status

**GET** `/api/v1/tasks/{taskId}`

Check task execution status and retrieve result.

**Response** (200 OK):
```json
{
  "taskId": "uuid",
  "status": "completed",
  "result": {
    "content": "string",
    "model": "claude-3-5-sonnet-20241022",
    "tokensUsed": 1247,
    "completionTime": 8.4
  },
  "createdAt": "ISO 8601",
  "completedAt": "ISO 8601"
}
```

---

### Stream Task Output (SSE)

**GET** `/api/v1/tasks/{taskId}/stream`

Stream task output in real-time using Server-Sent Events.

**Response** (text/event-stream):
```
event: token
data: {"content": "The key"}

event: token
data: {"content": " features"}

event: complete
data: {"tokensUsed": 1247}
```

**Example (JavaScript)**:
```javascript
const eventSource = new EventSource(
  `http://localhost:8080/api/v1/tasks/${taskId}/stream`
);

eventSource.addEventListener('token', (event) => {
  const data = JSON.parse(event.data);
  console.log(data.content);
});

eventSource.addEventListener('complete', (event) => {
  eventSource.close();
});
```

---

## Error Codes

| Code | Meaning | Resolution |
|------|---------|------------|
| **400** | Bad Request | Check request body format |
| **401** | Unauthorized | Add X-Company-ID and X-App-ID headers |
| **404** | Not Found | Document/task ID doesn't exist |
| **429** | Rate Limited | Wait before retrying (see Retry-After header) |
| **500** | Internal Error | Contact support |
| **503** | Service Unavailable | Service is starting or under maintenance |

**Error Response Format**:
```json
{
  "error": {
    "code": "INVALID_REQUEST",
    "message": "Content field is required",
    "details": {
      "field": "content",
      "constraint": "required"
    }
  }
}
```

---

## SDKs

### TypeScript/JavaScript

```bash
npm install @adverant/nexus-client
```

```typescript
import { GraphRAGClient, MageAgentClient } from '@adverant/nexus-client';

const graphrag = new GraphRAGClient({
  baseURL: 'http://localhost:8090',
  companyId: 'demo',
  appId: 'test',
});

const docId = await graphrag.storeDocument({
  content: 'Document text',
  metadata: { title: 'Test' },
});

const results = await graphrag.retrieve({
  query: 'search query',
  limit: 10,
});
```

### Python

```bash
pip install adverant-nexus
```

```python
from adverant_nexus import GraphRAGClient, MageAgentClient

graphrag = GraphRAGClient(
    base_url='http://localhost:8090',
    company_id='demo',
    app_id='test'
)

doc_id = graphrag.store_document(
    content='Document text',
    metadata={'title': 'Test'}
)

results = graphrag.retrieve(
    query='search query',
    limit=10
)
```

---

## Webhooks

Configure webhooks to receive real-time notifications.

**POST** `/api/v1/webhooks`

**Request Body**:
```json
{
  "url": "https://your-app.com/webhook",
  "events": ["document.created", "task.completed"],
  "secret": "webhook-signing-secret"
}
```

**Webhook Payload Example**:
```json
{
  "event": "task.completed",
  "taskId": "uuid",
  "result": {
    "content": "string",
    "tokensUsed": 1247
  },
  "timestamp": "ISO 8601",
  "signature": "sha256=..."
}
```

---

## Related Documentation

- [Getting Started Guide](../getting-started.md)
- [GraphRAG Architecture](../architecture/graphrag.md)
- [MageAgent Orchestration](../architecture/mageagent.md)
- [Use Cases](../use-cases/)

---

**📄 License**: Apache 2.0 + Elastic License 2.0
**🔗 Repository**: [github.com/adverant/Adverant-Nexus-Open-Core](https://github.com/adverant/Adverant-Nexus-Open-Core)
