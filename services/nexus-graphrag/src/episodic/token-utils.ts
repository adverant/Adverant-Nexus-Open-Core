/**
 * Token Estimation Utilities for Episodic Memory
 *
 * Provides fast, accurate token counting for response size control.
 * Uses GPT-4 tokenization rules (1 token ≈ 4 characters for English).
 */

/**
 * Estimate token count for text content
 * Uses 4:1 character-to-token ratio (conservative for JSON overhead)
 *
 * @param text - Text content to estimate
 * @returns Estimated token count
 */
export function estimateTokens(text: string): number {
  if (!text || typeof text !== 'string') return 0;

  // Base character count
  const charCount = text.length;

  // GPT-4 tokenization: ~4 chars per token for English
  // Add 20% overhead for JSON structure, keys, commas, quotes
  const baseTokens = Math.ceil(charCount / 4);
  const jsonOverhead = Math.ceil(baseTokens * 0.2);

  return baseTokens + jsonOverhead;
}

/**
 * Estimate tokens for a JSON object
 * Includes overhead for keys, structure, and formatting
 *
 * @param obj - Object to estimate tokens for
 * @returns Estimated token count
 */
export function estimateObjectTokens(obj: any): number {
  if (obj === null || obj === undefined) return 0;

  try {
    // Stringify to get accurate size including structure
    const jsonString = JSON.stringify(obj);
    return estimateTokens(jsonString);
  } catch (error) {
    // Fallback for circular references or non-serializable objects
    return estimateTokens(String(obj));
  }
}

/**
 * Truncate text to fit within token budget
 * Adds ellipsis (...) to indicate truncation
 *
 * @param text - Text to truncate
 * @param maxTokens - Maximum tokens allowed
 * @returns Truncated text with ellipsis if needed
 */
export function truncateToTokens(text: string, maxTokens: number): string {
  if (!text || typeof text !== 'string') return '';

  // Calculate max characters (4 chars per token, minus ellipsis)
  const maxChars = (maxTokens * 4) - 3;  // Reserve 3 chars for "..."

  if (text.length <= maxChars) {
    return text;
  }

  // Truncate and add ellipsis
  return text.substring(0, maxChars) + '...';
}

/**
 * Generate summary from content with token budget
 * Extracts first sentence or paragraph, respecting token limit
 *
 * @param content - Full content to summarize
 * @param maxTokens - Maximum tokens for summary (default: 50)
 * @returns Content summary
 */
export function generateSummary(content: string, maxTokens: number = 50): string {
  if (!content || typeof content !== 'string') return '';

  // Try to find first complete sentence (handles abbreviations like Dr., Inc., etc.)
  const firstSentence = content.match(/^(?:(?:Mr|Mrs|Ms|Dr|Prof|Inc|Ltd|Corp|Co|Jr|Sr|vs|etc|e\.g|i\.e)\.|[^.!?])+[.!?]/);
  if (firstSentence) {
    const sentence = firstSentence[0].trim();
    const sentenceTokens = estimateTokens(sentence);

    if (sentenceTokens <= maxTokens) {
      return sentence;
    }
  }

  // Fallback: truncate to token limit
  return truncateToTokens(content, maxTokens);
}

/**
 * Token budget manager for episode recall responses
 * Tracks total tokens and provides allocation logic
 */
export class TokenBudgetManager {
  private totalBudget: number;
  private used: number = 0;
  private overhead: number;

  constructor(totalBudget: number = 4000) {
    this.totalBudget = totalBudget;
    // Reserve 10% for response structure overhead
    this.overhead = Math.ceil(totalBudget * 0.1);
  }

  /**
   * Get available tokens for content
   */
  getAvailable(): number {
    return Math.max(0, this.totalBudget - this.overhead - this.used);
  }

  /**
   * Allocate tokens for an item
   * @returns true if allocation succeeded, false if budget exceeded
   */
  allocate(tokens: number): boolean {
    if (tokens > this.getAvailable()) {
      return false;
    }

    this.used += tokens;
    return true;
  }

  /**
   * Get total tokens used (including overhead)
   */
  getUsed(): number {
    return this.used + this.overhead;
  }

  /**
   * Check if budget is exhausted (< 5% remaining)
   */
  isExhausted(): boolean {
    const remaining = this.getAvailable();
    const percentRemaining = (remaining / this.totalBudget) * 100;
    return percentRemaining < 5;
  }

  /**
   * Get budget statistics
   */
  getStats(): {
    total: number;
    used: number;
    available: number;
    overhead: number;
    percentUsed: number;
  } {
    const available = this.getAvailable();
    const used = this.used;

    return {
      total: this.totalBudget,
      used,
      available,
      overhead: this.overhead,
      percentUsed: (used / this.totalBudget) * 100
    };
  }
}

/**
 * Calculate tokens per episode for different response levels
 * Used for pre-allocation and capacity planning
 */
export const TOKENS_PER_EPISODE = {
  summary: 80,   // ~300 chars (id, timestamp, summary, scores)
  medium: 200,   // ~800 chars (+ content preview, entities)
  full: 800      // ~3200 chars (complete episode with relationships)
} as const;

/**
 * Calculate how many episodes fit in token budget
 *
 * @param budget - Total token budget
 * @param level - Response level
 * @returns Maximum episodes that fit in budget
 */
export function calculateEpisodeCapacity(
  budget: number,
  level: 'summary' | 'medium' | 'full'
): number {
  const tokensPerEpisode = TOKENS_PER_EPISODE[level];
  const overhead = Math.ceil(budget * 0.1);  // 10% overhead
  const available = budget - overhead;

  return Math.floor(available / tokensPerEpisode);
}
