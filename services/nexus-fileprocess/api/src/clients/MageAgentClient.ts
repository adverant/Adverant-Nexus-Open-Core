/**
 * MageAgentClient for FileProcessAgent
 *
 * Simplified HTTP client for MageAgent's rate-limit-exempt internal endpoint.
 * Used for AI-powered analysis of document content, format detection, and quality validation.
 *
 * Architecture:
 * - Direct HTTP fetch to MageAgent:8080/api/internal/orchestrate (RATE-LIMIT EXEMPT)
 * - Basic error handling with timeout control
 * - No client-side rate limiting (internal endpoint bypasses MageAgent's globalRateLimiter)
 * - OpenRouter client already handles retry + circuit breaker (defense in depth)
 *
 * Use Cases for FileProcessAgent:
 * - Document format analysis and intelligent routing
 * - OCR tier selection (Tesseract vs GPT-4 Vision vs Claude-3 Opus)
 * - Quality confidence scoring
 * - Content extraction strategy optimization
 */

import { config } from '../config';
import { logger } from '../utils/logger';

export interface MageAgentTask {
  task: string;
  options?: {
    timeout?: number;
    maxAgents?: number;
    context?: Record<string, unknown>;
    priority?: number;
  };
  timeout?: number;
  maxAgents?: number;
  context?: Record<string, unknown>;
}

export interface MageAgentResponse {
  success: boolean;
  taskId: string;
  status: 'completed' | 'pending' | 'failed';
  agents?: Array<{
    id: string;
    role: string;
    status: string;
    result?: unknown;
  }>;
  result: unknown;
  error?: string;
  realtime?: {
    note: string;
    websocket: string;
    subscribe: string;
  };
}

export interface MageAgentAsyncResponse {
  success: boolean;
  taskId: string;
  status: 'pending';
  message: string;
  pollUrl: string;
  estimatedDuration: string;
}

/**
 * MageAgent client for AI-powered document analysis
 */
export class MageAgentClient {
  private readonly mageagentUrl: string;
  private readonly defaultTimeout: number;
  private requestCount = 0;

  constructor() {
    this.mageagentUrl = config.mageagentUrl;
    this.defaultTimeout = config.processingTimeout;

    logger.info('MageAgentClient initialized', {
      url: this.mageagentUrl,
      timeout: this.defaultTimeout
    });
  }

  /**
   * Execute orchestration task via MageAgent internal endpoint
   *
   * Common use cases for FileProcessAgent:
   * - "Analyze this document and suggest the best OCR tier (Tesseract, GPT-4, or Claude)"
   * - "Extract structured data from this table image with maximum accuracy"
   * - "Determine the optimal document processing strategy for this PDF"
   * - "Score the quality and completeness of this document extraction"
   *
   * @param task - Natural language task description
   * @param options - Orchestration options (agents, timeout, context)
   * @returns MageAgent response with agent results
   */
  async orchestrate(
    task: string,
    options: {
      maxAgents?: number;
      timeout?: number;
      context?: Record<string, unknown>;
      async?: boolean;
    } = {}
  ): Promise<MageAgentResponse | MageAgentAsyncResponse> {
    this.requestCount++;
    const requestId = `fileprocess_${this.requestCount}_${Date.now()}`;

    logger.debug('Orchestrating MageAgent task', {
      requestId,
      task: task.substring(0, 100) + (task.length > 100 ? '...' : ''),
      maxAgents: options.maxAgents,
      timeout: options.timeout
    });

    const startTime = Date.now();

    try {
      // Build MageAgent request
      const requestBody: MageAgentTask = {
        task,
        options: {
          maxAgents: options.maxAgents || 3,
          timeout: options.timeout || this.defaultTimeout,
          context: options.context,
        },
      };

      // Call MageAgent internal orchestration endpoint
      const controller = new AbortController();
      const timeoutId = setTimeout(
        () => controller.abort(),
        (options.timeout || this.defaultTimeout) + 5000 // +5s buffer
      );

      const response = await fetch(this.mageagentUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': 'FileProcessAgent/1.0 (MageAgentClient)',
          'X-Request-ID': requestId,
          'X-Source': 'FileProcessAgent',
        },
        body: JSON.stringify(requestBody),
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      const duration = Date.now() - startTime;

      if (!response.ok) {
        const errorText = await response.text().catch(() => 'Unable to read error response');

        throw new Error(
          `MageAgent returned HTTP ${response.status} ${response.statusText}\n` +
          `Endpoint: ${this.mageagentUrl}\n` +
          `Request ID: ${requestId}\n` +
          `Duration: ${duration}ms\n` +
          `Error Details: ${errorText}\n\n` +
          `Troubleshooting:\n` +
          `- If 429: MageAgent internal endpoint should not rate-limit. Check route configuration.\n` +
          `- If 503: MageAgent may be overloaded. Check service health and logs.\n` +
          `- If 500: Internal error in MageAgent. Check MageAgent container logs.`
        );
      }

      const result = await response.json() as MageAgentResponse | MageAgentAsyncResponse;

      logger.info('MageAgent orchestration completed', {
        requestId,
        duration: `${duration}ms`,
        status: result.status,
        taskId: result.taskId,
        success: result.success
      });

      // Check for async response (long-running task)
      if ('pollUrl' in result) {
        logger.debug('Task is async, poll required', {
          requestId,
          pollUrl: result.pollUrl
        });
        return result as MageAgentAsyncResponse;
      }

      // Check for errors
      if (!result.success || result.status === 'failed') {
        throw new Error(
          `MageAgent orchestration failed\n` +
          `Task ID: ${result.taskId}\n` +
          `Status: ${result.status}\n` +
          `Error: ${result.error || 'Unknown error'}\n` +
          `Duration: ${duration}ms`
        );
      }

      return result as MageAgentResponse;

    } catch (error) {
      const duration = Date.now() - startTime;
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';

      logger.error('MageAgent orchestration failed', {
        requestId,
        task: task.substring(0, 100),
        duration: `${duration}ms`,
        error: errorMessage,
        mageagentUrl: this.mageagentUrl
      });

      throw new Error(
        `MageAgentClient orchestration failed\n` +
        `Request ID: ${requestId}\n` +
        `Endpoint: ${this.mageagentUrl}\n` +
        `Duration: ${duration}ms\n` +
        `Error: ${errorMessage}`
      );
    }
  }

  /**
   * Poll async task status
   */
  async getTaskStatus(taskId: string): Promise<MageAgentResponse> {
    logger.debug('Polling MageAgent task status', { taskId });

    try {
      // Extract base URL (remove /mageagent/api/internal/orchestrate suffix)
      const baseUrl = this.mageagentUrl.replace(/\/mageagent\/api\/.*$/, '');

      const response = await fetch(`${baseUrl}/mageagent/api/tasks/${taskId}`, {
        method: 'GET',
        headers: {
          'User-Agent': 'FileProcessAgent/1.0 (MageAgentClient)',
        },
      });

      if (!response.ok) {
        throw new Error(`Failed to get task status: HTTP ${response.status}`);
      }

      const result = await response.json() as MageAgentResponse;
      return result;

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      logger.error('Failed to poll task status', { taskId, error: errorMessage });

      throw new Error(
        `Failed to poll task ${taskId}: ${errorMessage}`
      );
    }
  }

  /**
   * Analyze document and recommend OCR tier
   * Helper method for common FileProcessAgent use case
   */
  async recommendOCRTier(
    documentInfo: {
      filename: string;
      mimeType: string;
      fileSize: number;
      hasComplexTables?: boolean;
      hasImages?: boolean;
      isScanned?: boolean;
    }
  ): Promise<{ tier: 'tesseract' | 'gpt4-vision' | 'claude-opus'; confidence: number; reasoning: string }> {
    const task = `Analyze this document and recommend the best OCR tier for optimal accuracy/cost:

Document: ${documentInfo.filename}
MIME Type: ${documentInfo.mimeType}
File Size: ${documentInfo.fileSize} bytes
Has Complex Tables: ${documentInfo.hasComplexTables || 'unknown'}
Has Images: ${documentInfo.hasImages || 'unknown'}
Is Scanned: ${documentInfo.isScanned || 'unknown'}

OCR Tiers:
1. Tesseract - 82% accuracy, free, fast
2. GPT-4 Vision - 93% accuracy, $0.01-0.03/page, moderate speed
3. Claude-3 Opus - 97% accuracy, $0.05-0.10/page, slower

Respond with JSON: { "tier": "tesseract|gpt4-vision|claude-opus", "confidence": 0.0-1.0, "reasoning": "explanation" }`;

    const response = await this.orchestrate(task, {
      maxAgents: 1,
      timeout: 10000,
      context: { operation: 'ocr_tier_recommendation' }
    }) as MageAgentResponse;

    // Parse result (expecting JSON from agent)
    const result = response.result as { tier: string; confidence: number; reasoning: string };
    return result as { tier: 'tesseract' | 'gpt4-vision' | 'claude-opus'; confidence: number; reasoning: string };
  }

  /**
   * Get client statistics for monitoring
   */
  getStatistics() {
    return {
      total_requests: this.requestCount,
      config: {
        mageagent_url: this.mageagentUrl,
        default_timeout_ms: this.defaultTimeout,
      },
    };
  }

  /**
   * PHASE 59: Process unknown file type dynamically using UniversalTaskExecutor
   *
   * This method handles file types that are NOT known document formats
   * (e.g., CAD files, point cloud data, 3D models, proprietary formats).
   *
   * The UniversalTaskExecutor will:
   * 1. Analyze the file type using TaskDecompositionAgent (LLM)
   * 2. Determine required packages (apt/npm/pip) to process it
   * 3. Generate processing code using CodingAgent (LLM)
   * 4. Execute in sandbox with dynamic package installation
   * 5. Store successful patterns in GraphRAG for reuse
   *
   * @param fileInfo - Information about the file to process
   * @returns Processing result with extracted content/metadata
   */
  async processUnknownFileType(
    fileInfo: {
      filename: string;
      mimeType: string;
      fileSize: number;
      fileBuffer?: Buffer;
      fileUrl?: string;
    }
  ): Promise<{
    success: boolean;
    extractedContent?: string;
    metadata?: Record<string, unknown>;
    artifacts?: Array<{ filename: string; url?: string }>;
    processingMethod?: string;
    error?: string;
  }> {
    logger.info('Processing unknown file type via MageAgent UniversalTaskExecutor', {
      filename: fileInfo.filename,
      mimeType: fileInfo.mimeType,
      fileSize: fileInfo.fileSize,
      hasBuffer: !!fileInfo.fileBuffer,
      hasUrl: !!fileInfo.fileUrl,
    });

    // Build a comprehensive task description for the LLM
    const task = `
Process and extract content from an unknown file type:

FILE INFORMATION:
- Filename: ${fileInfo.filename}
- MIME Type: ${fileInfo.mimeType}
- File Size: ${fileInfo.fileSize} bytes

OBJECTIVES:
1. Determine what software/packages are needed to open/parse this file type
2. Extract all readable text, metadata, and structural information
3. Convert to a universal format (JSON/text) if possible
4. Report any errors encountered during processing

EXPECTED OUTPUT:
- Extracted text content (if applicable)
- File metadata (creation date, author, format version, etc.)
- Structure information (layers, objects, tables, etc.)
- Processing method used
    `.trim();

    try {
      const initialResponse = await this.orchestrate(task, {
        maxAgents: 5, // Allow multiple agents for complex file processing
        timeout: 300000, // 5 minutes for complex files
        context: {
          operation: 'unknown_file_processing',
          filename: fileInfo.filename,
          mimeType: fileInfo.mimeType,
          fileSize: fileInfo.fileSize,
          // Include file URL for sandbox to download
          fileUrl: fileInfo.fileUrl,
          // Note: We don't send fileBuffer via JSON - sandbox should download from fileUrl
        },
      });

      // Handle async responses by polling
      let response: MageAgentResponse;

      if ('pollUrl' in initialResponse) {
        // Task is async - poll for completion
        logger.info('Unknown file processing started asynchronously', {
          taskId: initialResponse.taskId,
          pollUrl: initialResponse.pollUrl,
          estimatedDuration: initialResponse.estimatedDuration,
        });

        // Poll for up to 5 minutes with increasing intervals
        const maxPolls = 60;
        const pollIntervalMs = 5000; // 5 seconds between polls
        let completedResponse: MageAgentResponse | null = null;

        for (let i = 0; i < maxPolls; i++) {
          await new Promise(resolve => setTimeout(resolve, pollIntervalMs));

          try {
            const statusResponse = await this.getTaskStatus(initialResponse.taskId);

            if (statusResponse.status === 'completed') {
              completedResponse = statusResponse;
              break;
            } else if (statusResponse.status === 'failed') {
              return {
                success: false,
                error: statusResponse.error || 'Task failed during processing',
              };
            }
            // Still pending - continue polling
            logger.debug('Task still processing', {
              taskId: initialResponse.taskId,
              pollAttempt: i + 1,
              maxPolls,
            });
          } catch (pollError) {
            logger.warn('Poll attempt failed, will retry', {
              taskId: initialResponse.taskId,
              pollAttempt: i + 1,
              error: pollError instanceof Error ? pollError.message : 'Unknown error',
            });
          }
        }

        if (!completedResponse) {
          return {
            success: false,
            error: 'Task timed out waiting for completion',
          };
        }

        response = completedResponse;
      } else {
        // Synchronous response
        response = initialResponse as MageAgentResponse;
      }

      if (!response.success) {
        return {
          success: false,
          error: response.error || 'Unknown file processing failed',
        };
      }

      // Parse the result from agents
      const result = response.result as Record<string, unknown>;

      logger.info('Unknown file type processed successfully', {
        filename: fileInfo.filename,
        mimeType: fileInfo.mimeType,
        agentsUsed: response.agents?.length || 0,
      });

      return {
        success: true,
        extractedContent: result?.extractedContent as string || result?.text as string || '',
        metadata: result?.metadata as Record<string, unknown>,
        artifacts: result?.artifacts as Array<{ filename: string; url?: string }>,
        processingMethod: result?.processingMethod as string || 'dynamic_agent_processing',
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';

      logger.error('Failed to process unknown file type', {
        filename: fileInfo.filename,
        mimeType: fileInfo.mimeType,
        error: errorMessage,
      });

      return {
        success: false,
        error: errorMessage,
      };
    }
  }

  /**
   * Check if a MIME type is a known document format that the standard
   * FileProcessAgent pipeline can handle (images, PDFs, text files).
   *
   * Returns false for exotic/unknown formats that need dynamic processing.
   */
  static isKnownDocumentType(mimeType: string): boolean {
    const knownTypes = new Set([
      // Images (for OCR)
      'image/jpeg',
      'image/png',
      'image/gif',
      'image/bmp',
      'image/tiff',
      'image/webp',
      // PDFs
      'application/pdf',
      // Text-based
      'text/plain',
      'text/html',
      'text/markdown',
      'text/csv',
      'application/json',
      'application/xml',
      'text/xml',
      'application/x-yaml',
      'text/yaml',
      'application/javascript',
      'text/javascript',
      // Office documents (if supported by worker)
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document', // .docx
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', // .xlsx
      'application/vnd.openxmlformats-officedocument.presentationml.presentation', // .pptx
      'application/msword', // .doc
      'application/vnd.ms-excel', // .xls
      'application/vnd.ms-powerpoint', // .ppt
    ]);

    return knownTypes.has(mimeType);
  }
}

// Singleton instance
let mageAgentClientInstance: MageAgentClient | null = null;

/**
 * Get or create the singleton MageAgent client instance
 */
export function getMageAgentClient(): MageAgentClient {
  if (!mageAgentClientInstance) {
    mageAgentClientInstance = new MageAgentClient();
  }
  return mageAgentClientInstance;
}
