/**
 * Repository Types and Interfaces for @adverant/repo-analyzer
 *
 * AI-powered repository analysis and architecture discovery
 */

export type GitPlatform = 'github' | 'gitlab' | 'bitbucket';

export type RepositoryType =
  | 'backend'
  | 'frontend'
  | 'mobile'
  | 'infra-as-code'
  | 'library'
  | 'monorepo'
  | 'unknown';

export type TechStack =
  // Languages
  | 'typescript' | 'javascript' | 'python' | 'java' | 'go' | 'rust' | 'csharp' | 'ruby' | 'php' | 'swift' | 'kotlin'
  // Backend frameworks
  | 'express' | 'nestjs' | 'fastify' | 'django' | 'flask' | 'fastapi' | 'spring' | 'rails' | 'laravel' | 'gin' | 'actix'
  // Frontend frameworks
  | 'react' | 'vue' | 'angular' | 'svelte' | 'nextjs' | 'nuxt' | 'remix' | 'gatsby'
  // Mobile
  | 'react-native' | 'flutter' | 'swiftui' | 'jetpack-compose' | 'ionic' | 'capacitor'
  // Databases
  | 'postgresql' | 'mysql' | 'mongodb' | 'redis' | 'elasticsearch' | 'neo4j' | 'dynamodb' | 'sqlite'
  // Infrastructure
  | 'docker' | 'kubernetes' | 'terraform' | 'pulumi' | 'ansible' | 'helm'
  // Cloud
  | 'aws' | 'gcp' | 'azure' | 'vercel' | 'netlify' | 'cloudflare'
  // Testing
  | 'jest' | 'vitest' | 'pytest' | 'junit' | 'mocha' | 'cypress' | 'playwright'
  // Other
  | 'graphql' | 'rest' | 'grpc' | 'websocket' | 'openapi';

export interface RepositoryInfo {
  url: string;
  platform: GitPlatform;
  owner: string;
  name: string;
  branch: string;
  commitHash?: string;
  defaultBranch?: string;
  isPrivate?: boolean;
  clonePath?: string;
}

export interface RepositoryMetadata {
  sizeBytes: number;
  fileCount: number;
  directoryCount: number;
  lastCommitDate?: Date;
  contributors?: number;
  stars?: number;
  forks?: number;
}

export interface DirectoryStructure {
  path: string;
  name: string;
  type: 'file' | 'directory';
  size?: number;
  children?: DirectoryStructure[];
}

export interface FileInfo {
  path: string;
  name: string;
  extension: string;
  size: number;
  language?: string;
  lineCount?: number;
}

export interface TypeDetectionResult {
  primaryType: RepositoryType;
  confidence: number;  // 0-1
  techStack: TechStack[];
  indicators: TypeIndicator[];
  subTypes?: RepositoryType[];  // For monorepos
}

export interface TypeIndicator {
  type: 'file' | 'dependency' | 'pattern' | 'structure';
  name: string;
  path?: string;
  confidence: number;
  suggestedType: RepositoryType;
}

export interface CloneOptions {
  depth?: number;  // Shallow clone depth
  branch?: string;
  sparse?: boolean;  // Sparse checkout
  sparsePatterns?: string[];  // Patterns for sparse checkout
  timeout?: number;  // Clone timeout in ms
}

export interface RepositoryCloneResult {
  success: boolean;
  localPath: string;
  commitHash: string;
  branch: string;
  duration: number;
  error?: string;
}

export interface GitCredentials {
  platform: GitPlatform;
  token?: string;
  username?: string;
  sshKey?: string;
}

export interface RepositoryParseResult {
  isValid: boolean;
  platform?: GitPlatform;
  owner?: string;
  name?: string;
  branch?: string;
  error?: string;
}

/**
 * Analysis result types
 */
export type AnalysisStatus =
  | 'queued'
  | 'cloning'
  | 'detecting'
  | 'analyzing'
  | 'synthesizing'
  | 'generating'
  | 'completed'
  | 'failed';

export type AnalysisDepth = 'quick' | 'standard' | 'deep';

export type FindingType =
  | 'architecture'
  | 'security'
  | 'performance'
  | 'documentation'
  | 'testing'
  | 'maintainability';

export type Severity = 'info' | 'low' | 'medium' | 'high' | 'critical';

export interface AnalysisRequest {
  repoUrl: string;
  branch?: string;
  analysisDepth?: AnalysisDepth;
  includeSecurityScan?: boolean;
  force?: boolean;  // Force re-analysis even if cached
  webhookUrl?: string;  // Callback URL for completion
}

export interface AnalysisOptions {
  depth: AnalysisDepth;
  includeSecurityScan: boolean;
  force: boolean;
}

export interface AnalysisProgress {
  analysisId: string;
  status: AnalysisStatus;
  progress: number;  // 0-100
  currentStep: string;
}

export interface Finding {
  id: string;
  agentType: string;
  findingType: FindingType;
  severity: Severity;
  title: string;
  description: string;
  location?: string;
  lineNumber?: number;
  recommendation?: string;
}

export interface SecurityFinding extends Finding {
  cwe?: string;
  owasp?: string;
  cvss?: number;
  remediation: string;
}

export interface Recommendation {
  category: FindingType;
  priority: 'low' | 'medium' | 'high' | 'critical';
  title: string;
  description: string;
  effort: 'trivial' | 'small' | 'medium' | 'large' | 'epic';
  impact: 'low' | 'medium' | 'high';
}

export type ArchitecturePattern =
  | 'monolith'
  | 'layered-monolith'
  | 'microservices'
  | 'serverless'
  | 'event-driven'
  | 'hexagonal'
  | 'clean-architecture'
  | 'mvc'
  | 'mvvm'
  | 'flux'
  | 'component-based'
  | 'plugin-based'
  | 'unknown';

export interface ArchitectureLayer {
  name: string;
  type: string;
  paths: string[];
  responsibilities: string[];
  dependencies: string[];
}

export interface ArchitectureComponent {
  name: string;
  type: 'service' | 'module' | 'controller' | 'component' | 'utility' | 'config' | 'other';
  path: string;
  description: string;
  dependencies: string[];
  exports: string[];
  linesOfCode?: number;
  complexity?: number;
}

export interface DependencyGraph {
  nodes: Array<{
    id: string;
    name: string;
    type: string;
    path: string;
  }>;
  edges: Array<{
    source: string;
    target: string;
    type: 'imports' | 'extends' | 'implements' | 'uses';
  }>;
  externalDependencies: Array<{
    name: string;
    version: string;
    type: 'production' | 'development';
  }>;
}

export interface ArchitectureAnalysis {
  pattern: ArchitecturePattern;
  patternConfidence: number;
  layers: ArchitectureLayer[];
  components: ArchitectureComponent[];
  dependencies: DependencyGraph;
  apis?: ApiEndpoint[];
  dataModels?: DataModel[];
  buildSystem?: string;
  deploymentConfig?: string;
}

export interface ApiEndpoint {
  method: string;
  path: string;
  description?: string;
  parameters?: Array<{ name: string; type: string; required: boolean }>;
  requestBody?: string;
  responseType?: string;
}

export interface DataModel {
  name: string;
  type: 'class' | 'interface' | 'type' | 'schema' | 'entity';
  path: string;
  fields: Array<{ name: string; type: string; nullable: boolean }>;
  relationships: Array<{ target: string; type: string }>;
}

export interface AnalysisUsage {
  tokensConsumed: number;
  inputTokens: number;
  outputTokens: number;
  agentsUsed: number;
  filesAnalyzed: number;
  repoSizeBytes: number;
  durationMs: number;
  cacheHit: boolean;
}

export interface AnalysisResult {
  detectedType: RepositoryType;
  techStack: TechStack[];
  architecture: ArchitectureAnalysis;
  findings: Finding[];
  securityFindings?: SecurityFinding[];
  recommendations: Recommendation[];
  archMd: string;  // Generated .arch.md content
  repositoryInfo: RepositoryInfo;
  repositoryMetadata: RepositoryMetadata;
  directoryStructure: DirectoryStructure;
}

export interface Analysis {
  id: string;
  userId: string;
  tenantId?: string;
  repoUrl: string;
  repoName: string;
  branch: string;
  commitHash?: string;
  analysisDepth: AnalysisDepth;
  includeSecurity: boolean;
  forceReanalysis: boolean;
  status: AnalysisStatus;
  progress: number;
  currentStep?: string;
  result?: AnalysisResult;
  errorMessage?: string;
  usage: AnalysisUsage;
  createdAt: Date;
  updatedAt: Date;
  completedAt?: Date;
}

export interface TenantContext {
  userId: string;
  tenantId?: string;
  requestId?: string;
}

/**
 * File patterns for different repository types
 */
export const TYPE_DETECTION_PATTERNS: Record<RepositoryType, string[]> = {
  backend: [
    'package.json',
    'requirements.txt',
    'go.mod',
    'Cargo.toml',
    'pom.xml',
    'build.gradle',
    'Gemfile',
    'composer.json',
  ],
  frontend: [
    'package.json',
    'next.config.js',
    'nuxt.config.js',
    'vite.config.ts',
    'webpack.config.js',
    'angular.json',
    'svelte.config.js',
  ],
  mobile: [
    'ios/',
    'android/',
    'App.tsx',
    'pubspec.yaml',
    'Podfile',
    'build.gradle',
    'capacitor.config.json',
  ],
  'infra-as-code': [
    'main.tf',
    'terraform/',
    'Pulumi.yaml',
    'ansible/',
    'kubernetes/',
    'k8s/',
    'helm/',
    'docker-compose.yml',
  ],
  library: [
    'package.json',
    'setup.py',
    'pyproject.toml',
    'Cargo.toml',
    'lib/',
  ],
  monorepo: [
    'pnpm-workspace.yaml',
    'lerna.json',
    'nx.json',
    'turbo.json',
    'packages/',
    'apps/',
  ],
  unknown: [],
};

/**
 * Tech stack detection patterns
 */
export const TECH_STACK_PATTERNS: Record<TechStack, { files?: string[]; dependencies?: string[] }> = {
  // Languages
  typescript: { files: ['tsconfig.json', '*.ts', '*.tsx'] },
  javascript: { files: ['*.js', '*.jsx', '.eslintrc.js'] },
  python: { files: ['*.py', 'requirements.txt', 'setup.py', 'pyproject.toml'] },
  java: { files: ['*.java', 'pom.xml', 'build.gradle'] },
  go: { files: ['*.go', 'go.mod', 'go.sum'] },
  rust: { files: ['*.rs', 'Cargo.toml'] },
  csharp: { files: ['*.cs', '*.csproj', '*.sln'] },
  ruby: { files: ['*.rb', 'Gemfile'] },
  php: { files: ['*.php', 'composer.json'] },
  swift: { files: ['*.swift', 'Package.swift'] },
  kotlin: { files: ['*.kt', 'build.gradle.kts'] },

  // Backend frameworks
  express: { dependencies: ['express'] },
  nestjs: { dependencies: ['@nestjs/core'] },
  fastify: { dependencies: ['fastify'] },
  django: { files: ['manage.py', 'settings.py'] },
  flask: { dependencies: ['flask'] },
  fastapi: { dependencies: ['fastapi'] },
  spring: { files: ['pom.xml'], dependencies: ['spring-boot'] },
  rails: { files: ['Gemfile'], dependencies: ['rails'] },
  laravel: { files: ['artisan', 'composer.json'] },
  gin: { dependencies: ['github.com/gin-gonic/gin'] },
  actix: { dependencies: ['actix-web'] },

  // Frontend frameworks
  react: { dependencies: ['react', 'react-dom'] },
  vue: { dependencies: ['vue'] },
  angular: { files: ['angular.json'], dependencies: ['@angular/core'] },
  svelte: { dependencies: ['svelte'] },
  nextjs: { dependencies: ['next'] },
  nuxt: { dependencies: ['nuxt'] },
  remix: { dependencies: ['@remix-run/react'] },
  gatsby: { dependencies: ['gatsby'] },

  // Mobile
  'react-native': { dependencies: ['react-native'] },
  flutter: { files: ['pubspec.yaml'] },
  swiftui: { files: ['*.swift'] },
  'jetpack-compose': { files: ['build.gradle.kts'] },
  ionic: { dependencies: ['@ionic/angular', '@ionic/react', '@ionic/vue'] },
  capacitor: { dependencies: ['@capacitor/core'] },

  // Databases
  postgresql: { dependencies: ['pg', 'psycopg2', 'postgres'] },
  mysql: { dependencies: ['mysql', 'mysql2', 'pymysql'] },
  mongodb: { dependencies: ['mongodb', 'mongoose', 'pymongo'] },
  redis: { dependencies: ['redis', 'ioredis'] },
  elasticsearch: { dependencies: ['@elastic/elasticsearch', 'elasticsearch'] },
  neo4j: { dependencies: ['neo4j-driver'] },
  dynamodb: { dependencies: ['@aws-sdk/client-dynamodb'] },
  sqlite: { dependencies: ['sqlite3', 'better-sqlite3'] },

  // Infrastructure
  docker: { files: ['Dockerfile', 'docker-compose.yml'] },
  kubernetes: { files: ['*.yaml', 'k8s/', 'kubernetes/'] },
  terraform: { files: ['*.tf', 'main.tf'] },
  pulumi: { files: ['Pulumi.yaml'] },
  ansible: { files: ['ansible/', 'playbook.yml'] },
  helm: { files: ['Chart.yaml', 'values.yaml'] },

  // Cloud
  aws: { files: ['serverless.yml', 'sam.yaml'], dependencies: ['@aws-sdk/core', 'boto3'] },
  gcp: { files: ['app.yaml'], dependencies: ['@google-cloud/core'] },
  azure: { dependencies: ['@azure/core-rest-pipeline'] },
  vercel: { files: ['vercel.json'] },
  netlify: { files: ['netlify.toml'] },
  cloudflare: { files: ['wrangler.toml'] },

  // Testing
  jest: { dependencies: ['jest'] },
  vitest: { dependencies: ['vitest'] },
  pytest: { dependencies: ['pytest'] },
  junit: { dependencies: ['junit'] },
  mocha: { dependencies: ['mocha'] },
  cypress: { dependencies: ['cypress'] },
  playwright: { dependencies: ['@playwright/test'] },

  // Other
  graphql: { files: ['*.graphql', '*.gql'], dependencies: ['graphql', 'apollo-server'] },
  rest: { files: ['openapi.yaml', 'swagger.json'] },
  grpc: { files: ['*.proto'], dependencies: ['@grpc/grpc-js'] },
  websocket: { dependencies: ['ws', 'socket.io'] },
  openapi: { files: ['openapi.yaml', 'openapi.json', 'swagger.yaml'] },
};