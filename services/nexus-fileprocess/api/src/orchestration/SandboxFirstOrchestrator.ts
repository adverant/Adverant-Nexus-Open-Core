/**
 * Sandbox-First Orchestrator
 *
 * Implements the Sandbox-First Unified Orchestration Monitor (UOM) architecture.
 * ALL files go through sandbox analysis before any routing decisions.
 * ALL decisions are made dynamically by UOM (no hardcoded if/else logic).
 *
 * Flow:
 * 1. File Received → Triage Decision (sandbox tier)
 * 2. Sandbox Analysis → Security Decision (allow/block/review)
 * 3. Security Passed → Route Decision (target service)
 * 4. Processing Complete → Post-Processing Decision (storage/learning)
 *
 * Key Features:
 * - Async processing with SSE updates
 * - Pattern learning from outcomes
 * - Complete telemetry for observability
 * - Circuit breaker for resilience
 */

import { v4 as uuidv4 } from 'uuid';
import { logger } from '../utils/logger';
import { getCyberAgentClient, ScanResult, ThreatLevel as CyberThreatLevel } from '../clients/CyberAgentClient';
import { VideoAgentClient, getVideoAgentClient } from '../clients/VideoAgentClient';
import { GeoAgentClient, getGeoAgentClient } from '../clients/GeoAgentClient';
import { getGitHubManagerClient } from '../clients/GitHubManagerClient';
import { getMageAgentClient, MageAgentResponse } from '../clients/MageAgentClient';
import { getPatternLearningService } from '../services/pattern-learning-service';
import { isGitHubRepoUrl, extractGitHubRepoInfo } from '../utils/url-detector';
import {
  FileContext,
  UserContext,
  OrgSecurityPolicy,
  SandboxAnalysisResult,
  FileClassification,
  SandboxRecommendation,
  ThreatLevel,
  TargetService,
  StorageDestination,
  UOMDecision,
  InitialTriageDecision,
  SecurityAssessmentDecision,
  ProcessingRouteDecision,
  PostProcessingDecision
} from '@adverant/nexus-telemetry';
import { Counter, Histogram, Gauge } from 'prom-client';

// ============================================================================
// Prometheus Metrics
// ============================================================================

const orchestrationCounter = new Counter({
  name: 'sandbox_orchestration_total',
  help: 'Total orchestration operations by stage and outcome',
  labelNames: ['stage', 'outcome']
});

const orchestrationLatency = new Histogram({
  name: 'sandbox_orchestration_latency_seconds',
  help: 'Orchestration latency by stage',
  labelNames: ['stage'],
  buckets: [0.1, 0.5, 1, 2, 5, 10, 30, 60, 120]
});

const activeOrchestrations = new Gauge({
  name: 'sandbox_orchestrations_active',
  help: 'Currently active orchestration jobs'
});

const filesByThreatLevel = new Counter({
  name: 'sandbox_files_by_threat_level',
  help: 'Files processed by threat level',
  labelNames: ['threat_level']
});

const videoRoutingCounter = new Counter({
  name: 'sandbox_video_routing_total',
  help: 'Total video files routed to VideoAgent',
  labelNames: ['pipeline', 'outcome']
});

const videoProcessingDuration = new Histogram({
  name: 'sandbox_video_processing_duration_seconds',
  help: 'Total video processing duration',
  labelNames: ['pipeline'],
  buckets: [10, 30, 60, 120, 300, 600, 1800, 3600]
});

// ============================================================================
// Types
// ============================================================================

/**
 * Orchestration job status
 */
export type OrchestrationStatus =
  | 'pending'
  | 'triaging'
  | 'sandbox_running'
  | 'security_assessment'
  | 'routing'
  | 'processing'
  | 'post_processing'
  | 'completed'
  | 'blocked'
  | 'review_queued'
  | 'failed';

/**
 * Orchestration job tracking
 */
export interface OrchestrationJob {
  id: string;
  correlationId: string;
  status: OrchestrationStatus;
  file: FileContext;
  user?: UserContext;
  orgPolicies?: OrgSecurityPolicy;

  // Decision results
  triageDecision?: UOMDecision<InitialTriageDecision>;
  sandboxResult?: SandboxAnalysisResult;
  securityDecision?: UOMDecision<SecurityAssessmentDecision>;
  routeDecision?: UOMDecision<ProcessingRouteDecision>;
  postProcessDecision?: UOMDecision<PostProcessingDecision>;

  // Processing results
  processingJobId?: string;
  processingResult?: ProcessingResult;

  // Timing
  createdAt: Date;
  updatedAt: Date;
  completedAt?: Date;

  // Errors
  error?: string;
  errorStage?: string;

  // Progress tracking for SSE
  progress: number; // 0-100
  currentStage: string;
  stageMessages: StageMessage[];
}

/**
 * Processing result from handler service
 */
interface ProcessingResult {
  success: boolean;
  jobId: string;
  outputPath?: string;
  extractedContent?: string;
  artifacts?: string[];
  durationMs: number;
  error?: string;
}

/**
 * Stage message for SSE updates
 */
interface StageMessage {
  timestamp: Date;
  stage: string;
  message: string;
  data?: Record<string, unknown>;
}

/**
 * Orchestration request
 */
export interface OrchestrationRequest {
  file: FileContext;
  user?: UserContext;
  orgPolicies?: OrgSecurityPolicy;
  async?: boolean; // Return 202 with job ID
  priority?: number;
}

/**
 * Orchestration response
 */
export interface OrchestrationResponse {
  jobId: string;
  status: OrchestrationStatus;
  progress: number;
  currentStage: string;
  result?: {
    success: boolean;
    threatLevel?: ThreatLevel;
    targetService?: TargetService;
    processingResult?: ProcessingResult;
    storedIn?: StorageDestination[];
  };
  error?: string;
  sseEndpoint?: string;
}

/**
 * Decision Engine interface (imported from MageAgent)
 * We define a minimal interface here to avoid circular dependencies
 */
interface DecisionEngine {
  decideInitialTriage(request: DecisionRequest): Promise<DecisionResponse<InitialTriageDecision>>;
  decideSecurityAssessment(request: DecisionRequest): Promise<DecisionResponse<SecurityAssessmentDecision>>;
  decideProcessingRoute(request: DecisionRequest): Promise<DecisionResponse<ProcessingRouteDecision>>;
  decidePostProcessing(request: DecisionRequest): Promise<DecisionResponse<PostProcessingDecision>>;
  storePattern(request: DecisionRequest, decision: unknown, confidence: number): Promise<void>;
  recordPatternFailure(request: DecisionRequest): Promise<void>;
}

interface DecisionRequest {
  context: {
    filename: string;
    mimeType: string;
    fileSize: number;
    fileHash?: string;
    storagePath?: string;
    userId?: string;
    orgId?: string;
    userTrustScore?: number;
    orgPolicies?: OrgSecurityPolicy;
    sandboxResult?: SandboxAnalysisResult;
    processingResult?: ProcessingResult;
    similarFilesProcessed?: number;
    patternMatchConfidence?: number;
  };
  correlationId: string;
  timestamp: string;
}

interface DecisionResponse<T> {
  decision: T;
  confidence: number;
  reason: string;
  learnFromOutcome: boolean;
  source: 'pattern_cache' | 'llm_primary' | 'llm_fallback' | 'fast_path';
  durationMs: number;
  alternatives?: Array<{ decision: T; confidence: number; reason: string }>;
}

/**
 * Event emitter type for SSE updates
 */
type EventCallback = (event: string, data: unknown) => void;

// ============================================================================
// Sandbox-First Orchestrator
// ============================================================================

export class SandboxFirstOrchestrator {
  private jobs: Map<string, OrchestrationJob> = new Map();
  private decisionEngine: DecisionEngine | null = null;
  private eventCallbacks: Map<string, EventCallback[]> = new Map();

  // Configuration
  private readonly maxConcurrentJobs = 50;
  private readonly jobTimeoutMs = 300000; // 5 minutes
  private readonly sandboxTimeoutMs = 120000; // 2 minutes

  constructor() {
    logger.info('SandboxFirstOrchestrator initialized', {
      maxConcurrentJobs: this.maxConcurrentJobs,
      jobTimeoutMs: this.jobTimeoutMs,
      sandboxTimeoutMs: this.sandboxTimeoutMs
    });

    // Start cleanup interval
    setInterval(() => this.cleanupStaleJobs(), 60000);
  }

  /**
   * Inject decision engine dependency
   */
  setDecisionEngine(engine: DecisionEngine): void {
    this.decisionEngine = engine;
    logger.info('DecisionEngine injected into SandboxFirstOrchestrator');
  }

  // ============================================================================
  // Main Orchestration Method
  // ============================================================================

  /**
   * Process a file through the sandbox-first pipeline
   */
  async processFile(request: OrchestrationRequest): Promise<OrchestrationResponse> {
    const jobId = uuidv4();
    const correlationId = uuidv4();

    // Create job
    const job: OrchestrationJob = {
      id: jobId,
      correlationId,
      status: 'pending',
      file: request.file,
      user: request.user,
      orgPolicies: request.orgPolicies,
      createdAt: new Date(),
      updatedAt: new Date(),
      progress: 0,
      currentStage: 'Initializing',
      stageMessages: []
    };

    this.jobs.set(jobId, job);
    activeOrchestrations.inc();

    logger.info('Orchestration job created', {
      jobId,
      correlationId,
      filename: request.file.filename,
      mimeType: request.file.mimeType,
      fileSize: request.file.fileSize,
      async: request.async
    });

    // Async mode: return 202 immediately
    if (request.async) {
      // Start processing in background
      this.executeOrchestration(job).catch(error => {
        logger.error('Background orchestration failed', {
          jobId,
          error: error instanceof Error ? error.message : 'Unknown error'
        });
      });

      return {
        jobId,
        status: 'pending',
        progress: 0,
        currentStage: 'Queued for processing',
        sseEndpoint: `/fileprocess/api/v1/jobs/${jobId}/stream`
      };
    }

    // Sync mode: wait for completion
    await this.executeOrchestration(job);

    return this.buildResponse(job);
  }

  /**
   * Get job status
   */
  getJob(jobId: string): OrchestrationJob | undefined {
    return this.jobs.get(jobId);
  }

  /**
   * Get job response
   */
  getJobStatus(jobId: string): OrchestrationResponse | null {
    const job = this.jobs.get(jobId);
    if (!job) return null;
    return this.buildResponse(job);
  }

  /**
   * Subscribe to job events (SSE)
   */
  subscribeToJob(jobId: string, callback: EventCallback): () => void {
    const callbacks = this.eventCallbacks.get(jobId) || [];
    callbacks.push(callback);
    this.eventCallbacks.set(jobId, callbacks);

    // Return unsubscribe function
    return () => {
      const current = this.eventCallbacks.get(jobId) || [];
      this.eventCallbacks.set(jobId, current.filter(cb => cb !== callback));
    };
  }

  // ============================================================================
  // Orchestration Pipeline
  // ============================================================================

  /**
   * Execute the full orchestration pipeline
   */
  private async executeOrchestration(job: OrchestrationJob): Promise<void> {
    const startTime = Date.now();

    try {
      // Stage 1: Initial Triage
      await this.stageInitialTriage(job);

      // Stage 2: Sandbox Analysis
      await this.stageSandboxAnalysis(job);

      // Stage 3: Security Assessment
      const securityPassed = await this.stageSecurityAssessment(job);
      if (!securityPassed) {
        // Job was blocked or queued for review
        return;
      }

      // Stage 4: Processing Route
      await this.stageProcessingRoute(job);

      // Stage 5: Execute Processing
      await this.stageExecuteProcessing(job);

      // Stage 6: Post-Processing
      await this.stagePostProcessing(job);

      // Complete
      this.updateJob(job, {
        status: 'completed',
        progress: 100,
        currentStage: 'Complete',
        completedAt: new Date()
      });

      orchestrationCounter.labels('complete', 'success').inc();

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';

      this.updateJob(job, {
        status: 'failed',
        error: errorMessage,
        errorStage: job.currentStage,
        completedAt: new Date()
      });

      orchestrationCounter.labels(job.currentStage.toLowerCase(), 'error').inc();

      // Record pattern failure for learning
      if (this.decisionEngine) {
        const decisionRequest = this.buildDecisionRequest(job);
        await this.decisionEngine.recordPatternFailure(decisionRequest);
      }

      logger.error('Orchestration failed', {
        jobId: job.id,
        correlationId: job.correlationId,
        stage: job.currentStage,
        error: errorMessage
      });

    } finally {
      activeOrchestrations.dec();
      const totalDuration = Date.now() - startTime;
      orchestrationLatency.labels('total').observe(totalDuration / 1000);

      this.emitEvent(job.id, 'complete', {
        jobId: job.id,
        status: job.status,
        duration: totalDuration
      });
    }
  }

  // ============================================================================
  // Stage 1: Initial Triage
  // ============================================================================

  /**
   * Decision Point 1: Determine sandbox tier and priority
   */
  private async stageInitialTriage(job: OrchestrationJob): Promise<void> {
    const stageStart = Date.now();
    this.updateJob(job, {
      status: 'triaging',
      progress: 10,
      currentStage: 'Initial Triage'
    });

    this.emitEvent(job.id, 'stage', {
      stage: 'triage',
      message: 'Determining sandbox analysis tier...'
    });

    if (!this.decisionEngine) {
      // Fallback: use file extension heuristics
      const decision = this.fallbackTriageDecision(job.file);
      job.triageDecision = {
        decisionPoint: 'initial_triage',
        decision,
        confidence: 0.7,
        reason: 'Fallback heuristic decision',
        source: 'fast_path',
        durationMs: Date.now() - stageStart,
        learnFromOutcome: false
      };
      return;
    }

    const decisionRequest = this.buildDecisionRequest(job);
    const response = await this.decisionEngine.decideInitialTriage(decisionRequest);

    job.triageDecision = {
      decisionPoint: 'initial_triage',
      decision: response.decision,
      confidence: response.confidence,
      reason: response.reason,
      source: response.source,
      durationMs: response.durationMs,
      learnFromOutcome: response.learnFromOutcome,
      alternatives: response.alternatives?.map(alt => ({
        decision: alt.decision,
        confidence: alt.confidence,
        reason: alt.reason
      }))
    };

    this.addStageMessage(job, 'triage', `Sandbox tier: ${response.decision.sandboxTier}, Priority: ${response.decision.priority}`);
    orchestrationLatency.labels('triage').observe((Date.now() - stageStart) / 1000);

    logger.info('Triage decision made', {
      jobId: job.id,
      tier: response.decision.sandboxTier,
      priority: response.decision.priority,
      source: response.source,
      confidence: response.confidence
    });
  }

  // ============================================================================
  // Stage 2: Sandbox Analysis
  // ============================================================================

  /**
   * Execute sandbox analysis with CyberAgent
   */
  private async stageSandboxAnalysis(job: OrchestrationJob): Promise<void> {
    const stageStart = Date.now();
    this.updateJob(job, {
      status: 'sandbox_running',
      progress: 25,
      currentStage: 'Sandbox Analysis'
    });

    this.emitEvent(job.id, 'stage', {
      stage: 'sandbox',
      message: 'Running sandbox analysis...'
    });

    const tier = job.triageDecision?.decision.sandboxTier || 'tier2';
    const tools = job.triageDecision?.decision.tools || ['magic_detect', 'yara_quick'];
    const timeout = job.triageDecision?.decision.timeout || this.sandboxTimeoutMs;

    const cyberAgentClient = getCyberAgentClient();

    // Check if this is a binary file that needs full analysis
    const isBinary = this.isBinaryFile(job.file.mimeType, job.file.filename);

    try {
      let scanResult: ScanResult;

      if (isBinary) {
        // Use full binary analysis for executables
        const analysisResult = await cyberAgentClient.analyzeBinary(
          job.file.storagePath || job.file.originalUrl || '',
          {
            filename: job.file.filename,
            mimeType: job.file.mimeType,
            fileSize: job.file.fileSize,
            deepAnalysis: tier === 'tier3',
            decompile: tier !== 'tier1',
            timeout,
            localFilePath: job.file.storagePath ? `file://${job.file.storagePath}` : undefined
          }
        );

        // Convert analysis result to ScanResult format
        scanResult = {
          is_malicious: analysisResult.isMalicious,
          threat_level: analysisResult.threatLevel,
          confidence: 0.9,
          iocs: [],
          yara_matches: analysisResult.yara_matches || [],
          recommendations: analysisResult.recommendations,
          analysis_summary: analysisResult.analysis_summary,
          decompiled_code: analysisResult.decompiled_code,
          extracted_strings: analysisResult.extracted_strings,
          file_metadata: analysisResult.file_metadata
        };
      } else {
        // Use quick malware scan for non-binary files
        scanResult = await cyberAgentClient.malwareScan(
          job.file.storagePath || job.file.originalUrl || '',
          {
            tools: tools.includes('yara_full') ? ['yara', 'clamav'] : ['yara'],
            sandboxTier: tier,
            deepScan: tier === 'tier3',
            timeout
          }
        );
      }

      // Convert to our SandboxAnalysisResult format
      job.sandboxResult = this.convertToSandboxResult(job, scanResult, stageStart);

      // Track by threat level
      filesByThreatLevel.labels(job.sandboxResult.security.threatLevel).inc();

      this.addStageMessage(job, 'sandbox',
        `Analysis complete: ${job.sandboxResult.security.threatLevel} threat level`
      );

      orchestrationLatency.labels('sandbox').observe((Date.now() - stageStart) / 1000);

      logger.info('Sandbox analysis complete', {
        jobId: job.id,
        threatLevel: job.sandboxResult.security.threatLevel,
        isMalicious: job.sandboxResult.security.isMalicious,
        category: job.sandboxResult.classification.category,
        durationMs: job.sandboxResult.durationMs
      });

    } catch (error) {
      // Sandbox failure - treat as suspicious
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';

      job.sandboxResult = {
        analysisId: uuidv4(),
        correlationId: job.correlationId,
        tier: tier,
        classification: {
          category: 'unknown',
          mimeType: job.file.mimeType,
          format: 'unknown',
          confidence: 0.1
        },
        security: {
          threatLevel: 'medium', // Default to medium on sandbox failure
          isMalicious: false,
          shouldBlock: false,
          flags: ['sandbox_analysis_failed', errorMessage]
        },
        recommendations: [],
        toolsUsed: tools,
        durationMs: Date.now() - stageStart,
        timestamp: new Date().toISOString()
      };

      this.addStageMessage(job, 'sandbox', `Sandbox analysis failed: ${errorMessage}`);

      logger.warn('Sandbox analysis failed', {
        jobId: job.id,
        error: errorMessage
      });
    }
  }

  // ============================================================================
  // Stage 3: Security Assessment
  // ============================================================================

  /**
   * Decision Point 2: Allow, block, or queue for review
   */
  private async stageSecurityAssessment(job: OrchestrationJob): Promise<boolean> {
    const stageStart = Date.now();
    this.updateJob(job, {
      status: 'security_assessment',
      progress: 45,
      currentStage: 'Security Assessment'
    });

    this.emitEvent(job.id, 'stage', {
      stage: 'security',
      message: 'Evaluating security...'
    });

    if (!this.decisionEngine) {
      // Fallback: use sandbox recommendation
      const decision = this.fallbackSecurityDecision(job.sandboxResult!);
      job.securityDecision = {
        decisionPoint: 'security_assessment',
        decision,
        confidence: 0.7,
        reason: 'Fallback security decision based on sandbox result',
        source: 'fast_path',
        durationMs: Date.now() - stageStart,
        learnFromOutcome: false
      };
    } else {
      const decisionRequest = this.buildDecisionRequest(job);
      const response = await this.decisionEngine.decideSecurityAssessment(decisionRequest);

      job.securityDecision = {
        decisionPoint: 'security_assessment',
        decision: response.decision,
        confidence: response.confidence,
        reason: response.reason,
        source: response.source,
        durationMs: response.durationMs,
        learnFromOutcome: response.learnFromOutcome,
        alternatives: response.alternatives?.map(alt => ({
          decision: alt.decision,
          confidence: alt.confidence,
          reason: alt.reason
        }))
      };
    }

    const action = job.securityDecision.decision.action;
    orchestrationCounter.labels('security', action).inc();
    orchestrationLatency.labels('security').observe((Date.now() - stageStart) / 1000);

    logger.info('Security decision made', {
      jobId: job.id,
      action,
      reason: job.securityDecision.reason,
      confidence: job.securityDecision.confidence
    });

    // Handle security actions
    switch (action) {
      case 'block':
        this.updateJob(job, {
          status: 'blocked',
          progress: 100,
          currentStage: 'Blocked',
          completedAt: new Date()
        });
        this.addStageMessage(job, 'security', `File blocked: ${job.securityDecision.reason}`);
        this.emitEvent(job.id, 'blocked', {
          reason: job.securityDecision.reason,
          threatLevel: job.sandboxResult?.security.threatLevel
        });
        return false;

      case 'review':
        this.updateJob(job, {
          status: 'review_queued',
          progress: 100,
          currentStage: 'Queued for Review',
          completedAt: new Date()
        });
        this.addStageMessage(job, 'security',
          `File queued for review: ${job.securityDecision.decision.reviewQueue || 'security-review'}`
        );
        this.emitEvent(job.id, 'review_queued', {
          queue: job.securityDecision.decision.reviewQueue,
          expiresAt: job.securityDecision.decision.expiresAt
        });
        return false;

      case 'escalate':
        // Escalate but continue processing with monitoring
        this.addStageMessage(job, 'security', 'Escalated to security team - proceeding with monitoring');
        this.emitEvent(job.id, 'escalated', {
          notifyUsers: job.securityDecision.decision.notifyUsers
        });
        return true;

      case 'allow':
      default:
        this.addStageMessage(job, 'security', 'Security check passed');
        return true;
    }
  }

  // ============================================================================
  // Stage 4: Processing Route
  // ============================================================================

  /**
   * Decision Point 3: Determine target service and method
   */
  private async stageProcessingRoute(job: OrchestrationJob): Promise<void> {
    const stageStart = Date.now();
    this.updateJob(job, {
      status: 'routing',
      progress: 55,
      currentStage: 'Routing Decision'
    });

    this.emitEvent(job.id, 'stage', {
      stage: 'routing',
      message: 'Determining processing route...'
    });

    if (!this.decisionEngine) {
      // Fallback: use sandbox recommendations
      const decision = this.fallbackRouteDecision(job);
      job.routeDecision = {
        decisionPoint: 'processing_route',
        decision,
        confidence: 0.7,
        reason: 'Fallback routing based on sandbox recommendations',
        source: 'fast_path',
        durationMs: Date.now() - stageStart,
        learnFromOutcome: false
      };
    } else {
      const decisionRequest = this.buildDecisionRequest(job);
      const response = await this.decisionEngine.decideProcessingRoute(decisionRequest);

      job.routeDecision = {
        decisionPoint: 'processing_route',
        decision: response.decision,
        confidence: response.confidence,
        reason: response.reason,
        source: response.source,
        durationMs: response.durationMs,
        learnFromOutcome: response.learnFromOutcome,
        alternatives: response.alternatives?.map(alt => ({
          decision: alt.decision,
          confidence: alt.confidence,
          reason: alt.reason
        }))
      };
    }

    this.addStageMessage(job, 'routing',
      `Route: ${job.routeDecision.decision.targetService} via ${job.routeDecision.decision.method}`
    );

    orchestrationCounter.labels('routing', job.routeDecision.decision.targetService).inc();
    orchestrationLatency.labels('routing').observe((Date.now() - stageStart) / 1000);

    logger.info('Route decision made', {
      jobId: job.id,
      targetService: job.routeDecision.decision.targetService,
      method: job.routeDecision.decision.method,
      confidence: job.routeDecision.confidence
    });
  }

  // ============================================================================
  // Stage 5: Execute Processing
  // ============================================================================

  /**
   * Execute processing on the target service
   */
  private async stageExecuteProcessing(job: OrchestrationJob): Promise<void> {
    const stageStart = Date.now();
    this.updateJob(job, {
      status: 'processing',
      progress: 70,
      currentStage: 'Processing'
    });

    const route = job.routeDecision!.decision;

    this.emitEvent(job.id, 'stage', {
      stage: 'processing',
      message: `Processing with ${route.targetService}...`
    });

    try {
      let result: ProcessingResult;

      switch (route.targetService) {
        case 'cyberagent':
          result = await this.processByCyberAgent(job, route);
          break;

        case 'videoagent':
          result = await this.processByVideoAgent(job, route);
          break;

        case 'geoagent':
          result = await this.processByGeoAgent(job, route);
          break;

        case 'github-manager':
          result = await this.processByGitHubManager(job, route);
          break;

        case 'mageagent':
          result = await this.processByMageAgent(job, route);
          break;

        case 'fileprocess':
        default:
          result = await this.processByFileProcess(job, route);
          break;
      }

      job.processingResult = result;
      job.processingJobId = result.jobId;

      if (result.success) {
        this.addStageMessage(job, 'processing',
          `Processing complete in ${result.durationMs}ms`
        );
      } else {
        this.addStageMessage(job, 'processing',
          `Processing failed: ${result.error || 'Unknown error'}`
        );
      }

      orchestrationLatency.labels('processing').observe((Date.now() - stageStart) / 1000);

      logger.info('Processing complete', {
        jobId: job.id,
        targetService: route.targetService,
        method: route.method,
        success: result.success,
        durationMs: result.durationMs
      });

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';

      job.processingResult = {
        success: false,
        jobId: 'N/A',
        durationMs: Date.now() - stageStart,
        error: errorMessage
      };

      throw error;
    }
  }

  // ============================================================================
  // Stage 6: Post-Processing
  // ============================================================================

  /**
   * Decision Point 4: Storage, indexing, and learning
   */
  private async stagePostProcessing(job: OrchestrationJob): Promise<void> {
    const stageStart = Date.now();
    this.updateJob(job, {
      status: 'post_processing',
      progress: 90,
      currentStage: 'Post-Processing'
    });

    this.emitEvent(job.id, 'stage', {
      stage: 'post_processing',
      message: 'Finalizing...'
    });

    if (!this.decisionEngine) {
      // Fallback: basic post-processing
      const decision = this.fallbackPostProcessDecision(job);
      job.postProcessDecision = {
        decisionPoint: 'post_processing',
        decision,
        confidence: 0.7,
        reason: 'Fallback post-processing',
        source: 'fast_path',
        durationMs: Date.now() - stageStart,
        learnFromOutcome: false
      };
    } else {
      const decisionRequest = this.buildDecisionRequest(job);
      const response = await this.decisionEngine.decidePostProcessing(decisionRequest);

      job.postProcessDecision = {
        decisionPoint: 'post_processing',
        decision: response.decision,
        confidence: response.confidence,
        reason: response.reason,
        source: response.source,
        durationMs: response.durationMs,
        learnFromOutcome: response.learnFromOutcome,
        alternatives: response.alternatives?.map(alt => ({
          decision: alt.decision,
          confidence: alt.confidence,
          reason: alt.reason
        }))
      };

      // Learn from successful processing
      if (job.processingResult?.success && response.decision.learnPattern) {
        await this.decisionEngine.storePattern(
          decisionRequest,
          {
            triage: job.triageDecision?.decision,
            route: job.routeDecision?.decision
          },
          response.confidence
        );
      }
    }

    // Execute post-processing actions
    await this.executePostProcessing(job);

    // Record pattern learning outcome (persisted to Redis)
    await this.recordPatternLearning(job);

    this.addStageMessage(job, 'post_processing',
      `Stored in: ${job.postProcessDecision.decision.storeIn.join(', ')}`
    );

    orchestrationLatency.labels('post_processing').observe((Date.now() - stageStart) / 1000);

    logger.info('Post-processing complete', {
      jobId: job.id,
      storedIn: job.postProcessDecision.decision.storeIn,
      learnPattern: job.postProcessDecision.decision.learnPattern
    });
  }

  /**
   * Record pattern learning outcome
   */
  private async recordPatternLearning(job: OrchestrationJob): Promise<void> {
    const patternLearning = getPatternLearningService();
    const success = job.processingResult?.success ?? false;

    // Build pattern lookup request
    const lookupRequest = {
      filename: job.file.filename,
      mimeType: job.file.mimeType,
      fileSize: job.file.fileSize,
      decisionPoint: 'processing_route' as const,
      sandboxResult: job.sandboxResult ? {
        classification: {
          category: job.sandboxResult.classification.category
        },
        security: {
          threatLevel: job.sandboxResult.security.threatLevel
        }
      } : undefined
    };

    try {
      if (success && job.postProcessDecision?.decision.learnPattern) {
        // Record success for each decision point
        await patternLearning.recordSuccess(
          { ...lookupRequest, decisionPoint: 'initial_triage' },
          (job.triageDecision?.decision || {}) as Record<string, unknown>
        );
        await patternLearning.recordSuccess(
          { ...lookupRequest, decisionPoint: 'processing_route' },
          (job.routeDecision?.decision || {}) as Record<string, unknown>
        );

        logger.debug('Pattern success recorded', {
          jobId: job.id,
          filename: job.file.filename
        });
      } else if (!success) {
        // Record failure
        await patternLearning.recordFailure({
          ...lookupRequest,
          decisionPoint: 'processing_route'
        });

        logger.debug('Pattern failure recorded', {
          jobId: job.id,
          filename: job.file.filename,
          error: job.processingResult?.error
        });
      }
    } catch (error) {
      // Don't fail the job if pattern learning fails
      logger.warn('Pattern learning failed', {
        jobId: job.id,
        error: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  }

  // ============================================================================
  // Processing Handlers
  // ============================================================================

  /**
   * Process file via CyberAgent (binary analysis)
   */
  private async processByCyberAgent(
    job: OrchestrationJob,
    route: ProcessingRouteDecision
  ): Promise<ProcessingResult> {
    const startTime = Date.now();
    const cyberAgentClient = getCyberAgentClient();

    try {
      const result = await cyberAgentClient.analyzeBinary(
        job.file.storagePath || job.file.originalUrl || '',
        {
          filename: job.file.filename,
          mimeType: job.file.mimeType,
          fileSize: job.file.fileSize,
          deepAnalysis: route.config?.deep_scan ?? true,
          decompile: route.config?.decompile ?? true,
          localFilePath: job.file.storagePath ? `file://${job.file.storagePath}` : undefined
        }
      );

      return {
        success: result.success,
        jobId: job.correlationId,
        extractedContent: result.decompiled_code,
        artifacts: result.extracted_strings?.slice(0, 100), // Limit extracted strings
        durationMs: Date.now() - startTime,
        error: result.error
      };

    } catch (error) {
      return {
        success: false,
        jobId: job.correlationId,
        durationMs: Date.now() - startTime,
        error: error instanceof Error ? error.message : 'CyberAgent processing failed'
      };
    }
  }

  /**
   * Process file via MageAgent (dynamic/unknown files)
   */
  private async processByMageAgent(
    job: OrchestrationJob,
    route: ProcessingRouteDecision
  ): Promise<ProcessingResult> {
    const startTime = Date.now();
    const mageAgentClient = getMageAgentClient();

    try {
      logger.info('Processing file via MageAgent', {
        jobId: job.id,
        correlationId: job.correlationId,
        filename: job.file.filename,
        mimeType: job.file.mimeType,
        method: route.method
      });

      // Build a comprehensive task description for MageAgent
      const task = this.buildMageAgentTask(job, route);

      // Prepare context with file information
      const context = {
        operation: 'file_processing',
        filename: job.file.filename,
        mimeType: job.file.mimeType,
        fileSize: job.file.fileSize,
        fileHash: job.file.fileHash,
        fileUrl: job.file.originalUrl || (job.file.storagePath ? `file://${job.file.storagePath}` : undefined),
        sandboxResult: job.sandboxResult ? {
          classification: job.sandboxResult.classification,
          security: {
            threatLevel: job.sandboxResult.security.threatLevel,
            isMalicious: job.sandboxResult.security.isMalicious
          }
        } : undefined,
        userId: job.user?.userId,
        orgId: job.user?.orgId,
        correlationId: job.correlationId
      };

      // Determine if this is a complex file that needs async processing
      const isComplexFile = job.file.fileSize > 10 * 1024 * 1024 || // > 10MB
                           route.config?.deep_analysis === true ||
                           ['dynamic_process', 'media_analysis'].includes(route.method);

      // Call MageAgent orchestration
      const initialResponse = await mageAgentClient.orchestrate(task, {
        maxAgents: route.config?.max_agents || (isComplexFile ? 5 : 3),
        timeout: route.config?.timeout || (isComplexFile ? 300000 : 120000), // 5min for complex, 2min for simple
        context,
        async: isComplexFile
      });

      let response: MageAgentResponse;

      // Handle async processing
      if ('pollUrl' in initialResponse) {
        logger.info('MageAgent processing started asynchronously', {
          jobId: job.id,
          taskId: initialResponse.taskId,
          estimatedDuration: initialResponse.estimatedDuration
        });

        this.addStageMessage(job, 'processing',
          `MageAgent processing started (async) - estimated duration: ${initialResponse.estimatedDuration}`
        );

        // Poll for completion
        response = await this.pollMageAgentTask(mageAgentClient, initialResponse.taskId, job);
      } else {
        // Synchronous response
        response = initialResponse as MageAgentResponse;
      }

      // Parse the result
      if (!response.success || response.status === 'failed') {
        return {
          success: false,
          jobId: job.correlationId,
          durationMs: Date.now() - startTime,
          error: response.error || 'MageAgent processing failed'
        };
      }

      const result = response.result as Record<string, unknown>;

      logger.info('MageAgent processing completed successfully', {
        jobId: job.id,
        correlationId: job.correlationId,
        agentsUsed: response.agents?.length || 0,
        durationMs: Date.now() - startTime
      });

      // Extract content from result
      const extractedContent = result?.extractedContent as string ||
                               result?.text as string ||
                               result?.content as string || '';

      // Store extracted content in GraphRAG for chunking and searchability
      // This enables document search via /api/memory/recall
      if (extractedContent && extractedContent.length > 0) {
        await this.storeInGraphRAG(job, extractedContent);
      }

      return {
        success: true,
        jobId: job.correlationId,
        extractedContent,
        artifacts: result?.artifacts as string[] || [],
        durationMs: Date.now() - startTime
      };

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'MageAgent processing failed';

      logger.error('MageAgent processing failed', {
        jobId: job.id,
        correlationId: job.correlationId,
        filename: job.file.filename,
        error: errorMessage
      });

      return {
        success: false,
        jobId: job.correlationId,
        durationMs: Date.now() - startTime,
        error: errorMessage
      };
    }
  }

  /**
   * Build MageAgent task description based on route method
   */
  private buildMageAgentTask(job: OrchestrationJob, route: ProcessingRouteDecision): string {
    const baseContext = `
File: ${job.file.filename}
MIME Type: ${job.file.mimeType}
File Size: ${job.file.fileSize} bytes
`;

    const sandboxInfo = job.sandboxResult ? `
Sandbox Classification: ${job.sandboxResult.classification.category}
Threat Level: ${job.sandboxResult.security.threatLevel}
` : '';

    switch (route.method) {
      case 'dynamic_process':
        return `Analyze and process this file dynamically. Determine the best processing strategy and extract all meaningful content.

${baseContext}${sandboxInfo}

Objectives:
1. Identify the file format and required processing tools
2. Extract all text, metadata, and structural information
3. Convert to a universal format (JSON/text) if possible
4. Report any errors or warnings

Return a JSON object with:
- extractedContent: string (main content)
- metadata: object (file metadata)
- artifacts: array (any generated files/outputs)
- processingMethod: string (method used)`;

      case 'media_analysis':
        return `Analyze this media file and extract comprehensive information.

${baseContext}${sandboxInfo}

Objectives:
1. Extract metadata (EXIF, creation date, camera/device info, etc.)
2. Analyze visual/audio content for classification
3. Generate a textual description of the content
4. Detect any embedded text (OCR if image)
5. Identify any quality issues or artifacts

Return a JSON object with:
- extractedContent: string (description + OCR text)
- metadata: object (EXIF, dimensions, codec info, etc.)
- artifacts: array (thumbnails, extracted frames, etc.)
- contentType: string (photo, illustration, screenshot, etc.)`;

      case 'code_analysis':
        return `Analyze this code file for structure, dependencies, and quality.

${baseContext}${sandboxInfo}

Objectives:
1. Identify programming language and framework
2. Extract imports/dependencies
3. Analyze code structure (functions, classes, exports)
4. Check for security issues or anti-patterns
5. Generate a comprehensive summary

Return a JSON object with:
- extractedContent: string (code summary)
- metadata: object (language, dependencies, metrics)
- securityIssues: array (any security concerns)
- qualityScore: number (0-100)`;

      case 'archive_extraction':
        return `Extract and analyze the contents of this archive file.

${baseContext}${sandboxInfo}

Objectives:
1. List all files in the archive
2. Extract metadata (compression ratio, file count, etc.)
3. Analyze file types within the archive
4. Check for nested archives or suspicious patterns
5. Generate a manifest of contents

Return a JSON object with:
- extractedContent: string (manifest as text)
- metadata: object (archive info, compression stats)
- files: array (list of contained files with sizes/types)
- warnings: array (suspicious patterns, encrypted files, etc.)`;

      default:
        // Generic processing
        return `Process this file and extract all available information.

${baseContext}${sandboxInfo}

Extract any text, metadata, or structural information from this file.
Return a JSON object with extracted content, metadata, and any artifacts.`;
    }
  }

  /**
   * Poll MageAgent task until completion
   */
  private async pollMageAgentTask(
    client: ReturnType<typeof getMageAgentClient>,
    taskId: string,
    job: OrchestrationJob
  ): Promise<MageAgentResponse> {
    const maxPolls = 60; // 5 minutes max at 5s intervals
    const pollIntervalMs = 5000;

    for (let i = 0; i < maxPolls; i++) {
      await new Promise(resolve => setTimeout(resolve, pollIntervalMs));

      try {
        const statusResponse = await client.getTaskStatus(taskId);

        if (statusResponse.status === 'completed') {
          logger.info('MageAgent task completed', {
            jobId: job.id,
            taskId,
            pollAttempts: i + 1
          });
          return statusResponse;
        } else if (statusResponse.status === 'failed') {
          logger.error('MageAgent task failed', {
            jobId: job.id,
            taskId,
            error: statusResponse.error
          });
          return statusResponse;
        }

        // Still processing - update progress
        if (i % 3 === 0) { // Update every 15 seconds
          this.addStageMessage(job, 'processing',
            `MageAgent still processing... (${((i + 1) * pollIntervalMs / 1000)}s elapsed)`
          );
        }

      } catch (pollError) {
        logger.warn('MageAgent poll attempt failed', {
          jobId: job.id,
          taskId,
          pollAttempt: i + 1,
          error: pollError instanceof Error ? pollError.message : 'Unknown error'
        });
      }
    }

    // Timeout
    throw new Error(`MageAgent task ${taskId} timed out after ${maxPolls * pollIntervalMs / 1000} seconds`);
  }

  /**
   * Process file via FileProcess (standard documents)
   */
  private async processByFileProcess(
    job: OrchestrationJob,
    route: ProcessingRouteDecision
  ): Promise<ProcessingResult> {
    const startTime = Date.now();

    try {
      logger.info('FileProcess processing requested', {
        jobId: job.id,
        correlationId: job.correlationId,
        method: route.method,
        filename: job.file.filename,
        mimeType: job.file.mimeType,
        category: job.sandboxResult?.classification.category
      });

      const category = job.sandboxResult?.classification.category || 'unknown';
      let extractedContent = '';
      const artifacts: string[] = [];

      // Route based on file category
      switch (category) {
        case 'archive':
          // Handle archive extraction
          const archiveResult = await this.processArchive(job);
          extractedContent = archiveResult.extractedContent;
          artifacts.push(...(archiveResult.artifacts || []));
          break;

        case 'document':
          // Handle document extraction (PDF, DOCX, etc.)
          const documentResult = await this.processDocument(job);
          extractedContent = documentResult.extractedContent;
          break;

        case 'code':
        case 'data':
          // Handle plain text/code/data files
          const textResult = await this.processTextFile(job);
          extractedContent = textResult.extractedContent;
          break;

        default:
          // Unknown file type - attempt generic text extraction
          logger.warn('Unknown file category for FileProcess', {
            jobId: job.id,
            category,
            filename: job.file.filename
          });
          extractedContent = `File: ${job.file.filename}\nType: ${job.file.mimeType}\nSize: ${job.file.fileSize} bytes`;
          break;
      }

      // Store extracted content in GraphRAG if we have content
      if (extractedContent && extractedContent.length > 0) {
        await this.storeInGraphRAG(job, extractedContent);
      }

      const durationMs = Date.now() - startTime;

      logger.info('FileProcess processing complete', {
        jobId: job.id,
        correlationId: job.correlationId,
        contentLength: extractedContent.length,
        artifactsCount: artifacts.length,
        durationMs
      });

      return {
        success: true,
        jobId: job.correlationId,
        extractedContent,
        artifacts,
        durationMs
      };

    } catch (error) {
      const durationMs = Date.now() - startTime;
      const errorMessage = error instanceof Error ? error.message : 'FileProcess processing failed';

      logger.error('FileProcess processing failed', {
        jobId: job.id,
        correlationId: job.correlationId,
        error: errorMessage,
        durationMs
      });

      return {
        success: false,
        jobId: job.correlationId,
        durationMs,
        error: errorMessage
      };
    }
  }

  /**
   * Process archive files (ZIP, TAR, RAR, 7Z)
   */
  private async processArchive(job: OrchestrationJob): Promise<{ extractedContent: string; artifacts: string[] }> {
    logger.info('Processing archive file', {
      jobId: job.id,
      filename: job.file.filename,
      mimeType: job.file.mimeType
    });

    try {
      // Dynamic import to avoid loading heavy dependencies unless needed
      const { ArchiveExtractorFactory } = await import('../extractors/ArchiveExtractor');
      const fs = await import('fs/promises');

      // Read file buffer
      let fileBuffer: Buffer;
      if (job.file.storagePath) {
        fileBuffer = await fs.readFile(job.file.storagePath);
      } else {
        throw new Error('No storage path available for archive extraction');
      }

      // Extract archive
      const extractionResult = await ArchiveExtractorFactory.extract(
        fileBuffer,
        job.file.filename,
        job.file.mimeType
      );

      if (!extractionResult.success) {
        throw new Error(extractionResult.error?.message || 'Archive extraction failed');
      }

      // Build summary of extracted files
      const fileList = extractionResult.files.map(f =>
        `${f.filename} (${f.size} bytes)`
      ).join('\n');

      const extractedContent = `Archive: ${job.file.filename}
Archive Type: ${extractionResult.metadata.archiveType}
Total Files: ${extractionResult.metadata.totalFiles}
Total Size: ${extractionResult.metadata.totalSize} bytes
Extraction Time: ${extractionResult.metadata.extractionTimeMs}ms

Extracted Files:
${fileList}`;

      const artifacts = extractionResult.files.map(f => f.filename);

      logger.info('Archive processed successfully', {
        jobId: job.id,
        totalFiles: extractionResult.metadata.totalFiles,
        totalSize: extractionResult.metadata.totalSize
      });

      return { extractedContent, artifacts };

    } catch (error) {
      logger.error('Archive processing failed', {
        jobId: job.id,
        error: error instanceof Error ? error.message : String(error)
      });

      return {
        extractedContent: `Failed to extract archive: ${error instanceof Error ? error.message : 'Unknown error'}`,
        artifacts: []
      };
    }
  }

  /**
   * Process document files (PDF, DOCX, TXT, MD)
   */
  private async processDocument(job: OrchestrationJob): Promise<{ extractedContent: string }> {
    logger.info('Processing document file', {
      jobId: job.id,
      filename: job.file.filename,
      mimeType: job.file.mimeType
    });

    try {
      const fs = await import('fs/promises');

      // Read file buffer
      let fileBuffer: Buffer;
      if (job.file.storagePath) {
        fileBuffer = await fs.readFile(job.file.storagePath);
      } else {
        throw new Error('No storage path available for document extraction');
      }

      // For now, handle text-based documents directly
      // PDF and DOCX extraction would require additional libraries
      const mimeType = job.file.mimeType.toLowerCase();

      if (mimeType.includes('text') || mimeType.includes('markdown')) {
        // Plain text or markdown
        const extractedContent = fileBuffer.toString('utf-8');
        return { extractedContent };
      }

      // For binary document formats (PDF, DOCX), return metadata for now
      // TODO: Integrate pdf-parse for PDF, mammoth for DOCX
      const extractedContent = `Document: ${job.file.filename}
Type: ${job.file.mimeType}
Size: ${job.file.fileSize} bytes

[Binary document - text extraction not yet implemented]
To extract text, integrate libraries:
- PDF: pdf-parse or pdfjs-dist
- DOCX: mammoth or docx
- XLSX: xlsx or exceljs`;

      logger.warn('Binary document text extraction not yet implemented', {
        jobId: job.id,
        mimeType: job.file.mimeType
      });

      return { extractedContent };

    } catch (error) {
      logger.error('Document processing failed', {
        jobId: job.id,
        error: error instanceof Error ? error.message : String(error)
      });

      return {
        extractedContent: `Failed to process document: ${error instanceof Error ? error.message : 'Unknown error'}`
      };
    }
  }

  /**
   * Process text/code files
   */
  private async processTextFile(job: OrchestrationJob): Promise<{ extractedContent: string }> {
    logger.info('Processing text file', {
      jobId: job.id,
      filename: job.file.filename,
      mimeType: job.file.mimeType
    });

    try {
      const fs = await import('fs/promises');

      // Read file buffer
      let fileBuffer: Buffer;
      if (job.file.storagePath) {
        fileBuffer = await fs.readFile(job.file.storagePath);
      } else {
        throw new Error('No storage path available for text extraction');
      }

      // Convert to UTF-8 string
      const extractedContent = fileBuffer.toString('utf-8');

      logger.info('Text file processed successfully', {
        jobId: job.id,
        contentLength: extractedContent.length
      });

      return { extractedContent };

    } catch (error) {
      logger.error('Text file processing failed', {
        jobId: job.id,
        error: error instanceof Error ? error.message : String(error)
      });

      return {
        extractedContent: `Failed to process text file: ${error instanceof Error ? error.message : 'Unknown error'}`
      };
    }
  }

  /**
   * Store extracted content in GraphRAG
   */
  private async storeInGraphRAG(job: OrchestrationJob, content: string): Promise<void> {
    try {
      // Dynamic import to avoid loading unless needed
      const { getGraphRAGClient } = await import('../clients/GraphRAGClient');
      const graphRAGClient = getGraphRAGClient();

      logger.info('Storing content in GraphRAG', {
        jobId: job.id,
        filename: job.file.filename,
        contentLength: content.length
      });

      await graphRAGClient.storeDocument({
        content,
        title: job.file.filename,
        metadata: {
          source: job.file.originalUrl || job.file.storagePath,
          tags: [
            job.sandboxResult?.classification.category || 'unknown',
            job.file.mimeType,
            `size:${job.file.fileSize}`
          ],
          type: this.determineDocumentType(job.sandboxResult?.classification.category),
          fileSize: job.file.fileSize,
          mimeType: job.file.mimeType,
          uploadedBy: job.user?.userId,
          orgId: job.user?.orgId,
          processingJobId: job.id,
          correlationId: job.correlationId
        }
      });

      logger.info('Content stored in GraphRAG successfully', {
        jobId: job.id,
        filename: job.file.filename
      });

    } catch (error) {
      // Don't fail the job if GraphRAG storage fails
      logger.error('Failed to store content in GraphRAG', {
        jobId: job.id,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  /**
   * Determine GraphRAG document type from file category
   */
  private determineDocumentType(category?: FileClassification['category']): 'code' | 'markdown' | 'text' | 'structured' | 'multimodal' {
    switch (category) {
      case 'code':
        return 'code';
      case 'document':
        return 'text';
      case 'archive':
        return 'structured';
      default:
        return 'text';
    }
  }

  /**
   * Process file via VideoAgent (video files)
   */
  private async processByVideoAgent(
    job: OrchestrationJob,
    route: ProcessingRouteDecision
  ): Promise<ProcessingResult> {
    const startTime = Date.now();
    const videoAgentClient = getVideoAgentClient();

    try {
      // Determine video URL (local file:// or remote URL)
      let videoUrl = job.file.originalUrl;
      if (job.file.storagePath) {
        videoUrl = `file://${job.file.storagePath}`;
      }

      if (!videoUrl) {
        throw new Error('No video URL or storage path available');
      }

      logger.info('Processing video via VideoAgent', {
        jobId: job.id,
        correlationId: job.correlationId,
        videoUrl: videoUrl.substring(0, 100),
        filename: job.file.filename
      });

      const result = await videoAgentClient.processVideoAndWait({
        userId: job.user?.userId || 'anonymous',
        filename: job.file.filename,
        videoUrl,
        options: {
          extractMetadata: true,
          detectScenes: route.config?.detect_scenes ?? false,
          analyzeFrames: route.config?.analyze_frames ?? true,
          transcribeAudio: route.config?.transcribe ?? false,
          quality: route.config?.quality ?? 'medium',
        },
        priority: route.priority,
        metadata: {
          correlationId: job.correlationId,
          source: 'SandboxFirstOrchestrator',
          orgId: job.user?.orgId,
        },
      });

      videoRoutingCounter.labels(route.method || 'standard', 'success').inc();
      videoProcessingDuration.labels(route.method || 'standard').observe((Date.now() - startTime) / 1000);

      return {
        success: true,
        jobId: job.correlationId,
        extractedContent: result.summary || result.transcription,
        artifacts: result.frames?.map(f => f.path),
        durationMs: Date.now() - startTime,
      };

    } catch (error) {
      videoRoutingCounter.labels(route.method || 'standard', 'error').inc();
      const errorMessage = error instanceof Error ? error.message : 'VideoAgent processing failed';

      logger.error('VideoAgent processing failed', {
        jobId: job.id,
        correlationId: job.correlationId,
        error: errorMessage
      });

      return {
        success: false,
        jobId: job.correlationId,
        durationMs: Date.now() - startTime,
        error: errorMessage,
      };
    }
  }

  /**
   * Process file via GeoAgent (geospatial and point cloud files)
   */
  private async processByGeoAgent(
    job: OrchestrationJob,
    route: ProcessingRouteDecision
  ): Promise<ProcessingResult> {
    const startTime = Date.now();
    const geoAgentClient = getGeoAgentClient();

    try {
      // Determine file URL (local file:// or remote URL)
      let fileUrl = job.file.originalUrl;
      if (job.file.storagePath) {
        fileUrl = `file://${job.file.storagePath}`;
      }

      if (!fileUrl) {
        throw new Error('No file URL or storage path available');
      }

      logger.info('Processing geospatial file via GeoAgent', {
        jobId: job.id,
        correlationId: job.correlationId,
        fileUrl: fileUrl.substring(0, 100),
        filename: job.file.filename,
        method: route.method,
      });

      // Determine if this is a point cloud (LiDAR) file or standard geospatial
      const isPointCloud = GeoAgentClient.isPointCloudFileType(job.file.mimeType, job.file.filename);

      let result;
      if (isPointCloud || route.method === 'lidar_processing') {
        // Process as LiDAR/point cloud
        result = await geoAgentClient.processLiDARAndWait({
          userId: job.user?.userId || 'anonymous',
          filename: job.file.filename,
          fileUrl,
          options: {
            generateDEM: route.config?.generate_dem ?? true,
            generateDSM: route.config?.generate_dsm ?? false,
            generateCHM: route.config?.generate_chm ?? false,
            classifyGround: route.config?.classify_ground ?? true,
            extractBuildings: route.config?.extract_buildings ?? false,
            extractVegetation: route.config?.extract_vegetation ?? false,
            outputFormat: route.config?.output_format ?? 'geotiff',
          },
          priority: route.priority,
          metadata: {
            correlationId: job.correlationId,
            source: 'SandboxFirstOrchestrator',
            orgId: job.user?.orgId,
          },
        });

        return {
          success: true,
          jobId: job.correlationId,
          extractedContent: result.summary || `LiDAR processed: ${result.metadata?.pointCount || 0} points`,
          artifacts: [
            ...(result.artifacts || []),
            ...(result.dem ? [result.dem] : []),
            ...(result.dsm ? [result.dsm] : []),
            ...(result.chm ? [result.chm] : []),
          ],
          durationMs: Date.now() - startTime,
        };
      } else {
        // Process as standard geospatial (GeoJSON, KML, Shapefile, etc.)
        result = await geoAgentClient.processGeospatialAndWait({
          userId: job.user?.userId || 'anonymous',
          filename: job.file.filename,
          fileUrl,
          options: {
            extractMetadata: true,
            analyzeGeometry: route.config?.analyze_geometry ?? true,
            detectAnomalies: route.config?.detect_anomalies ?? false,
            generateThumbnail: route.config?.generate_thumbnail ?? false,
            coordinateSystem: route.config?.crs ?? 'EPSG:4326',
          },
          priority: route.priority,
          metadata: {
            correlationId: job.correlationId,
            source: 'SandboxFirstOrchestrator',
            orgId: job.user?.orgId,
          },
        });

        return {
          success: true,
          jobId: job.correlationId,
          extractedContent: result.summary || JSON.stringify(result.metadata, null, 2),
          artifacts: result.artifacts,
          durationMs: Date.now() - startTime,
        };
      }

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'GeoAgent processing failed';

      logger.error('GeoAgent processing failed', {
        jobId: job.id,
        correlationId: job.correlationId,
        filename: job.file.filename,
        error: errorMessage,
      });

      return {
        success: false,
        jobId: job.correlationId,
        durationMs: Date.now() - startTime,
        error: errorMessage,
      };
    }
  }

  /**
   * Process GitHub repository URL via GitHub Manager
   *
   * This method handles GitHub repository URLs by:
   * 1. Connecting the repository to GitHub Manager
   * 2. Triggering a full repository sync into GraphRAG memory
   * 3. Waiting for sync completion (optional)
   *
   * The result is a "digital twin" of the repository stored in:
   * - Neo4j (code graph with AST relationships)
   * - Qdrant (Voyage AI code embeddings)
   * - GraphRAG (episodic and semantic memory)
   */
  private async processByGitHubManager(
    job: OrchestrationJob,
    route: ProcessingRouteDecision
  ): Promise<ProcessingResult> {
    const startTime = Date.now();
    const gitHubManagerClient = getGitHubManagerClient();

    try {
      // Get the GitHub URL from the job
      const repoUrl = job.file.originalUrl;

      if (!repoUrl) {
        throw new Error('No GitHub repository URL provided');
      }

      // Validate it's a GitHub repo URL
      if (!isGitHubRepoUrl(repoUrl)) {
        throw new Error(`Invalid GitHub repository URL: ${repoUrl}`);
      }

      // Extract repo info for logging
      const repoInfo = extractGitHubRepoInfo(repoUrl);

      logger.info('Processing GitHub repository via GitHub Manager', {
        jobId: job.id,
        correlationId: job.correlationId,
        repoUrl,
        owner: repoInfo?.owner,
        repo: repoInfo?.repo,
        branch: repoInfo?.branch,
      });

      // Build tenant context from user info
      const tenantContext = {
        companyId: job.user?.orgId || 'default',
        appId: 'nexus-fileprocess',
        userId: job.user?.userId,
      };

      // Process the repository
      // waitForCompletion can be configured via route config
      const waitForCompletion = route.config?.wait_for_completion ?? true;
      const timeout = route.config?.timeout ?? 600000; // 10 minutes default

      const result = await gitHubManagerClient.processGitHubRepo(
        repoUrl,
        tenantContext,
        {
          forceResync: route.config?.force_resync ?? false,
          waitForCompletion,
          timeout,
        }
      );

      if (!result.success) {
        throw new Error(result.error || 'GitHub repository processing failed');
      }

      const durationMs = Date.now() - startTime;

      // Build summary content
      const extractedContent = this.buildGitHubRepoSummary(result, repoInfo);

      logger.info('GitHub repository processed successfully', {
        jobId: job.id,
        correlationId: job.correlationId,
        repositoryId: result.repositoryId,
        fullName: result.fullName,
        status: result.status,
        isNewConnection: result.isNewConnection,
        syncStats: result.syncStats,
        durationMs,
      });

      return {
        success: true,
        jobId: job.correlationId,
        extractedContent,
        artifacts: result.repositoryId ? [result.repositoryId] : [],
        durationMs,
      };

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'GitHub Manager processing failed';

      logger.error('GitHub Manager processing failed', {
        jobId: job.id,
        correlationId: job.correlationId,
        repoUrl: job.file.originalUrl,
        error: errorMessage,
      });

      return {
        success: false,
        jobId: job.correlationId,
        durationMs: Date.now() - startTime,
        error: errorMessage,
      };
    }
  }

  /**
   * Build summary content for GitHub repository processing result
   */
  private buildGitHubRepoSummary(
    result: {
      repositoryId?: string;
      fullName?: string;
      status: string;
      isNewConnection: boolean;
      syncStats?: {
        totalFiles?: number;
        parsedFiles?: number;
        entitiesExtracted?: number;
        lastSyncDurationMs?: number;
      };
    },
    repoInfo: { owner: string; repo: string; branch?: string } | null
  ): string {
    const parts: string[] = [];

    parts.push(`GitHub Repository: ${result.fullName || (repoInfo ? `${repoInfo.owner}/${repoInfo.repo}` : 'unknown')}`);
    parts.push(`Status: ${result.status}`);
    parts.push(`Connection: ${result.isNewConnection ? 'New' : 'Existing'}`);

    if (result.repositoryId) {
      parts.push(`Repository ID: ${result.repositoryId}`);
    }

    if (repoInfo?.branch) {
      parts.push(`Branch: ${repoInfo.branch}`);
    }

    if (result.syncStats) {
      parts.push('');
      parts.push('Sync Statistics:');
      if (result.syncStats.totalFiles !== undefined) {
        parts.push(`  Total Files: ${result.syncStats.totalFiles}`);
      }
      if (result.syncStats.parsedFiles !== undefined) {
        parts.push(`  Parsed Files: ${result.syncStats.parsedFiles}`);
      }
      if (result.syncStats.entitiesExtracted !== undefined) {
        parts.push(`  Entities Extracted: ${result.syncStats.entitiesExtracted}`);
      }
      if (result.syncStats.lastSyncDurationMs !== undefined) {
        parts.push(`  Sync Duration: ${(result.syncStats.lastSyncDurationMs / 1000).toFixed(1)}s`);
      }
    }

    parts.push('');
    parts.push('The repository has been ingested into Nexus GraphRAG memory.');
    parts.push('You can now query this repository using natural language.');

    return parts.join('\n');
  }

  /**
   * Execute post-processing actions
   */
  private async executePostProcessing(job: OrchestrationJob): Promise<void> {
    const decision = job.postProcessDecision!.decision;
    const storageResults: { destination: string; success: boolean; error?: string }[] = [];

    // Import storage handlers
    const { storeToPostgres, storeToQdrant, storeToGraphRAG, storeOriginalFile } = await import('./storage-handlers');

    // Execute storage operations with graceful failure handling
    for (const destination of decision.storeIn) {
      try {
        logger.debug('Storing to destination', {
          jobId: job.id,
          destination,
          indexForSearch: decision.indexForSearch,
          generateEmbeddings: decision.generateEmbeddings
        });

        switch (destination) {
          case 'postgres':
            // Store job metadata
            await storeToPostgres(job);
            storageResults.push({ destination: 'postgres', success: true });

            // Also store original file content for user retrieval
            // This runs after metadata storage to ensure job record exists
            try {
              await storeOriginalFile(job);
              storageResults.push({ destination: 'postgres_file', success: true });
            } catch (fileError) {
              // Non-fatal - original file storage is optional
              const fileErrorMsg = fileError instanceof Error ? fileError.message : 'Unknown error';
              logger.warn('Original file storage failed (non-fatal)', {
                jobId: job.id,
                error: fileErrorMsg
              });
              storageResults.push({ destination: 'postgres_file', success: false, error: fileErrorMsg });
            }
            break;

          case 'qdrant':
            if (decision.generateEmbeddings) {
              await storeToQdrant(job);
              storageResults.push({ destination: 'qdrant', success: true });
            } else {
              logger.debug('Skipping Qdrant storage - embeddings not requested', { jobId: job.id });
            }
            break;

          case 'graphrag':
            await storeToGraphRAG(job);
            storageResults.push({ destination: 'graphrag', success: true });
            break;

          default:
            logger.warn('Unknown storage destination', { jobId: job.id, destination });
        }

      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        logger.error(`Failed to store to ${destination}`, {
          jobId: job.id,
          destination,
          error: errorMessage
        });

        storageResults.push({
          destination,
          success: false,
          error: errorMessage
        });

        // Don't fail the entire job if one storage fails
        // Continue to next destination
      }
    }

    // Log storage summary
    const successCount = storageResults.filter(r => r.success).length;
    const failureCount = storageResults.filter(r => !r.success).length;

    logger.info('Post-processing storage complete', {
      jobId: job.id,
      successCount,
      failureCount,
      results: storageResults
    });

    // Emit storage results event
    this.emitEvent(job.id, 'storage_complete', {
      results: storageResults,
      successCount,
      failureCount
    });

    // Notify user if requested
    if (decision.notifyUser) {
      this.emitEvent(job.id, 'notification', {
        type: 'processing_complete',
        success: job.processingResult?.success,
        storageResults
      });
    }

  }

  // ============================================================================
  // Helper Methods
  // ============================================================================

  /**
   * Build decision request from job state
   */
  private buildDecisionRequest(job: OrchestrationJob): DecisionRequest {
    return {
      context: {
        filename: job.file.filename,
        mimeType: job.file.mimeType,
        fileSize: job.file.fileSize,
        fileHash: job.file.fileHash,
        storagePath: job.file.storagePath,
        userId: job.user?.userId,
        orgId: job.user?.orgId,
        userTrustScore: job.user?.userTrustScore,
        orgPolicies: job.orgPolicies,
        sandboxResult: job.sandboxResult,
        processingResult: job.processingResult
      },
      correlationId: job.correlationId,
      timestamp: new Date().toISOString()
    };
  }

  /**
   * Convert CyberAgent scan result to SandboxAnalysisResult
   */
  private convertToSandboxResult(
    job: OrchestrationJob,
    scanResult: ScanResult,
    startTime: number
  ): SandboxAnalysisResult {
    const tier = job.triageDecision?.decision.sandboxTier || 'tier2';

    // Map CyberAgent threat level to our type
    const threatLevelMap: Record<CyberThreatLevel, ThreatLevel> = {
      safe: 'safe',
      low: 'low',
      medium: 'medium',
      high: 'high',
      critical: 'critical'
    };

    // Determine category from file metadata or MIME type
    let category: FileClassification['category'] = 'unknown';

    // Check for GitHub repo URLs first (special case - URL-based routing)
    if (job.file.originalUrl && isGitHubRepoUrl(job.file.originalUrl)) {
      // GitHub repo URLs bypass normal file classification
      // They go directly to github-manager
      category = 'code'; // Repos are code
    }
    // Check for geospatial files first (by extension and MIME type)
    else if (this.isGeospatialFile(job.file.mimeType, job.file.filename)) {
      category = 'geo';
    } else if (this.isPointCloudFile(job.file.mimeType, job.file.filename)) {
      category = 'pointcloud';
    } else if (scanResult.file_metadata?.format) {
      if (['PE', 'ELF', 'Mach-O'].includes(scanResult.file_metadata.format)) {
        category = 'binary';
      }
    } else if (job.file.mimeType.startsWith('application/')) {
      if (this.isBinaryFile(job.file.mimeType, job.file.filename)) {
        category = 'binary';
      } else if (job.file.mimeType.includes('pdf') || job.file.mimeType.includes('document')) {
        category = 'document';
      } else if (job.file.mimeType.includes('zip') || job.file.mimeType.includes('archive')) {
        category = 'archive';
      }
    } else if (job.file.mimeType.startsWith('image/') || job.file.mimeType.startsWith('video/')) {
      category = 'media';
    } else if (job.file.mimeType.startsWith('text/')) {
      category = job.file.filename.match(/\.(js|ts|py|go|rs|java|c|cpp|h)$/) ? 'code' : 'document';
    }

    // Build recommendations based on analysis
    const recommendations: SandboxRecommendation[] = [];

    // Check for GitHub repo URL first (highest priority routing)
    if (job.file.originalUrl && isGitHubRepoUrl(job.file.originalUrl)) {
      recommendations.push({
        targetService: 'github-manager' as TargetService,
        method: 'repo_ingestion',
        priority: 10,
        reason: 'GitHub repository URL - ingest into GraphRAG memory',
        confidence: 0.99
      });
    } else if (category === 'binary') {
      recommendations.push({
        targetService: 'cyberagent',
        method: 'binary_analysis',
        priority: 9,
        reason: 'Binary file requires full security analysis',
        confidence: 0.95
      });
    } else if (category === 'geo') {
      recommendations.push({
        targetService: 'geoagent',
        method: 'geospatial_processing',
        priority: 7,
        reason: 'Geospatial file - requires GeoAgent processing',
        confidence: 0.95
      });
    } else if (category === 'pointcloud') {
      recommendations.push({
        targetService: 'geoagent',
        method: 'lidar_processing',
        priority: 7,
        reason: 'Point cloud file - requires GeoAgent LiDAR processing',
        confidence: 0.95
      });
    } else if (category === 'media') {
      // Check if it's specifically a video file
      if (VideoAgentClient.isVideoFileType(job.file.mimeType, job.file.filename)) {
        recommendations.push({
          targetService: 'videoagent',
          method: 'video_processing',
          priority: 7,
          reason: 'Video file - requires VideoAgent processing',
          confidence: 0.9
        });
      } else {
        recommendations.push({
          targetService: 'mageagent',
          method: 'media_analysis',
          priority: 5,
          reason: 'Media file - use MageAgent for analysis',
          confidence: 0.8
        });
      }
    } else if (category === 'document') {
      recommendations.push({
        targetService: 'fileprocess',
        method: 'document_extraction',
        priority: 5,
        reason: 'Standard document processing',
        confidence: 0.9
      });
    } else {
      recommendations.push({
        targetService: 'mageagent',
        method: 'dynamic_process',
        priority: 5,
        reason: 'Unknown file type - use dynamic processing',
        confidence: 0.7
      });
    }

    return {
      analysisId: uuidv4(),
      correlationId: job.correlationId,
      tier: tier,
      classification: {
        category,
        mimeType: job.file.mimeType,
        format: scanResult.file_metadata?.format || 'unknown',
        confidence: scanResult.confidence || 0.8
      },
      security: {
        threatLevel: threatLevelMap[scanResult.threat_level] || 'medium',
        isMalicious: scanResult.is_malicious,
        shouldBlock: scanResult.is_malicious || scanResult.threat_level === 'critical',
        flags: scanResult.yara_matches?.map(m => m.rule_name) || [],
        yaraMatches: scanResult.yara_matches?.map(m => m.rule_name)
      },
      recommendations,
      toolsUsed: job.triageDecision?.decision.tools || [],
      durationMs: Date.now() - startTime,
      timestamp: new Date().toISOString()
    };
  }

  /**
   * Check if file is binary/executable
   */
  private isBinaryFile(mimeType: string, filename: string): boolean {
    const binaryMimeTypes = new Set([
      'application/x-executable',
      'application/x-mach-binary',
      'application/x-mach-o',
      'application/x-dosexec',
      'application/x-msdownload',
      'application/vnd.microsoft.portable-executable',
      'application/x-elf',
      'application/x-sharedlib',
      'application/x-apple-diskimage',
      'application/x-macho',
      'application/octet-stream'
    ]);

    if (binaryMimeTypes.has(mimeType)) return true;

    const ext = filename.split('.').pop()?.toLowerCase();
    const binaryExtensions = new Set([
      'exe', 'dll', 'so', 'dylib', 'dmg', 'pkg', 'app',
      'msi', 'deb', 'rpm', 'apk', 'bin', 'elf'
    ]);

    return !!ext && binaryExtensions.has(ext);
  }

  /**
   * Check if file is a geospatial format
   */
  private isGeospatialFile(mimeType: string, filename: string): boolean {
    const geoMimeTypes = new Set([
      'application/geo+json',
      'application/vnd.geo+json',
      'application/vnd.google-earth.kml+xml',
      'application/vnd.google-earth.kmz',
      'application/gml+xml',
      'application/gpx+xml',
      'image/tiff', // GeoTIFF - check extension too
      'application/x-shapefile',
      'application/x-esri-shapefile',
      'application/vnd.shp'
    ]);

    if (geoMimeTypes.has(mimeType)) return true;

    const ext = filename.split('.').pop()?.toLowerCase();
    const geoExtensions = new Set([
      'geojson', 'json', // GeoJSON (check content for json)
      'kml', 'kmz',      // Google Earth
      'shp', 'shx', 'dbf', 'prj', // Shapefile components
      'gpx',             // GPS Exchange
      'gml',             // Geography Markup Language
      'tiff', 'tif',     // GeoTIFF (may need content check)
      'gpkg',            // GeoPackage
      'mbtiles',         // MapBox Tiles
      'topojson'         // TopoJSON
    ]);

    // Special case: .json files might be GeoJSON - we'll classify as geo if extension matches common patterns
    if (ext === 'geojson') return true;
    if (ext && geoExtensions.has(ext) && ext !== 'json' && ext !== 'tiff' && ext !== 'tif') return true;

    // Check filename patterns for geospatial
    const geoPatterns = /\.(geojson|kml|kmz|shp|gpx|gml|gpkg|mbtiles|topojson)$/i;
    return geoPatterns.test(filename);
  }

  /**
   * Check if file is a point cloud format
   */
  private isPointCloudFile(mimeType: string, filename: string): boolean {
    const pointCloudMimeTypes = new Set([
      'application/vnd.las',
      'application/vnd.laz',
      'application/octet-stream' // Many point cloud formats use this
    ]);

    const ext = filename.split('.').pop()?.toLowerCase();
    const pointCloudExtensions = new Set([
      'las', 'laz',      // LiDAR formats
      'ply',             // Polygon File Format
      'pcd',             // Point Cloud Data
      'xyz',             // XYZ point cloud
      'pts', 'ptx',      // Leica formats
      'e57',             // ASTM E57
      'obj',             // Wavefront OBJ (can contain point clouds)
      'asc'              // ASCII point cloud
    ]);

    if (ext && pointCloudExtensions.has(ext)) return true;

    // Check MIME type only if extension matches typical point cloud
    if (pointCloudMimeTypes.has(mimeType) && ext && pointCloudExtensions.has(ext)) {
      return true;
    }

    return false;
  }

  /**
   * Fallback triage decision (no decision engine)
   */
  private fallbackTriageDecision(file: FileContext): InitialTriageDecision {
    const ext = file.filename.split('.').pop()?.toLowerCase() || '';
    const isBinary = this.isBinaryFile(file.mimeType, file.filename);

    if (isBinary) {
      return {
        sandboxTier: 'tier3',
        priority: 9,
        timeout: 120000,
        tools: ['magic_detect', 'yara_full', 'ghidra', 'strings'],
        reason: 'Binary/executable file requires full analysis'
      };
    }

    const archiveExts = ['zip', 'rar', '7z', 'tar', 'gz'];
    if (archiveExts.includes(ext)) {
      return {
        sandboxTier: 'tier2',
        priority: 7,
        timeout: 60000,
        tools: ['magic_detect', 'yara_quick', 'archive_scan'],
        reason: 'Archive file requires content scan'
      };
    }

    return {
      sandboxTier: 'tier1',
      priority: 5,
      timeout: 30000,
      tools: ['magic_detect', 'yara_quick'],
      reason: 'Standard file - quick scan'
    };
  }

  /**
   * Fallback security decision (no decision engine)
   */
  private fallbackSecurityDecision(sandboxResult: SandboxAnalysisResult): SecurityAssessmentDecision {
    const { security } = sandboxResult;

    if (security.isMalicious || security.threatLevel === 'critical') {
      return {
        action: 'block',
        reason: `Critical threat: ${security.flags.join(', ')}`
      };
    }

    if (security.threatLevel === 'high') {
      return {
        action: 'review',
        reason: 'High threat level requires review',
        reviewQueue: 'security-review',
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()
      };
    }

    return {
      action: 'allow',
      reason: 'Security check passed'
    };
  }

  /**
   * Fallback route decision (no decision engine)
   */
  private fallbackRouteDecision(job: OrchestrationJob): ProcessingRouteDecision {
    // Check for GitHub repo URL first (highest priority)
    if (job.file.originalUrl && isGitHubRepoUrl(job.file.originalUrl)) {
      return {
        targetService: 'github-manager' as TargetService,
        method: 'repo_ingestion',
        priority: 10,
        reason: 'GitHub repository URL - ingest into GraphRAG memory'
      };
    }

    // Use sandbox recommendations if available
    if (job.sandboxResult?.recommendations.length) {
      const rec = job.sandboxResult.recommendations[0];
      return {
        targetService: rec.targetService,
        method: rec.method,
        priority: rec.priority,
        reason: rec.reason
      };
    }

    // Default based on category
    const category = job.sandboxResult?.classification.category || 'unknown';

    switch (category) {
      case 'binary':
        return {
          targetService: 'cyberagent',
          method: 'binary_analysis',
          priority: 8,
          reason: 'Binary file - route to CyberAgent'
        };

      case 'geo':
        return {
          targetService: 'geoagent',
          method: 'geospatial_processing',
          priority: 7,
          reason: 'Geospatial file - route to GeoAgent'
        };

      case 'pointcloud':
        return {
          targetService: 'geoagent',
          method: 'lidar_processing',
          priority: 7,
          reason: 'Point cloud file - route to GeoAgent LiDAR processor'
        };

      case 'media':
      case 'video':
        // Check if it's specifically a video file
        if (VideoAgentClient.isVideoFileType(job.file.mimeType, job.file.filename)) {
          return {
            targetService: 'videoagent',
            method: 'video_processing',
            priority: 6,
            reason: 'Video file - route to VideoAgent'
          };
        }
        // Non-video media (images, audio) go to MageAgent
        return {
          targetService: 'mageagent',
          method: 'media_analysis',
          priority: 5,
          reason: 'Non-video media - route to MageAgent'
        };

      case 'document':
        return {
          targetService: 'fileprocess',
          method: 'document_extraction',
          priority: 5,
          reason: 'Document - route to FileProcess'
        };

      default:
        return {
          targetService: 'mageagent',
          method: 'dynamic_process',
          priority: 5,
          reason: 'Unknown type - route to MageAgent'
        };
    }
  }

  /**
   * Fallback post-process decision (no decision engine)
   */
  private fallbackPostProcessDecision(job: OrchestrationJob): PostProcessingDecision {
    const success = job.processingResult?.success ?? false;

    return {
      storeIn: success ? ['graphrag', 'postgres'] : ['postgres'],
      indexForSearch: success,
      generateEmbeddings: success,
      notifyUser: true,
      learnPattern: success,
      reason: success ? 'Successful processing - full storage' : 'Failed processing - audit only'
    };
  }

  /**
   * Update job state
   */
  private updateJob(job: OrchestrationJob, updates: Partial<OrchestrationJob>): void {
    Object.assign(job, updates, { updatedAt: new Date() });
  }

  /**
   * Add stage message
   */
  private addStageMessage(job: OrchestrationJob, stage: string, message: string, data?: Record<string, unknown>): void {
    job.stageMessages.push({
      timestamp: new Date(),
      stage,
      message,
      data
    });
  }

  /**
   * Emit event to subscribers
   */
  private emitEvent(jobId: string, event: string, data: unknown): void {
    const callbacks = this.eventCallbacks.get(jobId) || [];
    for (const callback of callbacks) {
      try {
        callback(event, data);
      } catch (error) {
        logger.error('Event callback error', { jobId, event, error });
      }
    }
  }

  /**
   * Build response from job
   */
  private buildResponse(job: OrchestrationJob): OrchestrationResponse {
    return {
      jobId: job.id,
      status: job.status,
      progress: job.progress,
      currentStage: job.currentStage,
      result: job.status === 'completed' ? {
        success: job.processingResult?.success ?? false,
        threatLevel: job.sandboxResult?.security.threatLevel,
        targetService: job.routeDecision?.decision.targetService,
        processingResult: job.processingResult,
        storedIn: job.postProcessDecision?.decision.storeIn
      } : undefined,
      error: job.error,
      sseEndpoint: `/fileprocess/api/v1/jobs/${job.id}/stream`
    };
  }

  /**
   * Cleanup stale jobs
   */
  private cleanupStaleJobs(): void {
    const now = Date.now();
    const staleThreshold = this.jobTimeoutMs * 2;

    for (const [jobId, job] of this.jobs.entries()) {
      const age = now - job.createdAt.getTime();
      if (age > staleThreshold && !['completed', 'blocked', 'review_queued', 'failed'].includes(job.status)) {
        logger.warn('Cleaning up stale job', { jobId, age, status: job.status });
        this.jobs.delete(jobId);
        this.eventCallbacks.delete(jobId);
        activeOrchestrations.dec();
      }
    }
  }

  // ============================================================================
  // Statistics
  // ============================================================================

  /**
   * Get orchestrator statistics
   */
  getStatistics(): {
    activeJobs: number;
    totalJobs: number;
    jobsByStatus: Record<OrchestrationStatus, number>;
  } {
    const jobsByStatus: Record<string, number> = {};

    for (const job of this.jobs.values()) {
      jobsByStatus[job.status] = (jobsByStatus[job.status] || 0) + 1;
    }

    return {
      activeJobs: this.jobs.size,
      totalJobs: this.jobs.size,
      jobsByStatus: jobsByStatus as Record<OrchestrationStatus, number>
    };
  }
}

// ============================================================================
// Singleton
// ============================================================================

let orchestratorInstance: SandboxFirstOrchestrator | null = null;

/**
 * Get or create the orchestrator instance
 */
export function getSandboxFirstOrchestrator(): SandboxFirstOrchestrator {
  if (!orchestratorInstance) {
    orchestratorInstance = new SandboxFirstOrchestrator();
  }
  return orchestratorInstance;
}

/**
 * Reset the orchestrator instance (for testing)
 */
export function resetSandboxFirstOrchestrator(): void {
  orchestratorInstance = null;
}
