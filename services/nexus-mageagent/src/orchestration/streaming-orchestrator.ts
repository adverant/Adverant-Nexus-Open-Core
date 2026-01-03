/**
 * Streaming Orchestrator - WebSocket-Integrated Task Orchestration
 * Implements real-time streaming for all orchestration operations
 */

import { EventEmitter } from 'events';
import { Transform } from 'stream';
import { v4 as uuidv4 } from 'uuid';
import { logger } from '../utils/logger';
import { getEnhancedWebSocketManager } from '../websocket/enhanced-websocket-manager';
import { Orchestrator } from './orchestrator';

export interface StreamingTaskOptions {
  stream?: boolean;
  sessionId?: string;
  chunkSize?: number;
  flushInterval?: number;
}

export interface TaskStreamEvent {
  type: 'start' | 'progress' | 'chunk' | 'complete' | 'error';
  taskId: string;
  agentId?: string;
  data: any;
  metadata?: Record<string, any>;
  timestamp: number;
}

export class StreamingOrchestrator extends EventEmitter {
  private orchestrator: Orchestrator;
  private activeStreams: Map<string, StreamingTaskContext> = new Map();

  constructor(orchestrator: Orchestrator) {
    super();
    this.orchestrator = orchestrator;
    this.setupEventHandlers();
  }

  private setupEventHandlers(): void {
    // Forward orchestrator events to WebSocket
    this.orchestrator.on('agent:start', (data) => {
      this.streamEvent('agent_started', data);
    });

    this.orchestrator.on('agent:progress', (data) => {
      this.streamEvent('agent_progress', data);
    });

    this.orchestrator.on('agent:complete', (data) => {
      this.streamEvent('agent_completed', data);
    });

    this.orchestrator.on('agent:error', (data) => {
      this.streamEvent('agent_error', data);
    });
  }

  private streamEvent(eventType: string, data: any): void {
    try {
      const wsManager = getEnhancedWebSocketManager();

      // Stream to task-specific subscribers
      if (data.taskId) {
        wsManager.streamToTask(data.taskId, eventType, data);
      }

      // Stream to agent-specific subscribers
      if (data.agentId) {
        wsManager.streamToAgent(data.agentId, eventType, data);
      }

      // Log streaming activity
      logger.debug('Streamed event', {
        eventType,
        taskId: data.taskId,
        agentId: data.agentId
      });
    } catch (error) {
      logger.error('Failed to stream event', {
        eventType,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  async orchestrateWithStreaming(
    task: string | any,
    options: StreamingTaskOptions = {}
  ): Promise<any> {
    const taskId = uuidv4();
    const startTime = Date.now();

    // Create streaming context
    const context = new StreamingTaskContext(taskId, options);
    this.activeStreams.set(taskId, context);

    try {
      // Initialize WebSocket streaming if requested
      if (options.stream) {
        await this.initializeStreaming(taskId, options.sessionId);
      }

      // Send initial task started event
      this.sendStreamEvent(taskId, {
        type: 'start',
        taskId,
        data: { task, options },
        timestamp: Date.now()
      });

      // Create progress reporter
      const progressReporter = this.createProgressReporter(taskId);

      // Execute orchestration with progress reporting
      const result = await this.executeWithProgress(
        task,
        options,
        progressReporter
      );

      // Send completion event
      this.sendStreamEvent(taskId, {
        type: 'complete',
        taskId,
        data: result,
        metadata: {
          duration: Date.now() - startTime,
          success: true
        },
        timestamp: Date.now()
      });

      return {
        ...result,
        taskId,
        streamed: options.stream || false
      };

    } catch (error) {
      // Send error event
      const errorMessage = error instanceof Error ? error.message : String(error);

      this.sendStreamEvent(taskId, {
        type: 'error',
        taskId,
        data: { error: errorMessage },
        metadata: {
          duration: Date.now() - startTime,
          success: false
        },
        timestamp: Date.now()
      });

      throw error;

    } finally {
      // Cleanup streaming context
      this.activeStreams.delete(taskId);
    }
  }

  private async initializeStreaming(
    taskId: string,
    sessionId?: string
  ): Promise<void> {
    const wsManager = getEnhancedWebSocketManager();

    // Notify WebSocket clients about new streaming task
    await wsManager.streamToTask(taskId, 'task_created', {
      taskId,
      sessionId,
      timestamp: Date.now(),
      streaming: true
    });
  }

  private createProgressReporter(taskId: string): (progress: any) => void {
    return (progress: any) => {
      this.sendStreamEvent(taskId, {
        type: 'progress',
        taskId,
        data: progress,
        timestamp: Date.now()
      });
    };
  }

  private async executeWithProgress(
    task: any,
    options: any,
    progressReporter: (progress: any) => void
  ): Promise<any> {
    // Transform stream creation would go here if needed
    // const transformStream = this.createTransformStream(task.taskId || uuidv4());

    // Hook into orchestrator execution
    const originalExecute = this.orchestrator.orchestrateTask.bind(this.orchestrator);

    // Wrap execution with progress reporting
    return new Promise(async (resolve, reject) => {
      let progressInterval: NodeJS.Timeout | undefined;
      let progress = 0;

      try {
        // Start progress reporting
        progressInterval = setInterval(() => {
          progress = Math.min(progress + 10, 90);
          progressReporter({
            percentage: progress,
            stage: this.getProgressStage(progress),
            timestamp: Date.now()
          });
        }, 1000);

        // Execute the actual task
        const result = await originalExecute(task, options);

        // Final progress
        progressReporter({
          percentage: 100,
          stage: 'completed',
          timestamp: Date.now()
        });

        resolve(result);

      } catch (error) {
        reject(error);
      } finally {
        if (progressInterval) {
          clearInterval(progressInterval);
        }
      }
    });
  }

  private getProgressStage(percentage: number): string {
    if (percentage < 20) return 'initializing';
    if (percentage < 40) return 'processing';
    if (percentage < 60) return 'analyzing';
    if (percentage < 80) return 'synthesizing';
    if (percentage < 100) return 'finalizing';
    return 'completed';
  }

  // @ts-ignore - Reserved for future use
  private _createTransformStream(taskId: string): Transform {
    // const wsManager = getEnhancedWebSocketManager(); // Used internally

    return new Transform({
      objectMode: true,
      transform: (chunk, _encoding, callback) => {
        // Stream chunk to WebSocket
        this.sendStreamEvent(taskId, {
          type: 'chunk',
          taskId,
          data: chunk,
          timestamp: Date.now()
        });

        callback(null, chunk);
      }
    });
  }

  private sendStreamEvent(taskId: string, event: TaskStreamEvent): void {
    const context = this.activeStreams.get(taskId);
    if (!context) return;

    // Update context
    context.eventCount++;
    context.lastEventTime = Date.now();

    // Send via WebSocket
    try {
      const wsManager = getEnhancedWebSocketManager();
      wsManager.streamToTask(taskId, 'task_stream', event);
    } catch (error) {
      logger.error('Failed to send stream event', {
        taskId,
        eventType: event.type,
        error: error instanceof Error ? error.message : String(error)
      });
    }

    // Emit local event
    this.emit('stream_event', event);
  }

  async runCompetitionWithStreaming(
    challenge: string,
    options: any = {}
  ): Promise<any> {
    const competitionId = uuidv4();
    const wsManager = getEnhancedWebSocketManager();

    try {
      // Notify start of competition
      await wsManager.broadcast('competition_started', {
        competitionId,
        challenge,
        timestamp: Date.now()
      });

      // Create streaming wrapper for competition
      const streamingOptions = {
        ...options,
        stream: true,
        onAgentUpdate: (agentId: string, update: any) => {
          wsManager.streamToAgent(agentId, 'agent_update', {
            competitionId,
            agentId,
            update,
            timestamp: Date.now()
          });
        }
      };

      // Run competition with streaming
      const result = await this.orchestrator.runCompetition({
        challenge,
        ...streamingOptions
      });

      // Broadcast competition results
      await wsManager.broadcast('competition_completed', {
        competitionId,
        result,
        timestamp: Date.now()
      });

      return result;

    } catch (error) {
      // Broadcast error
      await wsManager.broadcast('competition_error', {
        competitionId,
        error: error instanceof Error ? error.message : String(error),
        timestamp: Date.now()
      });

      throw error;
    }
  }

  createStreamingAgent(agentId: string, model: string): StreamingAgent {
    return new StreamingAgent(agentId, model, this);
  }

  getActiveStreams(): Map<string, StreamingTaskContext> {
    return new Map(this.activeStreams);
  }

  async stopStream(taskId: string): Promise<void> {
    const context = this.activeStreams.get(taskId);
    if (!context) return;

    // Send stream stopped event
    this.sendStreamEvent(taskId, {
      type: 'complete',
      taskId,
      data: { stopped: true },
      metadata: { reason: 'manual_stop' },
      timestamp: Date.now()
    });

    // Cleanup
    this.activeStreams.delete(taskId);
  }
}

class StreamingTaskContext {
  taskId: string;
  options: StreamingTaskOptions;
  startTime: number;
  eventCount: number = 0;
  lastEventTime: number;

  constructor(taskId: string, options: StreamingTaskOptions) {
    this.taskId = taskId;
    this.options = options;
    this.startTime = Date.now();
    this.lastEventTime = Date.now();
  }

  getDuration(): number {
    return Date.now() - this.startTime;
  }

  getEventRate(): number {
    const duration = this.getDuration() / 1000; // in seconds
    return duration > 0 ? this.eventCount / duration : 0;
  }
}

export class StreamingAgent extends EventEmitter {
  private agentId: string;
  private model: string;
  // private orchestrator: StreamingOrchestrator; // Not used currently
  private outputBuffer: string[] = [];
  private flushInterval: NodeJS.Timeout | null = null;

  constructor(agentId: string, model: string, _orchestrator: StreamingOrchestrator) {
    super();
    this.agentId = agentId;
    this.model = model;
    // this.orchestrator = _orchestrator; // Store if needed
    this.startFlushInterval();
  }

  private startFlushInterval(): void {
    this.flushInterval = setInterval(() => {
      this.flush();
    }, 100); // Flush every 100ms
  }

  write(content: string): void {
    this.outputBuffer.push(content);

    // Emit chunk immediately for real-time streaming
    this.emit('chunk', {
      agentId: this.agentId,
      content,
      timestamp: Date.now()
    });

    // Auto-flush if buffer is large
    if (this.outputBuffer.length > 10) {
      this.flush();
    }
  }

  flush(): void {
    if (this.outputBuffer.length === 0) return;

    const content = this.outputBuffer.join('');
    this.outputBuffer = [];

    // Send via WebSocket
    try {
      const wsManager = getEnhancedWebSocketManager();
      wsManager.streamToAgent(this.agentId, 'agent_output', {
        agentId: this.agentId,
        content,
        model: this.model,
        timestamp: Date.now()
      });
    } catch (error) {
      logger.error('Failed to stream agent output', {
        agentId: this.agentId,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  complete(result?: any): void {
    this.flush();

    if (this.flushInterval) {
      clearInterval(this.flushInterval);
      this.flushInterval = null;
    }

    this.emit('complete', {
      agentId: this.agentId,
      result,
      timestamp: Date.now()
    });
  }

  error(error: any): void {
    this.flush();

    if (this.flushInterval) {
      clearInterval(this.flushInterval);
      this.flushInterval = null;
    }

    this.emit('error', {
      agentId: this.agentId,
      error: error instanceof Error ? error.message : String(error),
      timestamp: Date.now()
    });
  }
}

// Export factory function
export function createStreamingOrchestrator(orchestrator: Orchestrator): StreamingOrchestrator {
  return new StreamingOrchestrator(orchestrator);
}