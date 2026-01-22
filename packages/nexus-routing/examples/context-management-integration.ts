/**
 * Context Management Integration Example
 *
 * Demonstrates how to integrate all 4 phases of context management
 * into a Claude Code or Nexus API Gateway application.
 */

import {
  graphragClientV2,
  createContextManager,
  createConversationHooks,
  createContextInjector,
  getContextMonitor
} from '../src/index.js';

// ============================================================================
// FULL INTEGRATION EXAMPLE
// ============================================================================

export class NexusContextSystem {
  private contextManager;
  private conversationHooks;
  private contextInjector;
  private contextMonitor;

  constructor(sessionId?: string) {
    // Initialize all components
    this.contextManager = createContextManager(graphragClientV2, sessionId);
    this.conversationHooks = createConversationHooks(graphragClientV2, sessionId);
    this.contextInjector = createContextInjector(graphragClientV2);
    this.contextMonitor = getContextMonitor();

    console.log('✅ Nexus Context System initialized');
  }

  // ==========================================================================
  // PHASE 1: SESSION CHECKPOINTS
  // ==========================================================================

  async createCheckpoint(options: { currentTask?: string; gitStatus?: string }): Promise<string> {
    const checkpointId = await this.contextManager.storeCheckpoint({
      sessionId: this.conversationHooks.getContextManager().getContext().sessionId,
      ...options
    });

    this.contextMonitor.recordStorage('checkpoint', true);

    console.log(`✅ Checkpoint created: ${checkpointId}`);
    return checkpointId;
  }

  async loadCheckpoint(sessionId?: string): Promise<any> {
    const checkpoint = await this.contextManager.loadCheckpoint(sessionId);

    if (checkpoint) {
      console.log(`✅ Checkpoint loaded: ${checkpoint.currentTask}`);
    } else {
      console.log('ℹ️ No checkpoint found');
    }

    return checkpoint;
  }

  // ==========================================================================
  // PHASE 2: CONVERSATION CAPTURE
  // ==========================================================================

  async captureTaskPlanning(taskDescription: string, plan: string): Promise<void> {
    const result = await this.contextManager.storeTaskPlanning(taskDescription, plan);

    this.contextMonitor.recordStorage('episode', true);
    this.contextMonitor.recordStorage('document', true);

    console.log(`✅ Task planning captured: episode=${result.episodeId}, document=${result.documentId}`);
  }

  async captureTaskCompletion(
    taskDescription: string,
    outcome: string,
    learnings: string[]
  ): Promise<void> {
    const result = await this.contextManager.storeTaskCompletion(
      taskDescription,
      outcome,
      learnings
    );

    this.contextMonitor.recordStorage('episode', true);
    if (result.documentId) {
      this.contextMonitor.recordStorage('document', true);
    }

    console.log(`✅ Task completion captured: episode=${result.episodeId}`);
  }

  async captureDiscovery(discovery: string, context: string): Promise<void> {
    const memoryId = await this.contextManager.storeDiscovery(discovery, context);

    this.contextMonitor.recordStorage('memory', true);

    console.log(`✅ Discovery captured: ${memoryId}`);
  }

  async captureProgress(progressSummary: string): Promise<void> {
    const episodeId = await this.contextManager.storeProgressUpdate(progressSummary);

    this.contextMonitor.recordStorage('episode', true);

    console.log(`✅ Progress update captured: ${episodeId}`);
  }

  // ==========================================================================
  // PHASE 3: CONTEXT INJECTION
  // ==========================================================================

  async injectContextForTool(toolName: string, toolArgs: any): Promise<any> {
    const startTime = Date.now();

    const result = await this.contextInjector.injectContext({
      toolName,
      toolArgs,
      sessionId: this.conversationHooks.getContextManager().getContext().sessionId
    });

    // Record metrics
    this.contextMonitor.recordInjection(
      result.latency,
      result.injected,
      result.timedOut
    );

    if (result.timedOut) {
      console.warn(`⚠️ Context injection timed out for ${toolName} (${result.latency}ms)`);
      return null;
    }

    if (result.injected) {
      console.log(`✅ Context injected for ${toolName} (${result.latency}ms)`);
      return result.context;
    }

    return null;
  }

  async getSuggestionsForContext(contextId: string): Promise<string[]> {
    const suggestions = await this.contextInjector.getSuggestions({ contextId });

    console.log(`✅ Generated ${suggestions.length} suggestions`);
    return suggestions;
  }

  // ==========================================================================
  // PHASE 4: HOOK INTEGRATION
  // ==========================================================================

  async onSessionStart(sessionId: string): Promise<void> {
    await this.conversationHooks.onSessionStart({
      type: 'start',
      sessionId,
      timestamp: new Date().toISOString()
    });

    console.log(`✅ Session started: ${sessionId}`);
  }

  async onUserPrompt(prompt: string, tokensUsed?: number): Promise<void> {
    await this.conversationHooks.onUserPromptSubmit({
      prompt,
      context: {
        sessionId: this.conversationHooks.getContextManager().getContext().sessionId,
        timestamp: new Date().toISOString(),
        tokensUsed
      }
    });

    console.log(`✅ User prompt captured (${prompt.length} chars)`);
  }

  async onToolExecuted(
    toolName: string,
    toolArgs: any,
    result: any,
    duration: number
  ): Promise<void> {
    await this.conversationHooks.onPostToolUse({
      toolName,
      toolArgs,
      result,
      duration,
      context: {
        sessionId: this.conversationHooks.getContextManager().getContext().sessionId,
        timestamp: new Date().toISOString()
      }
    });

    console.log(`✅ Tool execution captured: ${toolName} (${duration}ms)`);
  }

  async onSessionEnd(sessionId: string): Promise<void> {
    await this.conversationHooks.onSessionEnd({
      type: 'end',
      sessionId,
      timestamp: new Date().toISOString()
    });

    console.log(`✅ Session ended: ${sessionId}`);
  }

  // ==========================================================================
  // MONITORING & HEALTH
  // ==========================================================================

  getHealthStatus(): any {
    return this.contextMonitor.getHealthStatus();
  }

  getMetrics(): any {
    return this.contextMonitor.getMetrics();
  }

  getPerformanceSummary(): string {
    return this.contextMonitor.getPerformanceSummary();
  }

  adaptConfiguration(): void {
    this.contextMonitor.adaptConfiguration();
    console.log('✅ Configuration adapted based on performance');
  }

  // ==========================================================================
  // COMPLETE WORKFLOW EXAMPLE
  // ==========================================================================

  async demonstrateFullWorkflow(): Promise<void> {
    console.log('\n🚀 Starting full context management workflow demonstration\n');

    // 1. Session Start
    const sessionId = `demo_${Date.now()}`;
    await this.onSessionStart(sessionId);

    // 2. User submits a task (with automatic task planning detection)
    const taskPrompt = `Implement a new feature to track user engagement metrics and export them to CSV format.
    This should include:
    - Daily active users
    - Session duration
    - Feature usage statistics
    - Export functionality`;

    await this.onUserPrompt(taskPrompt, 500);

    // 3. Capture task planning
    await this.captureTaskPlanning(
      'Track user engagement metrics with CSV export',
      taskPrompt
    );

    // 4. Simulate tool execution with context injection
    const editContext = await this.injectContextForTool('Edit', {
      file_path: 'src/analytics/metrics-tracker.ts',
      old_string: 'old code',
      new_string: 'new code'
    });

    if (editContext) {
      console.log(`Context retrieved: ${editContext.memories?.length || 0} memories`);
    }

    // 5. Capture tool execution
    await this.onToolExecuted(
      'Edit',
      { file_path: 'src/analytics/metrics-tracker.ts' },
      { success: true },
      45
    );

    // 6. Capture a discovery
    await this.captureDiscovery(
      'Using a rolling window for daily metrics provides better performance than recalculating from scratch',
      'Implementing metrics tracker'
    );

    // 7. Progress update (simulating 15-minute work)
    await this.captureProgress(
      'Completed metrics tracker implementation. Currently testing CSV export functionality.'
    );

    // 8. Create checkpoint
    await this.createCheckpoint({
      currentTask: 'Track user engagement metrics with CSV export',
      gitStatus: 'M src/analytics/metrics-tracker.ts\nM src/analytics/csv-exporter.ts'
    });

    // 9. Complete task
    await this.captureTaskCompletion(
      'Track user engagement metrics with CSV export',
      'Successfully implemented metrics tracking with CSV export. All tests passing.',
      [
        'Rolling window approach is more efficient for time-series metrics',
        'CSV export should use streams for large datasets',
        'Metrics should be cached for 5 minutes to reduce database load'
      ]
    );

    // 10. Session end
    await this.onSessionEnd(sessionId);

    // 11. Show performance summary
    console.log('\n📊 Performance Summary:\n');
    console.log(this.getPerformanceSummary());

    // 12. Show health status
    const health = this.getHealthStatus();
    console.log(`\n🏥 Health Status: ${health.status.toUpperCase()}\n`);

    console.log('✨ Full workflow demonstration completed!\n');
  }
}

// ============================================================================
// USAGE EXAMPLE
// ============================================================================

async function main() {
  const system = new NexusContextSystem();

  // Run full workflow demonstration
  await system.demonstrateFullWorkflow();

  // Test checkpoint recovery
  console.log('\n🔄 Testing checkpoint recovery...\n');

  const newSession = new NexusContextSystem();
  const checkpoint = await newSession.loadCheckpoint();

  if (checkpoint) {
    console.log('✅ Successfully recovered session context');
    console.log(`   Current Task: ${checkpoint.currentTask}`);
    console.log(`   Completed: ${checkpoint.completedSteps.length} steps`);
    console.log(`   Pending: ${checkpoint.pendingTasks.length} tasks`);
  }
}

// Run if executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(console.error);
}

export default NexusContextSystem;
