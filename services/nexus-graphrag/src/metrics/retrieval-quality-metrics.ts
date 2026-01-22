/**
 * Retrieval Quality Metrics
 *
 * Tracks and calculates retrieval performance metrics:
 * - MRR (Mean Reciprocal Rank): Position of first relevant result
 * - MAP (Mean Average Precision): Precision at each relevant result
 * - NDCG@K (Normalized Discounted Cumulative Gain): Ranked relevance quality
 * - Precision@K: Precision in top K results
 * - Recall@K: Coverage in top K results
 */

import Redis from 'ioredis';
import { Pool } from 'pg';
import { logger } from '../utils/logger';
import { v4 as uuidv4 } from 'uuid';

export interface RelevanceFeedback {
  resultId: string;
  relevant: boolean;
  relevanceScore?: number; // 0-3: 0=not relevant, 1=somewhat, 2=relevant, 3=highly relevant
}

export interface SearchResultForMetrics {
  id: string;
  score: number;
  rank: number;
}

export interface QueryMetrics {
  queryId: string;
  query: string;
  timestamp: string;
  resultCount: number;
  relevantCount: number;
  mrr: number;
  map: number;
  precisionAt5: number;
  precisionAt10: number;
  recallAt5: number;
  recallAt10: number;
  ndcgAt5: number;
  ndcgAt10: number;
}

export interface AggregateMetrics {
  timeRange: { start: Date; end: Date };
  totalQueries: number;
  avgMRR: number;
  avgMAP: number;
  avgPrecisionAt5: number;
  avgPrecisionAt10: number;
  avgRecallAt5: number;
  avgRecallAt10: number;
  avgNDCGAt5: number;
  avgNDCGAt10: number;
  queryPatternBreakdown?: {
    title_search: { count: number; avgMRR: number };
    code_search: { count: number; avgMRR: number };
    semantic: { count: number; avgMRR: number };
    exact_phrase: { count: number; avgMRR: number };
    hybrid: { count: number; avgMRR: number };
  };
}

export class RetrievalQualityMetrics {
  private redisClient: Redis;
  private postgresPool: Pool;

  constructor(redisClient: Redis, postgresPool: Pool) {
    this.redisClient = redisClient;
    this.postgresPool = postgresPool;
  }

  /**
   * Record a query and its results for later analysis
   */
  async recordQuery(
    query: string,
    results: SearchResultForMetrics[],
    pattern?: string,
    relevanceFeedback?: RelevanceFeedback[]
  ): Promise<string> {
    const queryId = uuidv4();
    const timestamp = new Date().toISOString();

    // Store query and results in Redis (24 hour TTL)
    const queryData = {
      queryId,
      query,
      pattern: pattern || 'unknown',
      results: results.map(r => ({ id: r.id, score: r.score, rank: r.rank })),
      relevanceFeedback: relevanceFeedback || [],
      timestamp
    };

    await this.redisClient.setex(
      `retrieval:query:${queryId}`,
      86400, // 24 hours
      JSON.stringify(queryData)
    );

    // If feedback provided, calculate and store metrics
    if (relevanceFeedback && relevanceFeedback.length > 0) {
      const metrics = await this.calculateMetrics(
        queryId,
        query,
        results,
        relevanceFeedback,
        pattern
      );

      // Store in PostgreSQL for long-term analysis
      await this.storeMetricsInDB(metrics);
    }

    return queryId;
  }

  /**
   * Add relevance feedback to an existing query
   */
  async addRelevanceFeedback(
    queryId: string,
    feedback: RelevanceFeedback[]
  ): Promise<QueryMetrics> {
    // Get query data from Redis
    const queryDataStr = await this.redisClient.get(`retrieval:query:${queryId}`);
    if (!queryDataStr) {
      throw new Error(`Query ${queryId} not found in cache`);
    }

    const queryData = JSON.parse(queryDataStr);

    // Calculate metrics
    const metrics = await this.calculateMetrics(
      queryId,
      queryData.query,
      queryData.results,
      feedback,
      queryData.pattern
    );

    // Update query data with feedback
    queryData.relevanceFeedback = feedback;
    await this.redisClient.setex(
      `retrieval:query:${queryId}`,
      86400,
      JSON.stringify(queryData)
    );

    // Store metrics in DB
    await this.storeMetricsInDB(metrics);

    return metrics;
  }

  /**
   * Calculate all retrieval quality metrics
   */
  private async calculateMetrics(
    queryId: string,
    query: string,
    results: SearchResultForMetrics[],
    feedback: RelevanceFeedback[],
    _pattern?: string
  ): Promise<QueryMetrics> {
    // Build relevance map
    const relevanceMap = new Map<string, number>();
    let totalRelevant = 0;

    for (const f of feedback) {
      const score = f.relevanceScore ?? (f.relevant ? 1 : 0);
      relevanceMap.set(f.resultId, score);
      if (f.relevant || score > 0) {
        totalRelevant++;
      }
    }

    // Calculate MRR (Mean Reciprocal Rank)
    const mrr = this.calculateMRR(results, relevanceMap);

    // Calculate MAP (Mean Average Precision)
    const map = this.calculateMAP(results, relevanceMap);

    // Calculate Precision@K
    const precisionAt5 = this.calculatePrecisionAtK(results, relevanceMap, 5);
    const precisionAt10 = this.calculatePrecisionAtK(results, relevanceMap, 10);

    // Calculate Recall@K
    const recallAt5 = this.calculateRecallAtK(results, relevanceMap, totalRelevant, 5);
    const recallAt10 = this.calculateRecallAtK(results, relevanceMap, totalRelevant, 10);

    // Calculate NDCG@K
    const ndcgAt5 = this.calculateNDCGAtK(results, relevanceMap, 5);
    const ndcgAt10 = this.calculateNDCGAtK(results, relevanceMap, 10);

    return {
      queryId,
      query,
      timestamp: new Date().toISOString(),
      resultCount: results.length,
      relevantCount: totalRelevant,
      mrr,
      map,
      precisionAt5,
      precisionAt10,
      recallAt5,
      recallAt10,
      ndcgAt5,
      ndcgAt10
    };
  }

  /**
   * Calculate Mean Reciprocal Rank (MRR)
   * MRR = 1 / rank of first relevant result
   */
  private calculateMRR(
    results: SearchResultForMetrics[],
    relevanceMap: Map<string, number>
  ): number {
    for (let i = 0; i < results.length; i++) {
      const relevance = relevanceMap.get(results[i].id) || 0;
      if (relevance > 0) {
        return 1 / (i + 1); // rank is 1-indexed
      }
    }
    return 0; // No relevant results found
  }

  /**
   * Calculate Mean Average Precision (MAP)
   * MAP = (1/|Rel|) * Σ (Precision@k * rel(k))
   */
  private calculateMAP(
    results: SearchResultForMetrics[],
    relevanceMap: Map<string, number>
  ): number {
    let relevantCount = 0;
    let sumPrecision = 0;

    for (let i = 0; i < results.length; i++) {
      const relevance = relevanceMap.get(results[i].id) || 0;
      if (relevance > 0) {
        relevantCount++;
        const precision = relevantCount / (i + 1);
        sumPrecision += precision;
      }
    }

    return relevantCount > 0 ? sumPrecision / relevantCount : 0;
  }

  /**
   * Calculate Precision@K
   * Precision@K = (# relevant in top K) / K
   */
  private calculatePrecisionAtK(
    results: SearchResultForMetrics[],
    relevanceMap: Map<string, number>,
    k: number
  ): number {
    const topK = results.slice(0, k);
    const relevantInTopK = topK.filter(r => (relevanceMap.get(r.id) || 0) > 0).length;
    return relevantInTopK / k;
  }

  /**
   * Calculate Recall@K
   * Recall@K = (# relevant in top K) / (total # relevant)
   */
  private calculateRecallAtK(
    results: SearchResultForMetrics[],
    relevanceMap: Map<string, number>,
    totalRelevant: number,
    k: number
  ): number {
    if (totalRelevant === 0) return 0;

    const topK = results.slice(0, k);
    const relevantInTopK = topK.filter(r => (relevanceMap.get(r.id) || 0) > 0).length;
    return relevantInTopK / totalRelevant;
  }

  /**
   * Calculate Normalized Discounted Cumulative Gain at K (NDCG@K)
   * NDCG@K = DCG@K / IDCG@K
   *
   * DCG@K = Σ (rel_i / log2(i + 1)) for i=1 to k
   * IDCG@K = DCG@K for perfect ranking
   */
  private calculateNDCGAtK(
    results: SearchResultForMetrics[],
    relevanceMap: Map<string, number>,
    k: number
  ): number {
    const topK = results.slice(0, k);

    // Calculate DCG@K
    let dcg = 0;
    for (let i = 0; i < topK.length; i++) {
      const relevance = relevanceMap.get(topK[i].id) || 0;
      dcg += relevance / Math.log2(i + 2); // i+2 because log2(1) = 0
    }

    // Calculate IDCG@K (ideal ranking)
    const allRelevances = Array.from(relevanceMap.values())
      .filter(r => r > 0)
      .sort((a, b) => b - a); // Sort descending

    let idcg = 0;
    for (let i = 0; i < Math.min(k, allRelevances.length); i++) {
      idcg += allRelevances[i] / Math.log2(i + 2);
    }

    return idcg > 0 ? dcg / idcg : 0;
  }

  /**
   * Store metrics in PostgreSQL for long-term analysis
   */
  private async storeMetricsInDB(metrics: QueryMetrics): Promise<void> {
    const client = await this.postgresPool.connect();
    try {
      await client.query(`
        INSERT INTO graphrag.retrieval_metrics (
          query_id,
          query,
          timestamp,
          result_count,
          relevant_count,
          mrr,
          map,
          precision_at_5,
          precision_at_10,
          recall_at_5,
          recall_at_10,
          ndcg_at_5,
          ndcg_at_10
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
        ON CONFLICT (query_id) DO UPDATE SET
          mrr = EXCLUDED.mrr,
          map = EXCLUDED.map,
          precision_at_5 = EXCLUDED.precision_at_5,
          precision_at_10 = EXCLUDED.precision_at_10,
          recall_at_5 = EXCLUDED.recall_at_5,
          recall_at_10 = EXCLUDED.recall_at_10,
          ndcg_at_5 = EXCLUDED.ndcg_at_5,
          ndcg_at_10 = EXCLUDED.ndcg_at_10
      `, [
        metrics.queryId,
        metrics.query,
        metrics.timestamp,
        metrics.resultCount,
        metrics.relevantCount,
        metrics.mrr,
        metrics.map,
        metrics.precisionAt5,
        metrics.precisionAt10,
        metrics.recallAt5,
        metrics.recallAt10,
        metrics.ndcgAt5,
        metrics.ndcgAt10
      ]);
    } finally {
      client.release();
    }
  }

  /**
   * Get aggregate metrics over a time range
   */
  async getAggregateMetrics(
    startDate: Date,
    endDate: Date
  ): Promise<AggregateMetrics> {
    const client = await this.postgresPool.connect();
    try {
      const result = await client.query(`
        SELECT
          COUNT(*) as total_queries,
          AVG(mrr) as avg_mrr,
          AVG(map) as avg_map,
          AVG(precision_at_5) as avg_precision_at_5,
          AVG(precision_at_10) as avg_precision_at_10,
          AVG(recall_at_5) as avg_recall_at_5,
          AVG(recall_at_10) as avg_recall_at_10,
          AVG(ndcg_at_5) as avg_ndcg_at_5,
          AVG(ndcg_at_10) as avg_ndcg_at_10
        FROM graphrag.retrieval_metrics
        WHERE timestamp >= $1 AND timestamp <= $2
      `, [startDate.toISOString(), endDate.toISOString()]);

      const row = result.rows[0];

      return {
        timeRange: { start: startDate, end: endDate },
        totalQueries: parseInt(row.total_queries) || 0,
        avgMRR: parseFloat(row.avg_mrr) || 0,
        avgMAP: parseFloat(row.avg_map) || 0,
        avgPrecisionAt5: parseFloat(row.avg_precision_at_5) || 0,
        avgPrecisionAt10: parseFloat(row.avg_precision_at_10) || 0,
        avgRecallAt5: parseFloat(row.avg_recall_at_5) || 0,
        avgRecallAt10: parseFloat(row.avg_recall_at_10) || 0,
        avgNDCGAt5: parseFloat(row.avg_ndcg_at_5) || 0,
        avgNDCGAt10: parseFloat(row.avg_ndcg_at_10) || 0
      };
    } finally {
      client.release();
    }
  }

  /**
   * Get recent metrics for monitoring
   */
  async getRecentMetrics(limit: number = 100): Promise<QueryMetrics[]> {
    const client = await this.postgresPool.connect();
    try {
      const result = await client.query(`
        SELECT
          query_id,
          query,
          timestamp,
          result_count,
          relevant_count,
          mrr,
          map,
          precision_at_5,
          precision_at_10,
          recall_at_5,
          recall_at_10,
          ndcg_at_5,
          ndcg_at_10
        FROM graphrag.retrieval_metrics
        ORDER BY timestamp DESC
        LIMIT $1
      `, [limit]);

      return result.rows.map(row => ({
        queryId: row.query_id,
        query: row.query,
        timestamp: row.timestamp,
        resultCount: row.result_count,
        relevantCount: row.relevant_count,
        mrr: parseFloat(row.mrr),
        map: parseFloat(row.map),
        precisionAt5: parseFloat(row.precision_at_5),
        precisionAt10: parseFloat(row.precision_at_10),
        recallAt5: parseFloat(row.recall_at_5),
        recallAt10: parseFloat(row.recall_at_10),
        ndcgAt5: parseFloat(row.ndcg_at_5),
        ndcgAt10: parseFloat(row.ndcg_at_10)
      }));
    } finally {
      client.release();
    }
  }

  /**
   * Initialize database schema for metrics
   */
  async initializeSchema(): Promise<void> {
    const client = await this.postgresPool.connect();
    try {
      await client.query(`
        CREATE TABLE IF NOT EXISTS graphrag.retrieval_metrics (
          query_id VARCHAR(36) PRIMARY KEY,
          query TEXT NOT NULL,
          timestamp TIMESTAMP NOT NULL,
          result_count INTEGER NOT NULL,
          relevant_count INTEGER NOT NULL,
          mrr DECIMAL(5,4) NOT NULL,
          map DECIMAL(5,4) NOT NULL,
          precision_at_5 DECIMAL(5,4) NOT NULL,
          precision_at_10 DECIMAL(5,4) NOT NULL,
          recall_at_5 DECIMAL(5,4) NOT NULL,
          recall_at_10 DECIMAL(5,4) NOT NULL,
          ndcg_at_5 DECIMAL(5,4) NOT NULL,
          ndcg_at_10 DECIMAL(5,4) NOT NULL,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );

        CREATE INDEX IF NOT EXISTS idx_retrieval_metrics_timestamp
          ON graphrag.retrieval_metrics(timestamp DESC);
      `);

      logger.info('Retrieval quality metrics schema initialized');
    } finally {
      client.release();
    }
  }
}
