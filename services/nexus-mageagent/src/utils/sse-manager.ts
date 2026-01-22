import { Response } from 'express';
import { EventEmitter } from 'events';
import { logger } from './logger';

export interface SSEConnection {
  id: string;
  res: Response;
  lastActivity: Date;
  keepaliveInterval?: NodeJS.Timeout;
}

/**
 * SSE Manager - Handles Server-Sent Events connections with keepalive and cleanup
 *
 * Features:
 * - Automatic keepalive pings every 15 seconds
 * - Connection timeout after 5 minutes of inactivity
 * - Graceful cleanup on connection close
 * - Broadcast capabilities
 * - Connection metrics
 */
export class SSEManager extends EventEmitter {
  private connections: Map<string, SSEConnection> = new Map();
  private keepaliveInterval = 15000; // 15 seconds
  private connectionTimeout = 300000; // 5 minutes

  /**
   * Initialize SSE connection with keepalive
   */
  initializeSSE(connectionId: string, res: Response): void {
    // Set SSE headers
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no'); // Disable nginx buffering

    // Send initial connection event
    this.sendSSE(res, 'connected', {
      connectionId,
      timestamp: new Date().toISOString(),
      keepaliveInterval: this.keepaliveInterval
    });

    // Setup keepalive pings
    const keepaliveTimer = setInterval(() => {
      this.sendSSE(res, 'keepalive', { timestamp: new Date().toISOString() });
    }, this.keepaliveInterval);

    // Store connection
    const connection: SSEConnection = {
      id: connectionId,
      res,
      lastActivity: new Date(),
      keepaliveInterval: keepaliveTimer
    };
    this.connections.set(connectionId, connection);

    // Cleanup on connection close
    res.on('close', () => {
      this.closeConnection(connectionId);
    });

    // Timeout inactive connections
    this.setupConnectionTimeout(connectionId);

    logger.info('SSE connection initialized', { connectionId });
  }

  /**
   * Send SSE event
   */
  sendSSE(res: Response, event: string, data: any): boolean {
    try {
      const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
      return res.write(payload);
    } catch (error) {
      logger.error('Failed to send SSE event', {
        event,
        error: error instanceof Error ? error.message : String(error)
      });
      return false;
    }
  }

  /**
   * Send event to specific connection
   */
  sendToConnection(connectionId: string, event: string, data: any): boolean {
    const connection = this.connections.get(connectionId);
    if (!connection) {
      logger.warn('SSE connection not found', { connectionId });
      return false;
    }

    connection.lastActivity = new Date();
    return this.sendSSE(connection.res, event, data);
  }

  /**
   * Broadcast to all connections
   */
  broadcast(event: string, data: any): void {
    for (const [_connectionId, connection] of this.connections) {
      this.sendSSE(connection.res, event, data);
    }
  }

  /**
   * Close and cleanup connection
   */
  closeConnection(connectionId: string): void {
    const connection = this.connections.get(connectionId);
    if (!connection) return;

    // Clear keepalive interval
    if (connection.keepaliveInterval) {
      clearInterval(connection.keepaliveInterval);
    }

    // End response
    try {
      connection.res.end();
    } catch (error) {
      // Connection already closed
    }

    // Remove from map
    this.connections.delete(connectionId);

    logger.info('SSE connection closed', { connectionId });
    this.emit('connectionClosed', connectionId);
  }

  /**
   * Setup automatic timeout for inactive connections
   */
  private setupConnectionTimeout(connectionId: string): void {
    const checkInterval = setInterval(() => {
      const connection = this.connections.get(connectionId);
      if (!connection) {
        clearInterval(checkInterval);
        return;
      }

      const inactiveTime = Date.now() - connection.lastActivity.getTime();
      if (inactiveTime > this.connectionTimeout) {
        logger.warn('SSE connection timed out due to inactivity', {
          connectionId,
          inactiveTimeMs: inactiveTime
        });
        this.closeConnection(connectionId);
        clearInterval(checkInterval);
      }
    }, 60000); // Check every minute
  }

  /**
   * Get connection metrics
   */
  getMetrics() {
    return {
      activeConnections: this.connections.size,
      connections: Array.from(this.connections.values()).map(conn => ({
        id: conn.id,
        lastActivity: conn.lastActivity,
        durationMs: Date.now() - conn.lastActivity.getTime()
      }))
    };
  }

  /**
   * Cleanup all connections (for graceful shutdown)
   */
  async cleanup(): Promise<void> {
    logger.info('Closing all SSE connections', {
      count: this.connections.size
    });

    for (const [connectionId] of this.connections) {
      this.closeConnection(connectionId);
    }

    this.removeAllListeners();
  }
}

// Singleton
let sseManagerInstance: SSEManager | null = null;

export function getSSEManager(): SSEManager {
  if (!sseManagerInstance) {
    sseManagerInstance = new SSEManager();
  }
  return sseManagerInstance;
}
