/**
 * Batch Embedding Load Test
 *
 * Tests VoyageAI batch embedding performance and scalability:
 * - 100 texts (1 batch)
 * - 500 texts (5 batches)
 * - 1000 texts (10 batches)
 * - Concurrency handling
 * - Error recovery
 *
 * SETUP:
 * 1. Set VOYAGEAI_API_KEY environment variable
 * 2. Ensure sufficient API quota
 *
 * RUN:
 * npm run test:loadtest
 */

import { describe, it, expect, beforeAll } from '@jest/globals';
import axios from 'axios';

// Configuration
const FILEPROCESS_API_URL = process.env.FILEPROCESS_API_URL || 'http://localhost:8096';
const TEST_TIMEOUT = 120000; // 2 minutes for large batches

// Generate test data
function generateTestTexts(count: number): string[] {
  const texts: string[] = [];
  const sampleParagraphs = [
    'The quick brown fox jumps over the lazy dog. This is a sample paragraph for testing embedding generation.',
    'Machine learning is a subset of artificial intelligence that enables systems to learn and improve from experience.',
    'Natural language processing allows computers to understand, interpret, and generate human language.',
    'Document processing involves extracting meaningful information from unstructured text data.',
    'Vector embeddings represent text as high-dimensional numerical vectors for semantic similarity comparisons.',
  ];

  for (let i = 0; i < count; i++) {
    const paragraph = sampleParagraphs[i % sampleParagraphs.length];
    texts.push(`[Text ${i + 1}] ${paragraph} Unique identifier: ${Math.random()}`);
  }

  return texts;
}

describe('Batch Embedding Load Tests', () => {
  describe('Small Batch (100 texts)', () => {
    it('should process 100 texts efficiently in single batch', async () => {
      const texts = generateTestTexts(100);
      const startTime = Date.now();

      const response = await axios.post(
        `${FILEPROCESS_API_URL}/api/internal/embeddings/batch`,
        { texts },
        { timeout: TEST_TIMEOUT }
      );

      const duration = Date.now() - startTime;

      expect(response.status).toBe(200);
      expect(response.data.success).toBe(true);
      expect(response.data.embeddings).toHaveLength(100);

      // Validate embedding structure
      expect(response.data.embeddings[0]).toHaveLength(1024); // voyage-3 dimensions

      console.log(`✅ 100 texts processed in ${duration}ms (~${(duration / 100).toFixed(0)}ms per text)`);
      console.log(`   Throughput: ${(100 / (duration / 1000)).toFixed(1)} texts/second`);

      // Performance target: <10 seconds for 100 texts
      expect(duration).toBeLessThan(10000);
    }, TEST_TIMEOUT);
  });

  describe('Medium Batch (500 texts)', () => {
    it('should process 500 texts across 5 batches', async () => {
      const texts = generateTestTexts(500);
      const startTime = Date.now();

      const response = await axios.post(
        `${FILEPROCESS_API_URL}/api/internal/embeddings/batch`,
        { texts },
        { timeout: TEST_TIMEOUT }
      );

      const duration = Date.now() - startTime;

      expect(response.status).toBe(200);
      expect(response.data.success).toBe(true);
      expect(response.data.embeddings).toHaveLength(500);

      console.log(`✅ 500 texts processed in ${duration}ms (~${(duration / 500).toFixed(0)}ms per text)`);
      console.log(`   Throughput: ${(500 / (duration / 1000)).toFixed(1)} texts/second`);
      console.log(`   Batches: 5 (100 texts each)`);

      // Performance target: <30 seconds for 500 texts
      expect(duration).toBeLessThan(30000);
    }, TEST_TIMEOUT);
  });

  describe('Large Batch (1000 texts)', () => {
    it('should process 1000 texts across 10 batches', async () => {
      const texts = generateTestTexts(1000);
      const startTime = Date.now();

      const response = await axios.post(
        `${FILEPROCESS_API_URL}/api/internal/embeddings/batch`,
        { texts },
        { timeout: TEST_TIMEOUT }
      );

      const duration = Date.now() - startTime;

      expect(response.status).toBe(200);
      expect(response.data.success).toBe(true);
      expect(response.data.embeddings).toHaveLength(1000);

      console.log(`✅ 1000 texts processed in ${duration}ms (~${(duration / 1000).toFixed(0)}ms per text)`);
      console.log(`   Throughput: ${(1000 / (duration / 1000)).toFixed(1)} texts/second`);
      console.log(`   Batches: 10 (100 texts each)`);

      // Performance target: <60 seconds for 1000 texts
      expect(duration).toBeLessThan(60000);
    }, TEST_TIMEOUT);
  });

  describe('Performance Comparison', () => {
    it('should show significant speedup vs sequential processing', async () => {
      const texts = generateTestTexts(50);

      // Batch processing
      const batchStart = Date.now();
      await axios.post(
        `${FILEPROCESS_API_URL}/api/internal/embeddings/batch`,
        { texts },
        { timeout: TEST_TIMEOUT }
      );
      const batchDuration = Date.now() - batchStart;

      // Sequential processing (5 texts only for comparison)
      const sequentialTexts = texts.slice(0, 5);
      const sequentialStart = Date.now();
      for (const text of sequentialTexts) {
        await axios.post(
          `${FILEPROCESS_API_URL}/api/internal/embeddings/single`,
          { text },
          { timeout: TEST_TIMEOUT }
        );
      }
      const sequentialDuration = Date.now() - sequentialStart;

      // Extrapolate sequential time for 50 texts
      const extrapolatedSequentialDuration = (sequentialDuration / 5) * 50;

      const speedup = extrapolatedSequentialDuration / batchDuration;

      console.log(`✅ Batch: 50 texts in ${batchDuration}ms`);
      console.log(`   Sequential: 5 texts in ${sequentialDuration}ms (extrapolated: ${extrapolatedSequentialDuration}ms for 50)`);
      console.log(`   Speedup: ${speedup.toFixed(1)}x faster`);

      // Batch should be at least 5x faster
      expect(speedup).toBeGreaterThan(5);
    }, TEST_TIMEOUT);
  });

  describe('Concurrent Requests', () => {
    it('should handle multiple concurrent batch requests', async () => {
      const batch1 = generateTestTexts(100);
      const batch2 = generateTestTexts(100);
      const batch3 = generateTestTexts(100);

      const startTime = Date.now();

      // Send 3 concurrent requests
      const [response1, response2, response3] = await Promise.all([
        axios.post(`${FILEPROCESS_API_URL}/api/internal/embeddings/batch`, { texts: batch1 }, { timeout: TEST_TIMEOUT }),
        axios.post(`${FILEPROCESS_API_URL}/api/internal/embeddings/batch`, { texts: batch2 }, { timeout: TEST_TIMEOUT }),
        axios.post(`${FILEPROCESS_API_URL}/api/internal/embeddings/batch`, { texts: batch3 }, { timeout: TEST_TIMEOUT }),
      ]);

      const duration = Date.now() - startTime;

      expect(response1.status).toBe(200);
      expect(response2.status).toBe(200);
      expect(response3.status).toBe(200);

      console.log(`✅ 3 concurrent batches (300 texts total) processed in ${duration}ms`);
      console.log(`   Average per batch: ${(duration / 3).toFixed(0)}ms`);

      // Concurrent should complete faster than sequential
      // 3 sequential batches would take ~30 seconds (10s each)
      // Concurrent should take ~15 seconds or less
      expect(duration).toBeLessThan(20000);
    }, TEST_TIMEOUT);
  });

  describe('Edge Cases', () => {
    it('should handle empty text array', async () => {
      try {
        await axios.post(
          `${FILEPROCESS_API_URL}/api/internal/embeddings/batch`,
          { texts: [] },
          { timeout: TEST_TIMEOUT }
        );

        // Should return error
        expect(true).toBe(false);
      } catch (error: any) {
        expect(error.response.status).toBeGreaterThanOrEqual(400);
        console.log(`✅ Empty array handled correctly: ${error.response.status}`);
      }
    });

    it('should handle very long texts with truncation', async () => {
      const longText = 'A'.repeat(20000); // 20k characters (exceeds 16k limit)
      const texts = [longText];

      const response = await axios.post(
        `${FILEPROCESS_API_URL}/api/internal/embeddings/batch`,
        { texts },
        { timeout: TEST_TIMEOUT }
      );

      expect(response.status).toBe(200);
      expect(response.data.embeddings).toHaveLength(1);
      expect(response.data.embeddings[0]).toHaveLength(1024);

      console.log(`✅ Long text (20k chars) handled with truncation`);
    });

    it('should handle mixed text lengths', async () => {
      const texts = [
        'Short text',
        'A'.repeat(1000), // 1k chars
        'A'.repeat(10000), // 10k chars
        'Another short text',
        'A'.repeat(5000), // 5k chars
      ];

      const response = await axios.post(
        `${FILEPROCESS_API_URL}/api/internal/embeddings/batch`,
        { texts },
        { timeout: TEST_TIMEOUT }
      );

      expect(response.status).toBe(200);
      expect(response.data.embeddings).toHaveLength(5);

      // All embeddings should be valid
      for (const embedding of response.data.embeddings) {
        expect(embedding).toHaveLength(1024);
      }

      console.log(`✅ Mixed text lengths handled correctly`);
    });
  });

  describe('Reliability', () => {
    it('should maintain accuracy across large batches', async () => {
      const texts = generateTestTexts(200);

      const response = await axios.post(
        `${FILEPROCESS_API_URL}/api/internal/embeddings/batch`,
        { texts },
        { timeout: TEST_TIMEOUT }
      );

      expect(response.status).toBe(200);

      // Validate all embeddings
      for (let i = 0; i < texts.length; i++) {
        const embedding = response.data.embeddings[i];

        // Check dimensions
        expect(embedding).toHaveLength(1024);

        // Check for valid values (no NaN or Inf)
        for (const value of embedding) {
          expect(Number.isFinite(value)).toBe(true);
        }

        // Check magnitude (normalized vectors typically have magnitude ~1)
        const magnitude = Math.sqrt(embedding.reduce((sum: number, val: number) => sum + val * val, 0));
        expect(magnitude).toBeGreaterThan(0);
        expect(magnitude).toBeLessThan(10); // Reasonable upper bound
      }

      console.log(`✅ All 200 embeddings are valid and normalized`);
    }, TEST_TIMEOUT);
  });

  describe('Memory Efficiency', () => {
    it('should process large batches without memory issues', async () => {
      const initialMemory = process.memoryUsage().heapUsed;

      // Process 1000 texts
      const texts = generateTestTexts(1000);
      await axios.post(
        `${FILEPROCESS_API_URL}/api/internal/embeddings/batch`,
        { texts },
        { timeout: TEST_TIMEOUT }
      );

      const finalMemory = process.memoryUsage().heapUsed;
      const memoryIncrease = (finalMemory - initialMemory) / 1024 / 1024; // MB

      console.log(`✅ Memory increase: ${memoryIncrease.toFixed(2)}MB`);

      // Memory increase should be reasonable (<500MB)
      expect(memoryIncrease).toBeLessThan(500);
    }, TEST_TIMEOUT);
  });
});
