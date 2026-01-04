/**
 * @adverant/repo-analyzer
 *
 * AI-powered repository analysis and architecture discovery
 */

// Main exports
export { RepositoryAnalyzer, AnalyzerError } from './analyzer.js';
export { RepoManager, RepoManagerError } from './manager.js';
export { TypeDetector } from './detector.js';
export { OutputGenerator } from './output.js';

// Type exports
export type {
  // Core types
  GitPlatform,
  RepositoryType,
  TechStack,
  RepositoryInfo,
  RepositoryMetadata,
  DirectoryStructure,
  FileInfo,
  TypeDetectionResult,
  TypeIndicator,
  CloneOptions,
  RepositoryCloneResult,
  GitCredentials,
  RepositoryParseResult,

  // Analysis types
  AnalysisStatus,
  AnalysisDepth,
  FindingType,
  Severity,
  AnalysisRequest,
  AnalysisOptions,
  AnalysisProgress,
  Finding,
  SecurityFinding,
  Recommendation,

  // Architecture types
  ArchitecturePattern,
  ArchitectureLayer,
  ArchitectureComponent,
  DependencyGraph,
  ArchitectureAnalysis,
  ApiEndpoint,
  DataModel,

  // Result types
  AnalysisUsage,
  AnalysisResult,
  Analysis,
  TenantContext,

  // Config types
  AnalyzerConfig,
} from './types/index.js';

// Pattern constants
export {
  TYPE_DETECTION_PATTERNS,
  TECH_STACK_PATTERNS,
} from './types/index.js';

// Output options type
export type { OutputOptions } from './output.js';
