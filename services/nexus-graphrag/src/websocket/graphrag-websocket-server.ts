/**
 * GraphRAG WebSocket Server - Real-time Memory and RAG Operations
 * This WebSocket server belongs in GraphRAG, not MageAgent
 */

import { Server as SocketIOServer, Socket } from 'socket.io';
import { Server as HTTPServer } from 'http';
import { EventEmitter } from 'events';
import { logger } from '../utils/logger';
import { v4 as uuidv4 } from 'uuid';

export interface GraphRAGSession {
  id: string;
  socket: Socket;
  subscriptions: Set<string>;
  createdAt: Date;
  metadata: Record<string, any>;
}

export interface MemoryUpdate {
  type: 'create' | 'update' | 'delete' | 'recall';
  memoryId?: string;
  content?: any;
  timestamp: Date;
}

export interface DocumentUpdate {
  type: 'indexed' | 'updated' | 'deleted' | 'searched';
  documentId?: string;
  content?: any;
  timestamp: Date;
}

export class GraphRAGWebSocketServer extends EventEmitter {
  private io: SocketIOServer;
  private sessions: Map<string, GraphRAGSession> = new Map();

  // Namespaces for different GraphRAG operations
  private graphragNamespace: any;
  private memoryNamespace: any;
  private documentNamespace: any;
  private searchNamespace: any;

  constructor(server: HTTPServer) {
    super();

    // Initialize Socket.IO with GraphRAG-specific configuration
    this.io = new SocketIOServer(server, {
      path: '/graphrag/socket.io',
      cors: {
        origin: process.env.CORS_ORIGIN || '*',
        methods: ['GET', 'POST'],
        credentials: true
      },
      transports: ['websocket', 'polling'],
      pingTimeout: 60000,
      pingInterval: 25000
    });

    logger.info('GraphRAG WebSocket server created');
  }

  /**
   * Start the WebSocket server and setup handlers
   */
  public start(): void {
    try {
      this.setupNamespaces();
      this.setupMainHandlers();

      logger.info('GraphRAG WebSocket server started successfully', {
        namespaces: [
          '/graphrag',
          '/graphrag/memory',
          '/graphrag/documents',
          '/graphrag/search'
        ],
        path: '/graphrag/socket.io',
        transports: ['websocket', 'polling']
      });

      this.emit('started');
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      logger.error('Failed to start GraphRAG WebSocket server', {
        error: errorMessage,
        stack: error instanceof Error ? error.stack : undefined
      });

      throw new Error(
        'GraphRAG WebSocket Server Startup Failed:\n' +
        `Error: ${errorMessage}\n` +
        'This prevents real-time updates from functioning.\n' +
        'Check that port 8090 is available and not blocked.'
      );
    }
  }

  /**
   * Get WebSocket server statistics
   */
  public getStats(): any {
    const rooms = this.io.of('/graphrag').adapter.rooms;
    const sockets = this.io.of('/graphrag').sockets;

    return {
      sessions: this.sessions.size,
      connections: sockets.size,
      rooms: rooms.size,
      namespaces: {
        main: this.graphragNamespace?.sockets.size || 0,
        memory: this.memoryNamespace?.sockets.size || 0,
        documents: this.documentNamespace?.sockets.size || 0,
        search: this.searchNamespace?.sockets.size || 0
      },
      uptime: process.uptime(),
      timestamp: new Date().toISOString()
    };
  }

  private setupNamespaces(): void {
    // Main GraphRAG namespace for general operations
    this.graphragNamespace = this.io.of('/graphrag');

    // Memory operations namespace
    this.memoryNamespace = this.io.of('/graphrag/memory');

    // Document operations namespace
    this.documentNamespace = this.io.of('/graphrag/documents');

    // Search operations namespace
    this.searchNamespace = this.io.of('/graphrag/search');

    // Setup handlers for each namespace
    this.setupMemoryHandlers();
    this.setupDocumentHandlers();
    this.setupSearchHandlers();
  }

  private setupMainHandlers(): void {
    this.graphragNamespace.on('connection', (socket: Socket) => {
      const sessionId = uuidv4();

      logger.info('GraphRAG client connected', {
        sessionId,
        socketId: socket.id
      });

      // Create session
      const session: GraphRAGSession = {
        id: sessionId,
        socket,
        subscriptions: new Set(),
        createdAt: new Date(),
        metadata: {
          address: socket.handshake.address,
          headers: socket.handshake.headers
        }
      };

      this.sessions.set(sessionId, session);

      // Send welcome with GraphRAG capabilities
      socket.emit('welcome', {
        sessionId,
        service: 'GraphRAG',
        version: '1.0.0',
        capabilities: {
          memory: true,
          documents: true,
          search: true,
          episodes: true,
          entities: true,
          relationships: true
        },
        namespaces: {
          main: '/graphrag',
          memory: '/graphrag/memory',
          documents: '/graphrag/documents',
          search: '/graphrag/search'
        },
        timestamp: new Date().toISOString()
      });

      // Handle GraphRAG-specific operations
      socket.on('memory:store', (data, callback) =>
        this.handleMemoryStore(sessionId, data, callback));

      socket.on('memory:recall', (data, callback) =>
        this.handleMemoryRecall(sessionId, data, callback));

      socket.on('document:store', (data, callback) =>
        this.handleDocumentStore(sessionId, data, callback));

      socket.on('search:execute', (data, callback) =>
        this.handleSearch(sessionId, data, callback));

      socket.on('subscribe:memory', (data, callback) =>
        this.handleMemorySubscription(sessionId, data, callback));

      socket.on('subscribe:documents', (data, callback) =>
        this.handleDocumentSubscription(sessionId, data, callback));

      // Handle task streaming subscriptions (for MageAgent task progress)
      socket.on('subscribe:task', (taskId, callback) => {
        if (!taskId) {
          if (callback) callback({ success: false, error: 'Task ID required' });
          return;
        }

        const room = `task:${taskId}`;
        socket.join(room);
        session.subscriptions.add(room);

        logger.info('Client subscribed to task', {
          sessionId,
          taskId,
          room
        });

        if (callback) {
          callback({
            success: true,
            taskId,
            room,
            message: 'Subscribed to task progress updates'
          });
        }
      });

      socket.on('unsubscribe:task', (taskId, callback) => {
        if (!taskId) {
          if (callback) callback({ success: false, error: 'Task ID required' });
          return;
        }

        const room = `task:${taskId}`;
        socket.leave(room);
        session.subscriptions.delete(room);

        logger.info('Client unsubscribed from task', {
          sessionId,
          taskId,
          room
        });

        if (callback) {
          callback({
            success: true,
            taskId,
            room,
            message: 'Unsubscribed from task progress updates'
          });
        }
      });

      // Handle ping for health checks
      socket.on('ping', (callback) => {
        if (callback) callback('pong');
      });

      // Handle disconnection
      socket.on('disconnect', (reason) => {
        logger.info('GraphRAG client disconnected', { sessionId, reason });
        this.cleanupSession(sessionId);
      });

      // Error handling
      socket.on('error', (error) => {
        logger.error('GraphRAG WebSocket error', { sessionId, error });
        this.emit('client:error', { sessionId, error });
      });
    });
  }

  private setupMemoryHandlers(): void {
    this.memoryNamespace.on('connection', (socket: Socket) => {
      logger.info('Memory namespace connection', { socketId: socket.id });

      socket.on('store', async (_data, callback) => {
        try {
          // This would call the actual memory storage service
          const result = await this.storeMemory(_data);
          callback({ success: true, result });

          // Broadcast update to subscribers
          this.broadcastMemoryUpdate({
            type: 'create',
            memoryId: result.id,
            content: _data,
            timestamp: new Date()
          });
        } catch (error) {
          callback({ success: false, error: error instanceof Error ? error.message : 'Unknown error' });
        }
      });

      socket.on('recall', async (_data, callback) => {
        try {
          // This would call the actual memory recall service
          const memories = await this.recallMemories(_data);
          callback({ success: true, memories });
        } catch (error) {
          callback({ success: false, error: error instanceof Error ? error.message : 'Unknown error' });
        }
      });

      socket.on('stream:updates', (_data) => {
        socket.join('memory:updates');
        socket.emit('subscribed', { room: 'memory:updates' });
      });
    });
  }

  private setupDocumentHandlers(): void {
    this.documentNamespace.on('connection', (socket: Socket) => {
      logger.info('Document namespace connection', { socketId: socket.id });

      socket.on('index', async (_data, callback) => {
        try {
          // This would call the actual document indexing service
          const result = await this.indexDocument(_data);
          callback({ success: true, result });

          // Broadcast update
          this.broadcastDocumentUpdate({
            type: 'indexed',
            documentId: result.id,
            content: _data,
            timestamp: new Date()
          });
        } catch (error) {
          callback({ success: false, error: error instanceof Error ? error.message : 'Unknown error' });
        }
      });

      socket.on('retrieve', async (_data, callback) => {
        try {
          const documents = await this.retrieveDocuments(_data);
          callback({ success: true, documents });
        } catch (error) {
          callback({ success: false, error: error instanceof Error ? error.message : 'Unknown error' });
        }
      });

      socket.on('stream:updates', (_data) => {
        socket.join('document:updates');
        socket.emit('subscribed', { room: 'document:updates' });
      });
    });
  }

  private setupSearchHandlers(): void {
    this.searchNamespace.on('connection', (socket: Socket) => {
      logger.info('Search namespace connection', { socketId: socket.id });

      socket.on('query', async (_data, callback) => {
        try {
          // Stream search results as they come in
          const searchId = uuidv4();

          socket.emit('search:started', { searchId });

          // This would call the actual search service
          const results = await this.executeSearch(_data);

          // Stream results in chunks
          for (const chunk of this.chunkResults(results, 10)) {
            socket.emit('search:chunk', {
              searchId,
              chunk,
              timestamp: new Date()
            });
          }

          socket.emit('search:complete', { searchId });
          callback({ success: true, searchId, total: results.length });
        } catch (error) {
          callback({ success: false, error: error instanceof Error ? error.message : 'Unknown error' });
        }
      });

      socket.on('stream:results', (data) => {
        socket.join(`search:${data.searchId}`);
        socket.emit('subscribed', { room: `search:${data.searchId}` });
      });
    });
  }

  // Handler methods
  private async handleMemoryStore(
    sessionId: string,
    data: any,
    callback?: Function
  ): Promise<void> {
    try {
      const session = this.sessions.get(sessionId);
      if (!session) {
        callback?.({ error: 'Session not found' });
        return;
      }

      // Store memory (this would integrate with actual storage)
      const result = await this.storeMemory(data);

      callback?.({ success: true, memoryId: result.id });

      // Emit to subscribers
      this.emit('memory:stored', result);
    } catch (error) {
      logger.error('Failed to store memory', { sessionId, error });
      callback?.({ error: error instanceof Error ? error.message : 'Unknown error' });
    }
  }

  private async handleMemoryRecall(
    sessionId: string,
    data: any,
    callback?: Function
  ): Promise<void> {
    try {
      const session = this.sessions.get(sessionId);
      if (!session) {
        callback?.({ error: 'Session not found' });
        return;
      }

      // Recall memories
      const memories = await this.recallMemories(data);

      callback?.({ success: true, memories });

      // Track recall for analytics
      this.emit('memory:recalled', { sessionId, query: data.query });
    } catch (error) {
      logger.error('Failed to recall memory', { sessionId, error });
      callback?.({ error: error instanceof Error ? error.message : 'Unknown error' });
    }
  }

  private async handleDocumentStore(
    sessionId: string,
    data: any,
    callback?: Function
  ): Promise<void> {
    try {
      const session = this.sessions.get(sessionId);
      if (!session) {
        callback?.({ error: 'Session not found' });
        return;
      }

      // Store document
      const result = await this.indexDocument(data);

      callback?.({ success: true, documentId: result.id });

      // Emit to subscribers
      this.emit('document:stored', result);
    } catch (error) {
      logger.error('Failed to store document', { sessionId, error });
      callback?.({ error: error instanceof Error ? error.message : 'Unknown error' });
    }
  }

  private async handleSearch(
    sessionId: string,
    data: any,
    callback?: Function
  ): Promise<void> {
    try {
      const session = this.sessions.get(sessionId);
      if (!session) {
        callback?.({ error: 'Session not found' });
        return;
      }

      // Execute search
      const results = await this.executeSearch(data);

      callback?.({ success: true, results });

      // Track search for analytics
      this.emit('search:executed', { sessionId, query: data.query });
    } catch (error) {
      logger.error('Search failed', { sessionId, error });
      callback?.({ error: error instanceof Error ? error.message : 'Unknown error' });
    }
  }

  private async handleMemorySubscription(
    sessionId: string,
    data: any,
    callback?: Function
  ): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      callback?.({ error: 'Session not found' });
      return;
    }

    const subscriptionKey = `memory:${data.type || 'all'}`;
    session.subscriptions.add(subscriptionKey);
    session.socket.join(subscriptionKey);

    callback?.({
      success: true,
      subscription: subscriptionKey,
      timestamp: new Date().toISOString()
    });
  }

  private async handleDocumentSubscription(
    sessionId: string,
    data: any,
    callback?: Function
  ): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      callback?.({ error: 'Session not found' });
      return;
    }

    const subscriptionKey = `document:${data.type || 'all'}`;
    session.subscriptions.add(subscriptionKey);
    session.socket.join(subscriptionKey);

    callback?.({
      success: true,
      subscription: subscriptionKey,
      timestamp: new Date().toISOString()
    });
  }

  // Broadcast methods
  broadcastMemoryUpdate(update: MemoryUpdate): void {
    this.memoryNamespace.to('memory:updates').emit('memory:update', update);
    this.graphragNamespace.emit('memory:update', update);
  }

  broadcastDocumentUpdate(update: DocumentUpdate): void {
    this.documentNamespace.to('document:updates').emit('document:update', update);
    this.graphragNamespace.emit('document:update', update);
  }

  broadcastSearchResult(searchId: string, result: any): void {
    this.searchNamespace.to(`search:${searchId}`).emit('search:result', result);
  }

  /**
   * Public method to emit events to specific rooms
   * Used by external services (MageAgent TaskManager) to broadcast task progress
   *
   * @param room - The room to emit to (e.g., 'task:abc-123')
   * @param event - The event name (e.g., 'task:abc-123')
   * @param data - The event payload
   */
  public emitToRoom(room: string, event: string, data: any): void {
    try {
      // Emit to main GraphRAG namespace
      this.graphragNamespace.to(room).emit(event, data);

      logger.debug('Emitted event to room', {
        room,
        event,
        dataKeys: Object.keys(data),
        timestamp: new Date().toISOString()
      });
    } catch (error) {
      logger.error('Failed to emit to room', {
        room,
        event,
        error: error instanceof Error ? error.message : 'Unknown error'
      });
      throw error;
    }
  }

  /**
   * Get list of rooms with active subscribers
   */
  public getActiveRooms(): string[] {
    const rooms = Array.from(this.graphragNamespace.adapter.rooms.keys()) as string[];
    // Filter out socket IDs (rooms that are just socket IDs)
    return rooms.filter(room => !room.startsWith('socket:') && room.length > 20);
  }

  /**
   * Get number of subscribers in a room
   */
  public getRoomSubscriberCount(room: string): number {
    const roomSockets = this.graphragNamespace.adapter.rooms.get(room);
    return roomSockets ? roomSockets.size : 0;
  }

  // Placeholder service methods (would connect to actual services)
  private async storeMemory(_data: any): Promise<any> {
    // This would integrate with the actual memory storage service
    return { id: uuidv4(), ..._data };
  }

  private async recallMemories(_data: any): Promise<any[]> {
    // This would integrate with the actual memory recall service
    return [];
  }

  private async indexDocument(_data: any): Promise<any> {
    // This would integrate with the actual document service
    return { id: uuidv4(), ..._data };
  }

  private async retrieveDocuments(_data: any): Promise<any[]> {
    // This would integrate with the actual document retrieval service
    return [];
  }

  private async executeSearch(_data: any): Promise<any[]> {
    // This would integrate with the actual search service
    return [];
  }

  private *chunkResults(results: any[], chunkSize: number): Generator<any[]> {
    for (let i = 0; i < results.length; i += chunkSize) {
      yield results.slice(i, i + chunkSize);
    }
  }

  // Cleanup
  private cleanupSession(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    // Leave all rooms
    for (const subscription of session.subscriptions) {
      session.socket.leave(subscription);
    }

    this.sessions.delete(sessionId);
    this.emit('session:cleanup', sessionId);
  }

  // Metrics
  getMetrics(): any {
    return {
      activeSessions: this.sessions.size,
      namespaces: {
        main: this.graphragNamespace.sockets.size,
        memory: this.memoryNamespace.sockets.size,
        documents: this.documentNamespace.sockets.size,
        search: this.searchNamespace.sockets.size
      },
      timestamp: new Date().toISOString()
    };
  }

  async shutdown(): Promise<void> {
    logger.info('Shutting down GraphRAG WebSocket server');

    // Notify all clients
    this.graphragNamespace.emit('server:shutdown', {
      message: 'Server is shutting down',
      timestamp: new Date().toISOString()
    });

    // Close all connections
    await this.io.close();

    this.sessions.clear();
    logger.info('GraphRAG WebSocket server shut down');
  }
}

// Export singleton management
let graphragWebSocketServer: GraphRAGWebSocketServer | null = null;

export function initializeGraphRAGWebSocket(server: HTTPServer): GraphRAGWebSocketServer {
  if (!graphragWebSocketServer) {
    graphragWebSocketServer = new GraphRAGWebSocketServer(server);
  }
  return graphragWebSocketServer;
}

export function getGraphRAGWebSocket(): GraphRAGWebSocketServer {
  if (!graphragWebSocketServer) {
    throw new Error('GraphRAG WebSocket server not initialized');
  }
  return graphragWebSocketServer;
}