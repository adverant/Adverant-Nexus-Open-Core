import { Agent, AgentRole, AgentTask, AgentDependencies } from './base-agent';
import { logger } from '../utils/logger';

export class ResearchAgent extends Agent {
  constructor(id: string, model: string, dependencies: AgentDependencies) {
    super(id, model, AgentRole.RESEARCH, dependencies);
  }
  
  protected async performTask(
    task: AgentTask,
    memoryContext: any,
    sharedContext?: any
  ): Promise<any> {
    logger.info(`ResearchAgent ${this.id} performing research`, {
      objective: task.objective,
      model: this.model
    });
    
    // Build messages for the model
    const messages = [
      {
        role: 'system',
        content: `You are a research agent tasked with providing thorough, accurate analysis.
Your model: ${this.model}
${this.competitionGroup ? `Competition Group: ${this.competitionGroup} - Provide your unique perspective` : ''}
${this.collaborationGroup ? `Collaboration Group: ${this.collaborationGroup} - Consider shared context` : ''}

Previous successful patterns:
${JSON.stringify(memoryContext, null, 2)}

Your task is to analyze and provide insights. Be thorough, cite sources when possible, and provide actionable recommendations.`
      },
      {
        role: 'user',
        content: `Research Task: ${task.objective}

Context: ${JSON.stringify(task.context, null, 2)}

${sharedContext ? `Shared Context from other agents: ${JSON.stringify(sharedContext, null, 2)}` : ''}

Please provide a comprehensive analysis including:
1. Key findings and insights
2. Evidence and reasoning
3. Potential challenges or risks
4. Recommendations
5. Areas for further investigation`
      }
    ];
    
    // Make real API call to OpenRouter
    const response = await this.callModel(messages);
    
    // Parse and structure the response
    const result = {
      agentId: this.id,
      model: this.model,
      role: this.role,
      analysis: response,
      metadata: {
        timestamp: new Date().toISOString(),
        tokenEstimate: this.estimateTokens(response),
        competitionGroup: this.competitionGroup,
        collaborationGroup: this.collaborationGroup
      }
    };
    
    // Store in database
    await this.dependencies.databaseManager.storeAgentResult(this.id, task.id, result);
    
    return result;
  }
  
  protected summarizeResult(result: any): any {
    return {
      type: 'research',
      keyFindings: this.extractKeyPoints(result.analysis),
      model: result.model,
      confidence: this.assessConfidence(result.analysis)
    };
  }
  
  private extractKeyPoints(analysis: string): string[] {
    // Simple extraction - could be enhanced with NLP
    const lines = analysis.split('\n');
    const keyPoints: string[] = [];
    
    lines.forEach(line => {
      if (line.match(/^\d+\.|^-|^•/) && line.trim().length > 20) {
        keyPoints.push(line.trim());
      }
    });
    
    return keyPoints.slice(0, 5); // Top 5 points
  }
  
  private assessConfidence(analysis: string): number {
    // Simple confidence assessment based on content
    const confidenceIndicators = [
      'clearly', 'definitely', 'certainly', 'strong evidence',
      'highly recommend', 'conclusive', 'proven'
    ];
    
    const uncertaintyIndicators = [
      'possibly', 'might', 'could be', 'unclear',
      'needs further', 'uncertain', 'ambiguous'
    ];
    
    let confidence = 0.5;
    const lowerAnalysis = analysis.toLowerCase();
    
    confidenceIndicators.forEach(indicator => {
      if (lowerAnalysis.includes(indicator)) confidence += 0.05;
    });
    
    uncertaintyIndicators.forEach(indicator => {
      if (lowerAnalysis.includes(indicator)) confidence -= 0.05;
    });
    
    return Math.max(0, Math.min(1, confidence));
  }
  
  private estimateTokens(text: string): number {
    // Rough estimate: 1 token ≈ 4 characters
    return Math.ceil(text.length / 4);
  }
}
