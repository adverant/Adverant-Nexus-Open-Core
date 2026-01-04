/**
 * Local Compute Client
 *
 * Client for communicating with local compute agent daemon
 * and HPC Gateway for job submission and status queries.
 */

import { io, Socket } from 'socket.io-client';
import axios, { AxiosInstance } from 'axios';
import EventEmitter from 'eventemitter3';
import os from 'os';
import fs from 'fs/promises';
import path from 'path';
import type {
  LocalComputeConfig,
  ComputeAgentStatus,
  LocalComputeJob,
  JobSubmitRequest,
  ComputeEvents,
  DEFAULT_COMPUTE_CONFIG,
} from '../../../types/compute.js';

/**
 * Path to agent PID file
 */
const AGENT_PID_FILE = path.join(os.homedir(), '.nexus', 'compute-agent.pid');
const AGENT_SOCKET_FILE = path.join(os.homedir(), '.nexus', 'compute-agent.sock');

export interface LocalComputeClientOptions {
  /** Local agent API port (default: 9200) */
  agentPort?: number;
  /** HPC Gateway URL for remote operations */
  gatewayUrl?: string;
  /** Request timeout in ms */
  timeout?: number;
}

export class LocalComputeClient extends EventEmitter<ComputeEvents> {
  private agentClient: AxiosInstance;
  private gatewayClient: AxiosInstance;
  private wsClient: Socket | null = null;
  private readonly agentUrl: string;
  private readonly gatewayUrl: string;
  private readonly timeout: number;

  constructor(options: LocalComputeClientOptions = {}) {
    super();

    const agentPort = options.agentPort ?? 9200;
    this.agentUrl = `http://localhost:${agentPort}`;
    this.gatewayUrl = options.gatewayUrl ?? 'https://api.adverant.ai/hpc';
    this.timeout = options.timeout ?? 30000;

    this.agentClient = axios.create({
      baseURL: this.agentUrl,
      timeout: this.timeout,
      headers: { 'Content-Type': 'application/json' },
    });

    this.gatewayClient = axios.create({
      baseURL: this.gatewayUrl,
      timeout: this.timeout,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  /**
   * Check if local compute agent is running
   */
  async isAgentRunning(): Promise<boolean> {
    try {
      // Check PID file first
      const pidExists = await this.getAgentPid();
      if (!pidExists) {
        return false;
      }

      // Verify agent is responsive
      const response = await this.agentClient.get('/health', { timeout: 2000 });
      return response.status === 200;
    } catch {
      return false;
    }
  }

  /**
   * Get agent PID from file
   */
  async getAgentPid(): Promise<number | null> {
    try {
      const pidStr = await fs.readFile(AGENT_PID_FILE, 'utf-8');
      const pid = parseInt(pidStr.trim(), 10);

      // Check if process is actually running
      try {
        process.kill(pid, 0);
        return pid;
      } catch {
        // Process not running, clean up stale PID file
        await fs.unlink(AGENT_PID_FILE).catch(() => {});
        return null;
      }
    } catch {
      return null;
    }
  }

  /**
   * Get agent status
   */
  async getAgentStatus(): Promise<ComputeAgentStatus | null> {
    try {
      const response = await this.agentClient.get('/status');
      return this.parseAgentStatus(response.data);
    } catch {
      return null;
    }
  }

  /**
   * Submit a job to local compute agent
   */
  async submitJob(request: JobSubmitRequest): Promise<LocalComputeJob> {
    if (request.remote && request.cluster) {
      // Submit to remote HPC cluster
      return this.submitRemoteJob(request);
    }

    // Submit to local agent
    const running = await this.isAgentRunning();
    if (!running) {
      throw new Error(
        'Local compute agent is not running. Start it with: nexus compute agent start'
      );
    }

    try {
      const response = await this.agentClient.post('/jobs', {
        name: request.name,
        script: request.script,
        scriptPath: request.scriptPath,
        workingDir: request.workingDir ?? process.cwd(),
        environment: request.environment ?? {},
        resources: {
          gpu: request.resources?.gpu ?? true,
          gpuMemoryPercent: request.resources?.gpuMemoryPercent,
          cpuCores: request.resources?.cpuCores,
          memoryGb: request.resources?.memoryGb,
        },
        framework: request.framework ?? 'generic',
      });

      return this.parseJob(response.data);
    } catch (error) {
      throw new Error(
        `Failed to submit job: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * Submit job to remote HPC cluster
   */
  private async submitRemoteJob(request: JobSubmitRequest): Promise<LocalComputeJob> {
    try {
      const response = await this.gatewayClient.post('/jobs', {
        name: request.name,
        script: request.script,
        scriptPath: request.scriptPath,
        workingDir: request.workingDir,
        environment: request.environment,
        resources: request.resources,
        framework: request.framework,
        cluster: request.cluster,
      });

      return this.parseJob(response.data);
    } catch (error) {
      throw new Error(
        `Failed to submit remote job: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * Get job status
   */
  async getJobStatus(jobId: string): Promise<LocalComputeJob | null> {
    try {
      const response = await this.agentClient.get(`/jobs/${jobId}`);
      return this.parseJob(response.data);
    } catch (error) {
      if (axios.isAxiosError(error) && error.response?.status === 404) {
        return null;
      }
      throw new Error(
        `Failed to get job status: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * List all jobs
   */
  async listJobs(options?: {
    status?: string;
    limit?: number;
  }): Promise<LocalComputeJob[]> {
    const running = await this.isAgentRunning();
    if (!running) {
      return [];
    }

    try {
      const response = await this.agentClient.get('/jobs', {
        params: {
          status: options?.status,
          limit: options?.limit ?? 50,
        },
      });

      return (response.data.jobs || []).map(this.parseJob);
    } catch {
      return [];
    }
  }

  /**
   * Cancel a running job
   */
  async cancelJob(jobId: string): Promise<void> {
    try {
      await this.agentClient.post(`/jobs/${jobId}/cancel`);
    } catch (error) {
      throw new Error(
        `Failed to cancel job: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * Get job logs
   */
  async getJobLogs(
    jobId: string,
    options?: { tail?: number; follow?: boolean }
  ): Promise<string[]> {
    try {
      const response = await this.agentClient.get(`/jobs/${jobId}/logs`, {
        params: {
          tail: options?.tail,
        },
      });

      return response.data.logs || [];
    } catch (error) {
      throw new Error(
        `Failed to get job logs: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * Stream job logs via WebSocket
   */
  async *streamJobLogs(jobId: string): AsyncIterable<string> {
    const wsUrl = this.agentUrl.replace('http://', 'ws://');
    const socket = io(wsUrl, {
      transports: ['websocket'],
      reconnection: false,
    });

    this.wsClient = socket;

    const logQueue: string[] = [];
    let resolveNext: ((value: IteratorResult<string>) => void) | null = null;
    let streamEnded = false;
    let streamError: Error | null = null;

    socket.on('connect', () => {
      socket.emit('subscribe:logs', { jobId });
    });

    socket.on('log', (data: { line: string }) => {
      if (resolveNext) {
        resolveNext({ done: false, value: data.line });
        resolveNext = null;
      } else {
        logQueue.push(data.line);
      }
    });

    socket.on('job:completed', () => {
      streamEnded = true;
      if (resolveNext) {
        resolveNext({ done: true, value: undefined as any });
      }
    });

    socket.on('job:failed', (data: { error: string }) => {
      streamError = new Error(data.error);
      streamEnded = true;
      if (resolveNext) {
        resolveNext({ done: true, value: undefined as any });
      }
    });

    socket.on('error', (error: Error) => {
      streamError = error;
      streamEnded = true;
      if (resolveNext) {
        resolveNext({ done: true, value: undefined as any });
      }
    });

    socket.on('disconnect', () => {
      streamEnded = true;
      if (resolveNext) {
        resolveNext({ done: true, value: undefined as any });
      }
    });

    try {
      while (!streamEnded || logQueue.length > 0) {
        if (logQueue.length > 0) {
          yield logQueue.shift()!;
        } else if (!streamEnded) {
          await new Promise<void>((resolve) => {
            resolveNext = () => {
              resolveNext = null;
              resolve();
            };
          });

          if (logQueue.length > 0) {
            yield logQueue.shift()!;
          }
        }
      }

      if (streamError) {
        throw streamError;
      }
    } finally {
      socket.disconnect();
      this.wsClient = null;
    }
  }

  /**
   * Stop the local compute agent
   */
  async stopAgent(): Promise<void> {
    const pid = await this.getAgentPid();
    if (!pid) {
      throw new Error('Local compute agent is not running');
    }

    try {
      // Try graceful shutdown first
      await this.agentClient.post('/shutdown', {}, { timeout: 5000 });
    } catch {
      // Force kill if graceful shutdown fails
      try {
        process.kill(pid, 'SIGTERM');

        // Wait for process to exit
        await new Promise<void>((resolve) => {
          let attempts = 0;
          const check = setInterval(() => {
            try {
              process.kill(pid, 0);
              attempts++;
              if (attempts > 10) {
                // Force kill
                process.kill(pid, 'SIGKILL');
              }
            } catch {
              clearInterval(check);
              resolve();
            }
          }, 500);
        });
      } catch (error) {
        throw new Error(
          `Failed to stop agent: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }

    // Clean up PID file
    await fs.unlink(AGENT_PID_FILE).catch(() => {});
  }

  /**
   * Parse job data from API response
   */
  private parseJob(data: any): LocalComputeJob {
    return {
      id: data.id,
      name: data.name,
      script: data.script,
      scriptPath: data.scriptPath,
      workingDir: data.workingDir,
      environment: data.environment || {},
      resources: {
        gpu: data.resources?.gpu ?? false,
        gpuMemoryPercent: data.resources?.gpuMemoryPercent,
        cpuCores: data.resources?.cpuCores,
        memoryGb: data.resources?.memoryGb,
      },
      framework: data.framework || 'generic',
      status: data.status || 'queued',
      submittedAt: new Date(data.submittedAt),
      startedAt: data.startedAt ? new Date(data.startedAt) : undefined,
      completedAt: data.completedAt ? new Date(data.completedAt) : undefined,
      exitCode: data.exitCode,
      error: data.error,
      logs: data.logs || [],
      metrics: data.metrics,
    };
  }

  /**
   * Parse agent status from API response
   */
  private parseAgentStatus(data: any): ComputeAgentStatus {
    return {
      id: data.id,
      name: data.name,
      status: data.status || 'disconnected',
      registeredAt: new Date(data.registeredAt),
      lastHeartbeat: new Date(data.lastHeartbeat),
      currentJob: data.currentJob ? this.parseJob(data.currentJob) : null,
      jobsCompleted: data.jobsCompleted || 0,
      jobsFailed: data.jobsFailed || 0,
      totalComputeTime: data.totalComputeTime || 0,
      hardware: data.hardware,
    };
  }

  /**
   * Disconnect WebSocket if connected
   */
  disconnect(): void {
    if (this.wsClient) {
      this.wsClient.disconnect();
      this.wsClient = null;
    }
  }
}

export default LocalComputeClient;
