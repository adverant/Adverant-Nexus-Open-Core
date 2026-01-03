import { Agent, AgentRole, AgentTask, AgentDependencies } from './base-agent';
import { logger } from '../utils/logger';

export class CodingAgent extends Agent {
  constructor(id: string, model: string, dependencies: AgentDependencies) {
    super(id, model, AgentRole.CODING, dependencies);
  }
  
  protected async performTask(
    task: AgentTask,
    memoryContext: any,
    sharedContext?: any
  ): Promise<any> {
    logger.info(`CodingAgent ${this.id} generating code`, {
      objective: task.objective,
      model: this.model
    });
    
    // Build messages for code generation
    const messages = [
      {
        role: 'system',
        content: `You are an expert coding agent specializing in clean, production-ready code.
Your model: ${this.model}
${this.competitionGroup ? `Competition: Provide your best implementation approach` : ''}
${this.collaborationGroup ? `Collaboration: Build upon shared context` : ''}

Previous successful code patterns:
${JSON.stringify(memoryContext, null, 2)}

Guidelines:
- Write clean, well-documented code
- Follow best practices for the language
- Include error handling
- Make code production-ready
- NO mock data or stubs - implement real functionality
- Include comprehensive comments`
      },
      {
        role: 'user',
        content: `Coding Task: ${task.objective}

Context: ${JSON.stringify(task.context, null, 2)}

${sharedContext ? `Shared Context: ${JSON.stringify(sharedContext, null, 2)}` : ''}

Requirements:
1. Implement a complete, working solution
2. Include proper error handling
3. Add comprehensive documentation
4. Follow language best practices
5. Make it production-ready

Provide the implementation with explanations of key design decisions.`
      }
    ];
    
    // Make real API call to OpenRouter
    const response = await this.callModel(messages);
    
    // Extract code blocks and analyze
    const codeBlocks = this.extractCodeBlocks(response);
    const analysis = this.analyzeCode(codeBlocks);
    
    const result = {
      agentId: this.id,
      model: this.model,
      role: this.role,
      implementation: response,
      codeBlocks,
      analysis,
      metadata: {
        timestamp: new Date().toISOString(),
        language: this.detectLanguage(codeBlocks),
        lineCount: this.countLines(codeBlocks),
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
      type: 'coding',
      language: result.metadata.language,
      lineCount: result.metadata.lineCount,
      keyFeatures: result.analysis.features,
      complexity: result.analysis.complexity,
      model: result.model
    };
  }
  
  private extractCodeBlocks(text: string): Array<{ language: string; code: string }> {
    const codeBlocks: Array<{ language: string; code: string }> = [];
    const regex = /```(\w+)?\n([\s\S]*?)```/g;
    let match;
    
    while ((match = regex.exec(text)) !== null) {
      codeBlocks.push({
        language: match[1] || 'plaintext',
        code: match[2].trim()
      });
    }
    
    return codeBlocks;
  }
  
  private analyzeCode(codeBlocks: Array<{ language: string; code: string }>) {
    const analysis = {
      features: [] as string[],
      complexity: 'medium' as 'low' | 'medium' | 'high',
      hasErrorHandling: false,
      hasTests: false,
      hasDocumentation: false
    };
    
    codeBlocks.forEach(block => {
      const code = block.code.toLowerCase();
      
      // Check for error handling
      if (code.includes('try') || code.includes('catch') || code.includes('error')) {
        analysis.hasErrorHandling = true;
        analysis.features.push('Error handling');
      }
      
      // Check for tests
      if (code.includes('test') || code.includes('describe') || code.includes('it(')) {
        analysis.hasTests = true;
        analysis.features.push('Unit tests');
      }
      
      // Check for documentation
      if (code.includes('/**') || code.includes('#') || code.includes('"""')) {
        analysis.hasDocumentation = true;
        analysis.features.push('Documentation');
      }
      
      // Assess complexity
      const lines = block.code.split('\n').length;
      if (lines < 50) {
        analysis.complexity = 'low';
      } else if (lines < 200) {
        analysis.complexity = 'medium';
      } else {
        analysis.complexity = 'high';
      }
    });
    
    return analysis;
  }
  
  private detectLanguage(codeBlocks: Array<{ language: string; code: string }>): string {
    if (codeBlocks.length === 0) return 'unknown';
    
    // Get most common language
    const languageCounts: Record<string, number> = {};
    codeBlocks.forEach(block => {
      languageCounts[block.language] = (languageCounts[block.language] || 0) + 1;
    });
    
    return Object.entries(languageCounts)
      .sort((a, b) => b[1] - a[1])[0][0];
  }
  
  private countLines(codeBlocks: Array<{ language: string; code: string }>): number {
    return codeBlocks.reduce((total, block) => {
      return total + block.code.split('\n').length;
    }, 0);
  }
}
