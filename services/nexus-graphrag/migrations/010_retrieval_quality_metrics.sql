-- Migration: Add Retrieval Quality Metrics Table
-- Purpose: Track MRR, MAP, NDCG, Precision@K, Recall@K for continuous improvement
-- Date: 2025-11-06

-- Create retrieval metrics table
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

-- Create indexes for performance
CREATE INDEX IF NOT EXISTS idx_retrieval_metrics_timestamp
  ON graphrag.retrieval_metrics(timestamp DESC);

CREATE INDEX IF NOT EXISTS idx_retrieval_metrics_mrr
  ON graphrag.retrieval_metrics(mrr DESC);

-- Add comments
COMMENT ON TABLE graphrag.retrieval_metrics IS 'Tracks retrieval quality metrics (MRR, MAP, NDCG, Precision, Recall) for continuous improvement';
COMMENT ON COLUMN graphrag.retrieval_metrics.mrr IS 'Mean Reciprocal Rank - position of first relevant result';
COMMENT ON COLUMN graphrag.retrieval_metrics.map IS 'Mean Average Precision - precision at each relevant result';
COMMENT ON COLUMN graphrag.retrieval_metrics.ndcg_at_5 IS 'Normalized Discounted Cumulative Gain at position 5';
COMMENT ON COLUMN graphrag.retrieval_metrics.ndcg_at_10 IS 'Normalized Discounted Cumulative Gain at position 10';
