/**
 * Unit Tests for GraphRAG Storage Engine
 * Tests all document storage, chunking, and indexing functionality
 */

import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from '@jest/globals';
import { GraphRAGStorageEngine } from '../../../src/storage/storage-engine';
import { TestConnections, testConfig } from '../../test-config';
import { TestDataGenerator, DatabaseTestUtils } from '../../helpers/test-helpers';
import { v4 as uuidv4 } from 'uuid';

describe('GraphRAG Storage Engine', () => {
  let storageEngine: GraphRAGStorageEngine;
  let connections: TestConnections;
  let dbUtils: DatabaseTestUtils;

  beforeAll(async () => {
    connections = TestConnections.getInstance();
    dbUtils = new DatabaseTestUtils();

    // Ensure test database is ready
    const healthy = await connections.healthCheck();
    if (!healthy) {
      throw new Error('Test database connections not healthy');
    }
  });

  beforeEach(async () => {
    // Clean database before each test
    await dbUtils.cleanDatabase();

    // Initialize storage engine
    storageEngine = new GraphRAGStorageEngine();
  });

  afterEach(async () => {
    // Cleanup after each test
    await dbUtils.cleanDatabase();
  });

  afterAll(async () => {
    await connections.cleanup();
  });

  describe('Document Storage', () => {
    it('should store a new document successfully', async () => {
      const document = TestDataGenerator.generateDocument();

      const result = await storageEngine.storeDocument(document.content, {
        title: document.title,
        type: document.type,
        format: document.format,
        tags: document.tags
      });

      expect(result.success).toBe(true);
      expect(result.documentId).toBeDefined();
      expect(result.documentId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    });

    it('should detect and handle duplicate documents', async () => {
      const document = TestDataGenerator.generateDocument();

      // Store document first time
      const result1 = await storageEngine.storeDocument(document.content, {
        title: document.title
      });

      // Try to store same document again
      const result2 = await storageEngine.storeDocument(document.content, {
        title: document.title
      });

      expect(result1.success).toBe(true);
      expect(result2.success).toBe(true);
      expect(result2.duplicate).toBe(true);
      expect(result2.documentId).toBe(result1.documentId);
    });

    it('should handle various content types', async () => {
      const contentTypes = [
        { content: 'Plain text content', format: 'plain' },
        { content: '# Markdown Content\n\n- Item 1\n- Item 2', format: 'markdown' },
        { content: '<html><body>HTML content</body></html>', format: 'html' },
        { content: JSON.stringify({ key: 'value' }), format: 'json' }
      ];

      for (const { content, format } of contentTypes) {
        const result = await storageEngine.storeDocument(content, {
          title: `Test ${format}`,
          format
        });

        expect(result.success).toBe(true);
        expect(result.metadata.format).toBe(format);
      }
    });

    it('should store document metadata correctly', async () => {
      const metadata = {
        title: 'Test Document',
        type: 'research',
        format: 'plain',
        tags: ['test', 'unit', 'storage'],
        source: 'https://example.com',
        author: 'Test Author',
        custom: {
          category: 'testing',
          priority: 'high'
        }
      };

      const result = await storageEngine.storeDocument('Test content', metadata);

      expect(result.success).toBe(true);
      expect(result.metadata).toMatchObject({
        title: metadata.title,
        type: metadata.type,
        format: metadata.format,
        tags: metadata.tags
      });
    });

    it('should handle empty content gracefully', async () => {
      const result = await storageEngine.storeDocument('', {
        title: 'Empty Document'
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('empty');
    });

    it('should handle very large documents', async () => {
      const largeDoc = TestDataGenerator.generateLargeDocument(500); // 500KB

      const result = await storageEngine.storeDocument(largeDoc.content, {
        title: largeDoc.title
      });

      expect(result.success).toBe(true);
      expect(result.metadata.size).toBeGreaterThan(500000);
    });

    it('should update document version on modifications', async () => {
      const documentId = uuidv4();
      const content1 = 'Original content';
      const content2 = 'Updated content';

      // Store initial version
      const result1 = await storageEngine.storeDocument(content1, {
        id: documentId,
        title: 'Version Test'
      });

      // Update document
      const result2 = await storageEngine.updateDocument(documentId, content2, {
        title: 'Version Test Updated'
      });

      expect(result1.metadata.version).toBe(1);
      expect(result2.metadata.version).toBe(2);
    });
  });

  describe('Document Chunking', () => {
    it('should create chunks with default strategy', async () => {
      const content = TestDataGenerator.generateDocument({
        content: 'A'.repeat(3500) // Content longer than default chunk size
      }).content;

      const chunks = await storageEngine.createChunks(content, {
        strategy: 'default',
        chunkSize: 1000,
        overlap: 200
      });

      expect(chunks.length).toBeGreaterThan(1);
      expect(chunks[0].content.length).toBeLessThanOrEqual(1000);

      // Check overlap
      if (chunks.length > 1) {
        const overlap = chunks[0].content.slice(-200);
        expect(chunks[1].content.startsWith(overlap)).toBe(true);
      }
    });

    it('should create sentence-based chunks', async () => {
      const content = 'First sentence. Second sentence. Third sentence. Fourth sentence.';

      const chunks = await storageEngine.createChunks(content, {
        strategy: 'sentence',
        chunkSize: 30
      });

      expect(chunks.length).toBeGreaterThan(1);
      chunks.forEach(chunk => {
        expect(chunk.content.endsWith('.')).toBe(true);
      });
    });

    it('should create paragraph-based chunks', async () => {
      const content = 'Paragraph 1.\n\nParagraph 2.\n\nParagraph 3.';

      const chunks = await storageEngine.createChunks(content, {
        strategy: 'paragraph'
      });

      expect(chunks.length).toBe(3);
      expect(chunks[0].content).toBe('Paragraph 1.');
      expect(chunks[1].content).toBe('Paragraph 2.');
      expect(chunks[2].content).toBe('Paragraph 3.');
    });

    it('should handle custom chunk sizes', async () => {
      const content = 'A'.repeat(10000);
      const chunkSizes = [500, 1000, 2000, 5000];

      for (const chunkSize of chunkSizes) {
        const chunks = await storageEngine.createChunks(content, {
          strategy: 'default',
          chunkSize,
          overlap: 0
        });

        const expectedChunks = Math.ceil(content.length / chunkSize);
        expect(chunks.length).toBe(expectedChunks);
      }
    });

    it('should store chunk metadata', async () => {
      const content = 'Test content for chunking';
      const documentId = uuidv4();

      const chunks = await storageEngine.createChunks(content, {
        documentId,
        metadata: {
          source: 'test',
          language: 'en'
        }
      });

      expect(chunks[0].metadata).toMatchObject({
        documentId,
        source: 'test',
        language: 'en',
        index: 0
      });
    });

    it('should handle empty content for chunking', async () => {
      const chunks = await storageEngine.createChunks('', {});

      expect(chunks).toEqual([]);
    });

    it('should preserve special characters in chunks', async () => {
      const content = 'Code: function test() { return "hello"; }\n\nMath: x² + y² = z²';

      const chunks = await storageEngine.createChunks(content, {
        strategy: 'default',
        chunkSize: 50
      });

      const reconstructed = chunks.map(c => c.content).join('');
      expect(reconstructed).toContain('function test()');
      expect(reconstructed).toContain('x² + y²');
    });
  });

  describe('Document Indexing', () => {
    it('should create search index for documents', async () => {
      const document = TestDataGenerator.generateDocument();

      const result = await storageEngine.storeDocument(document.content, {
        title: document.title
      });

      const index = await storageEngine.getSearchIndex(result.documentId);

      expect(index).toBeDefined();
      expect(index.documentId).toBe(result.documentId);
      expect(index.searchVector).toBeDefined();
    });

    it('should support full-text search', async () => {
      const documents = [
        { content: 'GraphRAG is a powerful system', title: 'Doc 1' },
        { content: 'Machine learning and AI', title: 'Doc 2' },
        { content: 'Knowledge graphs are useful', title: 'Doc 3' }
      ];

      const docIds = [];
      for (const doc of documents) {
        const result = await storageEngine.storeDocument(doc.content, { title: doc.title });
        docIds.push(result.documentId);
      }

      const searchResults = await storageEngine.searchDocuments('GraphRAG');

      expect(searchResults.length).toBeGreaterThan(0);
      expect(searchResults[0].documentId).toBe(docIds[0]);
    });

    it('should rank search results by relevance', async () => {
      const documents = [
        { content: 'GraphRAG GraphRAG GraphRAG', title: 'Most relevant' },
        { content: 'GraphRAG is mentioned once', title: 'Less relevant' },
        { content: 'No mention of the search term', title: 'Not relevant' }
      ];

      for (const doc of documents) {
        await storageEngine.storeDocument(doc.content, { title: doc.title });
      }

      const searchResults = await storageEngine.searchDocuments('GraphRAG');

      expect(searchResults[0].title).toBe('Most relevant');
      expect(searchResults[0].rank).toBeGreaterThan(searchResults[1].rank);
    });

    it('should handle search with filters', async () => {
      const documents = [
        { content: 'Test content', title: 'Doc 1', type: 'research', tags: ['ai'] },
        { content: 'Test content', title: 'Doc 2', type: 'tutorial', tags: ['ml'] },
        { content: 'Test content', title: 'Doc 3', type: 'research', tags: ['ai', 'ml'] }
      ];

      for (const doc of documents) {
        await storageEngine.storeDocument(doc.content, {
          title: doc.title,
          type: doc.type,
          tags: doc.tags
        });
      }

      const results = await storageEngine.searchDocuments('Test', {
        filters: {
          type: 'research',
          tags: ['ai']
        }
      });

      expect(results.length).toBe(2);
      results.forEach(result => {
        expect(result.type).toBe('research');
        expect(result.tags).toContain('ai');
      });
    });

    it('should update search index on document update', async () => {
      const documentId = uuidv4();

      // Store initial document
      await storageEngine.storeDocument('Original content about GraphRAG', {
        id: documentId,
        title: 'Test Doc'
      });

      // Search for original term
      let results = await storageEngine.searchDocuments('GraphRAG');
      expect(results.length).toBe(1);

      // Update document
      await storageEngine.updateDocument(documentId, 'Updated content about machine learning', {});

      // Search for new term
      results = await storageEngine.searchDocuments('machine learning');
      expect(results.length).toBe(1);

      // Original term should not match
      results = await storageEngine.searchDocuments('GraphRAG');
      expect(results.length).toBe(0);
    });
  });

  describe('Document Retrieval', () => {
    it('should retrieve document by ID', async () => {
      const original = TestDataGenerator.generateDocument();

      const storeResult = await storageEngine.storeDocument(original.content, {
        title: original.title
      });

      const retrieved = await storageEngine.getDocument(storeResult.documentId);

      expect(retrieved).toBeDefined();
      expect(retrieved.id).toBe(storeResult.documentId);
      expect(retrieved.title).toBe(original.title);
      expect(retrieved.content).toBe(original.content);
    });

    it('should list documents with pagination', async () => {
      // Store multiple documents
      for (let i = 0; i < 25; i++) {
        const doc = TestDataGenerator.generateDocument();
        await storageEngine.storeDocument(doc.content, {
          title: `Document ${i + 1}`
        });
      }

      // Get first page
      const page1 = await storageEngine.listDocuments({
        page: 1,
        limit: 10
      });

      expect(page1.documents.length).toBe(10);
      expect(page1.total).toBe(25);
      expect(page1.totalPages).toBe(3);

      // Get second page
      const page2 = await storageEngine.listDocuments({
        page: 2,
        limit: 10
      });

      expect(page2.documents.length).toBe(10);
      expect(page2.documents[0].id).not.toBe(page1.documents[0].id);
    });

    it('should filter documents by tags', async () => {
      const documents = [
        { title: 'Doc 1', tags: ['ai', 'ml'] },
        { title: 'Doc 2', tags: ['ai', 'nlp'] },
        { title: 'Doc 3', tags: ['ml', 'cv'] },
        { title: 'Doc 4', tags: ['nlp'] }
      ];

      for (const doc of documents) {
        await storageEngine.storeDocument('Content', doc);
      }

      const filtered = await storageEngine.listDocuments({
        tags: ['ai']
      });

      expect(filtered.documents.length).toBe(2);
      filtered.documents.forEach(doc => {
        expect(doc.tags).toContain('ai');
      });
    });

    it('should filter documents by date range', async () => {
      const now = new Date();
      const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);
      const tomorrow = new Date(now.getTime() + 24 * 60 * 60 * 1000);

      await storageEngine.storeDocument('Recent doc', {
        title: 'Recent',
        created_at: now
      });

      const filtered = await storageEngine.listDocuments({
        dateRange: {
          from: yesterday,
          to: tomorrow
        }
      });

      expect(filtered.documents.length).toBeGreaterThan(0);
      filtered.documents.forEach(doc => {
        const createdAt = new Date(doc.created_at);
        expect(createdAt.getTime()).toBeGreaterThanOrEqual(yesterday.getTime());
        expect(createdAt.getTime()).toBeLessThanOrEqual(tomorrow.getTime());
      });
    });
  });

  describe('Document Deletion', () => {
    it('should delete document and all related data', async () => {
      const doc = TestDataGenerator.generateDocument();

      const result = await storageEngine.storeDocument(doc.content, {
        title: doc.title
      });

      // Verify document exists
      let retrieved = await storageEngine.getDocument(result.documentId);
      expect(retrieved).toBeDefined();

      // Delete document
      const deleteResult = await storageEngine.deleteDocument(result.documentId);
      expect(deleteResult.success).toBe(true);

      // Verify document is deleted
      retrieved = await storageEngine.getDocument(result.documentId);
      expect(retrieved).toBeNull();

      // Verify chunks are deleted
      const chunks = await storageEngine.getDocumentChunks(result.documentId);
      expect(chunks.length).toBe(0);

      // Verify search index is cleaned
      const searchResults = await storageEngine.searchDocuments(doc.title);
      expect(searchResults.length).toBe(0);
    });

    it('should handle deletion of non-existent document', async () => {
      const result = await storageEngine.deleteDocument(uuidv4());

      expect(result.success).toBe(false);
      expect(result.error).toContain('not found');
    });
  });

  describe('Batch Operations', () => {
    it('should store multiple documents in batch', async () => {
      const documents = TestDataGenerator.generateDocuments(10);

      const results = await storageEngine.batchStoreDocuments(documents);

      expect(results.successful).toBe(10);
      expect(results.failed).toBe(0);
      expect(results.documents.length).toBe(10);

      results.documents.forEach(result => {
        expect(result.success).toBe(true);
        expect(result.documentId).toBeDefined();
      });
    });

    it('should handle partial batch failures', async () => {
      const documents = [
        TestDataGenerator.generateDocument(),
        { content: '', title: 'Empty' }, // This should fail
        TestDataGenerator.generateDocument()
      ];

      const results = await storageEngine.batchStoreDocuments(documents);

      expect(results.successful).toBe(2);
      expect(results.failed).toBe(1);
      expect(results.documents[1].success).toBe(false);
    });

    it('should batch delete documents', async () => {
      const documents = TestDataGenerator.generateDocuments(5);
      const documentIds = [];

      // Store documents
      for (const doc of documents) {
        const result = await storageEngine.storeDocument(doc.content, {
          title: doc.title
        });
        documentIds.push(result.documentId);
      }

      // Batch delete
      const deleteResults = await storageEngine.batchDeleteDocuments(documentIds);

      expect(deleteResults.successful).toBe(5);
      expect(deleteResults.failed).toBe(0);

      // Verify all deleted
      for (const id of documentIds) {
        const doc = await storageEngine.getDocument(id);
        expect(doc).toBeNull();
      }
    });
  });

  describe('Transaction Management', () => {
    it('should rollback on failure', async () => {
      const doc = TestDataGenerator.generateDocument();

      // Simulate a failure during storage
      const mockError = new Error('Simulated database error');
      jest.spyOn(storageEngine, 'createChunks').mockRejectedValueOnce(mockError);

      const result = await storageEngine.storeDocument(doc.content, {
        title: doc.title
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('Simulated database error');

      // Verify nothing was stored
      const documents = await storageEngine.listDocuments({});
      expect(documents.total).toBe(0);
    });

    it('should maintain consistency across related tables', async () => {
      const doc = TestDataGenerator.generateDocument();

      const result = await storageEngine.storeDocument(doc.content, {
        title: doc.title
      });

      // Verify consistency
      const consistency = await dbUtils.verifyDataConsistency();

      expect(consistency.consistent).toBe(true);
      expect(consistency.issues).toEqual([]);
    });
  });
});