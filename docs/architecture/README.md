# Adverant Nexus Architecture Overview

**Production-grade AI platform architecture designed for composability, resilience, and scale.**

---

## Table of Contents

1. [System Architecture](#system-architecture)
2. [Component Responsibilities](#component-responsibilities)
3. [Technology Stack](#technology-stack)
4. [Data Flow](#data-flow)
5. [Deployment Models](#deployment-models)
6. [Design Principles](#design-principles)

---

## System Architecture

Adverant Nexus follows a **microservices architecture** with clear separation of concerns, enabling independent scaling and deployment of components.

### High-Level Architecture Diagram

```
┌──────────────────────────────────────────────────────────────────────┐
│                        Client Applications                            │
│     (Web Apps, Mobile Apps, CLI Tools, Third-Party Integrations)      │
└────────────┬─────────────────────────────────────────────────────────┘
             │ HTTPS / WebSocket
             ▼
┌──────────────────────────────────────────────────────────────────────┐
│                       API Gateway Layer (Future)                      │
│    Authentication • Rate Limiting • Request Routing • Load Balancing  │
└────────────┬─────────────────────────────────────────────────────────┘
             │
      ┌──────┴──────┐
      │ HTTP/REST   │
      ▼             ▼
┌─────────────┐  ┌──────────────┐
│  GraphRAG   │  │  MageAgent   │
│  Service    │◄─┤  Service     │
│  :8090      │──►│  :8080       │
└──────┬──────┘  └──────┬───────┘
       │                │
       │  ┌─────────────┴──────────────┐
       │  │                            │
       ▼  ▼                            ▼
┌────────────────────────────────────────────────────────────────────┐
│                        Data Layer                                  │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐  ┌────────┐│
│  │ PostgreSQL   │  │   Neo4j      │  │   Qdrant     │  │ Redis  ││
│  │ Structured   │  │  Graph DB    │  │ Vector Store │  │ Cache  ││
│  │ + RLS        │  │ + APOC       │  │ + gRPC       │  │ + Pub/ ││
│  │              │  │              │  │              │  │  Sub   ││
│  └──────────────┘  └──────────────┘  └──────────────┘  └────────┘│
└────────────────────────────────────────────────────────────────────┘
          │                  │                  │              │
          └──────────────────┴──────────────────┴──────────────┘
                           Persistent Volumes
```

### Key Architectural Characteristics

#### 1. **Microservices with Bounded Contexts**
- **GraphRAG Service**: Owns all knowledge management operations
- **MageAgent Service**: Owns all LLM orchestration and agent tasks
- **Clear APIs**: REST for request/response, WebSocket for streaming
- **Independent Scaling**: Scale GraphRAG and MageAgent separately based on load

#### 2. **Event-Driven Communication**
- **Redis Pub/Sub**: Inter-service event broadcasting
- **BullMQ Queues**: Async task processing with retries
- **WebSocket**: Real-time updates to clients
- **Eventual Consistency**: Services sync state asynchronously

#### 3. **Triple-Layer Data Architecture**
- **PostgreSQL**: Source of truth for structured data
- **Neo4j**: Derived graph for relationship queries
- **Qdrant**: Derived vectors for semantic search
- **Synchronization**: GraphRAG service maintains consistency

#### 4. **Resilience Patterns**
- **Circuit Breakers**: Prevent cascade failures
- **Retries with Exponential Backoff**: Handle transient errors
- **Timeouts**: Every external call has a deadline
- **Bulkheads**: Isolate critical resources
- **Health Checks**: Liveness and readiness probes

---

## Component Responsibilities

### Core Services

#### **GraphRAG Service** ([services/nexus-graphrag](../../services/nexus-graphrag/))

**Purpose**: Unified knowledge management across three storage layers

**Responsibilities**:
- Document ingestion, chunking, and indexing
- Triple-layer storage coordination (PostgreSQL + Neo4j + Qdrant)
- Semantic search and hybrid retrieval
- Entity extraction and relationship mapping
- Episodic memory and fact management
- Document versioning and metadata
- Multi-tenant data isolation (Row-Level Security)

**APIs**:
- `POST /graphrag/api/v1/documents` - Store documents
- `POST /graphrag/api/retrieve/enhanced` - Enhanced multi-layer retrieval
- `GET /graphrag/api/v1/documents/:id` - Fetch document by ID
- `DELETE /graphrag/api/v1/documents/:id` - Remove document
- 42+ total REST endpoints

**Technology**:
- Node.js 20 + TypeScript
- PostgreSQL client (pg)
- Neo4j driver (neo4j-driver)
- Qdrant client (@qdrant/qdrant-js)
- BullMQ for async tasks
- Winston for logging

#### **MageAgent Service** ([services/nexus-mageagent](../../services/nexus-mageagent/))

**Purpose**: Multi-agent orchestration and LLM task management

**Responsibilities**:
- LLM model routing (320+ models via OpenAI, Anthropic, Google, OpenRouter)
- Async task execution with streaming
- Agent tool integration (web search, code execution, file processing)
- Context window management
- Multi-agent collaboration
- Task queue management (BullMQ)
- Real-time progress updates (WebSocket, SSE)

**APIs**:
- `POST /mageagent/api/v1/tasks` - Create agent task
- `GET /mageagent/api/v1/tasks/:id` - Get task status
- `GET /mageagent/api/v1/tasks/:id/stream` - Stream task updates (SSE)
- `WS /mageagent/api/v1/tasks/:id/ws` - WebSocket streaming
- 20+ total REST endpoints

**Technology**:
- Node.js 20 + TypeScript
- OpenAI SDK
- Anthropic SDK
- Google Generative AI SDK
- BullMQ for queues
- Socket.io for WebSocket

### Infrastructure Packages

All services share 10 battle-tested infrastructure packages for **70-90% code reuse**:

#### **[@adverant/logger](../../packages/adverant-logger/)**
Structured logging with Winston, supporting multiple transports (console, file, HTTP).

**Features**:
- Log levels: debug, info, warn, error
- Correlation IDs for distributed tracing
- JSON formatting for log aggregation
- Sensitive data masking

#### **[@adverant/errors](../../packages/adverant-errors/)**
Error classification and handling with rich context.

**Error Types**:
- `ValidationError`: Invalid input
- `NotFoundError`: Resource doesn't exist
- `UnauthorizedError`: Authentication failed
- `ForbiddenError`: Authorization failed
- `ConflictError`: Resource state conflict
- `RateLimitError`: Too many requests
- `ServiceError`: Internal service failure

#### **[@adverant/config](../../packages/adverant-config/)**
Configuration management with environment variable validation.

**Features**:
- Schema-based validation
- Type-safe config access
- Environment-specific overrides
- Port registry (conflict detection)
- Secret management integration

#### **[@adverant/resilience](../../packages/adverant-resilience/)**
Resilience patterns for fault tolerance.

**Patterns**:
- **Circuit Breaker**: Stop calling failing services
- **Retry**: Exponential backoff with jitter
- **Timeout**: Deadline for all operations
- **Bulkhead**: Resource isolation
- **Fallback**: Graceful degradation

#### **[@adverant/cache](../../packages/adverant-cache/)**
Redis-backed caching with TTL and invalidation.

**Features**:
- Key-value caching
- TTL (time-to-live) support
- Cache invalidation patterns
- Cache-aside pattern
- Multi-layer caching (memory + Redis)

#### **[@adverant/database](../../packages/adverant-database/)**
Database managers for PostgreSQL, Neo4j, Qdrant.

**Managers**:
- `PostgresManager`: Connection pooling, transactions, RLS
- `Neo4jManager`: Cypher queries, transactions
- `QdrantManager`: Vector CRUD, collections, search

#### **[@adverant/event-bus](../../packages/adverant-event-bus/)**
Pub/sub event system for inter-service communication.

**Features**:
- Topic-based routing
- Event replay
- Dead letter queue
- Event schema validation

#### **[@adverant/nexus-routing](../../packages/nexus-routing/)**
Service discovery and request routing.

**Features**:
- Service registry
- Load balancing
- Health checking
- Circuit breaker integration

#### **[@adverant/nexus-telemetry](../../packages/nexus-telemetry/)**
OpenTelemetry integration for observability.

**Features**:
- Distributed tracing (Jaeger)
- Metrics collection (Prometheus)
- Custom spans and attributes
- Trace correlation

#### **[@unified-nexus/voyage-ai-client](../../packages/voyage-ai-client/)**
Voyage AI embeddings client for semantic search.

**Features**:
- Batch embedding generation
- Model selection (voyage-2, voyage-code-2)
- Retry logic
- Rate limiting

---

## Technology Stack

### Core Technologies

| Component | Technology | Version | Purpose |
|-----------|------------|---------|---------|
| **Runtime** | Node.js | 20+ | JavaScript execution |
| **Language** | TypeScript | 5.3+ | Type-safe development |
| **Package Manager** | npm | 10+ | Dependency management |
| **Build Tool** | tsx, tsc | Latest | TypeScript compilation |
| **Containerization** | Docker | 24+ | Service packaging |
| **Orchestration** | Kubernetes / K3s | 1.28+ | Container management |

### Databases

| Database | Purpose | Version | Key Features |
|----------|---------|---------|--------------|
| **PostgreSQL** | Structured data | 15+ | RLS, JSONB, full-text search |
| **Neo4j** | Graph relationships | 5+ | APOC, Cypher, graph algorithms |
| **Qdrant** | Vector search | 1.7+ | HNSW, quantization, filters |
| **Redis** | Caching, queues | 7+ | Pub/sub, streams, sorted sets |

### LLM Integrations

| Provider | Models | SDK | Notes |
|----------|--------|-----|-------|
| **OpenAI** | GPT-4, GPT-3.5 Turbo | openai | Vision, function calling |
| **Anthropic** | Claude 3.5 Sonnet, Opus, Haiku | @anthropic-ai/sdk | 200K context, tool use |
| **Google** | Gemini Pro, Ultra | @google/generative-ai | Multimodal |
| **Cohere** | Command, Embed | cohere-ai | Embeddings, rerank |
| **OpenRouter** | 320+ models | openai-compatible | Unified API |
| **Voyage AI** | voyage-2, voyage-code-2 | voyage-ai | Embeddings |

### Observability

| Tool | Purpose | Integration |
|------|---------|-------------|
| **OpenTelemetry** | Tracing | @opentelemetry/api |
| **Jaeger** | Trace visualization | OTLP exporter |
| **Prometheus** | Metrics | prom-client |
| **Grafana** | Dashboards | Prometheus data source |
| **Winston** | Logging | @adverant/logger |

---

## Data Flow

### Document Ingestion Flow

```
Client
  │
  ▼
POST /graphrag/api/v1/documents
  │
  ▼
GraphRAG Service
  │
  ├─► 1. Validate input (schema, auth)
  │
  ├─► 2. Extract metadata
  │
  ├─► 3. Chunk document (intelligent splitting)
  │
  ├─► 4. Store in PostgreSQL (structured + RLS)
  │
  ├─► 5. Extract entities (NER)
  │    └─► Store in Neo4j (nodes + relationships)
  │
  ├─► 6. Generate embeddings (Voyage AI)
  │    └─► Store in Qdrant (vectors + metadata)
  │
  └─► 7. Return document ID + status
       └─► Client receives response
```

**Time**: 200-500ms depending on document size

### Enhanced Retrieval Flow

```
Client
  │
  ▼
POST /graphrag/api/retrieve/enhanced
  │
  ▼
GraphRAG Service
  │
  ├─► 1. Parse query + filters
  │
  ├─► 2. Generate query embedding (Voyage AI)
  │
  ├─► 3. Parallel search across 3 layers:
  │    │
  │    ├─► PostgreSQL (metadata filters, full-text)
  │    │    └─► Returns: structured matches
  │    │
  │    ├─► Neo4j (graph traversal, entity links)
  │    │    └─► Returns: related entities
  │    │
  │    └─► Qdrant (vector similarity)
  │         └─► Returns: semantic matches
  │
  ├─► 4. Merge results (deduplicate, rank)
  │
  ├─► 5. Re-rank (hybrid scoring)
  │
  └─► 6. Return top-k results
       └─► Client receives ranked results
```

**Time**: 50-200ms (with caching: <20ms)

### Agent Task Execution Flow

```
Client
  │
  ▼
POST /mageagent/api/v1/tasks
  │
  ▼
MageAgent Service
  │
  ├─► 1. Validate task (auth, rate limit)
  │
  ├─► 2. Enqueue task (BullMQ)
  │
  ├─► 3. Return task ID (immediate response)
  │
  └─► Client receives task ID
       │
       ▼
    GET /tasks/:id/stream (SSE) or WS
       │
       ▼
    Agent Worker (async)
       │
       ├─► 4. Retrieve context (GraphRAG if needed)
       │
       ├─► 5. Select LLM model (routing logic)
       │
       ├─► 6. Execute tools (if function calling)
       │
       ├─► 7. Stream response (chunk by chunk)
       │    └─► Client receives streaming updates
       │
       ├─► 8. Store result (cache, history)
       │
       └─► 9. Mark task complete
            └─► Client receives final status
```

**Time**: 2-10 seconds (LLM-dependent)

---

## Deployment Models

Adverant Nexus supports multiple deployment models for different use cases:

### 1. **Local Development (Docker Compose)**

**Use Case**: Development, testing, demos

**Resources**: 8GB RAM minimum, 4 CPU cores

**Components**:
- All services in `docker-compose.test.yml`
- Databases on Docker volumes
- No external dependencies

**Pros**:
- ✅ Quick setup (5 minutes)
- ✅ Full feature parity
- ✅ Offline capable (except LLM calls)

**Cons**:
- ❌ Not production-ready
- ❌ No horizontal scaling
- ❌ Single point of failure

### 2. **Kubernetes (Standard Deployment)**

**Use Case**: Production, multi-tenant SaaS

**Resources**: 16GB+ RAM, 8+ CPU cores, persistent volumes

**Components**:
- Deployments for each service
- StatefulSets for databases
- Ingress + TLS termination
- Horizontal Pod Autoscaling

**Pros**:
- ✅ Horizontal scaling
- ✅ High availability
- ✅ Rolling updates
- ✅ Self-healing

**Cons**:
- ❌ Requires K8s cluster
- ❌ More complex setup

**Reference**: [k8s/base/](../../k8s/base/)

### 3. **Managed Cloud (SaaS)**

**Use Case**: Skip self-hosting, fastest time to value

**Provider**: [dashboard.adverant.ai](https://dashboard.adverant.ai)

**Pricing**:
- Free: 1,000 requests/month
- Pro: 50,000 requests/month ($49/mo)
- Enterprise: Unlimited + SLA ($499/mo)

**Pros**:
- ✅ Zero infrastructure management
- ✅ Automatic scaling
- ✅ Global CDN
- ✅ Managed backups

**Cons**:
- ❌ Vendor lock-in (export available)
- ❌ No on-premise option

---

## Design Principles

### 1. **Composability**
Every service and package is independently usable. You can use GraphRAG without MageAgent, or vice versa.

### 2. **Resilience First**
Every external call has timeouts, retries, and circuit breakers. Services degrade gracefully under failure.

### 3. **Developer Experience**
TypeScript strict mode, npm workspaces, comprehensive error messages, detailed logging.

### 4. **Production-Ready**
Multi-tenancy, observability, security (RLS, RBAC), performance optimizations (caching, batching).

### 5. **Open Core**
Open-source foundation with optional paid enterprise features. No vendor lock-in.

---

## Performance Characteristics

### Latency (p50 / p95 / p99)

| Operation | p50 | p95 | p99 | Notes |
|-----------|-----|-----|-----|-------|
| Document storage | 100ms | 300ms | 500ms | Includes all 3 layers |
| Vector search | 20ms | 50ms | 100ms | Cached: <5ms |
| Enhanced retrieval | 50ms | 150ms | 300ms | 3-layer parallel search |
| Agent task (GPT-4) | 3s | 8s | 15s | LLM-dependent |
| Graph query | 10ms | 50ms | 100ms | Neo4j Cypher |

### Throughput

| Metric | Development | Production |
|--------|-------------|------------|
| Documents ingested/sec | 10-20 | 50-100 (scaled) |
| Search queries/sec | 100-200 | 1,000+ (cached) |
| Concurrent agents | 5-10 | 50-100 (scaled) |
| WebSocket connections | 100 | 10,000+ (load balanced) |

### Resource Usage (Per Service)

| Service | CPU (idle) | CPU (load) | Memory | Storage |
|---------|------------|------------|--------|---------|
| GraphRAG | 5% | 30-60% | 500MB | Minimal (databases) |
| MageAgent | 5% | 40-80% | 800MB | Minimal (queues) |
| PostgreSQL | 2% | 10-30% | 300MB | 5-50GB (data) |
| Neo4j | 5% | 20-40% | 1GB | 1-10GB (data) |
| Qdrant | 3% | 15-35% | 500MB | 5-50GB (vectors) |
| Redis | 1% | 5-15% | 100MB | 100MB-2GB |

---

## Security Architecture

### Multi-Tenancy Isolation

**Strategy**: Company-ID + App-ID namespace isolation

1. **Row-Level Security (PostgreSQL)**:
   - Every table has `company_id` and `app_id` columns
   - RLS policies enforce tenant isolation
   - No cross-tenant data leakage

2. **Neo4j Namespace**:
   - Graph nodes tagged with `company_id` and `app_id`
   - Cypher queries filtered automatically

3. **Qdrant Collections**:
   - Per-tenant collections or filtered payloads
   - No cross-collection queries

4. **Redis Keys**:
   - Prefixed with `{company_id}:{app_id}:`
   - Namespace isolation via key patterns

### Authentication & Authorization

**Current**: Header-based (development mode)
- `X-Company-ID`: Tenant identifier
- `X-App-ID`: Application identifier

**Enterprise**: JWT + OAuth2
- JWT tokens with tenant claims
- RBAC (Role-Based Access Control)
- API key authentication

### Data Protection

1. **At Rest**: AES-256 encryption (database level)
2. **In Transit**: TLS 1.3 (HTTPS, WSS)
3. **Secrets**: Kubernetes Secrets, Vault integration
4. **Audit Logs**: All access logged (Enterprise)

---

## Observability & Monitoring

### Distributed Tracing

**Tool**: OpenTelemetry + Jaeger

**Traces**:
- Request lifecycle across services
- Database query spans
- External API calls (LLMs)
- Custom business logic spans

**Correlation**:
- Trace IDs propagated via HTTP headers
- Context preserved across async boundaries

### Metrics

**Tool**: Prometheus + Grafana

**Metrics**:
- Request rate, latency, error rate (RED metrics)
- Database connection pool stats
- Queue depth and processing time
- LLM token usage and costs
- Cache hit/miss rates

### Logging

**Tool**: Winston + Fluentd (optional)

**Log Levels**:
- `debug`: Development debugging
- `info`: Normal operation
- `warn`: Degraded state
- `error`: Failures requiring attention

**Structured Logs**:
- JSON format for aggregation
- Correlation IDs for tracing
- Sensitive data masking

---

## Scalability & Performance

### Horizontal Scaling

**GraphRAG Service**:
- Stateless (safe to replicate)
- Scale based on CPU/memory
- Database connection pooling

**MageAgent Service**:
- Stateless workers
- BullMQ for work distribution
- Scale based on queue depth

**Databases**:
- PostgreSQL: Read replicas
- Neo4j: Causal clustering (Enterprise Neo4j)
- Qdrant: Horizontal scaling (distributed mode)
- Redis: Redis Cluster

### Caching Strategy

**Layers**:
1. **Application Cache**: Redis (5-60 min TTL)
2. **Database Query Cache**: PostgreSQL shared buffers
3. **CDN Cache**: CloudFront/CloudFlare (static assets)

**Invalidation**:
- TTL expiration
- Event-based invalidation (pub/sub)
- Manual purge API

### Optimization Techniques

1. **Database**:
   - Index optimization (PostgreSQL, Neo4j)
   - Query result caching
   - Connection pooling

2. **Vector Search**:
   - HNSW index for fast approximate search
   - Quantization (reduce memory)
   - Pre-filtering with metadata

3. **LLM Calls**:
   - Response caching (semantic similarity)
   - Smart model routing (price/speed trade-offs)
   - Batch processing

---

## Next Steps

### Deep Dives

- **[GraphRAG Architecture](graphrag.md)** - Triple-layer storage in detail
- **[MageAgent Architecture](mageagent.md)** - Multi-agent orchestration patterns
- **[Infrastructure Packages](infrastructure.md)** - Shared library design
- **[Data Flow](data-flow.md)** - Request lifecycle and event flows

### Implementation Guides

- **[API Reference](../api/)** - Complete endpoint documentation
- **[Deployment Guide](../../k8s/README.md)** - Kubernetes production deployment
- **[Migration Guides](../migration/)** - Move from existing tools

---

**[← Back to Getting Started](../getting-started.md)** | **[Next: GraphRAG Deep Dive →](graphrag.md)**
