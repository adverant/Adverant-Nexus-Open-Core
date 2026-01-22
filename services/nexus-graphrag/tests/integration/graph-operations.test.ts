/**
 * Graph Operations Integration Tests for GraphRAG
 * Tests Neo4j integration, entity extraction, and graph building
 */

import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from '@jest/globals';
import neo4j from 'neo4j-driver';
import { TestConnections } from '../test-config';
import { TestDataGenerator, DatabaseTestUtils, TestAPIClient } from '../helpers/test-helpers';
import { EntityExtractionService } from '../../src/services/entity-extraction-service';
import { GraphBuilderService } from '../../src/services/graph-builder-service';

describe('GraphRAG Graph Operations Tests', () => {
  let driver: neo4j.Driver;
  let session: neo4j.Session;
  let connections: TestConnections;
  let dbUtils: DatabaseTestUtils;
  let apiClient: TestAPIClient;
  let entityExtractor: EntityExtractionService;
  let graphBuilder: GraphBuilderService;

  beforeAll(async () => {
    connections = TestConnections.getInstance();
    driver = connections.neo4jDriver;
    dbUtils = new DatabaseTestUtils();
    apiClient = new TestAPIClient(process.env.API_BASE_URL || 'http://localhost:8090');

    // Initialize services
    entityExtractor = new EntityExtractionService();
    graphBuilder = new GraphBuilderService(driver);

    // Verify Neo4j connection
    await driver.verifyConnectivity();
  });

  beforeEach(async () => {
    session = driver.session();
    // Clear graph database
    await session.run('MATCH (n) DETACH DELETE n');
  });

  afterEach(async () => {
    await session.close();
  });

  afterAll(async () => {
    await driver.close();
    await connections.cleanup();
  });

  describe('Neo4j Connection and Basic Operations', () => {
    it('should connect to Neo4j successfully', async () => {
      const result = await session.run('RETURN 1 as number');
      expect(result.records).toHaveLength(1);
      expect(result.records[0].get('number').toNumber()).toBe(1);
    });

    it('should create and retrieve nodes', async () => {
      // Create node
      const createResult = await session.run(
        'CREATE (d:Document {id: $id, title: $title}) RETURN d',
        { id: 'test-123', title: 'Test Document' }
      );

      expect(createResult.records).toHaveLength(1);

      // Retrieve node
      const getResult = await session.run(
        'MATCH (d:Document {id: $id}) RETURN d',
        { id: 'test-123' }
      );

      const node = getResult.records[0].get('d');
      expect(node.properties.title).toBe('Test Document');
    });

    it('should create and traverse relationships', async () => {
      // Create nodes and relationships
      await session.run(`
        CREATE (d:Document {id: 'doc-1', title: 'Document 1'})
        CREATE (e1:Entity {name: 'Entity 1', type: 'Person'})
        CREATE (e2:Entity {name: 'Entity 2', type: 'Organization'})
        CREATE (d)-[:CONTAINS]->(e1)
        CREATE (d)-[:CONTAINS]->(e2)
        CREATE (e1)-[:RELATED_TO]->(e2)
      `);

      // Traverse relationships
      const result = await session.run(`
        MATCH (d:Document {id: 'doc-1'})-[:CONTAINS]->(e:Entity)
        RETURN e.name as name, e.type as type
        ORDER BY e.name
      `);

      expect(result.records).toHaveLength(2);
      expect(result.records[0].get('name')).toBe('Entity 1');
      expect(result.records[1].get('name')).toBe('Entity 2');
    });
  });

  describe('Entity Extraction', () => {
    it('should extract person entities from text', async () => {
      const text = 'John Smith met with Sarah Johnson at Microsoft headquarters. Bill Gates was also present.';

      const entities = await entityExtractor.extractEntities(text);

      const persons = entities.filter(e => e.type === 'Person');
      expect(persons).toContainEqual(
        expect.objectContaining({ name: 'John Smith', type: 'Person' })
      );
      expect(persons).toContainEqual(
        expect.objectContaining({ name: 'Sarah Johnson', type: 'Person' })
      );
      expect(persons).toContainEqual(
        expect.objectContaining({ name: 'Bill Gates', type: 'Person' })
      );
    });

    it('should extract organization entities', async () => {
      const text = 'Apple Inc. announced a partnership with Google LLC and Microsoft Corporation.';

      const entities = await entityExtractor.extractEntities(text);

      const orgs = entities.filter(e => e.type === 'Organization');
      expect(orgs).toContainEqual(
        expect.objectContaining({ name: 'Apple Inc.', type: 'Organization' })
      );
      expect(orgs).toContainEqual(
        expect.objectContaining({ name: 'Google LLC', type: 'Organization' })
      );
      expect(orgs).toContainEqual(
        expect.objectContaining({ name: 'Microsoft Corporation', type: 'Organization' })
      );
    });

    it('should extract location entities', async () => {
      const text = 'The conference will be held in San Francisco, California, with satellite events in New York and London.';

      const entities = await entityExtractor.extractEntities(text);

      const locations = entities.filter(e => e.type === 'Location');
      expect(locations.length).toBeGreaterThan(0);
      expect(locations).toContainEqual(
        expect.objectContaining({ type: 'Location' })
      );
    });

    it('should extract dates and times', async () => {
      const text = 'The meeting is scheduled for January 15, 2024 at 3:00 PM. The deadline is next Friday.';

      const entities = await entityExtractor.extractEntities(text);

      const dates = entities.filter(e => e.type === 'Date' || e.type === 'Time');
      expect(dates.length).toBeGreaterThan(0);
    });

    it('should extract relationships between entities', async () => {
      const text = 'CEO Tim Cook of Apple announced that Steve Wozniak, co-founder, will join the board.';

      const result = await entityExtractor.extractEntitiesWithRelationships(text);

      expect(result.entities).toBeDefined();
      expect(result.relationships).toBeDefined();
      expect(result.relationships).toContainEqual(
        expect.objectContaining({
          source: expect.any(String),
          target: expect.any(String),
          type: expect.any(String)
        })
      );
    });
  });

  describe('Graph Building', () => {
    it('should build document graph with entities', async () => {
      const documentId = 'doc-graph-1';
      const content = 'John Smith, CEO of TechCorp, announced a partnership with DataSystems Inc.';

      // Extract entities
      const entities = await entityExtractor.extractEntities(content);

      // Build graph
      await graphBuilder.buildDocumentGraph(documentId, {
        title: 'Partnership Announcement',
        content,
        entities
      });

      // Verify graph structure
      const result = await session.run(`
        MATCH (d:Document {id: $id})
        OPTIONAL MATCH (d)-[:CONTAINS]->(e:Entity)
        RETURN d, collect(e) as entities
      `, { id: documentId });

      expect(result.records).toHaveLength(1);
      const record = result.records[0];
      expect(record.get('d').properties.id).toBe(documentId);
      expect(record.get('entities').length).toBeGreaterThan(0);
    });

    it('should create chunk nodes and relationships', async () => {
      const documentId = 'doc-chunks-1';
      const chunks = [
        { id: 'chunk-1', content: 'First chunk content', index: 0 },
        { id: 'chunk-2', content: 'Second chunk content', index: 1 },
        { id: 'chunk-3', content: 'Third chunk content', index: 2 }
      ];

      await graphBuilder.createChunkNodes(documentId, chunks);

      // Verify chunk nodes
      const result = await session.run(`
        MATCH (d:Document {id: $id})-[:HAS_CHUNK]->(c:Chunk)
        RETURN c.id as id, c.index as index
        ORDER BY c.index
      `, { id: documentId });

      expect(result.records).toHaveLength(3);
      expect(result.records[0].get('index').toNumber()).toBe(0);
      expect(result.records[1].get('index').toNumber()).toBe(1);
      expect(result.records[2].get('index').toNumber()).toBe(2);
    });

    it('should create entity co-occurrence relationships', async () => {
      const documentId = 'doc-cooccur-1';

      // Create document with multiple entities
      await session.run(`
        CREATE (d:Document {id: $id})
        CREATE (e1:Entity {name: 'Entity A', type: 'Person'})
        CREATE (e2:Entity {name: 'Entity B', type: 'Person'})
        CREATE (e3:Entity {name: 'Entity C', type: 'Organization'})
        CREATE (d)-[:CONTAINS]->(e1)
        CREATE (d)-[:CONTAINS]->(e2)
        CREATE (d)-[:CONTAINS]->(e3)
      `, { id: documentId });

      await graphBuilder.createCoOccurrenceRelationships(documentId);

      // Verify co-occurrence relationships
      const result = await session.run(`
        MATCH (e1:Entity)-[r:CO_OCCURS_WITH]-(e2:Entity)
        WHERE EXISTS((d:Document {id: $id})-[:CONTAINS]->(e1))
        AND EXISTS((d:Document {id: $id})-[:CONTAINS]->(e2))
        RETURN count(r) as count
      `, { id: documentId });

      expect(result.records[0].get('count').toNumber()).toBeGreaterThan(0);
    });
  });

  describe('Graph Queries', () => {
    beforeEach(async () => {
      // Setup test graph
      await session.run(`
        CREATE (d1:Document {id: 'doc-1', title: 'AI Research'})
        CREATE (d2:Document {id: 'doc-2', title: 'ML Applications'})
        CREATE (d3:Document {id: 'doc-3', title: 'Data Science'})

        CREATE (e1:Entity {name: 'Machine Learning', type: 'Topic'})
        CREATE (e2:Entity {name: 'Neural Networks', type: 'Topic'})
        CREATE (e3:Entity {name: 'John Doe', type: 'Person'})
        CREATE (e4:Entity {name: 'TechCorp', type: 'Organization'})

        CREATE (d1)-[:CONTAINS]->(e1)
        CREATE (d1)-[:CONTAINS]->(e2)
        CREATE (d1)-[:MENTIONS]->(e3)
        CREATE (d2)-[:CONTAINS]->(e1)
        CREATE (d2)-[:REFERENCES]->(e4)
        CREATE (d3)-[:CONTAINS]->(e2)
        CREATE (d3)-[:MENTIONS]->(e3)

        CREATE (e1)-[:RELATED_TO]->(e2)
        CREATE (e3)-[:WORKS_AT]->(e4)
      `);
    });

    it('should find connected documents through entities', async () => {
      const result = await session.run(`
        MATCH (d1:Document {id: 'doc-1'})-[:CONTAINS]->(e:Entity)<-[:CONTAINS]-(d2:Document)
        WHERE d1.id <> d2.id
        RETURN DISTINCT d2.id as connectedDoc
      `);

      const connectedDocs = result.records.map(r => r.get('connectedDoc'));
      expect(connectedDocs).toContain('doc-2');
      expect(connectedDocs).toContain('doc-3');
    });

    it('should find entity relationships', async () => {
      const result = await session.run(`
        MATCH (e1:Entity {name: 'John Doe'})-[r]->(e2:Entity)
        RETURN e2.name as relatedEntity, type(r) as relationshipType
      `);

      expect(result.records).toHaveLength(1);
      expect(result.records[0].get('relatedEntity')).toBe('TechCorp');
      expect(result.records[0].get('relationshipType')).toBe('WORKS_AT');
    });

    it('should calculate entity centrality', async () => {
      const result = await session.run(`
        MATCH (e:Entity)
        OPTIONAL MATCH (e)-[r]-()
        RETURN e.name as entity, count(r) as degree
        ORDER BY degree DESC
      `);

      expect(result.records.length).toBeGreaterThan(0);
      const mostConnected = result.records[0];
      expect(mostConnected.get('degree').toNumber()).toBeGreaterThan(0);
    });

    it('should find shortest paths between entities', async () => {
      const result = await session.run(`
        MATCH path = shortestPath(
          (e1:Entity {name: 'Machine Learning'})-[*]-(e2:Entity {name: 'TechCorp'})
        )
        RETURN length(path) as pathLength
      `);

      if (result.records.length > 0) {
        expect(result.records[0].get('pathLength').toNumber()).toBeGreaterThan(0);
      }
    });
  });

  describe('Graph Analytics', () => {
    it('should compute PageRank for entities', async () => {
      // Note: This requires APOC procedures or GDS library
      // Simplified version for testing
      const result = await session.run(`
        MATCH (e:Entity)
        OPTIONAL MATCH (e)<-[r]-()
        WITH e, count(r) as inDegree
        RETURN e.name as entity, inDegree
        ORDER BY inDegree DESC
        LIMIT 5
      `);

      expect(result.records.length).toBeGreaterThan(0);
    });

    it('should detect communities', async () => {
      // Simplified community detection
      const result = await session.run(`
        MATCH (e:Entity)-[:RELATED_TO]-(e2:Entity)
        WITH e, collect(e2) as neighbors
        RETURN e.name as entity, size(neighbors) as communitySize
        ORDER BY communitySize DESC
      `);

      expect(result.records).toBeDefined();
    });

    it('should find entity clusters', async () => {
      const result = await session.run(`
        MATCH (e:Entity {type: 'Topic'})
        OPTIONAL MATCH (e)-[:RELATED_TO]-(related:Entity {type: 'Topic'})
        WITH e, collect(related.name) as cluster
        RETURN e.name as topic, cluster
      `);

      expect(result.records.length).toBeGreaterThan(0);
    });
  });

  describe('Graph Visualization Data', () => {
    it('should generate visualization data for document graph', async () => {
      const documentId = 'doc-1';

      const result = await apiClient.getGraph(documentId);

      expect(result.status).toBe(200);
      expect(result.data).toHaveProperty('documentId');
      expect(result.data).toHaveProperty('nodes');
      expect(result.data).toHaveProperty('edges');

      // Verify node structure
      if (result.data.nodes.length > 0) {
        const node = result.data.nodes[0];
        expect(node).toHaveProperty('id');
        expect(node).toHaveProperty('type');
      }

      // Verify edge structure
      if (result.data.edges.length > 0) {
        const edge = result.data.edges[0];
        expect(edge).toHaveProperty('source');
        expect(edge).toHaveProperty('target');
        expect(edge).toHaveProperty('type');
      }
    });
  });

  describe('Cypher Query Execution', () => {
    it('should execute valid Cypher queries', async () => {
      const query = 'MATCH (n) RETURN count(n) as nodeCount';
      const result = await apiClient.executeCypher(query);

      expect(result.status).toBe(200);
      expect(result.data).toHaveProperty('results');
      expect(result.data.results).toBeInstanceOf(Array);
    });

    it('should handle parameterized queries', async () => {
      const result = await session.run(
        'MATCH (d:Document {id: $id}) RETURN d',
        { id: 'doc-1' }
      );

      expect(result.records).toBeDefined();
    });

    it('should handle complex graph queries', async () => {
      const complexQuery = `
        MATCH (d:Document)-[:CONTAINS]->(e:Entity)
        WITH d, collect(e) as entities
        RETURN d.id as document, size(entities) as entityCount
        ORDER BY entityCount DESC
      `;

      const result = await apiClient.executeCypher(complexQuery);

      expect(result.status).toBe(200);
      expect(result.data.results).toBeInstanceOf(Array);
    });

    it('should reject invalid Cypher queries', async () => {
      const invalidQuery = 'INVALID CYPHER SYNTAX HERE';
      const result = await apiClient.executeCypher(invalidQuery);

      expect(result.status).toBe(400);
      expect(result.data).toHaveProperty('error');
    });
  });

  describe('Graph Persistence and Transactions', () => {
    it('should handle transactions correctly', async () => {
      const tx = session.beginTransaction();

      try {
        await tx.run('CREATE (n:TestNode {id: 1})');
        await tx.run('CREATE (n:TestNode {id: 2})');
        await tx.commit();

        const result = await session.run('MATCH (n:TestNode) RETURN count(n) as count');
        expect(result.records[0].get('count').toNumber()).toBe(2);
      } catch (error) {
        await tx.rollback();
        throw error;
      }
    });

    it('should rollback failed transactions', async () => {
      const tx = session.beginTransaction();

      try {
        await tx.run('CREATE (n:TestNode {id: 1})');
        throw new Error('Simulated error');
        await tx.commit();
      } catch (error) {
        await tx.rollback();
      }

      const result = await session.run('MATCH (n:TestNode) RETURN count(n) as count');
      expect(result.records[0].get('count').toNumber()).toBe(0);
    });
  });
});