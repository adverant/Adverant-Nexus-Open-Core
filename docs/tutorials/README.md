# Tutorials

Step-by-step guides for building with Adverant Nexus.

---

## Quick Start Tutorials

### 1. Build a RAG Chatbot (30 minutes)

**What You'll Build**: A chatbot that answers questions using your documentation

**Prerequisites**:
- Nexus Open Core installed (see [Getting Started](../getting-started.md))
- Node.js 20+
- Basic TypeScript knowledge

**Steps**:
1. Set up GraphRAG service
2. Ingest documentation (Markdown files)
3. Build chat API endpoint
4. Create simple web UI
5. Test Q&A functionality

**Technologies**: GraphRAG, MageAgent, Express.js, React

**[View Full Tutorial →](rag-chatbot.md)**

---

### 2. Create a Custom Agent (45 minutes)

**What You'll Build**: A specialized agent with custom tools

**Prerequisites**:
- Completed RAG Chatbot tutorial
- Understanding of async/await patterns

**Steps**:
1. Define agent role and capabilities
2. Implement custom tools (API calls, calculations)
3. Register agent with MageAgent service
4. Test multi-agent collaboration
5. Add error handling and retries

**Technologies**: MageAgent, Custom tools, BullMQ

**[View Full Tutorial →](custom-agent.md)**

---

### 3. Implement Self-Correcting RAG (60 minutes)

**What You'll Build**: RAG system that automatically improves retrieval quality

**Prerequisites**:
- Completed RAG Chatbot tutorial
- Understanding of GraphRAG architecture

**Steps**:
1. Enable modular RAG strategies
2. Configure quality thresholds
3. Implement fallback retrieval methods
4. Monitor improvements
5. A/B test retrieval strategies

**Technologies**: GraphRAG, Quality metrics, A/B testing

**[View Full Tutorial →](self-correcting-rag.md)**

---

### 4. Deploy to Kubernetes (90 minutes)

**What You'll Build**: Production-ready K8s deployment

**Prerequisites**:
- K8s cluster (local K3s, EKS, GKE, or AKS)
- kubectl installed
- Docker images built

**Steps**:
1. Prepare Kubernetes cluster
2. Configure persistent volumes
3. Deploy databases (PostgreSQL, Neo4j, Qdrant, Redis)
4. Deploy Nexus services
5. Set up monitoring (Prometheus, Grafana)
6. Configure Istio service mesh (optional)

**Technologies**: Kubernetes, Helm, Istio, Prometheus

**[View Full Tutorial →](kubernetes-deployment.md)**

---

## Migration Guides

### From LangChain to Nexus

**Time**: 2-4 hours for typical application

**Key Differences**:
- LangChain: Single vector store → Nexus: Triple-layer storage
- LangChain: DIY observability → Nexus: OpenTelemetry built-in
- LangChain: Sync calls → Nexus: Async task patterns

**Migration Steps**:
1. Map LangChain components to Nexus equivalents
2. Convert vector store calls to GraphRAG API
3. Replace LLM chains with MageAgent tasks
4. Update error handling patterns
5. Test and validate

**[View Full Guide →](../migration/langchain-to-nexus.md)**

---

### From LlamaIndex to Nexus

**Time**: 2-3 hours for typical application

**Key Differences**:
- LlamaIndex: Index-centric → Nexus: Multi-store architecture
- LlamaIndex: Query engine → Nexus: MageAgent orchestration
- LlamaIndex: Local only → Nexus: Cloud-ready

**[View Full Guide →](../migration/llamaindex-to-nexus.md)**

---

## Best Practices Guides

### Production Monitoring

**Topics**:
- OpenTelemetry setup
- Custom metrics
- Log aggregation
- Alert configuration
- Performance profiling

**[View Guide →](production-monitoring.md)**

---

### Performance Tuning

**Topics**:
- Database indexing strategies
- Vector search optimization
- Query result caching
- Connection pooling
- Horizontal scaling

**[View Guide →](performance-tuning.md)**

---

### Security Best Practices

**Topics**:
- Authentication and authorization
- API key management
- Data encryption (at rest and in transit)
- Network security
- GDPR/HIPAA compliance

**[View Guide →](security-best-practices.md)**

---

## Example Projects

### Complete Applications

All examples include:
- Full source code (TypeScript)
- Docker Compose setup
- README with setup instructions
- Tests

**1. Document Q&A System**
- Repository: `examples/document-qa`
- Features: PDF ingestion, semantic search, web UI
- Time to run: 10 minutes

**2. Support Ticket Assistant**
- Repository: `examples/support-assistant`
- Features: Zendesk integration, auto-responses
- Time to run: 15 minutes

**3. Research Paper Library**
- Repository: `examples/research-library`
- Features: arXiv import, citation network
- Time to run: 20 minutes

**[Browse All Examples →](https://github.com/adverant/Adverant-Nexus-Open-Core/tree/main/examples)**

---

## Video Tutorials

Coming soon:
- YouTube channel: @AdverantAI
- Topics: Quick start, advanced features, production deployment

---

## Community Resources

- **[GitHub Discussions](https://github.com/adverant/Adverant-Nexus-Open-Core/discussions)** - Ask questions
- **[Discord](https://discord.gg/adverant)** - Real-time help
- **[Blog](https://adverant.ai/blog)** - Tutorials and updates

---

**📄 License**: Apache 2.0 + Elastic License 2.0
**🔗 Repository**: [github.com/adverant/Adverant-Nexus-Open-Core](https://github.com/adverant/Adverant-Nexus-Open-Core)
