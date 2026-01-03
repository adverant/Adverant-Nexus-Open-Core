import { Server as SocketIOServer, Socket } from 'socket.io';
import { Server as HTTPServer } from 'http';
import { logger } from '../utils/logger';
import { v4 as uuidv4 } from 'uuid';

export interface StreamMessage {
  type: 'agent_stream' | 'orchestration_update' | 'competition_result' | 'synthesis_progress' | 'error';
  agentId?: string;
  content: string;
  metadata?: any;
  timestamp: string;
}

export interface ClientSession {
  id: string;
  socket: Socket;
  activeAgents: Set<string>;
  subscriptions: Set<string>;
  createdAt: Date;
}

export class WebSocketManager {
  private _io: SocketIOServer;
  private sessions: Map<string, ClientSession> = new Map();
  private agentStreams: Map<string, Set<string>> = new Map(); // agentId -> Set of session IDs

  // Public getter for io server to allow direct event emission from external modules
  get io(): SocketIOServer {
    return this._io;
  }

  constructor(server: HTTPServer) {
    this._io = new SocketIOServer(server, {
      path: '/mageagent/socket.io', // CRITICAL: Custom path for VirtualService routing
      cors: {
        origin: ["https://adverant.ai", "https://www.adverant.ai"], // Tighten security
        methods: ["GET", "POST"],
        credentials: true
      },
      transports: ['websocket', 'polling'],
      pingTimeout: 60000,
      pingInterval: 25000
    });

    this.setupConnectionHandlers();
    logger.info('WebSocket server initialized');
  }

  private setupConnectionHandlers(): void {
    this._io.on('connection', (socket: Socket) => {
      const sessionId = uuidv4();
      
      logger.info('New WebSocket connection', {
        sessionId,
        socketId: socket.id,
        address: socket.handshake.address
      });

      // Create session
      const session: ClientSession = {
        id: sessionId,
        socket,
        activeAgents: new Set(),
        subscriptions: new Set(),
        createdAt: new Date()
      };
      
      this.sessions.set(sessionId, session);

      // Send welcome message
      socket.emit('welcome', {
        sessionId,
        timestamp: new Date().toISOString(),
        message: 'Connected to MageAgent WebSocket server'
      });

      // Handle client messages
      socket.on('subscribe', (data) => this.handleSubscribe(sessionId, data));
      socket.on('unsubscribe', (data) => this.handleUnsubscribe(sessionId, data));
      socket.on('start_agent_task', (data) => this.handleStartAgentTask(sessionId, data));
      socket.on('stop_agent', (data) => this.handleStopAgent(sessionId, data));
      
      // Handle disconnection
      socket.on('disconnect', (reason) => {
        logger.info('WebSocket disconnected', {
          sessionId,
          reason
        });
        this.cleanupSession(sessionId);
      });

      // Handle errors
      socket.on('error', (error) => {
        logger.error('WebSocket error', {
          sessionId,
          error: error.message
        });
      });
    });
  }

  private handleSubscribe(sessionId: string, data: any): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    const { agentId, streamTypes = ['all'] } = data;
    
    logger.debug('Client subscribing to agent', {
      sessionId,
      agentId,
      streamTypes
    });

    // Add subscription
    session.subscriptions.add(agentId);
    
    // Track agent subscribers
    if (!this.agentStreams.has(agentId)) {
      this.agentStreams.set(agentId, new Set());
    }
    this.agentStreams.get(agentId)!.add(sessionId);

    // Acknowledge subscription
    session.socket.emit('subscribed', {
      agentId,
      streamTypes,
      timestamp: new Date().toISOString()
    });
  }

  private handleUnsubscribe(sessionId: string, data: any): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    const { agentId } = data;
    
    logger.debug('Client unsubscribing from agent', {
      sessionId,
      agentId
    });

    // Remove subscription
    session.subscriptions.delete(agentId);
    
    // Remove from agent subscribers
    const subscribers = this.agentStreams.get(agentId);
    if (subscribers) {
      subscribers.delete(sessionId);
      if (subscribers.size === 0) {
        this.agentStreams.delete(agentId);
      }
    }

    // Acknowledge unsubscription
    session.socket.emit('unsubscribed', {
      agentId,
      timestamp: new Date().toISOString()
    });
  }

  private handleStartAgentTask(sessionId: string, data: any): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    const { taskId, taskType } = data;
    
    logger.info('Client starting agent task', {
      sessionId,
      taskId,
      taskType
    });

    // This would typically trigger the orchestrator
    // For now, acknowledge the request
    session.socket.emit('task_started', {
      taskId,
      taskType,
      timestamp: new Date().toISOString()
    });
  }

  private handleStopAgent(sessionId: string, data: any): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    const { agentId } = data;
    
    logger.info('Client stopping agent', {
      sessionId,
      agentId
    });

    // Remove agent from active list
    session.activeAgents.delete(agentId);
    
    // This would typically signal the agent to stop
    // For now, acknowledge the request
    session.socket.emit('agent_stopped', {
      agentId,
      timestamp: new Date().toISOString()
    });
  }

  // Stream agent output to subscribers
  async streamAgentOutput(agentId: string, message: StreamMessage): Promise<void> {
    const subscribers = this.agentStreams.get(agentId);
    if (!subscribers || subscribers.size === 0) {
      logger.debug('No subscribers for agent', { agentId });
      return;
    }

    const streamData = {
      ...message,
      agentId,
      timestamp: new Date().toISOString()
    };

    // Send to all subscribers
    for (const sessionId of subscribers) {
      const session = this.sessions.get(sessionId);
      if (session) {
        session.socket.emit('agent_stream', streamData);
      }
    }

    logger.debug('Streamed agent output', {
      agentId,
      subscriberCount: subscribers.size,
      messageType: message.type
    });
  }

  // Broadcast competition results
  async broadcastCompetitionResult(competitionId: string, results: any): Promise<void> {
    const message = {
      type: 'competition_result',
      competitionId,
      results,
      timestamp: new Date().toISOString()
    };

    this.io.emit('competition_result', message);
    
    logger.info('Broadcasted competition results', {
      competitionId,
      agentCount: results.agents?.length || 0
    });
  }

  // Broadcast orchestration updates
  async broadcastOrchestrationUpdate(update: any): Promise<void> {
    const message = {
      type: 'orchestration_update',
      ...update,
      timestamp: new Date().toISOString()
    };

    this.io.emit('orchestration_update', message);
  }

  // Stream synthesis progress
  async streamSynthesisProgress(synthesisId: string, progress: any): Promise<void> {
    const message = {
      type: 'synthesis_progress',
      synthesisId,
      progress,
      timestamp: new Date().toISOString()
    };

    this.io.emit('synthesis_progress', message);
  }

  // Send error to specific session
  async sendError(sessionId: string, error: any): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    session.socket.emit('error', {
      type: 'error',
      error: {
        message: error.message,
        code: error.code,
        details: error.details
      },
      timestamp: new Date().toISOString()
    });
  }

  // Get active sessions count
  getActiveSessionsCount(): number {
    return this.sessions.size;
  }

  // Get subscribers for an agent
  getAgentSubscribers(agentId: string): number {
    return this.agentStreams.get(agentId)?.size || 0;
  }

  // Clean up session
  private cleanupSession(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    // Remove from all agent streams
    for (const agentId of session.subscriptions) {
      const subscribers = this.agentStreams.get(agentId);
      if (subscribers) {
        subscribers.delete(sessionId);
        if (subscribers.size === 0) {
          this.agentStreams.delete(agentId);
        }
      }
    }

    // Remove session
    this.sessions.delete(sessionId);
    
    logger.debug('Cleaned up session', { sessionId });
  }

  // Health check
  getHealthMetrics(): any {
    return {
      activeSessions: this.sessions.size,
      activeAgentStreams: this.agentStreams.size,
      totalSubscriptions: Array.from(this.sessions.values())
        .reduce((sum, session) => sum + session.subscriptions.size, 0),
      uptime: process.uptime()
    };
  }

  // Helper method to create streaming function for agents
  createAgentStreamer(agentId: string): (content: string, metadata?: any) => Promise<void> {
    return async (content: string, metadata?: any) => {
      await this.streamAgentOutput(agentId, {
        type: 'agent_stream',
        content,
        metadata,
        timestamp: new Date().toISOString()
      });
    };
  }
}

// Export singleton getter (instance created in main server file)
let webSocketManagerInstance: WebSocketManager | null = null;

export function initializeWebSocketManager(server: HTTPServer): WebSocketManager {
  if (!webSocketManagerInstance) {
    webSocketManagerInstance = new WebSocketManager(server);
  }
  return webSocketManagerInstance;
}

export function getWebSocketManager(): WebSocketManager {
  if (!webSocketManagerInstance) {
    throw new Error('WebSocketManager not initialized');
  }
  return webSocketManagerInstance;
}
