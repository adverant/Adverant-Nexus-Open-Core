/**
 * Agent Client for OrchestrationAgent Service
 *
 * Handles communication with OrchestrationAgent on port 9109
 * Supports task submission, status queries, and WebSocket streaming
 */

import { io, Socket } from 'socket.io-client';
import axios, { AxiosInstance } from 'axios';
import type {
  AgentTask,
  AgentStatus,
  AgentClient as IAgentClient,
  ReActEvent,
} from '../types/agent.js';

export class AgentClient implements IAgentClient {
  private httpClient: AxiosInstance;
  private wsClient: Socket | null = null;
  private readonly baseUrl: string;
  private readonly wsUrl: string;

  constructor(baseUrl: string = 'http://localhost:9109') {
    this.baseUrl = baseUrl;
    this.wsUrl = baseUrl.replace('http://', 'ws://').replace('https://', 'wss://');

    this.httpClient = axios.create({
      baseURL: this.baseUrl,
      timeout: 30000,
      headers: {
        'Content-Type': 'application/json',
      },
    });
  }

  /**
   * Submit a task for autonomous execution
   * Returns a task ID for tracking
   */
  async submitTask(task: AgentTask): Promise<string> {
    try {
      const response = await this.httpClient.post('/agent/tasks', {
        description: task.task,
        maxIterations: task.maxIterations ?? 20,
        budget: task.budget,
        workspace: task.workspace ?? process.cwd(),
        autoApprove: task.approveCommands ?? false,
        context: task.context ?? {},
      });

      return response.data.taskId;
    } catch (error) {
      throw new Error(
        `Failed to submit task: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * Stream ReAct loop progress via WebSocket
   * Yields events as they occur
   */
  async *streamProgress(taskId: string): AsyncIterable<ReActEvent> {
    const socket = io(this.wsUrl, {
      transports: ['websocket'],
      reconnection: true,
      reconnectionDelay: 1000,
      reconnectionAttempts: 5,
    });

    this.wsClient = socket;

    // Create a queue for events
    const eventQueue: ReActEvent[] = [];
    let resolveNext: ((value: IteratorResult<ReActEvent>) => void) | null = null;
    let streamEnded = false;
    let streamError: Error | null = null;

    // Setup event handlers
    socket.on('connect', () => {
      socket.emit('subscribe', { taskId });
    });

    socket.on('thought', (data: any) => {
      const event: ReActEvent = {
        type: 'thought',
        iteration: data.iteration,
        content: data.content,
        metadata: data.metadata,
        timestamp: new Date(data.timestamp),
      };
      enqueueEvent(event);
    });

    socket.on('action', (data: any) => {
      const event: ReActEvent = {
        type: 'action',
        iteration: data.iteration,
        content: data.content,
        metadata: data.metadata,
        timestamp: new Date(data.timestamp),
      };
      enqueueEvent(event);
    });

    socket.on('observation', (data: any) => {
      const event: ReActEvent = {
        type: 'observation',
        iteration: data.iteration,
        content: data.content,
        metadata: data.metadata,
        timestamp: new Date(data.timestamp),
      };
      enqueueEvent(event);
    });

    socket.on('complete', (data: any) => {
      const event: ReActEvent = {
        type: 'complete',
        iteration: data.iteration,
        content: data.content || 'Task completed',
        metadata: data.result,
        timestamp: new Date(),
      };
      enqueueEvent(event);
      streamEnded = true;
    });

    socket.on('error', (error: any) => {
      streamError = new Error(error.message || 'Stream error');
      streamEnded = true;
      if (resolveNext) {
        resolveNext({ done: true, value: undefined });
      }
    });

    socket.on('approval-required', (data: any) => {
      const event: ReActEvent = {
        type: 'approval-required',
        iteration: data.iteration,
        content: data.command,
        metadata: {
          action: data.action,
          safetyLevel: data.safetyLevel,
          reason: data.reason,
        },
        timestamp: new Date(data.timestamp),
      };
      enqueueEvent(event);
    });

    function enqueueEvent(event: ReActEvent) {
      if (resolveNext) {
        resolveNext({ done: false, value: event });
        resolveNext = null;
      } else {
        eventQueue.push(event);
      }
    }

    // Generator logic
    try {
      while (!streamEnded || eventQueue.length > 0) {
        if (eventQueue.length > 0) {
          yield eventQueue.shift()!;
        } else {
          // Wait for next event
          await new Promise<ReActEvent | null>((resolve, reject) => {
            if (streamError) {
              reject(streamError);
            } else if (streamEnded) {
              resolve(null);
            } else {
              resolveNext = (result) => {
                if (result.done) {
                  resolve(null);
                } else {
                  resolve(result.value);
                }
              };
            }
          });

          // Check queue again after waiting
          if (eventQueue.length > 0) {
            yield eventQueue.shift()!;
          } else if (streamEnded) {
            break;
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
   * Get current status of a task
   */
  async getStatus(taskId: string): Promise<AgentStatus> {
    try {
      const response = await this.httpClient.get(`/agent/tasks/${taskId}`);
      return this.parseAgentStatus(response.data);
    } catch (error) {
      throw new Error(
        `Failed to get task status: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * Cancel a running task
   */
  async cancelTask(taskId: string): Promise<void> {
    try {
      await this.httpClient.post(`/agent/tasks/${taskId}/cancel`);
    } catch (error) {
      throw new Error(
        `Failed to cancel task: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * List all tasks
   */
  async listTasks(): Promise<AgentStatus[]> {
    try {
      const response = await this.httpClient.get('/agent/tasks');
      return response.data.tasks.map(this.parseAgentStatus);
    } catch (error) {
      throw new Error(
        `Failed to list tasks: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * Approve an action (for interactive approval mode)
   */
  async approveAction(
    taskId: string,
    actionId: string,
    approved: boolean,
    modifiedCommand?: string
  ): Promise<void> {
    if (this.wsClient && this.wsClient.connected) {
      this.wsClient.emit('approval-response', {
        taskId,
        actionId,
        approved,
        modifiedCommand,
      });
    } else {
      // Fallback to HTTP
      await this.httpClient.post(`/agent/tasks/${taskId}/approve`, {
        actionId,
        approved,
        modifiedCommand,
      });
    }
  }

  /**
   * Parse API response into AgentStatus
   */
  private parseAgentStatus(data: any): AgentStatus {
    return {
      taskId: data.taskId,
      status: data.status,
      currentIteration: data.currentIteration ?? 0,
      maxIterations: data.maxIterations ?? 20,
      thoughts: (data.thoughts ?? []).map((t: any) => ({
        iteration: t.iteration,
        content: t.content,
        reasoning: t.reasoning,
        timestamp: new Date(t.timestamp),
      })),
      actions: (data.actions ?? []).map((a: any) => ({
        iteration: a.iteration,
        action: a.action,
        tool: a.tool,
        params: a.params,
        requiresApproval: a.requiresApproval,
        approved: a.approved,
        timestamp: new Date(a.timestamp),
      })),
      observations: (data.observations ?? []).map((o: any) => ({
        iteration: o.iteration,
        content: o.content,
        success: o.success,
        error: o.error,
        data: o.data,
        timestamp: new Date(o.timestamp),
      })),
      result: data.result,
      error: data.error,
      startedAt: data.startedAt ? new Date(data.startedAt) : undefined,
      completedAt: data.completedAt ? new Date(data.completedAt) : undefined,
      estimatedCompletion: data.estimatedCompletion
        ? new Date(data.estimatedCompletion)
        : undefined,
      metadata: data.metadata,
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
