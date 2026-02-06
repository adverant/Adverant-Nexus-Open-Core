/**
 * Telemetry Consumer Service
 *
 * Consumes telemetry events from Redis Streams and makes orchestration decisions
 */

import {
  TelemetryConsumer,
  TelemetryEvent,
  OrchestrationDecision
} from '@adverant/nexus-telemetry';
import { DecisionEngine, getDecisionEngine } from './decision-engine-service';
import { getCyberAgentClient, CyberAgentClient, ScanType, SecurityTool } from '../clients/cyberagent-client';
import { OpenRouterClient } from '../clients/openrouter-client';
import { logger } from '../utils/logger';
import { config } from '../config';
import { Counter, Histogram, Gauge } from 'prom-client';

// ============================================================================
// Prometheus Metrics
// ============================================================================

const decisionsCounter = new Counter({
  name: 'nexus_orchestration_decisions_total',
  help: 'Total orchestration decisions made',
  labelNames: ['decision', 'rule', 'service']
});

const scansQueuedCounter = new Counter({
  name: 'nexus_security_scans_queued_total',
  help: 'Total security scans queued',
  labelNames: ['scan_type', 'trigger_service']
});

const decisionLatencyHistogram = new Histogram({
  name: 'nexus_decision_latency_seconds',
  help: 'Latency of decision making',
  buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1]
});

const activeConsumersGauge = new Gauge({
  name: 'nexus_telemetry_active_consumers',
  help: 'Number of active telemetry consumers'
});

// ============================================================================
// Types
// ============================================================================

interface TelemetryConsumerServiceConfig {
  redisUrl: string;
  consumerGroup?: string;
  batchSize?: number;
  enableSecurityScans?: boolean;
  openRouterClient?: OpenRouterClient;
}

// ============================================================================
// Telemetry Consumer Service
// ============================================================================

/**
 * TelemetryConsumerService - Orchestrates telemetry event processing
 *
 * Features:
 * - Consumes events from Redis Streams
 * - Evaluates events against decision engine rules
 * - Triggers security scans via CyberAgent
 * - Tracks metrics and statistics
 */
export class TelemetryConsumerService {
  private consumer: TelemetryConsumer | null = null;
  private decisionEngine: DecisionEngine;
  private cyberAgentClient: CyberAgentClient;
  private config: TelemetryConsumerServiceConfig;
  private running: boolean = false;
  private processedCount: number = 0;
  private errorCount: number = 0;

  constructor(consumerConfig?: Partial<TelemetryConsumerServiceConfig>) {
    this.config = {
      redisUrl: consumerConfig?.redisUrl ||
        (config as any).redis?.url ||
        process.env.REDIS_URL ||
        'redis://nexus-redis:6379',
      consumerGroup: consumerConfig?.consumerGroup || 'orchestrator',
      batchSize: consumerConfig?.batchSize || 100,
      enableSecurityScans: consumerConfig?.enableSecurityScans ?? true,
      openRouterClient: consumerConfig?.openRouterClient
    };

    this.decisionEngine = getDecisionEngine();
    this.cyberAgentClient = getCyberAgentClient();

    // Inject OpenRouterClient into DecisionEngine for LLM-powered decisions
    if (this.config.openRouterClient) {
      this.decisionEngine.setOpenRouterClient(this.config.openRouterClient);
      logger.info('LLM-powered decision engine enabled', {
        primaryModel: 'anthropic/claude-opus-4.6',
        fallbackModel: 'google/gemini-2.0-flash-001'
      });
    } else {
      logger.info('Decision engine using fast-path security checks (no LLM)');
    }

    logger.info('TelemetryConsumerService initialized', {
      consumerGroup: this.config.consumerGroup,
      enableSecurityScans: this.config.enableSecurityScans,
      llmEnabled: !!this.config.openRouterClient
    });
  }

  /**
   * Inject OpenRouterClient after construction
   */
  setOpenRouterClient(client: OpenRouterClient): void {
    this.config.openRouterClient = client;
    this.decisionEngine.setOpenRouterClient(client);
    logger.info('OpenRouterClient injected into TelemetryConsumerService');
  }

  /**
   * Start consuming telemetry events
   */
  async start(): Promise<void> {
    if (this.running) {
      logger.warn('TelemetryConsumerService already running');
      return;
    }

    try {
      this.consumer = new TelemetryConsumer({
        redisUrl: this.config.redisUrl,
        consumerGroup: this.config.consumerGroup,
        consumerName: process.env.HOSTNAME || `mageagent-${Date.now()}`,
        batchSize: this.config.batchSize,
        blockTimeout: 5000
      });

      await this.consumer.start(this.handleEvent.bind(this));
      this.running = true;
      activeConsumersGauge.inc();

      logger.info('TelemetryConsumerService started', {
        consumerGroup: this.config.consumerGroup
      });
    } catch (err) {
      logger.error('Failed to start TelemetryConsumerService', {
        error: err instanceof Error ? err.message : 'Unknown error'
      });
      throw err;
    }
  }

  /**
   * Stop consuming events
   */
  async stop(): Promise<void> {
    if (!this.running || !this.consumer) {
      return;
    }

    try {
      await this.consumer.stop();
      this.running = false;
      activeConsumersGauge.dec();

      logger.info('TelemetryConsumerService stopped', {
        processedCount: this.processedCount,
        errorCount: this.errorCount
      });
    } catch (err) {
      logger.error('Error stopping TelemetryConsumerService', {
        error: err instanceof Error ? err.message : 'Unknown error'
      });
    }
  }

  /**
   * Handle a single telemetry event
   */
  private async handleEvent(event: TelemetryEvent): Promise<void> {
    const startTime = Date.now();

    try {
      // Evaluate event against decision engine
      const decision = await this.decisionEngine.evaluate(event);

      // Track metrics
      decisionsCounter.inc({
        decision: decision.decision,
        rule: decision.reason || 'unknown',
        service: event.service
      });

      decisionLatencyHistogram.observe((Date.now() - startTime) / 1000);

      // Handle decision
      await this.handleDecision(event, decision);

      this.processedCount++;

      // Log significant decisions
      if (decision.decision !== 'passthrough') {
        logger.info('Orchestration decision made', {
          correlationId: event.correlationId,
          service: event.service,
          operation: event.operation,
          decision: decision.decision,
          rule: decision.reason,
          scanType: decision.scanType
        });
      }
    } catch (err) {
      this.errorCount++;
      logger.error('Error processing telemetry event', {
        correlationId: event.correlationId,
        error: err instanceof Error ? err.message : 'Unknown error'
      });
    }
  }

  /**
   * Handle a decision by taking appropriate action
   */
  private async handleDecision(
    event: TelemetryEvent,
    decision: OrchestrationDecision
  ): Promise<void> {
    switch (decision.decision) {
      case 'scan':
        if (this.config.enableSecurityScans) {
          await this.triggerSecurityScan(event, decision);
        }
        break;

      case 'block':
        await this.handleBlock(event, decision);
        break;

      case 'route':
        await this.handleRouting(event, decision);
        break;

      case 'passthrough':
        // No action needed, just monitoring
        break;

      default:
        logger.warn('Unknown decision type', {
          decision: decision.decision,
          correlationId: event.correlationId
        });
    }
  }

  /**
   * Trigger a security scan via CyberAgent
   */
  private async triggerSecurityScan(
    event: TelemetryEvent,
    decision: OrchestrationDecision
  ): Promise<void> {
    try {
      // Determine target for scan
      const target = this.extractScanTarget(event);
      if (!target) {
        logger.debug('No scan target found for event', {
          correlationId: event.correlationId
        });
        return;
      }

      // Map decision scan type to CyberAgent scan type
      const scanType = this.mapScanType(decision.scanType);

      // Queue scan job
      const response = await this.cyberAgentClient.createScanJob({
        scan_type: scanType,
        target,
        tools: this.getToolsForScanType(scanType),
        config: {
          priority: this.mapPriority(decision.priority || 5),
          deep_scan: (decision.priority || 5) >= 8
        },
        metadata: {
          correlationId: event.correlationId,
          service: event.service,
          operation: event.operation,
          resourceType: event.resourceType,
          resourceId: event.resourceId,
          triggeredBy: 'orchestrator',
          rule: decision.reason
        }
      });

      scansQueuedCounter.inc({
        scan_type: scanType,
        trigger_service: event.service
      });

      logger.info('Security scan queued', {
        jobId: response.job.id,
        correlationId: event.correlationId,
        scanType,
        priority: decision.priority,
        rule: decision.reason
      });
    } catch (err) {
      logger.error('Failed to queue security scan', {
        correlationId: event.correlationId,
        error: err instanceof Error ? err.message : 'Unknown error'
      });
      // Don't rethrow - scan failures shouldn't block event processing
    }
  }

  /**
   * Handle blocked requests
   */
  private async handleBlock(
    event: TelemetryEvent,
    decision: OrchestrationDecision
  ): Promise<void> {
    // Log the block for audit trail
    logger.warn('Request blocked by orchestration', {
      correlationId: event.correlationId,
      service: event.service,
      operation: event.operation,
      path: event.path,
      rule: decision.reason,
      userId: event.userId,
      orgId: event.orgId
    });

    // In a more complete implementation, this could:
    // - Publish to a security alerts stream
    // - Notify security team via webhook
    // - Update rate limiting rules
    // - Add to blocklist
  }

  /**
   * Handle request routing
   */
  private async handleRouting(
    event: TelemetryEvent,
    decision: OrchestrationDecision
  ): Promise<void> {
    // In a more complete implementation, this could:
    // - Update routing rules in Istio/Envoy
    // - Redirect request to different service
    // - Apply traffic shaping

    logger.debug('Routing decision', {
      correlationId: event.correlationId,
      targetService: decision.targetService,
      reason: decision.reason
    });
  }

  /**
   * Extract scan target from event
   */
  private extractScanTarget(event: TelemetryEvent): string | null {
    const metadata = event.metadata || {};

    // Try various fields that might contain the target
    return (
      (metadata.fileUrl as string) ||
      (metadata.fileId as string) ||
      (metadata.resourceUrl as string) ||
      event.resourceId ||
      (metadata.target as string) ||
      null
    );
  }

  /**
   * Map decision scan type to CyberAgent scan type
   */
  private mapScanType(scanType?: string): ScanType {
    const mapping: Record<string, ScanType> = {
      malware: 'malware',
      exploit: 'vulnerability',
      pentest: 'penetration_test',
      apt: 'apt',
      threat: 'threat_intel'
    };

    return mapping[scanType || ''] || 'malware';
  }

  /**
   * Get security tools for scan type
   */
  private getToolsForScanType(scanType: ScanType): SecurityTool[] {
    const toolsMap: Record<ScanType, SecurityTool[]> = {
      malware: ['yara', 'clamav'],
      vulnerability: ['nuclei', 'nmap'],
      penetration_test: ['nmap', 'nuclei'],
      apt: ['yara', 'volatility'],
      threat_intel: ['yara']
    };

    return toolsMap[scanType] || ['yara'];
  }

  /**
   * Map priority number to CyberAgent priority level
   */
  private mapPriority(priority: number): 'low' | 'normal' | 'high' {
    if (priority >= 8) return 'high';
    if (priority >= 5) return 'normal';
    return 'low';
  }

  /**
   * Get service statistics
   */
  getStatistics(): {
    running: boolean;
    processedCount: number;
    errorCount: number;
    decisionEngineStats: ReturnType<DecisionEngine['getStatistics']>;
    cyberAgentCircuitState: string;
  } {
    return {
      running: this.running,
      processedCount: this.processedCount,
      errorCount: this.errorCount,
      decisionEngineStats: this.decisionEngine.getStatistics(),
      cyberAgentCircuitState: this.cyberAgentClient.getCircuitState()
    };
  }

  /**
   * Check if service is running
   */
  isRunning(): boolean {
    return this.running;
  }
}

// ============================================================================
// Singleton
// ============================================================================

let telemetryConsumerServiceInstance: TelemetryConsumerService | null = null;

/**
 * Get or create the telemetry consumer service instance
 */
export function getTelemetryConsumerService(): TelemetryConsumerService {
  if (!telemetryConsumerServiceInstance) {
    telemetryConsumerServiceInstance = new TelemetryConsumerService();
  }
  return telemetryConsumerServiceInstance;
}

/**
 * Initialize and start the telemetry consumer service
 * @param openRouterClient Optional OpenRouterClient for LLM-powered decisions
 */
export async function initializeTelemetryConsumer(
  openRouterClient?: OpenRouterClient
): Promise<TelemetryConsumerService> {
  const service = getTelemetryConsumerService();

  // Inject OpenRouterClient if provided (enables LLM-powered decisions)
  if (openRouterClient) {
    service.setOpenRouterClient(openRouterClient);
  }

  if (!service.isRunning()) {
    await service.start();
  }
  return service;
}

/**
 * Stop the telemetry consumer service
 */
export async function stopTelemetryConsumer(): Promise<void> {
  if (telemetryConsumerServiceInstance) {
    await telemetryConsumerServiceInstance.stop();
    telemetryConsumerServiceInstance = null;
  }
}
