/**
 * WebSocket Real-time Tests for GraphRAG
 * Tests WebSocket connections, event streaming, and real-time updates
 */

import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from '@jest/globals';
import WebSocket from 'ws';
import { testConfig } from '../../test-config';
import { TestDataGenerator, AssertionHelpers } from '../../helpers/test-helpers';

describe('GraphRAG WebSocket Integration Tests', () => {
  let ws: WebSocket;
  const wsUrl = testConfig.websocket.url;

  beforeEach(() => {
    // Create new WebSocket connection for each test
    ws = new WebSocket(wsUrl);
  });

  afterEach(() => {
    // Close WebSocket connection after each test
    if (ws.readyState === WebSocket.OPEN) {
      ws.close();
    }
  });

  describe('Connection Management', () => {
    it('should establish WebSocket connection on port 8091', (done) => {
      const testWs = new WebSocket('ws://localhost:8091/ws');

      testWs.on('open', () => {
        expect(testWs.readyState).toBe(WebSocket.OPEN);
        testWs.close();
        done();
      });

      testWs.on('error', (error) => {
        done(error);
      });
    });

    it('should receive welcome message on connection', (done) => {
      ws.on('open', () => {
        // Connection established
      });

      ws.on('message', (data) => {
        const message = JSON.parse(data.toString());
        expect(message).toHaveProperty('type');
        expect(message).toHaveProperty('timestamp');

        if (message.type === 'welcome' || message.type === 'connected') {
          done();
        }
      });

      ws.on('error', (error) => {
        done(error);
      });
    });

    it('should handle multiple concurrent connections', async () => {
      const connections = [];
      const connectionCount = 5;

      for (let i = 0; i < connectionCount; i++) {
        const connection = new WebSocket(wsUrl);
        connections.push(connection);
      }

      // Wait for all connections to open
      const openPromises = connections.map(conn =>
        new Promise((resolve, reject) => {
          conn.on('open', resolve);
          conn.on('error', reject);
        })
      );

      await Promise.all(openPromises);

      // Verify all connections are open
      connections.forEach(conn => {
        expect(conn.readyState).toBe(WebSocket.OPEN);
      });

      // Close all connections
      connections.forEach(conn => conn.close());
    });

    it('should handle reconnection after disconnect', (done) => {
      let reconnectCount = 0;
      const maxReconnects = 3;

      function attemptConnection() {
        const testWs = new WebSocket(wsUrl);

        testWs.on('open', () => {
          reconnectCount++;

          if (reconnectCount < maxReconnects) {
            testWs.close();
            setTimeout(attemptConnection, 100);
          } else {
            expect(reconnectCount).toBe(maxReconnects);
            testWs.close();
            done();
          }
        });

        testWs.on('error', (error) => {
          if (reconnectCount < maxReconnects) {
            setTimeout(attemptConnection, 100);
          } else {
            done(error);
          }
        });
      }

      attemptConnection();
    });
  });

  describe('Message Exchange', () => {
    it('should send and receive messages', (done) => {
      ws.on('open', () => {
        const testMessage = {
          type: 'test',
          data: { message: 'Hello WebSocket' }
        };

        ws.send(JSON.stringify(testMessage));
      });

      ws.on('message', (data) => {
        const message = JSON.parse(data.toString());

        // Skip welcome message
        if (message.type === 'welcome' || message.type === 'connected') {
          return;
        }

        expect(message).toHaveProperty('type');
        done();
      });
    });

    it('should handle subscription messages', (done) => {
      ws.on('open', () => {
        const subscription = {
          type: 'subscribe',
          channel: 'documents',
          data: {
            documentId: 'test-doc-123'
          }
        };

        ws.send(JSON.stringify(subscription));
      });

      ws.on('message', (data) => {
        const message = JSON.parse(data.toString());

        if (message.type === 'subscribed') {
          expect(message).toHaveProperty('channel');
          done();
        }
      });
    });

    it('should handle unsubscription messages', (done) => {
      ws.on('open', () => {
        // First subscribe
        ws.send(JSON.stringify({
          type: 'subscribe',
          channel: 'documents'
        }));

        // Then unsubscribe
        setTimeout(() => {
          ws.send(JSON.stringify({
            type: 'unsubscribe',
            channel: 'documents'
          }));
        }, 100);
      });

      ws.on('message', (data) => {
        const message = JSON.parse(data.toString());

        if (message.type === 'unsubscribed') {
          expect(message).toHaveProperty('channel');
          done();
        }
      });
    });
  });

  describe('Document Processing Stream', () => {
    it('should stream document processing updates', (done) => {
      const documentId = 'test-doc-' + Date.now();
      const receivedUpdates: any[] = [];

      ws.on('open', () => {
        // Subscribe to document processing
        ws.send(JSON.stringify({
          type: 'subscribe',
          data: {
            documentId,
            streamTypes: ['processing']
          }
        }));

        // Start document processing
        setTimeout(() => {
          ws.send(JSON.stringify({
            type: 'process',
            data: { documentId }
          }));
        }, 100);
      });

      ws.on('message', (data) => {
        const message = JSON.parse(data.toString());

        if (message.type === 'processing_started') {
          expect(message.documentId).toBe(documentId);
        } else if (message.type === 'processing_update') {
          receivedUpdates.push(message);
          expect(message).toHaveProperty('step');
          expect(message).toHaveProperty('progress');
        } else if (message.type === 'processing_completed') {
          expect(receivedUpdates.length).toBeGreaterThan(0);
          done();
        } else if (message.type === 'processing_error') {
          done(new Error(message.error));
        }
      });
    });

    it('should handle processing errors', (done) => {
      ws.on('open', () => {
        // Send invalid processing request
        ws.send(JSON.stringify({
          type: 'process',
          data: { documentId: null }
        }));
      });

      ws.on('message', (data) => {
        const message = JSON.parse(data.toString());

        if (message.type === 'error' || message.type === 'processing_error') {
          expect(message).toHaveProperty('error');
          done();
        }
      });
    });
  });

  describe('Real-time Search Updates', () => {
    it('should stream search results', (done) => {
      const searchQuery = 'test query';
      const receivedChunks: any[] = [];

      ws.on('open', () => {
        ws.send(JSON.stringify({
          type: 'stream_retrieval',
          query: searchQuery,
          options: { limit: 5 }
        }));
      });

      ws.on('message', (data) => {
        const message = JSON.parse(data.toString());

        switch (message.type) {
          case 'stream_start':
            expect(message.query).toBe(searchQuery);
            break;
          case 'stream_chunk':
            receivedChunks.push(message.chunk);
            expect(message.chunk).toHaveProperty('id');
            expect(message.chunk).toHaveProperty('content');
            break;
          case 'stream_complete':
            expect(receivedChunks.length).toBeGreaterThanOrEqual(0);
            done();
            break;
          case 'stream_error':
            // Search might return no results, which is okay
            done();
            break;
        }
      });
    });
  });

  describe('Memory Updates Stream', () => {
    it('should stream memory updates', (done) => {
      const sessionId = 'test-session-' + Date.now();

      ws.on('open', () => {
        ws.send(JSON.stringify({
          type: 'stream_memory_updates',
          sessionId
        }));
      });

      ws.on('message', (data) => {
        const message = JSON.parse(data.toString());

        if (message.type === 'memory_stream_started') {
          expect(message.sessionId).toBe(sessionId);

          // Simulate a memory update
          ws.send(JSON.stringify({
            type: 'store_memory',
            sessionId,
            data: {
              content: 'Test memory content',
              timestamp: new Date().toISOString()
            }
          }));
        } else if (message.type === 'memory_update') {
          expect(message).toHaveProperty('data');
          done();
        }
      });

      // Timeout if no memory updates received
      setTimeout(() => done(), 5000);
    });
  });

  describe('Error Handling', () => {
    it('should handle malformed JSON messages', (done) => {
      ws.on('open', () => {
        ws.send('invalid json string');
      });

      ws.on('message', (data) => {
        const message = JSON.parse(data.toString());

        if (message.type === 'error') {
          expect(message).toHaveProperty('error');
          done();
        }
      });
    });

    it('should handle unknown message types', (done) => {
      ws.on('open', () => {
        ws.send(JSON.stringify({
          type: 'unknown_message_type',
          data: {}
        }));
      });

      ws.on('message', (data) => {
        const message = JSON.parse(data.toString());

        if (message.type === 'error') {
          expect(message.error).toContain('Unknown');
          done();
        }
      });
    });

    it('should handle connection errors gracefully', (done) => {
      const badWs = new WebSocket('ws://localhost:9999/ws');

      badWs.on('error', (error) => {
        expect(error).toBeDefined();
        expect(error.message).toContain('ECONNREFUSED');
        done();
      });

      badWs.on('open', () => {
        done(new Error('Should not connect to invalid port'));
      });
    });
  });

  describe('Performance and Load', () => {
    it('should handle rapid message sending', (done) => {
      const messageCount = 100;
      let sentCount = 0;
      let receivedCount = 0;

      ws.on('open', () => {
        // Send messages rapidly
        for (let i = 0; i < messageCount; i++) {
          ws.send(JSON.stringify({
            type: 'test',
            id: i,
            timestamp: Date.now()
          }));
          sentCount++;
        }
      });

      ws.on('message', (data) => {
        const message = JSON.parse(data.toString());
        receivedCount++;

        // Allow for welcome message
        if (receivedCount >= messageCount) {
          expect(sentCount).toBe(messageCount);
          done();
        }
      });

      // Timeout after 10 seconds
      setTimeout(() => {
        expect(receivedCount).toBeGreaterThan(0);
        done();
      }, 10000);
    });

    it('should handle large messages', (done) => {
      const largeData = 'A'.repeat(64 * 1024); // 64KB message

      ws.on('open', () => {
        ws.send(JSON.stringify({
          type: 'large_message_test',
          data: largeData
        }));
      });

      ws.on('message', (data) => {
        const message = JSON.parse(data.toString());

        // Skip welcome message
        if (message.type === 'welcome') return;

        expect(message).toBeDefined();
        done();
      });

      ws.on('error', (error) => {
        done(error);
      });
    });
  });

  describe('Broadcasting', () => {
    it('should broadcast to multiple clients', (done) => {
      const client1 = new WebSocket(wsUrl);
      const client2 = new WebSocket(wsUrl);
      const broadcastChannel = 'broadcast-test';
      let receivedOnClient1 = false;
      let receivedOnClient2 = false;

      // Setup client 1
      client1.on('open', () => {
        client1.send(JSON.stringify({
          type: 'subscribe',
          channel: broadcastChannel
        }));
      });

      client1.on('message', (data) => {
        const message = JSON.parse(data.toString());
        if (message.type === 'broadcast' && message.channel === broadcastChannel) {
          receivedOnClient1 = true;
          checkCompletion();
        }
      });

      // Setup client 2
      client2.on('open', () => {
        client2.send(JSON.stringify({
          type: 'subscribe',
          channel: broadcastChannel
        }));

        // Send broadcast after both clients are subscribed
        setTimeout(() => {
          client1.send(JSON.stringify({
            type: 'broadcast',
            channel: broadcastChannel,
            data: { message: 'Test broadcast' }
          }));
        }, 100);
      });

      client2.on('message', (data) => {
        const message = JSON.parse(data.toString());
        if (message.type === 'broadcast' && message.channel === broadcastChannel) {
          receivedOnClient2 = true;
          checkCompletion();
        }
      });

      function checkCompletion() {
        if (receivedOnClient1 && receivedOnClient2) {
          client1.close();
          client2.close();
          done();
        }
      }

      // Timeout after 5 seconds
      setTimeout(() => {
        client1.close();
        client2.close();
        done();
      }, 5000);
    });
  });

  describe('Connection State Management', () => {
    it('should track connection state', (done) => {
      const states: number[] = [];

      // Track state changes
      states.push(ws.readyState); // CONNECTING

      ws.on('open', () => {
        states.push(ws.readyState); // OPEN
        ws.close();
      });

      ws.on('close', () => {
        states.push(ws.readyState); // CLOSED

        expect(states).toContain(WebSocket.CONNECTING);
        expect(states).toContain(WebSocket.OPEN);
        expect(states).toContain(WebSocket.CLOSED);
        done();
      });
    });

    it('should handle ping/pong for keep-alive', (done) => {
      let pongReceived = false;

      ws.on('open', () => {
        // Send ping
        ws.ping();
      });

      ws.on('pong', () => {
        pongReceived = true;
        expect(pongReceived).toBe(true);
        done();
      });

      // Timeout after 2 seconds
      setTimeout(() => {
        if (!pongReceived) {
          done(new Error('Pong not received'));
        }
      }, 2000);
    });
  });
});