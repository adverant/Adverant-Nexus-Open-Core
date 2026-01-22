/**
 * Enhanced WebSocket Manager - Production-Grade Real-Time Communication
 * Implements: Streaming, Bidirectional Communication, Reconnection, Memory Management
 */

import { Server as SocketIOServer, Socket, Namespace } from 'socket.io';
import { Server as HTTPServer } from 'http';
import { EventEmitter } from 'events';
import { Transform } from 'stream';
import { logger } from '../utils/logger';
import { v4 as uuidv4 } from 'uuid';
// import { performance } from 'perf_hooks'; // Not used in this implementation

// Enhanced interfaces with proper typing
export interface StreamOptions {
  backpressureThreshold?: number;
  chunkSize?: number;
  flushInterval?: number;
  compressionLevel?: number;
}

export interface SessionState {
  id: string;
  socket: Socket;
  activeStreams: Map<string, NodeJS.Timeout>;
  subscriptions: Map<string, SubscriptionConfig>;
  lastPing: number;
  reconnectToken?: string;
  metadata: Record<string, any>;
}

export interface SubscriptionConfig {
  type: 'agent' | 'task' | 'competition' | 'global';
  resourceId: string;
  filters?: string[];
  createdAt: number;
  lastActivity: number;
}

export interface StreamingContext {
  taskId: string;
  agentId?: string;
  sessionId: string;
  startTime: number;
  chunks: number;
  bytes: number;
}

export class EnhancedWebSocketManager extends EventEmitter {
  private io: SocketIOServer;
  private sessions: Map<string, SessionState> = new Map();
  private reconnectTokens: Map<string, string> = new Map();
  private streamContexts: Map<string, StreamingContext> = new Map();
  private namespaces: Map<string, Namespace> = new Map();

  // Resource management
  private cleanupInterval!: NodeJS.Timeout;
  private pingInterval!: NodeJS.Timeout;
  private metricsInterval!: NodeJS.Timeout;

  // Performance metrics
  private metrics = {
    messagesIn: 0,
    messagesOut: 0,
    bytesIn: 0,
    bytesOut: 0,
    activeStreams: 0,
    reconnections: 0,
    errors: 0
  };

  constructor(server: HTTPServer) {
    super();

    this.io = new SocketIOServer(server, {
      cors: {
        origin: process.env.CORS_ORIGIN || '*',
        methods: ['GET', 'POST'],
        credentials: true
      },
      transports: ['websocket', 'polling'],
      pingTimeout: 60000,
      pingInterval: 25000,
      maxHttpBufferSize: 1e6, // 1MB
      perMessageDeflate: {
        threshold: 1024 // Compress messages larger than 1KB
      },
      allowEIO3: true // Compatibility with older clients
    });

    this.initializeNamespaces();
    this.setupConnectionHandlers();
    this.startMaintenanceTasks();

    logger.info('Enhanced WebSocket Manager initialized');
  }

  private initializeNamespaces(): void {
    // Create dedicated namespaces for different concerns
    const mainNamespace = this.io.of('/');
    const streamNamespace = this.io.of('/stream');
    const controlNamespace = this.io.of('/control');

    this.namespaces.set('main', mainNamespace);
    this.namespaces.set('stream', streamNamespace);
    this.namespaces.set('control', controlNamespace);

    // Setup namespace-specific handlers
    streamNamespace.on('connection', (socket) => {
      this.handleStreamConnection(socket);
    });

    controlNamespace.on('connection', (socket) => {
      this.handleControlConnection(socket);
    });
  }

  private setupConnectionHandlers(): void {
    const mainNamespace = this.namespaces.get('main')!;

    mainNamespace.on('connection', (socket: Socket) => {
      const sessionId = this.createSession(socket);

      // Enhanced event handlers
      socket.on('subscribe', (data, callback) =>
        this.handleSubscribe(sessionId, data, callback));

      socket.on('unsubscribe', (data, callback) =>
        this.handleUnsubscribe(sessionId, data, callback));

      // Bidirectional communication handlers
      socket.on('ping', (data, callback) =>
        this.handlePing(sessionId, data, callback));

      socket.on('pong', (data) =>
        this.handlePong(sessionId, data));

      // Stream control
      socket.on('start_stream', (data, callback) =>
        this.handleStartStream(sessionId, data, callback));

      socket.on('stop_stream', (data, callback) =>
        this.handleStopStream(sessionId, data, callback));

      // Reconnection support
      socket.on('reconnect_session', (data, callback) =>
        this.handleReconnection(socket, data, callback));

      // Error handling
      socket.on('error', (error) =>
        this.handleError(sessionId, error));

      socket.on('disconnect', (reason) =>
        this.handleDisconnect(sessionId, reason));
    });
  }

  private createSession(socket: Socket): string {
    const sessionId = uuidv4();
    const reconnectToken = uuidv4();

    const session: SessionState = {
      id: sessionId,
      socket,
      activeStreams: new Map(),
      subscriptions: new Map(),
      lastPing: Date.now(),
      reconnectToken,
      metadata: {
        connectedAt: new Date().toISOString(),
        address: socket.handshake.address,
        userAgent: socket.handshake.headers['user-agent']
      }
    };

    this.sessions.set(sessionId, session);
    this.reconnectTokens.set(reconnectToken, sessionId);

    // Send enhanced welcome message
    socket.emit('welcome', {
      sessionId,
      reconnectToken,
      timestamp: new Date().toISOString(),
      capabilities: {
        streaming: true,
        bidirectional: true,
        compression: true,
        reconnection: true
      },
      namespaces: {
        main: '/',
        stream: '/stream',
        control: '/control'
      }
    });

    logger.info('Session created', { sessionId, address: socket.handshake.address });
    this.emit('session_created', sessionId);

    return sessionId;
  }

  private async handleSubscribe(
    sessionId: string,
    data: any,
    callback?: Function
  ): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      callback?.({ error: 'Session not found' });
      return;
    }

    try {
      const { type, resourceId, filters } = data;

      // Validate subscription request
      if (!type || !resourceId) {
        throw new Error('Invalid subscription request: type and resourceId required');
      }

      const subscriptionKey = `${type}:${resourceId}`;
      const subscription: SubscriptionConfig = {
        type,
        resourceId,
        filters,
        createdAt: Date.now(),
        lastActivity: Date.now()
      };

      session.subscriptions.set(subscriptionKey, subscription);

      // Join Socket.IO room for efficient broadcasting
      session.socket.join(subscriptionKey);

      // Send confirmation
      const response = {
        success: true,
        subscription: {
          key: subscriptionKey,
          type,
          resourceId,
          filters
        },
        timestamp: new Date().toISOString()
      };

      session.socket.emit('subscribed', response);
      callback?.(response);

      logger.debug('Subscription created', { sessionId, subscriptionKey });
      this.metrics.messagesIn++;

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      logger.error('Subscribe failed', { sessionId, error: errorMessage });
      callback?.({ error: errorMessage });
      this.metrics.errors++;
    }
  }

  private async handleUnsubscribe(
    sessionId: string,
    data: any,
    callback?: Function
  ): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      callback?.({ error: 'Session not found' });
      return;
    }

    try {
      const { type, resourceId } = data;
      const subscriptionKey = `${type}:${resourceId}`;

      if (session.subscriptions.has(subscriptionKey)) {
        session.subscriptions.delete(subscriptionKey);
        session.socket.leave(subscriptionKey);

        const response = {
          success: true,
          unsubscribed: subscriptionKey,
          timestamp: new Date().toISOString()
        };

        session.socket.emit('unsubscribed', response);
        callback?.(response);

        logger.debug('Subscription removed', { sessionId, subscriptionKey });
      } else {
        callback?.({ error: 'Subscription not found' });
      }

      this.metrics.messagesIn++;

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      logger.error('Unsubscribe failed', { sessionId, error: errorMessage });
      callback?.({ error: errorMessage });
      this.metrics.errors++;
    }
  }

  private async handlePing(
    sessionId: string,
    data: any,
    callback?: Function
  ): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    const pongData = {
      timestamp: Date.now(),
      echo: data,
      sessionId
    };

    // Update last ping time
    session.lastPing = Date.now();

    // Send pong response
    session.socket.emit('pong', pongData);
    callback?.(pongData);

    this.metrics.messagesIn++;
    this.metrics.messagesOut++;
  }

  private handlePong(sessionId: string, data: any): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.lastPing = Date.now();
      logger.debug('Pong received', { sessionId, latency: Date.now() - data.timestamp });
    }
  }

  private async handleStartStream(
    sessionId: string,
    data: any,
    callback?: Function
  ): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      callback?.({ error: 'Session not found' });
      return;
    }

    try {
      const { taskId, agentId, options = {} } = data;

      if (!taskId) {
        throw new Error('Task ID required for streaming');
      }

      const streamKey = `${taskId}:${agentId || 'main'}`;

      // Create streaming context
      const context: StreamingContext = {
        taskId,
        agentId,
        sessionId,
        startTime: Date.now(),
        chunks: 0,
        bytes: 0
      };

      this.streamContexts.set(streamKey, context);

      // Join stream room
      session.socket.join(`stream:${streamKey}`);

      // Start stream with backpressure handling
      const stream = this.createBackpressureStream(session.socket, streamKey, options);
      session.activeStreams.set(streamKey, stream);

      const response = {
        success: true,
        streamKey,
        taskId,
        timestamp: new Date().toISOString()
      };

      session.socket.emit('stream_started', response);
      callback?.(response);

      logger.info('Stream started', { sessionId, streamKey });
      this.metrics.activeStreams++;

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      logger.error('Stream start failed', { sessionId, error: errorMessage });
      callback?.({ error: errorMessage });
      this.metrics.errors++;
    }
  }

  private async handleStopStream(
    sessionId: string,
    data: any,
    callback?: Function
  ): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      callback?.({ error: 'Session not found' });
      return;
    }

    try {
      const { streamKey } = data;

      if (session.activeStreams.has(streamKey)) {
        const timer = session.activeStreams.get(streamKey);
        if (timer) clearTimeout(timer);

        session.activeStreams.delete(streamKey);
        session.socket.leave(`stream:${streamKey}`);

        // Get and cleanup stream context
        const context = this.streamContexts.get(streamKey);
        if (context) {
          const duration = Date.now() - context.startTime;

          const response = {
            success: true,
            streamKey,
            stats: {
              duration,
              chunks: context.chunks,
              bytes: context.bytes,
              avgChunkSize: context.chunks > 0 ? context.bytes / context.chunks : 0
            },
            timestamp: new Date().toISOString()
          };

          session.socket.emit('stream_stopped', response);
          callback?.(response);

          this.streamContexts.delete(streamKey);
          logger.info('Stream stopped', { sessionId, streamKey, duration });
        }

        this.metrics.activeStreams--;
      } else {
        callback?.({ error: 'Stream not found' });
      }

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      logger.error('Stream stop failed', { sessionId, error: errorMessage });
      callback?.({ error: errorMessage });
      this.metrics.errors++;
    }
  }

  private async handleReconnection(
    socket: Socket,
    data: any,
    callback?: Function
  ): Promise<void> {
    try {
      const { reconnectToken, sessionId: oldSessionId } = data;

      if (!reconnectToken) {
        throw new Error('Reconnect token required');
      }

      // Validate reconnect token
      const storedSessionId = this.reconnectTokens.get(reconnectToken);
      if (!storedSessionId || storedSessionId !== oldSessionId) {
        throw new Error('Invalid reconnect token');
      }

      // Restore session
      const oldSession = this.sessions.get(oldSessionId);
      if (oldSession) {
        // Update socket reference
        oldSession.socket = socket;
        oldSession.lastPing = Date.now();

        // Rejoin rooms
        for (const [key, _] of oldSession.subscriptions) {
          socket.join(key);
        }

        const response = {
          success: true,
          sessionId: oldSessionId,
          subscriptions: Array.from(oldSession.subscriptions.keys()),
          timestamp: new Date().toISOString()
        };

        socket.emit('reconnected', response);
        callback?.(response);

        logger.info('Session reconnected', { sessionId: oldSessionId });
        this.metrics.reconnections++;
      } else {
        // Create new session if old one expired
        const newSessionId = this.createSession(socket);
        callback?.({ success: true, sessionId: newSessionId, newSession: true });
      }

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      logger.error('Reconnection failed', { error: errorMessage });

      // Create new session on reconnection failure
      const newSessionId = this.createSession(socket);
      callback?.({ error: errorMessage, newSessionId });
      this.metrics.errors++;
    }
  }

  private handleStreamConnection(socket: Socket): void {
    socket.on('stream_data', (data) => {
      this.metrics.messagesIn++;
      this.metrics.bytesIn += JSON.stringify(data).length;
    });

    socket.on('stream_control', (data) => {
      logger.debug('Stream control message', data);
    });
  }

  private handleControlConnection(socket: Socket): void {
    socket.on('get_metrics', (callback) => {
      callback(this.getMetrics());
    });

    socket.on('get_sessions', (callback) => {
      const sessions = Array.from(this.sessions.values()).map(s => ({
        id: s.id,
        subscriptions: Array.from(s.subscriptions.keys()),
        activeStreams: Array.from(s.activeStreams.keys()),
        lastPing: s.lastPing,
        metadata: s.metadata
      }));
      callback(sessions);
    });
  }

  private handleError(sessionId: string, error: any): void {
    logger.error('WebSocket error', {
      sessionId,
      error: error instanceof Error ? error.message : String(error)
    });
    this.metrics.errors++;
    this.emit('session_error', sessionId, error);
  }

  private handleDisconnect(_sessionId: string, reason: string): void {
    const sessionId = _sessionId; // Use the parameter
    logger.info('Session disconnected', { sessionId, reason });

    const session = this.sessions.get(sessionId);
    if (session) {
      // Clean up active streams
      for (const [streamKey, timer] of session.activeStreams) {
        if (timer) clearTimeout(timer);
        this.streamContexts.delete(streamKey);
      }

      // Keep session for reconnection (with TTL)
      setTimeout(() => {
        if (this.sessions.get(sessionId)?.socket.disconnected) {
          this.cleanupSession(sessionId);
        }
      }, 300000); // 5 minutes TTL
    }

    this.emit('session_disconnected', sessionId);
  }

  private cleanupSession(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    // Clean up reconnect token
    if (session.reconnectToken) {
      this.reconnectTokens.delete(session.reconnectToken);
    }

    // Clean up active streams
    for (const [_, timer] of session.activeStreams) {
      if (timer) clearTimeout(timer);
    }

    this.sessions.delete(sessionId);
    logger.debug('Session cleaned up', { sessionId });
  }

  private createBackpressureStream(
    socket: Socket,
    streamKey: string,
    options: StreamOptions = {}
  ): any {
    const {
      backpressureThreshold = 100,
      chunkSize = 1024,
      flushInterval = 100
    } = options;

    let buffer: any[] = [];
    let pressure = 0;

    const flush = () => {
      if (buffer.length === 0) return;

      const chunk = buffer.splice(0, chunkSize);
      const context = this.streamContexts.get(streamKey);

      if (context) {
        context.chunks++;
        context.bytes += JSON.stringify(chunk).length;
      }

      socket.emit('stream_chunk', {
        streamKey,
        data: chunk,
        sequence: context?.chunks || 0,
        timestamp: Date.now()
      });

      this.metrics.messagesOut++;
      this.metrics.bytesOut += JSON.stringify(chunk).length;

      pressure = Math.max(0, pressure - chunk.length);
    };

    const timer = setInterval(() => {
      if (pressure < backpressureThreshold) {
        flush();
      }
    }, flushInterval);

    return timer;
  }

  private startMaintenanceTasks(): void {
    // Cleanup inactive sessions
    this.cleanupInterval = setInterval(() => {
      const now = Date.now();
      const timeout = 600000; // 10 minutes

      for (const [sessionId, session] of this.sessions) {
        if (now - session.lastPing > timeout && session.socket.disconnected) {
          this.cleanupSession(sessionId);
        }

        // Cleanup inactive subscriptions
        for (const [key, subscription] of session.subscriptions) {
          if (now - subscription.lastActivity > timeout * 2) {
            session.subscriptions.delete(key);
            session.socket.leave(key);
          }
        }
      }
    }, 60000); // Every minute

    // Send periodic pings
    this.pingInterval = setInterval(() => {
      for (const [_, session] of this.sessions) {
        if (!session.socket.disconnected) {
          session.socket.emit('ping', { timestamp: Date.now() });
        }
      }
    }, 30000); // Every 30 seconds

    // Collect metrics
    this.metricsInterval = setInterval(() => {
      this.emit('metrics', this.getMetrics());
    }, 10000); // Every 10 seconds
  }

  // Public API methods

  async streamToTask(
    taskId: string,
    eventType: string,
    data: any
  ): Promise<void> {
    const room = `task:${taskId}`;
    const message = {
      type: eventType,
      taskId,
      data,
      timestamp: Date.now()
    };

    this.io.to(room).emit(eventType, message);
    this.metrics.messagesOut++;
    this.metrics.bytesOut += JSON.stringify(message).length;
  }

  async streamToAgent(
    agentId: string,
    eventType: string,
    data: any
  ): Promise<void> {
    const room = `agent:${agentId}`;
    const message = {
      type: eventType,
      agentId,
      data,
      timestamp: Date.now()
    };

    this.io.to(room).emit(eventType, message);
    this.metrics.messagesOut++;
    this.metrics.bytesOut += JSON.stringify(message).length;
  }

  async broadcast(eventType: string, data: any): Promise<void> {
    const message = {
      type: eventType,
      data,
      timestamp: Date.now()
    };

    this.io.emit(eventType, message);
    this.metrics.messagesOut += this.sessions.size;
    this.metrics.bytesOut += JSON.stringify(message).length * this.sessions.size;
  }

  createStreamTransform(taskId: string): Transform {
    return new Transform({
      objectMode: true,
      transform: (chunk, _encoding, callback) => {
        this.streamToTask(taskId, 'stream_chunk', chunk);
        callback(null, chunk);
      }
    });
  }

  getMetrics(): any {
    return {
      ...this.metrics,
      activeSessions: this.sessions.size,
      totalSubscriptions: Array.from(this.sessions.values())
        .reduce((sum, s) => sum + s.subscriptions.size, 0),
      activeStreamContexts: this.streamContexts.size,
      uptime: process.uptime(),
      memory: process.memoryUsage()
    };
  }

  getHealthStatus(): any {
    const metrics = this.getMetrics();
    return {
      healthy: true,
      activeSessions: metrics.activeSessions,
      activeStreams: metrics.activeStreams,
      totalSubscriptions: metrics.totalSubscriptions,
      errorRate: metrics.messagesIn > 0 ? metrics.errors / metrics.messagesIn : 0,
      uptime: metrics.uptime
    };
  }

  async shutdown(): Promise<void> {
    logger.info('Shutting down WebSocket Manager');

    // PHASE 4 FIX: Clean up intervals
    if (this.cleanupInterval) clearInterval(this.cleanupInterval);
    if (this.pingInterval) clearInterval(this.pingInterval);
    if (this.metricsInterval) clearInterval(this.metricsInterval);

    // PHASE 4 FIX: Clean up all session timers before clearing sessions
    for (const [_sessionId, session] of this.sessions) {
      // Clear all active stream timers for this session
      for (const [_streamKey, timer] of session.activeStreams) {
        if (timer) clearTimeout(timer);
      }
      session.activeStreams.clear();

      // Notify and disconnect client gracefully
      session.socket.emit('server_shutdown', {
        message: 'Server is shutting down',
        timestamp: Date.now()
      });
      session.socket.disconnect(true);
    }

    // Clear data structures
    this.sessions.clear();
    this.reconnectTokens.clear();
    this.streamContexts.clear();
    this.namespaces.clear();

    // PHASE 4 FIX: Remove all EventEmitter listeners to prevent memory leaks
    this.removeAllListeners();

    // Close Socket.IO server
    await new Promise<void>((resolve) => {
      this.io.close(() => {
        logger.info('WebSocket server closed', {
          intervalsCleared: true,
          sessionsCleared: true,
          listenersRemoved: true
        });
        resolve();
      });
    });
  }
}

// Export singleton management
let enhancedManagerInstance: EnhancedWebSocketManager | null = null;

export function initializeEnhancedWebSocketManager(server: HTTPServer): EnhancedWebSocketManager {
  if (!enhancedManagerInstance) {
    enhancedManagerInstance = new EnhancedWebSocketManager(server);
  }
  return enhancedManagerInstance;
}

export function getEnhancedWebSocketManager(): EnhancedWebSocketManager {
  if (!enhancedManagerInstance) {
    throw new Error('Enhanced WebSocket Manager not initialized');
  }
  return enhancedManagerInstance;
}