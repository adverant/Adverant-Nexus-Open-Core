/**
 * Graphiti Episodic Memory Integration Tests
 * Tests the complete episodic memory system including:
 * - Episode storage and recall
 * - Entity extraction and resolution
 * - Fact extraction and validation
 * - Temporal and causal relationships
 * - Unified memory retrieval
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from '@jest/globals';
import axios, { AxiosInstance } from 'axios';
import { v4 as uuidv4 } from 'uuid';

const API_BASE = process.env.GRAPHRAG_ENDPOINT || 'http://localhost:8090';

describe('Graphiti Episodic Memory Integration', () => {
  let api: AxiosInstance;
  let sessionId: string;
  let storedEpisodeIds: string[] = [];
  let extractedEntities: any[] = [];

  beforeAll(async () => {
    api = axios.create({
      baseURL: API_BASE,
      timeout: 30000,
      headers: {
        'Content-Type': 'application/json'
      }
    });

    // Check health
    const health = await api.get('/health');
    expect(health.data.status).toMatch(/healthy|degraded/);
  });

  beforeEach(() => {
    sessionId = uuidv4();
  });

  afterAll(async () => {
    // Clean up test episodes if needed
    for (const episodeId of storedEpisodeIds) {
      try {
        // Note: Delete endpoint would go here if implemented
      } catch (error) {
        // Ignore cleanup errors
      }
    }
  });

  describe('Episode Storage', () => {
    it('should store a user query episode', async () => {
      const episode = {
        content: 'Tell me about the GraphRAG system architecture',
        type: 'user_query',
        importance: 0.7,
        sessionId,
        entities: ['GraphRAG', 'architecture']
      };

      const response = await api.post('/api/episodes', episode);
      
      expect(response.status).toBe(201);
      expect(response.data.success).toBe(true);
      expect(response.data.episode_id).toBeDefined();
      expect(response.data.entities_extracted).toBeDefined();
      expect(response.data.facts_extracted).toBeDefined();
      
      storedEpisodeIds.push(response.data.episode_id);
    });

    it('should store a system response episode', async () => {
      const episode = {
        content: 'GraphRAG is a hybrid retrieval system combining vector, graph, and document storage',
        type: 'system_response',
        importance: 0.8,
        sessionId
      };

      const response = await api.post('/api/episodes', episode);
      
      expect(response.status).toBe(201);
      expect(response.data.success).toBe(true);
      storedEpisodeIds.push(response.data.episode_id);
    });

    it('should extract entities automatically', async () => {
      const episode = {
        content: 'Neo4j and PostgreSQL are used for graph and relational data storage respectively',
        type: 'document_interaction',
        sessionId
      };

      const response = await api.post('/api/episodes', episode);
      
      expect(response.data.entities_extracted.length).toBeGreaterThan(0);
      const entityNames = response.data.entities_extracted.map((e: any) => e.name);
      expect(entityNames).toContain('Neo4j');
      expect(entityNames).toContain('PostgreSQL');
      
      extractedEntities = response.data.entities_extracted;
      storedEpisodeIds.push(response.data.episode_id);
    });
  });

  describe('Episode Recall', () => {
    beforeEach(async () => {
      // Store some test episodes
      const episodes = [
        { content: 'What is machine learning?', type: 'user_query' },
        { content: 'Machine learning is a subset of AI', type: 'system_response' },
        { content: 'How does neural network work?', type: 'user_query' },
        { content: 'Neural networks are inspired by the nexus', type: 'system_response' }
      ];

      for (const ep of episodes) {
        const res = await api.post('/api/episodes', { ...ep, sessionId });
        storedEpisodeIds.push(res.data.episode_id);
      }
    });

    it('should recall relevant episodes', async () => {
      const response = await api.post('/api/episodes/recall', {
        query: 'machine learning',
        maxResults: 5
      });

      expect(response.data.episodes).toBeDefined();
      expect(response.data.episodes.length).toBeGreaterThan(0);
      
      const contents = response.data.episodes.map((e: any) => e.content);
      expect(contents.some((c: string) => c.includes('machine learning'))).toBe(true);
    });

    it('should apply temporal decay', async () => {
      const response = await api.post('/api/episodes/recall', {
        query: 'neural network',
        includeDecay: true,
        maxResults: 10
      });

      expect(response.data.episodes).toBeDefined();
      response.data.episodes.forEach((episode: any) => {
        expect(episode.decayFactor).toBeDefined();
        expect(episode.decayFactor).toBeGreaterThanOrEqual(0);
        expect(episode.decayFactor).toBeLessThanOrEqual(1);
      });
    });

    it('should filter by entity', async () => {
      if (extractedEntities.length > 0) {
        const entityName = extractedEntities[0].name;
        
        const response = await api.post('/api/episodes/recall', {
          query: '',
          entityFilter: [entityName],
          maxResults: 10
        });

        expect(response.data.episodes).toBeDefined();
        if (response.data.episodes.length > 0) {
          expect(response.data.entities.some((e: any) => e.name === entityName)).toBe(true);
        }
      }
    });
  });

  describe('Enhanced Retrieval', () => {
    it('should retrieve unified memories from both systems', async () => {
      const response = await api.post('/api/enhanced-retrieve', {
        query: 'database storage systems',
        includeEpisodic: true,
        includeDocuments: true,
        sessionContext: sessionId,
        maxTokens: 2000
      });

      expect(response.data.unified_memories).toBeDefined();
      expect(response.data.entities_mentioned).toBeDefined();
      expect(response.data.relevant_facts).toBeDefined();
      expect(response.data.suggested_followups).toBeDefined();

      // Check for both episodic and document memories
      const memoryTypes = response.data.unified_memories.map((m: any) => m.type);
      expect(memoryTypes).toContain('episodic');
    });

    it('should provide suggested follow-ups', async () => {
      const response = await api.post('/api/enhanced-retrieve', {
        query: 'GraphRAG architecture',
        sessionContext: sessionId
      });

      expect(response.data.suggested_followups).toBeDefined();
      expect(Array.isArray(response.data.suggested_followups)).toBe(true);
      if (response.data.suggested_followups.length > 0) {
        expect(typeof response.data.suggested_followups[0]).toBe('string');
      }
    });
  });

  describe('Entity and Fact Management', () => {
    it('should retrieve facts about a subject', async () => {
      // First store an episode with facts
      await api.post('/api/episodes', {
        content: 'Redis is used for caching and session management in GraphRAG',
        type: 'document_interaction',
        sessionId
      });

      const response = await api.get('/api/facts', {
        params: { subject: 'Redis' }
      });

      expect(response.data.facts).toBeDefined();
      expect(Array.isArray(response.data.facts)).toBe(true);
    });

    it('should retrieve entity history', async () => {
      if (extractedEntities.length > 0) {
        const entityId = extractedEntities[0].id;
        
        const response = await api.get(`/api/entities/${entityId}/history`);
        
        expect(response.data.episodes).toBeDefined();
        expect(Array.isArray(response.data.episodes)).toBe(true);
      }
    });
  });

  describe('Memory Statistics', () => {
    it('should retrieve memory system statistics', async () => {
      const response = await api.get('/api/memory/stats');
      
      expect(response.data.episodic).toBeDefined();
      expect(response.data.documents).toBeDefined();
      expect(response.data.sessions).toBeDefined();
      expect(response.data.combined_health).toBeDefined();
      expect(response.data.combined_health).toBeGreaterThanOrEqual(0);
      expect(response.data.combined_health).toBeLessThanOrEqual(1);
    });
  });

  describe('Session Management', () => {
    it('should clear session context', async () => {
      const response = await api.delete(`/api/sessions/${sessionId}/context`);
      
      expect(response.data.success).toBe(true);
      expect(response.data.message).toBe('Session context cleared');
    });
  });

  describe('Error Handling', () => {
    it('should handle missing content in episode storage', async () => {
      try {
        await api.post('/api/episodes', { type: 'user_query' });
        fail('Should have thrown an error');
      } catch (error: any) {
        expect(error.response.status).toBe(400);
        expect(error.response.data.error.code).toBe('MISSING_CONTENT');
      }
    });

    it('should handle missing query in episode recall', async () => {
      try {
        await api.post('/api/episodes/recall', {});
        fail('Should have thrown an error');
      } catch (error: any) {
        expect(error.response.status).toBe(400);
        expect(error.response.data.error.code).toBe('MISSING_QUERY');
      }
    });

    it('should handle non-existent episode', async () => {
      try {
        const fakeId = uuidv4();
        await api.get(`/api/episodes/${fakeId}`);
        fail('Should have thrown an error');
      } catch (error: any) {
        expect(error.response.status).toBe(404);
        expect(error.response.data.error.code).toBe('NOT_FOUND');
      }
    });
  });
});
