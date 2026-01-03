/**
 * Universal Task Executor - End-to-End Task Orchestration
 *
 * PHASE 59: REFACTORED - Now uses real LLM-based agents instead of mocks
 *
 * Workflow:
 * 1. Decompose task → TaskDecompositionAgent (LLM) identifies tools/packages needed
 * 2. Check GraphRAG for existing pattern
 * 3. Generate code (CodingAgent with LLM) if no pattern exists
 * 4. Upload input files to FileProcessAgent
 * 5. Execute in sandbox with dynamic package installation
 * 6. Download output artifacts
 * 7. Store successful pattern in GraphRAG for reuse
 *
 * Example: nexus_execute_unknown_task({ task: "Convert EPS to SVG", files: [epsBuffer] })
 * → Returns: { success: true, artifacts: [{ filename: 'output.svg', buffer: svgBuffer }] }
 */

import axios, { AxiosInstance } from 'axios';
import FormData from 'form-data';
import { v4 as uuidv4 } from 'uuid';
import { logger } from '../utils/logger';
import { TaskDecompositionAgent, TaskDecomposition } from '../agents/task-decomposition-agent';
import { CodingAgent } from '../agents/coding-agent';
import { OpenRouterClient } from '../clients/openrouter-client';
import { GraphRAGClient, createGraphRAGClient, TenantContext } from '../clients/graphrag-client';
import { databaseManager, DatabaseManager } from '../database/database-manager';
import { config } from '../config';
import { AgentDependencies } from '../agents/base-agent';

export interface UniversalTaskRequest {
  task: string;
  files?: Array<{ name: string; buffer: Buffer; mimeType?: string }>;
  parameters?: Record<string, string>;
  timeout?: number; // milliseconds
}

export interface UniversalTaskResult {
  success: boolean;
  artifacts: Array<{
    filename: string;
    buffer?: Buffer;
    url?: string;
    artifactId?: string;
    storageBackend?: string;
  }>;
  logs: string;
  decomposition?: any;
  generatedCode?: string;
  patternStored: boolean;
  executionTime: number;
  error?: string;
}

/**
 * Dependencies required to instantiate UniversalTaskExecutor
 * These are injected to support multi-tenant operations
 */
export interface UniversalTaskExecutorDependencies {
  openRouterClient: OpenRouterClient;
  graphRAGClient: GraphRAGClient;
  databaseManager: DatabaseManager;
  tenantContext?: TenantContext;
}

export class UniversalTaskExecutor {
  private fileProcessApiUrl: string;
  private sandboxApiUrl: string;
  private graphragApiUrl: string;
  private axiosClient: AxiosInstance;

  // PHASE 59: Real agent dependencies (no more mocks!)
  private openRouterClient: OpenRouterClient;
  private graphRAGClient: GraphRAGClient;
  private dbManager: DatabaseManager;
  private tenantContext?: TenantContext;

  // Default model for task decomposition and code generation
  private readonly defaultModel = 'anthropic/claude-sonnet-4';

  constructor(dependencies?: UniversalTaskExecutorDependencies) {
    this.fileProcessApiUrl = process.env.FILEPROCESS_API_URL || 'http://nexus-fileprocess-api:9099';
    this.sandboxApiUrl = process.env.SANDBOX_API_URL || 'http://nexus-sandbox:9095';
    this.graphragApiUrl = process.env.GRAPHRAG_API_URL || 'http://nexus-graphrag:9090';

    this.axiosClient = axios.create({
      timeout: 120000, // 2 minutes default
    });

    // PHASE 59: Initialize real dependencies
    if (dependencies) {
      this.openRouterClient = dependencies.openRouterClient;
      this.graphRAGClient = dependencies.graphRAGClient;
      this.dbManager = dependencies.databaseManager;
      this.tenantContext = dependencies.tenantContext;
    } else {
      // Fallback: Create default clients for backward compatibility
      this.openRouterClient = new OpenRouterClient(
        config.openRouter.apiKey,
        config.openRouter.baseUrl
      );
      this.graphRAGClient = new GraphRAGClient(config.graphRAG.endpoint);
      this.dbManager = databaseManager;
    }

    logger.info('UniversalTaskExecutor initialized with LLM-based agents', {
      fileProcessApiUrl: this.fileProcessApiUrl,
      sandboxApiUrl: this.sandboxApiUrl,
      graphragApiUrl: this.graphragApiUrl,
      defaultModel: this.defaultModel,
      hasTenantContext: !!this.tenantContext,
    });
  }

  /**
   * Get agent dependencies for creating agents
   */
  private getAgentDependencies(): AgentDependencies {
    return {
      openRouterClient: this.openRouterClient,
      graphRAGClient: this.tenantContext
        ? createGraphRAGClient(this.tenantContext)
        : this.graphRAGClient,
      databaseManager: this.dbManager,
      tenantContext: this.tenantContext,
    };
  }

  /**
   * Execute unknown task end-to-end
   */
  async execute(request: UniversalTaskRequest): Promise<UniversalTaskResult> {
    const startTime = Date.now();
    const executionId = uuidv4();

    logger.info('Starting universal task execution', {
      executionId,
      task: request.task,
      fileCount: request.files?.length || 0,
    });

    try {
      // Step 1: Task Decomposition
      logger.info('Step 1: Decomposing task', { executionId });
      const decomposition = await this.decomposeTask(request.task);

      logger.info('Task decomposed', {
        executionId,
        tools: decomposition.requiredTools,
        language: decomposition.executionLanguage,
      });

      // Step 2: Check GraphRAG for existing pattern
      logger.info('Step 2: Checking GraphRAG for existing pattern', { executionId });
      const existingPattern = await this.checkExistingPattern(request.task);

      let generatedCode: string;

      if (existingPattern) {
        logger.info('Found existing pattern in GraphRAG', {
          executionId,
          patternId: existingPattern.id,
        });
        generatedCode = existingPattern.code;
      } else {
        // Step 3: Generate code using CodingAgent
        logger.info('Step 3: Generating code (no existing pattern)', { executionId });
        generatedCode = await this.generateCode(request.task, decomposition);

        logger.info('Code generated', {
          executionId,
          codeLength: generatedCode.length,
        });
      }

      // Step 4: Upload input files (if any)
      let inputFileArtifacts: string[] = [];
      if (request.files && request.files.length > 0) {
        logger.info('Step 4: Uploading input files', {
          executionId,
          fileCount: request.files.length,
        });

        for (const file of request.files) {
          const artifactId = await this.uploadInputFile(
            file.name,
            file.buffer,
            file.mimeType || 'application/octet-stream',
            executionId
          );
          inputFileArtifacts.push(artifactId);
        }

        logger.info('Input files uploaded', {
          executionId,
          artifactIds: inputFileArtifacts,
        });
      }

      // Step 5: Execute in sandbox with dynamic packages
      logger.info('Step 5: Executing in sandbox', {
        executionId,
        packages: decomposition.requiredTools,
      });

      const sandboxResult = await this.executeInSandbox({
        executionId,
        code: generatedCode,
        language: decomposition.executionLanguage,
        packages: decomposition.requiredTools,
        timeout: request.timeout || 120000,
      });

      if (!sandboxResult.success) {
        throw new Error(`Sandbox execution failed: ${sandboxResult.error}`);
      }

      logger.info('Sandbox execution complete', {
        executionId,
        artifactCount: sandboxResult.artifacts.length,
      });

      // Step 6: Download artifacts
      logger.info('Step 6: Downloading artifacts', {
        executionId,
        artifactCount: sandboxResult.artifacts.length,
      });

      const artifacts: Array<{
        filename: string;
        buffer?: Buffer;
        url?: string;
        artifactId?: string;
        storageBackend?: string;
      }> = [];

      for (const artifact of sandboxResult.artifacts) {
        const downloadedArtifact = await this.downloadArtifact(artifact.artifactId);
        artifacts.push(downloadedArtifact);
      }

      // Step 7: Store pattern in GraphRAG (for future reuse)
      logger.info('Step 7: Storing pattern in GraphRAG', { executionId });
      await this.storePattern(request.task, decomposition, generatedCode, artifacts);

      const executionTime = Date.now() - startTime;

      logger.info('Universal task execution complete', {
        executionId,
        success: true,
        artifactCount: artifacts.length,
        executionTime,
      });

      return {
        success: true,
        artifacts,
        logs: sandboxResult.logs,
        decomposition,
        generatedCode,
        patternStored: true,
        executionTime,
      };
    } catch (error) {
      const executionTime = Date.now() - startTime;

      logger.error('Universal task execution failed', {
        executionId,
        error: error instanceof Error ? error.message : String(error),
        executionTime,
      });

      return {
        success: false,
        artifacts: [],
        logs: error instanceof Error ? error.message : String(error),
        patternStored: false,
        executionTime,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * PHASE 59: Decompose task using REAL TaskDecompositionAgent with LLM
   *
   * This is NO LONGER MOCKED - it uses the actual TaskDecompositionAgent
   * which calls OpenRouter to dynamically analyze any task and determine:
   * - Required apt/npm/pip packages
   * - Execution language (bash, python, javascript, etc.)
   * - Processing steps
   * - Input/output requirements
   */
  private async decomposeTask(task: string): Promise<TaskDecomposition> {
    const agentId = `task-decomposition-${uuidv4().substring(0, 8)}`;

    logger.info('Creating TaskDecompositionAgent for dynamic task analysis', {
      agentId,
      task: task.substring(0, 100),
      model: this.defaultModel,
    });

    // Create real TaskDecompositionAgent with LLM capabilities
    const decompositionAgent = new TaskDecompositionAgent(
      agentId,
      this.defaultModel,
      this.getAgentDependencies()
    );

    try {
      // Assign the task to the agent
      decompositionAgent.task = {
        id: uuidv4(),
        objective: task,
        context: {
          source: 'universal-task-executor',
          purpose: 'dynamic-file-processing',
          timestamp: new Date().toISOString(),
        },
      };

      // Execute the agent - this makes a REAL LLM call via OpenRouter
      const result = await decompositionAgent.execute();

      logger.info('Task decomposition complete via LLM', {
        agentId,
        taskDescription: result.taskDescription,
        requiredTools: result.requiredTools,
        executionLanguage: result.executionLanguage,
        complexity: result.complexity,
      });

      return result;
    } finally {
      // CRITICAL: Always dispose agent to prevent memory leaks
      await decompositionAgent.dispose();
    }
  }

  /**
   * PHASE 59: Check GraphRAG for existing pattern using REAL semantic search
   *
   * This queries the GraphRAG memory system to find previously successful
   * processing patterns for similar tasks. If found, we can reuse the
   * generated code instead of calling the LLM again (faster + cheaper).
   */
  private async checkExistingPattern(task: string): Promise<{ id: string; code: string } | null> {
    try {
      // Use tenant-aware client if available
      const client = this.tenantContext
        ? createGraphRAGClient(this.tenantContext)
        : this.graphRAGClient;

      // Search for similar task patterns in GraphRAG
      const searchResults = await client.recallMemory({
        query: `file processing pattern for: ${task}`,
        limit: 5,
        tags: ['universal-task-executor', 'processing-pattern', 'success'],
        score_threshold: 0.75, // Only return high-confidence matches
      });

      if (!searchResults || !Array.isArray(searchResults) || searchResults.length === 0) {
        logger.debug('No existing pattern found in GraphRAG', { task: task.substring(0, 50) });
        return null;
      }

      // Find the best matching pattern that contains executable code
      for (const memory of searchResults) {
        try {
          const content = typeof memory.content === 'string'
            ? JSON.parse(memory.content)
            : memory.content;

          if (content.generatedCode && content.success === true) {
            logger.info('Found existing processing pattern in GraphRAG', {
              memoryId: memory.id,
              similarity: memory.score || memory.similarity,
              originalTask: content.task?.substring(0, 50),
            });

            return {
              id: memory.id,
              code: content.generatedCode,
            };
          }
        } catch (parseError) {
          // Skip memories that can't be parsed
          continue;
        }
      }

      logger.debug('No usable pattern found in search results', {
        task: task.substring(0, 50),
        resultsCount: searchResults.length,
      });
      return null;
    } catch (error) {
      // Don't fail the whole operation if pattern lookup fails
      logger.warn('Failed to check GraphRAG for existing pattern', {
        error: error instanceof Error ? error.message : String(error),
        task: task.substring(0, 50),
      });
      return null;
    }
  }

  /**
   * PHASE 59: Generate code using REAL CodingAgent with LLM
   *
   * This is NO LONGER MOCKED - it uses the actual CodingAgent which calls
   * OpenRouter to dynamically generate executable code for any task.
   *
   * The decomposition provides context about:
   * - Required packages (apt, npm, pip)
   * - Execution language (bash, python, etc.)
   * - Processing steps
   * - Expected input/output
   */
  private async generateCode(task: string, decomposition: TaskDecomposition): Promise<string> {
    const agentId = `coding-agent-${uuidv4().substring(0, 8)}`;

    logger.info('Creating CodingAgent for dynamic code generation', {
      agentId,
      task: task.substring(0, 100),
      model: this.defaultModel,
      language: decomposition.executionLanguage,
      packages: decomposition.requiredTools,
    });

    // Create real CodingAgent with LLM capabilities
    const codingAgent = new CodingAgent(
      agentId,
      this.defaultModel,
      this.getAgentDependencies()
    );

    try {
      // Build a comprehensive task objective for code generation
      const codeGenObjective = `
Generate executable ${decomposition.executionLanguage} code to: ${task}

REQUIREMENTS:
- Language: ${decomposition.executionLanguage}
- Required packages: ${JSON.stringify(decomposition.requiredTools)}
- Steps: ${decomposition.steps.join(', ')}
- Expected input: ${JSON.stringify(decomposition.inputRequirements)}
- Expected output: ${JSON.stringify(decomposition.expectedOutput)}

CONSTRAINTS:
- Code MUST be production-ready and executable
- Input files are available in the current working directory
- Output files MUST be written to /output directory
- Include proper error handling
- NO placeholder code - implement full functionality
- For shell scripts, start with #!/bin/bash
- For Python, include proper imports
      `.trim();

      // Assign the task to the agent
      codingAgent.task = {
        id: uuidv4(),
        objective: codeGenObjective,
        context: {
          source: 'universal-task-executor',
          decomposition,
          originalTask: task,
          timestamp: new Date().toISOString(),
        },
      };

      // Execute the agent - this makes a REAL LLM call via OpenRouter
      const result = await codingAgent.execute();

      // Extract the actual code from the response
      let generatedCode = '';

      if (result.codeBlocks && result.codeBlocks.length > 0) {
        // Use the first code block that matches the expected language
        const matchingBlock = result.codeBlocks.find(
          (block: { language: string; code: string }) =>
            block.language === decomposition.executionLanguage ||
            block.language === 'bash' ||
            block.language === 'sh' ||
            block.language === 'python'
        );

        if (matchingBlock) {
          generatedCode = matchingBlock.code;
        } else {
          // Fallback to first code block
          generatedCode = result.codeBlocks[0].code;
        }
      } else {
        // If no code blocks found, use the raw implementation
        generatedCode = result.implementation || '';
      }

      logger.info('Code generation complete via LLM', {
        agentId,
        codeLength: generatedCode.length,
        codeBlocksCount: result.codeBlocks?.length || 0,
        detectedLanguage: result.metadata?.language,
      });

      // Ensure shell scripts have proper shebang
      if (decomposition.executionLanguage === 'bash' && !generatedCode.startsWith('#!')) {
        generatedCode = `#!/bin/bash\n${generatedCode}`;
      }

      return generatedCode;
    } finally {
      // CRITICAL: Always dispose agent to prevent memory leaks
      await codingAgent.dispose();
    }
  }

  /**
   * Upload input file to FileProcessAgent
   */
  private async uploadInputFile(
    filename: string,
    buffer: Buffer,
    mimeType: string,
    executionId: string
  ): Promise<string> {
    const formData = new FormData();
    formData.append('file', buffer, { filename, contentType: mimeType });
    formData.append('source_service', 'mageagent');
    formData.append('source_id', executionId);

    const response = await this.axiosClient.post(
      `${this.fileProcessApiUrl}/fileprocess/api/files/upload`,
      formData,
      {
        headers: formData.getHeaders(),
      }
    );

    return response.data.artifact.id;
  }

  /**
   * Execute code in sandbox with dynamic packages
   */
  private async executeInSandbox(params: {
    executionId: string;
    code: string;
    language: string;
    packages: any;
    timeout: number;
  }): Promise<any> {
    const response = await this.axiosClient.post(`${this.sandboxApiUrl}/api/execute`, {
      id: params.executionId,
      type: 'code',
      template: params.language === 'python' ? 'python' : 'bash',
      config: {
        code: params.code,
        timeout: params.timeout,
        packages: params.packages,
      },
    });

    return {
      success: response.data.status === 'success',
      artifacts: response.data.artifacts || [],
      logs: response.data.output || '',
      error: response.data.error,
    };
  }

  /**
   * Download artifact from FileProcessAgent
   */
  private async downloadArtifact(artifactId: string): Promise<any> {
    const response = await this.axiosClient.get(
      `${this.fileProcessApiUrl}/fileprocess/api/files/${artifactId}/metadata`
    );

    const artifact = response.data.artifact;

    // If small file in buffer, download it
    if (artifact.storage_backend === 'postgres_buffer') {
      const downloadResponse = await this.axiosClient.get(
        `${this.fileProcessApiUrl}/fileprocess/api/files/${artifactId}`,
        { responseType: 'arraybuffer' }
      );

      return {
        filename: artifact.filename,
        buffer: Buffer.from(downloadResponse.data),
        artifactId: artifact.id,
        storageBackend: artifact.storage_backend,
      };
    }

    // Large file - return URL
    return {
      filename: artifact.filename,
      url: artifact.download_url,
      artifactId: artifact.id,
      storageBackend: artifact.storage_backend,
    };
  }

  /**
   * PHASE 59: Store successful pattern in GraphRAG for future reuse
   *
   * This enables the system to learn from successful file processing operations.
   * When a similar task is requested later, checkExistingPattern() will find
   * this stored pattern and reuse the generated code (faster + cheaper).
   */
  private async storePattern(
    task: string,
    decomposition: TaskDecomposition,
    code: string,
    artifacts: Array<{ filename: string; buffer?: Buffer; url?: string; artifactId?: string; storageBackend?: string }>
  ): Promise<void> {
    try {
      // Use tenant-aware client if available
      const client = this.tenantContext
        ? createGraphRAGClient(this.tenantContext)
        : this.graphRAGClient;

      // Build pattern content for storage
      const patternContent = {
        task,
        success: true,
        generatedCode: code,
        decomposition: {
          taskDescription: decomposition.taskDescription,
          requiredTools: decomposition.requiredTools,
          executionLanguage: decomposition.executionLanguage,
          steps: decomposition.steps,
          complexity: decomposition.complexity,
        },
        artifacts: artifacts.map((a) => ({
          filename: a.filename,
          artifactId: a.artifactId,
          storageBackend: a.storageBackend,
          hasBuffer: !!a.buffer,
          hasUrl: !!a.url,
        })),
        storedAt: new Date().toISOString(),
      };

      // Store in GraphRAG with semantic tags for retrieval
      await client.storeMemory({
        content: JSON.stringify(patternContent),
        tags: [
          'universal-task-executor',
          'processing-pattern',
          'success',
          decomposition.executionLanguage,
          `complexity-${decomposition.complexity}`,
          // Add package-specific tags for better matching
          ...(decomposition.requiredTools.apt || []).map((pkg: string) => `apt-${pkg}`),
          ...(decomposition.requiredTools.npm || []).map((pkg: string) => `npm-${pkg}`),
          ...(decomposition.requiredTools.pip || []).map((pkg: string) => `pip-${pkg}`),
        ],
        metadata: {
          source: 'universal-task-executor',
          task: task.substring(0, 200),
          language: decomposition.executionLanguage,
          complexity: decomposition.complexity,
          artifactCount: artifacts.length,
          codeLength: code.length,
        },
      });

      logger.info('Pattern stored successfully in GraphRAG', {
        task: task.substring(0, 50),
        complexity: decomposition.complexity,
        language: decomposition.executionLanguage,
        artifactCount: artifacts.length,
        tags: decomposition.requiredTools,
      });
    } catch (error) {
      // Don't fail the whole operation if pattern storage fails
      logger.warn('Failed to store pattern in GraphRAG', {
        error: error instanceof Error ? error.message : String(error),
        task: task.substring(0, 50),
      });
    }
  }
}

// Singleton instance (for backward compatibility)
let universalTaskExecutorInstance: UniversalTaskExecutor | null = null;

/**
 * Get or create UniversalTaskExecutor singleton
 *
 * @param dependencies Optional dependencies for multi-tenant support
 * @param forceNew Force creation of a new instance (useful for tenant-specific executors)
 */
export function getUniversalTaskExecutor(
  dependencies?: UniversalTaskExecutorDependencies,
  forceNew: boolean = false
): UniversalTaskExecutor {
  // If dependencies provided or forceNew, always create fresh instance
  if (dependencies || forceNew) {
    return new UniversalTaskExecutor(dependencies);
  }

  // Otherwise use singleton for backward compatibility
  if (!universalTaskExecutorInstance) {
    universalTaskExecutorInstance = new UniversalTaskExecutor();
  }
  return universalTaskExecutorInstance;
}

/**
 * Create a tenant-specific UniversalTaskExecutor
 * Use this when processing files for a specific tenant
 */
export function createTenantTaskExecutor(
  tenantContext: TenantContext,
  openRouterClient?: OpenRouterClient,
  graphRAGClient?: GraphRAGClient
): UniversalTaskExecutor {
  return new UniversalTaskExecutor({
    openRouterClient: openRouterClient || new OpenRouterClient(
      config.openRouter.apiKey,
      config.openRouter.baseUrl
    ),
    graphRAGClient: graphRAGClient || new GraphRAGClient(
      config.graphRAG.endpoint,
      tenantContext
    ),
    databaseManager: databaseManager,
    tenantContext,
  });
}
