# Adverant Nexus Open Core

**Production-ready AI orchestration platform with GraphRAG knowledge management and multi-agent coordination.**

[![License: Apache 2.0](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](LICENSE-APACHE-2.0)
[![Kubernetes](https://img.shields.io/badge/Kubernetes-Native-326CE5?logo=kubernetes)](https://kubernetes.io)
[![Deploy](https://img.shields.io/badge/Deploy-Edge%20to%20Cloud-success)](docs/edge-deployment.md)

---

## 🎯 What is Adverant Nexus?

The **only open-source AI platform** that scales from edge devices to enterprise cloud:

- **🧠 Triple-Layer GraphRAG**: PostgreSQL + Neo4j + Qdrant in unified API
- **🤖 320+ LLM Models**: Intelligent routing across OpenAI, Anthropic, Google, and more
- **🔄 Multi-Agent Orchestration**: Production-grade async task management
- **📦 Kubernetes-Native**: Deploy from 2GB drones to 200TB data centers
- **🌐 Edge-First**: Works offline on Jetson, Raspberry Pi, autonomous vehicles

---

## 🚀 Quick Start

### Edge Deployment (Jetson, Raspberry Pi, Drones)
```bash
curl -sSL https://get.nexus.ai/edge | sh
```

### Standard Deployment (4GB+ RAM)
```bash
# Clone repository
git clone https://github.com/adverant/Adverant-Nexus-Open-Core.git
cd Adverant-Nexus-Open-Core

# Start with Docker Compose
docker-compose up -d

# Access dashboard
open http://localhost:3000
```

### Kubernetes Deployment
```bash
# Deploy to existing K8s cluster
kubectl kustomize k8s/overlays/dev | kubectl apply -f -

# Or use K3s on single node
curl -sfL https://get.k3s.io | sh -
./scripts/deploy-edge.sh
```

---

## 📦 What's Included (Open Source - Apache 2.0)

### Core Services
- **GraphRAG Core**: Triple-layer knowledge management (PostgreSQL + Neo4j + Qdrant)
- **MageAgent**: Multi-agent orchestration with 320+ LLM models
- **API Gateway**: Unified async API with WebSocket support
- **Nexus Auth**: OAuth, JWT authentication
- **Nexus Sandbox**: Secure code execution (37+ languages)

### Edge Edition (New!)
- **GraphRAG Lite**: SQLite backend, FAISS vectors, 650MB RAM
- **MageAgent Lite**: Single-agent mode, local inference, 512MB RAM
- **Total Footprint**: ~1.5GB RAM (perfect for edge devices)

### Shared Packages (23+ utilities)
- Configuration management
- Service discovery
- Logging, caching, error handling
- OpenTelemetry integration

---

## 🌍 Deploy Anywhere

| Environment | Resources | Use Case |
|-------------|-----------|----------|
| **Edge** | 2GB RAM, 2 cores | Drones, autonomous vehicles, IoT |
| **Development** | 4GB RAM, 4 cores | Local development, testing |
| **Production** | 16GB+ RAM, 8+ cores | Enterprise workloads |

### Supported Platforms
- ✅ NVIDIA Jetson (Nano, Xavier, Orin)
- ✅ Raspberry Pi 4/5
- ✅ Autonomous vehicles
- ✅ Drones
- ✅ Factory robots
- ✅ Kubernetes clusters (K3s, K8s, EKS, GKE, AKS)

---

## 📚 Documentation

- [Getting Started](docs/getting-started.md)
- [Architecture](docs/architecture.md)
- [Edge Deployment](docs/edge-deployment.md)
- [API Reference](docs/api-reference.md)
- [Contributing](CONTRIBUTING.md)

---

## 💼 Enterprise Edition

Need advanced features? Check out [Adverant Nexus Enterprise](https://adverant.ai):

| Feature | Open Source | Enterprise |
|---------|-------------|------------|
| GraphRAG Core | ✅ | ✅ |
| Multi-Agent | ✅ Basic | ✅ Advanced |
| Edge Deployment | ✅ | ✅ |
| Self-Correcting RAG | ❌ | ✅ |
| Autonomous Loops | ❌ | ✅ |
| GDPR Compliance | ❌ | ✅ |
| Domain Plugins | ❌ | ✅ (CRM, Medical, Legal) |
| Enterprise Support | ❌ | ✅ |

**Managed Cloud**: [dashboard.adverant.ai](https://dashboard.adverant.ai) (Free tier available)

---

## 🤝 Contributing

We welcome contributions! See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

**Community**:
- [Discord](https://discord.gg/adverant) - Chat with the community
- [GitHub Discussions](https://github.com/adverant/Adverant-Nexus-Open-Core/discussions) - Q&A and ideas
- [Twitter](https://twitter.com/adverant) - Latest updates

---

## 📄 License

**Dual-licensed**:
- **Open Source Core**: [Apache License 2.0](LICENSE-APACHE-2.0)
- **Enterprise Features**: See [LICENSE-COMMERCIAL](LICENSE-COMMERCIAL)

See [.visibility.json](.visibility.json) for detailed file-to-license mapping.

---

## ⭐ Star History

If you find this project useful, please consider giving it a star! ⭐

---

## 🙏 Acknowledgments

Built with:
- [PostgreSQL](https://www.postgresql.org/) - Structured data
- [Neo4j](https://neo4j.com/) - Graph relationships
- [Qdrant](https://qdrant.tech/) - Vector search
- [Redis](https://redis.io/) - Caching
- [Kubernetes](https://kubernetes.io/) - Orchestration

---

**Made with ❤️ by [Adverant](https://adverant.ai)**
