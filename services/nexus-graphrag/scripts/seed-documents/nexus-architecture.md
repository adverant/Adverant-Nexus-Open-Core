# Nexus Platform Architecture

## Overview

Nexus is a production-grade AI platform built on microservices architecture, running on Kubernetes (K3s) with a sophisticated GraphRAG system for intelligent knowledge management and retrieval.

## Core Services

### API Gateway (nexus-gateway)
**Port**: 9000
**Role**: Unified entry point for all API requests

**Responsibilities**:
- Request routing and load balancing
- Authentication and authorization
- Rate limiting
- WebSocket connections for real-time chat
- Tool routing to appropriate services

**Key Features**:
- Express.js with TypeScript
- Socket.IO for WebSocket support
- JWT token validation
- Admin tool handlers for K8s operations

### GraphRAG Core (nexus-graphrag)
**Port**: 8090
**Role**: Knowledge graph and vector search engine

**Capabilities**:
- Document storage and chunking
- Vector embeddings (Voyage AI)
- Hybrid search (dense + sparse)
- Entity extraction and linking
- Memory storage and recall
- Episodic memory with temporal decay

**Databases Used**:
- PostgreSQL: Document metadata, full-text search
- Qdrant: Vector embeddings for semantic search
- Neo4j: Knowledge graph and entity relationships
- Redis: Caching and job queues

### GraphRAG Enhanced (nexus-graphrag-enhanced)
**Port**: 9051
**Role**: Advanced RAG with quality evaluation

**Features**:
- Query enhancement (rewriting, HyDE, multi-query)
- Adaptive routing
- RAG Triad evaluation
- Self-correction loops
- Automatic quality scoring

**Enhancement Pipeline**:
```
Query → Enhance → Route → Retrieve → Evaluate → [Correct] → Respond
```

### MageAgent (nexus-mageagent)
**Port**: 9001
**Role**: Multi-agent orchestration system

**Capabilities**:
- Agent spawning and coordination
- Task decomposition
- Parallel agent execution
- Result synthesis
- Collaborative problem solving

### Authentication (nexus-auth)
**Port**: 9003
**Role**: User authentication and authorization

**Features**:
- OAuth2 integration (Google, GitHub)
- JWT token management
- Role-based access control
- Session management

### File Processing (nexus-fileprocess)
**Role**: Document processing and ingestion

**Supported Formats**:
- PDF documents
- Word documents
- Plain text
- Markdown
- Code files

## Infrastructure

### Kubernetes (K3s)

**Namespace**: `nexus`

**Deployment Pattern**:
- Deployments for stateless services
- StatefulSets for databases
- Services for internal communication
- Ingress for external access

**Resource Management**:
```yaml
resources:
  requests:
    memory: "256Mi"
    cpu: "100m"
  limits:
    memory: "512Mi"
    cpu: "500m"
```

### Service Mesh (Istio)

**Features**:
- Mutual TLS between services
- Traffic management
- Observability
- Load balancing

### Container Registry

**Local Registry**: `localhost:5000`

All images are built and stored locally:
- `localhost:5000/nexus-api-gateway:latest`
- `localhost:5000/nexus-graphrag:latest`
- `localhost:5000/nexus-graphrag-enhanced:latest`

## Data Flow

### Query Processing

```
User Query
    │
    ▼
API Gateway (9000)
    │
    ├─→ Authentication Check
    │
    ▼
GraphRAG Enhanced (9051)
    │
    ├─→ Query Enhancement
    │   ├── Query Rewriting
    │   ├── HyDE Generation
    │   └── Multi-Query Expansion
    │
    ├─→ Adaptive Routing
    │   └── Select retrieval strategy
    │
    ▼
GraphRAG Core (8090)
    │
    ├─→ Vector Search (Qdrant)
    ├─→ Full-Text Search (PostgreSQL)
    └─→ Graph Search (Neo4j)
    │
    ▼
Results Fusion & Reranking
    │
    ▼
RAG Triad Evaluation
    │
    ├─→ Quality OK: Return
    └─→ Quality Low: Self-Correct
    │
    ▼
Response to User
```

### Document Ingestion

```
Document Upload
    │
    ▼
File Processing
    │
    ├─→ Format Detection
    ├─→ Text Extraction
    ├─→ Chunking
    │
    ▼
GraphRAG Core
    │
    ├─→ Embedding Generation (Voyage AI)
    ├─→ Vector Storage (Qdrant)
    ├─→ Full-Text Index (PostgreSQL)
    ├─→ Entity Extraction (LLM)
    └─→ Knowledge Graph (Neo4j)
```

## Database Architecture

### PostgreSQL (graphrag schema)

**Tables**:
- `documents`: Document metadata
- `document_chunks`: Text chunks with embeddings
- `memories`: Persistent memories
- `episodes`: Episodic memories
- `search_index`: Full-text search vectors

### Qdrant

**Collections**:
- `unified_content`: All document embeddings
- `tenant_{id}_documents`: Tenant-specific collections

**Index**: HNSW with cosine similarity

### Neo4j

**Node Types**:
- `Document`: Source documents
- `Entity`: Extracted entities
- `Concept`: Abstract concepts

**Relationships**:
- `MENTIONS`: Document mentions entity
- `RELATES_TO`: Entity relationships
- `SIMILAR_TO`: Semantic similarity

### Redis

**Usage**:
- Session caching
- Query result caching
- Job queues for async processing
- Real-time pub/sub

## API Design

### REST Endpoints

```
GET  /health              Health check
POST /api/chat            Chat completion
POST /api/retrieve        Document retrieval
POST /api/documents       Store document
GET  /api/documents       List documents
POST /api/memories        Store memory
POST /api/memories/recall Recall memories
```

### WebSocket Events

```typescript
// Client → Server
'chat:message'      // Send message
'chat:typing'       // Typing indicator
'auth:token'        // Authentication

// Server → Client
'chat:response'     // Response chunk
'chat:complete'     // Response complete
'chat:error'        // Error occurred
'tool:call'         // Tool being executed
'tool:result'       // Tool result
```

## Observability

### Logging

**Format**: Structured JSON logging
**Levels**: error, warn, info, debug
**Aggregation**: Centralized logging with correlation IDs

### Metrics

**Key Metrics**:
- Request latency (p50, p95, p99)
- Retrieval quality scores
- Token usage
- Error rates
- Cache hit rates

### Health Checks

**Endpoints**:
- `/health`: Full health check
- `/health/live`: Kubernetes liveness
- `/health/ready`: Kubernetes readiness

## Security

### Authentication

- JWT tokens with RS256 signing
- OAuth2 for social login
- API keys for programmatic access

### Authorization

- Role-based access control (RBAC)
- Tenant isolation
- Resource-level permissions

### Data Protection

- Encryption at rest (PostgreSQL, Qdrant)
- Encryption in transit (TLS/mTLS)
- Secrets management (K8s Secrets)

## Deployment

### Build Process

```bash
# Build on server (never locally)
ssh root@server "cd /root/Adverant-Nexus && \
  docker build -t localhost:5000/service:tag \
  -f services/service/Dockerfile ."

# Push to registry
docker push localhost:5000/service:tag

# Deploy to K8s
kubectl set image deployment/service \
  service=localhost:5000/service:tag -n nexus
```

### CI/CD

1. Push to GitHub main branch
2. GitHub Actions triggers
3. SSH into server
4. Pull latest code
5. Build Docker image
6. Push to local registry
7. Update K8s deployment
8. Verify rollout

## Scaling

### Horizontal Scaling

- API Gateway: 2-3 replicas (stateless)
- GraphRAG: 1-2 replicas
- MageAgent: 1 replica (stateful coordination)

### Database Scaling

- PostgreSQL: Connection pooling, read replicas
- Qdrant: Sharding for large datasets
- Neo4j: Causal clustering (if needed)

## Best Practices

1. **Use GraphRAG Enhanced** for complex queries
2. **Store documents** with rich metadata
3. **Monitor RAG Triad scores** for quality
4. **Cache aggressively** for repeated queries
5. **Use episodic memory** for conversation context
6. **Deploy via CI/CD** - never build locally
