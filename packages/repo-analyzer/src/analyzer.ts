/**
 * Repository Analyzer - Main orchestration class
 * Coordinates cloning, type detection, and analysis
 *
 * @module @adverant/repo-analyzer
 */

import { v4 as uuidv4 } from 'uuid';
import axios, { AxiosError } from 'axios';

import type {
  Analysis,
  AnalysisRequest,
  AnalysisResult,
  AnalysisStatus,
  AnalysisOptions,
  AnalysisProgress,
  ArchitectureAnalysis,
  Finding,
  SecurityFinding,
  Recommendation,
  TypeDetectionResult,
  DirectoryStructure,
  RepositoryMetadata,
  TenantContext,
  GitCredentials,
  FindingType,
} from './types/index.js';
import { RepoManager } from './manager.js';
import { TypeDetector } from './detector.js';
import { OutputGenerator } from './output.js';

/**
 * Configuration for the analyzer
 */
export interface AnalyzerConfig {
  credentials?: GitCredentials[];
  mageAgentUrl?: string;
  graphRagUrl?: string;
  enableAiAnalysis?: boolean;
  tempDir?: string;
}

/**
 * Event callback types
 */
export type ProgressCallback = (progress: AnalysisProgress) => void;

/**
 * Repository Analyzer - Main class for analyzing repositories
 */
export class RepositoryAnalyzer {
  private repoManager: RepoManager;
  private typeDetector: TypeDetector;
  private outputGenerator: OutputGenerator;
  private config: AnalyzerConfig;
  private activeAnalyses: Map<string, Analysis>;

  constructor(config: AnalyzerConfig = {}) {
    this.config = {
      mageAgentUrl: process.env.MAGEAGENT_URL || 'http://localhost:9010',
      graphRagUrl: process.env.GRAPHRAG_URL || 'http://localhost:8090',
      enableAiAnalysis: true,
      ...config,
    };

    this.repoManager = new RepoManager(config.credentials || []);
    this.typeDetector = new TypeDetector(this.repoManager);
    this.outputGenerator = new OutputGenerator();
    this.activeAnalyses = new Map();
  }

  /**
   * Analyze a repository
   */
  async analyze(
    request: AnalysisRequest,
    context?: TenantContext,
    onProgress?: ProgressCallback
  ): Promise<Analysis> {
    const analysisId = uuidv4();
    const parseResult = this.repoManager.parseRepoUrl(request.repoUrl);

    if (!parseResult.isValid) {
      throw new RepositoryAnalyzerError(
        `Invalid repository URL: ${parseResult.error}`,
        'INVALID_URL',
        { url: request.repoUrl }
      );
    }

    const analysis: Analysis = {
      id: analysisId,
      userId: context?.userId || 'anonymous',
      tenantId: context?.tenantId,
      repoUrl: request.repoUrl,
      repoName: `${parseResult.owner}/${parseResult.name}`,
      branch: request.branch || 'main',
      analysisDepth: request.analysisDepth || 'standard',
      includeSecurity: request.includeSecurityScan !== false,
      forceReanalysis: request.force || false,
      status: 'queued',
      progress: 0,
      usage: {
        tokensConsumed: 0,
        inputTokens: 0,
        outputTokens: 0,
        agentsUsed: 0,
        filesAnalyzed: 0,
        repoSizeBytes: 0,
        durationMs: 0,
        cacheHit: false,
      },
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    this.activeAnalyses.set(analysisId, analysis);

    // Emit initial progress
    if (onProgress) {
      onProgress({
        analysisId,
        status: analysis.status,
        progress: 0,
        currentStep: 'Starting analysis...',
      });
    }

    // Run analysis
    try {
      await this.runAnalysis(analysis, request, context, onProgress);
    } catch (error) {
      analysis.status = 'failed';
      analysis.errorMessage = error instanceof Error ? error.message : 'Unknown error';
      analysis.updatedAt = new Date();

      if (onProgress) {
        onProgress({
          analysisId,
          status: 'failed',
          progress: analysis.progress,
          currentStep: `Failed: ${analysis.errorMessage}`,
        });
      }
    }

    return analysis;
  }

  /**
   * Get analysis by ID
   */
  getAnalysis(analysisId: string): Analysis | undefined {
    return this.activeAnalyses.get(analysisId);
  }

  /**
   * Quick detect repository type without full analysis
   */
  async detectType(repoUrl: string, options?: { branch?: string }): Promise<TypeDetectionResult> {
    const cloneResult = await this.repoManager.cloneRepository(repoUrl, {
      branch: options?.branch,
      depth: 1,
    });

    if (!cloneResult.success) {
      throw new RepositoryAnalyzerError(
        `Failed to clone repository: ${cloneResult.error}`,
        'CLONE_FAILED',
        { url: repoUrl }
      );
    }

    try {
      const files = await this.repoManager.getFiles(cloneResult.localPath);
      const structure = await this.repoManager.getDirectoryStructure(cloneResult.localPath);

      return await this.typeDetector.detect(cloneResult.localPath, structure, files);
    } finally {
      await this.repoManager.cleanup(cloneResult.localPath);
    }
  }

  /**
   * Run the full analysis pipeline
   */
  private async runAnalysis(
    analysis: Analysis,
    request: AnalysisRequest,
    context?: TenantContext,
    onProgress?: ProgressCallback
  ): Promise<void> {
    const startTime = Date.now();
    let localPath: string | null = null;

    try {
      // Step 1: Clone repository
      this.updateProgress(analysis, 'cloning', 10, 'Cloning repository...', onProgress);

      const cloneResult = await this.repoManager.cloneRepository(request.repoUrl, {
        branch: request.branch,
        depth: 1,
      });

      if (!cloneResult.success) {
        throw new RepositoryAnalyzerError(
          `Failed to clone repository: ${cloneResult.error}`,
          'CLONE_FAILED',
          { url: request.repoUrl }
        );
      }

      localPath = cloneResult.localPath;
      analysis.commitHash = cloneResult.commitHash;
      analysis.branch = cloneResult.branch;

      // Step 2: Detect repository type
      this.updateProgress(analysis, 'detecting', 20, 'Analyzing project structure...', onProgress);

      const files = await this.repoManager.getFiles(localPath);
      const directoryStructure = await this.repoManager.getDirectoryStructure(localPath);
      const metadata = await this.repoManager.getRepositoryMetadata(localPath);

      const typeResult = await this.typeDetector.detect(localPath, directoryStructure, files);

      analysis.usage.filesAnalyzed = files.length;
      analysis.usage.repoSizeBytes = metadata.sizeBytes;

      // Step 3: Run analysis (AI or basic)
      this.updateProgress(analysis, 'analyzing', 40, 'Running analysis...', onProgress);

      const options: AnalysisOptions = {
        depth: analysis.analysisDepth,
        includeSecurityScan: analysis.includeSecurity,
        force: analysis.forceReanalysis,
      };

      let analysisResult: AnalysisResult;

      if (this.config.enableAiAnalysis) {
        // Use MageAgent for AI analysis
        analysisResult = await this.runAiAnalysis(
          analysis,
          localPath,
          typeResult,
          directoryStructure,
          files,
          metadata,
          options,
          context,
          onProgress
        );
      } else {
        // Basic analysis without AI
        analysisResult = await this.runBasicAnalysis(
          analysis,
          localPath,
          typeResult,
          directoryStructure,
          files,
          metadata,
          options
        );
      }

      // Step 4: Generate output
      this.updateProgress(analysis, 'generating', 90, 'Generating documentation...', onProgress);

      const archMd = this.outputGenerator.generateMarkdown(analysisResult, { format: 'markdown' });
      analysisResult.archMd = archMd;

      // Complete
      analysis.status = 'completed';
      analysis.progress = 100;
      analysis.result = analysisResult;
      analysis.usage.durationMs = Date.now() - startTime;
      analysis.completedAt = new Date();
      analysis.updatedAt = new Date();

      this.updateProgress(analysis, 'completed', 100, 'Analysis complete', onProgress);

    } finally {
      // Cleanup
      if (localPath) {
        await this.repoManager.cleanup(localPath);
      }
    }
  }

  /**
   * Run AI-powered analysis using MageAgent
   */
  private async runAiAnalysis(
    analysis: Analysis,
    localPath: string,
    typeResult: TypeDetectionResult,
    structure: DirectoryStructure,
    files: { path: string; name: string; extension: string; size: number }[],
    metadata: RepositoryMetadata,
    options: AnalysisOptions,
    context?: TenantContext,
    onProgress?: ProgressCallback
  ): Promise<AnalysisResult> {
    const findings: Finding[] = [];
    const securityFindings: SecurityFinding[] = [];
    const recommendations: Recommendation[] = [];

    // Select files for analysis based on depth
    const selectedFiles = this.selectFilesForAnalysis(files, options.depth);
    const fileContents = await this.repoManager.readFiles(localPath, selectedFiles);

    // Build context for AI analysis
    const analysisContext = {
      repoName: analysis.repoName,
      repoType: typeResult.primaryType,
      techStack: typeResult.techStack,
      directoryStructure: this.formatStructure(structure),
      fileCount: files.length,
      selectedFiles: Object.keys(fileContents),
    };

    // Categories to analyze
    const categories: FindingType[] = [
      'architecture',
      'performance',
      'documentation',
      'testing',
      'maintainability',
    ];

    if (options.includeSecurityScan) {
      categories.push('security');
    }

    let progressBase = 40;
    const progressPerCategory = 45 / categories.length;

    // Initialize architecture with defaults
    let architecture: ArchitectureAnalysis = {
      pattern: 'unknown',
      patternConfidence: 0,
      layers: [],
      components: [],
      dependencies: {
        nodes: [],
        edges: [],
        externalDependencies: [],
      },
    };

    for (const category of categories) {
      this.updateProgress(
        analysis,
        'analyzing',
        progressBase,
        `Analyzing ${category}...`,
        onProgress
      );

      try {
        const result = await this.callMageAgent(
          category,
          analysisContext,
          fileContents,
          context
        );

        if (result.success) {
          // Update token usage
          analysis.usage.tokensConsumed += result.tokensUsed;
          analysis.usage.agentsUsed++;

          // Process results
          if (category === 'architecture' && result.output) {
            architecture = this.processArchitectureResult(result.output, architecture);
          } else if (category === 'security' && result.output) {
            const secFindings = this.processSecurityFindings(result.output);
            securityFindings.push(...secFindings);
          } else if (result.output) {
            const categoryFindings = this.processFindings(result.output, category);
            findings.push(...categoryFindings);
          }

          // Extract recommendations
          if (result.output?.recommendations) {
            const recs = this.processRecommendations(result.output.recommendations, category);
            recommendations.push(...recs);
          }
        }
      } catch (error) {
        // Log error but continue with other categories
        console.error(`Analysis failed for category ${category}:`, error);
      }

      progressBase += progressPerCategory;
    }

    // Extract external dependencies from package.json
    const packageJson = await this.repoManager.readFile(localPath, 'package.json');
    if (packageJson) {
      try {
        const pkg = JSON.parse(packageJson);
        architecture.dependencies.externalDependencies = [
          ...Object.entries(pkg.dependencies || {}).map(([name, version]) => ({
            name,
            version: String(version),
            type: 'production' as const,
          })),
          ...Object.entries(pkg.devDependencies || {}).map(([name, version]) => ({
            name,
            version: String(version),
            type: 'development' as const,
          })),
        ];
      } catch {
        // Ignore JSON parse errors
      }
    }

    const parseResult = this.repoManager.parseRepoUrl(analysis.repoUrl);

    return {
      detectedType: typeResult.primaryType,
      techStack: typeResult.techStack,
      architecture,
      findings,
      securityFindings: options.includeSecurityScan ? securityFindings : undefined,
      recommendations,
      archMd: '',
      repositoryInfo: {
        url: analysis.repoUrl,
        platform: parseResult.platform!,
        owner: parseResult.owner!,
        name: parseResult.name!,
        branch: analysis.branch,
        commitHash: analysis.commitHash,
      },
      repositoryMetadata: metadata,
      directoryStructure: structure,
    };
  }

  /**
   * Run basic analysis without AI
   */
  private async runBasicAnalysis(
    analysis: Analysis,
    localPath: string,
    typeResult: TypeDetectionResult,
    structure: DirectoryStructure,
    _files: { path: string; name: string; extension: string; size: number }[],
    metadata: RepositoryMetadata,
    _options: AnalysisOptions
  ): Promise<AnalysisResult> {
    const parseResult = this.repoManager.parseRepoUrl(analysis.repoUrl);

    // Build basic architecture from detection
    const architecture: ArchitectureAnalysis = {
      pattern: this.inferPattern(typeResult),
      patternConfidence: typeResult.confidence,
      layers: [],
      components: [],
      dependencies: {
        nodes: [],
        edges: [],
        externalDependencies: [],
      },
    };

    // Extract dependencies from package.json
    const packageJson = await this.repoManager.readFile(localPath, 'package.json');
    if (packageJson) {
      try {
        const pkg = JSON.parse(packageJson);
        architecture.dependencies.externalDependencies = [
          ...Object.entries(pkg.dependencies || {}).map(([name, version]) => ({
            name,
            version: String(version),
            type: 'production' as const,
          })),
          ...Object.entries(pkg.devDependencies || {}).map(([name, version]) => ({
            name,
            version: String(version),
            type: 'development' as const,
          })),
        ];
      } catch {
        // Ignore JSON parse errors
      }
    }

    return {
      detectedType: typeResult.primaryType,
      techStack: typeResult.techStack,
      architecture,
      findings: [],
      recommendations: [],
      archMd: '',
      repositoryInfo: {
        url: analysis.repoUrl,
        platform: parseResult.platform!,
        owner: parseResult.owner!,
        name: parseResult.name!,
        branch: analysis.branch,
        commitHash: analysis.commitHash,
      },
      repositoryMetadata: metadata,
      directoryStructure: structure,
    };
  }

  /**
   * Call MageAgent for AI analysis
   */
  private async callMageAgent(
    category: string,
    analysisContext: Record<string, unknown>,
    fileContents: Record<string, string>,
    context?: TenantContext
  ): Promise<{
    success: boolean;
    output?: Record<string, unknown>;
    tokensUsed: number;
    error?: string;
  }> {
    const prompt = this.buildAnalysisPrompt(category, analysisContext, fileContents);

    try {
      const response = await axios.post(
        `${this.config.mageAgentUrl}/v1/orchestration/task`,
        {
          task: {
            id: uuidv4(),
            type: 'analysis',
            objective: prompt,
            constraints: {
              maxTokens: 8000,
              timeout: 120000,
            },
          },
          options: {
            model: 'anthropic/claude-3.5-sonnet',
            streaming: false,
          },
        },
        {
          headers: {
            'Content-Type': 'application/json',
            ...(context?.tenantId && { 'X-Tenant-Id': context.tenantId }),
            ...(context?.userId && { 'X-User-Id': context.userId }),
          },
          timeout: 120000,
        }
      );

      return {
        success: true,
        output: this.parseAgentOutput(response.data),
        tokensUsed: response.data.usage?.totalTokens || 0,
      };
    } catch (error) {
      const axiosError = error as AxiosError;
      return {
        success: false,
        tokensUsed: 0,
        error: axiosError.message || 'MageAgent call failed',
      };
    }
  }

  private buildAnalysisPrompt(
    category: string,
    analysisContext: Record<string, unknown>,
    fileContents: Record<string, string>
  ): string {
    const prompts: Record<string, string> = {
      architecture: `Analyze the architecture of this ${analysisContext.repoType} repository.
Identify:
- Architecture pattern (monolith, microservices, layered, etc.)
- Main layers and their responsibilities
- Key components and their relationships
- Data flow patterns

Repository: ${analysisContext.repoName}
Tech Stack: ${(analysisContext.techStack as string[]).join(', ')}

Files analyzed:
${Object.keys(fileContents).join('\n')}

Return JSON with: { pattern, patternConfidence, layers, components }`,

      security: `Perform a security analysis of this repository.
Look for:
- Hardcoded secrets or credentials
- SQL injection vulnerabilities
- XSS vulnerabilities
- Authentication/authorization issues
- Insecure dependencies

Repository: ${analysisContext.repoName}
Tech Stack: ${(analysisContext.techStack as string[]).join(', ')}

File contents to analyze:
${Object.entries(fileContents)
  .slice(0, 10)
  .map(([path, content]) => `--- ${path} ---\n${content.slice(0, 2000)}`)
  .join('\n\n')}

Return JSON with: { findings: [{ title, severity, description, location, cwe, remediation }] }`,

      performance: `Analyze performance characteristics of this repository.
Look for:
- N+1 query patterns
- Inefficient algorithms
- Memory leaks
- Blocking operations
- Missing caching

Repository: ${analysisContext.repoName}
Tech Stack: ${(analysisContext.techStack as string[]).join(', ')}

Return JSON with: { findings: [{ title, severity, description, location, recommendation }] }`,

      documentation: `Assess the documentation quality of this repository.
Check for:
- README quality and completeness
- API documentation
- Code comments
- Architecture documentation
- Onboarding documentation

Repository: ${analysisContext.repoName}
Files: ${analysisContext.fileCount} total

Return JSON with: { findings: [{ title, severity, description, recommendation }] }`,

      testing: `Analyze the testing practices of this repository.
Look for:
- Test coverage indicators
- Test types (unit, integration, e2e)
- Testing frameworks used
- Missing test areas

Repository: ${analysisContext.repoName}
Tech Stack: ${(analysisContext.techStack as string[]).join(', ')}

Return JSON with: { findings: [{ title, severity, description, recommendation }] }`,

      maintainability: `Assess the maintainability of this repository.
Check for:
- Code complexity
- Duplication
- Naming conventions
- Technical debt indicators
- Dependency health

Repository: ${analysisContext.repoName}
Tech Stack: ${(analysisContext.techStack as string[]).join(', ')}

Return JSON with: { findings: [{ title, severity, description, recommendation }] }`,
    };

    return prompts[category] || prompts.maintainability;
  }

  private parseAgentOutput(response: unknown): Record<string, unknown> | undefined {
    if (!response || typeof response !== 'object') {
      return undefined;
    }

    const data = response as Record<string, unknown>;
    if (data.result) return data.result as Record<string, unknown>;
    if (data.content) return data.content as Record<string, unknown>;
    if (data.output) return data.output as Record<string, unknown>;
    if (data.data) return data.data as Record<string, unknown>;

    return data;
  }

  private processArchitectureResult(
    output: Record<string, unknown>,
    current: ArchitectureAnalysis
  ): ArchitectureAnalysis {
    return {
      ...current,
      pattern: (output.pattern as ArchitectureAnalysis['pattern']) || current.pattern,
      patternConfidence: (output.patternConfidence as number) || current.patternConfidence,
      layers: (output.layers as ArchitectureAnalysis['layers']) || current.layers,
      components: (output.components as ArchitectureAnalysis['components']) || current.components,
    };
  }

  private processSecurityFindings(output: Record<string, unknown>): SecurityFinding[] {
    const items = (output.findings || output.vulnerabilities || []) as unknown[];
    if (!Array.isArray(items)) return [];

    return items.map((item) => {
      const f = item as Record<string, unknown>;
      return {
        id: uuidv4(),
        agentType: 'security',
        findingType: 'security' as FindingType,
        severity: (f.severity as SecurityFinding['severity']) || 'medium',
        title: String(f.title || f.name || ''),
        description: String(f.description || ''),
        location: f.location as string,
        lineNumber: f.lineNumber as number,
        cwe: f.cwe as string,
        owasp: f.owasp as string,
        cvss: f.cvss as number,
        remediation: String(f.remediation || f.recommendation || ''),
      };
    });
  }

  private processFindings(output: Record<string, unknown>, findingType: FindingType): Finding[] {
    const items = (output.findings || output.issues || []) as unknown[];
    if (!Array.isArray(items)) return [];

    return items.map((item) => {
      const f = item as Record<string, unknown>;
      return {
        id: uuidv4(),
        agentType: findingType,
        findingType,
        severity: (f.severity as Finding['severity']) || 'info',
        title: String(f.title || f.name || ''),
        description: String(f.description || ''),
        location: f.location as string,
        lineNumber: f.lineNumber as number,
        recommendation: f.recommendation as string,
      };
    });
  }

  private processRecommendations(recs: unknown, category: FindingType): Recommendation[] {
    if (!Array.isArray(recs)) return [];

    return recs.map((item) => {
      const r = item as Record<string, unknown>;
      return {
        category,
        priority: (r.priority as Recommendation['priority']) || 'medium',
        title: String(r.title || ''),
        description: String(r.description || ''),
        effort: (r.effort as Recommendation['effort']) || 'medium',
        impact: (r.impact as Recommendation['impact']) || 'medium',
      };
    });
  }

  private selectFilesForAnalysis(
    files: { path: string; extension: string; size: number }[],
    depth: 'quick' | 'standard' | 'deep'
  ): string[] {
    const limits = { quick: 20, standard: 50, deep: 100 };
    const limit = limits[depth];

    const priorityExtensions = ['.ts', '.tsx', '.js', '.jsx', '.py', '.go', '.rs', '.java'];
    const priorityNames = ['index', 'main', 'app', 'server', 'api', 'routes', 'controller'];

    return files
      .filter((f) => f.size < 500000)
      .map((f) => {
        let score = 0;
        if (priorityExtensions.includes(f.extension)) score += 10;
        const baseName = f.path.split('/').pop()?.replace(/\.[^.]+$/, '').toLowerCase() || '';
        if (priorityNames.some((n) => baseName.includes(n))) score += 5;
        if (!f.path.includes('/')) score += 3;
        score -= f.path.split('/').length;
        return { ...f, score };
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map((f) => f.path);
  }

  private formatStructure(structure: DirectoryStructure, depth = 0, maxDepth = 4): string {
    if (depth > maxDepth) return '';
    const indent = '  '.repeat(depth);
    let result = `${indent}${structure.name}${structure.type === 'directory' ? '/' : ''}\n`;
    if (structure.children && depth < maxDepth) {
      for (const child of structure.children.slice(0, 50)) {
        result += this.formatStructure(child, depth + 1, maxDepth);
      }
    }
    return result;
  }

  private inferPattern(typeResult: TypeDetectionResult): ArchitectureAnalysis['pattern'] {
    // Simple pattern inference based on type and indicators
    const hasLayers = typeResult.indicators.some(
      (i) => i.name.includes('controller') || i.name.includes('routes') || i.name.includes('api')
    );

    if (typeResult.primaryType === 'monorepo') {
      return 'plugin-based';
    }
    if (typeResult.primaryType === 'frontend') {
      if (typeResult.techStack.includes('react') || typeResult.techStack.includes('vue')) {
        return 'component-based';
      }
      return 'mvc';
    }
    if (typeResult.primaryType === 'backend') {
      if (hasLayers) {
        return 'layered-monolith';
      }
      return 'monolith';
    }

    return 'unknown';
  }

  private updateProgress(
    analysis: Analysis,
    status: AnalysisStatus,
    progress: number,
    step: string,
    onProgress?: ProgressCallback
  ): void {
    analysis.status = status;
    analysis.progress = progress;
    analysis.currentStep = step;
    analysis.updatedAt = new Date();

    if (onProgress) {
      onProgress({
        analysisId: analysis.id,
        status,
        progress,
        currentStep: step,
      });
    }
  }
}

/**
 * Custom error class for repository analyzer errors
 */
export class RepositoryAnalyzerError extends Error {
  public readonly code: string;
  public readonly context: Record<string, unknown>;

  constructor(message: string, code: string, context: Record<string, unknown> = {}) {
    super(message);
    this.name = 'RepositoryAnalyzerError';
    this.code = code;
    this.context = context;
    Error.captureStackTrace(this, this.constructor);
  }
}

export default RepositoryAnalyzer;