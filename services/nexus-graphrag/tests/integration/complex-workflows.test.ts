/**
 * GraphRAG Complex Integration Tests
 *
 * Tests complex real-world user scenarios that combine multiple endpoints,
 * websockets, and cross-service operations.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from '@jest/globals';
import axios, { AxiosInstance } from 'axios';
import { io, Socket } from 'socket.io-client';
import FormData from 'form-data';
import fs from 'fs';
import path from 'path';

const GRAPHRAG_BASE_URL = process.env.GRAPHRAG_URL || 'http://localhost:8090';
const GRAPHRAG_WS_URL = process.env.GRAPHRAG_WS_URL || 'ws://localhost:8090';
const TEST_TIMEOUT = 120000; // 2 minutes for complex workflows

interface TestContext {
  userId: string;
  tenantId: string;
  apiKey: string;
}

describe('GraphRAG Complex Workflow Integration Tests', () => {
  let client: AxiosInstance;
  let wsClient: Socket;
  let testContext: TestContext;

  beforeAll(() => {
    testContext = {
      userId: `test-user-${Date.now()}`,
      tenantId: `test-tenant-${Date.now()}`,
      apiKey: process.env.TEST_API_KEY || 'test-api-key'
    };

    client = axios.create({
      baseURL: GRAPHRAG_BASE_URL,
      headers: {
        'Content-Type': 'application/json',
        'X-Company-ID': process.env.TEST_COMPANY_ID || 'test-company',
        'X-App-ID': process.env.TEST_APP_ID || 'integration-tests',
        'X-User-ID': testContext.userId
      },
      timeout: TEST_TIMEOUT,
      validateStatus: () => true // Handle all status codes
    });
  });

  afterAll(async () => {
    // Cleanup: Delete all test data
    try {
      await client.post('/graphrag/api/data/clear', {
        userId: testContext.userId,
        tenantId: testContext.tenantId,
        confirm: true
      });
    } catch (error) {
      console.warn('Cleanup failed:', error);
    }

    if (wsClient && wsClient.connected) {
      wsClient.disconnect();
    }
  });

  describe('Scenario 1: Research Paper Analysis Workflow', () => {
    /**
     * Complex scenario: User uploads research papers, extracts entities,
     * builds knowledge graph, and performs cross-document analysis
     */

    let documentIds: string[] = [];
    let entityIds: string[] = [];
    let episodeId: string;

    it('should upload and process multiple research papers', async () => {
      const papers = [
        {
          title: 'Advanced Neural Networks in Computer Vision',
          content: `This paper explores state-of-the-art convolutional neural networks (CNNs)
                    for image classification tasks. Key findings include ResNet-50 achieving
                    95.2% accuracy on ImageNet dataset. The research demonstrates that deeper
                    architectures with residual connections significantly improve performance.
                    Authors: John Smith, Jane Doe. Published: 2024 in IEEE Transactions.`,
          metadata: { type: 'research_paper', domain: 'computer_vision' }
        },
        {
          title: 'Transformer Architectures for NLP',
          content: `We present a comprehensive study of transformer models including BERT, GPT-3,
                    and T5. Experiments show GPT-3 achieves human-level performance on various
                    language tasks. The attention mechanism proves critical for understanding
                    long-range dependencies. Authors: Alice Johnson, Bob Williams. 2024 Nature.`,
          metadata: { type: 'research_paper', domain: 'natural_language_processing' }
        },
        {
          title: 'Reinforcement Learning in Robotics',
          content: `This study examines deep reinforcement learning algorithms (DQN, PPO, SAC)
                    applied to robotic manipulation tasks. Results indicate PPO achieves 89%
                    success rate in pick-and-place operations. The sim-to-real transfer
                    remains challenging. Authors: Carol Martinez, David Lee. 2024 Science Robotics.`,
          metadata: { type: 'research_paper', domain: 'robotics' }
        }
      ];

      for (const paper of papers) {
        const response = await client.post('/graphrag/api/documents', {
          title: paper.title,
          content: paper.content,
          metadata: paper.metadata,
          extractEntities: true,
          buildGraph: true
        });

        expect(response.status).toBe(201);
        expect(response.data.success).toBe(true);
        documentIds.push(response.data.data.id);

        console.log(`✓ Uploaded: ${paper.title} (ID: ${response.data.data.id})`);
      }

      expect(documentIds).toHaveLength(3);
    }, TEST_TIMEOUT);

    it('should extract entities from all documents', async () => {
      // Wait for entity extraction to complete
      await new Promise(resolve => setTimeout(resolve, 5000));

      for (const docId of documentIds) {
        const response = await client.get(`/graphrag/api/content/${docId}/entities`);

        expect(response.status).toBe(200);
        expect(response.data.data.entities).toBeDefined();
        expect(response.data.data.entities.length).toBeGreaterThan(0);

        entityIds.push(...response.data.data.entities.map((e: any) => e.id));

        console.log(`✓ Extracted ${response.data.data.entities.length} entities from doc ${docId}`);
      }

      expect(entityIds.length).toBeGreaterThan(5);
    }, TEST_TIMEOUT);

    it('should query cross-domain entities and relationships', async () => {
      const response = await client.post('/graphrag/api/entities/cross-domain', {
        domains: ['computer_vision', 'natural_language_processing', 'robotics'],
        relationshipTypes: ['RELATED_TO', 'BUILDS_UPON', 'APPLIES_TO'],
        minConfidence: 0.6
      });

      expect(response.status).toBe(200);
      expect(response.data.data.entities).toBeDefined();
      expect(response.data.data.relationships).toBeDefined();

      console.log(`✓ Found ${response.data.data.entities.length} cross-domain entities`);
      console.log(`✓ Found ${response.data.data.relationships.length} relationships`);
    }, TEST_TIMEOUT);

    it('should perform unified semantic search across all papers', async () => {
      const response = await client.post('/graphrag/api/unified/search', {
        query: 'What are the key performance metrics and accuracy results?',
        documentIds: documentIds,
        searchTypes: ['semantic', 'graph', 'keyword'],
        limit: 10,
        includeEntities: true
      });

      expect(response.status).toBe(200);
      expect(response.data.data.results).toBeDefined();
      expect(response.data.data.results.length).toBeGreaterThan(0);

      const results = response.data.data.results;
      expect(results.some((r: any) => r.content.includes('95.2%'))).toBe(true);
      expect(results.some((r: any) => r.content.includes('89%'))).toBe(true);

      console.log(`✓ Found ${results.length} relevant passages`);
    }, TEST_TIMEOUT);

    it('should create episodic memory of research session', async () => {
      const response = await client.post('/graphrag/api/episodes/store', {
        content: {
          action: 'research_analysis',
          documents: documentIds,
          findings: [
            'CNNs achieve high accuracy on image tasks',
            'Transformers excel at NLP',
            'RL shows promise in robotics'
          ],
          query: 'Compare AI techniques across domains',
          timestamp: new Date().toISOString()
        },
        tags: ['research', 'multi_domain', 'comparison'],
        metadata: {
          documentCount: documentIds.length,
          entityCount: entityIds.length,
          sessionDuration: '15 minutes'
        }
      });

      expect(response.status).toBe(201);
      expect(response.data.data.episodeId).toBeDefined();
      episodeId = response.data.data.episodeId;

      console.log(`✓ Created episode: ${episodeId}`);
    }, TEST_TIMEOUT);

    it('should recall the research session from episodic memory', async () => {
      const response = await client.post('/graphrag/api/episodes/recall', {
        query: 'What did I learn about AI techniques?',
        limit: 5,
        tags: ['research', 'comparison']
      });

      expect(response.status).toBe(200);
      expect(response.data.data.episodes).toBeDefined();
      expect(response.data.data.episodes.length).toBeGreaterThan(0);

      const foundEpisode = response.data.data.episodes.find((e: any) => e.id === episodeId);
      expect(foundEpisode).toBeDefined();

      console.log(`✓ Recalled episode with ${response.data.data.episodes.length} results`);
    }, TEST_TIMEOUT);

    it('should generate recommendations based on research history', async () => {
      const response = await client.post('/graphrag/api/recommendations', {
        query: 'Suggest related research topics',
        context: {
          readDocuments: documentIds,
          episodeId: episodeId
        },
        limit: 5
      });

      expect(response.status).toBe(200);
      expect(response.data.data.recommendations).toBeDefined();
      expect(response.data.data.recommendations.length).toBeGreaterThan(0);

      console.log(`✓ Generated ${response.data.data.recommendations.length} recommendations`);
    }, TEST_TIMEOUT);
  });

  describe('Scenario 2: Real-time Collaborative Knowledge Building', () => {
    /**
     * Complex scenario: Multiple users collaborate on shared knowledge base
     * with real-time updates via WebSocket
     */

    let sharedMemoryId: string;
    let wsEvents: any[] = [];
    let collaboratorUserId: string;

    beforeEach((done) => {
      collaboratorUserId = `collaborator-${Date.now()}`;
      wsEvents = [];

      wsClient = io(`${GRAPHRAG_WS_URL}/graphrag/memory`, {
        path: '/graphrag/socket.io',
        transports: ['websocket'],
        reconnection: true,
        extraHeaders: {
          'x-user-id': testContext.userId,
          'x-tenant-id': testContext.tenantId
        }
      });

      wsClient.on('connect', () => {
        console.log('✓ WebSocket connected');
        done();
      });

      wsClient.on('memory:update', (data) => {
        wsEvents.push({ type: 'memory:update', data, timestamp: Date.now() });
        console.log('✓ Received memory update:', data.memoryId);
      });

      wsClient.on('error', (error) => {
        console.error('WebSocket error:', error);
      });
    });

    afterEach(() => {
      if (wsClient && wsClient.connected) {
        wsClient.disconnect();
      }
    });

    it('should create shared company-scoped memory', async () => {
      const response = await client.post('/graphrag/api/memory', {
        content: 'Project Nexus: AI-powered knowledge management system',
        scope: 'COMPANY',
        tags: ['project', 'nexus', 'knowledge_base'],
        metadata: {
          projectPhase: 'development',
          priority: 'high',
          owner: testContext.userId
        }
      });

      expect(response.status).toBe(201);
      expect(response.data.data.id).toBeDefined();
      sharedMemoryId = response.data.data.id;

      console.log(`✓ Created shared memory: ${sharedMemoryId}`);
    }, TEST_TIMEOUT);

    it('should share memory with collaborator', async () => {
      const response = await client.post(`/graphrag/api/memory/${sharedMemoryId}/share`, {
        userId: collaboratorUserId,
        role: 'WRITE',
        message: 'Please review and contribute to project documentation'
      });

      expect(response.status).toBe(200);
      expect(response.data.success).toBe(true);

      console.log(`✓ Shared memory with ${collaboratorUserId}`);
    }, TEST_TIMEOUT);

    it('should subscribe to memory updates via WebSocket', (done) => {
      wsClient.emit('stream:updates', { memoryId: sharedMemoryId }, (response: any) => {
        expect(response.success).toBe(true);
        console.log('✓ Subscribed to memory updates');
        done();
      });
    }, TEST_TIMEOUT);

    it('should update memory and receive WebSocket notification', async () => {
      // Update memory via REST API
      const updatePromise = client.put(`/graphrag/api/memory/${sharedMemoryId}`, {
        content: 'Project Nexus: AI-powered knowledge management system. Status: In active development with GraphRAG and MageAgent integration.',
        metadata: {
          projectPhase: 'integration',
          lastUpdated: new Date().toISOString()
        }
      });

      // Wait for WebSocket update
      const wsUpdatePromise = new Promise((resolve) => {
        const checkInterval = setInterval(() => {
          const updateEvent = wsEvents.find(
            e => e.type === 'memory:update' && e.data.memoryId === sharedMemoryId
          );
          if (updateEvent) {
            clearInterval(checkInterval);
            resolve(updateEvent);
          }
        }, 100);

        setTimeout(() => {
          clearInterval(checkInterval);
          resolve(null);
        }, 10000);
      });

      const [apiResponse, wsEvent] = await Promise.all([updatePromise, wsUpdatePromise]);

      expect(apiResponse.status).toBe(200);
      expect(wsEvent).not.toBeNull();

      console.log('✓ Memory updated and WebSocket notification received');
    }, TEST_TIMEOUT);

    it('should get memory version history', async () => {
      const response = await client.get(`/graphrag/api/memory/${sharedMemoryId}/versions`);

      expect(response.status).toBe(200);
      expect(response.data.data.versions).toBeDefined();
      expect(response.data.data.versions.length).toBeGreaterThanOrEqual(2);

      console.log(`✓ Retrieved ${response.data.data.versions.length} versions`);
    }, TEST_TIMEOUT);

    it('should compare memory versions', async () => {
      const versionsResponse = await client.get(`/graphrag/api/memory/${sharedMemoryId}/versions`);
      const versions = versionsResponse.data.data.versions;

      if (versions.length >= 2) {
        const response = await client.get(`/graphrag/api/memory/${sharedMemoryId}/versions/compare`, {
          params: {
            fromVersion: versions[0].version,
            toVersion: versions[versions.length - 1].version
          }
        });

        expect(response.status).toBe(200);
        expect(response.data.data.changes).toBeDefined();

        console.log('✓ Compared versions:', response.data.data.changes);
      }
    }, TEST_TIMEOUT);

    it('should get collaboration statistics', async () => {
      const response = await client.get(`/graphrag/api/memory/${sharedMemoryId}/stats`);

      expect(response.status).toBe(200);
      expect(response.data.data.stats).toBeDefined();
      expect(response.data.data.stats.viewCount).toBeGreaterThanOrEqual(0);
      expect(response.data.data.stats.updateCount).toBeGreaterThanOrEqual(1);

      console.log('✓ Collaboration stats:', response.data.data.stats);
    }, TEST_TIMEOUT);
  });

  describe('Scenario 3: Multi-Stage Document Processing Pipeline', () => {
    /**
     * Complex scenario: URL ingestion → OCR processing → Entity extraction →
     * Graph building → Advanced search → Recommendation
     */

    let ingestionJobId: string;
    let processedDocId: string;
    let extractedEntities: any[] = [];

    it('should validate and start URL ingestion', async () => {
      // First validate the URL
      const validateResponse = await client.post('/graphrag/api/documents/validate-url', {
        url: 'https://example.com/research-paper.pdf',
        checkAccessibility: true
      });

      expect(validateResponse.status).toBe(200);
      expect(validateResponse.data.data.valid).toBeDefined();

      // Start ingestion
      const ingestResponse = await client.post('/graphrag/api/documents/ingest-url', {
        url: 'https://example.com/research-paper.pdf',
        options: {
          extractText: true,
          extractImages: true,
          extractTables: true,
          detectLanguage: true,
          enableOCR: true
        },
        metadata: {
          source: 'web',
          category: 'research',
          importedBy: testContext.userId
        }
      });

      expect(ingestResponse.status).toBe(202);
      expect(ingestResponse.data.data.jobId).toBeDefined();
      ingestionJobId = ingestResponse.data.data.jobId;

      console.log(`✓ Started ingestion job: ${ingestionJobId}`);
    }, TEST_TIMEOUT);

    it('should poll ingestion job status until complete', async () => {
      let attempts = 0;
      const maxAttempts = 30;
      let jobComplete = false;

      while (attempts < maxAttempts && !jobComplete) {
        await new Promise(resolve => setTimeout(resolve, 2000));

        const response = await client.get(`/graphrag/api/documents/ingestion-jobs/${ingestionJobId}`);

        expect(response.status).toBe(200);
        const job = response.data.data;

        console.log(`  Job status: ${job.status} (${job.progress || 0}%)`);

        if (job.status === 'completed') {
          jobComplete = true;
          processedDocId = job.documentId;
          expect(processedDocId).toBeDefined();
        } else if (job.status === 'failed') {
          throw new Error(`Ingestion job failed: ${job.error}`);
        }

        attempts++;
      }

      expect(jobComplete).toBe(true);
      console.log(`✓ Ingestion completed: ${processedDocId}`);
    }, TEST_TIMEOUT);

    it('should perform advanced document processing', async () => {
      const response = await client.post('/graphrag/api/documents/process-advanced', {
        documentId: processedDocId,
        operations: [
          {
            type: 'entity_extraction',
            config: { model: 'spacy-en', confidence: 0.7 }
          },
          {
            type: 'relationship_extraction',
            config: { maxDistance: 3 }
          },
          {
            type: 'topic_modeling',
            config: { numTopics: 5 }
          },
          {
            type: 'summarization',
            config: { maxLength: 500 }
          }
        ]
      });

      expect(response.status).toBe(200);
      expect(response.data.data.results).toBeDefined();

      console.log('✓ Advanced processing completed:', Object.keys(response.data.data.results));
    }, TEST_TIMEOUT);

    it('should extract and query document entities', async () => {
      const entitiesResponse = await client.get(`/graphrag/api/content/${processedDocId}/entities`);

      expect(entitiesResponse.status).toBe(200);
      extractedEntities = entitiesResponse.data.data.entities || [];

      if (extractedEntities.length > 0) {
        // Query entities by type
        const queryResponse = await client.post('/graphrag/api/entities/query', {
          filters: {
            documentId: processedDocId,
            types: ['PERSON', 'ORGANIZATION', 'TECHNOLOGY']
          },
          limit: 20
        });

        expect(queryResponse.status).toBe(200);
        console.log(`✓ Extracted ${extractedEntities.length} entities`);
      }
    }, TEST_TIMEOUT);

    it('should build entity relationships and hierarchy', async () => {
      if (extractedEntities.length >= 2) {
        const entity1 = extractedEntities[0];
        const entity2 = extractedEntities[1];

        const response = await client.post('/graphrag/api/entities/relationships', {
          sourceEntityId: entity1.id,
          targetEntityId: entity2.id,
          relationshipType: 'MENTIONED_WITH',
          confidence: 0.85,
          metadata: {
            documentId: processedDocId,
            context: 'co-occurrence'
          }
        });

        expect(response.status).toBe(201);
        console.log('✓ Created entity relationship');

        // Get entity hierarchy
        const hierarchyResponse = await client.get(`/graphrag/api/entities/${entity1.id}/hierarchy`);
        expect(hierarchyResponse.status).toBe(200);
      }
    }, TEST_TIMEOUT);

    it('should perform advanced semantic search with filters', async () => {
      const response = await client.post('/graphrag/api/search/advanced', {
        query: 'What are the main findings and conclusions?',
        filters: {
          documentIds: [processedDocId],
          entityTypes: ['FINDING', 'CONCLUSION'],
          minConfidence: 0.7
        },
        options: {
          rerank: true,
          includeContext: true,
          contextWindow: 2,
          highlightMatches: true
        },
        limit: 5
      });

      expect(response.status).toBe(200);
      expect(response.data.data.results).toBeDefined();

      console.log(`✓ Advanced search returned ${response.data.data.results.length} results`);
    }, TEST_TIMEOUT);

    it('should get document DNA (signature)', async () => {
      const response = await client.get(`/graphrag/api/documents/${processedDocId}/dna`);

      expect(response.status).toBe(200);
      expect(response.data.data.signature).toBeDefined();
      expect(response.data.data.characteristics).toBeDefined();

      console.log('✓ Document DNA:', response.data.data.signature);
    }, TEST_TIMEOUT);
  });

  describe('Scenario 4: WebSocket Task Progress Streaming', () => {
    /**
     * Complex scenario: Submit long-running task and stream progress via WebSocket
     */

    let taskId: string;
    let progressEvents: any[] = [];

    beforeEach((done) => {
      progressEvents = [];

      wsClient = io(GRAPHRAG_WS_URL, {
        path: '/graphrag/socket.io',
        transports: ['websocket'],
        extraHeaders: {
          'x-user-id': testContext.userId,
          'x-tenant-id': testContext.tenantId
        }
      });

      wsClient.on('connect', () => {
        console.log('✓ WebSocket connected for task streaming');
        done();
      });

      wsClient.on('message', (data) => {
        progressEvents.push({ ...data, receivedAt: Date.now() });
        console.log('  Progress:', data.message || data.status);
      });
    });

    afterEach(() => {
      if (wsClient && wsClient.connected) {
        wsClient.disconnect();
      }
    });

    it('should create task and subscribe to progress', async () => {
      // Create a complex analysis task
      const taskResponse = await client.post('/graphrag/api/orchestration/analyze', {
        topic: 'Impact of AI on healthcare diagnostics',
        depth: 'deep',
        includeMemory: true,
        async: true
      });

      expect(taskResponse.status).toBe(202);
      expect(taskResponse.data.data.taskId).toBeDefined();
      taskId = taskResponse.data.data.taskId;

      // Subscribe via WebSocket
      return new Promise<void>((resolve, reject) => {
        wsClient.emit('subscribe:task', taskId, (response: any) => {
          try {
            expect(response.success).toBe(true);
            console.log(`✓ Subscribed to task: ${taskId}`);
            resolve();
          } catch (error) {
            reject(error);
          }
        });
      });
    }, TEST_TIMEOUT);

    it('should receive real-time progress updates', async () => {
      // Wait for progress events
      await new Promise(resolve => setTimeout(resolve, 10000));

      expect(progressEvents.length).toBeGreaterThan(0);

      // Verify event structure
      progressEvents.forEach(event => {
        expect(event.taskId || event.id).toBe(taskId);
        expect(event.status || event.message).toBeDefined();
      });

      console.log(`✓ Received ${progressEvents.length} progress events`);
    }, TEST_TIMEOUT);

    it('should get final task status via REST', async () => {
      // Poll until task completes
      let completed = false;
      let attempts = 0;
      const maxAttempts = 30;

      while (!completed && attempts < maxAttempts) {
        await new Promise(resolve => setTimeout(resolve, 2000));

        const response = await client.get(`/graphrag/api/tasks/${taskId}/status`);
        expect(response.status).toBe(200);

        const status = response.data.data.status;
        console.log(`  Task status: ${status}`);

        if (status === 'completed' || status === 'failed') {
          completed = true;

          if (status === 'completed') {
            expect(response.data.data.result).toBeDefined();
          }
        }

        attempts++;
      }

      expect(completed).toBe(true);
      console.log('✓ Task completed');
    }, TEST_TIMEOUT);

    it('should verify WebSocket received completion event', () => {
      const completionEvent = progressEvents.find(
        e => e.status === 'completed' || e.type === 'task:complete'
      );

      expect(completionEvent).toBeDefined();
      console.log('✓ WebSocket received completion event');
    });
  });

  describe('Scenario 5: Billing and Usage Tracking', () => {
    /**
     * Complex scenario: Monitor usage, check quotas, handle subscription limits
     */

    it('should get current subscription details', async () => {
      const response = await client.get('/graphrag/api/billing/subscription');

      expect(response.status).toBe(200);
      expect(response.data.data.subscription).toBeDefined();

      console.log('✓ Subscription:', response.data.data.subscription.tier);
    }, TEST_TIMEOUT);

    it('should get current usage metrics', async () => {
      const response = await client.get('/graphrag/api/billing/usage');

      expect(response.status).toBe(200);
      expect(response.data.data.usage).toBeDefined();
      expect(response.data.data.usage.documentsProcessed).toBeGreaterThanOrEqual(0);

      console.log('✓ Usage:', response.data.data.usage);
    }, TEST_TIMEOUT);

    it('should check quota status', async () => {
      const response = await client.get('/graphrag/api/billing/quota');

      expect(response.status).toBe(200);
      expect(response.data.data.quotas).toBeDefined();

      const quotas = response.data.data.quotas;
      console.log('✓ Quotas:');
      console.log(`  Documents: ${quotas.documents?.used || 0} / ${quotas.documents?.limit || 'unlimited'}`);
      console.log(`  Storage: ${quotas.storage?.used || 0} / ${quotas.storage?.limit || 'unlimited'}`);
    }, TEST_TIMEOUT);

    it('should calculate storage usage', async () => {
      const response = await client.post('/graphrag/api/billing/usage/storage/calculate', {
        detailed: true
      });

      expect(response.status).toBe(200);
      expect(response.data.data.storage).toBeDefined();

      console.log('✓ Storage breakdown:', response.data.data.storage);
    }, TEST_TIMEOUT);

    it('should get current month usage details', async () => {
      const response = await client.get('/graphrag/api/billing/usage/current-month');

      expect(response.status).toBe(200);
      expect(response.data.data.usage).toBeDefined();

      console.log('✓ Current month usage:', response.data.data.usage);
    }, TEST_TIMEOUT);
  });

  describe('Scenario 6: Health & Diagnostics', () => {
    /**
     * Verify system health across all components
     */

    it('should perform quick health check', async () => {
      const response = await client.get('/graphrag/api/diagnostics/quick');

      expect(response.status).toBe(200);
      expect(response.data.data.healthy).toBeDefined();

      console.log('✓ Quick health check:', response.data.data.healthy ? 'PASS' : 'FAIL');
    }, TEST_TIMEOUT);

    it('should perform full diagnostics', async () => {
      const response = await client.get('/graphrag/api/diagnostics/full');

      expect(response.status).toBe(200);
      expect(response.data.data.services).toBeDefined();

      const services = response.data.data.services;
      console.log('✓ Service statuses:');
      Object.entries(services).forEach(([name, status]) => {
        console.log(`  ${name}: ${status}`);
      });
    }, TEST_TIMEOUT);

    it('should check storage diagnostics', async () => {
      const response = await client.get('/graphrag/api/diagnostics/storage');

      expect(response.status).toBe(200);
      expect(response.data.data.storage).toBeDefined();

      console.log('✓ Storage health:', response.data.data.storage);
    }, TEST_TIMEOUT);

    it('should check vector database diagnostics', async () => {
      const response = await client.get('/graphrag/api/diagnostics/vectors');

      expect(response.status).toBe(200);
      expect(response.data.data.qdrant).toBeDefined();

      console.log('✓ Vector DB health:', response.data.data.qdrant);
    }, TEST_TIMEOUT);

    it('should get system statistics', async () => {
      const response = await client.get('/graphrag/api/stats');

      expect(response.status).toBe(200);
      expect(response.data.data.stats).toBeDefined();

      console.log('✓ System stats:', response.data.data.stats);
    }, TEST_TIMEOUT);

    it('should get WebSocket statistics', async () => {
      const response = await client.get('/graphrag/api/websocket/stats');

      expect(response.status).toBe(200);
      expect(response.data.data).toBeDefined();

      console.log('✓ WebSocket stats:', response.data.data);
    }, TEST_TIMEOUT);
  });
});
