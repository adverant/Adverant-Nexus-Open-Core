import { OpenRouterClient } from '../clients/openrouter-client';
import { logger } from '../utils/logger';
import { config } from '../config';

/**
 * Operation types supported by MageAgent
 */
export type OperationType =
  | 'orchestrate'     // General task execution with multiple agents
  | 'competition'     // Multiple agents competing
  | 'analyze'         // Deep analysis of a topic
  | 'synthesize'      // Combine information from multiple sources
  | 'collaborate'     // Agents working together iteratively
  | 'search'          // Search for information or memories
  | 'store'           // Store memories, patterns, or documents
  // New workflow-related operations:
  | 'workflow'        // Multi-service workflow (e.g., "download and scan")
  | 'file_process'    // File/document processing
  | 'security_scan'   // Security/malware scanning
  | 'code_execute'    // Code execution in sandbox
  | 'unknown';        // Cannot determine operation

export interface IntentClassification {
  operation: OperationType;
  confidence: number;
  extractedParams: {
    task?: string;
    context?: any;
    maxAgents?: number;
    timeout?: number;
    competitorCount?: number;
    evaluationCriteria?: string[];
    sources?: string[];
    format?: string;
    objective?: string;
    agents?: any[];
    iterations?: number;
    depth?: string;
    includeMemory?: boolean;
    // New workflow-related params:
    url?: string;
    fileUrl?: string;
    driveUrl?: string;
    filename?: string;
    mimeType?: string;
    enableOcr?: boolean;
    extractTables?: boolean;
    target?: string;
    scanType?: 'malware' | 'vulnerability' | 'threat';
    code?: string;
    language?: string;
    packages?: string[];
    workflowSteps?: string[];
  };
  reasoning: string;
}

export class IntentClassifierService {
  private openRouterClient: OpenRouterClient | null = null;
  private modelId = 'anthropic/claude-3-haiku-20240307'; // Fast, cheap model for classification

  constructor() {
    const apiKey = process.env.OPENROUTER_API_KEY;
    if (apiKey) {
      this.openRouterClient = new OpenRouterClient(
        apiKey,
        config.openRouter?.baseUrl || 'https://openrouter.ai/api/v1'
      );
      logger.info('Intent classifier initialized with OpenRouter');
    } else {
      logger.warn('OpenRouter API key not found, falling back to keyword matching');
    }
  }

  async classifyIntent(input: string | any): Promise<IntentClassification> {
    // If OpenRouter is not available, fall back to enhanced keyword matching
    if (!this.openRouterClient) {
      return this.keywordBasedClassification(input);
    }

    try {
      const inputText = typeof input === 'string' ? input : JSON.stringify(input);

      const systemPrompt = `You are an intent classifier for a multi-agent orchestration system. Analyze the user input and determine:
1. The operation type from: orchestrate, competition, analyze, synthesize, collaborate, search, store, workflow, file_process, security_scan, code_execute, unknown
2. Extract relevant parameters based on the operation
3. Provide confidence score (0-1)
4. Brief reasoning

Operations:
- orchestrate: General task execution with multiple agents
- competition: Multiple agents competing to solve a challenge
- analyze: Deep analysis of a topic
- synthesize: Combine information from multiple sources
- collaborate: Agents working together iteratively
- search: Search for information or memories
- store: Store memories, patterns, or documents
- workflow: Multi-service workflow that chains operations (e.g., "download this file and scan it for viruses")
- file_process: File/document processing (download, extract, OCR, parse PDFs, etc.)
- security_scan: Security scanning (malware, virus, vulnerability, threat detection)
- code_execute: Code execution in sandbox environment
- unknown: Cannot determine operation

Key indicators for new operations:
- workflow: Contains "and then", "then", "after that" with multiple actions; involves file + scanning; chained operations
- file_process: URLs to files, "download", "extract", "process PDF", "OCR", "parse document", Google Drive links
- security_scan: "virus", "malware", "scan", "security", "threat", "vulnerability", "check for threats"
- code_execute: "run code", "execute script", "python", "javascript", code blocks

Output JSON only:
{
  "operation": "string",
  "confidence": number,
  "extractedParams": {},
  "reasoning": "string"
}`;

      const response = await this.openRouterClient.createCompletion({
        model: this.modelId,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: `Classify this input: ${inputText}` }
        ],
        max_tokens: 500,
        temperature: 0.1, // Low temperature for consistent classification
        response_format: { type: 'json_object' }
      });

      const classification = JSON.parse(response.choices[0].message.content);

      logger.debug('LLM classification result', classification);

      return classification;
    } catch (error) {
      logger.error('LLM classification failed, falling back to keywords', { error });
      return this.keywordBasedClassification(input);
    }
  }

  private keywordBasedClassification(input: string | any): IntentClassification {
    const inputText = typeof input === 'string' ? input :
                     (input.input || input.prompt || input.task || input.query || JSON.stringify(input));
    const inputLower = inputText.toLowerCase();

    // Check for multi-service workflow patterns FIRST (highest priority)
    // Workflow indicators: chained actions with "and", "then", etc.
    const hasFileAction = inputLower.includes('download') || inputLower.includes('file') ||
                         inputLower.includes('pdf') || inputLower.includes('document') ||
                         inputLower.includes('drive.google.com');
    const hasSecurityAction = inputLower.includes('virus') || inputLower.includes('malware') ||
                             inputLower.includes('scan') || inputLower.includes('security') ||
                             inputLower.includes('threat');
    const hasChainIndicator = inputLower.includes(' and ') || inputLower.includes(' then ') ||
                             inputLower.includes('after that') || inputLower.includes(', ');

    if (hasChainIndicator && (hasFileAction && hasSecurityAction)) {
      return {
        operation: 'workflow',
        confidence: 0.85,
        extractedParams: this.extractWorkflowParams(input),
        reasoning: 'Multi-step workflow detected: file processing + security scanning'
      };
    }

    // Security scan operations
    if (hasSecurityAction) {
      return {
        operation: 'security_scan',
        confidence: 0.8,
        extractedParams: this.extractSecurityScanParams(input),
        reasoning: 'Keywords suggest security/malware scanning'
      };
    }

    // File processing operations
    if (inputLower.includes('download') || inputLower.includes('process pdf') ||
        inputLower.includes('extract') || inputLower.includes('ocr') ||
        inputLower.includes('parse document') || inputLower.includes('drive.google.com') ||
        inputLower.match(/https?:\/\/.*\.(pdf|docx?|xlsx?|pptx?|zip|tar)/i)) {
      return {
        operation: 'file_process',
        confidence: 0.8,
        extractedParams: this.extractFileProcessParams(input),
        reasoning: 'Keywords or URL suggest file processing'
      };
    }

    // Code execution operations
    if (inputLower.includes('run code') || inputLower.includes('execute') ||
        inputLower.includes('```python') || inputLower.includes('```javascript') ||
        inputLower.includes('```bash') || inputLower.includes('script')) {
      return {
        operation: 'code_execute',
        confidence: 0.75,
        extractedParams: this.extractCodeExecuteParams(input),
        reasoning: 'Keywords or code blocks suggest code execution'
      };
    }

    // Enhanced keyword matching with context understanding
    if (inputLower.includes('compete') || inputLower.includes('competition') ||
        inputLower.includes('versus') || inputLower.includes('vs')) {
      return {
        operation: 'competition',
        confidence: 0.7,
        extractedParams: this.extractCompetitionParams(input),
        reasoning: 'Keywords suggest competition between agents'
      };
    }

    if (inputLower.includes('analyze') || inputLower.includes('analysis') ||
        inputLower.includes('examine') || inputLower.includes('investigate')) {
      return {
        operation: 'analyze',
        confidence: 0.7,
        extractedParams: this.extractAnalyzeParams(input),
        reasoning: 'Keywords suggest deep analysis'
      };
    }

    if (inputLower.includes('synthesize') || inputLower.includes('combine') ||
        inputLower.includes('merge') || inputLower.includes('integrate')) {
      return {
        operation: 'synthesize',
        confidence: 0.7,
        extractedParams: this.extractSynthesizeParams(input),
        reasoning: 'Keywords suggest synthesis of information'
      };
    }

    if (inputLower.includes('collaborate') || inputLower.includes('together') ||
        inputLower.includes('cooperate') || inputLower.includes('team')) {
      return {
        operation: 'collaborate',
        confidence: 0.7,
        extractedParams: this.extractCollaborateParams(input),
        reasoning: 'Keywords suggest collaboration'
      };
    }

    if (inputLower.includes('search') || inputLower.includes('find') ||
        inputLower.includes('recall') || inputLower.includes('remember')) {
      return {
        operation: 'search',
        confidence: 0.7,
        extractedParams: this.extractSearchParams(input),
        reasoning: 'Keywords suggest search or recall'
      };
    }

    if (inputLower.includes('store') || inputLower.includes('save') ||
        inputLower.includes('record') || inputLower.includes('memorize')) {
      return {
        operation: 'store',
        confidence: 0.7,
        extractedParams: this.extractStoreParams(input),
        reasoning: 'Keywords suggest storing information'
      };
    }

    // Default to orchestrate for general tasks
    if (inputLower.length > 10) {
      return {
        operation: 'orchestrate',
        confidence: 0.5,
        extractedParams: this.extractOrchestrateParams(input),
        reasoning: 'Default to orchestrate for general tasks'
      };
    }

    return {
      operation: 'unknown',
      confidence: 0.1,
      extractedParams: {},
      reasoning: 'Could not determine operation from input'
    };
  }

  private extractOrchestrateParams(input: any): any {
    if (typeof input === 'string') {
      return {
        task: input,
        maxAgents: 3,
        timeout: 60000
      };
    }
    return {
      task: input.task || input.prompt || input.input,
      context: input.context,
      maxAgents: input.maxAgents || 3,
      timeout: input.timeout || 60000
    };
  }

  private extractCompetitionParams(input: any): any {
    if (typeof input === 'string') {
      return {
        task: input,
        competitorCount: 3,
        timeout: 90000
      };
    }
    return {
      task: input.challenge || input.task || input.input,
      competitorCount: input.competitorCount || 3,
      evaluationCriteria: input.evaluationCriteria,
      timeout: input.timeout || 90000
    };
  }

  private extractAnalyzeParams(input: any): any {
    if (typeof input === 'string') {
      return {
        task: input,
        depth: 'standard',
        includeMemory: true
      };
    }
    return {
      task: input.topic || input.task || input.input,
      depth: input.depth || 'standard',
      includeMemory: input.includeMemory !== false
    };
  }

  private extractSynthesizeParams(input: any): any {
    if (typeof input === 'string') {
      return {
        sources: [input],
        format: 'summary'
      };
    }
    return {
      sources: input.sources || [input.input],
      objective: input.objective,
      format: input.format || 'summary'
    };
  }

  private extractCollaborateParams(input: any): any {
    if (typeof input === 'string') {
      return {
        objective: input,
        iterations: 2
      };
    }
    return {
      objective: input.objective || input.task || input.input,
      agents: input.agents,
      iterations: input.iterations || 2
    };
  }

  private extractSearchParams(input: any): any {
    if (typeof input === 'string') {
      return {
        query: input,
        limit: 10
      };
    }
    return {
      query: input.query || input.input,
      limit: input.limit || 10,
      tags: input.tags
    };
  }

  private extractStoreParams(input: any): any {
    if (typeof input === 'string') {
      return {
        content: input
      };
    }
    return {
      content: input.content || input.input,
      tags: input.tags,
      metadata: input.metadata
    };
  }

  private extractWorkflowParams(input: any): any {
    const inputText = typeof input === 'string' ? input : (input.input || input.task || input.prompt || '');

    // Extract URLs from the text
    const urlMatch = inputText.match(/https?:\/\/[^\s]+/i);
    const url = urlMatch ? urlMatch[0] : undefined;

    // Detect if it's a Google Drive URL
    const isGoogleDrive = url?.includes('drive.google.com') || url?.includes('docs.google.com');

    return {
      task: inputText,
      url: url,
      fileUrl: !isGoogleDrive ? url : undefined,
      driveUrl: isGoogleDrive ? url : undefined,
      workflowSteps: this.detectWorkflowSteps(inputText),
      timeout: 300000 // 5 minutes for multi-step workflows
    };
  }

  private extractFileProcessParams(input: any): any {
    const inputText = typeof input === 'string' ? input : (input.input || input.task || input.prompt || '');

    // Extract URLs from the text
    const urlMatch = inputText.match(/https?:\/\/[^\s]+/i);
    const url = urlMatch ? urlMatch[0] : undefined;

    // Detect if it's a Google Drive URL
    const isGoogleDrive = url?.includes('drive.google.com') || url?.includes('docs.google.com');

    // Extract filename from URL if present
    let filename: string | undefined;
    if (url) {
      const urlParts = url.split('/');
      const lastPart = urlParts[urlParts.length - 1].split('?')[0];
      if (lastPart.includes('.')) {
        filename = decodeURIComponent(lastPart);
      }
    }

    return {
      task: inputText,
      url: url,
      fileUrl: !isGoogleDrive ? url : undefined,
      driveUrl: isGoogleDrive ? url : undefined,
      filename: filename,
      enableOcr: inputText.toLowerCase().includes('ocr') ||
                 inputText.toLowerCase().includes('text recognition'),
      extractTables: inputText.toLowerCase().includes('table') ||
                    inputText.toLowerCase().includes('spreadsheet'),
      timeout: 300000 // 5 minutes for file processing
    };
  }

  private extractSecurityScanParams(input: any): any {
    const inputText = typeof input === 'string' ? input : (input.input || input.task || input.prompt || '');
    const inputLower = inputText.toLowerCase();

    // Determine scan type
    let scanType: 'malware' | 'vulnerability' | 'threat' = 'malware';
    if (inputLower.includes('vulnerability') || inputLower.includes('vuln')) {
      scanType = 'vulnerability';
    } else if (inputLower.includes('threat')) {
      scanType = 'threat';
    }

    // Extract target (URL or file reference)
    const urlMatch = inputText.match(/https?:\/\/[^\s]+/i);
    const target = urlMatch ? urlMatch[0] : inputText;

    return {
      task: inputText,
      target: target,
      scanType: scanType,
      timeout: 180000 // 3 minutes for security scans
    };
  }

  private extractCodeExecuteParams(input: any): any {
    const inputText = typeof input === 'string' ? input : (input.input || input.task || input.prompt || '');
    const inputLower = inputText.toLowerCase();

    // Detect language
    let language = 'python'; // default
    if (inputLower.includes('javascript') || inputLower.includes('```js') || inputLower.includes('```javascript')) {
      language = 'node';
    } else if (inputLower.includes('bash') || inputLower.includes('```bash') || inputLower.includes('shell')) {
      language = 'bash';
    } else if (inputLower.includes('```python') || inputLower.includes('python')) {
      language = 'python';
    } else if (inputLower.includes('```go') || inputLower.includes('golang')) {
      language = 'go';
    } else if (inputLower.includes('```rust')) {
      language = 'rust';
    }

    // Extract code block if present
    const codeMatch = inputText.match(/```(?:\w+)?\n([\s\S]*?)```/);
    const code = codeMatch ? codeMatch[1].trim() : undefined;

    return {
      task: inputText,
      code: code,
      language: language,
      timeout: 60000 // 1 minute for code execution
    };
  }

  /**
   * Detect workflow steps from natural language
   */
  private detectWorkflowSteps(text: string): string[] {
    const steps: string[] = [];
    const textLower = text.toLowerCase();

    // File processing step detection
    if (textLower.includes('download') || textLower.includes('file') ||
        textLower.includes('pdf') || textLower.includes('document')) {
      steps.push('file_process');
    }

    // Security scan step detection
    if (textLower.includes('virus') || textLower.includes('malware') ||
        textLower.includes('scan') || textLower.includes('security')) {
      steps.push('security_scan');
    }

    // Analysis step detection
    if (textLower.includes('analyze') || textLower.includes('summarize') ||
        textLower.includes('pii') || textLower.includes('extract')) {
      steps.push('analysis');
    }

    // Storage step detection
    if (textLower.includes('save') || textLower.includes('store') ||
        textLower.includes('remember')) {
      steps.push('store');
    }

    return steps;
  }
}

// Singleton instance
export const intentClassifier = new IntentClassifierService();