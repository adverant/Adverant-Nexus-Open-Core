import { Agent, AgentRole, AgentTask, AgentDependencies } from './base-agent';
import { logger } from '../utils/logger';

export class SynthesisAgent extends Agent {
  constructor(id: string, model: string, dependencies: AgentDependencies) {
    super(id, model, AgentRole.SYNTHESIS, dependencies);
  }
  
  protected async performTask(
    task: AgentTask,
    memoryContext: any,
    sharedContext?: any
  ): Promise<any> {
    logger.info(`SynthesisAgent ${this.id} performing synthesis`, {
      objective: task.objective,
      model: this.model
    });
    
    // Build messages for synthesis
    const messages = [
      {
        role: 'system',
        content: `You are a synthesis agent specializing in combining multiple perspectives into coherent insights.
Your model: ${this.model}
${this.competitionGroup ? `Competition: Build consensus from competing solutions` : ''}
${this.collaborationGroup ? `Collaboration: Integrate all contributions` : ''}

Previous synthesis patterns:
${JSON.stringify(memoryContext, null, 2)}

Your role is to:
- Identify common themes and patterns
- Resolve contradictions intelligently
- Create unified recommendations
- Highlight unique insights from each source
- Build actionable consensus`
      },
      {
        role: 'user',
        content: `Synthesis Task: ${task.objective}

Context: ${JSON.stringify(task.context, null, 2)}

${sharedContext ? `Shared Context: ${JSON.stringify(sharedContext, null, 2)}` : ''}

Please provide a comprehensive synthesis including:
1. Executive summary
2. Common themes across inputs
3. Key differences and how to reconcile them
4. Unique insights from each source
5. Unified recommendations
6. Action items with priorities
7. Confidence level in the synthesis`
      }
    ];
    
    // Make real API call to OpenRouter
    const response = await this.callModel(messages);
    
    // Parse synthesis components
    const synthesis = this.parseSynthesis(response);
    
    const result = {
      agentId: this.id,
      model: this.model,
      role: this.role,
      synthesis: response,
      structured: synthesis,
      metadata: {
        timestamp: new Date().toISOString(),
        sourceCount: this.countSources(task.context),
        themeCount: synthesis.themes.length,
        recommendationCount: synthesis.recommendations.length,
        confidenceLevel: synthesis.confidence,
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
      type: 'synthesis',
      executiveSummary: result.structured.executiveSummary,
      keyThemes: result.structured.themes.slice(0, 3),
      topRecommendations: result.structured.recommendations.slice(0, 3),
      confidence: result.structured.confidence,
      model: result.model
    };
  }
  
  private parseSynthesis(synthesisText: string): any {
    const synthesis = {
      executiveSummary: '',
      themes: [] as string[],
      differences: [] as { point: string; resolution: string }[],
      insights: [] as { source: string; insight: string }[],
      recommendations: [] as string[],
      actionItems: [] as { item: string; priority: string }[],
      confidence: 0.5
    };
    
    // Extract executive summary
    const execMatch = synthesisText.match(/executive summary[:\n]+([^\n]+(?:\n(?!^\d+\.|^#|^-)[^\n]+)*)/i);
    if (execMatch) {
      synthesis.executiveSummary = execMatch[1].trim();
    }
    
    // Parse confidence level
    const confMatch = synthesisText.match(/confidence[:\s]+(\d+(?:\.\d+)?)\s*[%/]|confidence level[:\s]+(\w+)/i);
    if (confMatch) {
      if (confMatch[1]) {
        synthesis.confidence = parseFloat(confMatch[1]) / 100;
      } else if (confMatch[2]) {
        synthesis.confidence = this.mapConfidenceWord(confMatch[2]);
      }
    }
    
    // Extract structured content
    const lines = synthesisText.split('\n');
    let currentSection = '';
    
    lines.forEach((line, index) => {
      const trimmed = line.trim();
      const lower = trimmed.toLowerCase();
      
      // Detect sections
      if (lower.includes('theme') || lower.includes('common')) {
        currentSection = 'themes';
      } else if (lower.includes('difference') || lower.includes('reconcil')) {
        currentSection = 'differences';
      } else if (lower.includes('insight') || lower.includes('unique')) {
        currentSection = 'insights';
      } else if (lower.includes('recommendation')) {
        currentSection = 'recommendations';
      } else if (lower.includes('action') && lower.includes('item')) {
        currentSection = 'actions';
      }
      
      // Parse content based on section
      if (trimmed.match(/^\d+\.|^-|^•/)) {
        const content = trimmed.replace(/^\d+\.|^-|^•/, '').trim();
        
        switch (currentSection) {
          case 'themes':
            if (content) synthesis.themes.push(content);
            break;
            
          case 'differences': {
            // Look for resolution in next lines
            const resolution = this.findResolution(lines, index);
            if (content && resolution) {
              synthesis.differences.push({ point: content, resolution });
            }
            break;
          }

          case 'insights': {
            const sourceMatch = content.match(/^([^:]+):\s*(.+)/);
            if (sourceMatch) {
              synthesis.insights.push({
                source: sourceMatch[1].trim(),
                insight: sourceMatch[2].trim()
              });
            } else if (content) {
              synthesis.insights.push({
                source: 'Unknown',
                insight: content
              });
            }
            break;
          }

          case 'recommendations':
            if (content) synthesis.recommendations.push(content);
            break;
            
          case 'actions': {
            const priorityMatch = content.match(/(.+)\s*\((\w+)\s*priority\)/i);
            if (priorityMatch) {
              synthesis.actionItems.push({
                item: priorityMatch[1].trim(),
                priority: priorityMatch[2].toLowerCase()
              });
            } else if (content) {
              synthesis.actionItems.push({
                item: content,
                priority: 'medium'
              });
            }
            break;
          }
        }
      }
    });
    
    // Ensure we have an executive summary
    if (!synthesis.executiveSummary && synthesis.themes.length > 0) {
      synthesis.executiveSummary = `Synthesis identified ${synthesis.themes.length} key themes and ${synthesis.recommendations.length} recommendations.`;
    }
    
    return synthesis;
  }
  
  private findResolution(lines: string[], startIndex: number): string {
    // Look for resolution in the next few lines
    for (let i = startIndex + 1; i < Math.min(startIndex + 3, lines.length); i++) {
      const line = lines[i].trim();
      if (line.toLowerCase().includes('resolv') || line.toLowerCase().includes('solution')) {
        return line.replace(/^.*?:\s*/, '').trim();
      }
    }
    return 'Requires further analysis';
  }
  
  private mapConfidenceWord(word: string): number {
    const confidenceMap: Record<string, number> = {
      'very high': 0.9,
      'high': 0.8,
      'moderate': 0.6,
      'medium': 0.5,
      'low': 0.3,
      'very low': 0.1
    };
    
    return confidenceMap[word.toLowerCase()] || 0.5;
  }
  
  private countSources(context: any): number {
    if (Array.isArray(context.solutions)) {
      return context.solutions.length;
    } else if (context.contributions) {
      return Object.keys(context.contributions).length;
    } else if (context.evaluation && Array.isArray(context.evaluation.solutions)) {
      return context.evaluation.solutions.length;
    }
    return 1;
  }
}
