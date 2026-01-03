# Changelog

All notable changes to Adverant Nexus Open Core will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- Community health files (CODE_OF_CONDUCT.md, SECURITY.md, GOVERNANCE.md)
- Plugin system architecture for domain-specific extensions
- Comprehensive documentation structure
- GitHub issue and PR templates
- Automated CI/CD workflows

### Changed
- N/A

### Deprecated
- N/A

### Removed
- N/A

### Fixed
- N/A

### Security
- N/A

## [1.0.0] - 2026-01-03

### Added

#### Core Platform
- **GraphRAG Implementation**: Triple-layer architecture (PostgreSQL + Neo4j + Qdrant)
  - Semantic memory with vector embeddings
  - Episodic memory with temporal context
  - Entity-relationship graphs with Neo4j
- **Multi-Agent Orchestration**: MageAgent engine with 320+ LLM model support
  - OpenRouter integration (250+ models)
  - OpenAI, Anthropic, Groq, Together AI support
  - Agent composition and task delegation
- **Document Processing**: Universal document ingestion pipeline
  - PDF, DOCX, TXT, Markdown support
  - Automatic chunking and embedding generation
  - Metadata extraction and indexing

#### Infrastructure Packages
- `@adverant/logger`: Structured logging with Winston
- `@adverant/config`: Environment-based configuration management
- `@adverant/types`: Shared TypeScript type definitions
- `@adverant/db`: Database connection pooling and query builders
- `@adverant/redis`: Redis client with retry logic
- `@adverant/vector`: Vector operations and similarity search
- `@adverant/graph`: Neo4j graph database utilities
- `@adverant/auth`: JWT-based authentication middleware
- `@adverant/mcp`: Model Context Protocol implementation
- `@adverant/errors`: Standardized error handling

#### Services
- **nexus-graphrag**: GraphRAG API service
  - RESTful API for memory operations
  - Enhanced retrieval with multi-layer search
  - Real-time memory storage
- **nexus-mageagent**: Multi-agent orchestration service
  - Agent creation and management
  - Task execution and monitoring
  - LLM provider abstraction

#### Deployment
- Docker Compose configuration for local development
- Kubernetes manifests for production deployment
- Health check endpoints for all services
- Prometheus metrics exporters

#### Documentation
- Comprehensive README with architecture diagrams
- API documentation with examples
- Deployment guides (Docker Compose, Kubernetes)
- Use case documentation (6 production scenarios)
- Plugin development guide

### Security
- Row-level security (RLS) in PostgreSQL
- API key authentication
- Rate limiting middleware
- Input validation and sanitization
- Secrets management best practices

---

## How to Update This Changelog

### For Maintainers

When preparing a release:

1. Move items from `[Unreleased]` to a new version section
2. Set the version number and release date
3. Add a comparison link at the bottom
4. Commit with message: `docs: update CHANGELOG for v X.Y.Z`

### For Contributors

When submitting a PR, add your changes to the `[Unreleased]` section under the appropriate category:
- **Added**: New features
- **Changed**: Changes to existing functionality
- **Deprecated**: Soon-to-be removed features
- **Removed**: Removed features
- **Fixed**: Bug fixes
- **Security**: Security improvements

Example:
```markdown
## [Unreleased]

### Added
- New plugin system for custom agents (#123)

### Fixed
- GraphRAG retrieval returning duplicate results (#456)
```

---

[Unreleased]: https://github.com/adverant/Adverant-Nexus-Open-Core/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/adverant/Adverant-Nexus-Open-Core/releases/tag/v1.0.0
