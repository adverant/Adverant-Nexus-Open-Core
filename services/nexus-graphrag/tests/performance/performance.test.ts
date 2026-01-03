/**
 * Performance and Load Tests for GraphRAG System
 * Tests system performance under various load conditions
 */

import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import { TestAPIClient, TestDataGenerator, DatabaseTestUtils, PerformanceTestUtils } from '../helpers/test-helpers';
import { testConfig } from '../test-config';

describe('GraphRAG Performance Tests', () => {
  let apiClient: TestAPIClient;
  let dbUtils: DatabaseTestUtils;

  beforeAll(async () => {
    apiClient = new TestAPIClient(testConfig.api.baseUrl);
    dbUtils = new DatabaseTestUtils();
    await dbUtils.cleanDatabase();
  });

  afterAll(async () => {
    await dbUtils.cleanDatabase();
  });

  describe('Document Upload Performance', () => {
    it('should handle single large document upload', async () => {
      const sizes = [100, 500, 1000, 5000]; // KB

      for (const sizeKB of sizes) {
        const doc = TestDataGenerator.generateLargeDocument(sizeKB);

        const { result, metrics } = await PerformanceTestUtils.measurePerformance(
          () => apiClient.uploadDocument(doc),
          1
        );

        expect(result.status).toBe(201);
        expect(metrics.avg).toBeLessThan(10000); // Should complete within 10 seconds

        console.log(`Upload ${sizeKB}KB: ${metrics.avg.toFixed(2)}ms`);
      }
    });

    it('should handle concurrent document uploads', async () => {
      const concurrencyLevels = [5, 10, 20, 50];

      for (const concurrency of concurrencyLevels) {
        const startMemory = PerformanceTestUtils.getMemoryUsage();

        const { successful, failed, duration } = await PerformanceTestUtils.generateConcurrentLoad(
          () => {
            const doc = TestDataGenerator.generateDocument();
            return apiClient.uploadDocument(doc);
          },
          concurrency
        );

        const endMemory = PerformanceTestUtils.getMemoryUsage();
        const memoryDelta = endMemory.heapUsed - startMemory.heapUsed;

        expect(failed).toBe(0);
        expect(successful).toBe(concurrency);
        expect(duration).toBeLessThan(concurrency * 1000); // Reasonable time

        console.log(`Concurrent uploads (${concurrency}): ${duration.toFixed(2)}ms, Memory: +${memoryDelta}MB`);
      }
    });

    it('should handle batch upload performance', async () => {
      const batchSizes = [10, 50, 100, 200];

      for (const batchSize of batchSizes) {
        const documents = TestDataGenerator.generateDocuments(batchSize);

        const { result, metrics } = await PerformanceTestUtils.measurePerformance(
          () => apiClient.uploadDocuments(documents),
          1
        );

        expect(result.status).toBe(200);
        expect(result.data.uploaded).toBe(batchSize);

        const avgTimePerDoc = metrics.avg / batchSize;
        expect(avgTimePerDoc).toBeLessThan(500); // Less than 500ms per document

        console.log(`Batch upload (${batchSize}): ${metrics.avg.toFixed(2)}ms, ${avgTimePerDoc.toFixed(2)}ms/doc`);
      }
    });
  });

  describe('Search Performance', () => {
    beforeAll(async () => {
      // Seed database with documents for search
      const documents = TestDataGenerator.generateDocuments(100);
      for (const doc of documents) {
        await apiClient.uploadDocument(doc);
      }
    });

    it('should perform search queries efficiently', async () => {
      const queries = [
        'simple search',
        'complex search with multiple terms',
        'very long search query with many words that should still be processed efficiently'
      ];

      for (const query of queries) {
        const { result, metrics } = await PerformanceTestUtils.measurePerformance(
          () => apiClient.searchDocuments({ query, limit: 10 }),
          10
        );

        expect(result.status).toBe(200);
        expect(metrics.avg).toBeLessThan(1000); // Average under 1 second
        expect(metrics.p95).toBeLessThan(2000); // 95th percentile under 2 seconds

        console.log(`Search "${query.substring(0, 20)}...": avg=${metrics.avg.toFixed(2)}ms, p95=${metrics.p95.toFixed(2)}ms`);
      }
    });

    it('should handle concurrent search requests', async () => {
      const concurrencyLevels = [10, 25, 50];

      for (const concurrency of concurrencyLevels) {
        const { successful, failed, duration } = await PerformanceTestUtils.generateConcurrentLoad(
          () => {
            const query = TestDataGenerator.generateSearchQuery();
            return apiClient.searchDocuments(query);
          },
          concurrency
        );

        expect(failed / concurrency).toBeLessThan(0.1); // Less than 10% failure rate
        const avgResponseTime = duration / concurrency;
        expect(avgResponseTime).toBeLessThan(500); // Average under 500ms

        console.log(`Concurrent searches (${concurrency}): ${successful}/${concurrency} successful, ${duration.toFixed(2)}ms total`);
      }
    });

    it('should maintain performance with filtered searches', async () => {
      const filters = [
        { type: 'text' },
        { tags: ['test'] },
        { type: 'text', tags: ['test'] },
        { dateRange: { from: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000), to: new Date() } }
      ];

      for (const filter of filters) {
        const { result, metrics } = await PerformanceTestUtils.measurePerformance(
          () => apiClient.searchDocuments({
            query: 'test',
            filters: filter,
            limit: 20
          }),
          5
        );

        expect(result.status).toBe(200);
        expect(metrics.avg).toBeLessThan(1500); // Filtered search under 1.5 seconds

        console.log(`Filtered search: ${metrics.avg.toFixed(2)}ms`);
      }
    });
  });

  describe('Pagination Performance', () => {
    beforeAll(async () => {
      // Seed with many documents
      const documents = TestDataGenerator.generateDocuments(500);
      const batchSize = 50;

      for (let i = 0; i < documents.length; i += batchSize) {
        const batch = documents.slice(i, i + batchSize);
        await apiClient.uploadDocuments(batch);
      }
    });

    it('should paginate through large result sets efficiently', async () => {
      const pageSizes = [10, 25, 50, 100];

      for (const pageSize of pageSizes) {
        const pages = 5; // Test first 5 pages
        const pageTimes: number[] = [];

        for (let page = 1; page <= pages; page++) {
          const start = performance.now();
          const response = await apiClient.listDocuments({
            page,
            limit: pageSize
          });
          const duration = performance.now() - start;

          expect(response.status).toBe(200);
          expect(response.data.documents.length).toBeLessThanOrEqual(pageSize);
          pageTimes.push(duration);
        }

        const avgPageTime = pageTimes.reduce((a, b) => a + b, 0) / pageTimes.length;
        expect(avgPageTime).toBeLessThan(500); // Each page under 500ms

        console.log(`Pagination (size=${pageSize}): avg=${avgPageTime.toFixed(2)}ms per page`);
      }
    });
  });

  describe('Chunking Performance', () => {
    it('should chunk documents efficiently', async () => {
      const documentSizes = [10, 50, 100, 500]; // KB

      for (const sizeKB of documentSizes) {
        const doc = TestDataGenerator.generateLargeDocument(sizeKB);
        const uploadResponse = await apiClient.uploadDocument(doc);
        const documentId = uploadResponse.data.documentId;

        const { result, metrics } = await PerformanceTestUtils.measurePerformance(
          () => apiClient.getChunks(documentId),
          1
        );

        expect(result.status).toBe(200);
        const expectedChunks = Math.ceil((sizeKB * 1024) / 1000); // Default chunk size 1000
        expect(result.data.chunks.length).toBeCloseTo(expectedChunks, 1);
        expect(metrics.avg).toBeLessThan(2000); // Under 2 seconds

        console.log(`Chunking ${sizeKB}KB: ${result.data.chunks.length} chunks in ${metrics.avg.toFixed(2)}ms`);
      }
    });

    it('should apply custom chunking strategies efficiently', async () => {
      const doc = TestDataGenerator.generateLargeDocument(100);
      const uploadResponse = await apiClient.uploadDocument(doc);
      const documentId = uploadResponse.data.documentId;

      const strategies = ['default', 'sentence', 'paragraph'];

      for (const strategy of strategies) {
        const { result, metrics } = await PerformanceTestUtils.measurePerformance(
          () => apiClient.axios.post(`/documents/${documentId}/chunk`, {
            strategy,
            chunkSize: 500
          }),
          1
        );

        expect(result.status).toBe(200);
        expect(metrics.avg).toBeLessThan(5000); // Under 5 seconds for re-chunking

        console.log(`Custom chunking (${strategy}): ${metrics.avg.toFixed(2)}ms`);
      }
    });
  });

  describe('Memory Management', () => {
    it('should handle memory efficiently during sustained load', async () => {
      const duration = 30000; // 30 seconds
      const requestsPerSecond = 10;
      const startTime = Date.now();
      const initialMemory = PerformanceTestUtils.getMemoryUsage();
      const memorySnapshots: any[] = [];

      let requestCount = 0;
      let errorCount = 0;

      while (Date.now() - startTime < duration) {
        const promises = [];

        for (let i = 0; i < requestsPerSecond; i++) {
          promises.push(
            apiClient.uploadDocument(TestDataGenerator.generateDocument())
              .then(() => requestCount++)
              .catch(() => errorCount++)
          );
        }

        await Promise.allSettled(promises);

        // Take memory snapshot every 5 seconds
        if ((Date.now() - startTime) % 5000 < 1000) {
          memorySnapshots.push({
            time: Date.now() - startTime,
            memory: PerformanceTestUtils.getMemoryUsage()
          });
        }

        await new Promise(resolve => setTimeout(resolve, 1000));
      }

      const finalMemory = PerformanceTestUtils.getMemoryUsage();
      const memoryGrowth = finalMemory.heapUsed - initialMemory.heapUsed;

      // Memory shouldn't grow excessively
      expect(memoryGrowth).toBeLessThan(100); // Less than 100MB growth

      console.log(`Sustained load test: ${requestCount} requests, ${errorCount} errors`);
      console.log(`Memory growth: ${memoryGrowth}MB`);
      console.log('Memory snapshots:', memorySnapshots);
    }, 60000); // 60 second timeout for this test
  });

  describe('Database Performance', () => {
    it('should handle database operations efficiently', async () => {
      const operations = [
        {
          name: 'Insert document',
          operation: () => apiClient.uploadDocument(TestDataGenerator.generateDocument())
        },
        {
          name: 'List documents',
          operation: () => apiClient.listDocuments({ limit: 50 })
        },
        {
          name: 'Search documents',
          operation: () => apiClient.searchDocuments({ query: 'test', limit: 10 })
        }
      ];

      for (const { name, operation } of operations) {
        const { metrics } = await PerformanceTestUtils.measurePerformance(operation, 20);

        expect(metrics.avg).toBeLessThan(1000);
        expect(metrics.p99).toBeLessThan(2000);

        console.log(`${name}: avg=${metrics.avg.toFixed(2)}ms, p99=${metrics.p99.toFixed(2)}ms`);
      }
    });

    it('should maintain consistency under concurrent writes', async () => {
      const documents = TestDataGenerator.generateDocuments(100);
      const documentIds: string[] = [];

      // Concurrent uploads
      const uploadPromises = documents.map(doc =>
        apiClient.uploadDocument(doc).then(res => {
          if (res.data.documentId) {
            documentIds.push(res.data.documentId);
          }
        })
      );

      await Promise.allSettled(uploadPromises);

      // Verify consistency
      const consistency = await dbUtils.verifyDataConsistency();
      expect(consistency.consistent).toBe(true);

      console.log(`Uploaded ${documentIds.length} documents`);
      console.log('Consistency check:', consistency.issues.length === 0 ? 'PASSED' : 'FAILED');
    });
  });

  describe('Caching Performance', () => {
    it('should improve performance with caching', async () => {
      const document = TestDataGenerator.generateDocument();
      const uploadResponse = await apiClient.uploadDocument(document);
      const documentId = uploadResponse.data.documentId;

      // First request (cache miss)
      const firstRequest = await PerformanceTestUtils.measurePerformance(
        () => apiClient.axios.get(`/documents/${documentId}`),
        1
      );

      // Subsequent requests (cache hits)
      const cachedRequests = await PerformanceTestUtils.measurePerformance(
        () => apiClient.axios.get(`/documents/${documentId}`),
        10
      );

      // Cached requests should be faster
      expect(cachedRequests.metrics.avg).toBeLessThan(firstRequest.metrics.avg * 0.5);

      console.log(`Cache miss: ${firstRequest.metrics.avg.toFixed(2)}ms`);
      console.log(`Cache hits (avg): ${cachedRequests.metrics.avg.toFixed(2)}ms`);
      console.log(`Speed improvement: ${((1 - cachedRequests.metrics.avg / firstRequest.metrics.avg) * 100).toFixed(1)}%`);
    });
  });

  describe('Scalability Tests', () => {
    it('should scale linearly with data size', async () => {
      const dataSizes = [10, 20, 40, 80];
      const timings: { size: number; time: number }[] = [];

      for (const size of dataSizes) {
        const documents = TestDataGenerator.generateDocuments(size);

        const start = performance.now();
        await apiClient.uploadDocuments(documents);
        const duration = performance.now() - start;

        timings.push({ size, time: duration });
      }

      // Check if scaling is approximately linear
      for (let i = 1; i < timings.length; i++) {
        const sizeRatio = timings[i].size / timings[i - 1].size;
        const timeRatio = timings[i].time / timings[i - 1].time;

        // Time should scale roughly linearly (within 50% margin)
        expect(timeRatio).toBeLessThan(sizeRatio * 1.5);
      }

      console.log('Scalability test results:');
      timings.forEach(t => {
        console.log(`  ${t.size} documents: ${t.time.toFixed(2)}ms (${(t.time / t.size).toFixed(2)}ms per doc)`);
      });
    });

    it('should handle growth in database size', async () => {
      const checkpoints = [100, 500, 1000, 2000];
      const searchTimes: { count: number; time: number }[] = [];

      for (const checkpoint of checkpoints) {
        // Add documents up to checkpoint
        while ((await apiClient.listDocuments({ limit: 1 })).data.total < checkpoint) {
          const batch = TestDataGenerator.generateDocuments(50);
          await apiClient.uploadDocuments(batch);
        }

        // Measure search performance at this checkpoint
        const { metrics } = await PerformanceTestUtils.measurePerformance(
          () => apiClient.searchDocuments({ query: 'test', limit: 10 }),
          5
        );

        searchTimes.push({ count: checkpoint, time: metrics.avg });
      }

      // Search time shouldn't degrade significantly
      const firstTime = searchTimes[0].time;
      const lastTime = searchTimes[searchTimes.length - 1].time;
      expect(lastTime).toBeLessThan(firstTime * 3); // At most 3x slower

      console.log('Database growth impact:');
      searchTimes.forEach(t => {
        console.log(`  ${t.count} docs: ${t.time.toFixed(2)}ms search time`);
      });
    }, 120000); // 2 minute timeout
  });
});