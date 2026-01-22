/**
 * CyberAgentClient - HTTP client for Nexus CyberAgent service
 *
 * Design Pattern: Facade Pattern + Circuit Breaker
 * SOLID Principles:
 * - Single Responsibility: Only handles CyberAgent communication
 * - Dependency Inversion: Depends on interfaces, not implementations
 *
 * Provides:
 * - Security scanning (malware, threats, vulnerabilities)
 * - Job management (create, status, cancel)
 * - Circuit breaker for fail-fast behavior
 * - Automatic retries with exponential backoff
 * - Connection pooling
 */

import axios, { AxiosInstance, AxiosError } from 'axios';
import axiosRetry from 'axios-retry';
import { config } from '../config';

// ============================================================================
// Types
// ============================================================================

/**
 * Scan types supported by CyberAgent
 */
export type ScanType =
  | 'malware'           // Malware detection
  | 'vulnerability'     // Vulnerability scanning
  | 'penetration_test'  // Penetration testing
  | 'apt'               // APT detection
  | 'threat_intel';     // Threat intelligence lookup

/**
 * Security tools available
 */
export type SecurityTool =
  | 'yara'       // YARA rules engine
  | 'clamav'     // ClamAV antivirus
  | 'cuckoo'     // Cuckoo sandbox
  | 'volatility' // Volatility memory forensics
  | 'nmap'       // Network scanner
  | 'nuclei';    // Nuclei vulnerability scanner

/**
 * Sandbox tier for malware analysis
 */
export type SandboxTier =
  | 'tier1'    // Basic analysis
  | 'tier2'    // Deep analysis with detonation
  | 'tier3';   // Full analysis with network simulation

/**
 * Job status
 */
export type JobStatus =
  | 'queued'
  | 'processing'
  | 'completed'
  | 'failed'
  | 'cancelled';

/**
 * Threat severity level
 */
export type ThreatLevel = 'safe' | 'low' | 'medium' | 'high' | 'critical';

/**
 * Request to create a scan job
 */
export interface CreateScanJobRequest {
  scan_type: ScanType;
  target: string;
  tools: SecurityTool[];
  sandbox_tier?: SandboxTier;
  config?: {
    deep_scan?: boolean;
    analysis_timeout?: number;
    enable_network_simulation?: boolean;
    priority?: 'low' | 'normal' | 'high';
  };
  metadata?: Record<string, unknown>;
}

/**
 * Response from job creation
 */
export interface CreateScanJobResponse {
  success: boolean;
  job: ScanJob;
  websocket_url?: string;
}

/**
 * Scan job entity
 */
export interface ScanJob {
  id: string;
  scan_type: ScanType;
  target: string;
  tools: SecurityTool[];
  sandbox_tier: SandboxTier;
  status: JobStatus;
  priority: 'low' | 'normal' | 'high';
  progress?: number;
  result?: ScanResult;
  error?: string;
  created_at: string;
  started_at?: string;
  completed_at?: string;
}

/**
 * Scan result with findings
 */
export interface ScanResult {
  is_malicious: boolean;
  threat_level: ThreatLevel;
  malware_family?: string;
  confidence: number;
  iocs: IOC[];
  yara_matches: YaraMatch[];
  vulnerabilities?: Vulnerability[];
  recommendations: string[];
  analysis_summary: string;
}

/**
 * Indicator of Compromise
 */
export interface IOC {
  type: 'hash' | 'ip' | 'domain' | 'url' | 'email' | 'file_path' | 'registry' | 'mutex';
  value: string;
  confidence: number;
  first_seen?: string;
  last_seen?: string;
  tags?: string[];
}

/**
 * YARA rule match
 */
export interface YaraMatch {
  rule_name: string;
  rule_set: string;
  description?: string;
  severity: ThreatLevel;
  tags?: string[];
  strings_matched?: string[];
}

/**
 * Vulnerability finding
 */
export interface Vulnerability {
  id: string;
  cve_id?: string;
  name: string;
  severity: ThreatLevel;
  cvss_score?: number;
  description: string;
  remediation?: string;
  affected_component?: string;
}

/**
 * Health check response
 */
export interface HealthStatus {
  status: 'healthy' | 'unhealthy' | 'degraded';
  version?: string;
  uptime?: number;
  services?: Record<string, boolean>;
}

// ============================================================================
// Circuit Breaker
// ============================================================================

enum CircuitState {
  CLOSED = 'CLOSED',
  OPEN = 'OPEN',
  HALF_OPEN = 'HALF_OPEN',
}

interface CircuitBreakerConfig {
  failureThreshold: number;
  successThreshold: number;
  timeout: number;
}

class CircuitBreaker {
  private state: CircuitState = CircuitState.CLOSED;
  private failureCount = 0;
  private successCount = 0;
  private lastFailureTime?: Date;
  private readonly name: string;

  constructor(
    private config: CircuitBreakerConfig,
    name: string = 'cyberagent'
  ) {
    this.name = name;
  }

  async execute<T>(operation: () => Promise<T>): Promise<T> {
    if (this.state === CircuitState.OPEN) {
      if (
        this.lastFailureTime &&
        Date.now() - this.lastFailureTime.getTime() > this.config.timeout
      ) {
        console.log(`[${this.name}] Circuit breaker entering HALF_OPEN state`);
        this.state = CircuitState.HALF_OPEN;
        this.successCount = 0;
      } else {
        throw new Error(
          `Circuit breaker OPEN - CyberAgent unavailable (last failure: ${this.lastFailureTime?.toISOString()})`
        );
      }
    }

    try {
      const result = await operation();

      if (this.state === CircuitState.HALF_OPEN) {
        this.successCount++;
        if (this.successCount >= this.config.successThreshold) {
          console.log(`[${this.name}] Circuit breaker CLOSED - service recovered`);
          this.state = CircuitState.CLOSED;
          this.failureCount = 0;
        }
      } else {
        this.failureCount = 0;
      }

      return result;
    } catch (error) {
      this.failureCount++;
      this.lastFailureTime = new Date();

      if (this.failureCount >= this.config.failureThreshold) {
        console.warn(`[${this.name}] Circuit breaker OPEN - service failing`, {
          failureCount: this.failureCount,
          threshold: this.config.failureThreshold,
        });
        this.state = CircuitState.OPEN;
      }

      throw error;
    }
  }

  getState(): CircuitState {
    return this.state;
  }

  reset(): void {
    this.state = CircuitState.CLOSED;
    this.failureCount = 0;
    this.successCount = 0;
  }
}

// ============================================================================
// CyberAgentClient
// ============================================================================

export class CyberAgentClient {
  private client: AxiosInstance;
  private circuitBreaker: CircuitBreaker;
  private baseUrl: string;

  // Configuration
  private readonly DEFAULT_TIMEOUT_MS = 180000; // 3 minutes
  private readonly MAX_POLL_ATTEMPTS = 90; // 90 * 2s = 3 minutes
  private readonly POLL_INTERVAL_MS = 2000; // 2 seconds

  constructor(baseUrl?: string) {
    // Use config or environment variable or default
    this.baseUrl = baseUrl ||
      (config as any).services?.cyberAgent?.endpoint ||
      process.env.CYBERAGENT_URL ||
      'http://nexus-cyberagent:9050';

    // Create axios client with connection pooling
    this.client = axios.create({
      baseURL: this.baseUrl,
      timeout: this.DEFAULT_TIMEOUT_MS,
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'MageAgent/1.0',
      },
      httpAgent: new (require('http').Agent)({
        keepAlive: true,
        maxSockets: 10,
      }),
      httpsAgent: new (require('https').Agent)({
        keepAlive: true,
        maxSockets: 10,
      }),
    });

    // Configure automatic retries
    axiosRetry(this.client, {
      retries: 3,
      retryDelay: axiosRetry.exponentialDelay,
      retryCondition: (error: AxiosError) => {
        return (
          axiosRetry.isNetworkOrIdempotentRequestError(error) ||
          (error.response?.status ? error.response.status >= 500 : false)
        );
      },
      onRetry: (retryCount, error) => {
        console.warn('[CyberAgentClient] Retrying request', {
          retryCount,
          error: error.message,
        });
      },
    });

    // Initialize circuit breaker
    this.circuitBreaker = new CircuitBreaker({
      failureThreshold: 3,
      successThreshold: 2,
      timeout: 45000, // 45 seconds in OPEN state
    });

    console.log('[CyberAgentClient] Initialized', {
      baseUrl: this.baseUrl,
      timeout: `${this.DEFAULT_TIMEOUT_MS}ms`,
    });
  }

  /**
   * Create a new scan job
   */
  async createScanJob(request: CreateScanJobRequest): Promise<CreateScanJobResponse> {
    return this.circuitBreaker.execute(async () => {
      const response = await this.client.post<CreateScanJobResponse>(
        '/api/v1/jobs',
        request
      );
      return response.data;
    });
  }

  /**
   * Get job status by ID
   */
  async getJobStatus(jobId: string): Promise<ScanJob> {
    return this.circuitBreaker.execute(async () => {
      const response = await this.client.get<{ success: boolean; job: ScanJob }>(
        `/api/v1/jobs/${jobId}`
      );
      return response.data.job;
    });
  }

  /**
   * Get job with detailed results
   */
  async getJobWithResults(jobId: string): Promise<ScanJob> {
    return this.circuitBreaker.execute(async () => {
      const response = await this.client.get<{ success: boolean; job: ScanJob }>(
        `/api/v1/jobs/${jobId}/details`
      );
      return response.data.job;
    });
  }

  /**
   * Cancel a running job
   */
  async cancelJob(jobId: string): Promise<ScanJob> {
    return this.circuitBreaker.execute(async () => {
      const response = await this.client.post<{ success: boolean; job: ScanJob }>(
        `/api/v1/jobs/${jobId}/cancel`
      );
      return response.data.job;
    });
  }

  /**
   * Perform malware scan and wait for result
   *
   * Convenience method that creates a job and polls until completion.
   */
  async malwareScan(
    target: string,
    options: {
      tools?: SecurityTool[];
      sandboxTier?: SandboxTier;
      deepScan?: boolean;
      timeout?: number;
    } = {}
  ): Promise<ScanResult> {
    const job = await this.createScanJob({
      scan_type: 'malware',
      target,
      tools: options.tools || ['yara', 'clamav'],
      sandbox_tier: options.sandboxTier || 'tier1',
      config: {
        deep_scan: options.deepScan ?? false,
        analysis_timeout: options.timeout || this.DEFAULT_TIMEOUT_MS,
      },
    });

    return this.waitForJobCompletion(job.job.id, options.timeout);
  }

  /**
   * Perform vulnerability scan
   */
  async vulnerabilityScan(
    target: string,
    options: {
      tools?: SecurityTool[];
      timeout?: number;
    } = {}
  ): Promise<ScanResult> {
    const job = await this.createScanJob({
      scan_type: 'vulnerability',
      target,
      tools: options.tools || ['nuclei'],
      config: {
        analysis_timeout: options.timeout || this.DEFAULT_TIMEOUT_MS,
      },
    });

    return this.waitForJobCompletion(job.job.id, options.timeout);
  }

  /**
   * Check for threats in content
   */
  async threatCheck(
    content: string | Buffer,
    options: {
      filename?: string;
      deepAnalysis?: boolean;
    } = {}
  ): Promise<{
    isThreat: boolean;
    threatLevel: ThreatLevel;
    findings: string[];
  }> {
    // For content-based checks, we submit to the malware scan endpoint
    // with the content as the target
    const target = Buffer.isBuffer(content)
      ? content.toString('base64')
      : content;

    const result = await this.malwareScan(target, {
      deepScan: options.deepAnalysis,
      tools: ['yara', 'clamav'],
    });

    return {
      isThreat: result.is_malicious,
      threatLevel: result.threat_level,
      findings: result.yara_matches.map(m => m.rule_name),
    };
  }

  /**
   * Health check
   */
  async healthCheck(): Promise<HealthStatus> {
    try {
      const response = await this.client.get<HealthStatus>('/health', {
        timeout: 5000,
      });
      return response.data;
    } catch (error) {
      return {
        status: 'unhealthy',
      };
    }
  }

  /**
   * Get circuit breaker state
   */
  getCircuitState(): string {
    return this.circuitBreaker.getState();
  }

  /**
   * Reset circuit breaker
   */
  resetCircuit(): void {
    this.circuitBreaker.reset();
  }

  /**
   * Wait for job completion with polling
   */
  private async waitForJobCompletion(
    jobId: string,
    timeout?: number
  ): Promise<ScanResult> {
    const maxTime = timeout || this.DEFAULT_TIMEOUT_MS;
    const startTime = Date.now();
    let attempts = 0;

    while (Date.now() - startTime < maxTime && attempts < this.MAX_POLL_ATTEMPTS) {
      const job = await this.getJobStatus(jobId);

      if (job.status === 'completed') {
        if (!job.result) {
          throw new Error('Job completed but no result available');
        }
        return job.result;
      }

      if (job.status === 'failed') {
        throw new Error(`Scan job failed: ${job.error || 'Unknown error'}`);
      }

      if (job.status === 'cancelled') {
        throw new Error('Scan job was cancelled');
      }

      // Wait before next poll
      await this.delay(this.POLL_INTERVAL_MS);
      attempts++;
    }

    // Timeout - cancel the job
    try {
      await this.cancelJob(jobId);
    } catch {
      // Ignore cancel errors
    }

    throw new Error(`Scan job timed out after ${maxTime}ms`);
  }

  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

// ============================================================================
// Singleton
// ============================================================================

let cyberAgentClientInstance: CyberAgentClient | null = null;

export function getCyberAgentClient(): CyberAgentClient {
  if (!cyberAgentClientInstance) {
    cyberAgentClientInstance = new CyberAgentClient();
  }
  return cyberAgentClientInstance;
}

export function resetCyberAgentClient(): void {
  cyberAgentClientInstance = null;
}
