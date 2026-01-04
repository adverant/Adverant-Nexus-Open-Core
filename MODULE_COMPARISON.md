# Module Comparison: Open Core vs Private Nexus

**Last Updated:** 2026-01-04

This document compares the modules in **Adverant Nexus Open Core** (public) vs **Adverant Nexus** (private).

---

## 📊 Overview

| Category | Private Nexus | Open Core | Difference |
|----------|---------------|-----------|------------|
| **Total Modules** | 80 | 16 | -64 modules |
| **Infrastructure Packages** | 15 | 11 | -4 packages |
| **Services** | 65 | 5 | -60 services |
| **Public %** | 100% | 20% | Open source core |

---

## ✅ Modules in Open Core (16 total)

### Infrastructure Packages (11)

These are the **foundational building blocks** for any AI platform:

| Package | Description | Status |
|---------|-------------|--------|
| **adverant-cache** | Redis caching utilities | ✅ Public |
| **adverant-config** | Environment configuration management | ✅ Public |
| **adverant-database** | PostgreSQL/database utilities | ✅ Public |
| **adverant-errors** | Standardized error handling | ✅ Public |
| **adverant-event-bus** | Event-driven architecture | ✅ Public |
| **adverant-logger** | Structured logging with Winston | ✅ Public |
| **adverant-resilience** | Circuit breakers, retry logic | ✅ Public |
| **nexus-routing** | Service routing | ✅ Public |
| **nexus-telemetry** | OpenTelemetry integration | ✅ Public |
| **voyage-ai-client** | Voyage AI embeddings client | ✅ Public |
| **nexus-cli** | Command-line interface for Nexus platform | ✅ Public |

### Core Services (5)

These are the **essential AI platform services**:

| Service | Description | Status |
|---------|-------------|--------|
| **nexus-graphrag** | Triple-layer GraphRAG (PostgreSQL + Neo4j + Qdrant) | ✅ Public |
| **nexus-mageagent** | Multi-agent orchestration (320+ LLM models) | ✅ Public |
| **nexus-plugin-system** | Zero-config plugin system | ✅ Public |
| **nexus-fileprocess** | Advanced file processing with Dockling-level accuracy | ✅ Public (NEW!) |
| **nexus-cli** | World-class CLI surpassing Claude Code and Gemini | ✅ Public (NEW!) |

---

## 🔒 Modules Only in Private Nexus (64 total)

### Missing Infrastructure Packages (4)

| Package | Description | Why Private |
|---------|-------------|-------------|
| **adverant-memory-storage** | Advanced memory management | Enterprise feature |
| **adverant-service-mesh** | Service mesh integration | Enterprise feature |
| **adverant-ui** | Admin UI components | Commercial product |
| **adverant-vertex-ai** | Google Vertex AI integration | Enterprise feature |
| **mcp** | Model Context Protocol (enterprise) | Enterprise feature |

### Missing Services (60)

#### 🏢 Enterprise Platform Services

| Service | Description | Category |
|---------|-------------|----------|
| nexus-analytics | Usage analytics & insights | Enterprise |
| nexus-api-gateway | Full API gateway with routing | Enterprise |
| nexus-auth | Advanced authentication | Enterprise |
| nexus-billing | Subscription & billing | Commercial |
| nexus-cluster-admin | Multi-cluster management | Enterprise |
| nexus-compliance | GDPR/HIPAA compliance | Enterprise |
| nexus-gateway | Production API gateway | Enterprise |
| nexus-hpc-gateway | HPC cluster integration | Enterprise |
| nexus-marketplace | Plugin marketplace | Commercial |
| nexus-mcp-gateway | MCP server gateway | Enterprise |
| nexus-orchestration | Advanced orchestration | Enterprise |
| nexus-plugins | Plugin management service | Enterprise |
| nexus-provisioner | Auto-provisioning | Enterprise |
| nexus-sdk | JavaScript/TypeScript SDK | Enterprise |
| nexus-security | Advanced security features | Enterprise |
| nexus-workspace | Multi-workspace management | Enterprise |

#### 🔌 Domain-Specific Plugins/Services

| Service | Domain | Category |
|---------|--------|----------|
| nexus-atelier | Creative workflows | Plugin |
| nexus-calendar-connector | Calendar integration | Plugin |
| nexus-channel-manager | Multi-channel mgmt | Plugin |
| nexus-cleaning | Cleaning workflows | Plugin |
| nexus-communication | Communication hub | Plugin |
| nexus-computer-vision | CV/image processing | Plugin |
| nexus-crm | CRM functionality | Plugin |
| nexus-cyberagent | Cybersecurity | Plugin |
| nexus-damage-tracking | Damage assessment | Plugin |
| nexus-doc | Document generation | Plugin |
| nexus-email-connector | Email integration | Plugin |
| nexus-geoagent | Geographic AI | Plugin |
| nexus-guest-experience | Guest services | Plugin |
| nexus-inventory | Inventory management | Plugin |
| nexus-law | Legal document analysis | Plugin |
| nexus-pricing | Dynamic pricing | Plugin |
| nexus-property-management | Property mgmt | Plugin |
| nexus-prosecreator | Content generation | Plugin |
| nexus-prosecreator-audiobook | Audiobook creation | Plugin |
| nexus-prosecreator-marketing | Marketing content | Plugin |
| nexus-prosecreator-publisher | Publishing workflows | Plugin |
| nexus-reposwarm | Repository analysis | Plugin |
| nexus-robotics | Robotics control | Plugin |
| nexus-smart-lock | IoT smart locks | Plugin |
| nexus-videoagent | Video processing | Plugin |

#### 🛠️ Developer Tools & Infrastructure

| Service | Description | Category |
|---------|-------------|----------|
| nexus-browser-worker | Browser automation | Tool |
| nexus-cli-sdk | CLI SDK | Tool |
| nexus-collab | Real-time collaboration | Tool |
| nexus-cvat-auth-proxy | CVAT auth proxy | Tool |
| nexus-desktop-extension | Desktop app integration | Tool |
| nexus-forge-proxy | Code forge proxy | Tool |
| nexus-github-manager | GitHub integration | Tool |
| nexus-jupyter-auth-proxy | Jupyter auth proxy | Tool |
| nexus-learningagent | Learning/training agent | Tool |
| nexus-media-upload | Media upload service | Tool |
| nexus-plugin-sdk | Plugin development SDK | Tool |
| nexus-plugin-verifier | Plugin security verification | Tool |
| nexus-sandbox | Sandboxed execution | Tool |
| nexus-terminal-computer | Terminal access | Tool |

#### 🧪 Experimental/Special Purpose

| Service | Description | Category |
|---------|-------------|----------|
| capture-common | Screen capture common | Experimental |
| n8n-nodes-nexus | n8n integration nodes | Integration |
| nested-learning-coordinator | Advanced ML coordination | Experimental |
| nexus-alive | Health monitoring | Utility |
| nexus-graphrag-enhanced | Enhanced GraphRAG features | Enterprise |

---

## 🎯 Open Core Strategy

### What's Public (Philosophy)

**✅ Include in Open Core:**
1. **Foundation** - Core infrastructure packages that 70-90% of projects need
2. **Platform** - GraphRAG and MageAgent as the essential AI services
3. **Extensibility** - Plugin system for community contributions
4. **No Lock-In** - Everything needed to build production AI platforms

**Goal:** Enable developers to build production-grade AI platforms 3-6× faster.

### What's Private (Philosophy)

**🔒 Keep Private:**
1. **Enterprise Features** - Advanced compliance, multi-tenancy, analytics
2. **Commercial Services** - Marketplace, billing, provisioning
3. **Domain Plugins** - Vertical-specific solutions (Law, CRM, Property Mgmt)
4. **Advanced Tooling** - Enterprise-grade security, admin dashboards

**Goal:** Monetize through enterprise features and domain-specific plugins.

---

## 📈 Growth Path

### Phase 1: Current State (v1.0.0) ✅
- ✅ 10 infrastructure packages
- ✅ 2 core services (GraphRAG, MageAgent)
- ✅ Plugin system foundation
- **Maturity:** 85%

### Phase 2: Community Building (Q1 2026)
- Add plugin marketplace integration
- Create 5+ example community plugins
- Publish infrastructure packages to npm
- Enable plugin discovery

### Phase 3: Feature Expansion (Q2 2026) ✅ COMPLETED EARLY
- ✅ nexus-fileprocess (advanced file processing) - Released v1.0.0
- ✅ nexus-cli (command-line interface) - Released v2.0.0
- Consider open-sourcing:
  - Basic nexus-auth (authentication)
- Add more infrastructure packages:
  - Graph utilities
  - Vector operations
  - MCP implementation

### Phase 4: Enterprise Differentiation (Q3-Q4 2026)
- Clear separation: Open Core vs Enterprise
- Enterprise features:
  - Multi-workspace management
  - Advanced analytics
  - Compliance automation
  - Priority support

---

## 🔄 Module Migration Strategy

### Candidates for Open Source (Future)

**High Priority:**
| Module | Why Open Source | Timeline |
|--------|-----------------|----------|
| ~~nexus-fileprocess~~ | ~~Community benefit, differentiate on scale~~ | ✅ Released v1.0.0 |
| ~~nexus-cli~~ | ~~Developer adoption driver~~ | ✅ Released v2.0.0 |
| Basic auth features | Standard requirement | Q2 2026 |

**Medium Priority:**
| Module | Why Open Source | Timeline |
|--------|-----------------|----------|
| nexus-browser-worker | Useful for automation | Q3 2026 |
| nexus-sandbox | Safe execution environment | Q3 2026 |

**Low Priority (Stay Private):**
| Module | Why Private | Timeline |
|--------|-------------|----------|
| All domain plugins | Commercial differentiator | Indefinite |
| Enterprise features | Revenue driver | Indefinite |
| Marketplace | Commercial service | Indefinite |

---

## 📊 Comparison Summary

### Infrastructure Packages
- **Private:** 15 packages
- **Open Core:** 11 packages (73% coverage) ⬆️ +1
- **Gap:** 4 enterprise packages

### Services
- **Private:** 65 services
- **Open Core:** 5 services (8% coverage) ⬆️ +2
- **Gap:** 60 enterprise/plugin services

### Philosophy
- **Open Core:** "Everything you need to build production AI platforms"
- **Private:** "Enterprise features + domain-specific solutions"

---

## 🎯 Key Differences Explained

### 1. Infrastructure (67% Open)
Open Core has the **essential infrastructure** most projects need:
- Logging, caching, database, errors, events, resilience
- Enough to build 80% of use cases

Private adds **enterprise infrastructure**:
- Advanced memory management
- Service mesh integration
- Vertex AI integration
- Enterprise UI components

### 2. Core Services (100% Open for Platform)
Open Core has **complete platform services**:
- GraphRAG: Full triple-layer implementation
- MageAgent: Full multi-agent orchestration
- Plugin System: Full extensibility

Private adds **enterprise platform features**:
- Enhanced GraphRAG with advanced features
- Enterprise orchestration
- Advanced security
- Multi-cluster management

### 3. Domain Services (0% Open)
**All domain plugins are private**:
- Law, CRM, Property Management, etc.
- These are commercial differentiators
- Community can build their own via plugin system

### 4. Developer Tools (Partial Open)
Open Core has:
- Plugin system
- Documentation
- Examples

Private adds:
- Full CLI
- Desktop extensions
- Browser automation
- Plugin marketplace
- SDK

---

## 💡 Strategic Rationale

### Why This Split?

1. **Open Core Provides Value**
   - Real production capabilities
   - Not a "bait and switch"
   - Actually cuts development time 3-6×

2. **Clear Upgrade Path**
   - Enterprise gets: compliance, analytics, multi-tenancy
   - Domain plugins: vertical-specific solutions
   - Commercial marketplace

3. **Community Can Thrive**
   - Plugin system enables contributions
   - Infrastructure is extensible
   - No artificial limitations

4. **Revenue Sustainability**
   - Enterprise features justify pricing
   - Domain plugins are high-value
   - Support and SLA differentiation

---

## 📞 Questions?

- **Missing a module?** Request it: [GitHub Discussions](https://github.com/adverant/Adverant-Nexus-Open-Core/discussions)
- **Want to contribute?** See [CONTRIBUTING.md](CONTRIBUTING.md)
- **Enterprise features?** Contact: enterprise@adverant.ai

---

**Last Updated:** 2026-01-04
**Open Core Version:** 1.1.0 (added nexus-cli v2.0.0 and nexus-fileprocess v1.0.0)
**Private Nexus Modules:** 80
**Open Core Modules:** 16 (20% of total)
