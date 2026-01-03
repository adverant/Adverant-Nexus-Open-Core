/**
 * Domain Router
 * Automatically classifies requests and routes to appropriate domain handlers
 * Uses OpenRouter models (NO FREE MODELS) for intelligent classification
 */

import { logger } from '../utils/logger';
import { getModelEngine, TaskType } from '../models/model-engine';
import { UniversalDomain } from '../entities/universal-entity';

export interface DomainClassificationRequest {
  content: string; // User query or content to classify
  context?: string; // Additional context
  hints?: string[]; // Optional hints from user or system
}

export interface DomainClassificationResult {
  primaryDomain: UniversalDomain;
  confidence: number; // 0-1
  secondaryDomains?: UniversalDomain[];
  reasoning: string;
  suggestedTaskType?: TaskType;
}

export interface RouteDecision {
  domain: UniversalDomain;
  taskType: TaskType;
  confidence: number;
  shouldUseLLM: boolean; // Whether to use LLM for classification
  reasoning: string;
}

export class DomainRouter {
  private modelEngine = getModelEngine();

  // Keyword-based classification rules (fast path)
  private readonly domainKeywords = {
    creative_writing: [
      'chapter', 'character', 'story', 'plot', 'novel', 'book', 'scene',
      'protagonist', 'antagonist', 'dialogue', 'narrative', 'fiction', 'writing',
      'series', 'trilogy', 'author', 'manuscript', 'draft', 'revision'
    ],
    code: [
      'function', 'class', 'method', 'variable', 'const', 'import', 'export',
      'component', 'module', 'package', 'library', 'framework', 'api', 'endpoint',
      'bug', 'error', 'debug', 'test', 'unit test', 'integration', 'typescript',
      'javascript', 'python', 'java', 'react', 'node', 'backend', 'frontend'
    ],
    medical: [
      'patient', 'diagnosis', 'treatment', 'medication', 'symptom', 'disease',
      'clinical', 'medical', 'hospital', 'doctor', 'physician', 'nurse',
      'prescription', 'dosage', 'therapy', 'surgery', 'procedure', 'study',
      'trial', 'research', 'health', 'wellness', 'condition', 'syndrome'
    ],
    legal: [
      'case', 'statute', 'regulation', 'law', 'court', 'judge', 'attorney',
      'lawyer', 'contract', 'agreement', 'clause', 'liability', 'plaintiff',
      'defendant', 'precedent', 'ruling', 'legal', 'litigation', 'settlement',
      'jurisdiction', 'evidence', 'testimony', 'brief', 'motion'
    ],
    conversation: [
      'chat', 'talk', 'discuss', 'conversation', 'interaction', 'dialogue',
      'question', 'answer', 'clarify', 'explain', 'tell me', 'help me'
    ]
  };

  constructor() {
    logger.info('Domain Router initialized');
  }

  /**
   * Classify content into appropriate domain
   */
  async classify(request: DomainClassificationRequest): Promise<DomainClassificationResult> {
    try {
      // First try fast keyword-based classification
      const keywordResult = this.classifyByKeywords(request.content);

      if (keywordResult.confidence > 0.8) {
        // High confidence from keywords - no need for LLM
        logger.debug('Domain classified by keywords', {
          domain: keywordResult.primaryDomain,
          confidence: keywordResult.confidence
        });
        return keywordResult;
      }

      // Low confidence - use LLM for accurate classification
      logger.debug('Using LLM for domain classification (low keyword confidence)');

      const llmResult = await this.classifyWithLLM(request);

      logger.info('Domain classified', {
        domain: llmResult.primaryDomain,
        confidence: llmResult.confidence,
        method: 'llm'
      });

      return llmResult;
    } catch (error) {
      logger.error('Failed to classify domain', { error, request });

      // Fallback to 'general' domain
      return {
        primaryDomain: 'general',
        confidence: 0.5,
        reasoning: 'Classification failed, defaulting to general domain',
        suggestedTaskType: 'generation'
      };
    }
  }

  /**
   * Make routing decision (includes domain + task type)
   */
  async route(request: DomainClassificationRequest): Promise<RouteDecision> {
    const classification = await this.classify(request);

    const taskType = classification.suggestedTaskType || this.inferTaskType(request.content);

    return {
      domain: classification.primaryDomain,
      taskType,
      confidence: classification.confidence,
      shouldUseLLM: classification.confidence < 0.8,
      reasoning: classification.reasoning
    };
  }

  /**
   * Classify using keyword matching (fast path)
   */
  private classifyByKeywords(content: string): DomainClassificationResult {
    const lowerContent = content.toLowerCase();
    const scores: Record<string, number> = {};

    // Count keyword matches for each domain
    for (const [domain, keywords] of Object.entries(this.domainKeywords)) {
      let score = 0;
      for (const keyword of keywords) {
        if (lowerContent.includes(keyword.toLowerCase())) {
          score += 1;
        }
      }
      scores[domain] = score;
    }

    // Find domain with highest score
    let maxScore = 0;
    let primaryDomain: UniversalDomain = 'general';

    for (const [domain, score] of Object.entries(scores)) {
      if (score > maxScore) {
        maxScore = score;
        primaryDomain = domain as UniversalDomain;
      }
    }

    // Calculate confidence (normalize by content length and keyword count)
    // Total keywords available: Object.values(this.domainKeywords).flat().length
    const confidence = Math.min(maxScore / 5, 1.0); // Cap at 1.0

    // Find secondary domains
    const secondaryDomains = Object.entries(scores)
      .filter(([domain, score]) => score > 0 && domain !== primaryDomain)
      .sort(([, a], [, b]) => b - a)
      .slice(0, 2)
      .map(([domain]) => domain as UniversalDomain);

    return {
      primaryDomain,
      confidence,
      secondaryDomains: secondaryDomains.length > 0 ? secondaryDomains : undefined,
      reasoning: `Keyword-based classification: ${maxScore} matches found`,
      suggestedTaskType: this.inferTaskType(content)
    };
  }

  /**
   * Classify using LLM (accurate but slower)
   */
  private async classifyWithLLM(request: DomainClassificationRequest): Promise<DomainClassificationResult> {
    if (!this.modelEngine.isInitialized()) {
      logger.warn('Model engine not initialized, falling back to keyword classification');
      return this.classifyByKeywords(request.content);
    }

    try {
      // Get model recommendation for classification task
      await this.modelEngine.recommend({
        task: 'classification',
        domain: 'general',
        contextSize: 4000
      });

      // Build classification prompt (for future LLM integration)
      this.buildClassificationPrompt(request);

      // TODO: Integrate with OpenRouter client to actually call the model
      // For now, fall back to keyword classification
      // In production, you would call:
      // const response = await openRouterClient.complete({ model: modelRecommendation.model.id, prompt });

      logger.warn('LLM classification not yet implemented, falling back to keywords');
      const keywordResult = this.classifyByKeywords(request.content);

      return {
        ...keywordResult,
        reasoning: `${keywordResult.reasoning} (LLM classification not yet available)`
      };
    } catch (error) {
      logger.error('LLM classification failed', { error });
      return this.classifyByKeywords(request.content);
    }
  }

  /**
   * Build prompt for LLM classification
   */
  private buildClassificationPrompt(request: DomainClassificationRequest): string {
    return `
You are a domain classification expert. Classify the following content into one of these domains:
- creative_writing: novels, stories, characters, plot development
- code: software development, programming, debugging, APIs
- medical: healthcare, patient care, clinical research, medications
- legal: laws, contracts, cases, regulations
- conversation: general chat, questions, explanations
- general: anything that doesn't fit the above categories

Content to classify:
${request.content}

${request.context ? `Additional context:\n${request.context}\n` : ''}
${request.hints && request.hints.length > 0 ? `Hints: ${request.hints.join(', ')}\n` : ''}

Respond in JSON format:
{
  "domain": "the_domain_name",
  "confidence": 0.95,
  "reasoning": "brief explanation",
  "secondaryDomains": ["optional", "alternative domains"]
}
    `.trim();
  }

  /**
   * Infer task type from content
   */
  private inferTaskType(content: string): TaskType {
    const lowerContent = content.toLowerCase();

    // Storage/generation keywords
    if (lowerContent.includes('store') || lowerContent.includes('save') ||
        lowerContent.includes('create') || lowerContent.includes('write') ||
        lowerContent.includes('generate')) {
      return 'generation';
    }

    // Retrieval keywords - map to 'document_analysis'
    if (lowerContent.includes('retrieve') || lowerContent.includes('find') ||
        lowerContent.includes('search') || lowerContent.includes('recall') ||
        lowerContent.includes('get') || lowerContent.includes('show me')) {
      return 'document_analysis';
    }

    // Code keywords
    if (lowerContent.includes('function') || lowerContent.includes('code') ||
        lowerContent.includes('implement') || lowerContent.includes('refactor')) {
      return 'code_generation';
    }

    // Analysis keywords
    if (lowerContent.includes('analyz') || lowerContent.includes('explain') ||
        lowerContent.includes('understand') || lowerContent.includes('why')) {
      return 'document_analysis';
    }

    // Classification keywords
    if (lowerContent.includes('classify') || lowerContent.includes('categorize') ||
        lowerContent.includes('what type') || lowerContent.includes('what kind')) {
      return 'classification';
    }

    // Default
    return 'generation';
  }

  /**
   * Check if content is cross-domain (spans multiple domains)
   */
  isCrossDomain(classification: DomainClassificationResult): boolean {
    return (classification.secondaryDomains && classification.secondaryDomains.length > 0) || false;
  }

  /**
   * Get all domains involved in a classification
   */
  getAllDomains(classification: DomainClassificationResult): UniversalDomain[] {
    const domains = [classification.primaryDomain];
    if (classification.secondaryDomains) {
      domains.push(...classification.secondaryDomains);
    }
    return domains;
  }
}
