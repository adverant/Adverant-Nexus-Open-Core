import { Agent, AgentRole, AgentTask, AgentDependencies } from './base-agent';
import { logger } from '../utils/logger';

export class ReviewAgent extends Agent {
  constructor(id: string, model: string, dependencies: AgentDependencies) {
    super(id, model, AgentRole.REVIEW, dependencies);
  }
  
  protected async performTask(
    task: AgentTask,
    memoryContext: any,
    sharedContext?: any
  ): Promise<any> {
    logger.info(`ReviewAgent ${this.id} performing review`, {
      objective: task.objective,
      model: this.model
    });
    
    // Build messages for review
    const messages = [
      {
        role: 'system',
        content: `You are an expert review agent providing thorough, constructive analysis.
Your model: ${this.model}
${this.competitionGroup ? `Competition: Evaluate solutions objectively` : ''}
${this.collaborationGroup ? `Collaboration: Provide constructive feedback` : ''}

Previous review patterns:
${JSON.stringify(memoryContext, null, 2)}

Your role is to:
- Evaluate quality, correctness, and completeness
- Identify strengths and weaknesses
- Suggest improvements
- Compare alternatives when applicable
- Provide actionable feedback`
      },
      {
        role: 'user',
        content: `Review Task: ${task.objective}

Context: ${JSON.stringify(task.context, null, 2)}

${sharedContext ? `Shared Context: ${JSON.stringify(sharedContext, null, 2)}` : ''}

Please provide a comprehensive review including:
1. Overall assessment
2. Strengths identified
3. Areas for improvement
4. Specific recommendations
5. Quality score (0-10) with justification
6. Risk assessment
7. Comparison with alternatives (if applicable)`
      }
    ];
    
    // Make real API call to OpenRouter
    const response = await this.callModel(messages);
    
    // Parse review components
    const review = this.parseReview(response);
    
    const result = {
      agentId: this.id,
      model: this.model,
      role: this.role,
      review: response,
      structured: review,
      metadata: {
        timestamp: new Date().toISOString(),
        qualityScore: review.qualityScore,
        recommendationCount: review.recommendations.length,
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
      type: 'review',
      qualityScore: result.structured.qualityScore,
      keyStrengths: result.structured.strengths.slice(0, 3),
      keyImprovements: result.structured.improvements.slice(0, 3),
      overallAssessment: result.structured.assessment,
      model: result.model
    };
  }
  
  private parseReview(reviewText: string): any {
    const review = {
      assessment: '',
      strengths: [] as string[],
      improvements: [] as string[],
      recommendations: [] as string[],
      qualityScore: 0,
      risks: [] as string[]
    };
    
    // Parse quality score
    const scoreMatch = reviewText.match(/score[:\s]+(\d+(?:\.\d+)?)\s*\/\s*10/i);
    if (scoreMatch) {
      review.qualityScore = parseFloat(scoreMatch[1]);
    } else {
      // Try to infer from sentiment
      review.qualityScore = this.inferQualityScore(reviewText);
    }
    
    // Extract sections
    const lines = reviewText.split('\n');
    let currentSection = '';
    
    lines.forEach(line => {
      const trimmed = line.trim();
      
      // Detect section headers
      if (trimmed.toLowerCase().includes('assessment')) {
        currentSection = 'assessment';
      } else if (trimmed.toLowerCase().includes('strength')) {
        currentSection = 'strengths';
      } else if (trimmed.toLowerCase().includes('improvement')) {
        currentSection = 'improvements';
      } else if (trimmed.toLowerCase().includes('recommendation')) {
        currentSection = 'recommendations';
      } else if (trimmed.toLowerCase().includes('risk')) {
        currentSection = 'risks';
      }
      
      // Add content to appropriate section
      if (trimmed && !trimmed.match(/^#|^\d+\.|^-/)) {
        if (currentSection === 'assessment' && !review.assessment) {
          review.assessment = trimmed;
        }
      } else if (trimmed.match(/^\d+\.|^-|^•/) && currentSection) {
        const content = trimmed.replace(/^\d+\.|^-|^•/, '').trim();
        if (content) {
          switch (currentSection) {
            case 'strengths':
              review.strengths.push(content);
              break;
            case 'improvements':
              review.improvements.push(content);
              break;
            case 'recommendations':
              review.recommendations.push(content);
              break;
            case 'risks':
              review.risks.push(content);
              break;
          }
        }
      }
    });
    
    // Ensure we have an assessment
    if (!review.assessment && lines.length > 0) {
      review.assessment = lines.find(l => l.trim().length > 20)?.trim() || 'No assessment provided';
    }
    
    return review;
  }
  
  private inferQualityScore(text: string): number {
    const positive = ['excellent', 'great', 'good', 'strong', 'effective', 'robust'];
    const negative = ['poor', 'weak', 'insufficient', 'lacking', 'needs improvement'];
    
    let score = 5; // Start neutral
    const lowerText = text.toLowerCase();
    
    positive.forEach(word => {
      if (lowerText.includes(word)) score += 0.5;
    });
    
    negative.forEach(word => {
      if (lowerText.includes(word)) score -= 0.5;
    });
    
    return Math.max(0, Math.min(10, score));
  }
}
