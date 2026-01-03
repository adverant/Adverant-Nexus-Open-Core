/**
 * Unit Tests for OpenRouterClient
 * Tests REAL OpenRouter API - NO MOCK DATA
 */

import { OpenRouterClient } from '../../../src/clients/openrouter-client';
import { config } from '../../../src/config';

describe('OpenRouterClient - Real API Tests', () => {
  let client: OpenRouterClient;
  const apiKey = process.env.OPENROUTER_API_KEY;

  beforeAll(() => {
    if (!apiKey) {
      throw new Error('OPENROUTER_API_KEY is required for real API tests');
    }
    client = new OpenRouterClient(apiKey, config.openRouter.baseUrl);
  });

  describe('Constructor', () => {
    test('should throw error when API key is missing', () => {
      expect(() => new OpenRouterClient('', config.openRouter.baseUrl))
        .toThrow('OpenRouter API key is required');
    });

    test('should create client with valid API key', () => {
      expect(client).toBeDefined();
      expect(client).toBeInstanceOf(OpenRouterClient);
    });
  });

  describe('listAvailableModels - Real API', () => {
    test('should fetch real models from OpenRouter', async () => {
      const models = await client.listAvailableModels();

      // Validate response structure
      expect(models).toBeDefined();
      expect(Array.isArray(models)).toBe(true);
      expect(models.length).toBeGreaterThan(0);
      expect(models).toHaveRealData();

      // Validate model structure
      const model = models[0];
      expect(model).toHaveProperty('id');
      expect(model).toHaveProperty('name');
      expect(model).toHaveProperty('pricing');
      expect(model).toHaveProperty('context_length');
      expect(model).toHaveProperty('architecture');

      // Check for known models
      const modelIds = models.map(m => m.id);
      expect(modelIds).toEqual(expect.arrayContaining([
        expect.stringMatching(/^openai\/gpt-/),
        expect.stringMatching(/^anthropic\/claude-/),
        expect.stringMatching(/^google\//),
      ]));

      // Log some models for verification
      console.log(`Found ${models.length} real models, including:`,
        models.slice(0, 5).map(m => ({ id: m.id, context: m.context_length }))
      );
    });

    test('should cache models after fetching', async () => {
      await client.listAvailableModels();

      // Test cache
      const cachedModel = client.getModel('openai/gpt-4');
      expect(cachedModel).toBeDefined();
      expect(cachedModel).toHaveRealData();
      expect(cachedModel?.id).toBe('openai/gpt-4');
    });

    test('should handle API errors gracefully', async () => {
      const badClient = new OpenRouterClient('invalid-key', config.openRouter.baseUrl);

      await expect(badClient.listAvailableModels())
        .rejects.toThrow(/OpenRouter API error/);
    });
  });

  describe('createCompletion - Real API', () => {
    test('should create real completion with GPT-4', async () => {
      const request = {
        model: 'openai/gpt-4o-mini',
        messages: [
          { role: 'system' as const, content: 'You are a helpful assistant.' },
          { role: 'user' as const, content: 'What is 2+2? Answer with just the number.' }
        ],
        max_tokens: 10,
        temperature: 0
      };

      const response = await client.createCompletion(request);

      // Validate response structure
      expect(response).toBeDefined();
      expect(response).toHaveRealData();
      expect(response.id).toBeDefined();
      expect(response.choices).toHaveLength(1);
      expect(response.choices[0].message.content).toMatch(/4/);
      expect(response.model).toBeDefined();
      expect(response.usage).toBeDefined();
      expect(response.usage.prompt_tokens).toBeGreaterThan(0);
      expect(response.usage.completion_tokens).toBeGreaterThan(0);

      console.log('Real completion response:', {
        model: response.model,
        content: response.choices[0].message.content,
        usage: response.usage
      });
    });

    test('should handle complex multi-turn conversation', async () => {
      const request = {
        model: 'openai/gpt-3.5-turbo',
        messages: [
          { role: 'system' as const, content: 'You are a coding assistant.' },
          { role: 'user' as const, content: 'Write a TypeScript function to add two numbers.' },
          { role: 'assistant' as const, content: 'function add(a: number, b: number): number { return a + b; }' },
          { role: 'user' as const, content: 'Now make it handle arrays of numbers too.' }
        ],
        max_tokens: 200,
        temperature: 0.5
      };

      const response = await client.createCompletion(request);

      expect(response).toHaveRealData();
      expect(response.choices[0].message.content).toContain('function');
      expect(response.choices[0].message.content.length).toBeGreaterThan(50);
    });

    test('should respect max_tokens limit', async () => {
      const request = {
        model: 'openai/gpt-3.5-turbo',
        messages: [
          { role: 'user' as const, content: 'Count from 1 to 1000' }
        ],
        max_tokens: 50,
        temperature: 0
      };

      const response = await client.createCompletion(request);

      expect(response.usage.completion_tokens).toBeLessThanOrEqual(50);
      expect(response.choices[0].finish_reason).toMatch(/length|stop/);
    });

    test('should handle model fallbacks', async () => {
      const request = {
        model: 'openai/gpt-4',
        models: ['openai/gpt-4', 'openai/gpt-3.5-turbo', 'google/gemini-pro'],
        route: 'fallback' as const,
        messages: [
          { role: 'user' as const, content: 'Hello, which model are you?' }
        ],
        max_tokens: 100
      };

      const response = await client.createCompletion(request);

      expect(response).toHaveRealData();
      expect(response.model).toBeDefined();
      console.log('Fallback model used:', response.model);
    });

    test('should handle JSON response format', async () => {
      const request = {
        model: 'openai/gpt-3.5-turbo',
        messages: [
          {
            role: 'user' as const,
            content: 'Generate a JSON object with name and age fields for a person. Only output valid JSON.'
          }
        ],
        max_tokens: 100,
        temperature: 0,
        response_format: { type: 'json_object' as const }
      };

      const response = await client.createCompletion(request);

      expect(response).toHaveRealData();
      const content = response.choices[0].message.content;
      expect(() => JSON.parse(content)).not.toThrow();

      const parsed = JSON.parse(content);
      expect(parsed).toHaveProperty('name');
      expect(parsed).toHaveProperty('age');
    });

    test('should handle rate limiting with retry', async () => {
      // Make multiple rapid requests to test retry logic
      const promises = Array(5).fill(null).map((_, i) =>
        client.createCompletion({
          model: 'openai/gpt-3.5-turbo',
          messages: [{ role: 'user' as const, content: `Test ${i}` }],
          max_tokens: 10
        })
      );

      const results = await Promise.allSettled(promises);
      const successful = results.filter(r => r.status === 'fulfilled');

      expect(successful.length).toBeGreaterThan(0);
      console.log(`Rate limit test: ${successful.length}/5 requests succeeded`);
    });

    test('should handle circuit breaker pattern', async () => {
      // Test circuit breaker doesn't trip on successful requests
      const requests = Array(15).fill(null).map((_, i) => ({
        model: 'openai/gpt-3.5-turbo',
        messages: [{ role: 'user' as const, content: `Circuit test ${i}` }],
        max_tokens: 10
      }));

      for (const request of requests) {
        const response = await client.createCompletion(request);
        expect(response).toHaveRealData();
        // Small delay to avoid rate limits
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    });
  });

  describe('streamCompletion - Real Streaming API', () => {
    test('should stream real completion chunks', async () => {
      const request = {
        model: 'openai/gpt-3.5-turbo',
        messages: [
          { role: 'user' as const, content: 'Count from 1 to 5, one number at a time.' }
        ],
        max_tokens: 100,
        temperature: 0
      };

      const chunks: string[] = [];
      const stream = client.streamCompletion(request);

      for await (const chunk of stream) {
        chunks.push(chunk);
        expect(typeof chunk).toBe('string');
        expect(chunk).toHaveRealData();
      }

      expect(chunks.length).toBeGreaterThan(0);
      const fullResponse = chunks.join('');
      expect(fullResponse).toContain('1');
      expect(fullResponse).toContain('5');

      console.log('Streamed response chunks:', chunks.length);
      console.log('Full streamed content:', fullResponse);
    });

    test('should handle stream interruption gracefully', async () => {
      const request = {
        model: 'openai/gpt-3.5-turbo',
        messages: [
          { role: 'user' as const, content: 'Write a very long story about space exploration.' }
        ],
        max_tokens: 1000
      };

      const chunks: string[] = [];
      const stream = client.streamCompletion(request);

      // Collect only first 10 chunks then break
      let count = 0;
      for await (const chunk of stream) {
        chunks.push(chunk);
        count++;
        if (count >= 10) break;
      }

      expect(chunks.length).toBe(10);
      expect(chunks.every(c => typeof c === 'string')).toBe(true);
    });
  });

  describe('Model Selection and Cost Estimation', () => {
    test('should estimate real costs accurately', async () => {
      await client.listAvailableModels(); // Ensure cache is populated

      const cost = client.estimateCost('openai/gpt-4', 1000, 1000);

      expect(cost).toBeGreaterThan(0);
      expect(cost).toBeLessThan(1); // Should be less than $1 for 2k tokens

      console.log('Estimated cost for GPT-4 (2k tokens):', `$${cost.toFixed(4)}`);
    });

    test('should select models based on requirements', async () => {
      await client.listAvailableModels();

      const models = client.selectModelsForTask('coding task', {
        minContextLength: 16000,
        preferredProviders: ['openai', 'anthropic'],
        maxCost: 0.01 // $0.01 per 2k tokens
      });

      expect(models.length).toBeGreaterThan(0);
      expect(models.every(m => m.context_length >= 16000)).toBe(true);

      console.log('Selected models for task:',
        models.slice(0, 3).map(m => ({
          id: m.id,
          context: m.context_length,
          cost: client.estimateCost(m.id, 1000, 1000)
        }))
      );
    });

    test('should filter by modality', async () => {
      await client.listAvailableModels();

      const textModels = client.selectModelsForTask('text task', {
        modalities: ['text']
      });

      expect(textModels.length).toBeGreaterThan(0);
      expect(textModels.every(m => m.architecture.modality === 'text')).toBe(true);
    });
  });

  describe('Connection Testing', () => {
    test('should successfully test connection', async () => {
      const isConnected = await client.testConnection();

      expect(isConnected).toBe(true);
    });

    test('should fail connection test with bad credentials', async () => {
      const badClient = new OpenRouterClient('invalid-key', config.openRouter.baseUrl);
      const isConnected = await badClient.testConnection();

      expect(isConnected).toBe(false);
    });
  });

  describe('Error Handling', () => {
    test('should handle invalid model gracefully', async () => {
      const request = {
        model: 'invalid/model-that-does-not-exist',
        messages: [{ role: 'user' as const, content: 'Test' }],
        max_tokens: 10
      };

      await expect(client.createCompletion(request))
        .rejects.toThrow(/OpenRouter API error/);
    });

    test('should handle malformed requests', async () => {
      const request = {
        model: 'openai/gpt-3.5-turbo',
        messages: [], // Empty messages
        max_tokens: 10
      };

      await expect(client.createCompletion(request))
        .rejects.toThrow();
    });

    test('should provide detailed error information', async () => {
      const request = {
        model: 'openai/gpt-4',
        messages: [{ role: 'user' as const, content: 'Test' }],
        max_tokens: -1 // Invalid max_tokens
      };

      try {
        await client.createCompletion(request);
        fail('Should have thrown an error');
      } catch (error) {
        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).toContain('OpenRouter API error');
        expect((error as Error).message).toContain('openai/gpt-4');
      }
    });
  });

  describe('Performance Tests', () => {
    test('should complete within reasonable time', async () => {
      const request = {
        model: 'openai/gpt-3.5-turbo',
        messages: [{ role: 'user' as const, content: 'Say hello' }],
        max_tokens: 10
      };

      const promise = client.createCompletion(request);

      await expect(promise).toCompleteWithinTime(10000); // 10 seconds
    });

    test('should handle concurrent requests efficiently', async () => {
      const startTime = Date.now();

      const requests = Array(3).fill(null).map((_, i) =>
        client.createCompletion({
          model: 'openai/gpt-3.5-turbo',
          messages: [{ role: 'user' as const, content: `Concurrent test ${i}` }],
          max_tokens: 20
        })
      );

      const results = await Promise.all(requests);
      const totalTime = Date.now() - startTime;

      expect(results).toHaveLength(3);
      expect(results.every(r => r.choices[0].message.content)).toBe(true);

      console.log(`Concurrent requests completed in ${totalTime}ms`);
      expect(totalTime).toBeLessThan(20000); // Should complete within 20s
    });
  });
});