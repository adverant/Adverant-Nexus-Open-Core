/**
 * Vector Search Integration Tests for GraphRAG
 * Tests Qdrant integration, embeddings, and similarity search
 */

import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from '@jest/globals';
import { TestConnections } from '../test-config';
import { TestDataGenerator, DatabaseTestUtils, TestAPIClient } from '../helpers/test-helpers';
import { VoyageAIClientEnhanced } from '../../src/clients/voyage-ai-client-enhanced';
import { QdrantClient } from '@qdrant/js-client-rest';

describe('GraphRAG Vector Search Tests', () => {
  let connections: TestConnections;
  let dbUtils: DatabaseTestUtils;
  let apiClient: TestAPIClient;
  let voyageClient: VoyageAIClientEnhanced;
  let qdrantClient: QdrantClient;

  beforeAll(async () => {
    connections = TestConnections.getInstance();
    dbUtils = new DatabaseTestUtils();
    apiClient = new TestAPIClient(process.env.API_BASE_URL || 'http://localhost:8090');

    // Initialize clients if API keys are available
    if (process.env.VOYAGE_AI_API_KEY) {
      voyageClient = new VoyageAIClientEnhanced({
        apiKey: process.env.VOYAGE_AI_API_KEY,
        model: 'voyage-2'
      });
    }

    qdrantClient = connections.qdrantClient;
  });

  beforeEach(async () => {
    await dbUtils.cleanDatabase();
    await setupVectorCollections();
  });

  afterAll(async () => {
    await connections.cleanup();
  });

  async function setupVectorCollections() {
    const collections = ['documents', 'memories', 'document_summaries'];

    for (const collectionName of collections) {
      try {
        await qdrantClient.deleteCollection(collectionName);
      } catch (error) {
        // Collection might not exist
      }

      await qdrantClient.createCollection(collectionName, {
        vectors: {
          size: 1024, // Voyage-2 embedding dimension
          distance: 'Cosine'
        }
      });
    }
  }

  describe('Embedding Generation', () => {
    it('should generate embeddings for text content', async () => {
      if (!voyageClient) {
        console.log('Skipping: VoyageAI client not configured');
        return;
      }

      const text = 'GraphRAG is a powerful knowledge graph system';
      const embedding = await voyageClient.createEmbedding({
        input: text,
        model: 'voyage-2'
      });

      expect(embedding).toHaveProperty('data');
      expect(embedding.data).toHaveLength(1);
      expect(embedding.data[0]).toHaveProperty('embedding');
      expect(embedding.data[0].embedding).toHaveLength(1024);
    });

    it('should generate embeddings for multiple texts', async () => {
      if (!voyageClient) {
        console.log('Skipping: VoyageAI client not configured');
        return;
      }

      const texts = [
        'First document about AI',
        'Second document about machine learning',
        'Third document about neural networks'
      ];

      const embeddings = await voyageClient.createEmbedding({
        input: texts,
        model: 'voyage-2'
      });

      expect(embeddings.data).toHaveLength(3);
      embeddings.data.forEach(emb => {
        expect(emb.embedding).toHaveLength(1024);
      });
    });

    it('should handle embedding errors gracefully', async () => {
      if (!voyageClient) {
        console.log('Skipping: VoyageAI client not configured');
        return;
      }

      // Test with empty input
      try {
        await voyageClient.createEmbedding({
          input: '',
          model: 'voyage-2'
        });
      } catch (error) {
        expect(error).toBeDefined();
      }
    });
  });

  describe('Vector Storage in Qdrant', () => {
    it('should store document vectors in Qdrant', async () => {
      const documentId = 'test-doc-123';
      const vector = Array(1024).fill(0).map(() => Math.random());

      await qdrantClient.upsert('documents', {
        points: [{
          id: documentId,
          vector,
          payload: {
            content: 'Test document content',
            metadata: {
              title: 'Test Document',
              type: 'test'
            }
          }
        }]
      });

      // Verify storage
      const result = await qdrantClient.retrieve('documents', {
        ids: [documentId]
      });

      expect(result).toHaveLength(1);
      expect(result[0].id).toBe(documentId);
      expect(result[0].payload.content).toBe('Test document content');
    });

    it('should store chunk vectors with metadata', async () => {
      const chunks = [
        { id: 'chunk-1', content: 'First chunk', index: 0 },
        { id: 'chunk-2', content: 'Second chunk', index: 1 },
        { id: 'chunk-3', content: 'Third chunk', index: 2 }
      ];

      const points = chunks.map(chunk => ({
        id: chunk.id,
        vector: Array(1024).fill(0).map(() => Math.random()),
        payload: {
          documentId: 'parent-doc',
          content: chunk.content,
          chunkIndex: chunk.index,
          metadata: {
            created: new Date().toISOString()
          }
        }
      }));

      await qdrantClient.upsert('documents', { points });

      // Search for chunks
      const searchResult = await qdrantClient.search('documents', {
        vector: Array(1024).fill(0).map(() => Math.random()),
        limit: 3,
        filter: {
          must: [{
            key: 'documentId',
            match: { value: 'parent-doc' }
          }]
        }
      });

      expect(searchResult).toHaveLength(3);
      searchResult.forEach(result => {
        expect(result.payload.documentId).toBe('parent-doc');
      });
    });
  });

  describe('Similarity Search', () => {
    beforeEach(async () => {
      // Seed vector database with test documents
      const documents = [
        { id: 'doc-1', content: 'Artificial intelligence and machine learning', category: 'AI' },
        { id: 'doc-2', content: 'Natural language processing with transformers', category: 'NLP' },
        { id: 'doc-3', content: 'Computer vision and image recognition', category: 'CV' },
        { id: 'doc-4', content: 'Deep learning neural networks', category: 'AI' },
        { id: 'doc-5', content: 'Knowledge graphs and semantic search', category: 'KG' }
      ];

      const points = documents.map(doc => ({
        id: doc.id,
        vector: Array(1024).fill(0).map(() => Math.random()), // Mock embeddings
        payload: {
          content: doc.content,
          category: doc.category
        }
      }));

      await qdrantClient.upsert('documents', { points });
    });

    it('should find similar documents', async () => {
      const queryVector = Array(1024).fill(0).map(() => Math.random());

      const results = await qdrantClient.search('documents', {
        vector: queryVector,
        limit: 3
      });

      expect(results).toHaveLength(3);
      expect(results[0].score).toBeGreaterThanOrEqual(results[1].score);
      expect(results[1].score).toBeGreaterThanOrEqual(results[2].score);
    });

    it('should filter search by metadata', async () => {
      const queryVector = Array(1024).fill(0).map(() => Math.random());

      const results = await qdrantClient.search('documents', {
        vector: queryVector,
        limit: 5,
        filter: {
          must: [{
            key: 'category',
            match: { value: 'AI' }
          }]
        }
      });

      results.forEach(result => {
        expect(result.payload.category).toBe('AI');
      });
    });

    it('should support multiple filter conditions', async () => {
      const queryVector = Array(1024).fill(0).map(() => Math.random());

      const results = await qdrantClient.search('documents', {
        vector: queryVector,
        limit: 5,
        filter: {
          must: [{
            key: 'category',
            match: { any: ['AI', 'NLP'] }
          }]
        }
      });

      results.forEach(result => {
        expect(['AI', 'NLP']).toContain(result.payload.category);
      });
    });
  });

  describe('Hybrid Search', () => {
    it('should combine vector and keyword search', async () => {
      // Upload documents with both vector embeddings and text content
      const documents = [
        { content: 'GraphRAG enables intelligent document processing', metadata: { title: 'GraphRAG Intro' } },
        { content: 'Vector databases power semantic search', metadata: { title: 'Vector DB' } },
        { content: 'Knowledge graphs connect information', metadata: { title: 'Knowledge Graphs' } }
      ];

      for (const doc of documents) {
        await apiClient.uploadDocument(doc);
      }

      // Perform hybrid search
      const response = await apiClient.searchDocuments({
        query: 'semantic search databases',
        limit: 5,
        useHybrid: true
      });

      expect(response.status).toBe(200);
      expect(response.data.results).toBeDefined();
    });
  });

  describe('Re-ranking and Relevance', () => {
    it('should re-rank results based on relevance scores', async () => {
      const documents = Array(10).fill(0).map((_, i) => ({
        id: `doc-${i}`,
        vector: Array(1024).fill(0).map(() => Math.random()),
        payload: {
          content: `Document ${i} content`,
          relevanceBoost: Math.random()
        }
      }));

      await qdrantClient.upsert('documents', { points: documents });

      const queryVector = Array(1024).fill(0).map(() => Math.random());
      const results = await qdrantClient.search('documents', {
        vector: queryVector,
        limit: 5,
        with_payload: true
      });

      // Re-rank based on custom relevance
      const reranked = results.sort((a, b) => {
        const scoreA = a.score * (1 + (a.payload.relevanceBoost || 0));
        const scoreB = b.score * (1 + (b.payload.relevanceBoost || 0));
        return scoreB - scoreA;
      });

      expect(reranked).toHaveLength(5);
    });
  });

  describe('Collection Management', () => {
    it('should create and manage vector collections', async () => {
      const collectionName = 'test-collection-' + Date.now();

      // Create collection
      await qdrantClient.createCollection(collectionName, {
        vectors: {
          size: 768,
          distance: 'Dot'
        }
      });

      // Verify collection exists
      const collections = await qdrantClient.getCollections();
      expect(collections.collections).toContainEqual(
        expect.objectContaining({ name: collectionName })
      );

      // Get collection info
      const info = await qdrantClient.getCollection(collectionName);
      expect(info.config.params.vectors.size).toBe(768);

      // Delete collection
      await qdrantClient.deleteCollection(collectionName);

      // Verify deletion
      const collectionsAfter = await qdrantClient.getCollections();
      expect(collectionsAfter.collections).not.toContainEqual(
        expect.objectContaining({ name: collectionName })
      );
    });
  });

  describe('Batch Operations', () => {
    it('should perform batch vector operations', async () => {
      const batchSize = 100;
      const points = Array(batchSize).fill(0).map((_, i) => ({
        id: `batch-${i}`,
        vector: Array(1024).fill(0).map(() => Math.random()),
        payload: {
          content: `Batch document ${i}`,
          batchId: Math.floor(i / 10)
        }
      }));

      // Batch upsert
      await qdrantClient.upsert('documents', { points });

      // Batch search
      const searchVectors = Array(5).fill(0).map(() =>
        Array(1024).fill(0).map(() => Math.random())
      );

      const batchResults = await Promise.all(
        searchVectors.map(vector =>
          qdrantClient.search('documents', {
            vector,
            limit: 3
          })
        )
      );

      expect(batchResults).toHaveLength(5);
      batchResults.forEach(results => {
        expect(results).toHaveLength(3);
      });

      // Batch delete
      const idsToDelete = Array(10).fill(0).map((_, i) => `batch-${i}`);
      await qdrantClient.delete('documents', {
        points: idsToDelete
      });

      // Verify deletion
      const remaining = await qdrantClient.retrieve('documents', {
        ids: idsToDelete
      });
      expect(remaining).toHaveLength(0);
    });
  });

  describe('Performance Optimization', () => {
    it('should optimize search with indexing', async () => {
      // Add many vectors to test indexing performance
      const largeDataset = Array(1000).fill(0).map((_, i) => ({
        id: `perf-${i}`,
        vector: Array(1024).fill(0).map(() => Math.random()),
        payload: {
          content: `Performance test document ${i}`
        }
      }));

      await qdrantClient.upsert('documents', {
        points: largeDataset,
        wait: true
      });

      // Measure search performance
      const startTime = performance.now();
      const queryVector = Array(1024).fill(0).map(() => Math.random());

      const results = await qdrantClient.search('documents', {
        vector: queryVector,
        limit: 10
      });

      const searchTime = performance.now() - startTime;

      expect(results).toHaveLength(10);
      expect(searchTime).toBeLessThan(1000); // Should complete within 1 second
    });
  });

  describe('Error Handling', () => {
    it('should handle Qdrant connection errors', async () => {
      const badClient = new QdrantClient({
        url: 'http://localhost:99999' // Invalid port
      });

      try {
        await badClient.getCollections();
        fail('Should have thrown an error');
      } catch (error) {
        expect(error).toBeDefined();
      }
    });

    it('should handle invalid vector dimensions', async () => {
      try {
        await qdrantClient.upsert('documents', {
          points: [{
            id: 'invalid-dim',
            vector: Array(512).fill(0), // Wrong dimension
            payload: { content: 'Test' }
          }]
        });
        fail('Should have thrown an error');
      } catch (error) {
        expect(error).toBeDefined();
      }
    });
  });
});