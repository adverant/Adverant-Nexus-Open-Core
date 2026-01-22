/**
 * Voyage AI Integration Test Suite
 * Phase 3.1: Comprehensive testing of Voyage AI embedding integration
 *
 * Tests:
 * - Model discovery and caching
 * - Content type routing
 * - Error handling and fail-fast behavior
 * - Batch processing
 * - Circuit breaker behavior
 * - End-to-end embedding generation
 */

import { VoyageAIClient } from '../../src/clients/voyage-ai-unified-client';
import { VoyageModelDiscovery } from '../../src/clients/voyage-model-discovery';
import { config } from '../../src/config';
import { logger } from '../../src/utils/logger';

describe('Voyage AI Integration Tests', () => {
  let voyageClient: VoyageAIClient;
  let modelDiscovery: VoyageModelDiscovery;

  beforeAll(() => {
    // Verify API key is configured
    if (!config.voyageAI.apiKey) {
      throw new Error('VOYAGE_API_KEY must be set for integration tests');
    }
  });

  beforeEach(() => {
    voyageClient = new VoyageAIClient(config.voyageAI.apiKey);
    modelDiscovery = new VoyageModelDiscovery(config.voyageAI.apiKey);
  });

  afterEach(async () => {
    // Cleanup
    if (voyageClient) {
      await voyageClient.close();
    }
  });

  describe('Phase 3.1.1: Model Discovery', () => {
    test('should discover all available Voyage AI models', async () => {
      const models = await modelDiscovery.getAllModels();

      expect(models).toBeDefined();
      expect(Array.isArray(models)).toBe(true);
      expect(models.length).toBeGreaterThan(0);

      // Verify expected models are present
      const modelIds = models.map(m => m.id);
      expect(modelIds).toContain('voyage-3');

      logger.info('[TEST] Discovered models', {
        count: models.length,
        modelIds
      });
    }, 30000);

    test('should cache model discovery results', async () => {
      const startTime1 = Date.now();
      const models1 = await modelDiscovery.getAllModels();
      const duration1 = Date.now() - startTime1;

      const startTime2 = Date.now();
      const models2 = await modelDiscovery.getAllModels();
      const duration2 = Date.now() - startTime2;

      // Second call should be significantly faster (cached)
      expect(duration2).toBeLessThan(duration1 * 0.5);
      expect(models1).toEqual(models2);

      logger.info('[TEST] Model discovery caching', {
        firstCallMs: duration1,
        secondCallMs: duration2,
        speedup: `${(duration1 / duration2).toFixed(2)}x`
      });
    }, 30000);

    test('should fail fast with invalid API key', async () => {
      const invalidClient = new VoyageModelDiscovery('invalid-api-key-test');

      await expect(invalidClient.getAllModels()).rejects.toThrow();

      logger.info('[TEST] Invalid API key correctly rejected');
    }, 30000);

    test('should test connection and report model availability', async () => {
      const results = await voyageClient.testConnection();

      expect(results).toBeDefined();
      expect(typeof results).toBe('object');

      const workingModels = Object.entries(results)
        .filter(([_, works]) => works)
        .map(([modelId]) => modelId);

      const failedModels = Object.entries(results)
        .filter(([_, works]) => !works)
        .map(([modelId]) => modelId);

      // At least one model should work
      expect(workingModels.length).toBeGreaterThan(0);

      logger.info('[TEST] Connection test results', {
        workingModels,
        failedModels,
        totalTested: Object.keys(results).length
      });
    }, 60000);
  });

  describe('Phase 3.1.2: Content Type Routing', () => {
    test('should route text content to voyage-3', async () => {
      const textContent = 'This is a simple text document for testing.';
      const model = await modelDiscovery.getOptimalModel(textContent, 'text');

      expect(model.id).toBe('voyage-3');
      expect(model.endpoint).toBe('/v1/embeddings');

      logger.info('[TEST] Text content routing', {
        modelId: model.id,
        endpoint: model.endpoint
      });
    });

    test('should route code content to voyage-code-3', async () => {
      const codeContent = `
        function fibonacci(n: number): number {
          if (n <= 1) return n;
          return fibonacci(n - 1) + fibonacci(n - 2);
        }
      `;
      const model = await modelDiscovery.getOptimalModel(codeContent, 'code');

      expect(model.id).toBe('voyage-code-3');
      expect(model.endpoint).toBe('/v1/embeddings');

      logger.info('[TEST] Code content routing', {
        modelId: model.id
      });
    });

    test('should route finance content to voyage-finance-2', async () => {
      const financeContent = 'Q3 revenue reached $2.5M with EBITDA margins of 35%. YoY growth 120%.';
      const model = await modelDiscovery.getOptimalModel(financeContent, 'finance');

      expect(model.id).toBe('voyage-finance-2');

      logger.info('[TEST] Finance content routing', {
        modelId: model.id
      });
    });

    test('should route legal content to voyage-law-2', async () => {
      const legalContent = 'The plaintiff hereby petitions the court for summary judgment pursuant to Rule 56.';
      const model = await modelDiscovery.getOptimalModel(legalContent, 'legal');

      expect(model.id).toBe('voyage-law-2');

      logger.info('[TEST] Legal content routing', {
        modelId: model.id
      });
    });

    test('should route multimodal content to voyage-multimodal-3', async () => {
      const multimodalContent = '[Image description: Product diagram showing architecture]';
      const model = await modelDiscovery.getOptimalModel(multimodalContent, 'multimodal');

      expect(model.id).toBe('voyage-multimodal-3');
      expect(model.endpoint).toBe('/v1/multimodal/embeddings');

      logger.info('[TEST] Multimodal content routing', {
        modelId: model.id,
        endpoint: model.endpoint
      });
    });

    test('should auto-detect code content', async () => {
      const codeContent = `
        const express = require('express');
        app.get('/api/users', async (req, res) => {
          const users = await db.query('SELECT * FROM users');
          res.json(users);
        });
      `;

      // Test without explicit content type - should auto-detect
      const model = await modelDiscovery.getOptimalModel(codeContent);

      expect(model.id).toBe('voyage-code-3');

      logger.info('[TEST] Auto-detected code content', {
        modelId: model.id
      });
    });

    test('should auto-detect finance content', async () => {
      const financeContent = 'Portfolio allocation: 60% equity, 30% bonds, 10% cash. Expected return 8% with volatility 12%.';

      const model = await modelDiscovery.getOptimalModel(financeContent);

      expect(model.id).toBe('voyage-finance-2');

      logger.info('[TEST] Auto-detected finance content', {
        modelId: model.id
      });
    });
  });

  describe('Phase 3.1.3: Error Handling & Fail-Fast', () => {
    test('should reject embedding generation with invalid API key', async () => {
      const invalidClient = new VoyageAIClient('invalid-api-key-test');

      await expect(
        invalidClient.generateEmbedding('test content', 'voyage-3')
      ).rejects.toThrow();

      await invalidClient.close();

      logger.info('[TEST] Invalid API key correctly rejected during embedding');
    }, 30000);

    test('should reject embedding with invalid model ID', async () => {
      await expect(
        voyageClient.generateEmbedding('test content', 'nonexistent-model-xyz')
      ).rejects.toThrow();

      logger.info('[TEST] Invalid model ID correctly rejected');
    }, 30000);

    test('should fail fast when network unavailable', async () => {
      // Test with unreachable endpoint (simulate network failure)
      const unreachableClient = new VoyageAIClient(
        config.voyageAI.apiKey,
        'http://unreachable-host-12345.invalid'
      );

      await expect(
        unreachableClient.generateEmbedding('test', 'voyage-3')
      ).rejects.toThrow();

      await unreachableClient.close();

      logger.info('[TEST] Network failure handled correctly');
    }, 30000);

    test('should propagate errors without silent degradation', async () => {
      // This tests Phase 1.2 fix - no silent fallbacks
      let errorCaught = false;

      try {
        await voyageClient.generateEmbedding('', 'voyage-3'); // Empty content should error
      } catch (error) {
        errorCaught = true;
        expect(error).toBeDefined();
      }

      expect(errorCaught).toBe(true);

      logger.info('[TEST] Error propagation verified (no silent degradation)');
    }, 30000);
  });

  describe('Phase 3.1.4: Batch Processing', () => {
    test('should generate embeddings for batch of texts', async () => {
      const texts = [
        'First document about machine learning',
        'Second document about natural language processing',
        'Third document about neural networks'
      ];

      const results = await voyageClient.generateBatchEmbeddings(texts, 'voyage-3');

      expect(results).toBeDefined();
      expect(results.length).toBe(3);

      results.forEach((result, idx) => {
        expect(result.embedding).toBeDefined();
        expect(Array.isArray(result.embedding)).toBe(true);
        expect(result.embedding.length).toBe(1024); // voyage-3 dimensions
        expect(result.model).toBe('voyage-3');
      });

      logger.info('[TEST] Batch embedding generation successful', {
        batchSize: texts.length,
        dimensions: results[0].embedding.length
      });
    }, 60000);

    test('should handle batch size limits', async () => {
      const largeTexts = Array.from({ length: 150 }, (_, i) =>
        `Document ${i + 1}: Lorem ipsum dolor sit amet, consectetur adipiscing elit.`
      );

      // Voyage AI has batch size limits (typically 128)
      // Should either chunk automatically or reject with clear error
      const promise = voyageClient.generateBatchEmbeddings(largeTexts, 'voyage-3');

      // If chunking is implemented, this should succeed
      // If not, should fail with clear error message
      try {
        const results = await promise;
        expect(results.length).toBe(150);
        logger.info('[TEST] Large batch handled via chunking');
      } catch (error: any) {
        expect(error.message).toContain('batch');
        logger.info('[TEST] Large batch rejected with clear error');
      }
    }, 120000);

    test('should process batch with mixed content types', async () => {
      const mixedContents = [
        { text: 'Business strategy document', type: 'text' as const },
        { text: 'function add(a, b) { return a + b; }', type: 'code' as const },
        { text: 'Q4 revenue $1.2M, YoY growth 45%', type: 'finance' as const }
      ];

      const results = await Promise.all(
        mixedContents.map(async ({ text, type }) => {
          const model = await modelDiscovery.getOptimalModel(text, type);
          return voyageClient.generateEmbedding(text, model.id);
        })
      );

      expect(results.length).toBe(3);
      expect(results[0].model).toBe('voyage-3');
      expect(results[1].model).toBe('voyage-code-3');
      expect(results[2].model).toBe('voyage-finance-2');

      logger.info('[TEST] Mixed content type batch processing', {
        models: results.map(r => r.model)
      });
    }, 60000);
  });

  describe('Phase 3.1.5: End-to-End Integration', () => {
    test('should complete full embedding generation flow', async () => {
      const testDocument = {
        content: 'This is a test document for end-to-end embedding generation testing.',
        contentType: 'text' as const
      };

      // Step 1: Model discovery
      const model = await modelDiscovery.getOptimalModel(
        testDocument.content,
        testDocument.contentType
      );

      expect(model).toBeDefined();
      expect(model.id).toBe('voyage-3');

      // Step 2: Generate embedding
      const result = await voyageClient.generateEmbedding(
        testDocument.content,
        model.id
      );

      expect(result).toBeDefined();
      expect(result.embedding).toBeDefined();
      expect(result.embedding.length).toBe(1024);
      expect(result.model).toBe('voyage-3');

      // Step 3: Verify embedding quality
      expect(result.embedding.every(val => typeof val === 'number')).toBe(true);
      expect(result.embedding.every(val => !isNaN(val))).toBe(true);

      logger.info('[TEST] End-to-end flow completed successfully', {
        modelId: model.id,
        dimensions: result.embedding.length,
        usage: result.usage
      });
    }, 60000);

    test('should verify fail-fast behavior on embedding failure', async () => {
      const testDocument = {
        content: 'Test document',
        contentType: 'text' as const
      };

      // Create client with invalid API key
      const invalidClient = new VoyageAIClient('invalid-key');

      let errorThrown = false;
      try {
        await invalidClient.generateEmbedding(testDocument.content, 'voyage-3');
      } catch (error) {
        errorThrown = true;
        expect(error).toBeDefined();
        // Error should be descriptive
        expect((error as Error).message.length).toBeGreaterThan(10);
      } finally {
        await invalidClient.close();
      }

      // Verify fail-fast: error was thrown (no silent degradation)
      expect(errorThrown).toBe(true);

      logger.info('[TEST] Fail-fast behavior verified in end-to-end flow');
    }, 30000);

    test('should handle concurrent embedding requests', async () => {
      const documents = Array.from({ length: 10 }, (_, i) =>
        `Concurrent test document ${i + 1} with unique content for testing.`
      );

      const startTime = Date.now();

      // Generate embeddings concurrently
      const results = await Promise.all(
        documents.map(doc =>
          voyageClient.generateEmbedding(doc, 'voyage-3')
        )
      );

      const duration = Date.now() - startTime;

      expect(results.length).toBe(10);
      results.forEach(result => {
        expect(result.embedding.length).toBe(1024);
        expect(result.model).toBe('voyage-3');
      });

      logger.info('[TEST] Concurrent requests handled successfully', {
        requestCount: 10,
        totalDurationMs: duration,
        avgDurationMs: duration / 10
      });
    }, 120000);
  });

  describe('Phase 3.1.6: Data Integrity Verification', () => {
    test('should never return null/undefined embeddings', async () => {
      const testContent = 'Data integrity test content';

      const result = await voyageClient.generateEmbedding(testContent, 'voyage-3');

      expect(result).not.toBeNull();
      expect(result).not.toBeUndefined();
      expect(result.embedding).not.toBeNull();
      expect(result.embedding).not.toBeUndefined();
      expect(result.embedding.length).toBeGreaterThan(0);

      logger.info('[TEST] Data integrity verified - no null/undefined embeddings');
    }, 30000);

    test('should ensure embedding dimensions match model spec', async () => {
      const modelSpecs = [
        { modelId: 'voyage-3', expectedDim: 1024 },
        { modelId: 'voyage-code-3', expectedDim: 1024 },
      ];

      for (const { modelId, expectedDim } of modelSpecs) {
        const result = await voyageClient.generateEmbedding('test', modelId);

        expect(result.embedding.length).toBe(expectedDim);

        logger.info('[TEST] Embedding dimensions verified', {
          modelId,
          expectedDim,
          actualDim: result.embedding.length
        });
      }
    }, 60000);

    test('should validate all embedding values are valid numbers', async () => {
      const result = await voyageClient.generateEmbedding('Validation test', 'voyage-3');

      result.embedding.forEach((value, idx) => {
        expect(typeof value).toBe('number');
        expect(isNaN(value)).toBe(false);
        expect(isFinite(value)).toBe(true);
      });

      logger.info('[TEST] All embedding values are valid numbers', {
        dimensions: result.embedding.length
      });
    }, 30000);
  });
});
