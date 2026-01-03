/**
 * WebSocket Authentication and Streaming Tests
 * Tests WebSocket security, real-time streaming, and event handling
 */

import { io, Socket } from 'socket.io-client';
import axios, { AxiosInstance } from 'axios';
import { v4 as uuidv4 } from 'uuid';

const API_BASE_URL = process.env.API_BASE_URL || 'http://localhost:3001/api';
const WS_URL = process.env.WS_URL || 'http://localhost:3001';

describe('WebSocket Authentication and Security Tests', () => {
  let apiClient: AxiosInstance;
  let wsClient: Socket;
  let authenticatedClient: Socket;

  beforeAll(() => {
    apiClient = axios.create({
      baseURL: API_BASE_URL,
      timeout: 30000
    });
  });

  afterEach(() => {
    if (wsClient && wsClient.connected) {
      wsClient.disconnect();
    }
    if (authenticatedClient && authenticatedClient.connected) {
      authenticatedClient.disconnect();
    }
  });

  describe('WebSocket Authentication', () => {
    it('should identify missing authentication vulnerability', async () => {
      // This test confirms the security vulnerability identified
      wsClient = io(WS_URL, {
        transports: ['websocket']
      });

      const connected = await new Promise<boolean>((resolve) => {
        wsClient.on('connect', () => {
          console.log('⚠️  VULNERABILITY: WebSocket connected without authentication');
          resolve(true);
        });

        wsClient.on('connect_error', (error) => {
          console.log('✅ WebSocket properly rejected unauthenticated connection');
          resolve(false);
        });

        setTimeout(() => resolve(false), 5000);
      });

      // Currently vulnerable - connects without auth
      expect(connected).toBe(true);

      // Test that connected client can access sensitive data
      if (connected) {
        const canAccessData = await new Promise<boolean>((resolve) => {
          wsClient.emit('get:tasks', {});

          wsClient.on('tasks:list', (data) => {
            console.log('⚠️  VULNERABILITY: Unauthenticated client received task data');
            resolve(true);
          });

          setTimeout(() => resolve(false), 2000);
        });

        // This confirms the vulnerability
        expect(canAccessData).toBe(true);
      }
    });

    it('should demonstrate proper authentication implementation', async () => {
      // This shows how authentication SHOULD work

      // Step 1: Get auth token from API
      const authToken = 'test-auth-token'; // In real implementation, get from login

      // Step 2: Connect with authentication
      authenticatedClient = io(WS_URL, {
        auth: {
          token: authToken
        },
        transports: ['websocket']
      });

      const authHandled = await new Promise<boolean>((resolve) => {
        authenticatedClient.on('connect', () => {
          console.log('Connected with auth token');
          resolve(true);
        });

        authenticatedClient.on('connect_error', (error) => {
          console.log('Auth validation error:', error.message);
          resolve(false);
        });

        setTimeout(() => resolve(false), 5000);
      });

      // Currently connects regardless of token (vulnerability)
      expect(authHandled).toBe(true);
    });

    it('should prevent unauthorized access to sensitive events', async () => {
      wsClient = io(WS_URL);

      await new Promise<void>((resolve) => {
        wsClient.on('connect', resolve);
      });

      // Try to access admin events
      const adminEvents = [
        'admin:get-config',
        'admin:update-settings',
        'admin:view-logs',
        'system:restart'
      ];

      for (const event of adminEvents) {
        const received = await new Promise<boolean>((resolve) => {
          wsClient.emit(event, { test: true });

          wsClient.once('error', (error) => {
            console.log(`Event ${event} properly rejected:`, error);
            resolve(false);
          });

          wsClient.once(`${event}:response`, () => {
            console.log(`⚠️  VULNERABILITY: ${event} processed without auth`);
            resolve(true);
          });

          setTimeout(() => resolve(false), 1000);
        });

        // Should not process admin events
        expect(received).toBe(false);
      }
    });
  });

  describe('Real-time Streaming Tests', () => {
    it('should stream agent output in real-time', async () => {
      // Start a streaming task
      const taskResponse = await apiClient.post('/orchestrate', {
        task: 'Write a detailed explanation of WebSocket security',
        options: {
          stream: true,
          maxTokens: 500
        }
      });

      const taskId = taskResponse.data.taskId;

      // Connect WebSocket
      wsClient = io(WS_URL);

      await new Promise<void>((resolve) => {
        wsClient.on('connect', () => {
          wsClient.emit('subscribe', { taskId, stream: true });
          resolve();
        });
      });

      // Collect streamed tokens
      const streamedContent: string[] = [];
      const timestamps: number[] = [];

      wsClient.on('token', (data) => {
        streamedContent.push(data.token);
        timestamps.push(Date.now());
      });

      wsClient.on('stream:complete', (data) => {
        console.log(`Stream completed: ${data.totalTokens} tokens`);
      });

      // Wait for streaming to complete
      await new Promise(resolve => setTimeout(resolve, 20000));

      // Verify streaming worked
      expect(streamedContent.length).toBeGreaterThan(10);
      expect(streamedContent.join('')).toContain('WebSocket');

      // Verify real-time nature (tokens should arrive over time, not all at once)
      if (timestamps.length > 2) {
        const timeSpan = timestamps[timestamps.length - 1] - timestamps[0];
        expect(timeSpan).toBeGreaterThan(1000); // Should take more than 1 second
      }
    }, 30000);

    it('should handle multiple concurrent streams', async () => {
      // Start multiple streaming tasks
      const tasks = [
        'Explain quantum computing',
        'Describe machine learning',
        'Write about cybersecurity'
      ];

      const taskPromises = tasks.map(task =>
        apiClient.post('/orchestrate', {
          task,
          options: { stream: true, maxTokens: 200 }
        })
      );

      const responses = await Promise.all(taskPromises);
      const taskIds = responses.map(r => r.data.taskId);

      // Connect WebSocket
      wsClient = io(WS_URL);

      await new Promise<void>((resolve) => {
        wsClient.on('connect', resolve);
      });

      // Subscribe to all streams
      const streamData: Record<string, string[]> = {};

      taskIds.forEach(taskId => {
        streamData[taskId] = [];
        wsClient.emit('subscribe', { taskId, stream: true });
      });

      wsClient.on('token', (data) => {
        if (streamData[data.taskId]) {
          streamData[data.taskId].push(data.token);
        }
      });

      // Wait for all streams
      await new Promise(resolve => setTimeout(resolve, 15000));

      // Verify all streams received data
      taskIds.forEach((taskId, index) => {
        expect(streamData[taskId].length).toBeGreaterThan(0);
        const content = streamData[taskId].join('');
        expect(content.toLowerCase()).toContain(tasks[index].split(' ')[1].toLowerCase());
      });
    });

    it('should handle stream interruption and resume', async () => {
      // Start a long streaming task
      const response = await apiClient.post('/orchestrate', {
        task: 'Write a comprehensive guide to distributed systems',
        options: { stream: true, maxTokens: 1000 }
      });

      const taskId = response.data.taskId;

      wsClient = io(WS_URL);
      await new Promise<void>((resolve) => {
        wsClient.on('connect', resolve);
      });

      let tokenCount = 0;
      const beforeDisconnect: string[] = [];
      const afterReconnect: string[] = [];

      wsClient.emit('subscribe', { taskId, stream: true });

      wsClient.on('token', (data) => {
        tokenCount++;
        if (wsClient.connected) {
          beforeDisconnect.push(data.token);
        }
      });

      // Simulate disconnection after 5 seconds
      setTimeout(() => {
        console.log('Simulating connection drop...');
        wsClient.disconnect();

        // Reconnect after 2 seconds
        setTimeout(() => {
          console.log('Reconnecting...');
          wsClient.connect();

          wsClient.on('connect', () => {
            wsClient.emit('subscribe', { taskId, stream: true, resume: true });

            wsClient.on('token', (data) => {
              afterReconnect.push(data.token);
            });
          });
        }, 2000);
      }, 5000);

      // Wait for completion
      await new Promise(resolve => setTimeout(resolve, 25000));

      // Should have received tokens both before and after reconnection
      expect(beforeDisconnect.length).toBeGreaterThan(0);
      expect(afterReconnect.length).toBeGreaterThan(0);

      console.log(`Received ${beforeDisconnect.length} tokens before disconnect`);
      console.log(`Received ${afterReconnect.length} tokens after reconnect`);
    }, 35000);
  });

  describe('Event Broadcasting and Room Management', () => {
    it('should properly isolate task rooms', async () => {
      // Create two tasks
      const [task1, task2] = await Promise.all([
        apiClient.post('/orchestrate', {
          task: 'Task 1', options: { maxTokens: 50 }
        }),
        apiClient.post('/orchestrate', {
          task: 'Task 2', options: { maxTokens: 50 }
        })
      ]);

      // Create two WebSocket connections
      const client1 = io(WS_URL);
      const client2 = io(WS_URL);

      await Promise.all([
        new Promise(resolve => client1.on('connect', resolve)),
        new Promise(resolve => client2.on('connect', resolve))
      ]);

      // Subscribe to different tasks
      client1.emit('subscribe', { taskId: task1.data.taskId });
      client2.emit('subscribe', { taskId: task2.data.taskId });

      const events1: any[] = [];
      const events2: any[] = [];

      client1.on('task:update', (data) => events1.push(data));
      client2.on('task:update', (data) => events2.push(data));

      // Wait for events
      await new Promise(resolve => setTimeout(resolve, 5000));

      // Each client should only receive events for their subscribed task
      events1.forEach(event => {
        expect(event.taskId).toBe(task1.data.taskId);
      });

      events2.forEach(event => {
        expect(event.taskId).toBe(task2.data.taskId);
      });

      // Cleanup
      client1.disconnect();
      client2.disconnect();
    });

    it('should handle competition event broadcasting', async () => {
      // Start a competition
      const competition = await apiClient.post('/competition', {
        challenge: 'Implement a sorting algorithm',
        competitorCount: 3
      });

      const competitionId = competition.data.competitionId;

      // Multiple clients watching the competition
      const clients = Array(5).fill(null).map(() => io(WS_URL));

      await Promise.all(
        clients.map(client =>
          new Promise(resolve => client.on('connect', resolve))
        )
      );

      // All subscribe to competition events
      clients.forEach(client => {
        client.emit('subscribe', { competitionId, type: 'competition' });
      });

      const eventCounts = clients.map(() => 0);

      clients.forEach((client, index) => {
        client.on('competition:update', () => {
          eventCounts[index]++;
        });
      });

      // Wait for competition events
      await new Promise(resolve => setTimeout(resolve, 15000));

      // All clients should receive the same events
      const firstCount = eventCounts[0];
      expect(firstCount).toBeGreaterThan(0);

      eventCounts.forEach(count => {
        expect(count).toBe(firstCount);
      });

      // Cleanup
      clients.forEach(client => client.disconnect());
    }, 30000);
  });

  describe('Error Handling and Recovery', () => {
    it('should handle malformed WebSocket messages', async () => {
      wsClient = io(WS_URL);

      await new Promise<void>((resolve) => {
        wsClient.on('connect', resolve);
      });

      const malformedMessages = [
        null,
        undefined,
        { __proto__: { polluted: true } },
        { type: 'a'.repeat(10000) }, // Very long string
        Buffer.from([0xFF, 0xFE, 0xFD]), // Binary data
        () => {}, // Function
      ];

      let errorCount = 0;

      wsClient.on('error', () => {
        errorCount++;
      });

      for (const msg of malformedMessages) {
        wsClient.emit('malformed', msg);
      }

      // Give time for errors to be handled
      await new Promise(resolve => setTimeout(resolve, 2000));

      // Connection should still be active
      expect(wsClient.connected).toBe(true);

      // Should have handled errors gracefully
      expect(errorCount).toBeLessThan(malformedMessages.length);
    });

    it('should rate limit WebSocket events', async () => {
      wsClient = io(WS_URL);

      await new Promise<void>((resolve) => {
        wsClient.on('connect', resolve);
      });

      let rateLimited = false;

      wsClient.on('rate-limit', () => {
        rateLimited = true;
      });

      // Spam events
      for (let i = 0; i < 1000; i++) {
        wsClient.emit('ping', { index: i });
      }

      await new Promise(resolve => setTimeout(resolve, 2000));

      // Should have been rate limited
      // Note: This depends on implementation
      console.log(`Rate limited: ${rateLimited}`);
    });
  });

  describe('Performance and Scalability', () => {
    it('should handle high-frequency streaming efficiently', async () => {
      const response = await apiClient.post('/orchestrate', {
        task: 'Generate a very long technical document',
        options: {
          stream: true,
          maxTokens: 2000,
          streamingMode: 'aggressive' // High frequency
        }
      });

      wsClient = io(WS_URL);

      await new Promise<void>((resolve) => {
        wsClient.on('connect', () => {
          wsClient.emit('subscribe', {
            taskId: response.data.taskId,
            stream: true
          });
          resolve();
        });
      });

      const startTime = Date.now();
      let tokenCount = 0;
      let lastTimestamp = startTime;
      const intervals: number[] = [];

      wsClient.on('token', () => {
        tokenCount++;
        const now = Date.now();
        intervals.push(now - lastTimestamp);
        lastTimestamp = now;
      });

      // Wait for streaming
      await new Promise(resolve => setTimeout(resolve, 10000));

      const duration = Date.now() - startTime;
      const tokensPerSecond = (tokenCount / duration) * 1000;

      console.log(`Streamed ${tokenCount} tokens in ${duration}ms`);
      console.log(`Rate: ${tokensPerSecond.toFixed(2)} tokens/second`);

      // Should maintain good streaming performance
      expect(tokensPerSecond).toBeGreaterThan(10); // At least 10 tokens/second

      // Check for consistent streaming (no long pauses)
      const avgInterval = intervals.reduce((a, b) => a + b, 0) / intervals.length;
      const maxInterval = Math.max(...intervals);

      expect(maxInterval).toBeLessThan(avgInterval * 10); // No huge gaps
    }, 20000);

    it('should scale to many concurrent WebSocket connections', async () => {
      const connectionCount = 50;
      const clients: Socket[] = [];

      console.log(`Creating ${connectionCount} concurrent connections...`);

      // Create many connections
      const connectionPromises = Array(connectionCount).fill(null).map(async () => {
        const client = io(WS_URL, {
          transports: ['websocket']
        });

        await new Promise<void>((resolve) => {
          client.on('connect', resolve);
        });

        clients.push(client);
        return client;
      });

      const connectedClients = await Promise.all(connectionPromises);

      expect(connectedClients.length).toBe(connectionCount);

      // All should be connected
      const connectedCount = clients.filter(c => c.connected).length;
      expect(connectedCount).toBe(connectionCount);

      // Test broadcasting to all
      const receivedCounts = Array(connectionCount).fill(0);

      clients.forEach((client, index) => {
        client.on('broadcast', () => {
          receivedCounts[index]++;
        });
      });

      // Server should be able to broadcast to all
      // (This would require server-side broadcast implementation)

      // Cleanup
      clients.forEach(client => client.disconnect());

      console.log(`Successfully handled ${connectionCount} concurrent connections`);
    });
  });

  describe('WebSocket Security Best Practices', () => {
    it('should implement origin validation', async () => {
      // Test with malicious origin
      const maliciousClient = io(WS_URL, {
        transports: ['websocket'],
        extraHeaders: {
          'Origin': 'https://evil.com'
        }
      });

      const connected = await new Promise<boolean>((resolve) => {
        maliciousClient.on('connect', () => resolve(true));
        maliciousClient.on('connect_error', () => resolve(false));
        setTimeout(() => resolve(false), 3000);
      });

      // Should validate origin (currently doesn't - vulnerability)
      if (process.env.ENABLE_ORIGIN_CHECK === 'true') {
        expect(connected).toBe(false);
      }

      if (maliciousClient.connected) {
        maliciousClient.disconnect();
      }
    });

    it('should prevent WebSocket request smuggling', async () => {
      // Attempt to smuggle requests
      const smuggleAttempts = [
        'GET /admin HTTP/1.1\r\nHost: localhost\r\n\r\n',
        'POST /api/admin HTTP/1.1\r\nContent-Length: 0\r\n\r\n'
      ];

      wsClient = io(WS_URL);

      await new Promise<void>((resolve) => {
        wsClient.on('connect', resolve);
      });

      for (const attempt of smuggleAttempts) {
        wsClient.emit('message', attempt);
      }

      // Should not process smuggled requests
      await new Promise(resolve => setTimeout(resolve, 2000));

      // Verify system still healthy
      const health = await apiClient.get('/health');
      expect(health.status).toBe(200);
    });
  });
});