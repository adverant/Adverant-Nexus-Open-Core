# Contributing to Adverant Nexus Open Core

Thank you for your interest in contributing to Adverant Nexus! This document provides guidelines for contributing to the open-source core.

## 📋 Table of Contents

- [Code of Conduct](#-code-of-conduct)
- [Project Overview](#-project-overview)
- [Getting Started](#-getting-started)
- [Development Workflow](#-development-workflow)
- [Plugin Development](#-plugin-development)
- [Code Quality Standards](#-code-quality-standards)
- [Issue and PR Templates](#-issue-and-pr-templates)
- [Community Guidelines](#-community-guidelines)
- [Recognition](#-recognition)

## 📜 Code of Conduct

This project adheres to a [Code of Conduct](CODE_OF_CONDUCT.md). By participating, you are expected to uphold this code. Please report unacceptable behavior to community@adverant.ai.

## 🔒 Security Policy

Please review our [Security Policy](SECURITY.md) before contributing. Never commit sensitive information or open public issues for security vulnerabilities.

## 🎯 Project Overview

Adverant Nexus Open Core is a production-grade TypeScript/Node.js platform for:
- **Multi-agent orchestration** (MageAgent) - Coordinate multiple AI agents with streaming
- **Knowledge management** (GraphRAG) - Vector search + graph-based episodic memory
- **Infrastructure utilities** - Logging, caching, resilience patterns, database management

## 📜 Dual License Model

This project uses a dual-license model:
- **Apache 2.0**: Open-source core components (GraphRAG, MageAgent, shared packages)
- **Elastic License 2.0**: Enterprise features (GDPR, SSO, smart routing, analytics)

See [LICENSE](./LICENSE) and [.visibility.json](./.visibility.json) for the complete mapping.

## 🚀 Getting Started

### Prerequisites

- **Node.js**: >= 20.0.0
- **npm**: >= 10.0.0
- **PostgreSQL**: >= 15 (for GraphRAG)
- **Neo4j**: >= 5.0 (for graph storage)
- **Qdrant**: >= 1.7 (for vector search)
- **Redis**: >= 7.0 (for task queues)

### Setup

```bash
# Clone the repository
git clone https://github.com/adverant/Adverant-Nexus-Open-Core.git
cd Adverant-Nexus-Open-Core

# Install dependencies
npm install

# Build all packages
npm run build

# Run tests
npm test
```

### Project Structure

```
Adverant-Nexus-Open-Core/
├── packages/                 # Shared infrastructure packages
│   ├── adverant-logger/      # Logging with correlation IDs
│   ├── adverant-errors/      # Error handling
│   ├── adverant-config/      # Configuration management
│   ├── adverant-cache/       # Caching utilities
│   ├── adverant-resilience/  # Circuit breakers, retry
│   ├── adverant-database/    # Database managers
│   ├── adverant-event-bus/   # Event-driven architecture
│   ├── nexus-telemetry/      # OpenTelemetry integration
│   ├── voyage-ai-client/     # Voyage AI embeddings
│   └── nexus-routing/        # Service routing
│
├── services/                 # Core services
│   ├── nexus-graphrag/       # Knowledge management (GraphRAG)
│   └── nexus-mageagent/      # Multi-agent orchestration
│
├── scripts/                  # Build and deployment scripts
│   └── security-scan.sh      # Security scanning
│
├── LICENSE                   # Dual license information
├── LICENSE-APACHE-2.0        # Apache 2.0 full text
├── LICENSE-ELASTIC           # Elastic License 2.0 full text
└── .visibility.json          # License mapping
```

## 🛠️ Development Workflow

### 1. Create a Branch

```bash
git checkout -b feature/your-feature-name
```

### 2. Make Changes

Follow our coding standards:
- **TypeScript strict mode** - No `any` types without justification
- **ESLint** - Zero warnings
- **Tests** - All new features must have tests
- **Documentation** - Update docs for any public API changes

### 3. Test Your Changes

```bash
# Run all tests
npm test

# Run specific package tests
npm test --workspace=packages/adverant-logger

# Run security scan
npm run security-scan

# Type check
npm run typecheck
```

### 4. Commit Your Changes

We use conventional commits:

```bash
git commit -m "feat(graphrag): Add semantic chunking strategy"
git commit -m "fix(mageagent): Resolve race condition in task queue"
git commit -m "docs: Update GraphRAG API examples"
```

**Commit types**:
- `feat`: New feature
- `fix`: Bug fix
- `docs`: Documentation only
- `style`: Code style changes (formatting)
- `refactor`: Code refactoring
- `test`: Adding tests
- `chore`: Maintenance tasks

### 5. Push and Create Pull Request

```bash
git push origin feature/your-feature-name
```

Then create a pull request on GitHub with:
- Clear description of the changes
- Link to related issues
- Screenshots/examples if applicable

## 🔒 Security

### Reporting Vulnerabilities

**DO NOT** open public issues for security vulnerabilities.

Email: security@adverant.ai

### Security Guidelines

1. **Never commit secrets**:
   - No API keys
   - No database passwords
   - No JWT secrets
   - Use environment variables

2. **Run security scan**:
   ```bash
   npm run security-scan
   ```

3. **Dependencies**:
   - Keep dependencies updated
   - Run `npm audit` regularly
   - Fix high/critical vulnerabilities immediately

## ✅ Code Quality Standards

### TypeScript

```typescript
// ✅ GOOD
export class StorageEngine {
  constructor(private readonly config: StorageConfig) {}

  async store(document: Document): Promise<StorageResult> {
    try {
      return await this.performStore(document);
    } catch (error) {
      throw new StorageError(
        `Failed to store document: ${document.id}`,
        { originalError: error, context: { documentId: document.id } }
      );
    }
  }
}

// ❌ BAD
export class StorageEngine {
  async store(doc: any) {
    return await someFunction(doc); // No error handling
  }
}
```

### Error Handling

Always provide context in errors:

```typescript
throw new ServiceError(
  `Failed to process task: ${taskId}`,
  {
    code: 'TASK_PROCESSING_ERROR',
    context: {
      taskId,
      timestamp: new Date(),
      operation: 'processTask'
    }
  }
);
```

### Testing

Write comprehensive tests:

```typescript
describe('StorageEngine', () => {
  describe('store', () => {
    it('should store document successfully', async () => {
      const engine = new StorageEngine(mockConfig);
      const result = await engine.store(mockDocument);
      expect(result.success).toBe(true);
    });

    it('should handle storage errors gracefully', async () => {
      const engine = new StorageEngine(mockConfig);
      await expect(engine.store(invalidDocument))
        .rejects.toThrow(StorageError);
    });
  });
});
```

## 🔌 Plugin Development

Nexus supports a powerful plugin system for extending functionality. See the [Plugin Development Guide](docs/plugins/development.md) for comprehensive documentation.

### Quick Start

1. **Use the example plugin as a template**:
   ```bash
   cp -r examples/example-plugin my-plugin
   cd my-plugin
   ```

2. **Update package.json**:
   - Change name to `@nexus-plugin/your-plugin-name`
   - Update metadata (description, author, etc.)

3. **Implement your plugin**:
   ```typescript
   import { NexusPlugin } from '@adverant/nexus-plugin-system';

   const myPlugin: NexusPlugin = {
     metadata: { /* ... */ },
     hooks: { /* ... */ },
     capabilities: { /* ... */ }
   };

   export default myPlugin;
   ```

4. **Test and publish**:
   ```bash
   npm run build
   npm test
   npm publish --access public
   ```

### Plugin Capabilities

Plugins can extend:
- **Tools**: Add custom tools for MageAgent
- **Agents**: Create specialized agents
- **Document Processors**: Support new file types in GraphRAG
- **API Routes**: Extend the REST API
- **Middleware**: Add custom request processing

See [examples/example-plugin](examples/example-plugin) for a complete working example.

## 📄 Issue and PR Templates

We use GitHub issue and PR templates to streamline contributions:

### Reporting Issues

Choose the appropriate template:
- **Bug Report**: Report bugs with reproduction steps
- **Feature Request**: Suggest new features
- **Documentation**: Report documentation issues

Find templates at: [Issues > New Issue](https://github.com/adverant/Adverant-Nexus-Open-Core/issues/new/choose)

### Submitting Pull Requests

All PRs must use our [PR template](.github/PULL_REQUEST_TEMPLATE.md) which includes:
- Type of change checklist
- Testing verification
- Documentation updates
- Security considerations
- Breaking change documentation

## 🏛️ Governance

This project follows a meritocratic governance model. See [GOVERNANCE.md](GOVERNANCE.md) for details on:
- Contributor roles and responsibilities
- Decision-making processes
- How to become a maintainer
- Conflict resolution

## 🗺️ Roadmap

Check our [ROADMAP.md](ROADMAP.md) to see:
- Planned features by quarter
- Current priorities
- How to influence the roadmap
- Voting on features

## 🌍 Community Guidelines

### Be Respectful

- Be welcoming to newcomers
- Respect differing viewpoints
- Accept constructive criticism gracefully
- Focus on what's best for the community

### Communication Channels

- **GitHub Issues**: Bug reports, feature requests ([Issue Templates](https://github.com/adverant/Adverant-Nexus-Open-Core/issues/new/choose))
- **GitHub Discussions**: Questions, ideas, showcases
- **Discord**: Real-time chat (https://discord.gg/adverant)
- **Monthly Community Calls**: First Tuesday of each month (announced in Discord)

### Support

See [SUPPORT.md](SUPPORT.md) for:
- Where to get help
- Community support channels
- Commercial support options

## 📝 Documentation

### Code Documentation

Use JSDoc for public APIs:

```typescript
/**
 * Stores a document in the knowledge base
 *
 * @param document - The document to store
 * @param options - Storage options
 * @returns Promise resolving to storage result
 * @throws {StorageError} If storage fails
 *
 * @example
 * ```typescript
 * const result = await storage.store(document, {
 *   createEmbeddings: true,
 *   extractEntities: true
 * });
 * ```
 */
async store(document: Document, options?: StorageOptions): Promise<StorageResult>
```

### README Updates

Update package READMEs when:
- Adding new features
- Changing APIs
- Adding examples
- Updating dependencies

## 🔄 Release Process

Releases are managed by maintainers:

1. Version bump (semver)
2. Changelog update
3. Git tag
4. npm publish (if applicable)
5. GitHub release

## 📞 Getting Help

- **Documentation**: Check package READMEs first
- **Examples**: See `examples/` directory
- **Issues**: Search existing issues before creating new ones
- **Discord**: For real-time help

## 🎁 Recognition

Contributors are recognized in:
- CONTRIBUTORS.md
- Release notes
- Project website

---

**Thank you for contributing to Adverant Nexus! 🚀**
