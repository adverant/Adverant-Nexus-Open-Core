# @adverant/repo-analyzer

AI-powered repository analysis and architecture discovery for Nexus Open Core.

## Features

- **Repository Cloning**: Supports GitHub, GitLab, and Bitbucket (public and private repos)
- **Type Detection**: Automatically detects backend, frontend, mobile, infra-as-code, library, and monorepo projects
- **Tech Stack Detection**: Identifies 47+ technologies including frameworks, databases, and tools
- **Architecture Pattern Recognition**: Detects monolith, microservices, layered, hexagonal, and more
- **AI-Powered Analysis**: Optional deep analysis via MageAgent integration
- **Documentation Generation**: Creates comprehensive `.arch.md` architecture documentation

## Installation

```bash
npm install @adverant/repo-analyzer
```

## Quick Start

```typescript
import { RepositoryAnalyzer } from '@adverant/repo-analyzer';

const analyzer = new RepositoryAnalyzer();

// Full analysis with AI
const analysis = await analyzer.analyze({
  repoUrl: 'https://github.com/facebook/react',
  analysisDepth: 'standard',
  includeSecurityScan: true,
});

console.log(analysis.result?.detectedType);  // 'library'
console.log(analysis.result?.techStack);     // ['typescript', 'react', 'jest', ...]
console.log(analysis.result?.archMd);        // Generated markdown documentation
```

## Quick Type Detection

For fast type detection without full analysis:

```typescript
import { RepositoryAnalyzer } from '@adverant/repo-analyzer';

const analyzer = new RepositoryAnalyzer();
const typeResult = await analyzer.detectType('https://github.com/nestjs/nest');

console.log(typeResult.primaryType);   // 'library'
console.log(typeResult.confidence);    // 0.95
console.log(typeResult.techStack);     // ['typescript', 'nestjs', 'jest', ...]
```

## Using Individual Components

### RepoManager - Git Operations

```typescript
import { RepoManager } from '@adverant/repo-analyzer';

const manager = new RepoManager([
  { platform: 'github', token: 'your-token' }
]);

// Clone repository
const result = await manager.cloneRepository('https://github.com/owner/repo', {
  branch: 'main',
  depth: 1,
});

// Get directory structure
const structure = await manager.getDirectoryStructure(result.localPath);

// Get files
const files = await manager.getFiles(result.localPath, ['**/*.ts']);

// Cleanup
await manager.cleanup(result.localPath);
```

### TypeDetector - Project Type Detection

```typescript
import { RepoManager, TypeDetector } from '@adverant/repo-analyzer';

const manager = new RepoManager();
const detector = new TypeDetector(manager);

// Analyze local directory
const files = await manager.getFiles('/path/to/repo');
const structure = await manager.getDirectoryStructure('/path/to/repo');
const result = await detector.detect('/path/to/repo', structure, files);

console.log(result.primaryType);    // 'backend' | 'frontend' | 'mobile' | etc.
console.log(result.techStack);      // Detected technologies
console.log(result.indicators);     // Why this type was detected
```

### OutputGenerator - Documentation Generation

```typescript
import { OutputGenerator } from '@adverant/repo-analyzer';

const generator = new OutputGenerator();

// Generate markdown
const markdown = generator.generateMarkdown(analysisResult, {
  format: 'markdown',
  includeToc: true,
});

// Generate JSON
const json = generator.generateJson(analysisResult);

// Generate HTML
const html = generator.generateHtml(analysisResult, { format: 'html' });
```

## Configuration

### AnalyzerConfig Options

```typescript
interface AnalyzerConfig {
  // Git credentials for private repos
  credentials?: GitCredentials[];

  // MageAgent URL for AI analysis (default: http://localhost:9010)
  mageAgentUrl?: string;

  // GraphRAG URL for caching (default: http://localhost:8090)
  graphRagUrl?: string;

  // Enable/disable AI analysis (default: true)
  enableAiAnalysis?: boolean;

  // Temporary directory for clones (default: /tmp/repos)
  tempDir?: string;
}
```

### Analysis Request Options

```typescript
interface AnalysisRequest {
  repoUrl: string;
  branch?: string;                    // Default: 'main'
  analysisDepth?: 'quick' | 'standard' | 'deep';  // Default: 'standard'
  includeSecurityScan?: boolean;      // Default: true
  force?: boolean;                    // Force re-analysis
  webhookUrl?: string;                // Callback URL
}
```

## Detected Repository Types

| Type | Description |
|------|-------------|
| `backend` | Server-side applications (Express, Django, Rails, etc.) |
| `frontend` | Web frontends (React, Vue, Angular, etc.) |
| `mobile` | Mobile apps (React Native, Flutter, etc.) |
| `infra-as-code` | Infrastructure (Terraform, Kubernetes, etc.) |
| `library` | Reusable packages and libraries |
| `monorepo` | Multi-package repositories |
| `unknown` | Could not determine type |

## Detected Architecture Patterns

- `monolith` - Single application codebase
- `layered-monolith` - Monolith with clear layering
- `microservices` - Service-oriented architecture
- `serverless` - Function-based architecture
- `event-driven` - Event streaming patterns
- `hexagonal` - Ports and adapters pattern
- `clean-architecture` - Clean architecture pattern
- `mvc` - Model-View-Controller
- `mvvm` - Model-View-ViewModel
- `component-based` - Component-driven architecture
- `plugin-based` - Plugin/extension architecture

## Progress Tracking

Track analysis progress with callbacks:

```typescript
const analysis = await analyzer.analyze(request, context, (progress) => {
  console.log(`${progress.progress}%: ${progress.currentStep}`);
  // Output:
  // 10%: Cloning repository...
  // 20%: Analyzing project structure...
  // 40%: Running analysis...
  // 90%: Generating documentation...
  // 100%: Analysis complete
});
```

## CLI Usage

When used with `nexus-cli`:

```bash
# Analyze a repository
nexus repo analyze https://github.com/owner/repo

# Quick type detection
nexus repo detect https://github.com/owner/repo

# Analyze local directory
nexus repo analyze ./my-project

# Export analysis
nexus repo export --format=markdown --output=architecture.md
```

## Integration with Nexus Services

This package integrates with other Nexus services:

- **MageAgent**: For AI-powered code analysis
- **GraphRAG**: For caching analysis results
- **Nexus CLI**: For command-line access

## License

Apache-2.0