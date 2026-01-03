/**
 * Agent Learning Service for MageAgent
 * Implements learning and adaptation from feedback and performance metrics
 * Enables agents to improve over time through experience
 */

import { v4 as uuidv4 } from 'uuid';
import { createGraphRAGClient, TenantContext } from '../clients/graphrag-client';
import { episodeService } from './episode-service';
import { logger } from '../utils/logger';

export interface AgentPerformanceMetrics {
  agentId: string;
  taskCount: number;
  successRate: number;
  avgResponseTime: number;
  avgTokenUsage: number;
  avgQualityScore: number;
  errorRate: number;
  feedbackScore: number;
  improvements: number;
  regressions: number;
}

export interface FeedbackData {
  id: string;
  agentId: string;
  taskId: string;
  sessionId?: string;
  type?: 'positive' | 'negative' | 'neutral' | 'correction';
  score?: number; // -1 to 1
  content?: string;
  suggestions?: string[];
  timestamp: Date;
  metadata?: any;
}

export interface LearningPattern {
  id: string;
  agentId: string;
  pattern: string;
  context: string;
  frequency: number;
  successRate: number;
  avgScore: number;
  examples: string[];
  recommendations: string[];
  lastUsed: Date;
}

export interface AgentProfile {
  agentId: string;
  model: string;
  specializations: string[];
  strengths: string[];
  weaknesses: string[];
  optimalParameters: {
    temperature: number;
    maxTokens: number;
    topP?: number;
    frequencyPenalty?: number;
    presencePenalty?: number;
  };
  performanceHistory: PerformanceSnapshot[];
  learningRate: number;
}

export interface PerformanceSnapshot {
  timestamp: Date;
  metrics: AgentPerformanceMetrics;
  significantEvents: string[];
}

export interface AdaptationRecommendation {
  agentId: string;
  type: 'parameter' | 'prompt' | 'role' | 'model';
  current: any;
  recommended: any;
  reason: string;
  confidence: number;
  expectedImprovement: number;
}

export class AgentLearningService {
  private static instance: AgentLearningService;
  private agentProfiles: Map<string, AgentProfile> = new Map();
  private learningPatterns: Map<string, LearningPattern[]> = new Map();
  private feedbackHistory: Map<string, FeedbackData[]> = new Map();
  private performanceCache: Map<string, AgentPerformanceMetrics> = new Map();
  private performanceHistory: Map<string, any[]> = new Map();

  private readonly LEARNING_RATE = 0.1; // How quickly agents adapt
  private readonly MIN_SAMPLES_FOR_LEARNING = 5; // Minimum feedback samples needed

  private constructor() {}

  public static getInstance(): AgentLearningService {
    if (!AgentLearningService.instance) {
      AgentLearningService.instance = new AgentLearningService();
    }
    return AgentLearningService.instance;
  }

  /**
   * Process feedback for an agent
   */
  async processFeedback(
    agentId: string,
    taskId: string,
    feedback: Omit<FeedbackData, 'id' | 'agentId' | 'taskId' | 'timestamp'>,
    tenantContext?: TenantContext // 🔒 SECURITY: Required for multi-tenant isolation
  ): Promise<void> {
    try {
      const feedbackData: FeedbackData = {
        id: uuidv4(),
        agentId,
        taskId,
        timestamp: new Date(),
        ...feedback
      };

      // Store feedback
      await this.storeFeedback(feedbackData, tenantContext);

      // Update agent metrics
      await this.updateAgentMetrics(agentId, feedbackData);

      // Identify patterns
      await this.identifyLearningPatterns(agentId, feedbackData);

      // Adjust agent parameters if needed
      const adjustments = await this.calculateAdjustments(agentId);
      if (adjustments.length > 0) {
        await this.applyAdjustments(agentId, adjustments, tenantContext);
      }

      // Store learning episode
      await episodeService.createFromUserInput(
        `Feedback received: ${feedback.type || 'general'} - ${feedback.content || 'No content'}`,
        feedback.sessionId || 'feedback-session',
        {
          type: 'feedback',
          agentId,
          taskId,
          score: feedback.score || 0
        }
      );

      logger.info('Feedback processed', {
        agentId,
        taskId,
        type: feedback.type,
        score: feedback.score
      });
    } catch (error) {
      logger.error('Failed to process feedback', { error, agentId, taskId });
    }
  }

  /**
   * Learn from task completion
   */
  async learnFromTask(
    agentId: string,
    task: any,
    result: any,
    performance: {
      responseTime: number;
      tokenUsage: number;
      success: boolean;
      error?: string;
    },
    tenantContext?: TenantContext // 🔒 SECURITY: Required for multi-tenant isolation
  ): Promise<void> {
    try {
      // Get or create agent profile
      let profile = this.agentProfiles.get(agentId);
      if (!profile) {
        profile = await this.createAgentProfile(agentId, task.model || 'unknown');
      }

      // Update performance metrics
      const metrics = await this.updatePerformanceMetrics(agentId, performance);

      // Identify successful patterns
      if (performance.success) {
        await this.recordSuccessPattern(agentId, task, result);
      } else {
        await this.recordFailurePattern(agentId, task, performance.error);
      }

      // Check for performance trends
      const trend = this.analyzePerformanceTrend(profile);

      if (trend === 'improving') {
        profile.learningRate = Math.min(profile.learningRate * 1.1, 0.5);
      } else if (trend === 'declining') {
        // Need more aggressive learning
        profile.learningRate = Math.max(profile.learningRate * 0.9, 0.05);

        // Generate recommendations
        const recommendations = await this.generateRecommendations(agentId, metrics);
        if (recommendations.length > 0) {
          await this.storeRecommendations(agentId, recommendations, tenantContext);
        }
      }

      // Store updated profile
      this.agentProfiles.set(agentId, profile);
      await this.persistAgentProfile(profile, tenantContext);

      logger.debug('Agent learned from task', {
        agentId,
        taskId: task.id,
        success: performance.success,
        learningRate: profile.learningRate
      });
    } catch (error) {
      logger.error('Failed to learn from task', { error, agentId });
    }
  }

  /**
   * Get agent recommendations
   */
  async getAgentRecommendations(agentId: string): Promise<AdaptationRecommendation[]> {
    try {
      const profile = this.agentProfiles.get(agentId);
      if (!profile) {
        return [];
      }

      const metrics = this.performanceCache.get(agentId);
      if (!metrics) {
        return [];
      }

      return await this.generateRecommendations(agentId, metrics);
    } catch (error) {
      logger.error('Failed to get agent recommendations', { error, agentId });
      return [];
    }
  }

  /**
   * Get best agent for task
   */
  async selectBestAgent(
    task: any,
    availableAgents: string[]
  ): Promise<{ agentId: string; confidence: number }> {
    try {
      let bestAgent = availableAgents[0];
      let bestScore = 0;

      for (const agentId of availableAgents) {
        const score = await this.calculateAgentFitness(agentId, task);
        if (score > bestScore) {
          bestScore = score;
          bestAgent = agentId;
        }
      }

      logger.info('Best agent selected', {
        task: task.type || task.name,
        agentId: bestAgent,
        confidence: bestScore
      });

      return { agentId: bestAgent, confidence: bestScore };
    } catch (error) {
      logger.error('Failed to select best agent', { error });
      return { agentId: availableAgents[0], confidence: 0.5 };
    }
  }

  /**
   * Share learning between agents
   */
  async shareLearning(
    sourceAgentId: string,
    targetAgentIds: string[],
    scope: 'patterns' | 'parameters' | 'all' = 'patterns'
  ): Promise<void> {
    try {
      const sourceProfile = this.agentProfiles.get(sourceAgentId);
      if (!sourceProfile) {
        throw new Error(`Source agent ${sourceAgentId} not found`);
      }

      const sourcePatterns = this.learningPatterns.get(sourceAgentId) || [];

      for (const targetId of targetAgentIds) {
        let targetProfile = this.agentProfiles.get(targetId);
        if (!targetProfile) {
          targetProfile = await this.createAgentProfile(targetId, 'unknown');
        }

        if (scope === 'patterns' || scope === 'all') {
          // Share successful patterns
          const successfulPatterns = sourcePatterns.filter(p => p.successRate > 0.7);
          await this.transferPatterns(successfulPatterns, targetId);
        }

        if (scope === 'parameters' || scope === 'all') {
          // Share optimal parameters (with adaptation)
          targetProfile.optimalParameters = this.adaptParameters(
            sourceProfile.optimalParameters,
            targetProfile.model
          );
        }

        // Update specializations
        const sharedSpecializations = sourceProfile.specializations
          .filter(s => !targetProfile.specializations.includes(s));
        targetProfile.specializations.push(...sharedSpecializations.slice(0, 3));

        this.agentProfiles.set(targetId, targetProfile);
        // Note: shareLearning doesn't have tenant context - skip persistence for now
        // This method should be updated to accept tenant context when called
        await this.persistAgentProfile(targetProfile);
      }

      logger.info('Learning shared between agents', {
        source: sourceAgentId,
        targets: targetAgentIds,
        scope
      });
    } catch (error) {
      logger.error('Failed to share learning', { error });
    }
  }

  /**
   * Get agent performance report
   */
  async getPerformanceReport(agentId: string): Promise<{
    profile: AgentProfile;
    metrics: AgentPerformanceMetrics;
    patterns: LearningPattern[];
    recentFeedback: FeedbackData[];
    recommendations: AdaptationRecommendation[];
  }> {
    try {
      const profile = this.agentProfiles.get(agentId) ||
                     await this.createAgentProfile(agentId, 'unknown');

      const metrics = this.performanceCache.get(agentId) ||
                     await this.calculatePerformanceMetrics(agentId);

      const patterns = this.learningPatterns.get(agentId) || [];

      const feedback = this.feedbackHistory.get(agentId) || [];
      const recentFeedback = feedback.slice(-10);

      const recommendations = await this.generateRecommendations(agentId, metrics);

      return {
        profile,
        metrics,
        patterns,
        recentFeedback,
        recommendations
      };
    } catch (error) {
      logger.error('Failed to get performance report', { error, agentId });
      throw error;
    }
  }

  // Private helper methods

  private async storeFeedback(feedback: FeedbackData, tenantContext?: TenantContext): Promise<void> {
    // Store in memory
    const history = this.feedbackHistory.get(feedback.agentId) || [];
    history.push(feedback);
    this.feedbackHistory.set(feedback.agentId, history);

    // 🔒 SECURITY: Skip GraphRAG storage if no tenant context
    if (!tenantContext) {
      logger.warn('SECURITY WARNING: Skipping GraphRAG feedback storage - no tenant context', {
        feedbackId: feedback.id,
        agentId: feedback.agentId,
      });
      return;
    }

    // Store in GraphRAG with tenant context
    const graphRAGClient = createGraphRAGClient(tenantContext);
    await graphRAGClient.storeMemory({
      content: JSON.stringify(feedback),
      tags: ['feedback', feedback.type || 'general', `agent:${feedback.agentId}`],
      metadata: {
        feedbackId: feedback.id,
        agentId: feedback.agentId,
        taskId: feedback.taskId,
        score: feedback.score,
        type: 'agent_feedback'
      }
    });
  }

  private async updateAgentMetrics(
    agentId: string,
    feedback: FeedbackData
  ): Promise<void> {
    let metrics = this.performanceCache.get(agentId);
    if (!metrics) {
      metrics = await this.calculatePerformanceMetrics(agentId);
    }

    // Update feedback score (moving average)
    const alpha = 0.1; // Smoothing factor
    const feedbackScore = feedback.score || 0;
    metrics.feedbackScore = (1 - alpha) * metrics.feedbackScore + alpha * feedbackScore;

    // Update success rate based on feedback type
    if (feedback.type === 'positive') {
      metrics.successRate = Math.min(1, metrics.successRate + 0.01);
    } else if (feedback.type === 'negative') {
      metrics.successRate = Math.max(0, metrics.successRate - 0.01);
    }

    this.performanceCache.set(agentId, metrics);
  }

  private async identifyLearningPatterns(
    agentId: string,
    feedback: FeedbackData
  ): Promise<void> {
    const patterns = this.learningPatterns.get(agentId) || [];

    // Look for patterns in feedback
    if (feedback.suggestions && feedback.suggestions.length > 0) {
      for (const suggestion of feedback.suggestions) {
        let pattern = patterns.find(p => p.pattern === suggestion);

        if (pattern) {
          // Update existing pattern
          pattern.frequency++;
          pattern.avgScore = (pattern.avgScore * (pattern.frequency - 1) + (feedback.score || 0)) / pattern.frequency;
          pattern.lastUsed = new Date();
        } else {
          // Create new pattern
          pattern = {
            id: uuidv4(),
            agentId,
            pattern: suggestion,
            context: feedback.content || '',
            frequency: 1,
            successRate: (feedback.score || 0) > 0 ? 1 : 0,
            avgScore: feedback.score || 0,
            examples: feedback.content ? [feedback.content] : [],
            recommendations: [],
            lastUsed: new Date()
          };
          patterns.push(pattern);
        }
      }
    }

    this.learningPatterns.set(agentId, patterns);
  }

  private async calculateAdjustments(agentId: string): Promise<AdaptationRecommendation[]> {
    const profile = this.agentProfiles.get(agentId);
    if (!profile) return [];

    const feedback = this.feedbackHistory.get(agentId) || [];
    if (feedback.length < this.MIN_SAMPLES_FOR_LEARNING) return [];

    const recommendations: AdaptationRecommendation[] = [];

    // Analyze recent feedback
    const recentFeedback = feedback.slice(-20);
    const avgScore = recentFeedback.reduce((sum, f) => sum + (f.score ?? 0), 0) / recentFeedback.length;

    // Temperature adjustment
    if (avgScore < 0 && profile.optimalParameters.temperature > 0.3) {
      recommendations.push({
        agentId,
        type: 'parameter',
        current: profile.optimalParameters.temperature,
        recommended: Math.max(0.1, profile.optimalParameters.temperature - 0.1),
        reason: 'Reducing temperature to improve consistency based on negative feedback',
        confidence: 0.7,
        expectedImprovement: 0.15
      });
    } else if (avgScore > 0.5 && profile.optimalParameters.temperature < 0.9) {
      recommendations.push({
        agentId,
        type: 'parameter',
        current: profile.optimalParameters.temperature,
        recommended: Math.min(1.0, profile.optimalParameters.temperature + 0.1),
        reason: 'Increasing temperature for more creative responses based on positive feedback',
        confidence: 0.6,
        expectedImprovement: 0.1
      });
    }

    // Token adjustment based on feedback about length
    const lengthComplaints = recentFeedback.filter(f =>
      f.content && (
        f.content.toLowerCase().includes('too long') ||
        f.content.toLowerCase().includes('too short')
      )
    );

    if (lengthComplaints.length > 3) {
      const tooLong = lengthComplaints.filter(f => f.content && f.content.toLowerCase().includes('too long'));
      if (tooLong.length > lengthComplaints.length / 2) {
        recommendations.push({
          agentId,
          type: 'parameter',
          current: profile.optimalParameters.maxTokens,
          recommended: Math.max(100, profile.optimalParameters.maxTokens - 200),
          reason: 'Reducing max tokens based on feedback about response length',
          confidence: 0.8,
          expectedImprovement: 0.2
        });
      }
    }

    return recommendations;
  }

  private async applyAdjustments(
    agentId: string,
    adjustments: AdaptationRecommendation[],
    tenantContext?: TenantContext
  ): Promise<void> {
    const profile = this.agentProfiles.get(agentId);
    if (!profile) return;

    for (const adjustment of adjustments) {
      if (adjustment.type === 'parameter') {
        // Apply parameter adjustments with learning rate
        const key = Object.keys(profile.optimalParameters).find(k =>
          profile.optimalParameters[k as keyof typeof profile.optimalParameters] === adjustment.current
        );

        if (key) {
          const currentValue = adjustment.current as number;
          const recommendedValue = adjustment.recommended as number;
          const newValue = currentValue + (recommendedValue - currentValue) * profile.learningRate;

          (profile.optimalParameters as any)[key] = newValue;
        }
      }
    }

    // 🔒 SECURITY: Skip GraphRAG storage if no tenant context
    if (!tenantContext) {
      logger.debug('Skipping adjustment storage - no tenant context', { agentId });
      this.agentProfiles.set(agentId, profile);
      return;
    }

    // Store adjustments as learning events
    const graphRAGClient = createGraphRAGClient(tenantContext);
    await graphRAGClient.storeMemory({
      content: JSON.stringify(adjustments),
      tags: ['learning', 'adjustment', `agent:${agentId}`],
      metadata: {
        agentId,
        type: 'parameter_adjustment',
        timestamp: new Date().toISOString()
      }
    });

    this.agentProfiles.set(agentId, profile);
  }

  private async createAgentProfile(agentId: string, model: string): Promise<AgentProfile> {
    const profile: AgentProfile = {
      agentId,
      model,
      specializations: [],
      strengths: [],
      weaknesses: [],
      optimalParameters: {
        temperature: 0.7,
        maxTokens: 1000,
        topP: 0.9,
        frequencyPenalty: 0,
        presencePenalty: 0
      },
      performanceHistory: [],
      learningRate: this.LEARNING_RATE
    };

    this.agentProfiles.set(agentId, profile);
    return profile;
  }

  private async updatePerformanceMetrics(
    agentId: string,
    performance: any
  ): Promise<AgentPerformanceMetrics> {
    let metrics = this.performanceCache.get(agentId);
    if (!metrics) {
      metrics = await this.calculatePerformanceMetrics(agentId);
    }

    // Update with new performance data
    metrics.taskCount++;
    metrics.successRate = (metrics.successRate * (metrics.taskCount - 1) +
                          (performance.success ? 1 : 0)) / metrics.taskCount;
    metrics.avgResponseTime = (metrics.avgResponseTime * (metrics.taskCount - 1) +
                               performance.responseTime) / metrics.taskCount;
    metrics.avgTokenUsage = (metrics.avgTokenUsage * (metrics.taskCount - 1) +
                             performance.tokenUsage) / metrics.taskCount;

    if (!performance.success) {
      metrics.errorRate = (metrics.errorRate * (metrics.taskCount - 1) + 1) / metrics.taskCount;
    }

    this.performanceCache.set(agentId, metrics);
    return metrics;
  }

  private async calculatePerformanceMetrics(agentId: string): Promise<AgentPerformanceMetrics> {
    // In production, calculate from historical data
    return {
      agentId,
      taskCount: 0,
      successRate: 0.5,
      avgResponseTime: 1000,
      avgTokenUsage: 500,
      avgQualityScore: 0.7,
      errorRate: 0.1,
      feedbackScore: 0,
      improvements: 0,
      regressions: 0
    };
  }

  private async recordSuccessPattern(
    agentId: string,
    task: any,
    result: any
  ): Promise<void> {
    const patterns = this.learningPatterns.get(agentId) || [];

    // Create success pattern
    const pattern: LearningPattern = {
      id: uuidv4(),
      agentId,
      pattern: `Success: ${task.type || 'general'}`,
      context: task.query || task.prompt || '',
      frequency: 1,
      successRate: 1,
      avgScore: 1,
      examples: [JSON.stringify({ task, result }).substring(0, 500)],
      recommendations: [],
      lastUsed: new Date()
    };

    patterns.push(pattern);
    this.learningPatterns.set(agentId, patterns.slice(-100)); // Keep last 100 patterns
  }

  private async recordFailurePattern(
    agentId: string,
    task: any,
    error?: string
  ): Promise<void> {
    const patterns = this.learningPatterns.get(agentId) || [];

    // Create failure pattern for learning
    const pattern: LearningPattern = {
      id: uuidv4(),
      agentId,
      pattern: `Failure: ${task.type || 'general'}`,
      context: error || 'Unknown error',
      frequency: 1,
      successRate: 0,
      avgScore: -1,
      examples: [JSON.stringify({ task, error }).substring(0, 500)],
      recommendations: ['Review task parameters', 'Consider different approach'],
      lastUsed: new Date()
    };

    patterns.push(pattern);
    this.learningPatterns.set(agentId, patterns.slice(-100));
  }

  private analyzePerformanceTrend(profile: AgentProfile): 'improving' | 'stable' | 'declining' {
    if (profile.performanceHistory.length < 3) return 'stable';

    const recent = profile.performanceHistory.slice(-3);
    const successRates = recent.map(p => p.metrics.successRate);

    // Check trend
    const isImproving = successRates.every((rate, i) =>
      i === 0 || rate >= successRates[i - 1]
    );
    const isDeclining = successRates.every((rate, i) =>
      i === 0 || rate <= successRates[i - 1]
    );

    if (isImproving) return 'improving';
    if (isDeclining) return 'declining';
    return 'stable';
  }

  private async generateRecommendations(
    agentId: string,
    metrics: AgentPerformanceMetrics
  ): Promise<AdaptationRecommendation[]> {
    const recommendations: AdaptationRecommendation[] = [];

    // Performance-based recommendations
    if (metrics.errorRate > 0.2) {
      recommendations.push({
        agentId,
        type: 'parameter',
        current: null,
        recommended: { temperature: 0.3 },
        reason: 'High error rate suggests need for more conservative parameters',
        confidence: 0.8,
        expectedImprovement: 0.3
      });
    }

    if (metrics.avgResponseTime > 5000) {
      recommendations.push({
        agentId,
        type: 'parameter',
        current: null,
        recommended: { maxTokens: 500 },
        reason: 'Response time too high, consider reducing max tokens',
        confidence: 0.7,
        expectedImprovement: 0.2
      });
    }

    return recommendations;
  }

  private async storeRecommendations(
    agentId: string,
    recommendations: AdaptationRecommendation[],
    tenantContext?: TenantContext
  ): Promise<void> {
    // 🔒 SECURITY: Skip if no tenant context
    if (!tenantContext) {
      logger.debug('Skipping recommendations storage - no tenant context', { agentId });
      return;
    }

    const graphRAGClient = createGraphRAGClient(tenantContext);
    await graphRAGClient.storeMemory({
      content: JSON.stringify(recommendations),
      tags: ['recommendations', 'learning', `agent:${agentId}`],
      metadata: {
        agentId,
        type: 'adaptation_recommendations',
        count: recommendations.length,
        timestamp: new Date().toISOString()
      }
    });
  }

  private async calculateAgentFitness(agentId: string, task: any): Promise<number> {
    const profile = this.agentProfiles.get(agentId);
    if (!profile) return 0.5;

    let fitness = 0.5; // Base fitness

    // Check specializations
    const taskType = task.type || 'general';
    if (profile.specializations.includes(taskType)) {
      fitness += 0.2;
    }

    // Check performance history
    const metrics = this.performanceCache.get(agentId);
    if (metrics) {
      fitness += metrics.successRate * 0.3;
    }

    // Check recent patterns
    const patterns = this.learningPatterns.get(agentId) || [];
    const relevantPatterns = patterns.filter(p =>
      p.context.toLowerCase().includes(task.query?.toLowerCase() || '')
    );

    if (relevantPatterns.length > 0) {
      const avgSuccess = relevantPatterns.reduce((sum, p) => sum + p.successRate, 0) / relevantPatterns.length;
      fitness += avgSuccess * 0.2;
    }

    return Math.min(fitness, 1);
  }

  private async transferPatterns(patterns: LearningPattern[], targetAgentId: string): Promise<void> {
    const targetPatterns = this.learningPatterns.get(targetAgentId) || [];

    for (const pattern of patterns) {
      // Check if pattern already exists
      const exists = targetPatterns.some(p => p.pattern === pattern.pattern);
      if (!exists) {
        // Clone pattern for target agent
        const transferredPattern: LearningPattern = {
          ...pattern,
          id: uuidv4(),
          agentId: targetAgentId,
          frequency: 0, // Reset frequency for new agent
          lastUsed: new Date()
        };
        targetPatterns.push(transferredPattern);
      }
    }

    this.learningPatterns.set(targetAgentId, targetPatterns);
  }

  private adaptParameters(sourceParams: any, targetModel: string): any {
    // Adapt parameters based on model differences
    const adapted = { ...sourceParams };

    // Model-specific adjustments
    if (targetModel.includes('gpt')) {
      // GPT models tend to work well with slightly higher temperature
      adapted.temperature = Math.min(1, sourceParams.temperature * 1.1);
    } else if (targetModel.includes('claude')) {
      // Claude models often benefit from lower temperature
      adapted.temperature = Math.max(0, sourceParams.temperature * 0.9);
    }

    return adapted;
  }

  private async persistAgentProfile(profile: AgentProfile, tenantContext?: TenantContext): Promise<void> {
    // 🔒 SECURITY: Skip if no tenant context
    if (!tenantContext) {
      logger.debug('Skipping profile persistence - no tenant context', {
        agentId: profile.agentId,
      });
      return;
    }

    const graphRAGClient = createGraphRAGClient(tenantContext);
    await graphRAGClient.storeMemory({
      content: JSON.stringify(profile),
      tags: ['agent-profile', `agent:${profile.agentId}`, profile.model],
      metadata: {
        agentId: profile.agentId,
        type: 'agent_profile',
        learningRate: profile.learningRate,
        timestamp: new Date().toISOString()
      }
    });
  }

  /**
   * Get agent profile
   */
  async getAgentProfile(agentId: string): Promise<any> {
    const profile = this.agentProfiles.get(agentId);
    if (!profile) {
      return {
        agentId,
        preferredModels: [],
        adjustedParameters: {},
        strengths: [],
        weaknesses: []
      };
    }
    return profile;
  }

  /**
   * Track performance metrics
   */
  async trackPerformance(
    agentId: string,
    taskId: string,
    metrics: any
  ): Promise<void> {
    if (!this.performanceHistory.has(agentId)) {
      this.performanceHistory.set(agentId, []);
    }

    this.performanceHistory.get(agentId)!.push({
      taskId,
      timestamp: new Date(),
      ...metrics
    });

    logger.info('Performance tracked', { agentId, taskId, metrics });
  }
}

export const agentLearningService = AgentLearningService.getInstance();