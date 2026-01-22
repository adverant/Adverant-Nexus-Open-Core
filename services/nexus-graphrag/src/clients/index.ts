/**
 * Client exports for GraphRAG
 *
 * Provides backward-compatible exports while using new adapter pattern
 */

// New adapter (recommended)
export { GraphRAGEmbeddingAdapter } from './GraphRAGEmbeddingAdapter';

// Backward compatibility: Export adapter as VoyageAIClient
// This allows existing code to work without changes
export { GraphRAGEmbeddingAdapter as VoyageAIClient } from './GraphRAGEmbeddingAdapter';
export { GraphRAGEmbeddingAdapter as VoyageAIUnifiedClient } from './GraphRAGEmbeddingAdapter';

// Export types from shared package
export type {
  EmbeddingResult,
  EmbeddingOptions,
  RerankResult,
  VoyageModelInfo
} from '../../../../packages/voyage-ai-client/dist';
