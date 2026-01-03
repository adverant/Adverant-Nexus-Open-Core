/**
 * LLM-Powered Decision Engine Service
 *
 * REFACTORED: Replaced hardcoded rules with LLM-based intelligent decision making.
 * Uses MageAgent's existing OpenRouterClient to leverage Claude 4.5 Thinking or
 * Gemini 2.0 Flash for orchestration decisions.
 *
 * Architecture:
 * - Reuses existing OpenRouterClient from MageAgent (no new dependencies)
 * - Uses Claude 4.5 (claude-sonnet-4-5) for complex reasoning with extended thinking
 * - Falls back to Gemini 2.0 Flash for cost optimization on simpler decisions
 * - LRU cache prevents redundant LLM calls for similar events
 * - Structured JSON output for reliable parsing
 */

import type {
  TelemetryEvent,
  OrchestrationDecision,
  OrchestrationAction
} from '@adverant/nexus-telemetry';
import { OpenRouterClient, CompletionResponse } from '../clients/openrouter-client';
import { logger } from '../utils/logger';
import { Counter, Histogram, Gauge } from 'prom-client';

// ============================================================================
// Prometheus Metrics
// ============================================================================

const llmDecisionCounter = new Counter({
  name: 'decision_engine_llm_calls_total',
  help: 'Total LLM calls for orchestration decisions',
  labelNames: ['model', 'decision']
});

const llmDecisionLatency = new Histogram({
  name: 'decision_engine_llm_latency_seconds',
  help: 'LLM decision latency in seconds',
  labelNames: ['model'],
  buckets: [0.1, 0.25, 0.5, 1, 2.5, 5, 10]
});

const cacheHitCounter = new Counter({
  name: 'decision_engine_cache_hits_total',
  help: 'Total cache hits for decision engine'
});

const cacheMissCounter = new Counter({
  name: 'decision_engine_cache_misses_total',
  help: 'Total cache misses for decision engine'
});

const cacheSize = new Gauge({
  name: 'decision_engine_cache_size',
  help: 'Current size of the decision cache'
});

// ============================================================================
// Types
// ============================================================================

/**
 * LLM response structure for orchestration decisions
 * ScanType matches @adverant/nexus-telemetry package: 'malware' | 'exploit' | 'pentest' | 'c2' | 'apt_simulation'
 */
interface LLMDecisionResponse {
  action: OrchestrationAction;
  reason: string;
  scanType?: 'malware' | 'exploit' | 'pentest' | 'c2' | 'apt_simulation';
  priority: number; // 0-10, higher = more urgent
  confidence: number; // 0-1
  targetService?: string;
  securityConcerns?: string[];
  suggestedTools?: string[];
}

/**
 * Cached decision with TTL
 */
interface CachedDecision {
  decision: OrchestrationDecision;
  createdAt: number;
  ttl: number;
}

/**
 * Decision Engine configuration
 */
interface DecisionEngineConfig {
  /** Primary model for complex reasoning (default: claude-sonnet-4-5) */
  primaryModel: string;
  /** Fallback model for cost optimization (default: gemini-2.0-flash) */
  fallbackModel: string;
  /** Cache TTL in milliseconds (default: 5 minutes) */
  cacheTtlMs: number;
  /** Maximum cache size (default: 1000 entries) */
  maxCacheSize: number;
  /** Use fallback model for low-priority events (default: true) */
  costOptimization: boolean;
  /** Maximum LLM response time before timeout (default: 10 seconds) */
  llmTimeoutMs: number;
}

// ============================================================================
// LLM-Powered Decision Engine
// ============================================================================

/**
 * LLM-Powered Decision Engine
 *
 * Replaces hardcoded rule evaluation with intelligent LLM-based decision making.
 * Uses structured JSON prompts for reliable parsing and caching for performance.
 */
export class DecisionEngine {
  private openRouterClient: OpenRouterClient | null = null;
  private cache: Map<string, CachedDecision> = new Map();
  private config: DecisionEngineConfig;

  // Statistics tracking
  private stats = {
    totalDecisions: 0,
    cacheHits: 0,
    llmCalls: 0,
    errors: 0,
    avgLatencyMs: 0
  };

  constructor(config?: Partial<DecisionEngineConfig>) {
    this.config = {
      // Claude 4.5 Sonnet with extended thinking for complex security reasoning
      primaryModel: config?.primaryModel || 'anthropic/claude-sonnet-4-5-20250514',
      // Gemini 2.0 Flash for fast, cost-effective decisions
      fallbackModel: config?.fallbackModel || 'google/gemini-2.0-flash-001',
      cacheTtlMs: config?.cacheTtlMs || 5 * 60 * 1000, // 5 minutes
      maxCacheSize: config?.maxCacheSize || 1000,
      costOptimization: config?.costOptimization ?? true,
      llmTimeoutMs: config?.llmTimeoutMs || 10000 // 10 seconds
    };

    logger.info('LLM-Powered Decision Engine initialized', {
      primaryModel: this.config.primaryModel,
      fallbackModel: this.config.fallbackModel,
      cacheTtlMs: this.config.cacheTtlMs,
      costOptimization: this.config.costOptimization
    });
  }

  /**
   * Inject OpenRouterClient dependency
   * Must be called before evaluate() to enable LLM decisions
   */
  setOpenRouterClient(client: OpenRouterClient): void {
    this.openRouterClient = client;
    logger.info('OpenRouterClient injected into Decision Engine');
  }

  /**
   * Evaluate a telemetry event and return an orchestration decision
   * Uses LLM reasoning instead of hardcoded rules
   */
  async evaluate(event: TelemetryEvent): Promise<OrchestrationDecision> {
    const startTime = Date.now();
    this.stats.totalDecisions++;

    try {
      // Only evaluate START events for proactive decisions
      if (event.phase !== 'start') {
        return this.createPassthroughDecision(event, 'Non-start phase event');
      }

      // Check cache first
      const cacheKey = this.generateCacheKey(event);
      const cached = this.getFromCache(cacheKey);
      if (cached) {
        cacheHitCounter.inc();
        this.stats.cacheHits++;
        logger.debug('Decision cache hit', {
          correlationId: event.correlationId,
          decision: cached.decision
        });
        return {
          ...cached,
          eventId: event.eventId,
          correlationId: event.correlationId,
          timestamp: new Date().toISOString()
        };
      }
      cacheMissCounter.inc();

      // If OpenRouterClient not available, use fast-path security checks
      if (!this.openRouterClient) {
        logger.warn('OpenRouterClient not available, using fast-path security checks');
        return this.fastPathSecurityCheck(event);
      }

      // Use LLM for intelligent decision making
      const decision = await this.makeLLMDecision(event);

      // Cache the decision
      this.addToCache(cacheKey, decision);

      return decision;
    } catch (error) {
      this.stats.errors++;
      logger.error('Decision engine error', {
        correlationId: event.correlationId,
        error: error instanceof Error ? error.message : 'Unknown error'
      });

      // Fallback to fast-path security check on LLM failure
      return this.fastPathSecurityCheck(event);
    } finally {
      const durationMs = Date.now() - startTime;
      this.updateAverageLatency(durationMs);

      if (durationMs > 100) {
        logger.debug('Decision evaluation completed', {
          correlationId: event.correlationId,
          durationMs
        });
      }
    }
  }

  /**
   * Make an LLM-powered decision using Claude 4.5 or Gemini 2.0
   */
  private async makeLLMDecision(event: TelemetryEvent): Promise<OrchestrationDecision> {
    const startTime = Date.now();
    this.stats.llmCalls++;

    // Select model based on event complexity and cost optimization
    const model = this.selectModel(event);

    try {
      const prompt = this.buildDecisionPrompt(event);

      const response = await Promise.race([
        this.openRouterClient!.createCompletion({
          model,
          messages: [
            {
              role: 'system',
              content: this.getSystemPrompt()
            },
            {
              role: 'user',
              content: prompt
            }
          ],
          max_tokens: 1000,
          temperature: 0.1, // Low temperature for consistent decisions
          response_format: { type: 'json_object' }
        }),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('LLM timeout')), this.config.llmTimeoutMs)
        )
      ]) as CompletionResponse;

      const latency = (Date.now() - startTime) / 1000;
      llmDecisionLatency.labels(model).observe(latency);

      // Parse LLM response
      const llmDecision = this.parseLLMResponse(response);
      llmDecisionCounter.labels(model, llmDecision.action).inc();

      logger.debug('LLM decision made', {
        correlationId: event.correlationId,
        model,
        action: llmDecision.action,
        reason: llmDecision.reason,
        confidence: llmDecision.confidence,
        latencyMs: Date.now() - startTime
      });

      return {
        eventId: event.eventId,
        correlationId: event.correlationId,
        decision: llmDecision.action,
        reason: llmDecision.reason,
        scanType: llmDecision.scanType,
        priority: llmDecision.priority,
        targetService: llmDecision.targetService,
        confidence: llmDecision.confidence,
        timestamp: new Date().toISOString()
      };
    } catch (error) {
      logger.error('LLM decision failed', {
        correlationId: event.correlationId,
        model,
        error: error instanceof Error ? error.message : 'Unknown error'
      });

      // Re-throw to trigger fallback
      throw error;
    }
  }

  /**
   * Select the appropriate model based on event complexity
   */
  private selectModel(event: TelemetryEvent): string {
    // Use primary model (Claude 4.5) for complex scenarios
    const isComplex =
      event.operation.includes('admin') ||
      event.operation.includes('security') ||
      event.path.includes('/admin') ||
      event.path.includes('/auth') ||
      (event.metadata?.contentLength && parseInt(event.metadata.contentLength as string) > 10 * 1024 * 1024);

    if (isComplex || !this.config.costOptimization) {
      return this.config.primaryModel;
    }

    // Use fallback model (Gemini 2.0 Flash) for simpler decisions
    return this.config.fallbackModel;
  }

  /**
   * Get the system prompt for LLM decision making
   */
  private getSystemPrompt(): string {
    return `You are a security-focused orchestration decision engine for the Nexus platform.
Your role is to analyze incoming HTTP requests and determine the appropriate security action.

Available actions:
- "passthrough": Allow the request to proceed normally (no security concern)
- "scan": Route to CyberAgent for security scanning (file/content analysis)
- "block": Block the request entirely (clear security threat detected)

Available scan types (when action is "scan"):
- "malware": Scan for malware, viruses, trojans
- "exploit": Scan for exploit attempts, payloads, or vulnerabilities
- "pentest": Enhanced security testing for admin operations
- "c2": Command and control communication detection
- "apt_simulation": Advanced persistent threat detection and simulation

Respond ONLY with a JSON object in this exact format:
{
  "action": "passthrough" | "scan" | "block",
  "reason": "Brief explanation of the decision",
  "scanType": "malware" | "exploit" | "pentest" | "c2" | "apt_simulation" (only if action is "scan"),
  "priority": 0-10 (higher = more urgent, 0 = lowest),
  "confidence": 0.0-1.0 (how confident you are in this decision),
  "targetService": "cyberagent" (only if action is "scan"),
  "securityConcerns": ["list", "of", "concerns"] (optional),
  "suggestedTools": ["yara", "clamav", "nuclei"] (optional, for scans)
}

Decision guidelines:
1. File uploads/downloads: Always scan for malware (priority 5-7)
2. Executable files (.exe, .dll, .sh, etc.): High priority scan (8-9)
3. Archive files (.zip, .rar, .7z): Scan for hidden threats (priority 6)
4. PDF files: Scan for embedded scripts (priority 5)
5. Admin operations: Enhanced monitoring with pentest scan (priority 8-10)
6. Path traversal attempts (../): BLOCK immediately (priority 10)
7. SQL injection patterns: BLOCK immediately (priority 10)
8. Large files (>10MB): Scan with priority 7
9. Normal API calls: Passthrough (priority 0)
10. Health checks, metrics: Passthrough (priority 0)`;
  }

  /**
   * Build the decision prompt from the telemetry event
   */
  private buildDecisionPrompt(event: TelemetryEvent): string {
    const metadata = event.metadata || {};

    return `Analyze this incoming request and determine the security action:

Request Details:
- Service: ${event.service}
- Operation: ${event.operation}
- Method: ${event.method}
- Path: ${event.path}
- Resource Type: ${event.resourceType || 'unknown'}
- User ID: ${event.userId || 'anonymous'}
- Organization: ${event.orgId || 'unknown'}

Metadata:
- Content Type: ${metadata.contentType || 'not specified'}
- Content Length: ${metadata.contentLength || 'unknown'}
- Filename: ${metadata.filename || metadata.fileName || 'none'}
- Query Parameters: ${JSON.stringify(metadata.query || {})}
- User Agent: ${metadata.userAgent || 'not provided'}

Additional Context:
- Correlation ID: ${event.correlationId}
- Timestamp: ${event.timestamp}

Determine the appropriate security action for this request.`;
  }

  /**
   * Parse the LLM response into a structured decision
   */
  private parseLLMResponse(response: CompletionResponse): LLMDecisionResponse {
    const content = response.choices[0]?.message?.content || '';

    try {
      const parsed = JSON.parse(content);

      // Validate required fields
      if (!parsed.action || !['passthrough', 'scan', 'block'].includes(parsed.action)) {
        throw new Error(`Invalid action: ${parsed.action}`);
      }

      return {
        action: parsed.action as OrchestrationAction,
        reason: parsed.reason || 'LLM decision',
        scanType: parsed.scanType,
        priority: Math.min(10, Math.max(0, parsed.priority || 5)),
        confidence: Math.min(1, Math.max(0, parsed.confidence || 0.8)),
        targetService: parsed.targetService,
        securityConcerns: parsed.securityConcerns,
        suggestedTools: parsed.suggestedTools
      };
    } catch (error) {
      logger.error('Failed to parse LLM response', {
        content,
        error: error instanceof Error ? error.message : 'Unknown error'
      });

      // Default to passthrough on parse failure
      return {
        action: 'passthrough',
        reason: 'LLM response parse failure - defaulting to passthrough',
        priority: 0,
        confidence: 0.5
      };
    }
  }

  /**
   * Fast-path security check when LLM is unavailable
   * Performs critical security checks without LLM
   */
  private fastPathSecurityCheck(event: TelemetryEvent): OrchestrationDecision {
    const path = event.path.toLowerCase();
    const operation = event.operation.toLowerCase();
    const metadata = event.metadata || {};

    // BLOCK: Path traversal attempts
    if (path.includes('..') || path.includes('%2e%2e')) {
      return this.createDecision(event, 'block', 'Path traversal attempt detected', 10, 1.0);
    }

    // BLOCK: SQL injection patterns
    const queryStr = JSON.stringify(metadata.query || {}).toLowerCase();
    if (/(\bunion\b|\bselect\b|\bdrop\b|\binsert\b|\bdelete\b.*\bfrom\b)/i.test(queryStr)) {
      return this.createDecision(event, 'block', 'SQL injection pattern detected', 10, 0.95);
    }

    // SCAN: File operations
    if (operation.includes('file') || operation.includes('upload') || operation.includes('download')) {
      return this.createDecision(event, 'scan', 'File operation requires security scan', 7, 0.9, 'malware');
    }

    // SCAN: Admin operations
    if (path.includes('/admin') || operation.includes('admin')) {
      return this.createDecision(event, 'scan', 'Admin operation requires enhanced monitoring', 8, 0.9, 'pentest');
    }

    // SCAN: Auth operations (audit logging)
    if (path.includes('/auth') || path.includes('/login') || path.includes('/token')) {
      return this.createDecision(event, 'passthrough', 'Authentication operation - audit only', 3, 0.85);
    }

    // Default: Passthrough
    return this.createPassthroughDecision(event, 'No security concerns detected');
  }

  /**
   * Create a decision object
   */
  private createDecision(
    event: TelemetryEvent,
    action: OrchestrationAction,
    reason: string,
    priority: number,
    confidence: number,
    scanType?: string
  ): OrchestrationDecision {
    return {
      eventId: event.eventId,
      correlationId: event.correlationId,
      decision: action,
      reason,
      scanType: scanType as OrchestrationDecision['scanType'],
      priority,
      targetService: action === 'scan' ? 'cyberagent' : undefined,
      confidence,
      timestamp: new Date().toISOString()
    };
  }

  /**
   * Create a passthrough decision
   */
  private createPassthroughDecision(event: TelemetryEvent, reason: string): OrchestrationDecision {
    return this.createDecision(event, 'passthrough', reason, 0, 1.0);
  }

  /**
   * Generate a cache key from the telemetry event
   * Key is based on operation, path pattern, and content characteristics
   */
  private generateCacheKey(event: TelemetryEvent): string {
    const metadata = event.metadata || {};

    // Normalize path by removing dynamic segments (IDs, UUIDs)
    const normalizedPath = event.path
      .replace(/\/[a-f0-9-]{36}\//g, '/:id/') // UUIDs
      .replace(/\/\d+\//g, '/:id/') // Numeric IDs
      .replace(/\/[a-f0-9]{24}\//g, '/:id/'); // MongoDB ObjectIds

    // Extract file extension if present
    const filename = (metadata.filename || metadata.fileName || '') as string;
    const fileExt = filename.split('.').pop()?.toLowerCase() || '';

    // Build cache key
    const keyParts = [
      event.service,
      event.method,
      normalizedPath,
      event.operation,
      fileExt,
      metadata.contentType || ''
    ];

    return keyParts.join('|');
  }

  /**
   * Get a decision from cache if valid
   */
  private getFromCache(key: string): OrchestrationDecision | null {
    const cached = this.cache.get(key);
    if (!cached) return null;

    // Check TTL
    if (Date.now() - cached.createdAt > cached.ttl) {
      this.cache.delete(key);
      return null;
    }

    return cached.decision;
  }

  /**
   * Add a decision to cache with LRU eviction
   */
  private addToCache(key: string, decision: OrchestrationDecision): void {
    // LRU eviction if cache is full
    if (this.cache.size >= this.config.maxCacheSize) {
      const oldestKey = this.cache.keys().next().value;
      if (oldestKey) {
        this.cache.delete(oldestKey);
      }
    }

    this.cache.set(key, {
      decision,
      createdAt: Date.now(),
      ttl: this.config.cacheTtlMs
    });

    cacheSize.set(this.cache.size);
  }

  /**
   * Update rolling average latency
   */
  private updateAverageLatency(latencyMs: number): void {
    const alpha = 0.1; // Exponential moving average factor
    this.stats.avgLatencyMs = alpha * latencyMs + (1 - alpha) * this.stats.avgLatencyMs;
  }

  /**
   * Get statistics about decision engine usage
   */
  getStatistics(): {
    totalDecisions: number;
    cacheHits: number;
    cacheHitRate: number;
    llmCalls: number;
    errors: number;
    avgLatencyMs: number;
    cacheSize: number;
  } {
    return {
      ...this.stats,
      cacheHitRate: this.stats.totalDecisions > 0
        ? this.stats.cacheHits / this.stats.totalDecisions
        : 0,
      cacheSize: this.cache.size
    };
  }

  /**
   * Clear the decision cache
   */
  clearCache(): void {
    this.cache.clear();
    cacheSize.set(0);
    logger.info('Decision engine cache cleared');
  }

  /**
   * Update configuration at runtime
   */
  updateConfig(config: Partial<DecisionEngineConfig>): void {
    this.config = { ...this.config, ...config };
    logger.info('Decision engine configuration updated', this.config);
  }
}

// ============================================================================
// Singleton Management
// ============================================================================

let decisionEngineInstance: DecisionEngine | null = null;

/**
 * Get or create the decision engine instance
 */
export function getDecisionEngine(): DecisionEngine {
  if (!decisionEngineInstance) {
    decisionEngineInstance = new DecisionEngine();
  }
  return decisionEngineInstance;
}

/**
 * Create a fresh decision engine (for testing)
 */
export function createDecisionEngine(config?: Partial<DecisionEngineConfig>): DecisionEngine {
  return new DecisionEngine(config);
}

/**
 * Reset the singleton instance (for testing)
 */
export function resetDecisionEngine(): void {
  decisionEngineInstance = null;
}
