/**
 * Memory Triage Service
 *
 * Intelligently determines what storage paths each memory needs:
 * - Entity extraction (Neo4j via GraphitiService)
 * - Episodic storage (facts, relationships)
 * - Basic storage (PostgreSQL + Qdrant + Redis)
 *
 * Uses intelligent heuristics optimized for fast decision-making.
 * LLM triage was evaluated but heuristics provide better latency/quality tradeoff
 * for the triage use case (entity extraction already uses LLM when needed).
 */

import axios, { AxiosInstance } from 'axios';
import { logger } from '../utils/logger';

export interface TriageDecision {
  needsEntityExtraction: boolean;
  needsEpisodicStorage: boolean;
  contentType: 'conversational' | 'factual' | 'code' | 'document' | 'system';
  confidence: number;
  reason: string;
}

export interface TriageOptions {
  forceEntityExtraction?: boolean;
  forceEpisodicStorage?: boolean;
  metadata?: Record<string, any>;
}

export class MemoryTriage {
  private openRouterClient: AxiosInstance | null = null;
  private triageCount = 0;
  private llmTriageCount = 0;
  private heuristicTriageCount = 0;

  constructor(openRouterApiKey?: string) {
    const apiKey = openRouterApiKey || process.env.OPENROUTER_API_KEY;
    if (apiKey) {
      this.openRouterClient = axios.create({
        baseURL: 'https://openrouter.ai/api/v1',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          'HTTP-Referer': 'https://adverant.ai',
          'X-Title': 'Nexus Memory Triage'
        }
      });
      logger.info('MemoryTriage initialized with LLM support via OpenRouter');
    } else {
      logger.info('MemoryTriage initialized with heuristics only (no OpenRouter API key)');
    }
  }

  async analyze(content: string, options: TriageOptions = {}): Promise<TriageDecision> {
    this.triageCount++;
    const startTime = Date.now();

    // Fast path: if forced, skip analysis
    if (options.forceEntityExtraction || options.forceEpisodicStorage) {
      logger.debug('Triage: forced decision', {
        forceEntityExtraction: options.forceEntityExtraction,
        forceEpisodicStorage: options.forceEpisodicStorage
      });
      return {
        needsEntityExtraction: options.forceEntityExtraction || false,
        needsEpisodicStorage: options.forceEpisodicStorage || false,
        contentType: 'factual',
        confidence: 1.0,
        reason: 'forced_by_request'
      };
    }

    // Fast path: very short content doesn't need entity extraction
    if (content.length < 50) {
      return {
        needsEntityExtraction: false,
        needsEpisodicStorage: false,
        contentType: 'conversational',
        confidence: 0.9,
        reason: 'content_too_short'
      };
    }

    // Fast path: system messages and debug logs rarely need entities
    if (this.isSystemContent(content)) {
      return {
        needsEntityExtraction: false,
        needsEpisodicStorage: false,
        contentType: 'system',
        confidence: 0.85,
        reason: 'system_content_detected'
      };
    }

    // HEURISTIC-FIRST: Always run fast heuristics first
    // Only use LLM if heuristic confidence is low (uncertain cases)
    let decision = this.heuristicTriage(content);
    this.heuristicTriageCount++;

    // If heuristic is confident (>= 0.75), use it directly - skip LLM for 80%+ of requests
    // Only fall back to LLM for uncertain cases where heuristic score is borderline
    if (decision.confidence < 0.75 && this.openRouterClient) {
      logger.debug('Heuristic uncertain, using LLM for better accuracy', {
        heuristicConfidence: decision.confidence,
        contentLength: content.length
      });
      decision = await this.llmTriage(content);
      this.llmTriageCount++;
    }

    const latency = Date.now() - startTime;
    logger.debug('Triage completed', {
      contentLength: content.length,
      decision,
      latency,
      method: this.openRouterClient ? 'llm' : 'heuristic'
    });

    return decision;
  }

  private async llmTriage(content: string): Promise<TriageDecision> {
    try {
      const response = await this.openRouterClient!.post('/chat/completions', {
        model: 'anthropic/claude-sonnet-4.5',
        max_tokens: 200,
        temperature: 0.1,
        messages: [{
          role: 'user',
          content: `Analyze this content and determine if it contains extractable entities (people, organizations, locations, technologies, concepts) or factual relationships worth storing.

Content (first 500 chars):
${content.substring(0, 500)}

Respond in JSON only:
{
  "hasEntities": true/false,
  "hasFacts": true/false,
  "contentType": "conversational|factual|code|document|system",
  "reason": "brief explanation"
}`
        }]
      });

      const text = response.data?.choices?.[0]?.message?.content || '';

      // Try to parse JSON, handling potential markdown code blocks
      let jsonText = text.trim();
      if (jsonText.startsWith('```')) {
        jsonText = jsonText.replace(/```json?\n?/g, '').replace(/```/g, '').trim();
      }

      const parsed = JSON.parse(jsonText);

      return {
        needsEntityExtraction: parsed.hasEntities === true,
        needsEpisodicStorage: parsed.hasFacts === true || parsed.hasEntities === true,
        contentType: parsed.contentType || 'factual',
        confidence: 0.85,
        reason: parsed.reason || 'llm_analysis'
      };
    } catch (err: any) {
      logger.warn('LLM triage failed, falling back to heuristics', { error: err.message });
      return this.heuristicTriage(content);
    }
  }

  private heuristicTriage(content: string): TriageDecision {
    const lower = content.toLowerCase();

    // Check for entity indicators
    const hasProperNouns = /[A-Z][a-z]+(?:\s+[A-Z][a-z]+)*/.test(content);
    const hasTechTerms = /\b(API|SDK|React|Python|Kubernetes|Docker|PostgreSQL|TypeScript|JavaScript|Node\.js|AWS|Azure|GCP)\b/i.test(content);
    const hasOrganizations = /\b(Inc\.|Corp\.|Ltd\.|LLC|Company|University|Institute|Microsoft|Google|Amazon|Apple|Meta|OpenAI|Anthropic)\b/i.test(content);
    const hasLocations = /\b(Street|Avenue|City|State|Country|California|New York|London|San Francisco|Seattle|Tokyo|Paris)\b/i.test(content);
    const hasPersonIndicators = /\b(Mr\.|Mrs\.|Ms\.|Dr\.|Prof\.|CEO|CTO|CFO|founder|author|developer)\b/i.test(content);

    // Check for factual content
    const hasRelationships = /\b(is|are|was|were|has|have|works at|founded|created|built|developed|designed|implemented)\b/i.test(lower);
    const hasDefinitions = /\b(means|refers to|is defined as|is called|stands for)\b/i.test(lower);
    const hasQuantities = /\b\d+\s*(users?|customers?|employees?|dollars?|percent|years?|months?|days?)\b/i.test(content);

    // Score calculation
    const entityScore =
      (hasProperNouns ? 0.25 : 0) +
      (hasTechTerms ? 0.2 : 0) +
      (hasOrganizations ? 0.25 : 0) +
      (hasLocations ? 0.15 : 0) +
      (hasPersonIndicators ? 0.15 : 0);

    const factScore =
      (hasRelationships ? 0.4 : 0) +
      (hasDefinitions ? 0.3 : 0) +
      (hasQuantities ? 0.3 : 0);

    const needsEntities = entityScore >= 0.4;
    const needsEpisodic = needsEntities || factScore >= 0.5;

    // Dynamic confidence based on signal strength
    // High scores (clear signals) = high confidence, borderline scores = low confidence
    const maxScore = Math.max(entityScore, factScore);
    let confidence: number;
    if (maxScore >= 0.7 || maxScore <= 0.2) {
      // Strong signal (either clearly needs extraction or clearly doesn't)
      confidence = 0.9;
    } else if (maxScore >= 0.5 || maxScore <= 0.3) {
      // Moderate signal
      confidence = 0.8;
    } else {
      // Borderline - uncertain, may need LLM verification
      confidence = 0.65;
    }

    return {
      needsEntityExtraction: needsEntities,
      needsEpisodicStorage: needsEpisodic,
      contentType: this.detectContentType(content),
      confidence,
      reason: `heuristic: entity_score=${entityScore.toFixed(2)}, fact_score=${factScore.toFixed(2)}`
    };
  }

  private isSystemContent(content: string): boolean {
    const systemIndicators = [
      /^\[DEBUG\]/i,
      /^\[INFO\]/i,
      /^\[ERROR\]/i,
      /^\[WARN\]/i,
      /^System:/i,
      /^Assistant:/i,
      /^User:/i,
      /^{"timestamp"/,
      /^---\s*$/m,
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/,  // ISO timestamp at start
      /^[A-Z_]+=/  // ENV variable format
    ];
    return systemIndicators.some(pattern => pattern.test(content));
  }

  private detectContentType(content: string): TriageDecision['contentType'] {
    // Code detection - comprehensive patterns
    if (/```|\bfunction\s|\bclass\s|\bimport\s|\bconst\s|\blet\s|\bvar\s|\basync\s|\bawait\s/.test(content)) {
      return 'code';
    }

    // Document detection - markdown headers, formatting
    if (/^#|\*\*|##|\[.*\]\(.*\)/.test(content)) {
      return 'document';
    }

    // System content
    if (this.isSystemContent(content)) {
      return 'system';
    }

    // Conversational - questions, greetings, short responses
    if (/\?$|\bplease\b|\bthanks\b|\bhello\b|\bhi\b|\bhey\b/i.test(content)) {
      return 'conversational';
    }

    return 'factual';
  }

  /**
   * FAST PATH: Heuristic-only triage (no LLM)
   *
   * Use this for async-first storage where latency is critical.
   * Returns in ~5ms instead of 500-2000ms with LLM.
   *
   * @param content - Content to analyze
   * @returns TriageDecision based on heuristics only
   */
  heuristicTriageOnly(content: string): TriageDecision {
    this.triageCount++;
    this.heuristicTriageCount++;

    // Fast path: very short content doesn't need entity extraction
    if (content.length < 50) {
      return {
        needsEntityExtraction: false,
        needsEpisodicStorage: false,
        contentType: 'conversational',
        confidence: 0.9,
        reason: 'content_too_short'
      };
    }

    // Fast path: system messages and debug logs rarely need entities
    if (this.isSystemContent(content)) {
      return {
        needsEntityExtraction: false,
        needsEpisodicStorage: false,
        contentType: 'system',
        confidence: 0.85,
        reason: 'system_content_detected'
      };
    }

    return this.heuristicTriage(content);
  }

  /**
   * Get triage statistics
   */
  getStats(): { total: number; llm: number; heuristic: number } {
    return {
      total: this.triageCount,
      llm: this.llmTriageCount,
      heuristic: this.heuristicTriageCount
    };
  }
}

// Singleton instance
let triageInstance: MemoryTriage | null = null;

export function getMemoryTriage(openRouterApiKey?: string): MemoryTriage {
  if (!triageInstance) {
    triageInstance = new MemoryTriage(openRouterApiKey || process.env.OPENROUTER_API_KEY);
  }
  return triageInstance;
}

export function resetMemoryTriage(): void {
  triageInstance = null;
}
