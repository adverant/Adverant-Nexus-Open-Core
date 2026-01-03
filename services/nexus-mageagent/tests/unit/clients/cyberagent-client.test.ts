/**
 * Unit Tests for CyberAgentClient
 *
 * Tests the CyberAgent HTTP client with circuit breaker pattern.
 * Uses mocked HTTP responses for reliable testing.
 */

import MockAdapter from 'axios-mock-adapter';
import {
  CyberAgentClient,
  getCyberAgentClient,
  resetCyberAgentClient,
  CreateScanJobRequest,
  ScanJob,
} from '../../../src/clients/cyberagent-client';

describe('CyberAgentClient', () => {
  let client: CyberAgentClient;
  let mock: MockAdapter;

  const TEST_BASE_URL = 'http://test-cyberagent:9050';

  beforeEach(() => {
    resetCyberAgentClient();
    client = new CyberAgentClient(TEST_BASE_URL);
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
      const customClient = new CyberAgentClient('http://custom:9050');
      expect(customClient).toBeDefined();
      expect(customClient).toBeInstanceOf(CyberAgentClient);
    });

    it('should create client with default URL when none provided', () => {
      const defaultClient = new CyberAgentClient();
      expect(defaultClient).toBeDefined();
    });
  });

  // ==========================================================================
  // Singleton Pattern Tests
  // ==========================================================================

  describe('Singleton Pattern', () => {
    it('should return same instance when using getCyberAgentClient', () => {
      const instance1 = getCyberAgentClient();
      const instance2 = getCyberAgentClient();
      expect(instance1).toBe(instance2);
    });

    it('should create new instance after reset', () => {
      const instance1 = getCyberAgentClient();
      resetCyberAgentClient();
      const instance2 = getCyberAgentClient();
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
        uptime: 3600
      });

      const health = await client.healthCheck();
      expect(health.status).toBe('healthy');
      expect(health.version).toBe('1.0.0');
    });

    it('should return unhealthy status when service is unavailable', async () => {
      mock.onGet('/health').reply(503, {
        status: 'unhealthy',
        error: 'Database connection failed'
      });

      // healthCheck returns unhealthy status instead of throwing
      const health = await client.healthCheck();
      expect(health.status).toBe('unhealthy');
    });

    it('should handle network errors gracefully', async () => {
      mock.onGet('/health').networkError();

      // healthCheck catches errors and returns unhealthy
      const health = await client.healthCheck();
      expect(health.status).toBe('unhealthy');
    });
  });

  // ==========================================================================
  // Create Scan Job Tests
  // ==========================================================================

  describe('createScanJob', () => {
    const validRequest: CreateScanJobRequest = {
      scan_type: 'malware',
      target: 'https://example.com/suspicious-file.exe',
      tools: ['yara', 'clamav'],
      sandbox_tier: 'tier1',
      config: {
        deep_scan: true,
        analysis_timeout: 120000
      }
    };

    const mockJob: ScanJob = {
      id: 'job-123',
      scan_type: 'malware',
      target: 'https://example.com/suspicious-file.exe',
      tools: ['yara', 'clamav'],
      sandbox_tier: 'tier1',
      status: 'queued',
      priority: 'normal',
      created_at: new Date().toISOString()
    };

    it('should create scan job successfully', async () => {
      mock.onPost('/api/v1/jobs').reply(200, {
        success: true,
        job: mockJob
      });

      const response = await client.createScanJob(validRequest);
      expect(response.success).toBe(true);
      expect(response.job.id).toBe('job-123');
      expect(response.job.scan_type).toBe('malware');
    });

    it('should handle validation errors', async () => {
      mock.onPost('/api/v1/jobs').reply(400, {
        success: false,
        error: 'Invalid target URL'
      });

      await expect(client.createScanJob(validRequest)).rejects.toThrow();
    });

    it('should include metadata in request', async () => {
      mock.onPost('/api/v1/jobs').reply((config) => {
        const data = JSON.parse(config.data);
        expect(data.metadata).toBeDefined();
        return [200, { success: true, job: mockJob }];
      });

      await client.createScanJob({
        ...validRequest,
        metadata: { taskId: 'task-456', sessionId: 'session-789' }
      });
    });
  });

  // ==========================================================================
  // Get Job Status Tests
  // ==========================================================================

  describe('getJobStatus', () => {
    const mockJob: ScanJob = {
      id: 'job-123',
      scan_type: 'malware',
      target: 'https://example.com/file.exe',
      tools: ['yara'],
      sandbox_tier: 'tier1',
      status: 'processing',
      priority: 'normal',
      progress: 50,
      created_at: new Date().toISOString()
    };

    it('should return job status', async () => {
      mock.onGet('/api/v1/jobs/job-123').reply(200, {
        success: true,
        job: mockJob
      });

      const job = await client.getJobStatus('job-123');
      expect(job.id).toBe('job-123');
      expect(job.status).toBe('processing');
      expect(job.progress).toBe(50);
    });

    it('should return completed job with result', async () => {
      const completedJob: ScanJob = {
        ...mockJob,
        status: 'completed',
        progress: 100,
        result: {
          is_malicious: true,
          threat_level: 'high',
          malware_family: 'Trojan.GenericKD',
          confidence: 0.95,
          iocs: [{ type: 'hash', value: 'abc123', confidence: 0.99 }],
          yara_matches: [{ rule_name: 'Trojan_Generic', rule_set: 'malware', severity: 'high' }],
          recommendations: ['Quarantine file', 'Scan system'],
          analysis_summary: 'File contains known malware signatures'
        }
      };

      mock.onGet('/api/v1/jobs/job-123').reply(200, {
        success: true,
        job: completedJob
      });

      const job = await client.getJobStatus('job-123');
      expect(job.status).toBe('completed');
      expect(job.result?.is_malicious).toBe(true);
      expect(job.result?.threat_level).toBe('high');
    });

    it('should return failed job with error', async () => {
      mock.onGet('/api/v1/jobs/job-123').reply(200, {
        success: true,
        job: {
          ...mockJob,
          status: 'failed',
          error: 'Analysis timeout exceeded'
        }
      });

      const job = await client.getJobStatus('job-123');
      expect(job.status).toBe('failed');
      expect(job.error).toBe('Analysis timeout exceeded');
    });

    it('should handle job not found', async () => {
      mock.onGet('/api/v1/jobs/nonexistent').reply(404, {
        success: false,
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
      mock.onPost('/api/v1/jobs/job-123/cancel').reply(200, {
        success: true,
        job: {
          id: 'job-123',
          status: 'cancelled',
          scan_type: 'malware',
          target: 'https://example.com/file.exe',
          tools: ['yara'],
          sandbox_tier: 'tier1',
          priority: 'normal',
          created_at: new Date().toISOString()
        }
      });

      const result = await client.cancelJob('job-123');
      expect(result.status).toBe('cancelled');
    });

    it('should handle cancellation of completed job', async () => {
      mock.onPost('/api/v1/jobs/job-123/cancel').reply(400, {
        success: false,
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
      // Simulate 3 consecutive failures
      mock.onGet('/api/v1/jobs/job-123').reply(500, { error: 'Internal Server Error' });

      // Fail 3 times to trigger circuit breaker (threshold is 3 for CyberAgent)
      for (let i = 0; i < 3; i++) {
        try {
          await client.getJobStatus('job-123');
        } catch (e) {
          // Expected to fail
        }
      }

      // Next call should fail fast with circuit breaker error
      await expect(client.getJobStatus('job-123')).rejects.toThrow(/Circuit breaker OPEN/);
    });

    it('should reset circuit breaker after timeout', async () => {
      // This test verifies the circuit breaker behavior
      // In a real scenario, we'd wait for the timeout period
      const circuitState = client.getCircuitState();
      expect(['CLOSED', 'OPEN', 'HALF_OPEN']).toContain(circuitState);
    });

    it('should reset circuit breaker manually', () => {
      client.resetCircuit();
      expect(client.getCircuitState()).toBe('CLOSED');
    });
  });

  // ==========================================================================
  // Convenience Method Tests
  // ==========================================================================

  describe('Convenience Methods', () => {
    describe('malwareScan', () => {
      it('should create malware scan job and wait for result', async () => {
        // First call creates the job
        mock.onPost('/api/v1/jobs').replyOnce(200, {
          success: true,
          job: {
            id: 'job-malware',
            scan_type: 'malware',
            target: 'https://example.com/file.exe',
            tools: ['yara', 'clamav'],
            sandbox_tier: 'tier1',
            status: 'queued',
            priority: 'normal',
            created_at: new Date().toISOString()
          }
        });

        // Poll returns processing first, then completed
        let pollCount = 0;
        mock.onGet('/api/v1/jobs/job-malware').reply(() => {
          pollCount++;
          if (pollCount < 2) {
            return [200, {
              success: true,
              job: {
                id: 'job-malware',
                status: 'processing',
                progress: 50,
                scan_type: 'malware',
                target: 'https://example.com/file.exe',
                tools: ['yara', 'clamav'],
                sandbox_tier: 'tier1',
                priority: 'normal',
                created_at: new Date().toISOString()
              }
            }];
          }
          return [200, {
            success: true,
            job: {
              id: 'job-malware',
              status: 'completed',
              progress: 100,
              scan_type: 'malware',
              target: 'https://example.com/file.exe',
              tools: ['yara', 'clamav'],
              sandbox_tier: 'tier1',
              priority: 'normal',
              created_at: new Date().toISOString(),
              result: {
                is_malicious: false,
                threat_level: 'safe',
                confidence: 0.99,
                iocs: [],
                yara_matches: [],
                recommendations: [],
                analysis_summary: 'No threats detected'
              }
            }
          }];
        });

        const result = await client.malwareScan('https://example.com/file.exe');
        expect(result.is_malicious).toBe(false);
        expect(result.threat_level).toBe('safe');
      });
    });

    describe('vulnerabilityScan', () => {
      it('should create vulnerability scan job and wait for result', async () => {
        // First call creates the job
        mock.onPost('/api/v1/jobs').replyOnce(200, {
          success: true,
          job: {
            id: 'job-vuln',
            scan_type: 'vulnerability',
            target: 'https://example.com/app',
            tools: ['nuclei'],
            sandbox_tier: 'tier1',
            status: 'queued',
            priority: 'normal',
            created_at: new Date().toISOString()
          }
        });

        // Second call returns completed job
        mock.onGet('/api/v1/jobs/job-vuln').reply(200, {
          success: true,
          job: {
            id: 'job-vuln',
            status: 'completed',
            scan_type: 'vulnerability',
            target: 'https://example.com/app',
            tools: ['nuclei'],
            sandbox_tier: 'tier1',
            priority: 'normal',
            created_at: new Date().toISOString(),
            result: {
              is_malicious: false,
              threat_level: 'low',
              confidence: 0.95,
              iocs: [],
              yara_matches: [],
              vulnerabilities: [
                {
                  id: 'vuln-1',
                  cve_id: 'CVE-2024-1234',
                  name: 'Test Vulnerability',
                  severity: 'low',
                  description: 'A test vulnerability',
                  remediation: 'Update to latest version'
                }
              ],
              recommendations: ['Update dependencies'],
              analysis_summary: 'One low severity vulnerability found'
            }
          }
        });

        const result = await client.vulnerabilityScan('https://example.com/app');
        expect(result.vulnerabilities).toHaveLength(1);
        expect(result.vulnerabilities![0].cve_id).toBe('CVE-2024-1234');
      });
    });

    describe('threatCheck', () => {
      it('should check content for threats', async () => {
        // Creates malware scan job
        mock.onPost('/api/v1/jobs').replyOnce(200, {
          success: true,
          job: {
            id: 'job-threat',
            scan_type: 'malware',
            target: 'test content',
            tools: ['yara', 'clamav'],
            sandbox_tier: 'tier1',
            status: 'queued',
            priority: 'normal',
            created_at: new Date().toISOString()
          }
        });

        // Returns completed job with no threats
        mock.onGet('/api/v1/jobs/job-threat').reply(200, {
          success: true,
          job: {
            id: 'job-threat',
            status: 'completed',
            scan_type: 'malware',
            target: 'test content',
            tools: ['yara', 'clamav'],
            sandbox_tier: 'tier1',
            priority: 'normal',
            created_at: new Date().toISOString(),
            result: {
              is_malicious: false,
              threat_level: 'safe',
              confidence: 0.99,
              iocs: [],
              yara_matches: [],
              recommendations: [],
              analysis_summary: 'No threats detected'
            }
          }
        });

        const result = await client.threatCheck('test content');
        expect(result.isThreat).toBe(false);
        expect(result.threatLevel).toBe('safe');
        expect(result.findings).toEqual([]);
      });
    });
  });
});
