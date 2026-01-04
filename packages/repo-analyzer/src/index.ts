/**
 * @adverant/repo-analyzer
 *
 * AI-powered repository analysis and architecture discovery for Nexus Open Core
 *
 * Features:
 * - Repository cloning (GitHub, GitLab, Bitbucket)
 * - Type detection (backend, frontend, mobile, infra, library, monorepo)
 * - Tech stack detection (47+ technologies)
 * - Architecture pattern recognition
 * - AI-powered analysis via MageAgent (optional)
 * - .arch.md documentation generation
 *
 * @example
 * ```typescript
 * import { RepositoryAnalyzer } from '@adverant/repo-analyzer';
 *
 * const analyzer = new RepositoryAnalyzer();
 *
 * // Full analysis
 * const analysis = await analyzer.analyze({
 *   repoUrl: 'https://github.com/owner/repo',
 *   analysisDepth: 'standard',
 *   includeSecurityScan: true,
 * });
 *
 * console.log(analysis.result?.archMd);
 *
 * // Quick type detection
 * const typeResult = await analyzer.detectType('https://github.com/owner/repo');
 * console.log(typeResult.primaryType); // 'backend' | 'frontend' | etc.
 * ```
 *
 * @module @adverant/repo-analyzer
 */

// Main analyzer class
export { RepositoryAnalyzer, RepositoryAnalyzerError } from './analyzer.js';
export type { AnalyzerConfig, ProgressCallback } from './analyzer.js';

// Repository management
export { RepoManager } from './manager.js';

// Type detection
export { TypeDetector } from './detector.js';

// Output generation
export { OutputGenerator } from './output.js';
export type { OutputOptions } from './output.js';

// All types
export * from './types/index.js';

// Default export
export { RepositoryAnalyzer as default } from './analyzer.js';