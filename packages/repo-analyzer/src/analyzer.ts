/**
 * Repository Analyzer
 *
 * Main orchestrator for AI-powered repository analysis.
 * Coordinates type detection, structure analysis, and output generation.
 */

import { randomUUID } from 'crypto';
import { RepoManager } from './manager.js';
import { TypeDetector } from './detector.js';
import { OutputGenerator } from './output.js';
import type {
  AnalysisRequest,
  AnalysisResult,
  Analysis,
  AnalysisProgress,
  AnalysisStatus,
  AnalyzerConfig,
  ArchitectureAnalysis,
  ArchitectureComponent,
  ArchitectureLayer,
  ArchitecturePattern,
  DependencyGraph,
  TenantContext,
  TypeDetectionResult,
  Finding,
  Recommendation,
} from './types/index.js';

/**
 * Error thrown for analysis failures
 */
export class AnalyzerError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly context: {
      operation: string;
      analysisId?: string;
      repoUrl?: string;
      originalError?: Error;
    }
  ) {
    super(message);
    this.name = 'AnalyzerError';
    Error.captureStackTrace(this, this.constructor);
  }
}

/**
 * Progress callback type
 */
export type ProgressCallback = (progress: AnalysisProgress) => void;

export class RepositoryAnalyzer {
  private readonly config: AnalyzerConfig;
  private readonly repoManager: RepoManager;
  private readonly outputGenerator: OutputGenerator;

  constructor(config: AnalyzerConfig = {}) {
    this.config = {
      mageAgentUrl: config.mageAgentUrl ?? 'http://localhost:9010',
      graphRagUrl: config.graphRagUrl ?? 'http://localhost:8090',
      enableAiAnalysis: config.enableAiAnalysis ?? true,
      tempDir: config.tempDir,
      maxFileSizeBytes: config.maxFileSizeBytes ?? 10 * 1024 * 1024, // 10MB
      excludePatterns: config.excludePatterns ?? [
        'node_modules',
        '.git',
        'dist',
        'build',
        'coverage',
      ],
    };

    this.repoManager = new RepoManager({ tempDir: this.config.tempDir });
    this.outputGenerator = new OutputGenerator();
  }

  /**
   * Run full repository analysis
   */
  async analyze(
    request: AnalysisRequest,
    context?: TenantContext,
    onProgress?: ProgressCallback
  ): Promise<Analysis> {
    const analysisId = randomUUID();
    const startTime = Date.now();

    let status: AnalysisStatus = 'queued';
    let repoPath: string | null = null;
    let errorMessage: string | undefined;

    const updateProgress = (step: string, progress: number) => {
      onProgress?.({
        analysisId,
        status,
        progress,
        currentStep: step,
      });
    };

    try {
      // Step 1: Clone/access repository
      status = 'cloning';
      updateProgress('Accessing repository...', 5);

      const cloneResult = await this.repoManager.cloneRepository(request.repoUrl, {
        branch: request.branch,
        depth: request.analysisDepth === 'quick' ? 1 : undefined,
      });

      if (!cloneResult.success) {
        throw new AnalyzerError(
          cloneResult.error ?? 'Failed to access repository',
          'CLONE_FAILED',
          { operation: 'clone', analysisId, repoUrl: request.repoUrl }
        );
      }

      repoPath = cloneResult.localPath;
      updateProgress('Repository accessed', 15);

      // Step 2: Detect repository type
      status = 'detecting';
      updateProgress('Detecting repository type...', 20);

      const typeDetector = new TypeDetector(this.repoManager, repoPath);
      const detectedType = await typeDetector.detect();
      updateProgress(`Detected: ${detectedType.primaryType}`, 30);

      // Step 3: Analyze structure
      status = 'analyzing';
      updateProgress('Analyzing repository structure...', 35);

      const directoryStructure = this.repoManager.getDirectoryStructure(repoPath);
      updateProgress('Structure analyzed', 45);

      // Get repository metadata
      const metadata = await this.repoManager.getRepositoryMetadata(repoPath);
      updateProgress('Metadata collected', 50);

      // Step 4: Build architecture analysis
      updateProgress('Analyzing architecture...', 55);
      const architecture = await this.analyzeArchitecture(repoPath, detectedType);
      updateProgress('Architecture analyzed', 70);

      // Step 5: Generate findings and recommendations
      updateProgress('Generating insights...', 75);
      const findings = this.generateFindings(detectedType, architecture);
      const recommendations = this.generateRecommendations(detectedType, architecture);
      updateProgress('Insights generated', 85);

      // Step 6: Generate output
      status = 'generating';
      updateProgress('Generating documentation...', 90);

      const result: AnalysisResult = {
        detectedType,
        techStack: detectedType.techStack,
        architecture,
        findings,
        recommendations,
        archMd: '',
        repositoryInfo: {
          url: request.repoUrl,
          platform: this.repoManager.parseRepoUrl(request.repoUrl).platform ?? 'github',
          owner: this.repoManager.parseRepoUrl(request.repoUrl).owner ?? 'unknown',
          name: this.repoManager.parseRepoUrl(request.repoUrl).name ?? 'unknown',
          branch: cloneResult.branch,
          commitHash: cloneResult.commitHash,
        },
        repositoryMetadata: metadata,
        directoryStructure,
      };

      // Generate markdown output
      result.archMd = this.outputGenerator.generateMarkdown(result);
      updateProgress('Documentation generated', 95);

      // Step 7: Complete
      status = 'completed';
      updateProgress('Analysis complete', 100);

      const analysis: Analysis = {
        id: analysisId,
        userId: context?.userId ?? 'anonymous',
        tenantId: context?.tenantId,
        repoUrl: request.repoUrl,
        repoName: result.repositoryInfo.name,
        branch: cloneResult.branch,
        commitHash: cloneResult.commitHash,
        analysisDepth: request.analysisDepth ?? 'standard',
        includeSecurity: request.includeSecurityScan ?? false,
        forceReanalysis: request.force ?? false,
        status,
        progress: 100,
        result,
        usage: {
          tokensConsumed: 0,
          inputTokens: 0,
          outputTokens: 0,
          agentsUsed: 0,
          filesAnalyzed: metadata.fileCount,
          repoSizeBytes: metadata.sizeBytes,
          durationMs: Date.now() - startTime,
          cacheHit: false,
        },
        createdAt: new Date(),
        updatedAt: new Date(),
        completedAt: new Date(),
      };

      return analysis;
    } catch (error) {
      status = 'failed';
      errorMessage = error instanceof Error ? error.message : String(error);

      updateProgress(`Failed: ${errorMessage}`, 0);

      const analysis: Analysis = {
        id: analysisId,
        userId: context?.userId ?? 'anonymous',
        tenantId: context?.tenantId,
        repoUrl: request.repoUrl,
        repoName: this.repoManager.parseRepoUrl(request.repoUrl).name ?? 'unknown',
        branch: request.branch ?? 'main',
        analysisDepth: request.analysisDepth ?? 'standard',
        includeSecurity: request.includeSecurityScan ?? false,
        forceReanalysis: request.force ?? false,
        status,
        progress: 0,
        errorMessage,
        usage: {
          tokensConsumed: 0,
          inputTokens: 0,
          outputTokens: 0,
          agentsUsed: 0,
          filesAnalyzed: 0,
          repoSizeBytes: 0,
          durationMs: Date.now() - startTime,
          cacheHit: false,
        },
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      return analysis;
    } finally {
      // Clean up cloned repo if it was a remote clone (not local)
      const parsed = this.repoManager.parseRepoUrl(request.repoUrl);
      if (repoPath && parsed.platform !== 'local') {
        try {
          await this.repoManager.cleanup(repoPath);
        } catch {
          // Ignore cleanup errors
        }
      }
    }
  }

  /**
   * Quick type detection without full analysis
   */
  async detectType(repoUrl: string): Promise<TypeDetectionResult> {
    const cloneResult = await this.repoManager.cloneRepository(repoUrl, { depth: 1 });

    if (!cloneResult.success) {
      throw new AnalyzerError(
        cloneResult.error ?? 'Failed to access repository',
        'CLONE_FAILED',
        { operation: 'detectType', repoUrl }
      );
    }

    try {
      const typeDetector = new TypeDetector(this.repoManager, cloneResult.localPath);
      return await typeDetector.detect();
    } finally {
      const parsed = this.repoManager.parseRepoUrl(repoUrl);
      if (parsed.platform !== 'local') {
        await this.repoManager.cleanup(cloneResult.localPath);
      }
    }
  }

  /**
   * Analyze architecture patterns and structure
   */
  private async analyzeArchitecture(
    repoPath: string,
    typeDetection: TypeDetectionResult
  ): Promise<ArchitectureAnalysis> {
    const files = this.repoManager.listFiles(repoPath);
    const layers: ArchitectureLayer[] = [];
    const components: ArchitectureComponent[] = [];

    // Detect common layer patterns based on repo type
    const layerPatterns = this.getLayerPatterns(typeDetection.primaryType);

    for (const pattern of layerPatterns) {
      const matchingFiles = files.filter(f => f.path.includes(pattern.path));
      if (matchingFiles.length > 0) {
        layers.push({
          name: pattern.name,
          type: pattern.type,
          paths: [pattern.path],
          responsibilities: pattern.responsibilities,
          dependencies: [],
        });
      }
    }

    // Detect components from key files
    const componentPatterns = [
      { pattern: /\/controllers?\/|Controller\.(ts|js)$/, type: 'controller' as const },
      { pattern: /\/services?\/|Service\.(ts|js)$/, type: 'service' as const },
      { pattern: /\/components?\/|Component\.(tsx|jsx)$/, type: 'component' as const },
      { pattern: /\/utils?\/|Utils?\.(ts|js)$/, type: 'utility' as const },
      { pattern: /\/config\/|\.config\.(ts|js)$/, type: 'config' as const },
      { pattern: /\/modules?\/|Module\.(ts|js)$/, type: 'module' as const },
    ];

    for (const file of files.slice(0, 500)) {
      for (const { pattern, type } of componentPatterns) {
        if (pattern.test(file.path)) {
          components.push({
            name: file.name.replace(/\.(ts|tsx|js|jsx)$/, ''),
            type,
            path: file.path,
            description: '',
            dependencies: [],
            exports: [],
            linesOfCode: this.estimateLineCount(repoPath, file.path),
          });
          break;
        }
      }
    }

    // Build dependency graph
    const dependencies = this.buildDependencyGraph(repoPath);

    // Detect architecture pattern
    const pattern = this.detectArchitecturePattern(layers, components, typeDetection);

    return {
      pattern: pattern.name,
      patternConfidence: pattern.confidence,
      layers,
      components: components.slice(0, 100), // Limit to top 100
      dependencies,
    };
  }

  /**
   * Get layer patterns for a repository type
   */
  private getLayerPatterns(repoType: string): Array<{
    path: string;
    name: string;
    type: string;
    responsibilities: string[];
  }> {
    type LayerPattern = Array<{
      path: string;
      name: string;
      type: string;
      responsibilities: string[];
    }>;

    const patterns: Record<string, LayerPattern> = {
      backend: [
        { path: 'src/controllers', name: 'Controllers', type: 'presentation', responsibilities: ['Handle HTTP requests', 'Input validation'] },
        { path: 'src/services', name: 'Services', type: 'business', responsibilities: ['Business logic', 'Orchestration'] },
        { path: 'src/repositories', name: 'Repositories', type: 'data', responsibilities: ['Data access', 'Database operations'] },
        { path: 'src/models', name: 'Models', type: 'domain', responsibilities: ['Domain entities', 'Data structures'] },
        { path: 'src/middleware', name: 'Middleware', type: 'cross-cutting', responsibilities: ['Request processing', 'Authentication'] },
      ],
      frontend: [
        { path: 'src/components', name: 'Components', type: 'presentation', responsibilities: ['UI rendering', 'User interaction'] },
        { path: 'src/pages', name: 'Pages', type: 'presentation', responsibilities: ['Page routing', 'Layout'] },
        { path: 'src/hooks', name: 'Hooks', type: 'logic', responsibilities: ['Reusable logic', 'State management'] },
        { path: 'src/store', name: 'Store', type: 'state', responsibilities: ['Global state', 'State management'] },
        { path: 'src/api', name: 'API', type: 'data', responsibilities: ['API calls', 'Data fetching'] },
      ],
      monorepo: [
        { path: 'packages', name: 'Packages', type: 'modules', responsibilities: ['Shared libraries', 'Internal packages'] },
        { path: 'apps', name: 'Applications', type: 'applications', responsibilities: ['Deployable applications', 'Entry points'] },
        { path: 'libs', name: 'Libraries', type: 'shared', responsibilities: ['Shared code', 'Common utilities'] },
      ],
    };

    return patterns[repoType] ?? patterns['backend'] ?? [];
  }

  /**
   * Detect architecture pattern from layers and components
   */
  private detectArchitecturePattern(
    layers: ArchitectureLayer[],
    components: ArchitectureComponent[],
    typeDetection: TypeDetectionResult
  ): { name: ArchitecturePattern; confidence: number } {
    // Simple heuristics for pattern detection
    const hasControllers = components.some(c => c.type === 'controller');
    const hasServices = components.some(c => c.type === 'service');
    const hasComponents = components.some(c => c.type === 'component');

    if (typeDetection.primaryType === 'monorepo') {
      return { name: 'plugin-based', confidence: 0.8 };
    }

    if (typeDetection.primaryType === 'frontend') {
      if (hasComponents) {
        return { name: 'component-based', confidence: 0.85 };
      }
      return { name: 'mvc', confidence: 0.6 };
    }

    if (layers.length >= 3 && hasControllers && hasServices) {
      return { name: 'layered-monolith', confidence: 0.8 };
    }

    if (hasControllers && hasServices) {
      return { name: 'mvc', confidence: 0.7 };
    }

    return { name: 'unknown', confidence: 0.3 };
  }

  /**
   * Build dependency graph from package files
   */
  private buildDependencyGraph(repoPath: string): DependencyGraph {
    const nodes: DependencyGraph['nodes'] = [];
    const edges: DependencyGraph['edges'] = [];
    const externalDependencies: DependencyGraph['externalDependencies'] = [];

    // Read package.json for external dependencies
    const packageJson = this.repoManager.readJsonFile<{
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    }>(repoPath, 'package.json');

    if (packageJson) {
      if (packageJson.dependencies) {
        for (const [name, version] of Object.entries(packageJson.dependencies)) {
          externalDependencies.push({ name, version, type: 'production' });
        }
      }
      if (packageJson.devDependencies) {
        for (const [name, version] of Object.entries(packageJson.devDependencies)) {
          externalDependencies.push({ name, version, type: 'development' });
        }
      }
    }

    return { nodes, edges, externalDependencies };
  }

  /**
   * Estimate line count for a file
   */
  private estimateLineCount(repoPath: string, filePath: string): number | undefined {
    const content = this.repoManager.readFile(repoPath, filePath);
    if (!content) return undefined;
    return content.split('\n').length;
  }

  /**
   * Generate findings based on analysis
   */
  private generateFindings(
    typeDetection: TypeDetectionResult,
    architecture: ArchitectureAnalysis
  ): Finding[] {
    const findings: Finding[] = [];

    // Check for missing documentation
    if (architecture.layers.length === 0) {
      findings.push({
        id: randomUUID(),
        agentType: 'structure-analyzer',
        findingType: 'architecture',
        severity: 'low',
        title: 'No clear layer structure detected',
        description: 'The repository does not follow a clear layered architecture pattern.',
        recommendation: 'Consider organizing code into distinct layers (presentation, business, data).',
      });
    }

    // Check for low confidence detection
    if (typeDetection.confidence < 0.5) {
      findings.push({
        id: randomUUID(),
        agentType: 'type-detector',
        findingType: 'maintainability',
        severity: 'info',
        title: 'Repository type unclear',
        description: `The repository type was detected with low confidence (${Math.round(typeDetection.confidence * 100)}%).`,
        recommendation: 'Add configuration files or documentation to clarify the project type.',
      });
    }

    return findings;
  }

  /**
   * Generate recommendations based on analysis
   */
  private generateRecommendations(
    typeDetection: TypeDetectionResult,
    architecture: ArchitectureAnalysis
  ): Recommendation[] {
    const recommendations: Recommendation[] = [];

    // Check for missing tests
    const hasTestingFramework = typeDetection.techStack.some(t =>
      ['jest', 'vitest', 'mocha', 'pytest', 'junit', 'cypress', 'playwright'].includes(t)
    );

    if (!hasTestingFramework) {
      recommendations.push({
        category: 'testing',
        priority: 'high',
        title: 'Add testing framework',
        description: 'No testing framework detected. Consider adding Jest, Vitest, or another testing framework.',
        effort: 'small',
        impact: 'high',
      });
    }

    // Check for documentation
    const prodDeps = architecture.dependencies.externalDependencies
      .filter(d => d.type === 'production');

    if (prodDeps.length > 20) {
      recommendations.push({
        category: 'maintainability',
        priority: 'medium',
        title: 'Review dependencies',
        description: `The project has ${prodDeps.length} production dependencies. Consider auditing for unused or redundant packages.`,
        effort: 'medium',
        impact: 'medium',
      });
    }

    return recommendations;
  }

  /**
   * Get the output generator for custom formatting
   */
  getOutputGenerator(): OutputGenerator {
    return this.outputGenerator;
  }

  /**
   * Get the repo manager for direct operations
   */
  getRepoManager(): RepoManager {
    return this.repoManager;
  }
}

export default RepositoryAnalyzer;
