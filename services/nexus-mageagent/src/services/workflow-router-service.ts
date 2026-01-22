/**
 * WorkflowRouterService - Multi-service workflow orchestration
 *
 * Design Pattern: Coordinator + Strategy Pattern
 * SOLID Principles:
 * - Single Responsibility: Coordinates workflow execution across services
 * - Open/Closed: Extensible for new services without modification
 * - Dependency Inversion: Depends on client interfaces, not implementations
 *
 * Provides:
 * - Natural language request parsing using LLM
 * - Workflow plan generation with dependency resolution
 * - Parallel execution of independent steps
 * - Multi-service coordination (FileProcess, CyberAgent, Sandbox, MageAgent)
 * - Comprehensive result aggregation
 */

import { v4 as uuidv4 } from 'uuid';
import { OpenRouterClient } from '../clients/openrouter-client';
import { CyberAgentClient, getCyberAgentClient, ScanResult } from '../clients/cyberagent-client';
import { FileProcessClient, getFileProcessClient, FileProcessingResult } from '../clients/fileprocess-client';
import { SandboxClient, getSandboxClient, SandboxExecutionResult } from '../clients/sandbox-client';
import { GraphRAGClient } from '../clients/graphrag-client';
import {
  WorkflowStep,
  WorkflowStepStatus,
  WorkflowStepResult,
  WorkflowStepError,
  WorkflowPlan,
  WorkflowResult,
  WorkflowParseRequest,
  WorkflowParseResponse,
  WorkflowProgressEvent,
  WorkflowServiceType,
  OPERATION_SERVICE_MAP,
  getDefaultTimeout,
} from '../types/workflow.types';

// ============================================================================
// Types
// ============================================================================

/**
 * Configuration for WorkflowRouterService
 */
export interface WorkflowRouterConfig {
  openRouterClient: OpenRouterClient;
  cyberAgentClient?: CyberAgentClient;
  fileProcessClient?: FileProcessClient;
  sandboxClient?: SandboxClient;
  graphRAGClient?: GraphRAGClient;
  defaultModel?: string;
  maxConcurrentSteps?: number;
}

/**
 * Internal step result during execution
 */
interface StepExecutionResult {
  success: boolean;
  data: unknown;
  error?: WorkflowStepError;
  durationMs: number;
}

// ============================================================================
// WorkflowRouterService
// ============================================================================

export class WorkflowRouterService {
  private openRouterClient: OpenRouterClient;
  private cyberAgentClient: CyberAgentClient;
  private fileProcessClient: FileProcessClient;
  private sandboxClient: SandboxClient;
  private graphRAGClient?: GraphRAGClient;

  private readonly defaultModel: string;
  private readonly maxConcurrentSteps: number;
  private readonly eventEmitter?: (event: WorkflowProgressEvent) => void;

  constructor(
    config: WorkflowRouterConfig,
    eventEmitter?: (event: WorkflowProgressEvent) => void
  ) {
    this.openRouterClient = config.openRouterClient;
    this.cyberAgentClient = config.cyberAgentClient || getCyberAgentClient();
    this.fileProcessClient = config.fileProcessClient || getFileProcessClient();
    this.sandboxClient = config.sandboxClient || getSandboxClient();
    this.graphRAGClient = config.graphRAGClient;

    this.defaultModel = config.defaultModel || 'anthropic/claude-3-haiku-20240307';
    this.maxConcurrentSteps = config.maxConcurrentSteps || 5;
    this.eventEmitter = eventEmitter;

    console.log('[WorkflowRouterService] Initialized', {
      defaultModel: this.defaultModel,
      maxConcurrentSteps: this.maxConcurrentSteps,
    });
  }

  /**
   * Parse natural language request into executable workflow plan
   */
  async parseRequest(request: WorkflowParseRequest): Promise<WorkflowParseResponse> {
    const correlationId = `wf-${Date.now()}-${uuidv4().slice(0, 8)}`;

    console.log('[WorkflowRouterService] Parsing request', {
      correlationId,
      requestLength: request.request.length,
    });

    const prompt = this.buildParsingPrompt(request.request);

    const completion = await this.openRouterClient.createCompletion({
      model: this.defaultModel,
      messages: [
        {
          role: 'system',
          content: this.getSystemPrompt(),
        },
        {
          role: 'user',
          content: prompt,
        },
      ],
      temperature: 0.1, // Low temperature for consistent parsing
      response_format: { type: 'json_object' },
    });

    const parsed = this.parseWorkflowResponse(
      completion.choices[0]?.message?.content || '{}'
    );

    const plan: WorkflowPlan = {
      id: uuidv4(),
      correlationId,
      originalRequest: request.request,
      steps: parsed.steps.map((step, index) => ({
        ...step,
        id: step.id || `step-${index + 1}`,
        status: 'pending' as WorkflowStepStatus,
        timeout: step.timeout || getDefaultTimeout(step.service),
      })),
      parallelGroups: this.computeParallelGroups(parsed.steps),
      status: 'planning',
      mode: request.options?.mode || 'best-effort',
      priority: request.options?.priority || 'normal',
      timeout: request.options?.timeout || this.computeWorkflowTimeout(parsed.steps),
      createdAt: new Date(),
      tenantContext: request.context?.metadata as any,
    };

    // Estimate duration
    const estimatedDurationMs = this.estimateDuration(plan);

    // Identify involved services
    const involvedServices = [...new Set(plan.steps.map(s => s.service))];

    // Determine confidence
    const confidence = parsed.confidence || this.calculateConfidence(plan);

    console.log('[WorkflowRouterService] Plan created', {
      correlationId,
      stepCount: plan.steps.length,
      parallelGroups: plan.parallelGroups.length,
      estimatedDurationMs,
      involvedServices,
      confidence,
    });

    return {
      plan,
      confidence,
      clarifications: parsed.clarifications,
      estimatedDurationMs,
      involvedServices,
    };
  }

  /**
   * Execute a workflow plan
   */
  async executeWorkflow(plan: WorkflowPlan): Promise<WorkflowResult> {
    const startTime = Date.now();
    plan.status = 'executing';
    plan.startedAt = new Date();

    console.log('[WorkflowRouterService] Executing workflow', {
      workflowId: plan.id,
      correlationId: plan.correlationId,
      stepCount: plan.steps.length,
      mode: plan.mode,
    });

    const results = new Map<string, WorkflowStepResult>();
    const failedSteps: WorkflowResult['failedSteps'] = [];
    const artifacts: WorkflowResult['artifacts'] = [];
    const pending = new Set(plan.steps.map(s => s.id));

    let successCount = 0;
    let failedCount = 0;
    let skippedCount = 0;

    // Execute steps respecting dependencies
    while (pending.size > 0) {
      // Find steps ready to execute (all dependencies satisfied)
      const readySteps = plan.steps.filter(step =>
        pending.has(step.id) &&
        (step.dependsOn || []).every(dep => results.has(dep))
      );

      if (readySteps.length === 0 && pending.size > 0) {
        // Deadlock or missing dependencies
        console.error('[WorkflowRouterService] Workflow deadlock detected', {
          pending: Array.from(pending),
          completed: Array.from(results.keys()),
        });
        break;
      }

      // Check for failed dependencies in strict mode
      if (plan.mode === 'strict') {
        const blockedSteps = readySteps.filter(step =>
          (step.dependsOn || []).some(dep => {
            const depResult = results.get(dep);
            return depResult && !depResult.success;
          })
        );

        for (const blockedStep of blockedSteps) {
          pending.delete(blockedStep.id);
          blockedStep.status = 'skipped';
          skippedCount++;

          results.set(blockedStep.id, {
            success: false,
            data: null,
            metrics: { durationMs: 0 },
          });
        }
      }

      // Execute ready steps (limit concurrency)
      const stepsToExecute = readySteps
        .filter(s => s.status !== 'skipped')
        .slice(0, this.maxConcurrentSteps);

      if (stepsToExecute.length === 0) continue;

      // Emit progress
      this.emitProgress({
        type: 'step_started',
        timestamp: new Date(),
        workflowId: plan.id,
        progress: Math.round(((plan.steps.length - pending.size) / plan.steps.length) * 100),
        message: `Executing ${stepsToExecute.length} step(s): ${stepsToExecute.map(s => s.name).join(', ')}`,
      });

      // Execute in parallel
      const execResults = await Promise.allSettled(
        stepsToExecute.map(step => this.executeStep(step, results))
      );

      // Process results
      for (let i = 0; i < stepsToExecute.length; i++) {
        const step = stepsToExecute[i];
        const execResult = execResults[i];

        pending.delete(step.id);
        step.completedAt = new Date();

        if (execResult.status === 'fulfilled') {
          const result = execResult.value;

          if (result.success) {
            step.status = 'completed';
            successCount++;

            results.set(step.id, {
              success: true,
              data: result.data,
              metrics: { durationMs: result.durationMs },
            });

            // Collect artifacts
            if (Array.isArray((result.data as any)?.artifacts)) {
              artifacts.push(...(result.data as any).artifacts.map((a: any) => ({
                ...a,
                sourceStepId: step.id,
              })));
            }

            this.emitProgress({
              type: 'step_completed',
              timestamp: new Date(),
              workflowId: plan.id,
              stepId: step.id,
              progress: Math.round(((plan.steps.length - pending.size) / plan.steps.length) * 100),
              message: `Step "${step.name}" completed successfully`,
              data: { durationMs: result.durationMs },
            });
          } else {
            step.status = 'failed';
            step.error = result.error;
            failedCount++;

            results.set(step.id, {
              success: false,
              data: null,
              metrics: { durationMs: result.durationMs },
            });

            failedSteps.push({
              stepId: step.id,
              stepName: step.name,
              error: result.error!,
              impact: this.assessImpact(step, plan),
            });

            this.emitProgress({
              type: 'step_failed',
              timestamp: new Date(),
              workflowId: plan.id,
              stepId: step.id,
              progress: Math.round(((plan.steps.length - pending.size) / plan.steps.length) * 100),
              message: `Step "${step.name}" failed: ${result.error?.message}`,
              data: { error: result.error },
            });
          }
        } else {
          // Promise rejected - unexpected error
          step.status = 'failed';
          failedCount++;

          const error: WorkflowStepError = {
            code: 'STEP_EXCEPTION',
            message: execResult.reason?.message || 'Unexpected error',
            recoverable: false,
          };

          step.error = error;

          results.set(step.id, {
            success: false,
            data: null,
            metrics: { durationMs: 0 },
          });

          failedSteps.push({
            stepId: step.id,
            stepName: step.name,
            error,
            impact: this.assessImpact(step, plan),
          });
        }
      }

      // Check for workflow timeout
      if (Date.now() - startTime > plan.timeout) {
        console.warn('[WorkflowRouterService] Workflow timeout', {
          workflowId: plan.id,
          elapsed: Date.now() - startTime,
          timeout: plan.timeout,
        });
        break;
      }
    }

    // Finalize workflow
    plan.completedAt = new Date();
    const totalDurationMs = Date.now() - startTime;

    // Determine final status
    let status: WorkflowResult['status'];
    if (failedCount === 0 && skippedCount === 0) {
      status = 'completed';
      plan.status = 'completed';
    } else if (successCount === 0) {
      status = 'failed';
      plan.status = 'failed';
    } else {
      status = 'degraded';
      plan.status = 'degraded';
    }

    // Generate summary
    const summary = this.generateSummary(plan, results, failedSteps);

    // Calculate parallelization efficiency
    const sequentialTime = plan.steps.reduce(
      (sum, s) => sum + (results.get(s.id)?.metrics?.durationMs || 0),
      0
    );
    const parallelizationEfficiency = sequentialTime > 0
      ? Math.min(1, sequentialTime / totalDurationMs)
      : 1;

    const result: WorkflowResult = {
      success: status === 'completed',
      status,
      summary,
      stepResults: results,
      failedSteps,
      artifacts,
      metrics: {
        totalDurationMs,
        stepCount: plan.steps.length,
        successCount,
        failedCount,
        skippedCount,
        parallelizationEfficiency,
      },
      suggestions: failedSteps.length > 0 ? this.generateSuggestions(failedSteps) : undefined,
    };

    this.emitProgress({
      type: 'workflow_completed',
      timestamp: new Date(),
      workflowId: plan.id,
      progress: 100,
      message: summary,
      data: { metrics: result.metrics },
    });

    console.log('[WorkflowRouterService] Workflow completed', {
      workflowId: plan.id,
      status,
      totalDurationMs,
      successCount,
      failedCount,
      skippedCount,
    });

    return result;
  }

  /**
   * Execute a single workflow step
   */
  private async executeStep(
    step: WorkflowStep,
    priorResults: Map<string, WorkflowStepResult>
  ): Promise<StepExecutionResult> {
    const startTime = Date.now();
    step.status = 'running';
    step.startedAt = new Date();

    console.log('[WorkflowRouterService] Executing step', {
      stepId: step.id,
      stepName: step.name,
      service: step.service,
      operation: step.operation,
    });

    // Resolve input references from prior results
    const resolvedInput = this.resolveInputReferences(step.input, priorResults);

    try {
      let data: unknown;

      switch (step.service) {
        case 'fileprocess':
          data = await this.executeFileProcessStep(step.operation, resolvedInput);
          break;

        case 'cyberagent':
          data = await this.executeCyberAgentStep(step.operation, resolvedInput);
          break;

        case 'sandbox':
          data = await this.executeSandboxStep(step.operation, resolvedInput);
          break;

        case 'mageagent':
          data = await this.executeMageAgentStep(step.operation, resolvedInput);
          break;

        case 'graphrag':
          data = await this.executeGraphRAGStep(step.operation, resolvedInput);
          break;

        default:
          throw new Error(`Unknown service: ${step.service}`);
      }

      return {
        success: true,
        data,
        durationMs: Date.now() - startTime,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);

      console.error('[WorkflowRouterService] Step execution failed', {
        stepId: step.id,
        service: step.service,
        operation: step.operation,
        error: errorMessage,
      });

      return {
        success: false,
        data: null,
        error: {
          code: `${step.service.toUpperCase()}_ERROR`,
          message: errorMessage,
          recoverable: this.isRecoverableError(error),
          suggestedAction: this.getSuggestedAction(step.service, error),
        },
        durationMs: Date.now() - startTime,
      };
    }
  }

  // ============================================================================
  // Service-Specific Execution Methods
  // ============================================================================

  private async executeFileProcessStep(
    operation: string,
    input: Record<string, unknown>
  ): Promise<FileProcessingResult | unknown> {
    switch (operation) {
      case 'file_download':
      case 'process_url':
        return this.fileProcessClient.downloadAndProcess(
          input.url as string,
          {
            filename: input.filename as string | undefined,
            mimeType: input.mimeType as string | undefined,
            enableOcr: input.enableOcr as boolean | undefined,
            extractTables: input.extractTables as boolean | undefined,
          }
        );

      case 'extract_content':
        return this.fileProcessClient.extractContent(
          input.url as string,
          {
            includeOcr: input.includeOcr as boolean | undefined,
            includeTables: input.includeTables as boolean | undefined,
          }
        );

      case 'process_drive':
        return this.fileProcessClient.processDriveUrl({
          driveUrl: input.driveUrl as string,
          options: {
            enableOcr: input.enableOcr as boolean | undefined,
            extractTables: input.extractTables as boolean | undefined,
          },
        });

      default:
        throw new Error(`Unknown FileProcess operation: ${operation}`);
    }
  }

  private async executeCyberAgentStep(
    operation: string,
    input: Record<string, unknown>
  ): Promise<ScanResult | unknown> {
    switch (operation) {
      case 'malware_scan':
      case 'virus_check':
        return this.cyberAgentClient.malwareScan(
          input.target as string,
          {
            tools: input.tools as any,
            sandboxTier: input.sandboxTier as any,
            deepScan: input.deepScan as boolean | undefined,
            timeout: input.timeout as number | undefined,
          }
        );

      case 'vulnerability_scan':
        return this.cyberAgentClient.vulnerabilityScan(
          input.target as string,
          {
            tools: input.tools as any,
            timeout: input.timeout as number | undefined,
          }
        );

      case 'threat_check':
        return this.cyberAgentClient.threatCheck(
          input.content as string,
          {
            filename: input.filename as string | undefined,
            deepAnalysis: input.deepAnalysis as boolean | undefined,
          }
        );

      default:
        throw new Error(`Unknown CyberAgent operation: ${operation}`);
    }
  }

  private async executeSandboxStep(
    operation: string,
    input: Record<string, unknown>
  ): Promise<SandboxExecutionResult | unknown> {
    switch (operation) {
      case 'code_execute':
      case 'script_run':
        return this.sandboxClient.execute({
          code: input.code as string,
          language: input.language as any,
          packages: input.packages as string[] | undefined,
          files: input.files as any,
          timeout: input.timeout as number | undefined,
          resourceLimits: input.resourceLimits as any,
        });

      case 'file_analyze':
        return this.sandboxClient.analyzeFile(
          input.filename as string,
          input.content as string,
          {
            analysisType: input.analysisType as any,
            timeout: input.timeout as number | undefined,
          }
        );

      case 'python_execute':
        return this.sandboxClient.executePython(
          input.code as string,
          {
            packages: input.packages as string[] | undefined,
            timeout: input.timeout as number | undefined,
          }
        );

      default:
        throw new Error(`Unknown Sandbox operation: ${operation}`);
    }
  }

  private async executeMageAgentStep(
    operation: string,
    input: Record<string, unknown>
  ): Promise<unknown> {
    // MageAgent operations are handled via LLM calls
    switch (operation) {
      case 'ai_analysis':
      case 'pii_detection':
      case 'summarization':
        return this.performLLMAnalysis(operation, input);

      default:
        throw new Error(`Unknown MageAgent operation: ${operation}`);
    }
  }

  private async executeGraphRAGStep(
    operation: string,
    input: Record<string, unknown>
  ): Promise<unknown> {
    if (!this.graphRAGClient) {
      throw new Error('GraphRAG client not configured');
    }

    switch (operation) {
      case 'knowledge_store':
        return this.graphRAGClient.storeMemory({
          content: input.content as string,
          tags: input.tags as string[] | undefined,
          metadata: input.metadata as any,
        });

      case 'knowledge_recall':
        return this.graphRAGClient.recallMemory({
          query: input.query as string,
          limit: input.limit as number | undefined,
          score_threshold: input.scoreThreshold as number | undefined,
        });

      default:
        throw new Error(`Unknown GraphRAG operation: ${operation}`);
    }
  }

  private async performLLMAnalysis(
    operation: string,
    input: Record<string, unknown>
  ): Promise<unknown> {
    const content = input.content as string || input.text as string || '';

    let systemPrompt: string;
    switch (operation) {
      case 'ai_analysis':
        systemPrompt = 'You are an expert analyst. Analyze the provided content and provide insights.';
        break;
      case 'pii_detection':
        systemPrompt = 'You are a PII detection expert. Identify all personally identifiable information in the content. Return JSON with: { "pii_found": boolean, "items": [{ "type": string, "value": string, "location": string }] }';
        break;
      case 'summarization':
        systemPrompt = 'You are a summarization expert. Provide a concise summary of the content.';
        break;
      default:
        systemPrompt = 'Analyze the content.';
    }

    const completion = await this.openRouterClient.createCompletion({
      model: this.defaultModel,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: `Content to analyze:\n\n${content}` },
      ],
      temperature: 0.3,
    });

    return {
      operation,
      result: completion.choices[0]?.message?.content,
      model: completion.model,
      usage: completion.usage,
    };
  }

  // ============================================================================
  // Helper Methods
  // ============================================================================

  private getSystemPrompt(): string {
    return `You are a workflow planning assistant for the Nexus platform.

Your task is to parse natural language requests and decompose them into executable workflow steps.

Available services and their operations:

1. **fileprocess** - Document and file processing
   - file_download: Download file from URL
   - process_url: Process file from URL (PDF, Office, images, archives)
   - extract_content: Extract text content from documents
   - process_drive: Process files from Google Drive

2. **cyberagent** - Security scanning
   - malware_scan: Scan for malware and threats
   - virus_check: Check for viruses
   - vulnerability_scan: Scan for vulnerabilities
   - threat_check: Analyze content for threats

3. **sandbox** - Code execution
   - code_execute: Execute code in isolated environment
   - script_run: Run scripts
   - file_analyze: Analyze files using code

4. **mageagent** - AI analysis
   - ai_analysis: General AI analysis
   - pii_detection: Detect personally identifiable information
   - summarization: Summarize content

5. **graphrag** - Knowledge management
   - knowledge_store: Store information in knowledge graph
   - knowledge_recall: Retrieve relevant knowledge

When creating workflow steps:
- Use unique step IDs (step-1, step-2, etc.)
- Specify dependencies with "dependsOn" array
- Include all required input parameters
- Use \${ref:step-id.field} syntax to reference outputs from prior steps

Output JSON format:
{
  "steps": [
    {
      "id": "step-1",
      "name": "Human-readable name",
      "service": "service_name",
      "operation": "operation_name",
      "input": { ... },
      "dependsOn": []
    }
  ],
  "confidence": 0.0-1.0,
  "clarifications": [] // Questions if request is ambiguous
}`;
  }

  private buildParsingPrompt(request: string): string {
    return `Parse this request into a workflow plan:

"${request}"

Create the optimal sequence of steps with proper dependencies. If steps can run in parallel, don't add unnecessary dependencies.

Return JSON with the workflow plan.`;
  }

  private parseWorkflowResponse(response: string): {
    steps: WorkflowStep[];
    confidence?: number;
    clarifications?: string[];
  } {
    try {
      const parsed = JSON.parse(response);
      return {
        steps: parsed.steps || [],
        confidence: parsed.confidence,
        clarifications: parsed.clarifications,
      };
    } catch (error) {
      console.error('[WorkflowRouterService] Failed to parse LLM response', {
        response: response.substring(0, 500),
        error,
      });
      return { steps: [] };
    }
  }

  private computeParallelGroups(steps: WorkflowStep[]): string[][] {
    // Topological sort with level assignment
    const levels = new Map<string, number>();
    const stepMap = new Map(steps.map(s => [s.id, s]));

    const computeLevel = (stepId: string, visited: Set<string>): number => {
      if (levels.has(stepId)) return levels.get(stepId)!;
      if (visited.has(stepId)) return 0; // Cycle detected

      visited.add(stepId);
      const step = stepMap.get(stepId);
      if (!step || !step.dependsOn || step.dependsOn.length === 0) {
        levels.set(stepId, 0);
        return 0;
      }

      const maxDepLevel = Math.max(
        ...step.dependsOn.map(dep => computeLevel(dep, visited))
      );
      const level = maxDepLevel + 1;
      levels.set(stepId, level);
      return level;
    };

    for (const step of steps) {
      computeLevel(step.id, new Set());
    }

    // Group by level
    const groups = new Map<number, string[]>();
    for (const step of steps) {
      const level = levels.get(step.id) || 0;
      if (!groups.has(level)) groups.set(level, []);
      groups.get(level)!.push(step.id);
    }

    // Sort by level and return
    return Array.from(groups.entries())
      .sort((a, b) => a[0] - b[0])
      .map(([_, ids]) => ids);
  }

  private computeWorkflowTimeout(steps: WorkflowStep[]): number {
    // Sum of all step timeouts (conservative estimate)
    return steps.reduce(
      (sum, step) => sum + (step.timeout || getDefaultTimeout(step.service)),
      0
    );
  }

  private estimateDuration(plan: WorkflowPlan): number {
    // Sum timeouts of critical path (longest chain)
    let maxChainDuration = 0;

    for (const group of plan.parallelGroups) {
      const groupDuration = Math.max(
        ...group.map(stepId => {
          const step = plan.steps.find(s => s.id === stepId);
          return step?.timeout || 60000;
        })
      );
      maxChainDuration += groupDuration;
    }

    return maxChainDuration;
  }

  private calculateConfidence(plan: WorkflowPlan): number {
    if (plan.steps.length === 0) return 0;

    // Base confidence on recognized operations
    const recognizedOps = plan.steps.filter(
      s => OPERATION_SERVICE_MAP[s.operation]
    ).length;

    return recognizedOps / plan.steps.length;
  }

  private resolveInputReferences(
    input: Record<string, unknown>,
    priorResults: Map<string, WorkflowStepResult>
  ): Record<string, unknown> {
    const resolved: Record<string, unknown> = {};

    for (const [key, value] of Object.entries(input)) {
      if (typeof value === 'string' && value.startsWith('${ref:')) {
        // Parse reference: ${ref:step-id.field}
        const match = value.match(/^\$\{ref:([^.]+)\.(.+)\}$/);
        if (match) {
          const [, stepId, field] = match;
          const stepResult = priorResults.get(stepId);
          if (stepResult?.success && stepResult.data) {
            resolved[key] = (stepResult.data as any)[field];
          } else {
            resolved[key] = value; // Keep original if not found
          }
        } else {
          resolved[key] = value;
        }
      } else if (typeof value === 'object' && value !== null) {
        resolved[key] = this.resolveInputReferences(
          value as Record<string, unknown>,
          priorResults
        );
      } else {
        resolved[key] = value;
      }
    }

    return resolved;
  }

  private isRecoverableError(error: unknown): boolean {
    if (error instanceof Error) {
      const message = error.message.toLowerCase();
      return (
        message.includes('timeout') ||
        message.includes('network') ||
        message.includes('temporarily unavailable') ||
        message.includes('circuit breaker')
      );
    }
    return false;
  }

  private getSuggestedAction(service: WorkflowServiceType, error: unknown): string {
    const message = error instanceof Error ? error.message.toLowerCase() : '';

    if (message.includes('timeout')) {
      return 'Consider increasing the timeout or breaking into smaller tasks';
    }
    if (message.includes('circuit breaker')) {
      return `${service} service is experiencing issues. Retry later.`;
    }
    if (message.includes('not found')) {
      return 'Verify the input parameters are correct';
    }

    return 'Review the error details and retry';
  }

  private assessImpact(step: WorkflowStep, plan: WorkflowPlan): string {
    // Find dependent steps
    const dependents = plan.steps.filter(
      s => s.dependsOn?.includes(step.id)
    );

    if (dependents.length === 0) {
      return 'No downstream impact - isolated step';
    }

    return `Blocks ${dependents.length} dependent step(s): ${dependents.map(d => d.name).join(', ')}`;
  }

  private generateSummary(
    plan: WorkflowPlan,
    results: Map<string, WorkflowStepResult>,
    failedSteps: WorkflowResult['failedSteps']
  ): string {
    const successCount = Array.from(results.values()).filter(r => r.success).length;
    const totalCount = plan.steps.length;

    if (failedSteps.length === 0) {
      return `Workflow completed successfully. All ${totalCount} steps executed.`;
    }

    if (successCount === 0) {
      return `Workflow failed. All ${totalCount} steps failed.`;
    }

    return `Workflow completed with partial success. ${successCount}/${totalCount} steps succeeded. Failed: ${failedSteps.map(f => f.stepName).join(', ')}`;
  }

  private generateSuggestions(
    failedSteps: WorkflowResult['failedSteps']
  ): string[] {
    const suggestions: string[] = [];

    for (const failed of failedSteps) {
      if (failed.error.recoverable) {
        suggestions.push(`Retry step "${failed.stepName}" - error may be transient`);
      }
      if (failed.error.suggestedAction) {
        suggestions.push(failed.error.suggestedAction);
      }
    }

    if (suggestions.length === 0) {
      suggestions.push('Review error details and consider adjusting workflow parameters');
    }

    return [...new Set(suggestions)]; // Deduplicate
  }

  private emitProgress(event: WorkflowProgressEvent): void {
    if (this.eventEmitter) {
      this.eventEmitter(event);
    }
  }
}

// ============================================================================
// Factory
// ============================================================================

let workflowRouterInstance: WorkflowRouterService | null = null;

export function getWorkflowRouterService(
  openRouterClient: OpenRouterClient,
  graphRAGClient?: GraphRAGClient
): WorkflowRouterService {
  if (!workflowRouterInstance) {
    workflowRouterInstance = new WorkflowRouterService({
      openRouterClient,
      graphRAGClient,
    });
  }
  return workflowRouterInstance;
}

export function resetWorkflowRouterService(): void {
  workflowRouterInstance = null;
}
