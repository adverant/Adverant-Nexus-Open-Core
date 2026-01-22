/**
 * Test Runner for GraphRAG API
 * Tests all 18 failing scenarios identified
 */

import axios, { AxiosInstance } from 'axios';
import WebSocket from 'ws';

// Use remote server or local fallback
const API_BASE_URL = process.env.API_BASE_URL || 'https://graphrag.adverant.ai';
const WS_BASE_URL = process.env.WS_BASE_URL || 'wss://graphrag.adverant.ai/ws';

class GraphRAGTestRunner {
  private api: AxiosInstance;
  private testResults: any[] = [];

  constructor() {
    this.api = axios.create({
      baseURL: API_BASE_URL,
      timeout: 30000,
      validateStatus: () => true // Don't throw on any status
    });
  }

  async runAllTests() {
    console.log('🚀 Starting GraphRAG Test Suite');
    console.log(`API URL: ${API_BASE_URL}`);
    console.log(`WS URL: ${WS_BASE_URL}`);
    console.log('=' .repeat(60));

    const tests = [
      this.test1_HealthCheck.bind(this),
      this.test2_UploadTextDocument.bind(this),
      this.test3_ListDocumentsWithPagination.bind(this),
      this.test4_FilterByTags.bind(this),
      this.test5_BatchUpload.bind(this),
      this.test6_GetDocumentChunks.bind(this),
      this.test7_RetrieveSingleChunk.bind(this),
      this.test8_CustomChunkingStrategy.bind(this),
      this.test9_SemanticSearch.bind(this),
      this.test10_SimilarityWithFilters.bind(this),
      this.test11_GetDocumentGraph.bind(this),
      this.test12_ExecuteCypherQuery.bind(this),
      this.test13_RetrieveMemory.bind(this),
      this.test14_ListMemories.bind(this),
      this.test15_WebSocketConnection.bind(this),
      this.test16_DocumentProcessingStream.bind(this),
      this.test17_LargeDocumentUpload.bind(this),
      this.test18_InvalidAPIKey.bind(this)
    ];

    let passed = 0;
    let failed = 0;

    for (const test of tests) {
      try {
        const result = await test();
        if ((result as any).passed) {
          passed++;
          console.log(`✅ ${(result as any).name}`);
        } else {
          failed++;
          console.log(`❌ ${(result as any).name}: ${(result as any).error}`);
        }
        this.testResults.push(result);
      } catch (error: any) {
        failed++;
        console.log(`❌ Test failed with error: ${error.message}`);
      }
    }

    console.log('\n' + '=' .repeat(60));
    console.log(`Results: ${passed} passed, ${failed} failed`);
    console.log(`Pass Rate: ${((passed / tests.length) * 100).toFixed(1)}%`);

    return this.testResults;
  }

  async test1_HealthCheck() {
    const res = await this.api.get('/api/health');

    const passed = res.status === 200 &&
                   res.data.services?.api !== undefined &&
                   res.data.services?.PostgreSQL !== undefined;

    return {
      name: '1. Health Check - API Health Status',
      passed,
      error: passed ? null : `Expected /api/health with services object including 'api' field. Got: ${JSON.stringify(res.data)}`
    };
  }

  async test2_UploadTextDocument() {
    const res = await this.api.post('/documents',
      'This is plain text content',
      { headers: { 'Content-Type': 'text/plain' } }
    );

    const passed = res.status === 200 && res.data.documentId;

    return {
      name: '2. Documents - Upload Text Document',
      passed,
      error: passed ? null : 'Plain text upload not handled properly'
    };
  }

  async test3_ListDocumentsWithPagination() {
    const res = await this.api.get('/documents?page=1&limit=10');

    const passed = res.status === 200 &&
                   res.data.documents !== undefined &&
                   res.data.page === 1 &&
                   res.data.limit === 10 &&
                   res.data.total !== undefined;

    return {
      name: '3. Documents - List with Pagination',
      passed,
      error: passed ? null : 'Pagination not implemented correctly'
    };
  }

  async test4_FilterByTags() {
    const res = await this.api.get('/documents?tags=test,integration');

    const passed = res.status === 200 && Array.isArray(res.data.documents);

    return {
      name: '4. Documents - Filter by Tags',
      passed,
      error: passed ? null : 'Tag filtering not working'
    };
  }

  async test5_BatchUpload() {
    const documents = [
      { content: 'Doc 1', metadata: { title: 'Test 1' } },
      { content: 'Doc 2', metadata: { title: 'Test 2' } },
      { content: 'Doc 3', metadata: { title: 'Test 3' } }
    ];

    const res = await this.api.post('/documents/batch', { documents });

    const passed = res.status === 200 && res.data.uploaded === 3;

    return {
      name: '5. Documents - Batch Upload',
      passed,
      error: passed ? null : 'Batch upload endpoint missing'
    };
  }

  async test6_GetDocumentChunks() {
    // First upload a document
    const uploadRes = await this.api.post('/documents', {
      content: 'Test document for chunking',
      metadata: { title: 'Chunk Test' }
    });

    if (uploadRes.data.documentId) {
      const res = await this.api.get(`/documents/${uploadRes.data.documentId}/chunks`);
      const passed = res.status === 200 && Array.isArray(res.data.chunks) && res.data.chunks.length > 0;

      return {
        name: '6. Chunking - Get Document Chunks',
        passed,
        error: passed ? null : 'No chunks returned for document'
      };
    }

    return {
      name: '6. Chunking - Get Document Chunks',
      passed: false,
      error: 'Could not upload test document'
    };
  }

  async test7_RetrieveSingleChunk() {
    const res = await this.api.get('/chunks/test-chunk-id');

    return {
      name: '7. Chunking - Retrieve Single Chunk',
      passed: false,
      error: 'Chunk retrieval endpoint not implemented'
    };
  }

  async test8_CustomChunkingStrategy() {
    const res = await this.api.post('/documents/test-id/chunk', {
      strategy: 'custom',
      chunkSize: 500
    });

    const passed = res.status === 200 && res.data.chunks;

    return {
      name: '8. Chunking - Custom Strategy',
      passed,
      error: passed ? null : 'Custom chunking not implemented'
    };
  }

  async test9_SemanticSearch() {
    const res = await this.api.post('/search', {
      query: 'test semantic search',
      limit: 10
    });

    const passed = res.status === 200 && Array.isArray(res.data.results);

    return {
      name: '9. Vector Search - Semantic Search',
      passed,
      error: passed ? null : 'Semantic search returning no results'
    };
  }

  async test10_SimilarityWithFilters() {
    const res = await this.api.post('/search', {
      query: 'test query',
      filters: { type: 'document' },
      limit: 10
    });

    const passed = res.status === 200 && Array.isArray(res.data.results);

    return {
      name: '10. Vector Search - Similarity with Filters',
      passed,
      error: passed ? null : 'Filtered search not working'
    };
  }

  async test11_GetDocumentGraph() {
    const res = await this.api.get('/graph/documents/test-doc-id');

    const passed = res.status === 200 && res.data.nodes && res.data.edges;

    return {
      name: '11. Graph - Get Document Graph',
      passed,
      error: passed ? null : 'Graph extraction not working'
    };
  }

  async test12_ExecuteCypherQuery() {
    const res = await this.api.post('/graph/query', {
      query: 'MATCH (n) RETURN n LIMIT 1'
    });

    const passed = res.status === 200 && res.data.results;

    return {
      name: '12. Graph - Execute Cypher Query',
      passed,
      error: passed ? null : 'Neo4j query execution failing'
    };
  }

  async test13_RetrieveMemory() {
    const res = await this.api.get('/memories/test-memory-id');

    const passed = res.status === 200 || res.status === 404;

    return {
      name: '13. Memory - Retrieve Memory',
      passed: false,
      error: 'Memory retrieval not implemented'
    };
  }

  async test14_ListMemories() {
    const res = await this.api.get('/memories');

    const passed = res.status === 200 && Array.isArray(res.data.memories);

    return {
      name: '14. Memory - List Memories',
      passed,
      error: passed ? null : 'Memory listing not working'
    };
  }

  async test15_WebSocketConnection() {
    return new Promise((resolve) => {
      const ws = new WebSocket(WS_BASE_URL);

      ws.on('open', () => {
        ws.close();
        resolve({
          name: '15. WebSocket - Real-time Connection',
          passed: true,
          error: null
        });
      });

      ws.on('error', (error) => {
        resolve({
          name: '15. WebSocket - Real-time Connection',
          passed: false,
          error: `WebSocket connection failed: ${error.message}`
        });
      });

      setTimeout(() => {
        ws.close();
        resolve({
          name: '15. WebSocket - Real-time Connection',
          passed: false,
          error: 'WebSocket connection timeout'
        });
      }, 5000);
    });
  }

  async test16_DocumentProcessingStream() {
    // WebSocket streaming is implemented but requires active connection
    return {
      name: '16. WebSocket - Document Processing Stream',
      passed: false,
      error: 'WebSocket streaming requires active document processing'
    };
  }

  async test17_LargeDocumentUpload() {
    const largeContent = 'A'.repeat(117 * 1024); // 117KB
    const res = await this.api.post('/documents', {
      content: largeContent,
      metadata: { title: 'Large Document' }
    });

    const passed = res.status === 200 || res.status === 201;

    return {
      name: '17. Performance - Large Document Upload',
      passed,
      error: passed ? null : 'Large document handling failed'
    };
  }

  async test18_InvalidAPIKey() {
    const res = await this.api.get('/api/health', {
      headers: { 'X-API-Key': 'invalid-key' }
    });

    const passed = res.status === 401 || res.status === 403;

    return {
      name: '18. Error Handling - Invalid API Key',
      passed,
      error: passed ? null : `Expected 401/403, got ${res.status}`
    };
  }
}

// Run the tests
async function main() {
  const runner = new GraphRAGTestRunner();
  await runner.runAllTests();
}

main().catch(console.error);