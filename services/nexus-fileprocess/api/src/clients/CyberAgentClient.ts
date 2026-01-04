/**
 * CyberAgentClient for FileProcessAgent
 *
 * HTTP client for Nexus CyberAgent service - handles security scanning,
 * malware analysis, and binary decompilation for executable files.
 *
 * Design Pattern: Facade Pattern + Circuit Breaker
 * SOLID Principles:
 * - Single Responsibility: Only handles CyberAgent communication
 * - Dependency Inversion: Depends on interfaces, not implementations
 *
 * Use Cases for FileProcessAgent:
 * - Binary/executable file analysis (DMG, EXE, DLL, etc.)
 * - Malware scanning before processing
 * - Decompilation for code extraction
 * - Threat intelligence lookups
 */

import { config } from '../config';
import { logger } from '../utils/logger';

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
  | 'threat_intel'      // Threat intelligence lookup
  | 'binary_analysis';  // Binary decompilation/analysis

/**
 * Security tools available
 */
export type SecurityTool =
  | 'yara'       // YARA rules engine
  | 'clamav'     // ClamAV antivirus
  | 'cuckoo'     // Cuckoo sandbox
  | 'volatility' // Volatility memory forensics
  | 'radare2'    // Radare2 disassembler
  | 'ghidra'     // Ghidra decompiler
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

  /**
   * Local file path for sandbox-first analysis (shared volume)
   * When provided, CyberAgent reads from this path instead of fetching target URL
   * Example: "file:///shared/uploads/binary-abc123.dmg"
   */
  local_file_path?: string;

  /**
   * File metadata for local file analysis
   */
  file_metadata?: {
    filename: string;
    mime_type?: string;
    size?: number;
  };

  config?: {
    deep_scan?: boolean;
    analysis_timeout?: number;
    enable_network_simulation?: boolean;
    priority?: 'low' | 'normal' | 'high';
    extract_code?: boolean;
    decompile?: boolean;
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
  // Binary analysis specific
  decompiled_code?: string;
  extracted_strings?: string[];
  file_metadata?: {
    format: string;
    architecture?: string;
    compiler?: string;
    imports?: string[];
    exports?: string[];
    sections?: Array<{ name: string; size: number; entropy: number }>;
  };
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
        logger.info(`[${this.name}] Circuit breaker entering HALF_OPEN state`);
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
          logger.info(`[${this.name}] Circuit breaker CLOSED - service recovered`);
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
        logger.warn(`[${this.name}] Circuit breaker OPEN - service failing`, {
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
  private circuitBreaker: CircuitBreaker;
  private baseUrl: string;
  private internalApiKey: string;

  // Configuration
  private readonly DEFAULT_TIMEOUT_MS = 180000; // 3 minutes
  private readonly MAX_POLL_ATTEMPTS = 90; // 90 * 2s = 3 minutes
  private readonly POLL_INTERVAL_MS = 2000; // 2 seconds

  constructor(baseUrl?: string) {
    // Use config or environment variable or default
    this.baseUrl = baseUrl ||
      config.cyberagentUrl ||
      process.env.CYBERAGENT_URL ||
      'http://nexus-cyberagent:9050';

    // Internal service API key for service-to-service auth
    // Uses the same API key that FileProcess uses for authenticated requests
    this.internalApiKey = process.env.INTERNAL_SERVICE_API_KEY ||
      process.env.API_KEY ||
      'brain_0T5uLPyy3j3RUdrJlFMY48VuN1a2ov9X'; // Default internal service key

    // Initialize circuit breaker
    this.circuitBreaker = new CircuitBreaker({
      failureThreshold: 3,
      successThreshold: 2,
      timeout: 45000, // 45 seconds in OPEN state
    });

    logger.info('CyberAgentClient initialized', {
      baseUrl: this.baseUrl,
      timeout: `${this.DEFAULT_TIMEOUT_MS}ms`,
      hasApiKey: !!this.internalApiKey,
    });
  }

  /**
   * Get common headers for all requests including auth
   */
  private getAuthHeaders(): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      'User-Agent': 'FileProcessAgent/1.0',
      'X-API-Key': this.internalApiKey,
      'X-Internal-Service': 'nexus-fileprocess',
    };
  }

  /**
   * Create a new scan job
   */
  async createScanJob(request: CreateScanJobRequest): Promise<CreateScanJobResponse> {
    return this.circuitBreaker.execute(async () => {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), this.DEFAULT_TIMEOUT_MS);

      try {
        const response = await fetch(`${this.baseUrl}/api/v1/jobs`, {
          method: 'POST',
          headers: this.getAuthHeaders(),
          body: JSON.stringify(request),
          signal: controller.signal,
        });

        clearTimeout(timeoutId);

        if (!response.ok) {
          const errorText = await response.text().catch(() => 'Unable to read error');
          throw new Error(`CyberAgent returned HTTP ${response.status}: ${errorText}`);
        }

        return await response.json() as CreateScanJobResponse;
      } finally {
        clearTimeout(timeoutId);
      }
    });
  }

  /**
   * Get job status by ID
   */
  async getJobStatus(jobId: string): Promise<ScanJob> {
    return this.circuitBreaker.execute(async () => {
      const response = await fetch(`${this.baseUrl}/api/v1/jobs/${jobId}`, {
        method: 'GET',
        headers: this.getAuthHeaders(),
      });

      if (!response.ok) {
        throw new Error(`Failed to get job status: HTTP ${response.status}`);
      }

      const data = await response.json() as { success: boolean; job: ScanJob };
      return data.job;
    });
  }

  /**
   * Cancel a running job
   */
  async cancelJob(jobId: string): Promise<ScanJob> {
    return this.circuitBreaker.execute(async () => {
      const response = await fetch(`${this.baseUrl}/api/v1/jobs/${jobId}/cancel`, {
        method: 'POST',
        headers: this.getAuthHeaders(),
      });

      if (!response.ok) {
        throw new Error(`Failed to cancel job: HTTP ${response.status}`);
      }

      const data = await response.json() as { success: boolean; job: ScanJob };
      return data.job;
    });
  }

  /**
   * Analyze a binary file (executable, DMG, etc.)
   *
   * This method handles:
   * - Malware scanning
   * - Decompilation via Ghidra/Radare2
   * - Code extraction
   * - String extraction
   *
   * @param targetOrLocalPath - URL to the file OR local file path (file://) for sandbox-first analysis
   * @param options - Analysis options including optional local file metadata
   * @returns Analysis result with extracted code and threat assessment
   */
  async analyzeBinary(
    targetOrLocalPath: string,
    options: {
      filename?: string;
      mimeType?: string;
      fileSize?: number;
      deepAnalysis?: boolean;
      decompile?: boolean;
      timeout?: number;
      /** Use local file path for sandbox-first analysis (bypasses external URL fetch) */
      localFilePath?: string;
    } = {}
  ): Promise<{
    success: boolean;
    threatLevel: ThreatLevel;
    isMalicious: boolean;
    decompiled_code?: string;
    extracted_strings?: string[];
    file_metadata?: ScanResult['file_metadata'];
    yara_matches?: YaraMatch[];
    recommendations: string[];
    analysis_summary: string;
    error?: string;
  }> {
    // Determine if this is a local file path for sandbox-first analysis
    const isLocalFile = targetOrLocalPath.startsWith('file://') ||
                        options.localFilePath?.startsWith('file://');
    const effectiveLocalPath = options.localFilePath || (isLocalFile ? targetOrLocalPath : undefined);

    logger.info('Analyzing binary file via CyberAgent', {
      target: targetOrLocalPath,
      localFilePath: effectiveLocalPath,
      isLocalFile,
      filename: options.filename,
      mimeType: options.mimeType,
      decompile: options.decompile,
    });

    try {
      // Create scan job for binary analysis
      // When local file path is provided, CyberAgent reads from shared volume
      const job = await this.createScanJob({
        scan_type: 'binary_analysis',
        target: isLocalFile ? (effectiveLocalPath || targetOrLocalPath) : targetOrLocalPath,
        local_file_path: effectiveLocalPath,
        file_metadata: options.filename ? {
          filename: options.filename,
          mime_type: options.mimeType,
          size: options.fileSize,
        } : undefined,
        tools: options.decompile
          ? ['yara', 'clamav', 'ghidra', 'radare2']
          : ['yara', 'clamav'],
        sandbox_tier: options.deepAnalysis ? 'tier2' : 'tier1',
        config: {
          deep_scan: options.deepAnalysis ?? true,
          analysis_timeout: options.timeout || this.DEFAULT_TIMEOUT_MS,
          decompile: options.decompile ?? true,
          extract_code: true,
          priority: 'high',
        },
        metadata: {
          filename: options.filename,
          mimeType: options.mimeType,
          source: 'FileProcessAgent',
          is_local_file: isLocalFile,
        },
      });

      logger.info('Binary analysis job created', {
        jobId: job.job.id,
        status: job.job.status,
      });

      // Wait for job completion
      const result = await this.waitForJobCompletion(job.job.id, options.timeout);

      return {
        success: true,
        threatLevel: result.threat_level,
        isMalicious: result.is_malicious,
        decompiled_code: result.decompiled_code,
        extracted_strings: result.extracted_strings,
        file_metadata: result.file_metadata,
        yara_matches: result.yara_matches,
        recommendations: result.recommendations,
        analysis_summary: result.analysis_summary,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);

      logger.error('Binary analysis failed', {
        target: targetOrLocalPath,
        localFilePath: effectiveLocalPath,
        error: errorMessage,
      });

      return {
        success: false,
        threatLevel: 'safe',
        isMalicious: false,
        recommendations: [],
        analysis_summary: 'Analysis failed',
        error: errorMessage,
      };
    }
  }

  /**
   * Perform malware scan and wait for result
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
   * Quick Analysis for Initial Triage (UOM Decision Point 1)
   *
   * Performs rapid classification and initial threat assessment without
   * full decompilation. Used by SandboxFirstOrchestrator to determine
   * appropriate sandbox tier and processing route.
   *
   * @param localFilePath - Local file path (file://) for sandbox analysis
   * @param options - Quick analysis options
   * @returns Quick analysis result with classification and initial threat assessment
   */
  async quickAnalyze(
    localFilePath: string,
    options: {
      filename: string;
      mimeType?: string;
      fileSize?: number;
      timeout?: number;
    }
  ): Promise<{
    success: boolean;
    classification: {
      category: 'binary' | 'document' | 'archive' | 'media' | 'code' | 'data' | 'unknown';
      format: string;
      confidence: number;
    };
    initialThreat: {
      level: ThreatLevel;
      flags: string[];
      requiresDeepScan: boolean;
    };
    recommendations: {
      sandboxTier: 'tier1' | 'tier2' | 'tier3';
      tools: string[];
      priority: number;
    };
    durationMs: number;
    error?: string;
  }> {
    const startTime = Date.now();

    logger.info('Quick analysis requested', {
      localFilePath,
      filename: options.filename,
      mimeType: options.mimeType
    });

    try {
      // Create a quick scan job - tier1 with minimal tools
      const job = await this.createScanJob({
        scan_type: 'malware',
        target: localFilePath,
        local_file_path: localFilePath,
        file_metadata: {
          filename: options.filename,
          mime_type: options.mimeType,
          size: options.fileSize
        },
        tools: ['yara'], // Quick YARA scan only
        sandbox_tier: 'tier1',
        config: {
          deep_scan: false,
          analysis_timeout: options.timeout || 15000, // 15 second default
          priority: 'high'
        },
        metadata: {
          analysis_type: 'quick_triage',
          source: 'SandboxFirstOrchestrator'
        }
      });

      // Wait for completion with short timeout
      const result = await this.waitForJobCompletion(
        job.job.id,
        options.timeout || 15000
      );

      // Determine category from result
      const category = this.determineCategory(options.filename, options.mimeType, result);

      // Determine if deep scan is needed
      const requiresDeepScan =
        result.is_malicious ||
        result.threat_level === 'high' ||
        result.threat_level === 'critical' ||
        result.yara_matches.length > 2 ||
        category === 'binary';

      // Calculate recommended sandbox tier
      let sandboxTier: 'tier1' | 'tier2' | 'tier3' = 'tier1';
      let tools: string[] = ['magic_detect', 'yara_quick'];
      let priority = 5;

      if (category === 'binary' || result.threat_level === 'critical') {
        sandboxTier = 'tier3';
        tools = ['magic_detect', 'yara_full', 'ghidra', 'strings', 'pe_analysis'];
        priority = 9;
      } else if (requiresDeepScan || result.threat_level === 'high') {
        sandboxTier = 'tier2';
        tools = ['magic_detect', 'yara_full', 'strings'];
        priority = 7;
      } else if (category === 'archive') {
        sandboxTier = 'tier2';
        tools = ['magic_detect', 'yara_quick', 'archive_scan'];
        priority = 6;
      }

      return {
        success: true,
        classification: {
          category,
          format: result.file_metadata?.format || 'unknown',
          confidence: result.confidence || 0.8
        },
        initialThreat: {
          level: result.threat_level,
          flags: result.yara_matches.map(m => m.rule_name),
          requiresDeepScan
        },
        recommendations: {
          sandboxTier,
          tools,
          priority
        },
        durationMs: Date.now() - startTime
      };

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';

      logger.error('Quick analysis failed', {
        localFilePath,
        filename: options.filename,
        error: errorMessage
      });

      // Return conservative defaults on failure
      return {
        success: false,
        classification: {
          category: 'unknown',
          format: 'unknown',
          confidence: 0.1
        },
        initialThreat: {
          level: 'medium', // Default to medium on failure
          flags: ['quick_analysis_failed'],
          requiresDeepScan: true
        },
        recommendations: {
          sandboxTier: 'tier2', // Conservative tier
          tools: ['magic_detect', 'yara_full'],
          priority: 7
        },
        durationMs: Date.now() - startTime,
        error: errorMessage
      };
    }
  }

  /**
   * Determine file category from filename, MIME type, and scan result
   */
  private determineCategory(
    filename: string,
    mimeType: string | undefined,
    result: ScanResult
  ): 'binary' | 'document' | 'archive' | 'media' | 'code' | 'data' | 'unknown' {
    // Check format from scan result first
    if (result.file_metadata?.format) {
      const format = result.file_metadata.format.toLowerCase();
      if (['pe', 'elf', 'mach-o', 'macho'].includes(format)) {
        return 'binary';
      }
    }

    // Check MIME type
    if (mimeType) {
      if (CyberAgentClient.isBinaryFileType(mimeType, filename)) {
        return 'binary';
      }
      if (mimeType.startsWith('image/') || mimeType.startsWith('video/') || mimeType.startsWith('audio/')) {
        return 'media';
      }
      if (mimeType.includes('pdf') || mimeType.includes('document') || mimeType.includes('word')) {
        return 'document';
      }
      if (mimeType.includes('zip') || mimeType.includes('archive') || mimeType.includes('compressed')) {
        return 'archive';
      }
      if (mimeType.startsWith('text/')) {
        return 'code';
      }
      if (mimeType.includes('json') || mimeType.includes('xml') || mimeType.includes('csv')) {
        return 'data';
      }
    }

    // Check file extension
    const ext = filename.split('.').pop()?.toLowerCase();
    if (ext) {
      const binaryExts = ['exe', 'dll', 'so', 'dylib', 'dmg', 'pkg', 'bin', 'elf', 'msi', 'app'];
      const archiveExts = ['zip', 'rar', '7z', 'tar', 'gz', 'bz2', 'xz'];
      const docExts = ['pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'odt', 'rtf'];
      const codeExts = ['js', 'ts', 'py', 'go', 'rs', 'java', 'c', 'cpp', 'h', 'rb', 'php'];
      const dataExts = ['json', 'xml', 'csv', 'yaml', 'yml', 'toml'];
      const mediaExts = ['jpg', 'jpeg', 'png', 'gif', 'mp4', 'mp3', 'wav', 'avi', 'mkv'];

      if (binaryExts.includes(ext)) return 'binary';
      if (archiveExts.includes(ext)) return 'archive';
      if (docExts.includes(ext)) return 'document';
      if (codeExts.includes(ext)) return 'code';
      if (dataExts.includes(ext)) return 'data';
      if (mediaExts.includes(ext)) return 'media';
    }

    return 'unknown';
  }

  /**
   * Health check
   */
  async healthCheck(): Promise<HealthStatus> {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 5000);

      const response = await fetch(`${this.baseUrl}/health`, {
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        return { status: 'unhealthy' };
      }

      return await response.json() as HealthStatus;
    } catch {
      return { status: 'unhealthy' };
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

      if (attempts % 10 === 0) {
        logger.debug('Waiting for CyberAgent job completion', {
          jobId,
          attempts,
          maxAttempts: this.MAX_POLL_ATTEMPTS,
          elapsedMs: Date.now() - startTime,
        });
      }
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

  /**
   * Check if a MIME type is a binary/executable file that should be
   * routed to CyberAgent for analysis instead of OCR.
   */
  static isBinaryFileType(mimeType: string, filename?: string): boolean {
    // Document extensions that should go to MageAgent, not CyberAgent
    // Even if MIME type is generic (application/octet-stream)
    // This handles cases where sources (like Google Drive) return incorrect MIME types
    const documentExtensions = new Set([
      'pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx',
      'odt', 'ods', 'odp', 'txt', 'csv', 'rtf', 'html', 'htm',
      'md', 'json', 'xml', 'yaml', 'yml', 'epub', 'mobi',
    ]);

    // For generic octet-stream, prioritize filename extension
    if (mimeType === 'application/octet-stream' && filename) {
      const ext = filename.split('.').pop()?.toLowerCase();
      if (ext && documentExtensions.has(ext)) {
        return false; // Documents → MageAgent
      }
    }

    // Binary/executable MIME types
    const binaryMimeTypes = new Set([
      // Executables
      'application/x-executable',
      'application/x-mach-binary',
      'application/x-mach-o',
      'application/x-dosexec',
      'application/x-msdownload',
      'application/x-ms-dos-executable',
      'application/vnd.microsoft.portable-executable',
      'application/x-elf',
      'application/x-sharedlib',
      'application/x-object',

      // Apple formats
      'application/x-apple-diskimage', // DMG
      'application/x-macho',
      'application/x-apple-installer-package', // PKG
      'application/x-xar', // XAR (macOS archives)

      // Windows formats
      'application/x-msi',
      'application/x-cab',

      // Linux formats
      'application/x-debian-package',
      'application/x-rpm',
      'application/x-redhat-package-manager',
      'application/x-deb',

      // Archives with potential executables
      'application/x-iso9660-image',
      'application/x-raw-disk-image',

      // Compressed executables
      'application/x-bzip2', // Often used for compressed binaries
      'application/x-xz',
      'application/x-lzma',

      // Java
      'application/java-archive', // JAR
      'application/x-java-archive',

      // Android
      'application/vnd.android.package-archive', // APK

      // Generic binary
      'application/octet-stream', // Catch-all for unknown binaries
    ]);

    // Check MIME type
    if (binaryMimeTypes.has(mimeType)) {
      return true;
    }

    // Check file extension as fallback
    if (filename) {
      const ext = filename.split('.').pop()?.toLowerCase();
      const binaryExtensions = new Set([
        'exe', 'dll', 'so', 'dylib', // Executables
        'dmg', 'pkg', 'app', // macOS
        'msi', 'cab', // Windows
        'deb', 'rpm', // Linux
        'apk', 'ipa', // Mobile
        'jar', 'war', 'ear', // Java
        'bin', 'elf', 'o', 'obj', // Raw binaries
        'img', 'iso', // Disk images
        'sys', 'drv', // Drivers
      ]);

      if (ext && binaryExtensions.has(ext)) {
        return true;
      }
    }

    return false;
  }
}

// ============================================================================
// Singleton
// ============================================================================

let cyberAgentClientInstance: CyberAgentClient | null = null;

/**
 * Get or create the singleton CyberAgent client instance
 */
export function getCyberAgentClient(): CyberAgentClient {
  if (!cyberAgentClientInstance) {
    cyberAgentClientInstance = new CyberAgentClient();
  }
  return cyberAgentClientInstance;
}

/**
 * Reset the singleton instance (for testing)
 */
export function resetCyberAgentClient(): void {
  cyberAgentClientInstance = null;
}
