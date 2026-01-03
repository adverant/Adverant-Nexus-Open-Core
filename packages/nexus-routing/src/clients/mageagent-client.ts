/**
 * MageAgent Client for Nexus Routing Package
 * Wrapper around MageAgent service HTTP API
 */

import axios, { AxiosInstance, AxiosError } from 'axios';
import { logger } from '../utils/logger.js';
import { ServiceUnavailableError, ToolExecutionError } from '../utils/error-handler.js';
import { config } from '../config.js';

export class MageAgentClient {
  private client: AxiosInstance;
  private healthy: boolean = true;
  private lastHealthCheck: number = 0;

  constructor() {
    this.client = axios.create({
      baseURL: config.mageagent.endpoints[0],
      timeout: config.mageagent.defaultTimeout,
      headers: {
        'Content-Type': 'application/json',
        ...(config.mageagent.apiKey && {
          'Authorization': `Bearer ${config.mageagent.apiKey}`
        })
      }
    });

    // Response interceptor for error handling
    this.client.interceptors.response.use(
      (response) => response,
      (error: AxiosError) => {
        this.handleError(error);
        throw error;
      }
    );

    logger.debug('MageAgent client initialized', {
      endpoint: config.mageagent.endpoints[0]
    });
  }

  /**
   * Handle HTTP errors with verbose logging
   */
  private handleError(error: AxiosError): void {
    const context = {
      endpoint: error.config?.url,
      method: error.config?.method,
      status: error.response?.status,
      data: error.response?.data
    };

    logger.error('MageAgent client error', context);
  }

  /**
   * Health check with caching
   */
  async checkHealth(): Promise<boolean> {
    const now = Date.now();

    // Use cached health status if recent
    if (now - this.lastHealthCheck < 30000) {
      return this.healthy;
    }

    try {
      // Try both /health and root endpoint
      let response;
      try {
        response = await this.client.get('/api/health', { timeout: 5000 });
      } catch {
        response = await this.client.get('/', { timeout: 5000 });
      }

      this.healthy = response.status === 200;
      this.lastHealthCheck = now;

      logger.debug('MageAgent health check', {
        healthy: this.healthy,
        response: response.data
      });

      return this.healthy;
    } catch (error) {
      this.healthy = false;
      this.lastHealthCheck = now;

      logger.warn('MageAgent health check failed', {
        error: (error as Error).message
      });

      return false;
    }
  }

  /**
   * Ensure service is healthy before request
   */
  private async ensureHealthy(toolName: string): Promise<void> {
    if (!await this.checkHealth()) {
      throw new ServiceUnavailableError('mageagent', {
        tool: toolName,
        endpoint: config.mageagent.endpoints[0]
      });
    }
  }

  /**
   * Generic POST request with error handling
   */
  private async post<T = any>(endpoint: string, data: any, toolName: string): Promise<T> {
    await this.ensureHealthy(toolName);

    try {
      const response = await this.client.post<T>(endpoint, data);
      return response.data;
    } catch (error) {
      throw new ToolExecutionError(toolName, 'mageagent', error as Error);
    }
  }

  /**
   * Generic GET request with error handling
   */
  private async get<T = any>(endpoint: string, toolName: string): Promise<T> {
    await this.ensureHealthy(toolName);

    try {
      const response = await this.client.get<T>(endpoint);
      return response.data;
    } catch (error) {
      throw new ToolExecutionError(toolName, 'mageagent', error as Error);
    }
  }

  // ========================================
  // Orchestration Operations
  // ========================================
  async orchestrate(task: {
    task: string;
    context?: any;
    maxAgents?: number;
    timeout?: number;
  }): Promise<any> {
    return this.post('/api/orchestrate', task, 'nexus_orchestrate');
  }

  async runCompetition(competition: {
    challenge: string;
    competitorCount?: number;
    evaluationCriteria?: string[];
    timeout?: number;
  }): Promise<any> {
    return this.post('/api/competition', competition, 'nexus_agent_competition');
  }

  async collaborate(collaboration: {
    objective: string;
    agents?: Array<{ role: string; focus?: string }>;
    iterations?: number;
  }): Promise<any> {
    return this.post('/api/collaborate', collaboration, 'nexus_agent_collaborate');
  }

  // ========================================
  // Analysis & Synthesis
  // ========================================
  async analyze(analysis: {
    topic: string;
    depth?: 'quick' | 'standard' | 'deep';
    includeMemory?: boolean;
  }): Promise<any> {
    // Map depth to agent configuration
    const maxAgents = analysis.depth === 'deep' ? 5 : analysis.depth === 'quick' ? 1 : 3;
    const timeout = analysis.depth === 'deep' ? 120000 : 60000;

    return this.orchestrate({
      task: `Perform ${analysis.depth || 'standard'} analysis on: ${analysis.topic}`,
      context: {
        analysisDepth: analysis.depth,
        includeMemory: analysis.includeMemory !== false
      },
      maxAgents,
      timeout
    });
  }

  async synthesize(synthesis: {
    sources: string[];
    objective?: string;
    format?: 'summary' | 'report' | 'analysis' | 'recommendations';
  }): Promise<any> {
    return this.orchestrate({
      task: `Synthesize the following into ${synthesis.format || 'summary'}: ${synthesis.sources.join(', ')}`,
      context: {
        objective: synthesis.objective,
        format: synthesis.format,
        sources: synthesis.sources
      },
      maxAgents: 2,
      timeout: 60000
    });
  }

  // ========================================
  // Memory & Patterns
  // ========================================
  async searchMemory(search: {
    query: string;
    limit?: number;
    tags?: string[];
  }): Promise<any> {
    return this.post('/api/memory/search', search, 'nexus_memory_search');
  }

  async storePattern(pattern: {
    pattern: string;
    context: string;
    tags?: string[];
    confidence?: number;
  }): Promise<any> {
    return this.post('/api/patterns', pattern, 'nexus_store_pattern');
  }

  // ========================================
  // Task & Agent Management
  // ========================================
  async getTaskStatus(taskId: string): Promise<any> {
    return this.get(`/api/tasks/${taskId}`, 'nexus_task_status');
  }

  async listAgents(): Promise<any> {
    return this.get('/api/agents', 'nexus_list_agents');
  }

  async getAgent(agentId: string): Promise<any> {
    return this.get(`/api/agents/${agentId}`, 'nexus_agent_details');
  }

  // ========================================
  // System & Stats
  // ========================================
  async getWebSocketStats(): Promise<any> {
    return this.get('/api/websocket/stats', 'nexus_websocket_stats');
  }

  async getModelStats(): Promise<any> {
    return this.get('/api/models/stats', 'nexus_model_stats');
  }

  async selectModel(selection: {
    complexity: number;
    taskType: string;
    maxBudget?: number;
  }): Promise<any> {
    return this.post('/api/models/select', selection, 'nexus_model_select');
  }
}

// Export singleton instance
export const mageagentClient = new MageAgentClient();
