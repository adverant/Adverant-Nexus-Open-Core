import { OpenRouterClient } from '../clients/openrouter-client';
import { GraphRAGClient, createGraphRAGClient } from '../clients/graphrag-client';
import { ModelSelector } from '../utils/model-selector';
import { logger } from '../utils/logger';
import { AgentRole } from '../agents/base-agent';
import { TenantContext } from '../middleware/tenant-context';

/**
 * 3-Layer Consensus Engine for Multi-Agent Orchestration
 *
 * Inspired by DocMage's institutional consensus + Manus.ai's adaptive architecture
 *
 * Architecture:
 * Layer 1: Meta-Analysis - Evaluate all agent outputs, identify agreements/conflicts
 * Layer 2: Conflict Resolution - Spawn referee agents to resolve disagreements
 * Layer 3: Synthesis - Produce final coherent output with weighted contributions
 *
 * Each layer can dynamically spawn additional agents for complex tasks
 */

export interface AgentOutput {
  agentId: string;
  role: AgentRole;
  model: string;
  specialization: string;
  focus: string;
  reasoningDepth: string;
  result: any;
  profile?: any;
}

export interface MetaAnalysisResult {
  agreements: Agreement[];
  conflicts: Conflict[];
  qualityAssessments: QualityAssessment[];
  overallConfidence: number;
  requiresConflictResolution: boolean;
}

export interface Agreement {
  topic: string;
  agentIds: string[];
  confidence: number;
  evidence: string;
}

export interface Conflict {
  topic: string;
  positions: ConflictPosition[];
  severity: 'low' | 'medium' | 'high' | 'critical';
  requiresReferee: boolean;
}

export interface ConflictPosition {
  agentId: string;
  model: string;
  stance: string;
  reasoning: string;
  confidence: number;
}

export interface QualityAssessment {
  agentId: string;
  model: string;
  qualityScore: number; // 0-1
  confidence: number; // 0-1
  logicalConsistency: number; // 0-1
  evidenceQuality: number; // 0-1
  domainExpertise: number; // 0-1
  strengths: string[];
  weaknesses: string[];
}

export interface ConflictResolution {
  conflict: Conflict;
  resolution: string;
  resolvedBy: 'meta-analysis' | 'referee-agent' | 'consensus-vote' | 'evidence-weight';
  confidence: number;
  reasoning: string;
}

export interface ConsensusResult {
  finalOutput: any;
  consensusStrength: number; // 0-1 (how much agents agreed)
  confidenceScore: number; // 0-1 (overall confidence in result)
  layers: {
    metaAnalysis: MetaAnalysisResult;
    conflictResolutions: ConflictResolution[];
    synthesisReasoning: string;
  };
  agentContributions: AgentContribution[];
  uncertainties: string[];
}

export interface AgentContribution {
  agentId: string;
  model: string;
  weight: number; // 0-1 (how much this agent influenced final result)
  keyInsights: string[];
}

export class ConsensusEngine {
  private readonly META_ANALYZER_MODEL = 'anthropic/claude-3.5-sonnet';
  private readonly SYNTHESIS_MODEL = 'anthropic/claude-sonnet-4.5';

  constructor(
    private openRouterClient: OpenRouterClient,
    private graphRAGClient: GraphRAGClient,
    private modelSelector: ModelSelector
  ) {}

  /**
   * Main entry point: Apply 3-layer consensus to agent outputs
   * PHASE 43: Added optional tenantContext for multi-tenant isolation
   */
  async applyConsensus(
    taskObjective: string,
    agentOutputs: AgentOutput[],
    layerCount: number = 3,
    tenantContext?: TenantContext
  ): Promise<ConsensusResult> {
    const startTime = Date.now();

    logger.info('Starting 3-layer consensus engine', {
      agentCount: agentOutputs.length,
      layerCount,
      taskLength: taskObjective.length
    });

    // Layer 1: Meta-Analysis
    const metaAnalysis = await this.runMetaAnalysis(taskObjective, agentOutputs);

    logger.info('Meta-analysis completed', {
      agreements: metaAnalysis.agreements.length,
      conflicts: metaAnalysis.conflicts.length,
      overallConfidence: metaAnalysis.overallConfidence,
      requiresConflictResolution: metaAnalysis.requiresConflictResolution
    });

    // Layer 2: Conflict Resolution (only if needed)
    let conflictResolutions: ConflictResolution[] = [];
    if (metaAnalysis.requiresConflictResolution && layerCount >= 2) {
      conflictResolutions = await this.resolveConflicts(
        taskObjective,
        metaAnalysis.conflicts,
        agentOutputs
      );

      logger.info('Conflict resolution completed', {
        resolvedConflicts: conflictResolutions.length,
        averageConfidence: conflictResolutions.reduce((sum, r) => sum + r.confidence, 0) / conflictResolutions.length
      });
    }

    // Layer 3: Final Synthesis
    const synthesisResult = await this.synthesizeConsensus(
      taskObjective,
      agentOutputs,
      metaAnalysis,
      conflictResolutions
    );

    const duration = Date.now() - startTime;

    logger.info('Consensus engine completed', {
      duration,
      consensusStrength: synthesisResult.consensusStrength,
      confidenceScore: synthesisResult.confidenceScore,
      uncertainties: synthesisResult.uncertainties.length
    });

    // Store consensus pattern in GraphRAG for learning
    // PHASE 43: Pass tenant context for multi-tenant isolation
    await this.storeConsensusPattern(taskObjective, agentOutputs, synthesisResult, tenantContext);

    return synthesisResult;
  }

  /**
   * Layer 1: Meta-Analysis - Evaluate all agent outputs
   * Identifies agreements, conflicts, and quality assessments
   */
  private async runMetaAnalysis(
    taskObjective: string,
    agentOutputs: AgentOutput[]
  ): Promise<MetaAnalysisResult> {
    const systemPrompt = `You are an expert meta-analyst specialized in evaluating multiple AI agent outputs.

Your task is to analyze ${agentOutputs.length} different agent responses to a task and identify:
1. Points of AGREEMENT (where multiple agents converge on same conclusion)
2. Points of CONFLICT (where agents disagree or contradict each other)
3. QUALITY ASSESSMENT for each agent (logical consistency, evidence quality, domain expertise)

## Guidelines:
- Be objective and unbiased
- Look for subtle disagreements, not just obvious conflicts
- Assess quality based on reasoning depth, not model name
- Identify which conflicts are critical vs minor
- Consider each agent's specialization and reasoning depth

## Critical Conflicts (require referee):
- Life-safety issues (medical diagnosis, structural safety)
- Legal or compliance implications
- Contradictory technical specifications
- Incompatible architectural decisions

## Output Format:
Return ONLY valid JSON with this structure (no markdown, no explanations):
{
  "agreements": [
    {
      "topic": "string",
      "agentIds": ["agent1", "agent2"],
      "confidence": 0.95,
      "evidence": "string"
    }
  ],
  "conflicts": [
    {
      "topic": "string",
      "positions": [
        {
          "agentId": "agent1",
          "model": "model-name",
          "stance": "string",
          "reasoning": "string",
          "confidence": 0.8
        }
      ],
      "severity": "high",
      "requiresReferee": true
    }
  ],
  "qualityAssessments": [
    {
      "agentId": "agent1",
      "model": "model-name",
      "qualityScore": 0.85,
      "confidence": 0.9,
      "logicalConsistency": 0.9,
      "evidenceQuality": 0.8,
      "domainExpertise": 0.85,
      "strengths": ["thorough analysis", "clear reasoning"],
      "weaknesses": ["limited evidence", "assumptions unclear"]
    }
  ],
  "overallConfidence": 0.85,
  "requiresConflictResolution": false
}`;

    const userPrompt = `Task Objective:
${taskObjective}

Agent Outputs to Analyze:
${JSON.stringify(agentOutputs.map((a, i) => ({
      agentNumber: i + 1,
      agentId: a.agentId,
      model: a.model,
      specialization: a.specialization,
      focus: a.focus,
      reasoningDepth: a.reasoningDepth,
      // Truncate long outputs for meta-analysis
      output: typeof a.result === 'string'
        ? a.result.substring(0, 2000)
        : JSON.stringify(a.result).substring(0, 2000)
    })), null, 2)}

Perform comprehensive meta-analysis now (JSON only):`;

    try {
      const response = await this.openRouterClient.createCompletion({
        model: this.META_ANALYZER_MODEL,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt }
        ],
        temperature: 0.2, // Low temperature for analytical consistency
        max_tokens: 8000
      });

      const content = response.choices[0].message.content.trim();

      // Extract JSON from response
      let jsonContent = content;
      if (content.startsWith('```json')) {
        jsonContent = content.replace(/```json\n?/g, '').replace(/```\n?$/g, '').trim();
      } else if (content.startsWith('```')) {
        jsonContent = content.replace(/```\n?/g, '').trim();
      }

      const metaAnalysis = JSON.parse(jsonContent);

      // Validate structure
      return this.validateMetaAnalysis(metaAnalysis, agentOutputs);

    } catch (error) {
      logger.error('Meta-analysis failed', {
        error: error instanceof Error ? error.message : String(error)
      });

      // Fallback: simple analysis
      return this.generateFallbackMetaAnalysis(agentOutputs);
    }
  }

  /**
   * Validate and sanitize meta-analysis result
   */
  private validateMetaAnalysis(
    metaAnalysis: any,
    agentOutputs: AgentOutput[]
  ): MetaAnalysisResult {
    const agentIds = new Set(agentOutputs.map(a => a.agentId));

    return {
      agreements: Array.isArray(metaAnalysis.agreements) ? metaAnalysis.agreements : [],
      conflicts: Array.isArray(metaAnalysis.conflicts) ? metaAnalysis.conflicts : [],
      qualityAssessments: Array.isArray(metaAnalysis.qualityAssessments)
        ? metaAnalysis.qualityAssessments.filter((qa: any) => agentIds.has(qa.agentId))
        : [],
      overallConfidence: Math.max(0, Math.min(1, Number(metaAnalysis.overallConfidence) || 0.7)),
      requiresConflictResolution: Boolean(metaAnalysis.requiresConflictResolution)
    };
  }

  /**
   * Fallback meta-analysis when LLM fails
   */
  private generateFallbackMetaAnalysis(agentOutputs: AgentOutput[]): MetaAnalysisResult {
    return {
      agreements: [{
        topic: 'general analysis',
        agentIds: agentOutputs.map(a => a.agentId),
        confidence: 0.6,
        evidence: 'Multiple agents completed analysis'
      }],
      conflicts: [],
      qualityAssessments: agentOutputs.map(a => ({
        agentId: a.agentId,
        model: a.model,
        qualityScore: 0.7,
        confidence: 0.7,
        logicalConsistency: 0.7,
        evidenceQuality: 0.7,
        domainExpertise: 0.7,
        strengths: ['completed analysis'],
        weaknesses: ['fallback assessment']
      })),
      overallConfidence: 0.6,
      requiresConflictResolution: false
    };
  }

  /**
   * Layer 2: Conflict Resolution
   * For critical conflicts, spawn referee agents to investigate
   */
  private async resolveConflicts(
    taskObjective: string,
    conflicts: Conflict[],
    agentOutputs: AgentOutput[]
  ): Promise<ConflictResolution[]> {
    const resolutions: ConflictResolution[] = [];

    for (const conflict of conflicts) {
      try {
        if (conflict.requiresReferee && conflict.severity === 'critical') {
          // Spawn referee agent for critical conflicts
          const resolution = await this.spawnRefereeAgent(taskObjective, conflict, agentOutputs);
          resolutions.push(resolution);
        } else {
          // Use evidence-based weighting for non-critical conflicts
          const resolution = this.resolveByEvidenceWeight(conflict);
          resolutions.push(resolution);
        }
      } catch (error) {
        logger.warn('Failed to resolve conflict', {
          topic: conflict.topic,
          error: error instanceof Error ? error.message : String(error)
        });

        // Fallback: consensus vote
        resolutions.push(this.resolveByConsensusVote(conflict));
      }
    }

    return resolutions;
  }

  /**
   * Spawn a referee agent to investigate and resolve critical conflicts
   */
  private async spawnRefereeAgent(
    taskObjective: string,
    conflict: Conflict,
    _agentOutputs: AgentOutput[]
  ): Promise<ConflictResolution> {
    logger.info('Spawning referee agent for critical conflict', {
      topic: conflict.topic,
      severity: conflict.severity,
      positions: conflict.positions.length
    });

    // Query GraphRAG for relevant evidence
    let evidence: any[] = [];
    try {
      evidence = await this.graphRAGClient.recallMemory({
        query: `Evidence for: ${conflict.topic} in context of ${taskObjective.substring(0, 200)}`,
        limit: 5
      });
    } catch (error) {
      logger.warn('Failed to query GraphRAG for evidence', { error });
    }

    const systemPrompt = `You are an expert referee agent tasked with resolving a critical conflict between multiple AI agents.

Your role is to:
1. Objectively evaluate all conflicting positions
2. Consider relevant evidence and domain expertise
3. Determine the most accurate/safe/optimal resolution
4. Provide clear reasoning for your decision

Be impartial, evidence-based, and prioritize safety/correctness over speed.`;

    const userPrompt = `Task Context:
${taskObjective}

Critical Conflict to Resolve:
Topic: ${conflict.topic}
Severity: ${conflict.severity}

Conflicting Positions:
${JSON.stringify(conflict.positions, null, 2)}

Relevant Evidence from Knowledge Base:
${JSON.stringify(evidence, null, 2)}

Please provide your resolution in JSON format:
{
  "resolution": "your resolution statement",
  "confidence": 0.9,
  "reasoning": "detailed explanation of why this resolution is correct"
}`;

    try {
      // Select a high-quality model for referee work
      const refereeModel = await this.modelSelector.selectModel({
        role: AgentRole.REVIEW,
        taskComplexity: 'extreme',
        requiredCapabilities: {
          contextLength: 32000
        }
      });

      const response = await this.openRouterClient.createCompletion({
        model: refereeModel,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt }
        ],
        temperature: 0.1, // Very low temperature for objective resolution
        max_tokens: 2000
      });

      const content = response.choices[0].message.content.trim();

      // Extract JSON
      let jsonContent = content;
      if (content.startsWith('```json')) {
        jsonContent = content.replace(/```json\n?/g, '').replace(/```\n?$/g, '').trim();
      } else if (content.startsWith('```')) {
        jsonContent = content.replace(/```\n?/g, '').trim();
      }

      const refereeResult = JSON.parse(jsonContent);

      return {
        conflict,
        resolution: refereeResult.resolution,
        resolvedBy: 'referee-agent',
        confidence: Math.max(0, Math.min(1, refereeResult.confidence || 0.8)),
        reasoning: refereeResult.reasoning
      };

    } catch (error) {
      logger.error('Referee agent failed', {
        error: error instanceof Error ? error.message : String(error),
        topic: conflict.topic
      });

      // Fallback to consensus vote
      return this.resolveByConsensusVote(conflict);
    }
  }

  /**
   * Resolve conflict by evidence quality weighting
   */
  private resolveByEvidenceWeight(conflict: Conflict): ConflictResolution {
    // Weight positions by confidence and evidence quality
    const weightedPositions = conflict.positions.map(p => ({
      ...p,
      weight: p.confidence * (p.reasoning.length / 1000) // Longer reasoning = more weight
    }));

    const topPosition = weightedPositions.sort((a, b) => b.weight - a.weight)[0];

    return {
      conflict,
      resolution: topPosition.stance,
      resolvedBy: 'evidence-weight',
      confidence: topPosition.confidence,
      reasoning: `Selected based on evidence quality. Agent ${topPosition.agentId} (${topPosition.model}) provided most comprehensive reasoning.`
    };
  }

  /**
   * Resolve conflict by simple consensus vote
   */
  private resolveByConsensusVote(conflict: Conflict): ConflictResolution {
    // Group positions by stance
    const stanceCounts = new Map<string, number>();
    conflict.positions.forEach(p => {
      stanceCounts.set(p.stance, (stanceCounts.get(p.stance) || 0) + 1);
    });

    // Find most common stance
    let maxCount = 0;
    let majorityStance = conflict.positions[0].stance;
    stanceCounts.forEach((count, stance) => {
      if (count > maxCount) {
        maxCount = count;
        majorityStance = stance;
      }
    });

    return {
      conflict,
      resolution: majorityStance,
      resolvedBy: 'consensus-vote',
      confidence: maxCount / conflict.positions.length,
      reasoning: `${maxCount} out of ${conflict.positions.length} agents agreed on this position.`
    };
  }

  /**
   * Layer 3: Final Synthesis
   * Integrate all agent outputs, meta-analysis, and conflict resolutions
   */
  private async synthesizeConsensus(
    taskObjective: string,
    agentOutputs: AgentOutput[],
    metaAnalysis: MetaAnalysisResult,
    conflictResolutions: ConflictResolution[]
  ): Promise<ConsensusResult> {
    const startTime = Date.now();

    logger.info('🎯 Starting synthesis layer (Layer 3)', {
      agentCount: agentOutputs.length,
      agreements: metaAnalysis.agreements.length,
      conflicts: metaAnalysis.conflicts.length,
      qualityAssessments: metaAnalysis.qualityAssessments.length,
      model: this.SYNTHESIS_MODEL
    });

    const systemPrompt = `You are an expert synthesis agent responsible for producing the final, authoritative response from multiple AI agent analyses.

Your task is to:
1. Integrate insights from ${agentOutputs.length} specialized agents
2. Apply meta-analysis findings (agreements and quality assessments)
3. Incorporate conflict resolutions
4. Produce a coherent, comprehensive final output
5. Quantify uncertainties where appropriate

## Weighting Strategy:
- Weight agent contributions by quality score
- Prioritize agreements over individual opinions
- Apply conflict resolutions where applicable
- Acknowledge remaining uncertainties

## Output Requirements:
- Comprehensive and actionable
- Clearly structured
- Evidence-based
- Includes uncertainty quantification where relevant`;

    const userPrompt = `Task Objective:
${taskObjective}

Meta-Analysis Summary:
- Overall Confidence: ${metaAnalysis.overallConfidence}
- Agreements: ${metaAnalysis.agreements.length}
- Conflicts: ${metaAnalysis.conflicts.length}
- Quality Assessments Available: ${metaAnalysis.qualityAssessments.length}

Conflict Resolutions Applied:
${conflictResolutions.map(cr => `- ${cr.conflict.topic}: ${cr.resolution} (confidence: ${cr.confidence}, resolved by: ${cr.resolvedBy})`).join('\n')}

Agent Outputs (with quality scores):
${agentOutputs.map((a, i) => {
  const qa = metaAnalysis.qualityAssessments.find(q => q.agentId === a.agentId);
  return `
Agent ${i + 1}: ${a.model}
Specialization: ${a.specialization}
Focus: ${a.focus}
Reasoning Depth: ${a.reasoningDepth}
Quality Score: ${qa?.qualityScore || 'N/A'}
Confidence: ${qa?.confidence || 'N/A'}

Output:
${typeof a.result === 'string' ? a.result : JSON.stringify(a.result, null, 2)}
`;
}).join('\n---\n')}

Produce your final synthesized response now:`;

    try {
      logger.info('📡 Calling synthesis model', {
        model: this.SYNTHESIS_MODEL,
        systemPromptLength: systemPrompt.length,
        userPromptLength: userPrompt.length,
        totalInputSize: systemPrompt.length + userPrompt.length
      });

      const response = await this.openRouterClient.createCompletion({
        model: this.SYNTHESIS_MODEL,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt }
        ],
        temperature: 0.3
        // NO max_tokens limit - full capability as requested
      });

      logger.info('✅ Synthesis model response received', {
        hasResponse: !!response,
        hasChoices: !!response?.choices,
        choicesLength: response?.choices?.length || 0,
        duration: Date.now() - startTime
      });

      const finalOutput = response.choices[0].message.content.trim();

      // Calculate consensus strength (how much agents agreed)
      const consensusStrength = metaAnalysis.agreements.length > 0
        ? metaAnalysis.agreements.reduce((sum, a) => sum + a.confidence, 0) / metaAnalysis.agreements.length
        : 0.5;

      // Calculate agent contributions based on quality
      const agentContributions = metaAnalysis.qualityAssessments.map(qa => ({
        agentId: qa.agentId,
        model: qa.model,
        weight: qa.qualityScore,
        keyInsights: qa.strengths
      }));

      // Extract uncertainties from conflicts and meta-analysis
      const uncertainties: string[] = [];
      conflictResolutions.forEach(cr => {
        if (cr.confidence < 0.7) {
          uncertainties.push(`${cr.conflict.topic} (confidence: ${cr.confidence})`);
        }
      });

      logger.info('✅ Synthesis layer completed successfully', {
        finalOutputLength: finalOutput.length,
        consensusStrength,
        confidenceScore: metaAnalysis.overallConfidence,
        uncertaintiesCount: uncertainties.length,
        duration: Date.now() - startTime
      });

      return {
        finalOutput,
        consensusStrength,
        confidenceScore: metaAnalysis.overallConfidence,
        layers: {
          metaAnalysis,
          conflictResolutions,
          synthesisReasoning: 'Synthesized using weighted agent contributions and conflict resolutions'
        },
        agentContributions,
        uncertainties
      };

    } catch (error) {
      const duration = Date.now() - startTime;
      logger.error('❌ Synthesis layer failed', {
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
        duration,
        model: this.SYNTHESIS_MODEL,
        agentCount: agentOutputs.length
      });

      // Fallback: simple concatenation
      return this.generateFallbackSynthesis(agentOutputs, metaAnalysis);
    }
  }

  /**
   * Fallback synthesis when LLM fails
   */
  private generateFallbackSynthesis(
    agentOutputs: AgentOutput[],
    metaAnalysis: MetaAnalysisResult
  ): ConsensusResult {
    const finalOutput = {
      type: 'multi-agent-consensus',
      agentCount: agentOutputs.length,
      results: agentOutputs.map(a => ({
        model: a.model,
        specialization: a.specialization,
        output: a.result
      })),
      note: 'Fallback synthesis - review individual agent outputs'
    };

    return {
      finalOutput,
      consensusStrength: 0.5,
      confidenceScore: metaAnalysis.overallConfidence,
      layers: {
        metaAnalysis,
        conflictResolutions: [],
        synthesisReasoning: 'Fallback synthesis applied'
      },
      agentContributions: agentOutputs.map(a => ({
        agentId: a.agentId,
        model: a.model,
        weight: 1 / agentOutputs.length,
        keyInsights: []
      })),
      uncertainties: ['Fallback synthesis used - manual review recommended']
    };
  }

  /**
   * Store consensus pattern in GraphRAG for future learning
   * PHASE 43: Added tenant context support for multi-tenant isolation
   */
  private async storeConsensusPattern(
    taskObjective: string,
    agentOutputs: AgentOutput[],
    consensusResult: ConsensusResult,
    tenantContext?: TenantContext
  ): Promise<void> {
    try {
      // PHASE 43: Use tenant-aware client if tenant context is provided
      const client = tenantContext ? createGraphRAGClient(tenantContext) : this.graphRAGClient;

      await client.storeMemory({
        content: JSON.stringify({
          task: taskObjective.substring(0, 500),
          agentCount: agentOutputs.length,
          models: [...new Set(agentOutputs.map(a => a.model))],
          consensusStrength: consensusResult.consensusStrength,
          confidenceScore: consensusResult.confidenceScore,
          agreements: consensusResult.layers.metaAnalysis.agreements.length,
          conflicts: consensusResult.layers.metaAnalysis.conflicts.length,
          resolutions: consensusResult.layers.conflictResolutions.length,
          topContributors: consensusResult.agentContributions
            .sort((a, b) => b.weight - a.weight)
            .slice(0, 3)
            .map(ac => ({ model: ac.model, weight: ac.weight }))
        }),
        tags: ['mageagent', 'consensus', '3-layer', 'multi-agent'],
        metadata: {
          timestamp: new Date().toISOString(),
          consensusEngine: 'v1.0',
          agentCount: agentOutputs.length
        }
      });
    } catch (error) {
      logger.warn('Failed to store consensus pattern', { error });
    }
  }
}
