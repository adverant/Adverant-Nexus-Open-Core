import { OpenRouterClient } from '../clients/openrouter-client';
import { GraphRAGClient, createGraphRAGClient } from '../clients/graphrag-client';
import { AgentRole } from '../agents/base-agent';
import { logger } from '../utils/logger';
import { ModelSelector } from '../utils/model-selector';
import { TenantContext } from '../middleware/tenant-context';

export interface DynamicAgentProfile {
  role: AgentRole;
  specialization: string;
  focus: string;
  capabilities: string[];
  modelId: string;
  priority: number;
  reasoningDepth: 'shallow' | 'medium' | 'deep' | 'extreme';
}

export interface AgentGenerationRequest {
  task: string;
  complexity: 'simple' | 'medium' | 'complex' | 'extreme';
  domain?: string;
  maxAgents?: number;
  requiredCapabilities?: string[];
  constraints?: any;
}

export interface AgentGenerationResult {
  profiles: DynamicAgentProfile[];
  strategy: string;
  estimatedDuration: number;
  recommendedConsensusLayers: number;
}

/**
 * Dynamic Agent Generator using LLM-powered meta-analysis
 * Replaces hardcoded templates with context-aware agent profile generation
 *
 * Inspired by DocMage's institutional profiles + Manus.ai's adaptive architecture
 */
export class AgentGenerator {
  private readonly META_ANALYZER_MODEL = 'anthropic/claude-opus-4.6';

  constructor(
    private openRouterClient: OpenRouterClient,
    private graphRAGClient: GraphRAGClient,
    private modelSelector: ModelSelector
  ) {}

  /**
   * Generate dynamic agent profiles based on task analysis
   * Uses DEPT framework: Depth, Evaluation, Planning, Testing
   *
   * PHASE 46: Added optional tenantContext parameter for multi-tenant isolation
   */
  async generateAgentProfiles(
    request: AgentGenerationRequest,
    tenantContext?: TenantContext
  ): Promise<AgentGenerationResult> {
    const startTime = Date.now();

    try {
      logger.info('Starting dynamic agent profile generation', {
        task: request.task.substring(0, 100),
        complexity: request.complexity,
        maxAgents: request.maxAgents
      });

      // Step 1: Query GraphRAG for similar successful patterns
      // PHASE 55: Pass tenant context to queryRelevantPatterns for multi-tenant isolation
      const memoryContext = await this.queryRelevantPatterns(request.task, request.domain, tenantContext);

      // Step 2: Use meta-analyzer to decompose task and generate agent profiles
      const profiles = await this.analyzeAndGenerateProfiles(request, memoryContext);

      // Step 3: Assign optimal models to each agent
      const profilesWithModels = await this.assignModelsToProfiles(profiles, request);

      // Step 4: Calculate strategy and consensus requirements
      const strategy = this.determineOrchestrationStrategy(profilesWithModels, request.complexity);
      const consensusLayers = this.calculateConsensusLayers(request.complexity, profilesWithModels.length);

      const result: AgentGenerationResult = {
        profiles: profilesWithModels,
        strategy,
        estimatedDuration: this.estimateDuration(profilesWithModels, request.complexity),
        recommendedConsensusLayers: consensusLayers
      };

      // Store generation pattern in GraphRAG
      // PHASE 46: Propagate tenant context for multi-tenant isolation
      await this.storeGenerationPattern(request, result, tenantContext);

      logger.info('Agent profile generation completed', {
        agentCount: profilesWithModels.length,
        duration: Date.now() - startTime,
        strategy,
        consensusLayers
      });

      return result;

    } catch (error) {
      logger.error('Agent profile generation failed', {
        error: error instanceof Error ? error.message : String(error),
        task: request.task.substring(0, 100)
      });

      // Fallback to simplified profile set
      return this.generateFallbackProfiles(request);
    }
  }

  /**
   * Query GraphRAG for relevant successful agent patterns
   * PHASE 55: Added tenantContext parameter for multi-tenant isolation
   */
  private async queryRelevantPatterns(task: string, domain?: string, tenantContext?: TenantContext): Promise<any> {
    try {
      const query = domain
        ? `Successful multi-agent patterns for ${domain} tasks similar to: ${task.substring(0, 200)}`
        : `Successful multi-agent orchestration patterns for: ${task.substring(0, 200)}`;

      // PHASE 55: Use tenant-aware client if tenant context is provided
      const client = tenantContext
        ? createGraphRAGClient(tenantContext)
        : this.graphRAGClient;

      const memories = await client.recallMemory({
        query,
        limit: 10
      });

      return memories;
    } catch (error) {
      logger.warn('Failed to query memory patterns', { error });
      return [];
    }
  }

  /**
   * Use LLM meta-analyzer to decompose task and generate specialized agent profiles
   * This is the core of dynamic agent generation
   */
  private async analyzeAndGenerateProfiles(
    request: AgentGenerationRequest,
    memoryContext: any
  ): Promise<Omit<DynamicAgentProfile, 'modelId'>[]> {
    const systemPrompt = `You are an expert AI orchestration architect specialized in multi-agent system design.

Your task is to analyze a complex task and generate optimal agent profiles for collaborative execution.

## DEPT Framework (apply to analysis):
- **Depth**: How deep should reasoning go? (shallow/medium/deep/extreme)
- **Evaluation**: What validation methods are needed?
- **Planning**: What execution strategy optimizes results?
- **Testing**: How to verify outputs at each stage?

## Agent Role Types:
- RESEARCH: Information gathering, analysis, synthesis
- CODING: Implementation, refactoring, technical execution
- REVIEW: Quality assurance, validation, error detection
- SYNTHESIS: Integration of multiple perspectives, final output
- SPECIALIST: Domain-specific expertise (medical, legal, scientific, etc.)

## Instructions:
1. Analyze the task complexity and domain
2. Identify key sub-problems and required expertise
3. Generate 3-15 specialized agent profiles (more for complex tasks)
4. Each profile should have:
   - role: One of the 5 role types
   - specialization: Specific focus area (e.g., "infectious disease diagnostics", "statistical analysis")
   - focus: What this agent contributes (e.g., "differential diagnosis ranking")
   - capabilities: Required skills (e.g., ["medical reasoning", "Bayesian inference"])
   - priority: 1-10 (higher = more critical to final result)
   - reasoningDepth: How deep this agent should think

## Complexity Guidelines:
- Simple (1-3 agents): Single-domain, straightforward tasks
- Medium (3-5 agents): Multi-faceted tasks requiring diverse perspectives
- Complex (5-10 agents): High-stakes tasks with multiple domains and validation needs
- Extreme (10-15 agents): Life-critical or highly specialized tasks requiring comprehensive analysis

Return ONLY a valid JSON array of agent profiles. No explanations, just the JSON array.`;

    const userPrompt = `Task: ${request.task}

Complexity: ${request.complexity}
Domain: ${request.domain || 'general'}
Max Agents: ${request.maxAgents || 15}
${request.requiredCapabilities ? `Required Capabilities: ${request.requiredCapabilities.join(', ')}` : ''}

${memoryContext.length > 0 ? `Previous Successful Patterns:\n${JSON.stringify(memoryContext.slice(0, 3), null, 2)}` : ''}

Generate agent profiles now (JSON array only):`;

    try {
      const response = await this.openRouterClient.createCompletion({
        model: this.META_ANALYZER_MODEL,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt }
        ],
        temperature: 0.3, // Lower temperature for consistent JSON output
        max_tokens: 4000
      });

      const content = response.choices[0].message.content.trim();

      // Extract JSON array from response (handle markdown code blocks)
      let jsonContent = content;
      if (content.startsWith('```json')) {
        jsonContent = content.replace(/```json\n?/g, '').replace(/```\n?$/g, '').trim();
      } else if (content.startsWith('```')) {
        jsonContent = content.replace(/```\n?/g, '').trim();
      }

      const profiles = JSON.parse(jsonContent);

      // Validate and sanitize profiles
      return this.validateProfiles(profiles, request);

    } catch (error) {
      logger.error('Meta-analyzer failed to generate profiles', {
        error: error instanceof Error ? error.message : String(error)
      });

      // Fallback to rule-based generation
      return this.generateRuleBasedProfiles(request);
    }
  }

  /**
   * Validate and sanitize generated profiles
   */
  private validateProfiles(
    profiles: any[],
    request: AgentGenerationRequest
  ): Omit<DynamicAgentProfile, 'modelId'>[] {
    const validRoles = Object.values(AgentRole);
    const maxAgents = request.maxAgents || 15;

    return profiles
      .filter(p => p && typeof p === 'object')
      .map(p => ({
        role: validRoles.includes(p.role) ? p.role : AgentRole.SPECIALIST,
        specialization: String(p.specialization || 'general'),
        focus: String(p.focus || 'analysis'),
        capabilities: Array.isArray(p.capabilities) ? p.capabilities : [],
        priority: Math.max(1, Math.min(10, Number(p.priority) || 5)),
        reasoningDepth: ['shallow', 'medium', 'deep', 'extreme'].includes(p.reasoningDepth)
          ? p.reasoningDepth
          : 'medium'
      }))
      .slice(0, maxAgents);
  }

  /**
   * Fallback rule-based profile generation when LLM fails
   */
  private generateRuleBasedProfiles(
    request: AgentGenerationRequest
  ): Omit<DynamicAgentProfile, 'modelId'>[] {
    const { complexity } = request;
    const profiles: Omit<DynamicAgentProfile, 'modelId'>[] = [];

    // Always include core research and synthesis agents
    profiles.push({
      role: AgentRole.RESEARCH,
      specialization: 'primary analysis',
      focus: 'comprehensive task analysis and information gathering',
      capabilities: ['analysis', 'research', 'synthesis'],
      priority: 9,
      reasoningDepth: complexity === 'extreme' ? 'extreme' : 'deep'
    });

    profiles.push({
      role: AgentRole.SYNTHESIS,
      specialization: 'result integration',
      focus: 'integrate multiple perspectives into coherent output',
      capabilities: ['synthesis', 'integration', 'writing'],
      priority: 10,
      reasoningDepth: 'deep'
    });

    // Add agents based on complexity
    if (complexity === 'medium' || complexity === 'complex' || complexity === 'extreme') {
      profiles.push({
        role: AgentRole.REVIEW,
        specialization: 'quality assurance',
        focus: 'validate analysis and identify gaps',
        capabilities: ['validation', 'error-detection', 'quality-assurance'],
        priority: 8,
        reasoningDepth: 'medium'
      });
    }

    if (complexity === 'complex' || complexity === 'extreme') {
      profiles.push(
        {
          role: AgentRole.SPECIALIST,
          specialization: 'domain expert',
          focus: 'provide specialized domain knowledge',
          capabilities: ['domain-expertise', 'specialized-analysis'],
          priority: 7,
          reasoningDepth: 'deep'
        },
        {
          role: AgentRole.RESEARCH,
          specialization: 'alternative perspectives',
          focus: 'explore contrarian views and edge cases',
          capabilities: ['critical-thinking', 'alternative-analysis'],
          priority: 6,
          reasoningDepth: 'medium'
        }
      );
    }

    if (complexity === 'extreme') {
      // Add multiple specialists for extreme complexity
      profiles.push(
        {
          role: AgentRole.SPECIALIST,
          specialization: 'technical specialist',
          focus: 'deep technical analysis',
          capabilities: ['technical-depth', 'precision'],
          priority: 7,
          reasoningDepth: 'extreme'
        },
        {
          role: AgentRole.REVIEW,
          specialization: 'adversarial review',
          focus: 'identify flaws and weaknesses',
          capabilities: ['adversarial-thinking', 'flaw-detection'],
          priority: 8,
          reasoningDepth: 'deep'
        },
        {
          role: AgentRole.RESEARCH,
          specialization: 'comprehensive research',
          focus: 'exhaustive information gathering',
          capabilities: ['research', 'data-gathering', 'verification'],
          priority: 7,
          reasoningDepth: 'deep'
        }
      );
    }

    return profiles;
  }

  /**
   * Assign DIVERSE models to each agent profile for competitive orchestration
   *
   * DocMage approach: Use DIFFERENT models to get diverse perspectives
   * Each agent should use a different model (anthropic, openai, google, meta, etc.)
   */
  private async assignModelsToProfiles(
    profiles: Omit<DynamicAgentProfile, 'modelId'>[],
    request: AgentGenerationRequest
  ): Promise<DynamicAgentProfile[]> {
    try {
      // Select N diverse models for the agent cohort
      const diverseModels = await this.modelSelector.selectDiverseModels(
        profiles.length,
        {
          role: AgentRole.SPECIALIST, // All dynamic agents are specialists
          taskComplexity: request.complexity,
          requiredCapabilities: {
            contextLength: request.complexity === 'extreme' ? 128000 : 32000
          },
          minContextLength: request.complexity === 'extreme' ? 100000 : 16000
        }
      );

      logger.info('Assigned diverse models to agent profiles', {
        profileCount: profiles.length,
        modelCount: diverseModels.length,
        providers: [...new Set(diverseModels.map(m => m.split('/')[0]))],
        models: diverseModels
      });

      // Assign models to profiles (round-robin if we have fewer models than profiles)
      const profilesWithModels: DynamicAgentProfile[] = profiles.map((profile, index) => ({
        ...profile,
        modelId: diverseModels[index % diverseModels.length]
      }));

      return profilesWithModels;
    } catch (error) {
      logger.error('Failed to assign diverse models, using fallback strategy', { error });

      // Fallback: Use individual selection (old behavior)
      const profilesWithModels: DynamicAgentProfile[] = [];

      for (const profile of profiles) {
        const fallbackModel = this.getFallbackModel(profile.role);
        profilesWithModels.push({
          ...profile,
          modelId: fallbackModel
        });
      }

      return profilesWithModels;
    }
  }

  /**
   * Get fallback model based on role
   */
  private getFallbackModel(role: AgentRole): string {
    const fallbacks: Record<AgentRole, string> = {
      [AgentRole.RESEARCH]: 'anthropic/claude-opus-4.6',
      [AgentRole.CODING]: 'openai/gpt-4-turbo',
      [AgentRole.REVIEW]: 'anthropic/claude-opus-4.6',
      [AgentRole.SYNTHESIS]: 'anthropic/claude-opus-4.6',
      [AgentRole.SPECIALIST]: 'anthropic/claude-opus-4.6'
    };

    return fallbacks[role];
  }

  /**
   * Determine orchestration strategy based on profiles
   */
  private determineOrchestrationStrategy(
    profiles: DynamicAgentProfile[],
    complexity: string
  ): string {
    if (profiles.length === 1) {
      return 'single-agent';
    }

    if (profiles.length <= 3) {
      return 'sequential-collaboration';
    }

    if (complexity === 'extreme' || profiles.length >= 8) {
      return 'competitive-consensus';
    }

    return 'parallel-synthesis';
  }

  /**
   * Calculate number of consensus layers needed
   */
  private calculateConsensusLayers(complexity: string, agentCount: number): number {
    if (agentCount === 1) return 0;
    if (complexity === 'simple') return 1;
    if (complexity === 'medium') return 2;
    if (complexity === 'complex') return 3;
    if (complexity === 'extreme') return 3;
    return 2;
  }

  /**
   * Estimate task duration based on profiles and complexity
   */
  private estimateDuration(profiles: DynamicAgentProfile[], complexity: string): number {
    const baseTime = 30000; // 30 seconds
    const perAgentTime = 15000; // 15 seconds per agent

    const complexityMultiplier = {
      'simple': 1,
      'medium': 1.5,
      'complex': 2.5,
      'extreme': 4
    }[complexity] || 2;

    const depthMultiplier = profiles.reduce((max, p) => {
      const depth = { 'shallow': 1, 'medium': 1.5, 'deep': 2, 'extreme': 3 }[p.reasoningDepth] || 1.5;
      return Math.max(max, depth);
    }, 1);

    return Math.round(baseTime + (profiles.length * perAgentTime * complexityMultiplier * depthMultiplier));
  }

  /**
   * Store generation pattern in GraphRAG for future learning
   *
   * PHASE 46: Added tenant context support for multi-tenant isolation
   */
  private async storeGenerationPattern(
    request: AgentGenerationRequest,
    result: AgentGenerationResult,
    tenantContext?: TenantContext
  ): Promise<void> {
    try {
      // PHASE 46: Use tenant-aware client if tenant context is provided
      // This ensures multi-tenant isolation by injecting X-Company-ID and X-App-ID headers
      const client = tenantContext ? createGraphRAGClient(tenantContext) : this.graphRAGClient;

      // PHASE 46: Log tenant context usage for audit trail
      if (tenantContext) {
        logger.debug('Storing agent generation pattern with tenant context', {
          companyId: tenantContext.companyId,
          appId: tenantContext.appId,
          agentCount: result.profiles.length,
          complexity: request.complexity
        });
      }

      await client.storeMemory({
        content: JSON.stringify({
          task: request.task.substring(0, 500),
          complexity: request.complexity,
          domain: request.domain,
          generatedProfiles: result.profiles.map(p => ({
            role: p.role,
            specialization: p.specialization,
            priority: p.priority
          })),
          strategy: result.strategy,
          agentCount: result.profiles.length,
          consensusLayers: result.recommendedConsensusLayers
        }),
        tags: ['mageagent', 'agent-generation', 'meta-analysis', request.complexity],
        metadata: {
          timestamp: new Date().toISOString(),
          agentCount: result.profiles.length,
          strategy: result.strategy
        }
      });
    } catch (error) {
      logger.warn('Failed to store generation pattern', { error });
    }
  }

  /**
   * Fallback profile generation when all else fails
   */
  private generateFallbackProfiles(request: AgentGenerationRequest): AgentGenerationResult {
    const profiles: DynamicAgentProfile[] = [
      {
        role: AgentRole.RESEARCH,
        specialization: 'general analysis',
        focus: 'comprehensive task analysis',
        capabilities: ['analysis', 'research'],
        modelId: 'anthropic/claude-opus-4.6',
        priority: 10,
        reasoningDepth: request.complexity === 'extreme' ? 'extreme' : 'deep'
      }
    ];

    return {
      profiles,
      strategy: 'single-agent',
      estimatedDuration: 60000,
      recommendedConsensusLayers: 0
    };
  }
}
