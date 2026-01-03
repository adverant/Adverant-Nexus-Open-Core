# Getting Started with Adverant Nexus Open Core

**Build your first production-ready AI application in 5 minutes** using GraphRAG knowledge management and multi-agent orchestration.

---

## What You'll Build

By the end of this guide (approximately **5-10 minutes**), you'll have:

✅ **Fully functional GraphRAG system** with triple-layer storage (PostgreSQL + Neo4j + Qdrant)
✅ **Multi-agent orchestration** with 320+ LLM models
✅ **Working API endpoints** for document storage, semantic search, and agent tasks
✅ **Real-time understanding** of how production AI platforms work

No mock data. No toy examples. **Production-grade infrastructure running locally.**

---

## Prerequisites

Before starting, ensure you have:

### Required Software
- **Node.js 20+** (LTS recommended)
  - Download: [nodejs.org](https://nodejs.org)
  - Verify: `node --version` should show v20.x or higher

- **Docker Desktop**
  - Download: [docker.com/products/docker-desktop](https://docker.com/products/docker-desktop)
  - Verify: `docker --version` and `docker-compose --version`

- **Git**
  - Usually pre-installed on Mac/Linux
  - Windows: [git-scm.com](https://git-scm.com)
  - Verify: `git --version`

### System Requirements
- **8GB RAM minimum** (16GB recommended for optimal performance)
- **10GB free disk space** (for Docker images and databases)
- **macOS, Linux, or Windows** with WSL2

### Optional but Recommended
- **API Keys** (for full LLM functionality):
  - OpenAI API key: [platform.openai.com](https://platform.openai.com)
  - Anthropic API key: [console.anthropic.com](https://console.anthropic.com)
  - Voyage AI API key: [dash.voyageai.com](https://dash.voyageai.com)

**Don't have API keys yet?** No problem! The platform works locally without them—you just won't be able to call external LLMs until you add keys.

---

## Step 1: Clone & Install (2 minutes)

### Clone the Repository

```bash
# Clone from GitHub
git clone https://github.com/adverant/Adverant-Nexus-Open-Core.git
cd Adverant-Nexus-Open-Core
```

### Install Dependencies

Adverant Nexus uses **npm workspaces** to manage all packages in a single command:

```bash
# Install all dependencies for services and packages
npm install
```

**What just happened?**
- Installed 10 infrastructure packages (`@adverant/logger`, `@adverant/database`, etc.)
- Installed dependencies for GraphRAG service
- Installed dependencies for MageAgent service
- Set up TypeScript, build tools, and testing frameworks

**Time: ~60-90 seconds** depending on your internet connection.

---

## Step 2: Start Services (2 minutes)

### Start All Services with Docker Compose

```bash
# Start databases and services
docker-compose -f docker-compose.test.yml up -d
```

**What's starting?**
- **PostgreSQL** (port 5432) - Structured data with Row-Level Security
- **Neo4j** (ports 7474, 7687) - Graph database for relationships
- **Qdrant** (ports 6333, 6334) - Vector search engine
- **Redis** (port 6379) - Caching and task queues
- **GraphRAG Service** (port 8090) - Triple-layer knowledge API
- **MageAgent Service** (port 8080) - Multi-agent orchestration

**Time: ~60-120 seconds** for Docker to pull images and start containers.

### Verify Services are Healthy

Wait about 60 seconds for all services to initialize, then check health:

```bash
# Check GraphRAG health
curl http://localhost:8090/health

# Expected response:
# {"status":"healthy","service":"graphrag","timestamp":"2024-01-03T..."}

# Check MageAgent health
curl http://localhost:8080/health

# Expected response:
# {"status":"healthy","service":"mageagent","timestamp":"2024-01-03T..."}
```

**Troubleshooting:**
- If services aren't healthy, wait another 30 seconds and retry
- Check Docker logs: `docker-compose -f docker-compose.test.yml logs`
- Ensure ports 8080, 8090, 5432, 6333, 6379, 7474, 7687 aren't in use

---

## Step 3: Your First API Calls (1 minute)

Now let's see the power of triple-layer GraphRAG in action.

### Store a Document in GraphRAG

```bash
curl -X POST http://localhost:8090/graphrag/api/v1/documents \
  -H "Content-Type: application/json" \
  -H "X-Company-ID: demo-company" \
  -H "X-App-ID: demo-app" \
  -d '{
    "content": "Adverant Nexus uses triple-layer storage architecture. PostgreSQL stores structured data with Row-Level Security for multi-tenant isolation. Neo4j maintains entity relationships and enables graph traversal queries. Qdrant provides semantic vector search for finding conceptually similar content. This architecture preserves 30-50% more information than single-store RAG systems.",
    "metadata": {
      "title": "Triple-Layer Architecture Overview",
      "type": "technical-documentation",
      "author": "Adverant Engineering",
      "tags": ["architecture", "graphrag", "storage"]
    }
  }'
```

**Expected response:**
```json
{
  "success": true,
  "documentId": "doc_abc123...",
  "message": "Document indexed successfully across all layers",
  "layers": {
    "postgresql": "stored",
    "neo4j": "entities_extracted",
    "qdrant": "vectors_indexed"
  }
}
```

**What just happened?**
1. **PostgreSQL** stored the full document with metadata in structured tables
2. **Neo4j** extracted entities (Adverant Nexus, PostgreSQL, Neo4j, Qdrant) and their relationships
3. **Qdrant** generated semantic embeddings and indexed vectors for similarity search

### Search with Semantic Understanding

Now retrieve the document using natural language:

```bash
curl -X POST http://localhost:8090/graphrag/api/retrieve/enhanced \
  -H "Content-Type: application/json" \
  -H "X-Company-ID: demo-company" \
  -H "X-App-ID: demo-app" \
  -d '{
    "query": "How does Nexus store and manage knowledge?",
    "limit": 5,
    "includeEpisodic": true
  }'
```

**Expected response:**
```json
{
  "results": [
    {
      "content": "Adverant Nexus uses triple-layer storage architecture...",
      "score": 0.92,
      "source": "vector_search",
      "metadata": {
        "title": "Triple-Layer Architecture Overview",
        "type": "technical-documentation"
      }
    }
  ],
  "searchStrategy": "enhanced_retrieval",
  "layersSearched": ["postgresql", "neo4j", "qdrant"],
  "totalResults": 1
}
```

**What just happened?**
1. **Enhanced retrieval** searched all three layers simultaneously:
   - PostgreSQL: Filtered by metadata (type, tags)
   - Neo4j: Found related entities and relationships
   - Qdrant: Semantic similarity search with embeddings
2. **Results merged** and ranked by relevance score
3. **30-50% better recall** than single-vector-store RAG

### Orchestrate Multiple Agents

Use MageAgent to analyze the content with an LLM:

**Note:** This requires an API key. If you don't have one yet, skip to "What Just Happened?" below.

```bash
curl -X POST http://localhost:8080/mageagent/api/v1/tasks \
  -H "Content-Type: application/json" \
  -H "X-Company-ID: demo-company" \
  -H "X-App-ID: demo-app" \
  -d '{
    "prompt": "Retrieve information about Nexus storage architecture and explain the key benefits in 3 bullet points.",
    "model": "claude-3-5-sonnet-20241022",
    "stream": false,
    "context": {
      "useGraphRAG": true,
      "graphragQuery": "storage architecture benefits"
    }
  }'
```

**Expected response:**
```json
{
  "taskId": "task_xyz789...",
  "status": "completed",
  "result": {
    "content": "Based on the retrieved information:\n\n• **No Information Loss**: Triple-layer architecture preserves structured data, relationships, and semantic meaning—30-50% better recall than single-store systems\n• **Multi-Modal Search**: Enables exact matches (PostgreSQL), graph traversal (Neo4j), and semantic similarity (Qdrant) in a single query\n• **Production-Ready Multi-Tenancy**: Built-in Row-Level Security and namespace isolation for enterprise deployments",
    "model": "claude-3-5-sonnet-20241022",
    "tokensUsed": 245
  },
  "retrievedContext": [
    {
      "content": "Adverant Nexus uses triple-layer storage architecture...",
      "score": 0.92
    }
  ]
}
```

**What just happened?**
1. **MageAgent** received your prompt
2. **GraphRAG retrieval** searched for relevant context ("storage architecture")
3. **LLM (Claude)** analyzed the retrieved information
4. **Agent synthesized** the response with citations
5. **Async task management** handled the workflow with BullMQ queues

---

## Step 4: Explore the Architecture (5 minutes)

### Verify Data Across All Layers

**Check PostgreSQL (structured data):**
```bash
docker exec -it nexus-test-postgres psql -U nexus -d nexus_test -c \
  "SELECT id, title, type FROM documents LIMIT 5;"
```

**Check Neo4j (graph relationships):**
1. Open Neo4j Browser: [http://localhost:7474](http://localhost:7474)
2. Login: `neo4j` / `nexus_test_password`
3. Run Cypher query:
   ```cypher
   MATCH (n) RETURN n LIMIT 25
   ```
4. See entities and relationships visualized as a graph

**Check Qdrant (vector search):**
```bash
curl http://localhost:6333/collections/memories
```

Expected: Collection info with vector count, dimensions, indexed points.

### Understanding the Service Architecture

```
Your Application
       │
       ▼
┌─────────────────────────────────────┐
│         API Gateway (Future)         │  ← Authentication, rate limiting
└────────────┬────────────────────────┘
             │
      ┌──────┴──────┐
      ▼             ▼
┌─────────────┐  ┌─────────────┐
│  GraphRAG   │  │  MageAgent  │
│  :8090      │  │  :8080      │      ← Your entry points
└──────┬──────┘  └──────┬──────┘
       │                │
       └────────┬───────┘
                ▼
┌───────────────────────────────────────┐
│          Data Layer                   │
│  ┌──────┐ ┌──────┐ ┌──────┐ ┌─────┐ │
│  │ PG   │ │ Neo4j│ │Qdrant│ │Redis│ │  ← Managed by services
│  └──────┘ └──────┘ └──────┘ └─────┘ │
└───────────────────────────────────────┘
```

**Key Points:**
- **GraphRAG (:8090)** manages all three storage layers transparently
- **MageAgent (:8080)** orchestrates LLM calls and tools
- **Services communicate** via REST APIs (internal) and WebSocket (streaming)
- **Data persistence** in PostgreSQL, Neo4j, Qdrant volumes
- **Caching & queues** in Redis

---

## Step 5: Add Your API Keys (Optional)

To use external LLMs (OpenAI, Anthropic, Google), add API keys:

### Create Environment File

```bash
# Copy example environment file
cp services/nexus-mageagent/.env.example services/nexus-mageagent/.env
```

### Edit .env File

```bash
# Open in your editor
nano services/nexus-mageagent/.env
```

**Add your keys:**
```bash
# OpenAI (GPT-4, GPT-3.5)
OPENAI_API_KEY=sk-proj-your-key-here

# Anthropic (Claude 3.5 Sonnet, Opus, Haiku)
ANTHROPIC_API_KEY=sk-ant-api03-your-key-here

# Voyage AI (embeddings)
VOYAGE_API_KEY=pa-your-key-here

# Google Gemini (optional)
GOOGLE_API_KEY=your-key-here

# OpenRouter (optional - access to 320+ models)
OPENROUTER_API_KEY=sk-or-your-key-here
```

### Restart MageAgent Service

```bash
docker-compose -f docker-compose.test.yml restart mageagent
```

**Now you have access to:**
- ✅ **OpenAI GPT-4, GPT-3.5 Turbo**
- ✅ **Anthropic Claude 3.5 Sonnet, Opus, Haiku**
- ✅ **Google Gemini Pro, Ultra**
- ✅ **320+ models via OpenRouter** (Llama 3, Mixtral, Qwen, etc.)

---

## Next Steps: What to Build

### 🎯 Beginner Tutorials (30-60 minutes each)

1. **[Build a RAG Chatbot](tutorials/rag-chatbot.md)**
   - Create a conversational AI with document memory
   - Implement streaming responses
   - Add chat history and context

2. **[Create a Custom Agent](tutorials/custom-agent.md)**
   - Define agent roles and capabilities
   - Implement custom tools (web search, calculator, etc.)
   - Chain multiple agents together

3. **[Implement Multi-Tenant App](tutorials/multi-tenant-setup.md)**
   - Use company-id and app-id headers
   - Configure Row-Level Security in PostgreSQL
   - Isolate data between tenants

### 🚀 Advanced Tutorials (60-120 minutes each)

4. **[Self-Correcting RAG](tutorials/self-correcting-rag.md)**
   - Enable modular RAG with quality monitoring
   - Configure retrieval strategy optimization
   - A/B test different approaches

5. **[Deploy to Kubernetes](tutorials/kubernetes-deployment.md)**
   - Prepare production K8s cluster
   - Configure Istio service mesh
   - Set up monitoring (Prometheus, Grafana, Jaeger)

6. **[Build a Domain Plugin](tutorials/domain-plugin.md)**
   - Plugin architecture overview
   - Implement MCP container
   - Register in marketplace

### 📚 Deep Dives

- **[Architecture Documentation](architecture/)** - Detailed component design
- **[API Reference](api/)** - Complete endpoint documentation
- **[Migration Guides](migration/)** - Move from LangChain, LlamaIndex, etc.
- **[50+ Use Cases](use-cases/)** - Knowledge management, content generation, data analysis

---

## Troubleshooting Common Issues

### Services Won't Start

**Problem:** `docker-compose up -d` fails or services show as unhealthy

**Solutions:**
1. **Check Docker is running:**
   ```bash
   docker ps
   ```
   If this fails, start Docker Desktop.

2. **Check port conflicts:**
   ```bash
   # macOS/Linux
   lsof -i :8080
   lsof -i :8090
   lsof -i :5432
   lsof -i :6379
   lsof -i :7474
   ```
   Kill conflicting processes or change ports in `docker-compose.test.yml`.

3. **Check Docker logs:**
   ```bash
   docker-compose -f docker-compose.test.yml logs graphrag
   docker-compose -f docker-compose.test.yml logs mageagent
   ```
   Look for errors like "port already in use" or "connection refused".

4. **Increase Docker memory:**
   - Docker Desktop → Settings → Resources → Memory → 8GB minimum

5. **Clean restart:**
   ```bash
   docker-compose -f docker-compose.test.yml down
   docker-compose -f docker-compose.test.yml up -d --force-recreate
   ```

### API Calls Return Errors

**Problem:** `curl` commands return 500 errors or connection refused

**Solutions:**
1. **Wait for startup:**
   Services need 60-120 seconds to fully initialize. Check health endpoints.

2. **Check service logs:**
   ```bash
   docker-compose -f docker-compose.test.yml logs -f graphrag
   ```

3. **Verify database connections:**
   - GraphRAG needs PostgreSQL, Neo4j, Qdrant, Redis
   - Check `docker ps` shows all containers as "healthy"

4. **Check request headers:**
   - `X-Company-ID` and `X-App-ID` are required
   - `Content-Type: application/json` for POST requests

### TypeScript Compilation Errors

**Problem:** `npm install` shows TypeScript errors

**Solutions:**
1. **Use tsx runtime (recommended):**
   Services use `tsx` to run TypeScript without strict compilation.

2. **Check Node.js version:**
   ```bash
   node --version  # Must be v20.x or higher
   ```

3. **Clean install:**
   ```bash
   rm -rf node_modules package-lock.json
   npm install
   ```

### Out of Memory Errors

**Problem:** Services crash with "JavaScript heap out of memory"

**Solutions:**
1. **Increase Node.js memory:**
   Already configured in `docker-compose.test.yml` (4GB for MageAgent, 2GB for GraphRAG).

2. **Reduce concurrent operations:**
   - Lower `MAX_CONCURRENT_AGENTS` in `.env`
   - Process fewer documents at once

3. **Upgrade system RAM:**
   - 16GB recommended for optimal performance

---

## Clean Up

### Stop All Services

```bash
# Stop services but keep data
docker-compose -f docker-compose.test.yml stop
```

### Remove Everything (Including Data)

```bash
# ⚠️ WARNING: This deletes all data!
docker-compose -f docker-compose.test.yml down -v
```

### Remove Docker Images

```bash
# Free up disk space (safe, can re-pull later)
docker-compose -f docker-compose.test.yml down --rmi all
```

---

## Performance Benchmarks (What to Expect)

### Startup Time
- **First run**: 3-5 minutes (Docker pulls images)
- **Subsequent runs**: 60-120 seconds (containers already built)

### API Latency
- **Document storage**: 100-300ms (includes all 3 layers)
- **Semantic search**: 50-150ms (vector similarity)
- **Enhanced retrieval**: 200-500ms (all layers + ranking)
- **Agent task (with LLM)**: 2-10 seconds (depends on model)

### Throughput
- **Documents/second**: 10-50 (limited by vector embedding speed)
- **Search queries/second**: 100-500 (cached results much faster)
- **Concurrent agents**: 5-10 (configurable, memory-limited)

### Resource Usage (Local Development)
- **PostgreSQL**: ~300MB RAM
- **Neo4j**: ~1GB RAM (includes JVM)
- **Qdrant**: ~500MB RAM (grows with data)
- **Redis**: ~100MB RAM
- **GraphRAG Service**: ~500MB RAM
- **MageAgent Service**: ~800MB RAM
- **Total**: ~3.2GB RAM (fits comfortably in 8GB system)

---

## Join the Community

### Get Help & Share Your Build

- **[Discord](https://discord.gg/adverant)** - Chat with developers, get help, share what you're building
- **[GitHub Discussions](https://github.com/adverant/Adverant-Nexus-Open-Core/discussions)** - Q&A, feature requests, ideas
- **[Stack Overflow](https://stackoverflow.com/questions/tagged/adverant-nexus)** - Tag: `adverant-nexus`

### Contribute to the Project

- **[Contributing Guide](../CONTRIBUTING.md)** - Code standards and PR process
- **[Good First Issues](https://github.com/adverant/Adverant-Nexus-Open-Core/labels/good%20first%20issue)** - Start here!
- **[Roadmap](https://github.com/adverant/Adverant-Nexus-Open-Core/projects)** - See what's planned

### Stay Updated

- **[Twitter @adverant](https://twitter.com/adverant)** - Product updates
- **[Blog](https://adverant.ai/blog)** - Technical deep-dives
- **[YouTube](https://youtube.com/@adverant)** - Video tutorials

---

## What's Next?

You now have **production-grade AI infrastructure** running locally. Here's what you can do:

### Option 1: Build Your First RAG Chatbot (30 min)
➡️ **[RAG Chatbot Tutorial](tutorials/rag-chatbot.md)** - Full conversational AI with memory

### Option 2: Explore the API
➡️ **[GraphRAG API Reference](api/graphrag.md)** - 42 REST endpoints
➡️ **[MageAgent API Reference](api/mageagent.md)** - Multi-agent orchestration

### Option 3: Deploy to Production
➡️ **[Kubernetes Deployment Guide](tutorials/kubernetes-deployment.md)** - K8s + Istio + monitoring

### Option 4: Use the Managed Cloud
Skip self-hosting and get **1,000 free requests/month**:
➡️ **[Sign up for free tier](https://dashboard.adverant.ai/signup)** (no credit card)

### Option 5: Migrate from Existing Tools
Already using LangChain, LlamaIndex, or Pinecone?
➡️ **[Migration Guides](migration/)** - Step-by-step with code examples

---

**Congratulations!** You've successfully deployed Adverant Nexus Open Core and experienced production-grade AI infrastructure firsthand.

**Questions or issues?** [Open a GitHub issue](https://github.com/adverant/Adverant-Nexus-Open-Core/issues) or [join Discord](https://discord.gg/adverant).

---

**[← Back to README](../README.md)** | **[Next: Architecture Overview →](architecture/README.md)**
