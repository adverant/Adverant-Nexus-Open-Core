import { Agent, AgentRole, AgentTask, AgentDependencies } from './base-agent';
import { logger } from '../utils/logger';

export interface SpecialistAgentConfig {
  specialization: string;
  focus: string;
  capabilities: string[];
  reasoningDepth: 'shallow' | 'medium' | 'deep' | 'extreme';
}

/**
 * SpecialistAgent - Dynamically configured domain expert agent
 *
 * Unlike hardcoded agent types, SpecialistAgent accepts dynamic configuration
 * to become any type of domain expert based on task requirements.
 *
 * Examples:
 * - Medical specialists (Oncology, Cardiology, Infectious Disease)
 * - Technical specialists (Security, Performance, Architecture)
 * - Domain specialists (Legal, Financial, Scientific)
 */
export class SpecialistAgent extends Agent {
  private config: SpecialistAgentConfig;

  constructor(
    id: string,
    model: string,
    dependencies: AgentDependencies,
    config: SpecialistAgentConfig
  ) {
    super(id, model, AgentRole.SPECIALIST, dependencies);
    this.config = config;
  }

  protected async performTask(
    task: AgentTask,
    memoryContext: any,
    sharedContext?: any
  ): Promise<any> {
    logger.info(`SpecialistAgent ${this.id} performing specialized analysis`, {
      specialization: this.config.specialization,
      focus: this.config.focus,
      objective: task.objective,
      model: this.model,
      reasoningDepth: this.config.reasoningDepth
    });

    // Build system prompt tailored to specialization
    const systemPrompt = this.buildSpecializedSystemPrompt(memoryContext);

    // Build user prompt with appropriate depth instructions
    const userPrompt = this.buildUserPrompt(task, sharedContext);

    const messages = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt }
    ];

    // Make API call to OpenRouter
    const response = await this.callModel(messages);

    // Structure the response
    const result = {
      agentId: this.id,
      model: this.model,
      role: this.role,
      specialization: this.config.specialization,
      focus: this.config.focus,
      reasoningDepth: this.config.reasoningDepth,
      analysis: response,
      metadata: {
        timestamp: new Date().toISOString(),
        tokenEstimate: this.estimateTokens(response),
        competitionGroup: this.competitionGroup,
        collaborationGroup: this.collaborationGroup,
        capabilities: this.config.capabilities
      }
    };

    // Store in database
    await this.dependencies.databaseManager.storeAgentResult(this.id, task.id, result);

    return result;
  }

  private buildSpecializedSystemPrompt(memoryContext: any): string {
    const depthInstructions = this.getDepthInstructions(this.config.reasoningDepth);

    return `You are a specialized AI agent with deep expertise in ${this.config.specialization}.

Your primary focus: ${this.config.focus}

Key capabilities:
${this.config.capabilities.map(cap => `- ${cap}`).join('\n')}

Reasoning Depth: ${this.config.reasoningDepth.toUpperCase()}
${depthInstructions}

Your model: ${this.model}
${this.competitionGroup ? `\nCompetition Mode: Provide your unique expert perspective to compete with other specialists.\n` : ''}
${this.collaborationGroup ? `\nCollaboration Mode: Consider insights from other agents and build upon shared context.\n` : ''}

Previous successful patterns from similar tasks:
${JSON.stringify(memoryContext, null, 2)}

Instructions:
1. Apply your specialized domain expertise to the problem
2. Use domain-specific terminology and frameworks appropriately
3. Identify nuances and edge cases others might miss
4. Provide evidence-based reasoning from your specialization
5. Consider interactions between your domain and related domains
6. Be precise, accurate, and thorough in your analysis

Remember: You are an expert in ${this.config.specialization}. Leverage that expertise fully.`;
  }

  private getDepthInstructions(depth: string): string {
    switch (depth) {
      case 'shallow':
        return `Provide a concise, high-level analysis focusing on the most critical aspects.
Think 2-3 steps ahead. Prioritize speed and clarity over exhaustive detail.`;

      case 'medium':
        return `Provide a balanced analysis covering key considerations and implications.
Think 3-5 steps ahead. Balance thoroughness with efficiency.`;

      case 'deep':
        return `Provide comprehensive, multi-layered analysis exploring connections and implications.
Think 5-7 steps ahead. Examine edge cases, alternative scenarios, and second-order effects.
Consider how different factors interact and influence outcomes.`;

      case 'extreme':
        return `Provide exhaustive, multi-dimensional analysis with maximum rigor.
Think 7+ steps ahead. Explore all angles, edge cases, and cascading effects.
Apply first-principles reasoning. Question assumptions. Consider rare but high-impact scenarios.
Build detailed causal chains. Identify hidden dependencies and non-obvious implications.
This is a critical task requiring your deepest analytical capabilities.`;

      default:
        return 'Provide a thorough analysis appropriate to the task complexity.';
    }
  }

  private buildUserPrompt(task: AgentTask, sharedContext?: any): string {
    let prompt = `Task: ${task.objective}\n\n`;

    if (task.context && Object.keys(task.context).length > 0) {
      prompt += `Context:\n${JSON.stringify(task.context, null, 2)}\n\n`;
    }

    if (sharedContext && Object.keys(sharedContext).length > 0) {
      prompt += `Insights from other agents:\n${JSON.stringify(sharedContext, null, 2)}\n\n`;
    }

    // Add depth-specific instructions
    switch (this.config.reasoningDepth) {
      case 'extreme':
        prompt += `As a ${this.config.specialization} specialist, provide your most rigorous analysis including:
1. Comprehensive assessment using domain-specific frameworks
2. Detailed differential analysis with probability estimates
3. Evidence-based reasoning with source citations
4. Risk stratification and severity assessment
5. Recommended diagnostic/investigative approach with priority ranking
6. Considerations for comorbidities and interactions
7. Timeline and urgency assessment
8. Quality assurance and validation criteria

Be exhaustive. Lives or critical outcomes may depend on your analysis.`;
        break;

      case 'deep':
        prompt += `As a ${this.config.specialization} specialist, provide thorough analysis including:
1. Key findings from your specialized perspective
2. Evidence and domain-specific reasoning
3. Risk assessment and critical considerations
4. Recommendations with justification
5. Areas requiring further specialist input

Be comprehensive and precise.`;
        break;

      case 'medium':
        prompt += `As a ${this.config.specialization} specialist, provide focused analysis including:
1. Primary insights from your domain
2. Key evidence and reasoning
3. Critical recommendations
4. Important considerations

Be clear and actionable.`;
        break;

      case 'shallow':
        prompt += `As a ${this.config.specialization} specialist, provide concise analysis:
1. Top 3 most important insights
2. Critical recommendation
3. Immediate next steps

Be brief but impactful.`;
        break;
    }

    return prompt;
  }

  protected summarizeResult(result: any): any {
    return {
      type: 'specialist',
      specialization: this.config.specialization,
      focus: this.config.focus,
      reasoningDepth: this.config.reasoningDepth,
      keyInsights: this.extractKeyPoints(result.analysis),
      model: result.model,
      confidence: this.assessConfidence(result.analysis)
    };
  }

  private extractKeyPoints(analysis: string): string[] {
    const lines = analysis.split('\n');
    const keyPoints: string[] = [];

    lines.forEach(line => {
      if (line.match(/^\d+\.|^-|^•|^#{1,3}\s/) && line.trim().length > 20) {
        keyPoints.push(line.trim());
      }
    });

    // Return more points for deeper reasoning
    const maxPoints = {
      'shallow': 3,
      'medium': 5,
      'deep': 7,
      'extreme': 10
    }[this.config.reasoningDepth] || 5;

    return keyPoints.slice(0, maxPoints);
  }

  private assessConfidence(analysis: string): number {
    const confidenceIndicators = [
      'clearly', 'definitely', 'certainly', 'strong evidence',
      'highly recommend', 'conclusive', 'proven', 'established',
      'well-documented', 'confirmed'
    ];

    const uncertaintyIndicators = [
      'possibly', 'might', 'could be', 'unclear',
      'needs further', 'uncertain', 'ambiguous', 'tentative',
      'preliminary', 'speculative'
    ];

    let confidence = 0.5;
    const lowerAnalysis = analysis.toLowerCase();

    confidenceIndicators.forEach(indicator => {
      if (lowerAnalysis.includes(indicator)) confidence += 0.04;
    });

    uncertaintyIndicators.forEach(indicator => {
      if (lowerAnalysis.includes(indicator)) confidence -= 0.04;
    });

    // Adjust confidence based on reasoning depth
    // Deeper reasoning with more evidence generally warrants higher base confidence
    const depthBonus = {
      'shallow': -0.1,
      'medium': 0,
      'deep': 0.05,
      'extreme': 0.1
    }[this.config.reasoningDepth] || 0;

    confidence += depthBonus;

    return Math.max(0, Math.min(1, confidence));
  }

  private estimateTokens(text: string): number {
    // Rough estimate: 1 token ≈ 4 characters
    return Math.ceil(text.length / 4);
  }
}
