/**
 * Entity Resolution Service
 *
 * Provides automatic entity deduplication using:
 * 1. Levenshtein distance (fast, catches typos and variations)
 * 2. Voyage AI reranking (semantic similarity for context-aware matching)
 *
 * Examples:
 * - "Dr. Emily Chen" ↔ "Emily Chen" (0.85 similarity)
 * - "Microsoft Corporation" ↔ "Microsoft" (0.90 similarity)
 * - "NYC" ↔ "New York City" (semantic match via reranking)
 */

import { VoyageAIUnifiedClient } from '../clients/voyage-ai-unified-client';
import { logger } from '../utils/logger';

export interface EntityCandidate {
  id: string;
  name: string;
  type?: string;
}

export interface DuplicateMatch {
  id: string;
  name: string;
  similarity: number;
  method: 'levenshtein' | 'voyage_rerank' | 'exact';
}

export interface MergeResult {
  merged: boolean;
  targetEntityId?: string;
  targetEntityName?: string;
  similarity?: number;
  method?: string;
}

export class EntityResolution {
  private voyageClient: VoyageAIUnifiedClient | null;

  constructor(voyageClient?: VoyageAIUnifiedClient) {
    this.voyageClient = voyageClient || null;
  }

  /**
   * Find potential duplicate entities using multi-phase matching:
   * 1. Exact match (case-insensitive)
   * 2. Levenshtein distance (fast, handles typos)
   * 3. Voyage AI reranking (semantic similarity)
   *
   * @param newEntity - The new entity name to check
   * @param existingEntities - Array of existing entities to compare against
   * @param threshold - Minimum similarity threshold (default: 0.85)
   * @returns Array of potential duplicates sorted by similarity (descending)
   */
  async findDuplicates(
    newEntity: string,
    existingEntities: EntityCandidate[],
    threshold: number = 0.85
  ): Promise<DuplicateMatch[]> {
    const newEntityLower = newEntity.toLowerCase().trim();
    const candidates: DuplicateMatch[] = [];
    const seen = new Set<string>();

    // Phase 1: Exact match (case-insensitive)
    for (const existing of existingEntities) {
      const existingLower = existing.name.toLowerCase().trim();
      if (existingLower === newEntityLower) {
        candidates.push({
          id: existing.id,
          name: existing.name,
          similarity: 1.0,
          method: 'exact'
        });
        seen.add(existing.id);
      }
    }

    // Phase 2: Levenshtein pre-filter (fast)
    for (const existing of existingEntities) {
      if (seen.has(existing.id)) continue;

      const levenshteinSim = this.levenshteinSimilarity(
        newEntityLower,
        existing.name.toLowerCase().trim()
      );

      // Pre-filter: only consider candidates with similarity >= 0.6
      if (levenshteinSim >= 0.6) {
        candidates.push({
          id: existing.id,
          name: existing.name,
          similarity: levenshteinSim,
          method: 'levenshtein'
        });
        seen.add(existing.id);
      }
    }

    // Phase 3: Voyage rerank for semantic similarity (accurate)
    // Only run if we have candidates and Voyage client is available
    if (candidates.length > 0 && candidates.length < 30 && this.voyageClient) {
      try {
        const levenshteinCandidates = candidates.filter(c => c.method === 'levenshtein');
        if (levenshteinCandidates.length > 0) {
          const documents = levenshteinCandidates.map(c => c.name);
          const reranked = await this.voyageClient.rerank(
            newEntity,
            documents,
            Math.min(10, documents.length)
          );

          // Update candidates with rerank scores if they're better
          for (const result of reranked) {
            const candidate = levenshteinCandidates[result.index];
            if (candidate && result.score > candidate.similarity) {
              candidate.similarity = result.score;
              candidate.method = 'voyage_rerank';
            }
          }
        }
      } catch (err: any) {
        logger.warn('Voyage reranking failed for entity resolution, using Levenshtein only', {
          error: err.message,
          newEntity,
          candidateCount: candidates.length
        });
      }
    }

    // Filter by threshold and sort by similarity (descending)
    return candidates
      .filter(c => c.similarity >= threshold)
      .sort((a, b) => b.similarity - a.similarity);
  }

  /**
   * Auto-merge if a very similar entity exists (similarity > 0.9)
   *
   * @param newEntityName - The new entity name
   * @param existingEntities - Array of existing entities
   * @returns MergeResult indicating whether to merge and with which entity
   */
  async autoMerge(
    newEntityName: string,
    existingEntities: EntityCandidate[]
  ): Promise<MergeResult> {
    // Use high threshold (0.9) for auto-merge to avoid false positives
    const duplicates = await this.findDuplicates(newEntityName, existingEntities, 0.9);

    if (duplicates.length > 0) {
      const target = duplicates[0];
      logger.info('Entity auto-merge candidate found', {
        newEntity: newEntityName,
        mergeTarget: target.name,
        similarity: target.similarity,
        method: target.method
      });
      return {
        merged: true,
        targetEntityId: target.id,
        targetEntityName: target.name,
        similarity: target.similarity,
        method: target.method
      };
    }

    return { merged: false };
  }

  /**
   * Calculate Levenshtein distance between two strings
   * Returns similarity as 0-1 (1 = identical)
   */
  levenshteinSimilarity(s1: string, s2: string): number {
    const maxLen = Math.max(s1.length, s2.length);
    if (maxLen === 0) return 1.0;
    return 1 - this.levenshteinDistance(s1, s2) / maxLen;
  }

  /**
   * Levenshtein distance implementation using dynamic programming
   * O(m*n) time and space complexity
   */
  private levenshteinDistance(s1: string, s2: string): number {
    const m = s1.length;
    const n = s2.length;

    // Create 2D array for DP
    const dp: number[][] = Array(m + 1)
      .fill(null)
      .map(() => Array(n + 1).fill(0));

    // Base cases
    for (let i = 0; i <= m; i++) dp[i][0] = i;
    for (let j = 0; j <= n; j++) dp[0][j] = j;

    // Fill DP table
    for (let i = 1; i <= m; i++) {
      for (let j = 1; j <= n; j++) {
        if (s1[i - 1] === s2[j - 1]) {
          dp[i][j] = dp[i - 1][j - 1];
        } else {
          dp[i][j] = 1 + Math.min(
            dp[i - 1][j],     // deletion
            dp[i][j - 1],     // insertion
            dp[i - 1][j - 1]  // substitution
          );
        }
      }
    }

    return dp[m][n];
  }

  /**
   * Jaro-Winkler similarity (better for short strings and names)
   * Returns 0-1 (1 = identical)
   */
  jaroWinklerSimilarity(s1: string, s2: string): number {
    if (s1 === s2) return 1.0;
    if (s1.length === 0 || s2.length === 0) return 0.0;

    const matchWindow = Math.floor(Math.max(s1.length, s2.length) / 2) - 1;
    const s1Matches = new Array(s1.length).fill(false);
    const s2Matches = new Array(s2.length).fill(false);

    let matches = 0;
    let transpositions = 0;

    // Find matches
    for (let i = 0; i < s1.length; i++) {
      const start = Math.max(0, i - matchWindow);
      const end = Math.min(i + matchWindow + 1, s2.length);

      for (let j = start; j < end; j++) {
        if (s2Matches[j] || s1[i] !== s2[j]) continue;
        s1Matches[i] = true;
        s2Matches[j] = true;
        matches++;
        break;
      }
    }

    if (matches === 0) return 0.0;

    // Count transpositions
    let k = 0;
    for (let i = 0; i < s1.length; i++) {
      if (!s1Matches[i]) continue;
      while (!s2Matches[k]) k++;
      if (s1[i] !== s2[k]) transpositions++;
      k++;
    }

    const jaro = (
      matches / s1.length +
      matches / s2.length +
      (matches - transpositions / 2) / matches
    ) / 3;

    // Winkler modification: boost for common prefix
    let prefix = 0;
    for (let i = 0; i < Math.min(4, s1.length, s2.length); i++) {
      if (s1[i] === s2[i]) prefix++;
      else break;
    }

    return jaro + prefix * 0.1 * (1 - jaro);
  }

  /**
   * Normalize entity name for comparison
   * Removes titles, suffixes, and normalizes whitespace
   */
  normalizeEntityName(name: string): string {
    return name
      .toLowerCase()
      .trim()
      // Remove common titles
      .replace(/^(mr\.?|mrs\.?|ms\.?|dr\.?|prof\.?)\s+/i, '')
      // Remove common suffixes
      .replace(/\s+(inc\.?|corp\.?|ltd\.?|llc|co\.?)$/i, '')
      // Normalize whitespace
      .replace(/\s+/g, ' ');
  }
}

export default EntityResolution;
