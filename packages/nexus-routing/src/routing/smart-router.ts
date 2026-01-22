/**
 * Smart Router for Nexus
 * Intelligently routes tool requests to appropriate backend service
 */

import { logger } from '../utils/logger.js';
import { RoutingError } from '../utils/error-handler.js';
import { graphragClientV2 as graphragClient } from '../clients/graphrag-client-v2.js';
import { mageagentClientV2 as mageagentClient } from '../clients/mageagent-client-v2.js';
import { apiGatewayClient } from '../clients/api-gateway-client.js';
import { videoagentClient } from '../clients/videoagent-client.js';
import { fileprocessagentClient } from '../clients/fileprocess-agent-client.js';
import { config } from '../config.js';

export interface RouteDecision {
  service: 'graphrag' | 'mageagent' | 'videoagent' | 'fileprocess-agent' | 'both' | 'api_gateway' | 'admin';
  handler: (args: any) => Promise<any>;
  description: string;
  requiresHealthCheck?: boolean;
  fallbackHandler?: (args: any) => Promise<any>;
}

/**
 * Request context for API key tracking and usage attribution
 * Passed through the routing layer to downstream services
 */
export interface RequestContext {
  /** API Key ID (UUID) for usage tracking - set after API key validation */
  apiKeyId?: string;
  /** User ID associated with the request */
  userId?: string;
  /** Subscription tier for access control */
  tier?: string;
  /** User email for logging */
  email?: string;
}

interface HealthCheckEntry {
  healthy: boolean;
  lastCheck: number;
  consecutiveFailures: number;
}

/**
 * SmartRouter class - Routes tool requests to appropriate backend
 */
export class SmartRouter {
  private healthCheckCache: Map<string, HealthCheckEntry> = new Map();
  private readonly HEALTH_CHECK_TTL = 10000; // 10 seconds cache (reduced from 30s)
  private readonly MAX_CACHE_SIZE = 100; // Prevent unbounded growth
  private readonly MAX_CACHE_AGE = 300000; // 5 minutes max age before cleanup
  private lastCleanup: number = Date.now();

  /**
   * Current request context for API key tracking
   * Set before routing to propagate to downstream services
   */
  private currentContext: RequestContext | null = null;

  /**
   * Constructor - Validates handler completeness on instantiation
   * FAIL-FAST PRINCIPLE: Better to fail at startup than at runtime
   */
  constructor() {
    this.validateHandlerCompleteness();
    logger.info('SmartRouter initialized and validated', {
      multiServiceTools: this.getMultiServiceTools().length
    });
  }

  /**
   * Validate that all multi-service tools have complete handler registration
   * This prevents runtime failures caused by incomplete handler maps
   *
   * ARCHITECTURAL PRINCIPLE:
   * If a tool declares it needs both GraphRAG AND MageAgent, BOTH services
   * MUST have registered handlers. Partial registration creates brittle systems.
   */
  private validateHandlerCompleteness(): void {
    const multiServiceTools = this.getMultiServiceTools();
    const incomplete: string[] = [];

    logger.debug('Validating handler completeness', {
      multiServiceToolsCount: multiServiceTools.length,
      tools: multiServiceTools
    });

    for (const toolName of multiServiceTools) {
      // Check GraphRAG handler exists
      try {
        this.getGraphRAGHandler(toolName);
      } catch (error) {
        incomplete.push(`${toolName}: missing GraphRAG handler - ${(error as Error).message}`);
      }

      // Check MageAgent handler exists
      try {
        this.getMageAgentHandler(toolName);
      } catch (error) {
        incomplete.push(`${toolName}: missing MageAgent handler - ${(error as Error).message}`);
      }
    }

    if (incomplete.length > 0) {
      const errorMessage =
        `HANDLER REGISTRATION INCOMPLETE - System integrity compromised\n\n` +
        `Root Cause: Tools requiring both services must have handlers in BOTH GraphRAG AND MageAgent.\n\n` +
        `Incomplete Registrations:\n${incomplete.map(i => `  - ${i}`).join('\n')}\n\n` +
        `Resolution:\n` +
        `1. Add missing handlers to getGraphRAGHandler() or getMageAgentHandler() methods\n` +
        `2. OR remove tool from requiresBothServices() if it doesn't need both\n` +
        `3. Verify handler implementation exists in respective client (graphragClient/mageagentClient)\n\n` +
        `Failing fast to prevent partial failures at runtime.`;

      logger.error('Handler completeness validation failed', {
        incompleteCount: incomplete.length,
        incomplete
      });

      throw new Error(errorMessage);
    }

    logger.info('✅ Handler completeness validation passed', {
      multiServiceTools: multiServiceTools.length,
      validated: 'all handlers present'
    });
  }

  /**
   * Get list of tools that require both services
   * Used for validation and testing
   */
  private getMultiServiceTools(): string[] {
    // No tools currently require routing to BOTH services
    // nexus_health uses custom aggregation via routeHealthCheck()
    // nexus_clear_data routes to GraphRAG only
    return [];
  }

  /**
   * Clean up stale entries from health check cache
   * Implements LRU-style eviction to prevent memory leaks
   */
  private cleanupHealthCheckCache(): void {
    const now = Date.now();

    // Only cleanup if it's been a while since last cleanup
    if (now - this.lastCleanup < this.MAX_CACHE_AGE) {
      return;
    }

    logger.debug('Cleaning up health check cache', {
      currentSize: this.healthCheckCache.size
    });

    // Remove stale entries
    for (const [service, entry] of this.healthCheckCache.entries()) {
      if (now - entry.lastCheck > this.MAX_CACHE_AGE) {
        this.healthCheckCache.delete(service);
        logger.debug('Removed stale health check entry', { service });
      }
    }

    // If still too large, remove oldest entries (LRU)
    if (this.healthCheckCache.size > this.MAX_CACHE_SIZE) {
      const entries = Array.from(this.healthCheckCache.entries());
      entries.sort((a, b) => a[1].lastCheck - b[1].lastCheck);

      const toRemove = entries.slice(0, entries.length - this.MAX_CACHE_SIZE);
      toRemove.forEach(([service]) => {
        this.healthCheckCache.delete(service);
        logger.debug('Evicted health check entry (LRU)', { service });
      });
    }

    this.lastCleanup = now;
    logger.debug('Health check cache cleanup complete', {
      size: this.healthCheckCache.size
    });
  }

  /**
   * Calculate backoff delay based on consecutive failures
   * Implements exponential backoff to reduce load on failing services
   * @param consecutiveFailures Number of consecutive failures
   * @returns Backoff delay in milliseconds
   */
  private calculateBackoff(consecutiveFailures: number): number {
    // Exponential backoff: 2^n * 1000ms, capped at 60s
    return Math.min(Math.pow(2, consecutiveFailures) * 1000, 60000);
  }

  /**
   * Check service health with caching, exponential backoff, and cleanup
   * @param service Service to check
   * @returns true if healthy, false otherwise
   */
  private async checkServiceHealth(service: 'graphrag' | 'mageagent' | 'api_gateway' | 'videoagent' | 'fileprocess-agent'): Promise<boolean> {
    const now = Date.now();

    // Periodic cleanup to prevent memory leaks
    this.cleanupHealthCheckCache();

    const cached = this.healthCheckCache.get(service);

    // Check if cached result is still valid
    if (cached) {
      const age = now - cached.lastCheck;

      // If service is healthy and cache is fresh, use it
      if (cached.healthy && age < this.HEALTH_CHECK_TTL) {
        logger.debug('Using cached health check (healthy)', {
          service,
          age: `${age}ms`
        });
        return true;
      }

      // If service is unhealthy, apply exponential backoff
      if (!cached.healthy) {
        const backoffDelay = this.calculateBackoff(cached.consecutiveFailures);
        if (age < backoffDelay) {
          logger.debug('Service in backoff period', {
            service,
            consecutiveFailures: cached.consecutiveFailures,
            backoffDelay: `${backoffDelay}ms`,
            timeRemaining: `${backoffDelay - age}ms`
          });
          return false;
        }
      }
    }

    // Perform health check
    try {
      let healthy = false;

      switch (service) {
        case 'graphrag':
          healthy = await graphragClient.checkHealth();
          break;
        case 'mageagent':
          healthy = await mageagentClient.checkHealth();
          break;
        case 'api_gateway':
          const gatewayHealth = await apiGatewayClient.checkHealth();
          healthy = gatewayHealth.status === 'healthy' || gatewayHealth.status === 'ok';
          break;
        case 'videoagent':
          healthy = await videoagentClient.checkHealth();
          break;
        case 'fileprocess-agent':
          healthy = await fileprocessagentClient.checkHealth();
          break;
      }

      // Update cache
      const consecutiveFailures = healthy ? 0 : (cached?.consecutiveFailures || 0) + 1;
      this.healthCheckCache.set(service, {
        healthy,
        lastCheck: now,
        consecutiveFailures
      });

      if (healthy && cached && !cached.healthy) {
        logger.info('Service recovered', {
          service,
          wasDown: `${now - cached.lastCheck}ms`
        });
      }

      logger.debug('Health check completed', {
        service,
        healthy,
        consecutiveFailures
      });

      return healthy;

    } catch (error) {
      logger.warn('Health check failed', {
        service,
        error: (error as Error).message
      });

      // Cache as unhealthy with incremented failure count
      const consecutiveFailures = (cached?.consecutiveFailures || 0) + 1;
      this.healthCheckCache.set(service, {
        healthy: false,
        lastCheck: now,
        consecutiveFailures
      });

      return false;
    }
  }

  /**
   * Get the current request context
   * Used by clients to access API key ID for usage tracking headers
   */
  getContext(): RequestContext | null {
    return this.currentContext;
  }

  /**
   * Route a tool request to the appropriate service
   * @param toolName Name of the tool to route
   * @param args Tool arguments
   * @param skipHealthCheck Skip health check for performance (default: false)
   * @param context Optional request context with API key ID for usage tracking
   */
  async route(toolName: string, args: any, skipHealthCheck = false, context?: RequestContext): Promise<RouteDecision> {
    // Store context for downstream clients to access
    if (context) {
      this.currentContext = context;
      logger.debug('Request context set', {
        apiKeyId: context.apiKeyId ? `${context.apiKeyId.substring(0, 8)}...` : undefined,
        userId: context.userId ? `${context.userId.substring(0, 8)}...` : undefined,
        tier: context.tier
      });
    }

    logger.debug('Routing tool request', { toolName, args, skipHealthCheck, hasContext: !!context });

    // ============================================================
    // PHASE 0: ADMIN TOOLS (highest priority - @adverant.ai users only)
    // Admin tools are handled directly by the gateway's admin-tool-handlers
    // ============================================================

    if (this.isAdminOperation(toolName)) {
      return this.routeToAdmin(toolName, args);
    }

    // ============================================================
    // PHASE 1: EXACT MATCH OPERATIONS (highest priority)
    // These must be checked FIRST to prevent false positives
    // from substring matching in later phases
    // ============================================================

    // Code Validation operations → Nexus API Gateway (MOVED UP!)
    // Must be before isAnalysisOperation which uses substring matching
    if (this.isValidationOperation(toolName)) {
      return this.routeToAPIGateway(toolName, args);
    }

    // Context Injection operations → Nexus API Gateway
    if (this.isContextOperation(toolName)) {
      return this.routeToAPIGateway(toolName, args);
    }

    // Execution-Learning operations → Nexus API Gateway
    if (this.isExecutionLearningOperation(toolName)) {
      return this.routeToAPIGateway(toolName, args);
    }

    // Health check aggregates both services
    if (this.isHealthCheckOperation(toolName)) {
      return this.routeHealthCheck(args);
    }

    // Stats operations → GraphRAG
    if (this.isStatsOperation(toolName)) {
      return this.routeToGraphRAG(toolName, args);
    }

    // Clear data operations → GraphRAG
    if (this.isClearDataOperation(toolName)) {
      return this.routeToGraphRAG(toolName, args);
    }

    // URL Ingestion operations → GraphRAG
    if (this.isIngestionOperation(toolName)) {
      return this.routeToGraphRAG(toolName, args, skipHealthCheck);
    }

    // ============================================================
    // PHASE 2: GRAPHRAG OPERATIONS (knowledge graph & memory)
    // Substring matching with specific patterns
    // ============================================================

    // Memory operations → GraphRAG
    if (this.isMemoryOperation(toolName)) {
      return this.routeToGraphRAG(toolName, args);
    }

    // Document operations → GraphRAG
    if (this.isDocumentOperation(toolName)) {
      return this.routeToGraphRAG(toolName, args);
    }

    // Episode operations → GraphRAG
    if (this.isEpisodeOperation(toolName)) {
      return this.routeToGraphRAG(toolName, args);
    }

    // Entity operations → GraphRAG (FIXED to handle plural)
    if (this.isEntityOperation(toolName)) {
      return this.routeToGraphRAG(toolName, args);
    }

    // Retrieval operations → GraphRAG
    if (this.isRetrievalOperation(toolName)) {
      return this.routeToGraphRAG(toolName, args);
    }

    // ============================================================
    // PHASE 3: MAGEAGENT OPERATIONS (agents & orchestration)
    // Substring matching with exclusions for ambiguous cases
    // ============================================================

    // Agent orchestration → MageAgent
    if (this.isOrchestrationOperation(toolName)) {
      return this.routeToMageAgent(toolName, args);
    }

    // Agent management → MageAgent
    if (this.isAgentManagementOperation(toolName)) {
      return this.routeToMageAgent(toolName, args);
    }

    // Analysis operations → MageAgent (WITH EXCLUSIONS!)
    // Now safe because validation tools were checked in Phase 1
    if (this.isAnalysisOperation(toolName)) {
      return this.routeToMageAgent(toolName, args);
    }

    // ============================================================
    // PHASE 3.5: VIDEOAGENT OPERATIONS (video processing)
    // ============================================================
    if (this.isVideoAgentOperation(toolName)) {
      return this.routeToVideoAgent(toolName, args);
    }

    // ============================================================
    // PHASE 3.6: FILEPROCESS AGENT OPERATIONS (document processing)
    // ============================================================
    if (this.isFileProcessAgentOperation(toolName)) {
      return this.routeToFileProcessAgent(toolName, args);
    }

    // ============================================================
    // PHASE 4: SPECIAL CASES
    // ============================================================

    // Special cases that need both services
    if (this.requiresBothServices(toolName)) {
      return this.routeToBoth(toolName, args);
    }

    // Unknown tool - comprehensive error message
    throw new RoutingError(
      toolName,
      `Tool '${toolName}' not recognized by router. ` +
      `Available tool categories: ` +
      `Memory (nexus_store_memory, nexus_recall_memory), ` +
      `Documents (nexus_store_document, nexus_list_documents), ` +
      `Entities (nexus_store_entity, nexus_query_entities), ` +
      `Episodes (nexus_store_episode, nexus_recall_episodes), ` +
      `Validation (nexus_validate_code, nexus_analyze_code), ` +
      `Execution (nexus_sandbox_execute), ` +
      `Agents (nexus_orchestrate, nexus_list_agents), ` +
      `Analysis (nexus_analyze, nexus_synthesize). ` +
      `Check tool name spelling and consult API documentation.`
    );
  }

  /**
   * Check if tool is a memory operation (GraphRAG)
   * Explicitly check for GraphRAG memory tools to avoid routing conflicts
   */
  private isMemoryOperation(toolName: string): boolean {
    return (toolName === 'nexus_store_memory' ||
            toolName === 'nexus_recall_memory' ||
            toolName === 'nexus_list_memories');
  }

  /**
   * Check if tool is a document operation
   */
  private isDocumentOperation(toolName: string): boolean {
    return toolName.includes('document');
  }

  /**
   * Check if tool is an episode operation
   */
  private isEpisodeOperation(toolName: string): boolean {
    return toolName.includes('episode');
  }

  /**
   * Check if tool is a retrieval operation
   */
  private isRetrievalOperation(toolName: string): boolean {
    return toolName.includes('retrieve') || toolName === 'nexus_search';
  }

  /**
   * Check if tool is an entity operation
   * Matches both singular 'entity' and plural 'entities'
   */
  private isEntityOperation(toolName: string): boolean {
    return toolName.includes('entit') || toolName.includes('domain');
  }

  /**
   * Check if tool is an orchestration operation
   */
  private isOrchestrationOperation(toolName: string): boolean {
    return toolName.includes('orchestrate') ||
           toolName.includes('competition') ||
           toolName.includes('collaborate');
  }

  /**
   * Check if tool is an analysis operation (MageAgent)
   * EXCLUDES validation tools that contain "analyze" - those route to API Gateway
   * EXCLUDES nexus_analyze_code - that routes to API Gateway for fast code analysis
   */
  private isAnalysisOperation(toolName: string): boolean {
    // Exclude validation tools that contain "analyze"
    if (this.isValidationOperation(toolName)) {
      return false;
    }

    return toolName === 'nexus_analyze' ||  // Exact match for MageAgent deep analyze
           toolName.includes('synthesize') ||
           toolName.includes('pattern') ||
           toolName.includes('model');
  }

  /**
   * Check if tool is agent management
   */
  private isAgentManagementOperation(toolName: string): boolean {
    return (toolName.includes('agent') || toolName.includes('task')) &&
           !toolName.includes('mageagent');
  }

  /**
   * Check if tool is execution-learning operation
   */
  private isExecutionLearningOperation(toolName: string): boolean {
    return toolName === 'nexus_trigger_learning' ||
           toolName === 'nexus_recall_learned_knowledge' ||
           toolName === 'nexus_sandbox_execute';
  }

  /**
   * Check if tool is validation operation (Phase 3)
   * Validation operations include:
   * - Multi-model consensus validation (nexus_validate_code, nexus_validate_command)
   * - Fast single-model analysis (nexus_analyze_code - routed to API Gateway)
   * - Validation result retrieval (nexus_validation_result)
   */
  private isValidationOperation(toolName: string): boolean {
    return toolName === 'nexus_validate_code' ||
           toolName === 'nexus_validate_command' ||
           toolName === 'nexus_analyze_code' ||
           toolName === 'nexus_validation_result';
  }

  /**
   * Check if tool is context injection operation (Phase 4)
   */
  private isContextOperation(toolName: string): boolean {
    return toolName === 'nexus_inject_context' ||
           toolName === 'nexus_get_suggestions';
  }

  /**
   * Check if tool is an admin operation (@adverant.ai users only)
   * Admin tools include K8s cluster control, codebase access, infrastructure, and chat history
   */
  private isAdminOperation(toolName: string): boolean {
    return toolName.startsWith('nexus_k8s_') ||
           toolName.startsWith('nexus_code_') ||
           toolName.startsWith('nexus_infra_') ||
           toolName.startsWith('nexus_chat_');
  }

  /**
   * Check if tool is a stats/system operation
   */
  private isStatsOperation(toolName: string): boolean {
    return toolName === 'nexus_get_stats';
  }

  /**
   * Check if tool is a clear data operation (GraphRAG-only)
   */
  private isClearDataOperation(toolName: string): boolean {
    return toolName === 'nexus_clear_data';
  }

  /**
   * Check if tool is a health check operation (aggregates both services)
   */
  private isHealthCheckOperation(toolName: string): boolean {
    return toolName === 'nexus_health';
  }

  /**
   * Check if tool is URL ingestion operation (Google Drive, etc.)
   */
  private isIngestionOperation(toolName: string): boolean {
    return toolName === 'nexus_ingest_url' ||
           toolName === 'nexus_ingest_url_confirm' ||
           toolName === 'nexus_validate_url' ||
           toolName === 'nexus_check_ingestion_job';
  }

  /**
   * Check if tool is a VideoAgent operation (video processing)
   * VideoAgent tools follow the Job ID pattern: submit → status → result
   */
  private isVideoAgentOperation(toolName: string): boolean {
    return toolName.includes('videoagent');
  }

  /**
   * Check if tool is a FileProcessAgent operation (document processing)
   * FileProcessAgent tools follow the Job ID pattern: submit → status → result
   */
  private isFileProcessAgentOperation(toolName: string): boolean {
    return toolName.includes('fileprocess');
  }

  /**
   * Check if tool requires both services
   */
  private requiresBothServices(toolName: string): boolean {
    // No tools currently require routing to BOTH services simultaneously
    // nexus_health is handled separately by isHealthCheckOperation
    return false;
  }

  /**
   * Route to GraphRAG service with health check and fallback
   */
  private async routeToGraphRAG(toolName: string, _args: any, skipHealthCheck = false): Promise<RouteDecision> {
    const handler = this.getGraphRAGHandler(toolName);

    // Optional health check before routing
    if (!skipHealthCheck) {
      const healthy = await this.checkServiceHealth('graphrag');
      if (!healthy) {
        logger.warn('GraphRAG service unhealthy, routing anyway with warning', { toolName });
      }
    }

    return {
      service: 'graphrag',
      handler: async (args: any) => {
        try {
          return await handler(args);
        } catch (error) {
          const err = error as Error;
          logger.error('GraphRAG handler execution failed', {
            toolName,
            error: err.message,
            stack: err.stack
          });

          throw new RoutingError(
            toolName,
            `GraphRAG service failed: ${err.message}. ` +
            `Check if GraphRAG service is running and accessible. ` +
            `Original error: ${err.stack || 'No stack trace'}`
          );
        }
      },
      description: `Routing to GraphRAG for ${toolName}`,
      requiresHealthCheck: true
    };
  }

  /**
   * Route to MageAgent service with health check and fallback
   */
  private async routeToMageAgent(toolName: string, _args: any, skipHealthCheck = false): Promise<RouteDecision> {
    const handler = this.getMageAgentHandler(toolName);

    // Optional health check before routing
    if (!skipHealthCheck) {
      const healthy = await this.checkServiceHealth('mageagent');
      if (!healthy) {
        logger.warn('MageAgent service unhealthy, routing anyway with warning', { toolName });
      }
    }

    // Capture current context for use in handler
    const capturedContext = this.currentContext;

    return {
      service: 'mageagent',
      handler: async (args: any) => {
        try {
          // Set request context on client for API key tracking headers
          if (capturedContext) {
            mageagentClient.setRequestContext({
              apiKeyId: capturedContext.apiKeyId,
              userId: capturedContext.userId,
              tier: capturedContext.tier
            });
          }

          return await handler(args);
        } catch (error) {
          const err = error as Error;
          logger.error('MageAgent handler execution failed', {
            toolName,
            error: err.message,
            stack: err.stack
          });

          throw new RoutingError(
            toolName,
            `MageAgent service failed: ${err.message}. ` +
            `Tool '${toolName}' was classified as MageAgent operation but execution failed. ` +
            `Check if MageAgent service is running and accessible at ${config.mageagent.endpoints[0]}. ` +
            `Available MageAgent tools: nexus_orchestrate, nexus_agent_competition, nexus_agent_collaborate, ` +
            `nexus_analyze, nexus_synthesize, nexus_memory_search, nexus_store_pattern, nexus_task_status, ` +
            `nexus_list_agents, nexus_agent_details, nexus_websocket_stats, nexus_model_stats, nexus_model_select. ` +
            `Original error: ${err.stack || 'No stack trace'}`
          );
        }
      },
      description: `Routing to MageAgent for ${toolName}`,
      requiresHealthCheck: true
    };
  }

  /**
   * Route to Nexus API Gateway with health check and fallback
   */
  private async routeToAPIGateway(toolName: string, _args: any, skipHealthCheck = false): Promise<RouteDecision> {
    const handler = this.getAPIGatewayHandler(toolName);

    // Optional health check before routing
    if (!skipHealthCheck) {
      const healthy = await this.checkServiceHealth('api_gateway');
      if (!healthy) {
        logger.warn('API Gateway service unhealthy, routing anyway with warning', { toolName });
      }
    }

    return {
      service: 'api_gateway',
      handler: async (args: any) => {
        try {
          return await handler(args);
        } catch (error) {
          const err = error as Error;
          logger.error('API Gateway handler execution failed', {
            toolName,
            error: err.message,
            stack: err.stack
          });

          throw new RoutingError(
            toolName,
            `Nexus API Gateway failed: ${err.message}. ` +
            `Tool '${toolName}' was classified as API Gateway operation (validation, execution-learning, or context). ` +
            `Check if Nexus API Gateway service is running and accessible at ${process.env.NEXUS_API_GATEWAY_URL || 'http://nexus-api-gateway:8092'}. ` +
            `Available API Gateway tools: nexus_sandbox_execute, nexus_trigger_learning, nexus_recall_learned_knowledge, ` +
            `nexus_validate_code, nexus_validate_command, nexus_analyze_code, nexus_validation_result, ` +
            `nexus_inject_context, nexus_get_suggestions. ` +
            `Original error: ${err.stack || 'No stack trace'}`
          );
        }
      },
      description: `Routing to Nexus API Gateway for ${toolName}`,
      requiresHealthCheck: true
    };
  }

  /**
   * Route to VideoAgent service with health check and fallback
   * VideoAgent handles long-running video processing via Job ID pattern
   */
  private async routeToVideoAgent(toolName: string, _args: any, skipHealthCheck = false): Promise<RouteDecision> {
    const handler = this.getVideoAgentHandler(toolName);

    // Optional health check before routing
    if (!skipHealthCheck) {
      const healthy = await this.checkServiceHealth('videoagent');
      if (!healthy) {
        logger.warn('VideoAgent service unhealthy, routing anyway with warning', { toolName });
      }
    }

    return {
      service: 'videoagent',
      handler: async (args: any) => {
        try {
          return await handler(args);
        } catch (error) {
          const err = error as Error;
          logger.error('VideoAgent handler execution failed', {
            toolName,
            error: err.message,
            stack: err.stack
          });

          throw new RoutingError(
            toolName,
            `VideoAgent service failed: ${err.message}. ` +
            `Tool '${toolName}' was classified as VideoAgent operation but execution failed. ` +
            `Check if VideoAgent service is running and accessible at ${config.videoagent?.endpoints?.[0] || 'http://localhost:9095'}. ` +
            `Available VideoAgent tools: nexus_videoagent_submit_job, nexus_videoagent_get_status, ` +
            `nexus_videoagent_get_result, nexus_videoagent_cancel_job, nexus_videoagent_get_queue_stats. ` +
            `Original error: ${err.stack || 'No stack trace'}`
          );
        }
      },
      description: `Routing to VideoAgent for ${toolName}`,
      requiresHealthCheck: true
    };
  }

  /**
   * Route to Admin handlers for @adverant.ai users
   * Admin tools are handled directly by the gateway's admin-tool-handlers service
   * These tools do not require external service health checks
   */
  private async routeToAdmin(toolName: string, _args: any): Promise<RouteDecision> {
    return {
      service: 'admin',
      handler: async (args: any) => {
        // Admin tools are handled by the gateway's admin-tool-handlers
        // The actual handler execution happens in the gateway service
        // This route decision signals that the tool should be handled by admin handlers
        return {
          _adminTool: true,
          toolName,
          args,
          message: 'Admin tool - must be executed by gateway admin-tool-handlers'
        };
      },
      description: `Routing to Admin handlers for ${toolName} (@adverant.ai users only)`,
      requiresHealthCheck: false // Admin tools don't need external health checks
    };
  }

  /**
   * Route to FileProcessAgent service with health check and fallback
   * FileProcessAgent handles document processing via Job ID pattern
   */
  private async routeToFileProcessAgent(toolName: string, _args: any, skipHealthCheck = false): Promise<RouteDecision> {
    const handler = this.getFileProcessAgentHandler(toolName);

    // Optional health check before routing
    if (!skipHealthCheck) {
      const healthy = await this.checkServiceHealth('fileprocess-agent');
      if (!healthy) {
        logger.warn('FileProcessAgent service unhealthy, routing anyway with warning', { toolName });
      }
    }

    return {
      service: 'fileprocess-agent',
      handler: async (args: any) => {
        try {
          return await handler(args);
        } catch (error) {
          const err = error as Error;
          logger.error('FileProcessAgent handler execution failed', {
            toolName,
            error: err.message,
            stack: err.stack
          });

          throw new RoutingError(
            toolName,
            `FileProcessAgent service failed: ${err.message}. ` +
            `Tool '${toolName}' was classified as FileProcessAgent operation but execution failed. ` +
            `Check if FileProcessAgent service is running and accessible at ${config.fileprocess?.endpoints?.[0] || 'http://localhost:9096'}. ` +
            `Available FileProcessAgent tools: nexus_fileprocess_submit_file, nexus_fileprocess_submit_url, ` +
            `nexus_fileprocess_get_status, nexus_fileprocess_get_result, nexus_fileprocess_cancel_job, ` +
            `nexus_fileprocess_list_jobs, nexus_fileprocess_get_queue_stats. ` +
            `Original error: ${err.stack || 'No stack trace'}`
          );
        }
      },
      description: `Routing to FileProcessAgent for ${toolName}`,
      requiresHealthCheck: true
    };
  }

  /**
   * Route to both services
   */
  private async routeToBoth(toolName: string, _args: any): Promise<RouteDecision> {
    return {
      service: 'both',
      handler: async (args: any) => {
        // Execute on both services and combine results
        const [graphragResult, mageagentResult] = await Promise.allSettled([
          this.executeOnGraphRAG(toolName, args),
          this.executeOnMageAgent(toolName, args)
        ]);

        return {
          graphrag: graphragResult.status === 'fulfilled' ? graphragResult.value : { error: (graphragResult as PromiseRejectedResult).reason.message },
          mageagent: mageagentResult.status === 'fulfilled' ? mageagentResult.value : { error: (mageagentResult as PromiseRejectedResult).reason.message }
        };
      },
      description: `Routing to both services for ${toolName}`
    };
  }

  /**
   * Special handler for nexus_health - aggregates health from both services
   */
  private async routeHealthCheck(args: any): Promise<RouteDecision> {
    return {
      service: 'both',
      handler: async (_args: any) => {
        const detailed = args?.detailed !== false;

        // Check health of both services in parallel
        const [graphragHealthy, mageagentHealthy] = await Promise.allSettled([
          this.checkServiceHealth('graphrag'),
          this.checkServiceHealth('mageagent')
        ]);

        const graphragStatus = graphragHealthy.status === 'fulfilled' && graphragHealthy.value;
        const mageagentStatus = mageagentHealthy.status === 'fulfilled' && mageagentHealthy.value;

        const result: any = {
          status: graphragStatus && mageagentStatus ? 'healthy' : 'degraded',
          services: {
            graphrag: {
              status: graphragStatus ? 'healthy' : 'unhealthy',
              endpoint: config.graphrag.endpoints[0]
            },
            mageagent: {
              status: mageagentStatus ? 'healthy' : 'unhealthy',
              endpoint: config.mageagent.endpoints[0]
            }
          },
          timestamp: new Date().toISOString()
        };

        // Add detailed metrics if requested
        if (detailed) {
          result.cache = {
            graphrag: this.healthCheckCache.get('graphrag'),
            mageagent: this.healthCheckCache.get('mageagent')
          };
        }

        return result;
      },
      description: 'Aggregating health status from GraphRAG and MageAgent services',
      requiresHealthCheck: false // Skip health check since this IS the health check
    };
  }

  /**
   * Get GraphRAG handler for tool
   */
  private getGraphRAGHandler(toolName: string): (args: any) => Promise<any> {
    const handlerMap: Record<string, (args: any) => Promise<any>> = {
      'nexus_store_memory': (args) => graphragClient.storeMemory(args.content, args.tags, args.metadata),
      'nexus_recall_memory': (args) => graphragClient.recallMemory(args.query, args.limit, args.score_threshold),
      'nexus_list_memories': (args) => graphragClient.listMemories(args.limit, args.offset),
      'nexus_store_document': (args) => graphragClient.storeDocument(args.content, args.title, args.metadata),
      'nexus_get_document': (args) => graphragClient.getDocument(args.document_id, args.include_chunks),
      'nexus_list_documents': (args) => graphragClient.listDocuments(args.limit, args.offset),
      // REDIRECTED: nexus_ingest_url now routes through FileProcess agent (not GraphRAG)
      // This consolidates URL ingestion to use a single path with UOM decision-making
      // The FileProcess agent handles: Google Drive pre-download, binary detection, CyberAgent routing
      'nexus_ingest_url': async (args) => {
        // Extract filename from URL
        const url = args.url || '';
        let filename = 'document';
        try {
          const urlObj = new URL(url);
          const segments = urlObj.pathname.split('/').filter((s: string) => s.length > 0);
          if (segments.length > 0) {
            filename = decodeURIComponent(segments[segments.length - 1]);
          }
          // Handle Google Drive URLs - extract from query params if present
          if (url.includes('drive.google.com') || url.includes('docs.google.com')) {
            filename = `google-drive-${Date.now()}`;
          }
        } catch {
          filename = `document-${Date.now()}`;
        }

        // Map GraphRAG-style args to FileProcess-style args
        return fileprocessagentClient.submitUrlJob({
          fileUrl: url,
          filename,
          mimeType: args.ingestionOptions?.mimeType,
          userId: args.ingestionOptions?.userId || 'anonymous',
          metadata: {
            ...args.ingestionOptions,
            discoveryOptions: args.discoveryOptions,
            skipConfirmation: args.skipConfirmation,
            source: 'nexus_ingest_url_redirect'
          }
        });
      },
      // REDIRECTED: nexus_ingest_url_confirm now routes through FileProcess agent
      // For bulk file confirmation, we submit each file individually to FileProcess
      'nexus_ingest_url_confirm': async (args) => {
        const files = args.files || [];
        const results = [];
        for (const file of files) {
          try {
            const result = await fileprocessagentClient.submitUrlJob({
              fileUrl: file.url,
              filename: file.filename || 'document',
              mimeType: file.mimeType,
              userId: args.ingestionOptions?.userId || 'anonymous',
              metadata: {
                ...args.ingestionOptions,
                source: 'nexus_ingest_url_confirm_redirect',
                originalFileInfo: file
              }
            });
            results.push({ success: true, file: file.filename, ...result });
          } catch (error) {
            results.push({ success: false, file: file.filename, error: (error as Error).message });
          }
        }
        return {
          success: results.every(r => r.success),
          jobCount: results.length,
          jobs: results,
          message: `Submitted ${results.filter(r => r.success).length}/${results.length} files to FileProcess agent`
        };
      },
      'nexus_validate_url': (args) => graphragClient.validateURL(args.url),
      // REDIRECTED: nexus_check_ingestion_job now checks FileProcess job status
      // Since nexus_ingest_url now uses FileProcess, we check FileProcess job status
      'nexus_check_ingestion_job': (args) => fileprocessagentClient.getJobStatus(args.jobId),
      'nexus_store_episode': (args) => graphragClient.storeEpisode(args.content, args.type, args.metadata),
      'nexus_recall_episodes': (args) => graphragClient.recallEpisodes(args.query, args),
      'nexus_retrieve': (args) => graphragClient.retrieve(args.query, args.strategy, args),
      'nexus_enhanced_retrieve': (args) => graphragClient.enhancedRetrieve(args.query, args),
      'nexus_search': (args) => graphragClient.search(args.query, args),
      'nexus_store_entity': (args) => graphragClient.storeEntity(args),
      'nexus_query_entities': (args) => graphragClient.queryEntities(args),
      'nexus_cross_domain_query': (args) => graphragClient.crossDomainQuery(args.domains, args.query, args.maxResults),
      'nexus_update_entity': (args) => graphragClient.updateEntity(args.entity_id, args),
      'nexus_get_entity': (args) => graphragClient.getEntity(args.entity_id),
      'nexus_get_entity_history': (args) => graphragClient.getEntityHistory(args.entity_id),
      'nexus_get_entity_hierarchy': (args) => graphragClient.getEntityHierarchy(args.entity_id),
      'nexus_get_facts': (args) => graphragClient.getFacts(args.subject),
      'nexus_create_entity_relationship': (args) => graphragClient.createEntityRelationship(args.source_entity_id, args.target_entity_id, args.relationship_type, args.weight),
      'nexus_bulk_create_entities': (args) => graphragClient.bulkCreateEntities(args.entities),
      'nexus_get_stats': (args) => graphragClient.getStats(args.include_health),
      'nexus_clear_data': (args) => graphragClient.clearData(args.type, args.confirm)
    };

    const handler = handlerMap[toolName];
    if (!handler) {
      throw new RoutingError(toolName, 'No GraphRAG handler found');
    }

    return handler;
  }

  /**
   * Get MageAgent handler for tool
   */
  private getMageAgentHandler(toolName: string): (args: any) => Promise<any> {
    const handlerMap: Record<string, (args: any) => Promise<any>> = {
      // Original hidden-async tools (kept for backward compatibility)
      'nexus_orchestrate': (args) => mageagentClient.orchestrate(args),
      'nexus_agent_competition': (args) => mageagentClient.runCompetition(args),
      'nexus_agent_collaborate': (args) => mageagentClient.collaborate(args),
      'nexus_analyze': (args) => mageagentClient.analyze(args),
      'nexus_synthesize': (args) => mageagentClient.synthesize(args),

      // Job ID Pattern Tools (PHASE 2 Refactoring)
      // ORCHESTRATE - 3 tools
      'nexus_orchestrate_submit': (args) => mageagentClient.orchestrateSubmit(args),
      'nexus_orchestrate_status': (args) => mageagentClient.orchestrateStatus(args.jobId),
      'nexus_orchestrate_result': (args) => mageagentClient.orchestrateResult(args.jobId),

      // COMPETITION - 3 tools
      'nexus_agent_competition_submit': (args) => mageagentClient.competitionSubmit(args),
      'nexus_agent_competition_status': (args) => mageagentClient.competitionStatus(args.jobId),
      'nexus_agent_competition_result': (args) => mageagentClient.competitionResult(args.jobId),

      // COLLABORATION - 3 tools
      'nexus_agent_collaborate_submit': (args) => mageagentClient.collaborateSubmit(args),
      'nexus_agent_collaborate_status': (args) => mageagentClient.collaborateStatus(args.jobId),
      'nexus_agent_collaborate_result': (args) => mageagentClient.collaborateResult(args.jobId),

      // ANALYSIS - 3 tools
      'nexus_analyze_submit': (args) => mageagentClient.analyzeSubmit(args),
      'nexus_analyze_status': (args) => mageagentClient.analyzeStatus(args.jobId),
      'nexus_analyze_result': (args) => mageagentClient.analyzeResult(args.jobId),

      // SYNTHESIS - 3 tools
      'nexus_synthesize_submit': (args) => mageagentClient.synthesizeSubmit(args),
      'nexus_synthesize_status': (args) => mageagentClient.synthesizeStatus(args.jobId),
      'nexus_synthesize_result': (args) => mageagentClient.synthesizeResult(args.jobId),

      // Other tools
      'nexus_memory_search': (args) => mageagentClient.searchMemory(args),
      'nexus_store_pattern': (args) => mageagentClient.storePattern(args),
      'nexus_task_status': (args) => mageagentClient.getTaskStatus(args.taskId),
      'nexus_list_agents': () => mageagentClient.listAgents(),
      'nexus_agent_details': (args) => mageagentClient.getAgent(args.agentId),
      'nexus_websocket_stats': () => mageagentClient.getWebSocketStats(),
      'nexus_model_stats': () => mageagentClient.getModelStats(),
      'nexus_model_select': (args) => mageagentClient.selectModel(args)
    };

    const handler = handlerMap[toolName];
    if (!handler) {
      throw new RoutingError(toolName, 'No MageAgent handler found');
    }

    return handler;
  }

  /**
   * Get VideoAgent handler for tool
   */
  private getVideoAgentHandler(toolName: string): (args: any) => Promise<any> {
    const handlerMap: Record<string, (args: any) => Promise<any>> = {
      'nexus_videoagent_submit_job': (args) => videoagentClient.submitJob(args),
      'nexus_videoagent_get_status': (args) => videoagentClient.getJobStatus(args.jobId),
      'nexus_videoagent_get_result': (args) => videoagentClient.getJobResult(args.jobId),
      'nexus_videoagent_cancel_job': (args) => videoagentClient.cancelJob(args.jobId),
      'nexus_videoagent_get_queue_stats': () => videoagentClient.getQueueStats()
    };

    const handler = handlerMap[toolName];
    if (!handler) {
      throw new RoutingError(toolName, 'No VideoAgent handler found');
    }
    return handler;
  }

  /**
   * Get FileProcessAgent handler for tool
   */
  private getFileProcessAgentHandler(toolName: string): (args: any) => Promise<any> {
    const handlerMap: Record<string, (args: any) => Promise<any>> = {
      'nexus_fileprocess_submit_file': (args) => fileprocessagentClient.submitFileJob(args),
      'nexus_fileprocess_submit_url': (args) => fileprocessagentClient.submitUrlJob(args),
      'nexus_fileprocess_get_status': (args) => fileprocessagentClient.getJobStatus(args.jobId),
      'nexus_fileprocess_get_result': (args) => fileprocessagentClient.getJobResult(args.jobId),
      'nexus_fileprocess_cancel_job': (args) => fileprocessagentClient.cancelJob(args.jobId),
      'nexus_fileprocess_list_jobs': (args) => fileprocessagentClient.listJobsByState(args.state, args.start, args.end),
      'nexus_fileprocess_get_queue_stats': () => fileprocessagentClient.getQueueStats()
    };

    const handler = handlerMap[toolName];
    if (!handler) {
      throw new RoutingError(toolName, 'No FileProcessAgent handler found');
    }
    return handler;
  }

  /**
   * Get API Gateway handler for tool
   */
  private getAPIGatewayHandler(toolName: string): (args: any) => Promise<any> {
    const handlerMap: Record<string, (args: any) => Promise<any>> = {
      'nexus_sandbox_execute': (args) => apiGatewayClient.executionLearningRun({
        code: args.code,
        language: args.language,
        context: args.context,
        trigger_learning: args.trigger_learning,
        timeout: args.timeout
      }),
      'nexus_trigger_learning': (args) => apiGatewayClient.triggerLearning({
        topic: args.topic,
        trigger: args.trigger || 'manual',
        priority: args.priority,
        context: args.context
      }),
      'nexus_recall_learned_knowledge': (args) => apiGatewayClient.recallLearnedKnowledge({
        topic: args.topic,
        context: args.context,
        limit: args.limit
      }),
      // Phase 3: Validation tools
      'nexus_validate_code': (args) => apiGatewayClient.validateCode({
        code: args.code,
        language: args.language,
        context: args.context,
        riskLevel: args.riskLevel
      }),
      'nexus_validate_command': (args) => apiGatewayClient.validateCommand({
        command: args.command,
        cwd: args.cwd,
        environment: args.environment
      }),
      'nexus_analyze_code': (args) => apiGatewayClient.analyzeCode({
        code: args.code,
        language: args.language,
        focusAreas: args.focusAreas,
        depth: args.depth
      }),
      'nexus_validation_result': (args) => apiGatewayClient.getValidationResult(args.validationId),

      // Phase 4: Context injection tools
      'nexus_inject_context': (args) => apiGatewayClient.injectContext({
        toolName: args.toolName,
        toolArgs: args.toolArgs,
        sessionId: args.sessionId
      }),
      'nexus_get_suggestions': (args) => apiGatewayClient.getSuggestions(args.contextId)
    };

    const handler = handlerMap[toolName];
    if (!handler) {
      throw new RoutingError(toolName, 'No API Gateway handler found');
    }

    return handler;
  }

  /**
   * Execute on GraphRAG (for combined operations)
   */
  private async executeOnGraphRAG(toolName: string, args: any): Promise<any> {
    // Special handling for health check
    if (toolName === 'nexus_health') {
      return graphragClient.checkHealth();
    }

    const handler = this.getGraphRAGHandler(toolName);
    return handler(args);
  }

  /**
   * Execute on MageAgent (for combined operations)
   */
  private async executeOnMageAgent(toolName: string, args: any): Promise<any> {
    // Special handling for health check
    if (toolName === 'nexus_health') {
      return mageagentClient.checkHealth();
    }

    const handler = this.getMageAgentHandler(toolName);
    return handler(args);
  }
}

// Export singleton instance
export const smartRouter = new SmartRouter();

/**
 * All 50 Nexus MCP Tools that should be supported
 */
const ALL_NEXUS_TOOLS = [
  // Memory Operations (3)
  'nexus_store_memory',
  'nexus_recall_memory',
  'nexus_list_memories',

  // Document Operations (3)
  'nexus_store_document',
  'nexus_get_document',
  'nexus_list_documents',

  // URL Ingestion Operations (4)
  'nexus_ingest_url',
  'nexus_ingest_url_confirm',
  'nexus_validate_url',
  'nexus_check_ingestion_job',

  // Episode Operations (2)
  'nexus_store_episode',
  'nexus_recall_episodes',

  // Retrieval Operations (3)
  'nexus_retrieve',
  'nexus_enhanced_retrieve',
  'nexus_search',

  // Universal Entity System (3)
  'nexus_store_entity',
  'nexus_query_entities',
  'nexus_cross_domain_query',

  // Statistics & Health (2)
  'nexus_get_stats',
  'nexus_clear_data',

  // Agent Orchestration (3)
  'nexus_orchestrate',
  'nexus_agent_competition',
  'nexus_agent_collaborate',

  // Analysis & Synthesis (2)
  'nexus_analyze',
  'nexus_synthesize',

  // Agent Memory & Patterns (2)
  'nexus_memory_search',
  'nexus_store_pattern',

  // Task & Agent Management (3)
  'nexus_task_status',
  'nexus_list_agents',
  'nexus_agent_details',

  // System Health & Monitoring (4)
  'nexus_health',
  'nexus_websocket_stats',
  'nexus_model_stats',
  'nexus_model_select',

  // Graphiti Entity Operations (3)
  'nexus_get_entity',
  'nexus_get_entity_history',
  'nexus_get_facts',

  // Entity Relationship Operations (4)
  'nexus_update_entity',
  'nexus_get_entity_hierarchy',
  'nexus_create_entity_relationship',
  'nexus_bulk_create_entities',

  // Execution-Learning Operations (3)
  'nexus_sandbox_execute',
  'nexus_trigger_learning',
  'nexus_recall_learned_knowledge',

  // Code Validation Operations - Phase 3 (4)
  'nexus_validate_code',
  'nexus_validate_command',
  'nexus_analyze_code',
  'nexus_validation_result',

  // Context Injection Operations - Phase 4 (2)
  'nexus_inject_context',
  'nexus_get_suggestions'
];

/**
 * Validate router configuration at startup
 * Ensures all 50 tools can be routed
 */
export async function validateRouterConfiguration(): Promise<{ valid: boolean; errors: string[] }> {
  const errors: string[] = [];

  logger.info('🔍 Validating router configuration for all 50 Nexus MCP tools...');

  for (const toolName of ALL_NEXUS_TOOLS) {
    try {
      // Try to route each tool with dummy args (skip health checks for faster validation)
      const routeDecision = await smartRouter.route(toolName, {}, true);

      // Verify handler exists
      if (!routeDecision.handler) {
        const errorMsg = `✗ ${toolName} - No handler found (service: ${routeDecision.service})`;
        errors.push(errorMsg);
        logger.error(errorMsg);
      } else {
        logger.debug(`✓ ${toolName} - routing validated (service: ${routeDecision.service})`);
      }
    } catch (error: any) {
      const errorMsg = `✗ ${toolName} - Routing failed: ${error.message}`;
      errors.push(errorMsg);
      logger.error(errorMsg);
    }
  }

  const valid = errors.length === 0;

  if (valid) {
    logger.info(`✅ Router validation PASSED - All ${ALL_NEXUS_TOOLS.length} tools properly configured`);
  } else {
    logger.error(`❌ Router validation FAILED - ${errors.length}/${ALL_NEXUS_TOOLS.length} tools have routing errors`);
    errors.forEach(err => logger.error(`  ${err}`));
  }

  return { valid, errors };
}
