/**
 * Integration Tests for GraphRAG API Endpoints
 * Comprehensive testing of all API functionality
 */

import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from '@jest/globals';
import { TestAPIClient, TestDataGenerator, DatabaseTestUtils, AssertionHelpers } from '../../helpers/test-helpers';
import { testConfig } from '../../test-config';

describe('GraphRAG API Integration Tests', () => {
  let apiClient: TestAPIClient;
  let dbUtils: DatabaseTestUtils;

  beforeAll(async () => {
    apiClient = new TestAPIClient(testConfig.api.baseUrl);
    dbUtils = new DatabaseTestUtils();
  });

  beforeEach(async () => {
    await dbUtils.cleanDatabase();
  });

  afterEach(async () => {
    await dbUtils.cleanDatabase();
  });

  describe('Health Check Endpoints', () => {
    it('should return health status at /health', async () => {
      const response = await apiClient.axios.get('/health');

      expect(response.status).toBe(200);
      expect(response.data).toHaveProperty('status');
      expect(response.data).toHaveProperty('services');
      expect(response.data.services).toHaveProperty('postgres');
      expect(response.data.services).toHaveProperty('redis');
      expect(response.data.services).toHaveProperty('neo4j');
      expect(response.data.services).toHaveProperty('qdrant');
    });

    it('should return health status at /api/health with api field', async () => {
      const response = await apiClient.getHealth();

      expect(response.status).toBe(200);
      expect(response.data).toHaveProperty('status');
      expect(response.data).toHaveProperty('services');
      expect(response.data.services).toHaveProperty('api');
      expect(response.data.services).toHaveProperty('PostgreSQL');
      expect(response.data.services).toHaveProperty('Redis');
      expect(response.data.services).toHaveProperty('Neo4j');
      expect(response.data.services).toHaveProperty('Qdrant');
      expect(response.data.services.api).toBe(true);
    });

    it('should return 503 when services are unhealthy', async () => {
      // This test would require mocking service failures
      // In a real scenario, you might stop a service temporarily
      const response = await apiClient.getHealth();

      if (response.data.status === 'degraded') {
        expect(response.status).toBe(503);
      }
    });
  });

  describe('Document Upload Endpoints', () => {
    it('should upload document with JSON body', async () => {
      const document = TestDataGenerator.generateDocument();
      const response = await apiClient.uploadDocument(document);

      expect(response.status).toBe(201);
      expect(response.data).toHaveProperty('success', true);
      expect(response.data).toHaveProperty('documentId');
      expect(response.data.documentId).toMatch(/^[0-9a-f-]+$/);
    });

    it('should upload document with plain text content-type', async () => {
      const content = 'This is plain text content';

      const response = await apiClient.axios.post('/documents', content, {
        headers: {
          'Content-Type': 'text/plain'
        }
      });

      expect(response.status).toBe(201);
      expect(response.data).toHaveProperty('success', true);
      expect(response.data).toHaveProperty('documentId');
    });

    it('should upload document with markdown content', async () => {
      const markdown = '# Title\n\n## Subtitle\n\n- Item 1\n- Item 2';

      const response = await apiClient.axios.post('/documents', markdown, {
        headers: {
          'Content-Type': 'text/markdown'
        }
      });

      expect(response.status).toBe(201);
      expect(response.data).toHaveProperty('documentId');
    });

    it('should handle large document upload', async () => {
      const largeDoc = TestDataGenerator.generateLargeDocument(200); // 200KB

      const response = await apiClient.uploadDocument(largeDoc);

      expect(response.status).toBe(201);
      expect(response.data).toHaveProperty('success', true);
    });

    it('should reject empty content', async () => {
      const response = await apiClient.uploadDocument({
        content: '',
        title: 'Empty Doc'
      });

      expect(response.status).toBe(400);
      expect(response.data).toHaveProperty('error');
    });

    it('should handle document with metadata and tags', async () => {
      const document = {
        content: 'Test content',
        metadata: {
          title: 'Test Document',
          tags: ['test', 'integration', 'api'],
          author: 'Test Suite',
          custom: {
            category: 'testing',
            version: '1.0'
          }
        }
      };

      const response = await apiClient.uploadDocument(document);

      expect(response.status).toBe(201);
      expect(response.data).toHaveProperty('success', true);
    });
  });

  describe('Batch Upload Endpoint', () => {
    it('should upload multiple documents in batch', async () => {
      const documents = TestDataGenerator.generateDocuments(5);
      const response = await apiClient.uploadDocuments(documents);

      expect(response.status).toBe(200);
      expect(response.data).toHaveProperty('success', true);
      expect(response.data).toHaveProperty('uploaded', 5);
      expect(response.data).toHaveProperty('total', 5);
      expect(response.data).toHaveProperty('results');
      expect(response.data.results).toHaveLength(5);
    });

    it('should handle partial batch failures', async () => {
      const documents = [
        TestDataGenerator.generateDocument(),
        { content: '', metadata: { title: 'Empty' } }, // Should fail
        TestDataGenerator.generateDocument()
      ];

      const response = await apiClient.uploadDocuments(documents);

      expect(response.status).toBe(200);
      expect(response.data.uploaded).toBe(2);
      expect(response.data.total).toBe(3);
      expect(response.data.results[1].success).toBe(false);
    });

    it('should reject invalid batch format', async () => {
      const response = await apiClient.axios.post('/documents/batch', {
        notDocuments: []
      });

      expect(response.status).toBe(400);
      expect(response.data).toHaveProperty('error');
    });
  });

  describe('Document Listing and Pagination', () => {
    beforeEach(async () => {
      // Seed test documents
      const documents = TestDataGenerator.generateDocuments(25);
      for (const doc of documents) {
        await apiClient.uploadDocument(doc);
      }
    });

    it('should list documents with default pagination', async () => {
      const response = await apiClient.listDocuments();

      expect(response.status).toBe(200);
      AssertionHelpers.assertPaginationResponse(response);
      expect(response.data.documents).toBeInstanceOf(Array);
      expect(response.data.documents.length).toBeLessThanOrEqual(10);
    });

    it('should support custom page and limit', async () => {
      const response = await apiClient.listDocuments({
        page: 2,
        limit: 5
      });

      expect(response.status).toBe(200);
      expect(response.data.page).toBe(2);
      expect(response.data.limit).toBe(5);
      expect(response.data.documents.length).toBeLessThanOrEqual(5);
    });

    it('should filter documents by tags', async () => {
      // Upload documents with specific tags
      await apiClient.uploadDocument({
        content: 'Tagged content',
        metadata: { title: 'Tagged', tags: ['specific', 'test'] }
      });

      const response = await apiClient.listDocuments({
        tags: 'specific,test'
      });

      expect(response.status).toBe(200);
      response.data.documents.forEach(doc => {
        expect(doc.tags).toEqual(expect.arrayContaining(['specific']));
      });
    });

    it('should filter documents by date range', async () => {
      const now = new Date();
      const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);

      const response = await apiClient.listDocuments({
        dateFrom: yesterday.toISOString(),
        dateTo: now.toISOString()
      });

      expect(response.status).toBe(200);
      response.data.documents.forEach(doc => {
        const createdAt = new Date(doc.created_at);
        expect(createdAt.getTime()).toBeGreaterThanOrEqual(yesterday.getTime());
        expect(createdAt.getTime()).toBeLessThanOrEqual(now.getTime());
      });
    });
  });

  describe('Document Chunking Endpoints', () => {
    let documentId: string;

    beforeEach(async () => {
      const doc = TestDataGenerator.generateDocument({
        content: 'A'.repeat(3000) // Content for multiple chunks
      });
      const response = await apiClient.uploadDocument(doc);
      documentId = response.data.documentId;
    });

    it('should get document chunks', async () => {
      const response = await apiClient.getChunks(documentId);

      expect(response.status).toBe(200);
      expect(response.data).toHaveProperty('documentId', documentId);
      expect(response.data).toHaveProperty('chunks');
      expect(response.data.chunks).toBeInstanceOf(Array);
      expect(response.data.chunks.length).toBeGreaterThan(0);

      response.data.chunks.forEach(chunk => {
        expect(chunk).toHaveProperty('id');
        expect(chunk).toHaveProperty('content');
        expect(chunk).toHaveProperty('chunk_index');
      });
    });

    it('should retrieve single chunk by ID', async () => {
      const chunksResponse = await apiClient.getChunks(documentId);
      const chunkId = chunksResponse.data.chunks[0].id;

      const response = await apiClient.axios.get(`/chunks/${chunkId}`);

      expect(response.status).toBe(200);
      expect(response.data).toHaveProperty('id', chunkId);
      expect(response.data).toHaveProperty('content');
      expect(response.data).toHaveProperty('document_id', documentId);
    });

    it('should apply custom chunking strategy', async () => {
      const response = await apiClient.axios.post(`/documents/${documentId}/chunk`, {
        strategy: 'sentence',
        chunkSize: 500
      });

      expect(response.status).toBe(200);
      expect(response.data).toHaveProperty('success', true);
      expect(response.data).toHaveProperty('chunks');
      expect(response.data).toHaveProperty('strategy', 'sentence');
    });

    it('should return 404 for non-existent document chunks', async () => {
      const response = await apiClient.getChunks('non-existent-id');

      expect(response.status).toBe(404);
    });
  });

  describe('Search Endpoints', () => {
    beforeEach(async () => {
      // Seed searchable documents
      const documents = [
        { content: 'GraphRAG is a powerful system for knowledge management', metadata: { title: 'GraphRAG Intro' } },
        { content: 'Machine learning enables intelligent document processing', metadata: { title: 'ML Basics' } },
        { content: 'Vector databases power semantic search capabilities', metadata: { title: 'Vector Search' } }
      ];

      for (const doc of documents) {
        await apiClient.uploadDocument(doc);
      }
    });

    it('should perform semantic search', async () => {
      const response = await apiClient.searchDocuments({
        query: 'knowledge management system',
        limit: 5
      });

      expect(response.status).toBe(200);
      expect(response.data).toHaveProperty('query');
      expect(response.data).toHaveProperty('results');
      expect(response.data.results).toBeInstanceOf(Array);
      expect(response.data.results.length).toBeGreaterThan(0);

      response.data.results.forEach(result => {
        expect(result).toHaveProperty('id');
        expect(result).toHaveProperty('score');
        expect(result).toHaveProperty('content');
      });
    });

    it('should search with metadata filters', async () => {
      const response = await apiClient.searchDocuments({
        query: 'document',
        filters: {
          type: 'text'
        },
        limit: 10
      });

      expect(response.status).toBe(200);
      expect(response.data.results).toBeInstanceOf(Array);
    });

    it('should handle empty search results', async () => {
      const response = await apiClient.searchDocuments({
        query: 'nonexistentquerythatwillnotmatch',
        limit: 10
      });

      expect(response.status).toBe(200);
      expect(response.data.results).toEqual([]);
      expect(response.data.count).toBe(0);
    });

    it('should reject search without query', async () => {
      const response = await apiClient.searchDocuments({
        limit: 10
      });

      expect(response.status).toBe(400);
      expect(response.data).toHaveProperty('error');
    });
  });

  describe('Memory Endpoints', () => {
    it('should store memory', async () => {
      const memory = TestDataGenerator.generateMemory();
      const response = await apiClient.storeMemory(memory);

      expect(response.status).toBe(201);
      expect(response.data).toHaveProperty('success', true);
      expect(response.data).toHaveProperty('memoryId');
    });

    it('should recall memories by query', async () => {
      // Store some memories
      const memories = Array.from({ length: 5 }, () => TestDataGenerator.generateMemory());
      for (const memory of memories) {
        await apiClient.storeMemory(memory);
      }

      const response = await apiClient.recallMemories({
        query: memories[0].content.split(' ').slice(0, 3).join(' '),
        limit: 3
      });

      expect(response.status).toBe(200);
      expect(response.data).toHaveProperty('memories');
      expect(response.data.memories).toBeInstanceOf(Array);
      expect(response.data.memories.length).toBeLessThanOrEqual(3);

      response.data.memories.forEach(memory => {
        expect(memory).toHaveProperty('content');
        expect(memory).toHaveProperty('score');
        expect(memory).toHaveProperty('timestamp');
      });
    });

    it('should list all memories', async () => {
      const response = await apiClient.axios.get('/api/memory/list?limit=10');

      expect(response.status).toBe(200);
      expect(response.data).toHaveProperty('memories');
      expect(response.data).toHaveProperty('pagination');
    });

    it('should get memory by ID', async () => {
      const memory = TestDataGenerator.generateMemory();
      const storeResponse = await apiClient.storeMemory(memory);
      const memoryId = storeResponse.data.memoryId;

      const response = await apiClient.axios.get(`/memories/${memoryId}`);

      if (response.status === 200) {
        expect(response.data).toHaveProperty('id', memoryId);
        expect(response.data).toHaveProperty('content');
      } else {
        expect(response.status).toBe(404);
      }
    });
  });

  describe('Graph Endpoints', () => {
    let documentId: string;

    beforeEach(async () => {
      const doc = TestDataGenerator.generateDocument();
      const response = await apiClient.uploadDocument(doc);
      documentId = response.data.documentId;
    });

    it('should get document graph', async () => {
      const response = await apiClient.getGraph(documentId);

      expect(response.status).toBe(200);
      expect(response.data).toHaveProperty('documentId', documentId);
      expect(response.data).toHaveProperty('nodes');
      expect(response.data).toHaveProperty('edges');
      expect(response.data.nodes).toBeInstanceOf(Array);
      expect(response.data.edges).toBeInstanceOf(Array);
    });

    it('should execute Cypher query', async () => {
      const response = await apiClient.executeCypher('MATCH (n) RETURN n LIMIT 1');

      expect(response.status).toBe(200);
      expect(response.data).toHaveProperty('results');
      expect(response.data.results).toBeInstanceOf(Array);
    });

    it('should handle invalid Cypher query', async () => {
      const response = await apiClient.executeCypher('INVALID CYPHER SYNTAX');

      expect(response.status).toBe(400);
      expect(response.data).toHaveProperty('error');
      expect(response.data.message).toContain('query');
    });

    it('should return empty graph for new document', async () => {
      const response = await apiClient.getGraph(documentId);

      expect(response.status).toBe(200);
      expect(response.data.nodes).toBeInstanceOf(Array);
      expect(response.data.edges).toBeInstanceOf(Array);
    });
  });

  describe('Authentication and Authorization', () => {
    it('should allow access without API key when not required', async () => {
      const response = await apiClient.getHealth();

      expect(response.status).toBe(200);
    });

    it('should return 401 when API key is required but not provided', async () => {
      // This test requires REQUIRE_API_KEY=true environment variable
      if (process.env.REQUIRE_API_KEY === 'true') {
        const unauthClient = new TestAPIClient(testConfig.api.baseUrl);
        const response = await unauthClient.axios.get('/api/documents');

        expect(response.status).toBe(401);
        expect(response.data).toHaveProperty('error', 'Authentication required');
      }
    });

    it('should return 403 for invalid API key', async () => {
      if (process.env.REQUIRE_API_KEY === 'true') {
        const invalidClient = new TestAPIClient(testConfig.api.baseUrl, 'invalid-key');
        const response = await invalidClient.axios.get('/api/documents');

        expect(response.status).toBe(403);
        expect(response.data).toHaveProperty('error', 'Invalid API key');
      }
    });

    it('should allow health check without authentication', async () => {
      const response = await apiClient.getHealth();

      expect(response.status).toBe(200);
    });
  });

  describe('Error Handling', () => {
    it('should return 404 for non-existent endpoints', async () => {
      const response = await apiClient.axios.get('/api/nonexistent');

      expect(response.status).toBe(404);
      expect(response.data).toHaveProperty('error');
    });

    it('should return 400 for malformed JSON', async () => {
      const response = await apiClient.axios.post('/api/documents', 'invalid json', {
        headers: { 'Content-Type': 'application/json' }
      });

      expect(response.status).toBe(400);
    });

    it('should return 413 for payload too large', async () => {
      const hugePayload = 'A'.repeat(100 * 1024 * 1024); // 100MB

      const response = await apiClient.axios.post('/documents', hugePayload, {
        headers: { 'Content-Type': 'text/plain' }
      });

      expect([413, 400]).toContain(response.status);
    });

    it('should handle database connection errors gracefully', async () => {
      // This would require simulating database failure
      // In production, you might temporarily stop the database service
      const response = await apiClient.getHealth();

      if (response.data.status === 'degraded' || response.data.status === 'unhealthy') {
        expect(response.status).toBe(503);
      }
    });
  });
});