/**
 * Test Helpers and Utilities for GraphRAG Testing
 * Provides reusable functions for test setup, teardown, and data generation
 */

import { v4 as uuidv4 } from 'uuid';
import axios, { AxiosInstance } from 'axios';
import { faker } from '@faker-js/faker';
import { TestConnections } from '../test-config';

/**
 * Test Data Generator
 */
export class TestDataGenerator {
  /**
   * Generate a random document
   */
  static generateDocument(options: Partial<{
    title: string;
    content: string;
    type: string;
    format: string;
    tags: string[];
    size: number;
  }> = {}) {
    const content = options.content || faker.lorem.paragraphs(5);

    return {
      title: options.title || faker.lorem.sentence(),
      content,
      type: options.type || 'text',
      format: options.format || 'plain',
      tags: options.tags || [faker.word.noun(), faker.word.adjective()],
      metadata: {
        author: faker.person.fullName(),
        created: faker.date.recent(),
        source: faker.internet.url(),
        language: 'en',
        size: options.size || content.length
      }
    };
  }

  /**
   * Generate multiple documents
   */
  static generateDocuments(count: number) {
    return Array.from({ length: count }, () => this.generateDocument());
  }

  /**
   * Generate a memory entry
   */
  static generateMemory() {
    return {
      content: faker.lorem.paragraph(),
      tags: [faker.word.noun(), faker.word.verb()],
      metadata: {
        session: uuidv4(),
        timestamp: new Date().toISOString(),
        importance: faker.number.float({ min: 0, max: 1 })
      }
    };
  }

  /**
   * Generate search query
   */
  static generateSearchQuery() {
    return {
      query: faker.lorem.words(3),
      filters: {
        type: faker.helpers.arrayElement(['text', 'pdf', 'markdown']),
        tags: [faker.word.noun()],
        dateRange: {
          from: faker.date.recent({ days: 30 }),
          to: new Date()
        }
      },
      limit: faker.number.int({ min: 5, max: 20 })
    };
  }

  /**
   * Generate large document for performance testing
   */
  static generateLargeDocument(sizeInKB: number) {
    const targetSize = sizeInKB * 1024;
    let content = '';

    while (content.length < targetSize) {
      content += faker.lorem.paragraphs(10) + '\n\n';
    }

    return {
      title: `Large Document ${sizeInKB}KB`,
      content: content.substring(0, targetSize),
      type: 'text',
      format: 'plain',
      metadata: {
        size: targetSize,
        chunks_expected: Math.ceil(targetSize / 1000)
      }
    };
  }

  /**
   * Generate Cypher query for testing
   */
  static generateCypherQuery() {
    const queries = [
      'MATCH (n) RETURN n LIMIT 10',
      'MATCH (d:Document) RETURN d.title, d.id',
      'MATCH (d:Document)-[r:CONTAINS]->(e:Entity) RETURN d, r, e',
      'MATCH path = (d:Document)-[*1..3]-(n) RETURN path',
      'MATCH (e:Entity {type: "Person"}) RETURN e.name'
    ];

    return faker.helpers.arrayElement(queries);
  }
}

/**
 * API Test Client
 */
export class TestAPIClient {
  private axios: AxiosInstance;

  constructor(baseURL: string, apiKey?: string) {
    this.axios = axios.create({
      baseURL,
      timeout: 30000,
      headers: {
        'Content-Type': 'application/json',
        ...(apiKey && { 'X-API-Key': apiKey })
      },
      validateStatus: () => true // Don't throw on any status
    });
  }

  async uploadDocument(document: any) {
    return this.axios.post('/documents', document);
  }

  async uploadDocuments(documents: any[]) {
    return this.axios.post('/documents/batch', { documents });
  }

  async getDocument(id: string) {
    return this.axios.get(`/documents/${id}`);
  }

  async listDocuments(params?: any) {
    return this.axios.get('/documents', { params });
  }

  async deleteDocument(id: string) {
    return this.axios.delete(`/documents/${id}`);
  }

  async getChunks(documentId: string) {
    return this.axios.get(`/documents/${documentId}/chunks`);
  }

  async searchDocuments(query: any) {
    return this.axios.post('/search', query);
  }

  async getHealth() {
    return this.axios.get('/api/health');
  }

  async storeMemory(memory: any) {
    return this.axios.post('/api/memory', memory);
  }

  async recallMemories(query: any) {
    return this.axios.post('/api/memory/recall', query);
  }

  async getGraph(documentId: string) {
    return this.axios.get(`/graph/documents/${documentId}`);
  }

  async executeCypher(query: string) {
    return this.axios.post('/graph/query', { query });
  }
}

/**
 * Database Test Utilities
 */
export class DatabaseTestUtils {
  private connections: TestConnections;

  constructor() {
    this.connections = TestConnections.getInstance();
  }

  /**
   * Clean all test data
   */
  async cleanDatabase() {
    const client = await this.connections.postgresPool.connect();

    try {
      await client.query('BEGIN');

      // Delete in correct order to respect foreign keys
      await client.query('DELETE FROM graphrag.document_chunks');
      await client.query('DELETE FROM graphrag.document_content');
      await client.query('DELETE FROM graphrag.document_summaries');
      await client.query('DELETE FROM graphrag.document_outlines');
      await client.query('DELETE FROM graphrag.search_index');
      await client.query('DELETE FROM graphrag.document_tags');
      await client.query('DELETE FROM graphrag.processing_jobs');
      await client.query('DELETE FROM graphrag.documents');
      await client.query('DELETE FROM graphrag.memories');

      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }

    // Clean Redis
    await this.connections.redisClient.flushdb();

    // Clean Neo4j
    const session = this.connections.neo4jDriver.session();
    try {
      await session.run('MATCH (n) DETACH DELETE n');
    } finally {
      await session.close();
    }

    // Clean Qdrant collections
    try {
      const collections = await this.connections.qdrantClient.getCollections();
      for (const collection of collections.collections) {
        await this.connections.qdrantClient.deleteCollection(collection.name);
        await this.connections.qdrantClient.createCollection(collection.name, {
          vectors: {
            size: 1024,
            distance: 'Cosine'
          }
        });
      }
    } catch (error) {
      console.warn('Qdrant cleanup skipped:', error);
    }
  }

  /**
   * Seed test data
   */
  async seedTestData() {
    const documents = TestDataGenerator.generateDocuments(10);
    const memories = Array.from({ length: 5 }, () => TestDataGenerator.generateMemory());

    const client = await this.connections.postgresPool.connect();

    try {
      await client.query('BEGIN');

      // Insert documents
      for (const doc of documents) {
        const id = uuidv4();
        await client.query(`
          INSERT INTO graphrag.documents (id, title, type, format, tags, metadata)
          VALUES ($1, $2, $3, $4, $5, $6)
        `, [id, doc.title, doc.type, doc.format, doc.tags, doc.metadata]);

        await client.query(`
          INSERT INTO graphrag.document_content (document_id, content)
          VALUES ($1, $2)
        `, [id, doc.content]);

        // Create chunks
        const chunkSize = 1000;
        for (let i = 0; i < doc.content.length; i += chunkSize) {
          const chunkId = `${id}_chunk_${i}`;
          const chunk = doc.content.slice(i, i + chunkSize);

          await client.query(`
            INSERT INTO graphrag.document_chunks (id, document_id, chunk_index, content, metadata)
            VALUES ($1, $2, $3, $4, $5)
          `, [chunkId, id, Math.floor(i / chunkSize), chunk, {}]);
        }

        // Add to search index
        await client.query(`
          INSERT INTO graphrag.search_index (document_id, content, search_vector)
          VALUES ($1, $2, to_tsvector('english', $2))
        `, [id, doc.content]);
      }

      // Insert memories
      for (const memory of memories) {
        await client.query(`
          INSERT INTO graphrag.memories (content, tags, metadata)
          VALUES ($1, $2, $3)
        `, [memory.content, memory.tags, memory.metadata]);
      }

      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }

    // Seed Neo4j with graph data
    const session = this.connections.neo4jDriver.session();
    try {
      // Create some document nodes
      await session.run(`
        UNWIND $documents as doc
        CREATE (d:Document {id: doc.id, title: doc.title})
      `, { documents: documents.slice(0, 5).map(d => ({ id: uuidv4(), title: d.title })) });

      // Create entity nodes
      await session.run(`
        CREATE (e1:Entity {name: 'Test Entity 1', type: 'Person'})
        CREATE (e2:Entity {name: 'Test Entity 2', type: 'Organization'})
        CREATE (e3:Entity {name: 'Test Entity 3', type: 'Location'})
      `);

      // Create relationships
      await session.run(`
        MATCH (d:Document), (e:Entity)
        WHERE d.id IS NOT NULL AND e.name IS NOT NULL
        WITH d, e LIMIT 10
        CREATE (d)-[:CONTAINS]->(e)
      `);
    } finally {
      await session.close();
    }
  }

  /**
   * Verify data consistency
   */
  async verifyDataConsistency(): Promise<{
    consistent: boolean;
    issues: string[];
  }> {
    const issues: string[] = [];
    const client = await this.connections.postgresPool.connect();

    try {
      // Check for orphaned chunks
      const orphanedChunks = await client.query(`
        SELECT COUNT(*) as count
        FROM graphrag.document_chunks c
        LEFT JOIN graphrag.documents d ON c.document_id = d.id
        WHERE d.id IS NULL
      `);

      if (parseInt(orphanedChunks.rows[0].count) > 0) {
        issues.push(`Found ${orphanedChunks.rows[0].count} orphaned chunks`);
      }

      // Check for documents without content
      const contentless = await client.query(`
        SELECT COUNT(*) as count
        FROM graphrag.documents d
        LEFT JOIN graphrag.document_content c ON d.id = c.document_id
        WHERE c.document_id IS NULL
      `);

      if (parseInt(contentless.rows[0].count) > 0) {
        issues.push(`Found ${contentless.rows[0].count} documents without content`);
      }

      // Check search index consistency
      const unindexed = await client.query(`
        SELECT COUNT(*) as count
        FROM graphrag.documents d
        LEFT JOIN graphrag.search_index s ON d.id = s.document_id
        WHERE s.document_id IS NULL
      `);

      if (parseInt(unindexed.rows[0].count) > 0) {
        issues.push(`Found ${unindexed.rows[0].count} unindexed documents`);
      }

      return {
        consistent: issues.length === 0,
        issues
      };
    } finally {
      client.release();
    }
  }
}

/**
 * Performance Test Utilities
 */
export class PerformanceTestUtils {
  /**
   * Measure operation performance
   */
  static async measurePerformance<T>(
    operation: () => Promise<T>,
    iterations: number = 1
  ): Promise<{
    result: T;
    metrics: {
      min: number;
      max: number;
      avg: number;
      p50: number;
      p95: number;
      p99: number;
    };
  }> {
    const times: number[] = [];
    let result: T;

    for (let i = 0; i < iterations; i++) {
      const start = performance.now();
      result = await operation();
      const duration = performance.now() - start;
      times.push(duration);
    }

    times.sort((a, b) => a - b);

    return {
      result: result!,
      metrics: {
        min: times[0],
        max: times[times.length - 1],
        avg: times.reduce((a, b) => a + b, 0) / times.length,
        p50: times[Math.floor(times.length * 0.5)],
        p95: times[Math.floor(times.length * 0.95)],
        p99: times[Math.floor(times.length * 0.99)]
      }
    };
  }

  /**
   * Generate concurrent load
   */
  static async generateConcurrentLoad<T>(
    operation: () => Promise<T>,
    concurrency: number
  ): Promise<{
    successful: number;
    failed: number;
    duration: number;
    errors: any[];
  }> {
    const start = performance.now();
    const promises = Array.from({ length: concurrency }, () => operation());
    const results = await Promise.allSettled(promises);

    const successful = results.filter(r => r.status === 'fulfilled').length;
    const failed = results.filter(r => r.status === 'rejected').length;
    const errors = results
      .filter(r => r.status === 'rejected')
      .map(r => (r as PromiseRejectedResult).reason);

    return {
      successful,
      failed,
      duration: performance.now() - start,
      errors
    };
  }

  /**
   * Monitor memory usage
   */
  static getMemoryUsage() {
    const usage = process.memoryUsage();
    return {
      rss: Math.round(usage.rss / 1024 / 1024), // MB
      heapTotal: Math.round(usage.heapTotal / 1024 / 1024), // MB
      heapUsed: Math.round(usage.heapUsed / 1024 / 1024), // MB
      external: Math.round(usage.external / 1024 / 1024), // MB
      arrayBuffers: Math.round(usage.arrayBuffers / 1024 / 1024) // MB
    };
  }
}

/**
 * Assertion Helpers
 */
export class AssertionHelpers {
  /**
   * Assert API response structure
   */
  static assertAPIResponse(response: any, expectedStatus: number, schema?: any) {
    expect(response.status).toBe(expectedStatus);

    if (schema) {
      expect(response.data).toMatchObject(schema);
    }
  }

  /**
   * Assert pagination structure
   */
  static assertPaginationResponse(response: any) {
    expect(response.data).toHaveProperty('page');
    expect(response.data).toHaveProperty('limit');
    expect(response.data).toHaveProperty('total');
    expect(response.data).toHaveProperty('totalPages');
    expect(typeof response.data.page).toBe('number');
    expect(typeof response.data.limit).toBe('number');
    expect(typeof response.data.total).toBe('number');
    expect(typeof response.data.totalPages).toBe('number');
  }

  /**
   * Assert error response
   */
  static assertErrorResponse(response: any, expectedStatus: number, errorCode?: string) {
    expect(response.status).toBe(expectedStatus);
    expect(response.data).toHaveProperty('error');

    if (errorCode) {
      expect(response.data.error).toBe(errorCode);
    }
  }

  /**
   * Assert WebSocket message
   */
  static assertWebSocketMessage(message: any, type: string, schema?: any) {
    expect(message).toHaveProperty('type');
    expect(message.type).toBe(type);

    if (schema) {
      expect(message).toMatchObject(schema);
    }
  }
}