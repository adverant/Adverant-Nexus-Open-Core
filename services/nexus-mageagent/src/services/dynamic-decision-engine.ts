/**
 * Dynamic Decision Engine for Unified Orchestration Monitor (UOM)
 *
 * Implements 4 decision points for Sandbox-First file processing:
 * 1. Initial Triage - Determine sandbox tier and priority
 * 2. Security Assessment - Allow, block, or queue for review
 * 3. Processing Route - Route to appropriate handler service
 * 4. Post-Processing - Storage, learning, and notifications
 *
 * Key Features:
 * - ALL decisions are made by UOM (no hardcoded if/else)
 * - Pattern cache for fast-path decisions on known patterns
 * - LLM-powered decisions for complex/unknown scenarios
 * - Learning from outcomes to improve future decisions
 */

import { OpenRouterClient, CompletionResponse } from '../clients/openrouter-client';
import { logger } from '../utils/logger';
import { Counter, Histogram, Gauge } from 'prom-client';

// ============================================================================
// Prometheus Metrics
// ============================================================================

const uomDecisionCounter = new Counter({
  name: 'uom_decisions_total',
  help: 'Total UOM decisions by decision point and outcome',
  labelNames: ['decision_point', 'outcome', 'source']
});

const uomDecisionLatency = new Histogram({
  name: 'uom_decision_latency_seconds',
  help: 'UOM decision latency in seconds',
  labelNames: ['decision_point', 'model'],
  buckets: [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10]
});

const patternCacheHits = new Counter({
  name: 'uom_pattern_cache_hits_total',
  help: 'Pattern cache hits for fast-path decisions'
});

const patternCacheMisses = new Counter({
  name: 'uom_pattern_cache_misses_total',
  help: 'Pattern cache misses requiring LLM decision'
});

const patternCacheSize = new Gauge({
  name: 'uom_pattern_cache_size',
  help: 'Current size of the pattern cache'
});

// ============================================================================
// Type Definitions
// ============================================================================

/**
 * Decision points in the Sandbox-First flow
 */
export type UOMDecisionPoint =
  | 'initial_triage'
  | 'security_assessment'
  | 'processing_route'
  | 'post_processing';

/**
 * Sandbox analysis tiers
 */
export type SandboxTier = 'tier1' | 'tier2' | 'tier3';

/**
 * Security assessment actions
 */
export type SecurityAction = 'allow' | 'block' | 'review' | 'escalate';

/**
 * Target services for processing
 */
export type TargetService = 'cyberagent' | 'mageagent' | 'fileprocess';

/**
 * Storage destinations
 */
export type StorageDestination = 'graphrag' | 'qdrant' | 'postgres';

/**
 * Sandbox analysis result from CyberAgent
 */
export interface SandboxAnalysisResult {
  analysisId: string;
  correlationId: string;
  classification: {
    category: 'binary' | 'document' | 'archive' | 'media' | 'code' | 'data' | 'unknown';
    mimeType: string;
    format: string;
    confidence: number;
  };
  security: {
    threatLevel: 'safe' | 'low' | 'medium' | 'high' | 'critical';
    isMalicious: boolean;
    shouldBlock: boolean;
    flags: string[];
    yaraMatches?: string[];
  };
  recommendations: Array<{
    targetService: TargetService;
    method: string;
    priority: number;
    reason: string;
    confidence: number;
  }>;
  durationMs: number;
}

/**
 * Processing result from handler service
 */
export interface ProcessingResult {
  success: boolean;
  jobId: string;
  outputPath?: string;
  extractedContent?: string;
  artifacts?: string[];
  durationMs: number;
  error?: string;
}

/**
 * Organization security policy
 */
export interface OrgSecurityPolicy {
  requireTier3ForExecutables: boolean;
  autoBlockHighThreat: boolean;
  reviewQueueEnabled: boolean;
  trustedUsersBypass: boolean;
  maxFileSizeMB: number;
  allowedMimeTypes?: string[];
  blockedMimeTypes?: string[];
}

/**
 * UOM Decision Request - context for all decision points
 */
export interface UOMDecisionRequest {
  decisionPoint: UOMDecisionPoint;
  context: {
    // File context
    filename: string;
    mimeType: string;
    fileSize: number;
    fileHash?: string;
    storagePath?: string;

    // User context
    userId?: string;
    orgId?: string;
    userTrustScore?: number;
    orgPolicies?: OrgSecurityPolicy;

    // Sandbox context (for later decision points)
    sandboxResult?: SandboxAnalysisResult;

    // Processing context (for post-processing)
    processingResult?: ProcessingResult;

    // Historical context
    similarFilesProcessed?: number;
    patternMatchConfidence?: number;
  };
  correlationId: string;
  timestamp: string;
}

/**
 * Initial Triage Decision
 */
export interface InitialTriageDecision {
  sandboxTier: SandboxTier;
  priority: number; // 1-10
  timeout: number; // milliseconds
  tools: string[];
  reason: string;
}

/**
 * Security Assessment Decision
 */
export interface SecurityAssessmentDecision {
  action: SecurityAction;
  reason: string;
  reviewQueue?: string;
  notifyUsers?: string[];
  expiresAt?: string;
}

/**
 * Processing Route Decision
 */
export interface ProcessingRouteDecision {
  targetService: TargetService;
  method: string;
  tools?: string[];
  config?: Record<string, any>;
  priority: number;
  reason: string;
}

/**
 * Post-Processing Decision
 */
export interface PostProcessingDecision {
  storeIn: StorageDestination[];
  indexForSearch: boolean;
  generateEmbeddings: boolean;
  notifyUser: boolean;
  learnPattern: boolean;
  tags?: string[];
  reason: string;
}

/**
 * Generic UOM Decision Response
 */
export interface UOMDecisionResponse<T = Record<string, any>> {
  decision: T;
  confidence: number;
  reason: string;
  learnFromOutcome: boolean;
  source: 'pattern_cache' | 'llm_primary' | 'llm_fallback' | 'fast_path';
  durationMs: number;
  alternatives?: Array<{
    decision: T;
    confidence: number;
    reason: string;
  }>;
}

/**
 * Cached pattern entry
 */
interface CachedPattern {
  key: string;
  decisionPoint: UOMDecisionPoint;
  decision: any;
  confidence: number;
  successCount: number;
  failureCount: number;
  lastUsed: number;
  createdAt: number;
}

/**
 * Dynamic Decision Engine Configuration
 */
interface DynamicDecisionEngineConfig {
  primaryModel: string;
  fallbackModel: string;
  patternCacheTtlMs: number;
  maxPatternCacheSize: number;
  minConfidenceForCache: number;
  llmTimeoutMs: number;
  enableLearning: boolean;
}

// ============================================================================
// Dynamic Decision Engine
// ============================================================================

/**
 * DynamicDecisionEngine - LLM-Powered UOM for File Processing
 *
 * Implements intelligent, adaptive decision making for all 4 decision points
 * in the Sandbox-First file processing architecture.
 */
export class DynamicDecisionEngine {
  private openRouterClient: OpenRouterClient | null = null;
  private patternCache: Map<string, CachedPattern> = new Map();
  private config: DynamicDecisionEngineConfig;

  // Statistics
  private stats = {
    totalDecisions: 0,
    patternCacheHits: 0,
    llmCalls: 0,
    errors: 0,
    avgLatencyMs: 0
  };

  constructor(config?: Partial<DynamicDecisionEngineConfig>) {
    this.config = {
      primaryModel: config?.primaryModel || 'anthropic/claude-sonnet-4-5-20250514',
      fallbackModel: config?.fallbackModel || 'google/gemini-2.0-flash-001',
      patternCacheTtlMs: config?.patternCacheTtlMs || 24 * 60 * 60 * 1000, // 24 hours
      maxPatternCacheSize: config?.maxPatternCacheSize || 10000,
      minConfidenceForCache: config?.minConfidenceForCache || 0.85,
      llmTimeoutMs: config?.llmTimeoutMs || 15000,
      enableLearning: config?.enableLearning ?? true
    };

    logger.info('DynamicDecisionEngine initialized', {
      primaryModel: this.config.primaryModel,
      fallbackModel: this.config.fallbackModel,
      enableLearning: this.config.enableLearning
    });
  }

  /**
   * Inject OpenRouterClient dependency
   */
  setOpenRouterClient(client: OpenRouterClient): void {
    this.openRouterClient = client;
    logger.info('OpenRouterClient injected into DynamicDecisionEngine');
  }

  // ============================================================================
  // Main Decision Method
  // ============================================================================

  /**
   * Make a decision for any decision point
   */
  async decide<T>(request: UOMDecisionRequest): Promise<UOMDecisionResponse<T>> {
    const startTime = Date.now();
    this.stats.totalDecisions++;

    try {
      // 1. Check pattern cache for similar decisions
      const cachedDecision = await this.checkPatternCache<T>(request);
      if (cachedDecision) {
        patternCacheHits.inc();
        this.stats.patternCacheHits++;
        return {
          ...cachedDecision,
          durationMs: Date.now() - startTime
        };
      }
      patternCacheMisses.inc();

      // 2. Check for fast-path decisions (critical security patterns)
      const fastPathDecision = this.checkFastPath<T>(request);
      if (fastPathDecision) {
        return {
          ...fastPathDecision,
          durationMs: Date.now() - startTime
        };
      }

      // 3. Use LLM for intelligent decision
      if (!this.openRouterClient) {
        logger.warn('OpenRouterClient not available, using default decision');
        return this.getDefaultDecision<T>(request, Date.now() - startTime);
      }

      const llmDecision = await this.makeLLMDecision<T>(request);

      // 4. Record metrics
      const durationMs = Date.now() - startTime;
      uomDecisionLatency.labels(request.decisionPoint, 'llm').observe(durationMs / 1000);
      uomDecisionCounter.labels(
        request.decisionPoint,
        String(llmDecision.decision),
        llmDecision.source
      ).inc();

      return {
        ...llmDecision,
        durationMs
      };
    } catch (error) {
      this.stats.errors++;
      logger.error('DynamicDecisionEngine error', {
        decisionPoint: request.decisionPoint,
        correlationId: request.correlationId,
        error: error instanceof Error ? error.message : 'Unknown error'
      });

      return this.getDefaultDecision<T>(request, Date.now() - startTime);
    }
  }

  // ============================================================================
  // Decision Point Specific Methods
  // ============================================================================

  /**
   * Decision Point 1: Initial Triage
   * Determines sandbox tier, priority, and timeout
   */
  async decideInitialTriage(
    request: Omit<UOMDecisionRequest, 'decisionPoint'>
  ): Promise<UOMDecisionResponse<InitialTriageDecision>> {
    return this.decide<InitialTriageDecision>({
      ...request,
      decisionPoint: 'initial_triage'
    });
  }

  /**
   * Decision Point 2: Security Assessment
   * Determines allow, block, review, or escalate
   */
  async decideSecurityAssessment(
    request: Omit<UOMDecisionRequest, 'decisionPoint'>
  ): Promise<UOMDecisionResponse<SecurityAssessmentDecision>> {
    return this.decide<SecurityAssessmentDecision>({
      ...request,
      decisionPoint: 'security_assessment'
    });
  }

  /**
   * Decision Point 3: Processing Route
   * Determines target service and method
   */
  async decideProcessingRoute(
    request: Omit<UOMDecisionRequest, 'decisionPoint'>
  ): Promise<UOMDecisionResponse<ProcessingRouteDecision>> {
    return this.decide<ProcessingRouteDecision>({
      ...request,
      decisionPoint: 'processing_route'
    });
  }

  /**
   * Decision Point 4: Post-Processing
   * Determines storage, indexing, and learning
   */
  async decidePostProcessing(
    request: Omit<UOMDecisionRequest, 'decisionPoint'>
  ): Promise<UOMDecisionResponse<PostProcessingDecision>> {
    return this.decide<PostProcessingDecision>({
      ...request,
      decisionPoint: 'post_processing'
    });
  }

  // ============================================================================
  // Pattern Cache Management
  // ============================================================================

  /**
   * Check pattern cache for similar decisions
   */
  private async checkPatternCache<T>(
    request: UOMDecisionRequest
  ): Promise<UOMDecisionResponse<T> | null> {
    const cacheKey = this.generatePatternKey(request);
    const cached = this.patternCache.get(cacheKey);

    if (!cached) return null;

    // Check TTL
    if (Date.now() - cached.createdAt > this.config.patternCacheTtlMs) {
      this.patternCache.delete(cacheKey);
      patternCacheSize.set(this.patternCache.size);
      return null;
    }

    // Check confidence threshold
    const effectiveConfidence = this.calculateEffectiveConfidence(cached);
    if (effectiveConfidence < this.config.minConfidenceForCache) {
      return null;
    }

    // Update last used
    cached.lastUsed = Date.now();

    return {
      decision: cached.decision as T,
      confidence: effectiveConfidence,
      reason: `Pattern match (${cached.successCount} successes)`,
      learnFromOutcome: this.config.enableLearning,
      source: 'pattern_cache',
      durationMs: 0
    };
  }

  /**
   * Generate a cache key from the request context
   */
  private generatePatternKey(request: UOMDecisionRequest): string {
    const { context, decisionPoint } = request;

    // Extract key characteristics
    const fileExt = context.filename.split('.').pop()?.toLowerCase() || '';
    const mimeCategory = context.mimeType.split('/')[0] || '';
    const sizeCategory = this.categorizeFileSize(context.fileSize);
    const threatLevel = context.sandboxResult?.security.threatLevel || 'unknown';
    const category = context.sandboxResult?.classification.category || 'unknown';

    const keyParts = [
      decisionPoint,
      fileExt,
      mimeCategory,
      sizeCategory,
      category,
      threatLevel
    ];

    return keyParts.join('|');
  }

  /**
   * Categorize file size for caching
   */
  private categorizeFileSize(size: number): string {
    if (size < 1024 * 1024) return 'small'; // < 1MB
    if (size < 10 * 1024 * 1024) return 'medium'; // < 10MB
    if (size < 100 * 1024 * 1024) return 'large'; // < 100MB
    return 'xlarge';
  }

  /**
   * Calculate effective confidence based on success/failure ratio
   */
  private calculateEffectiveConfidence(cached: CachedPattern): number {
    const total = cached.successCount + cached.failureCount;
    if (total === 0) return cached.confidence;

    const successRate = cached.successCount / total;
    // Blend cached confidence with success rate
    return (cached.confidence * 0.3) + (successRate * 0.7);
  }

  /**
   * Store a successful pattern in the cache
   */
  async storePattern(
    request: UOMDecisionRequest,
    decision: any,
    confidence: number
  ): Promise<void> {
    if (!this.config.enableLearning) return;
    if (confidence < this.config.minConfidenceForCache) return;

    const key = this.generatePatternKey(request);

    // LRU eviction
    if (this.patternCache.size >= this.config.maxPatternCacheSize) {
      let oldestKey = '';
      let oldestTime = Date.now();

      for (const [k, v] of this.patternCache.entries()) {
        if (v.lastUsed < oldestTime) {
          oldestTime = v.lastUsed;
          oldestKey = k;
        }
      }

      if (oldestKey) {
        this.patternCache.delete(oldestKey);
      }
    }

    const existing = this.patternCache.get(key);
    if (existing) {
      existing.successCount++;
      existing.lastUsed = Date.now();
      existing.confidence = (existing.confidence + confidence) / 2;
    } else {
      this.patternCache.set(key, {
        key,
        decisionPoint: request.decisionPoint,
        decision,
        confidence,
        successCount: 1,
        failureCount: 0,
        lastUsed: Date.now(),
        createdAt: Date.now()
      });
    }

    patternCacheSize.set(this.patternCache.size);
  }

  /**
   * Record a pattern failure
   */
  async recordPatternFailure(request: UOMDecisionRequest): Promise<void> {
    if (!this.config.enableLearning) return;

    const key = this.generatePatternKey(request);
    const existing = this.patternCache.get(key);

    if (existing) {
      existing.failureCount++;

      // Remove pattern if failure rate exceeds threshold
      const total = existing.successCount + existing.failureCount;
      if (total >= 5 && existing.failureCount / total > 0.3) {
        this.patternCache.delete(key);
        patternCacheSize.set(this.patternCache.size);
        logger.info('Pattern removed due to high failure rate', {
          key,
          successCount: existing.successCount,
          failureCount: existing.failureCount
        });
      }
    }
  }

  // ============================================================================
  // Fast-Path Decisions
  // ============================================================================

  /**
   * Check for critical fast-path decisions (no LLM needed)
   */
  private checkFastPath<T>(request: UOMDecisionRequest): UOMDecisionResponse<T> | null {
    const { decisionPoint, context } = request;

    // Security Assessment fast-paths
    if (decisionPoint === 'security_assessment' && context.sandboxResult) {
      const { security } = context.sandboxResult;

      // BLOCK: Critical threat or malicious
      if (security.threatLevel === 'critical' || security.isMalicious) {
        const decision: SecurityAssessmentDecision = {
          action: 'block',
          reason: `Critical threat detected: ${security.flags.join(', ')}`,
          notifyUsers: ['security@nexus.internal']
        };

        return {
          decision: decision as unknown as T,
          confidence: 1.0,
          reason: 'Fast-path: Critical threat detection',
          learnFromOutcome: false,
          source: 'fast_path',
          durationMs: 0
        };
      }

      // REVIEW: High threat
      if (security.threatLevel === 'high' && !security.shouldBlock) {
        const decision: SecurityAssessmentDecision = {
          action: 'review',
          reason: `High threat requires review: ${security.flags.join(', ')}`,
          reviewQueue: 'security-review',
          expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()
        };

        return {
          decision: decision as unknown as T,
          confidence: 0.95,
          reason: 'Fast-path: High threat review',
          learnFromOutcome: true,
          source: 'fast_path',
          durationMs: 0
        };
      }

      // ALLOW: Safe with high confidence
      if (security.threatLevel === 'safe' && context.sandboxResult.classification.confidence > 0.95) {
        const decision: SecurityAssessmentDecision = {
          action: 'allow',
          reason: 'Safe file with high confidence classification'
        };

        return {
          decision: decision as unknown as T,
          confidence: 0.98,
          reason: 'Fast-path: Safe file detection',
          learnFromOutcome: true,
          source: 'fast_path',
          durationMs: 0
        };
      }
    }

    // Initial Triage fast-paths
    if (decisionPoint === 'initial_triage') {
      const ext = context.filename.split('.').pop()?.toLowerCase() || '';

      // Executable files always get Tier 3
      const executableExts = ['exe', 'dll', 'so', 'dylib', 'bin', 'msi', 'dmg', 'app'];
      if (executableExts.includes(ext)) {
        const decision: InitialTriageDecision = {
          sandboxTier: 'tier3',
          priority: 9,
          timeout: 120000,
          tools: ['magic_detect', 'yara_full', 'ghidra', 'strings', 'pe_analysis'],
          reason: 'Executable file requires full security analysis'
        };

        return {
          decision: decision as unknown as T,
          confidence: 1.0,
          reason: 'Fast-path: Executable detection',
          learnFromOutcome: false,
          source: 'fast_path',
          durationMs: 0
        };
      }

      // Archive files get Tier 2
      const archiveExts = ['zip', 'rar', '7z', 'tar', 'gz', 'bz2'];
      if (archiveExts.includes(ext)) {
        const decision: InitialTriageDecision = {
          sandboxTier: 'tier2',
          priority: 7,
          timeout: 60000,
          tools: ['magic_detect', 'yara_quick', 'archive_scan'],
          reason: 'Archive file requires extraction and content scan'
        };

        return {
          decision: decision as unknown as T,
          confidence: 0.95,
          reason: 'Fast-path: Archive detection',
          learnFromOutcome: true,
          source: 'fast_path',
          durationMs: 0
        };
      }
    }

    return null;
  }

  // ============================================================================
  // LLM Decision Making
  // ============================================================================

  /**
   * Make an LLM-powered decision
   */
  private async makeLLMDecision<T>(
    request: UOMDecisionRequest
  ): Promise<UOMDecisionResponse<T>> {
    this.stats.llmCalls++;

    const model = this.selectModel(request);
    const prompt = this.buildDecisionPrompt(request);

    try {
      const response = await Promise.race([
        this.openRouterClient!.createCompletion({
          model,
          messages: [
            { role: 'system', content: this.getSystemPrompt(request.decisionPoint) },
            { role: 'user', content: prompt }
          ],
          max_tokens: 1500,
          temperature: 0.1,
          response_format: { type: 'json_object' }
        }),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('LLM timeout')), this.config.llmTimeoutMs)
        )
      ]) as CompletionResponse;

      const parsed = this.parseLLMResponse<T>(response, request.decisionPoint);

      logger.debug('LLM decision made', {
        decisionPoint: request.decisionPoint,
        correlationId: request.correlationId,
        model,
        confidence: parsed.confidence
      });

      return {
        decision: parsed.decision,
        confidence: parsed.confidence,
        reason: parsed.reason,
        learnFromOutcome: this.config.enableLearning,
        source: model === this.config.primaryModel ? 'llm_primary' : 'llm_fallback',
        durationMs: 0,
        alternatives: parsed.alternatives
      };
    } catch (error) {
      logger.error('LLM decision failed', {
        decisionPoint: request.decisionPoint,
        correlationId: request.correlationId,
        model,
        error: error instanceof Error ? error.message : 'Unknown error'
      });

      // Try fallback model
      if (model === this.config.primaryModel) {
        return this.makeLLMDecisionWithFallback<T>(request);
      }

      throw error;
    }
  }

  /**
   * Try fallback model
   */
  private async makeLLMDecisionWithFallback<T>(
    request: UOMDecisionRequest
  ): Promise<UOMDecisionResponse<T>> {
    const prompt = this.buildDecisionPrompt(request);

    const response = await Promise.race([
      this.openRouterClient!.createCompletion({
        model: this.config.fallbackModel,
        messages: [
          { role: 'system', content: this.getSystemPrompt(request.decisionPoint) },
          { role: 'user', content: prompt }
        ],
        max_tokens: 1500,
        temperature: 0.1,
        response_format: { type: 'json_object' }
      }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('LLM timeout')), this.config.llmTimeoutMs)
      )
    ]) as CompletionResponse;

    const parsed = this.parseLLMResponse<T>(response, request.decisionPoint);

    return {
      decision: parsed.decision,
      confidence: parsed.confidence * 0.9, // Slight confidence penalty for fallback
      reason: parsed.reason,
      learnFromOutcome: this.config.enableLearning,
      source: 'llm_fallback',
      durationMs: 0
    };
  }

  /**
   * Select appropriate model based on decision complexity
   */
  private selectModel(request: UOMDecisionRequest): string {
    const { decisionPoint, context } = request;

    // Use primary model for complex scenarios
    const isComplex =
      decisionPoint === 'security_assessment' ||
      context.sandboxResult?.security.threatLevel === 'high' ||
      context.sandboxResult?.security.threatLevel === 'medium' ||
      context.sandboxResult?.classification.category === 'binary' ||
      context.fileSize > 50 * 1024 * 1024; // > 50MB

    return isComplex ? this.config.primaryModel : this.config.fallbackModel;
  }

  /**
   * Get system prompt for decision point
   */
  private getSystemPrompt(decisionPoint: UOMDecisionPoint): string {
    const basePrompt = `You are the Unified Orchestration Monitor (UOM) for Nexus file processing.
Your role is to make intelligent routing and security decisions for files.
Respond ONLY with a valid JSON object matching the required schema.`;

    const decisionSpecific: Record<UOMDecisionPoint, string> = {
      initial_triage: `
${basePrompt}

## Decision Point: Initial Triage
Determine which sandbox tier and tools to use for initial file analysis.

### Sandbox Tiers
- **tier1**: Quick scan (<5s) - Basic magic bytes, quick YARA, classification
- **tier2**: Standard scan (5-30s) - YARA full, strings, basic decompilation
- **tier3**: Deep scan (30-120s) - Full decompilation, behavioral analysis, emulation

### Response Schema
{
  "sandboxTier": "tier1" | "tier2" | "tier3",
  "priority": 1-10,  // Higher = more urgent
  "timeout": number, // milliseconds
  "tools": ["magic_detect", "yara_quick", "yara_full", "strings", "ghidra", "pe_analysis", "archive_scan"],
  "reason": "explanation"
}

### Decision Guidelines
- Executable files (exe, dll, so) → tier3, priority 9
- Archive files (zip, rar, 7z) → tier2, priority 7
- Office documents → tier2, priority 6
- PDF files → tier2, priority 5
- Known document types → tier1, priority 3
- Large files (>50MB) → increase tier
- Unknown/suspicious → increase tier`,

      security_assessment: `
${basePrompt}

## Decision Point: Security Assessment
Determine security action based on sandbox analysis results.

### Actions
- **allow**: File is safe to process
- **block**: File is dangerous, reject immediately
- **review**: File needs human review (high threat but not certain)
- **escalate**: Alert security team, critical threat

### Response Schema
{
  "action": "allow" | "block" | "review" | "escalate",
  "reason": "explanation",
  "reviewQueue": "security-review" | "auto-approve-24h", // only if action is "review"
  "notifyUsers": ["email@domain.com"], // optional
  "expiresAt": "ISO8601" // review expiration
}

### Decision Guidelines
- Critical threat or isMalicious → block
- High threat with uncertainty → review
- Multiple YARA matches → review or block
- Known safe patterns → allow
- Trusted user with low threat → allow with monitoring`,

      processing_route: `
${basePrompt}

## Decision Point: Processing Route
Determine which service should process the file.

### Target Services
- **cyberagent**: Security analysis, binary decompilation, threat intel
- **mageagent**: Dynamic/unknown file processing, AI-powered analysis
- **fileprocess**: Standard document processing (OCR, text extraction)

### Response Schema
{
  "targetService": "cyberagent" | "mageagent" | "fileprocess",
  "method": "binary_analysis" | "document_extraction" | "dynamic_process" | "ocr_extract",
  "tools": ["ghidra", "yara", "strings", "tessaract"], // optional
  "config": { "deep_scan": true }, // optional
  "priority": 1-10,
  "reason": "explanation"
}

### Decision Guidelines
- Binary files → cyberagent with binary_analysis
- Unknown/exotic formats → mageagent with dynamic_process
- Documents (PDF, DOC, etc) → fileprocess with document_extraction
- Scanned documents → fileprocess with ocr_extract
- Media files → fileprocess or mageagent based on type`,

      post_processing: `
${basePrompt}

## Decision Point: Post-Processing
Determine how to store, index, and learn from processing results.

### Storage Destinations
- **graphrag**: Knowledge graph and semantic memory
- **qdrant**: Vector embeddings for similarity search
- **postgres**: Structured metadata and audit trail

### Response Schema
{
  "storeIn": ["graphrag", "qdrant", "postgres"],
  "indexForSearch": true | false,
  "generateEmbeddings": true | false,
  "notifyUser": true | false,
  "learnPattern": true | false,
  "tags": ["category", "type"],
  "reason": "explanation"
}

### Decision Guidelines
- Successful processing → store in all relevant destinations
- Text content → generate embeddings, index for search
- Failed processing → store in postgres only (audit)
- Sensitive content → limit storage, no learning
- Repeated patterns → learn for faster future decisions`
    };

    return decisionSpecific[decisionPoint];
  }

  /**
   * Build decision prompt from request context
   */
  private buildDecisionPrompt(request: UOMDecisionRequest): string {
    const { context, correlationId, timestamp } = request;

    let prompt = `## File Information
- Filename: ${context.filename}
- MIME Type: ${context.mimeType}
- File Size: ${this.formatFileSize(context.fileSize)}
- Storage Path: ${context.storagePath || 'not specified'}
- Correlation ID: ${correlationId}
- Timestamp: ${timestamp}

## User Context
- User ID: ${context.userId || 'anonymous'}
- Organization ID: ${context.orgId || 'unknown'}
- User Trust Score: ${context.userTrustScore ?? 'not available'}`;

    if (context.orgPolicies) {
      prompt += `

## Organization Policies
${JSON.stringify(context.orgPolicies, null, 2)}`;
    }

    if (context.sandboxResult) {
      prompt += `

## Sandbox Analysis Results
### Classification
- Category: ${context.sandboxResult.classification.category}
- Format: ${context.sandboxResult.classification.format}
- Confidence: ${(context.sandboxResult.classification.confidence * 100).toFixed(1)}%

### Security Assessment
- Threat Level: ${context.sandboxResult.security.threatLevel}
- Is Malicious: ${context.sandboxResult.security.isMalicious}
- Should Block: ${context.sandboxResult.security.shouldBlock}
- Flags: ${context.sandboxResult.security.flags.join(', ') || 'none'}
${context.sandboxResult.security.yaraMatches?.length ? `- YARA Matches: ${context.sandboxResult.security.yaraMatches.join(', ')}` : ''}

### Sandbox Recommendations
${context.sandboxResult.recommendations.map(r =>
  `- ${r.targetService}: ${r.method} (priority: ${r.priority}, confidence: ${(r.confidence * 100).toFixed(1)}%)`
).join('\n')}

### Analysis Duration
- Sandbox Time: ${context.sandboxResult.durationMs}ms`;
    }

    if (context.processingResult) {
      prompt += `

## Processing Results
- Success: ${context.processingResult.success}
- Job ID: ${context.processingResult.jobId}
- Duration: ${context.processingResult.durationMs}ms
${context.processingResult.error ? `- Error: ${context.processingResult.error}` : ''}
${context.processingResult.artifacts?.length ? `- Artifacts: ${context.processingResult.artifacts.length} files` : ''}`;
    }

    if (context.similarFilesProcessed !== undefined) {
      prompt += `

## Historical Context
- Similar Files Processed: ${context.similarFilesProcessed}
- Pattern Match Confidence: ${context.patternMatchConfidence ? (context.patternMatchConfidence * 100).toFixed(1) + '%' : 'N/A'}`;
    }

    prompt += `

Make a decision based on the above context.`;

    return prompt;
  }

  /**
   * Format file size for display
   */
  private formatFileSize(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
  }

  /**
   * Parse LLM response
   */
  private parseLLMResponse<T>(
    response: CompletionResponse,
    decisionPoint: UOMDecisionPoint
  ): { decision: T; confidence: number; reason: string; alternatives?: Array<{ decision: T; confidence: number; reason: string }> } {
    const content = response.choices[0]?.message?.content || '';

    try {
      const parsed = JSON.parse(content);

      // Validate required fields based on decision point
      this.validateDecision(parsed, decisionPoint);

      return {
        decision: parsed as T,
        confidence: parsed.confidence ?? 0.8,
        reason: parsed.reason || 'LLM decision',
        alternatives: parsed.alternatives
      };
    } catch (error) {
      logger.error('Failed to parse LLM response', {
        decisionPoint,
        content: content.substring(0, 500),
        error: error instanceof Error ? error.message : 'Unknown error'
      });

      throw new Error(`Failed to parse LLM response: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Validate decision structure
   */
  private validateDecision(parsed: any, decisionPoint: UOMDecisionPoint): void {
    switch (decisionPoint) {
      case 'initial_triage':
        if (!parsed.sandboxTier || !['tier1', 'tier2', 'tier3'].includes(parsed.sandboxTier)) {
          throw new Error('Invalid sandboxTier');
        }
        if (typeof parsed.priority !== 'number' || parsed.priority < 1 || parsed.priority > 10) {
          throw new Error('Invalid priority');
        }
        break;

      case 'security_assessment':
        if (!parsed.action || !['allow', 'block', 'review', 'escalate'].includes(parsed.action)) {
          throw new Error('Invalid action');
        }
        break;

      case 'processing_route':
        if (!parsed.targetService || !['cyberagent', 'mageagent', 'fileprocess'].includes(parsed.targetService)) {
          throw new Error('Invalid targetService');
        }
        break;

      case 'post_processing':
        if (!parsed.storeIn || !Array.isArray(parsed.storeIn)) {
          throw new Error('Invalid storeIn');
        }
        break;
    }
  }

  /**
   * Get default decision when LLM is unavailable
   */
  private getDefaultDecision<T>(
    request: UOMDecisionRequest,
    durationMs: number
  ): UOMDecisionResponse<T> {
    const defaults: Record<UOMDecisionPoint, any> = {
      initial_triage: {
        sandboxTier: 'tier2',
        priority: 5,
        timeout: 60000,
        tools: ['magic_detect', 'yara_quick'],
        reason: 'Default triage decision (LLM unavailable)'
      },
      security_assessment: {
        action: 'review',
        reason: 'Default review decision (LLM unavailable)',
        reviewQueue: 'security-review'
      },
      processing_route: {
        targetService: 'fileprocess',
        method: 'document_extraction',
        priority: 5,
        reason: 'Default routing decision (LLM unavailable)'
      },
      post_processing: {
        storeIn: ['postgres'],
        indexForSearch: false,
        generateEmbeddings: false,
        notifyUser: true,
        learnPattern: false,
        reason: 'Default storage decision (LLM unavailable)'
      }
    };

    return {
      decision: defaults[request.decisionPoint] as T,
      confidence: 0.5,
      reason: 'Default decision (LLM unavailable)',
      learnFromOutcome: false,
      source: 'fast_path',
      durationMs
    };
  }

  // ============================================================================
  // Statistics and Management
  // ============================================================================

  /**
   * Get engine statistics
   */
  getStatistics(): {
    totalDecisions: number;
    patternCacheHits: number;
    patternCacheHitRate: number;
    llmCalls: number;
    errors: number;
    avgLatencyMs: number;
    patternCacheSize: number;
  } {
    return {
      ...this.stats,
      patternCacheHitRate: this.stats.totalDecisions > 0
        ? this.stats.patternCacheHits / this.stats.totalDecisions
        : 0,
      patternCacheSize: this.patternCache.size
    };
  }

  /**
   * Clear pattern cache
   */
  clearPatternCache(): void {
    this.patternCache.clear();
    patternCacheSize.set(0);
    logger.info('Pattern cache cleared');
  }

  /**
   * Export patterns for backup/analysis
   */
  exportPatterns(): CachedPattern[] {
    return Array.from(this.patternCache.values());
  }

  /**
   * Import patterns from backup
   */
  importPatterns(patterns: CachedPattern[]): void {
    for (const pattern of patterns) {
      this.patternCache.set(pattern.key, pattern);
    }
    patternCacheSize.set(this.patternCache.size);
    logger.info('Patterns imported', { count: patterns.length });
  }
}

// ============================================================================
// Singleton Management
// ============================================================================

let dynamicDecisionEngineInstance: DynamicDecisionEngine | null = null;

/**
 * Get or create the dynamic decision engine instance
 */
export function getDynamicDecisionEngine(): DynamicDecisionEngine {
  if (!dynamicDecisionEngineInstance) {
    dynamicDecisionEngineInstance = new DynamicDecisionEngine();
  }
  return dynamicDecisionEngineInstance;
}

/**
 * Create a fresh dynamic decision engine (for testing)
 */
export function createDynamicDecisionEngine(
  config?: Partial<DynamicDecisionEngineConfig>
): DynamicDecisionEngine {
  return new DynamicDecisionEngine(config);
}

/**
 * Reset the singleton instance (for testing)
 */
export function resetDynamicDecisionEngine(): void {
  dynamicDecisionEngineInstance = null;
}
