/**
 * Unit Tests for FileProcessClient
 *
 * Tests the FileProcess HTTP client with circuit breaker pattern.
 * Uses mocked HTTP responses for reliable testing.
 */

import MockAdapter from 'axios-mock-adapter';
import {
  FileProcessClient,
  getFileProcessClient,
  resetFileProcessClient,
  ProcessUrlRequest,
  ProcessDriveUrlRequest,
  ProcessFileResponse,
  FileJob,
} from '../../../src/clients/fileprocess-client';

describe('FileProcessClient', () => {
  let client: FileProcessClient;
  let mock: MockAdapter;

  const TEST_BASE_URL = 'http://test-fileprocess:9040';

  beforeEach(() => {
    resetFileProcessClient();
    client = new FileProcessClient(TEST_BASE_URL);
    // Access the internal axios instance for mocking
    mock = new MockAdapter((client as any).client);
  });

  afterEach(() => {
    mock.reset();
    mock.restore();
  });

  // ==========================================================================
  // Constructor Tests
  // ==========================================================================

  describe('Constructor', () => {
    it('should create client with custom base URL', () => {
      const customClient = new FileProcessClient('http://custom:9040');
      expect(customClient).toBeDefined();
      expect(customClient).toBeInstanceOf(FileProcessClient);
    });

    it('should create client with default URL when none provided', () => {
      const defaultClient = new FileProcessClient();
      expect(defaultClient).toBeDefined();
    });
  });

  // ==========================================================================
  // Singleton Pattern Tests
  // ==========================================================================

  describe('Singleton Pattern', () => {
    it('should return same instance when using getFileProcessClient', () => {
      const instance1 = getFileProcessClient();
      const instance2 = getFileProcessClient();
      expect(instance1).toBe(instance2);
    });

    it('should create new instance after reset', () => {
      const instance1 = getFileProcessClient();
      resetFileProcessClient();
      const instance2 = getFileProcessClient();
      expect(instance1).not.toBe(instance2);
    });
  });

  // ==========================================================================
  // Health Check Tests
  // ==========================================================================

  describe('healthCheck', () => {
    it('should return healthy status when service is available', async () => {
      mock.onGet('/health').reply(200, {
        status: 'healthy',
        version: '1.0.0',
        queueStatus: {
          pending: 0,
          active: 2,
          completed: 100,
          failed: 1
        }
      });

      const health = await client.healthCheck();
      expect(health.status).toBe('healthy');
    });

    it('should handle degraded status', async () => {
      mock.onGet('/health').reply(200, {
        status: 'degraded',
        queueStatus: {
          pending: 50,
          active: 10,
          completed: 100,
          failed: 20
        }
      });

      const health = await client.healthCheck();
      expect(health.status).toBe('degraded');
    });

    it('should return unhealthy on service unavailable', async () => {
      mock.onGet('/health').reply(503);

      // healthCheck catches errors and returns unhealthy
      const health = await client.healthCheck();
      expect(health.status).toBe('unhealthy');
    });
  });

  // ==========================================================================
  // Process URL Tests
  // ==========================================================================

  describe('processUrl', () => {
    const validRequest: ProcessUrlRequest = {
      fileUrl: 'https://example.com/document.pdf',
      filename: 'document.pdf',
      mimeType: 'application/pdf',
      options: {
        enableOcr: true,
        extractTables: true
      }
    };

    const mockResponse: ProcessFileResponse = {
      jobId: 'job-123',
      status: 'pending',
      message: 'File processing started',
      estimatedDurationMs: 30000
    };

    it('should submit file for processing', async () => {
      mock.onPost('/api/process/url').reply(200, mockResponse);

      const response = await client.processUrl(validRequest);
      expect(response.jobId).toBe('job-123');
      expect(response.status).toBe('pending');
    });

    it('should include all options in request', async () => {
      mock.onPost('/api/process/url').reply((config) => {
        const data = JSON.parse(config.data);
        expect(data.fileUrl).toBe('https://example.com/document.pdf');
        expect(data.filename).toBe('document.pdf');
        expect(data.options.enableOcr).toBe(true);
        return [200, mockResponse];
      });

      await client.processUrl(validRequest);
    });

    it('should handle invalid URL errors', async () => {
      mock.onPost('/api/process/url').reply(400, {
        error: 'Invalid file URL',
        code: 'INVALID_URL'
      });

      await expect(client.processUrl(validRequest)).rejects.toThrow();
    });

    it('should handle file too large errors', async () => {
      mock.onPost('/api/process/url').reply(413, {
        error: 'File exceeds maximum size limit',
        maxSize: '100MB'
      });

      await expect(client.processUrl(validRequest)).rejects.toThrow();
    });
  });

  // ==========================================================================
  // Process Drive URL Tests
  // ==========================================================================

  describe('processDriveUrl', () => {
    const validRequest: ProcessDriveUrlRequest = {
      driveUrl: 'https://drive.google.com/file/d/abc123/view',
      options: {
        enableOcr: true,
        extractTables: true
      }
    };

    it('should process Google Drive URL', async () => {
      mock.onPost('/api/process/drive-url').reply(200, {
        jobId: 'job-drive-123',
        status: 'pending',
        message: 'Processing Google Drive file'
      });

      const response = await client.processDriveUrl(validRequest);
      expect(response.jobId).toBe('job-drive-123');
    });

    it('should handle Google Drive auth errors', async () => {
      mock.onPost('/api/process/drive-url').reply(401, {
        error: 'Google Drive authentication failed',
        code: 'DRIVE_AUTH_ERROR'
      });

      await expect(client.processDriveUrl(validRequest)).rejects.toThrow();
    });

    it('should handle file not found in Drive', async () => {
      mock.onPost('/api/process/drive-url').reply(404, {
        error: 'File not found in Google Drive',
        code: 'FILE_NOT_FOUND'
      });

      await expect(client.processDriveUrl(validRequest)).rejects.toThrow();
    });
  });

  // ==========================================================================
  // Get Job Status Tests
  // ==========================================================================

  describe('getJobStatus', () => {
    const mockJob: FileJob = {
      id: 'job-123',
      status: 'processing',
      filename: 'document.pdf',
      mimeType: 'application/pdf',
      fileSize: 1024000,
      progress: 50,
      createdAt: new Date().toISOString()
    };

    it('should return job status', async () => {
      mock.onGet('/api/jobs/job-123').reply(200, {
        job: mockJob
      });

      const job = await client.getJobStatus('job-123');
      expect(job.id).toBe('job-123');
      expect(job.status).toBe('processing');
      expect(job.progress).toBe(50);
    });

    it('should return completed job with result', async () => {
      const completedJob: FileJob = {
        ...mockJob,
        status: 'completed',
        progress: 100,
        result: {
          success: true,
          extractedContent: 'Extracted document text content',
          metadata: {
            pageCount: 5,
            wordCount: 1500
          },
          tables: [
            {
              id: 'table-1',
              rows: 10,
              columns: 5,
              data: []
            }
          ],
          processingMethod: 'pdf-parser',
          executionTimeMs: 5000
        },
        completedAt: new Date().toISOString()
      };

      mock.onGet('/api/jobs/job-123').reply(200, {
        job: completedJob
      });

      const job = await client.getJobStatus('job-123');
      expect(job.status).toBe('completed');
      expect(job.result?.success).toBe(true);
      expect(job.result?.metadata?.pageCount).toBe(5);
    });

    it('should return failed job with error', async () => {
      mock.onGet('/api/jobs/job-123').reply(200, {
        job: {
          ...mockJob,
          status: 'failed',
          error: 'PDF parsing failed: corrupted file'
        }
      });

      const job = await client.getJobStatus('job-123');
      expect(job.status).toBe('failed');
      expect(job.error).toContain('corrupted file');
    });

    it('should handle job not found', async () => {
      mock.onGet('/api/jobs/nonexistent').reply(404, {
        error: 'Job not found'
      });

      await expect(client.getJobStatus('nonexistent')).rejects.toThrow();
    });
  });

  // ==========================================================================
  // Cancel Job Tests
  // ==========================================================================

  describe('cancelJob', () => {
    it('should cancel job successfully', async () => {
      mock.onPost('/api/jobs/job-123/cancel').reply(200, {
        success: true,
        message: 'Job cancelled'
      });

      // cancelJob returns void, should not throw
      await expect(client.cancelJob('job-123')).resolves.toBeUndefined();
    });

    it('should handle cancellation of completed job', async () => {
      mock.onPost('/api/jobs/job-123/cancel').reply(400, {
        error: 'Cannot cancel completed job'
      });

      await expect(client.cancelJob('job-123')).rejects.toThrow();
    });
  });

  // ==========================================================================
  // Circuit Breaker Tests
  // ==========================================================================

  describe('Circuit Breaker', () => {
    it('should open circuit after multiple failures', async () => {
      mock.onGet('/api/jobs/job-123').reply(500, { error: 'Internal Server Error' });

      // Fail 5 times to trigger circuit breaker (threshold is 5 for FileProcess)
      for (let i = 0; i < 5; i++) {
        try {
          await client.getJobStatus('job-123');
        } catch (e) {
          // Expected to fail
        }
      }

      // Next call should fail fast with circuit breaker error
      await expect(client.getJobStatus('job-123')).rejects.toThrow(/Circuit breaker/);
    });

    it('should report circuit state', () => {
      const state = client.getCircuitState();
      expect(['CLOSED', 'OPEN', 'HALF_OPEN']).toContain(state);
    });

    it('should reset circuit breaker', () => {
      client.resetCircuit();
      expect(client.getCircuitState()).toBe('CLOSED');
    });
  });

  // ==========================================================================
  // Convenience Methods Tests
  // ==========================================================================

  describe('downloadAndProcess', () => {
    it('should download and process file from URL', async () => {
      // Submit job
      mock.onPost('/api/process/url').replyOnce(200, {
        jobId: 'job-download',
        status: 'pending'
      });

      // Poll for completion - first processing, then completed
      let pollCount = 0;
      mock.onGet('/api/jobs/job-download').reply(() => {
        pollCount++;
        if (pollCount < 2) {
          return [200, {
            job: {
              id: 'job-download',
              status: 'processing',
              progress: 50,
              filename: 'document.pdf',
              createdAt: new Date().toISOString()
            }
          }];
        }
        return [200, {
          job: {
            id: 'job-download',
            status: 'completed',
            progress: 100,
            filename: 'document.pdf',
            createdAt: new Date().toISOString(),
            result: {
              success: true,
              extractedContent: 'Extracted text content',
              processingMethod: 'pdf-parser',
              executionTimeMs: 3000
            }
          }
        }];
      });

      const result = await client.downloadAndProcess('https://example.com/doc.pdf', {
        enableOcr: true,
        extractTables: true
      });

      expect(result.success).toBe(true);
      expect(result.extractedContent).toBe('Extracted text content');
    });

    it('should handle Google Drive URLs automatically', async () => {
      mock.onPost('/api/process/drive-url').replyOnce(200, {
        jobId: 'job-drive',
        status: 'pending'
      });

      mock.onGet('/api/jobs/job-drive').reply(200, {
        job: {
          id: 'job-drive',
          status: 'completed',
          filename: 'gdrive-doc.pdf',
          createdAt: new Date().toISOString(),
          result: {
            success: true,
            extractedContent: 'Google Drive document content',
            processingMethod: 'pdf-parser',
            executionTimeMs: 4000
          }
        }
      });

      const result = await client.downloadAndProcess('https://drive.google.com/file/d/abc123/view');
      expect(result.success).toBe(true);
    });

    it('should handle processing failure', async () => {
      mock.onPost('/api/process/url').replyOnce(200, {
        jobId: 'job-fail',
        status: 'pending'
      });

      mock.onGet('/api/jobs/job-fail').reply(200, {
        job: {
          id: 'job-fail',
          status: 'failed',
          filename: 'bad.pdf',
          error: 'Invalid PDF format',
          createdAt: new Date().toISOString()
        }
      });

      await expect(
        client.downloadAndProcess('https://example.com/bad.pdf')
      ).rejects.toThrow(/Invalid PDF format/);
    });
  });

  describe('extractContent', () => {
    it('should extract content from document', async () => {
      mock.onPost('/api/process/url').replyOnce(200, {
        jobId: 'job-extract',
        status: 'pending'
      });

      mock.onGet('/api/jobs/job-extract').reply(200, {
        job: {
          id: 'job-extract',
          status: 'completed',
          filename: 'doc.pdf',
          createdAt: new Date().toISOString(),
          result: {
            success: true,
            extractedContent: 'Document content here',
            tables: [{ id: 't1', rows: 5, columns: 3, data: [] }],
            metadata: { pageCount: 10, wordCount: 500 },
            processingMethod: 'pdf-parser',
            executionTimeMs: 2000
          }
        }
      });

      const result = await client.extractContent('https://example.com/doc.pdf');
      expect(result.content).toBe('Document content here');
      expect(result.tables).toHaveLength(1);
      expect(result.metadata?.pageCount).toBe(10);
    });
  });
});
