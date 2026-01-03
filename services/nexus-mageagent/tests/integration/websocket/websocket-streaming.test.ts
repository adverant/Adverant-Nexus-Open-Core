/**
 * Integration Tests for WebSocket Streaming
 * Tests REAL WebSocket communication with live streaming
 */

import { createServer, Server as HTTPServer } from 'http';
import { io as ioClient, Socket as ClientSocket } from 'socket.io-client';
import { initializeWebSocketManager, WebSocketManager } from '../../../src/websocket/websocket-manager';
import { OpenRouterClient } from '../../../src/clients/openrouter-client';
import { GraphRAGClient } from '../../../src/clients/graphrag-client';
import { DatabaseManager } from '../../../src/database/database-manager';
import { Orchestrator } from '../../../src/orchestration/orchestrator';
import { config } from '../../../src/config';
import express from 'express';

describe('WebSocket Streaming - Real-time Integration Tests', () => {
  let httpServer: HTTPServer;
  let wsManager: WebSocketManager;
  let client1: ClientSocket;
  let client2: ClientSocket;
  let orchestrator: Orchestrator;
  const testPort = 9999;
  const wsUrl = `http://localhost:${testPort}`;

  beforeAll(async () => {
    // Create HTTP server
    const app = express();
    httpServer = createServer(app);

    // Initialize WebSocket manager
    wsManager = initializeWebSocketManager(httpServer);

    // Initialize real dependencies for orchestrator
    const openRouterClient = new OpenRouterClient(
      process.env.OPENROUTER_API_KEY!,
      config.openRouter.baseUrl
    );
    const graphRAGClient = new GraphRAGClient(config.graphRAG.externalEndpoint);
    const databaseManager = new DatabaseManager();
    await databaseManager.initialize();

    orchestrator = new Orchestrator({
      openRouterClient,
      graphRAGClient,
      databaseManager,
      config: config.orchestration
    });

    // Start server
    await new Promise<void>((resolve) => {
      httpServer.listen(testPort, () => {
        console.log(`Test WebSocket server running on port ${testPort}`);
        resolve();
      });
    });

    // Wait a bit for server to be fully ready
    await new Promise(resolve => setTimeout(resolve, 1000));
  }, 60000);

  afterAll(async () => {
    // Disconnect all clients
    if (client1 && client1.connected) client1.disconnect();
    if (client2 && client2.connected) client2.disconnect();

    // Close server
    await new Promise<void>((resolve) => {
      httpServer.close(() => resolve());
    });

    console.log('WebSocket test cleanup completed');
  }, 30000);

  beforeEach(() => {
    // Clean up any existing connections
    if (client1 && client1.connected) client1.disconnect();
    if (client2 && client2.connected) client2.disconnect();
  });

  describe('Basic WebSocket Connection', () => {
    test('should establish WebSocket connection and receive welcome message', async () => {
      const welcomePromise = new Promise((resolve) => {
        client1 = ioClient(wsUrl, {
          transports: ['websocket'],
          reconnection: false
        });

        client1.on('welcome', (data) => {
          resolve(data);
        });
      });

      const welcome = await welcomePromise;

      expect(welcome).toBeDefined();
      expect(welcome).toHaveRealData();
      expect(welcome).toHaveProperty('sessionId');
      expect(welcome).toHaveProperty('timestamp');
      expect(welcome).toHaveProperty('message');

      console.log('WebSocket connection established:', welcome);
    });

    test('should handle multiple concurrent connections', async () => {
      const connections = await Promise.all([
        new Promise((resolve) => {
          const client = ioClient(wsUrl, { transports: ['websocket'] });
          client.on('welcome', (data) => {
            resolve({ client, data });
          });
        }),
        new Promise((resolve) => {
          const client = ioClient(wsUrl, { transports: ['websocket'] });
          client.on('welcome', (data) => {
            resolve({ client, data });
          });
        }),
        new Promise((resolve) => {
          const client = ioClient(wsUrl, { transports: ['websocket'] });
          client.on('welcome', (data) => {
            resolve({ client, data });
          });
        })
      ]) as any[];

      expect(connections).toHaveLength(3);
      expect(wsManager.getActiveSessionsCount()).toBeGreaterThanOrEqual(3);

      // Different session IDs
      const sessionIds = connections.map((c: any) => c.data.sessionId);
      expect(new Set(sessionIds).size).toBe(3);

      // Cleanup
      connections.forEach((c: any) => c.client.disconnect());

      console.log(`Handled ${connections.length} concurrent connections`);
    });
  });

  describe('Agent Subscription and Streaming', () => {
    test('should subscribe to agent and receive real-time streams', async () => {
      client1 = ioClient(wsUrl, { transports: ['websocket'] });
      await new Promise(resolve => client1.on('connect', resolve));

      const agentId = 'test-agent-' + Date.now();
      const receivedStreams: any[] = [];

      // Set up stream listener
      client1.on('agent_stream', (data) => {
        receivedStreams.push(data);
      });

      // Subscribe to agent
      const subscribePromise = new Promise((resolve) => {
        client1.on('subscribed', resolve);
      });

      client1.emit('subscribe', { agentId, streamTypes: ['all'] });

      const subscribed = await subscribePromise;
      expect(subscribed).toHaveProperty('agentId', agentId);

      // Simulate agent streaming
      const streamer = wsManager.createAgentStreamer(agentId);

      await streamer('Starting analysis...', { phase: 'init' });
      await streamer('Processing data...', { phase: 'processing' });
      await streamer('Analysis complete!', { phase: 'complete' });

      // Wait for streams
      await new Promise(resolve => setTimeout(resolve, 1000));

      expect(receivedStreams).toHaveLength(3);
      expect(receivedStreams[0].content).toBe('Starting analysis...');
      expect(receivedStreams[2].content).toBe('Analysis complete!');
      expect(receivedStreams.every(s => s.agentId === agentId)).toBe(true);

      console.log(`Received ${receivedStreams.length} agent streams`);
    });

    test('should handle multiple subscribers to same agent', async () => {
      const agentId = 'multi-sub-agent-' + Date.now();

      // Connect two clients
      client1 = ioClient(wsUrl, { transports: ['websocket'] });
      client2 = ioClient(wsUrl, { transports: ['websocket'] });

      await Promise.all([
        new Promise(resolve => client1.on('connect', resolve)),
        new Promise(resolve => client2.on('connect', resolve))
      ]);

      const client1Streams: any[] = [];
      const client2Streams: any[] = [];

      client1.on('agent_stream', (data) => client1Streams.push(data));
      client2.on('agent_stream', (data) => client2Streams.push(data));

      // Both subscribe to same agent
      await Promise.all([
        new Promise(resolve => {
          client1.on('subscribed', resolve);
          client1.emit('subscribe', { agentId });
        }),
        new Promise(resolve => {
          client2.on('subscribed', resolve);
          client2.emit('subscribe', { agentId });
        })
      ]);

      expect(wsManager.getAgentSubscribers(agentId)).toBe(2);

      // Stream to agent
      const streamer = wsManager.createAgentStreamer(agentId);
      await streamer('Broadcast message', { broadcast: true });

      await new Promise(resolve => setTimeout(resolve, 500));

      // Both clients should receive the stream
      expect(client1Streams).toHaveLength(1);
      expect(client2Streams).toHaveLength(1);
      expect(client1Streams[0].content).toBe('Broadcast message');
      expect(client2Streams[0].content).toBe('Broadcast message');
    });

    test('should handle unsubscription correctly', async () => {
      client1 = ioClient(wsUrl, { transports: ['websocket'] });
      await new Promise(resolve => client1.on('connect', resolve));

      const agentId = 'unsub-test-' + Date.now();
      const streams: any[] = [];

      client1.on('agent_stream', (data) => streams.push(data));

      // Subscribe
      await new Promise(resolve => {
        client1.on('subscribed', resolve);
        client1.emit('subscribe', { agentId });
      });

      const streamer = wsManager.createAgentStreamer(agentId);
      await streamer('First message');

      // Unsubscribe
      await new Promise(resolve => {
        client1.on('unsubscribed', resolve);
        client1.emit('unsubscribe', { agentId });
      });

      // This message should not be received
      await streamer('Second message');

      await new Promise(resolve => setTimeout(resolve, 500));

      expect(streams).toHaveLength(1);
      expect(streams[0].content).toBe('First message');
      expect(wsManager.getAgentSubscribers(agentId)).toBe(0);
    });
  });

  describe('Real Agent Integration', () => {
    test('should stream real agent execution progress', async () => {
      client1 = ioClient(wsUrl, { transports: ['websocket'] });
      await new Promise(resolve => client1.on('connect', resolve));

      const events: any[] = [];

      // Listen for all event types
      client1.on('agent_stream', (data) => events.push({ type: 'stream', ...data }));
      client1.on('orchestration_update', (data) => events.push({ type: 'update', ...data }));
      client1.on('task_started', (data) => events.push({ type: 'started', ...data }));

      // Trigger real orchestration with streaming
      orchestrator.on('agentSpawned', async ({ agentId }) => {
        // Subscribe to the spawned agent
        client1.emit('subscribe', { agentId });

        // Create streamer for this agent
        const streamer = wsManager.createAgentStreamer(agentId);

        // Simulate agent progress
        await streamer('Agent initialized', { status: 'init' });
        await streamer('Analyzing task...', { status: 'working' });
      });

      // Run real task
      const task = {
        objective: 'Analyze WebSocket streaming patterns',
        context: { streamingEnabled: true }
      };

      await orchestrator.orchestrateTask(task);

      // Wait for events
      await new Promise(resolve => setTimeout(resolve, 2000));

      expect(events.length).toBeGreaterThan(0);
      console.log(`Captured ${events.length} streaming events during real agent execution`);

      // Cleanup
      orchestrator.removeAllListeners();
    });

    test('should stream competition progress with multiple agents', async () => {
      client1 = ioClient(wsUrl, { transports: ['websocket'] });
      await new Promise(resolve => client1.on('connect', resolve));

      const competitionEvents: any[] = [];

      client1.on('competition_result', (data) => competitionEvents.push(data));
      client1.on('agent_stream', (data) => competitionEvents.push({ stream: true, ...data }));

      // Monitor agent spawning
      const agentIds: string[] = [];
      orchestrator.on('agentSpawned', ({ agentId }) => {
        agentIds.push(agentId);
        client1.emit('subscribe', { agentId });
      });

      // Run competition
      const competition = await orchestrator.runCompetition({
        challenge: 'Design a caching strategy',
        competitorCount: 3,
        timeLimit: 30000
      });

      // Broadcast results
      await wsManager.broadcastCompetitionResult(competition.competitionId, competition);

      await new Promise(resolve => setTimeout(resolve, 1000));

      expect(competitionEvents.length).toBeGreaterThan(0);
      const resultEvent = competitionEvents.find(e => e.type === 'competition_result');
      expect(resultEvent).toBeDefined();
      expect(resultEvent.results.competitionId).toBe(competition.competitionId);

      console.log(`Streamed competition with ${agentIds.length} agents`);

      // Cleanup
      orchestrator.removeAllListeners();
    });
  });

  describe('Broadcast Messages', () => {
    test('should broadcast orchestration updates to all clients', async () => {
      // Connect multiple clients
      const clients = await Promise.all([
        createConnectedClient(wsUrl),
        createConnectedClient(wsUrl),
        createConnectedClient(wsUrl)
      ]);

      const receivedUpdates = clients.map(() => [] as any[]);

      // Set up listeners
      clients.forEach((client, i) => {
        client.on('orchestration_update', (data) => {
          receivedUpdates[i].push(data);
        });
      });

      // Broadcast update
      await wsManager.broadcastOrchestrationUpdate({
        taskId: 'broadcast-test',
        status: 'processing',
        progress: 50,
        message: 'Processing in progress'
      });

      await new Promise(resolve => setTimeout(resolve, 500));

      // All clients should receive the update
      receivedUpdates.forEach(updates => {
        expect(updates).toHaveLength(1);
        expect(updates[0].taskId).toBe('broadcast-test');
        expect(updates[0].status).toBe('processing');
      });

      // Cleanup
      clients.forEach(client => client.disconnect());

      console.log('Broadcast delivered to all clients');
    });

    test('should stream synthesis progress updates', async () => {
      client1 = ioClient(wsUrl, { transports: ['websocket'] });
      await new Promise(resolve => client1.on('connect', resolve));

      const progressUpdates: any[] = [];

      client1.on('synthesis_progress', (data) => progressUpdates.push(data));

      // Stream synthesis progress
      const synthesisId = 'synth-' + Date.now();

      await wsManager.streamSynthesisProgress(synthesisId, { step: 1, total: 3, description: 'Collecting data' });
      await wsManager.streamSynthesisProgress(synthesisId, { step: 2, total: 3, description: 'Analyzing patterns' });
      await wsManager.streamSynthesisProgress(synthesisId, { step: 3, total: 3, description: 'Generating synthesis' });

      await new Promise(resolve => setTimeout(resolve, 500));

      expect(progressUpdates).toHaveLength(3);
      expect(progressUpdates[0].progress.step).toBe(1);
      expect(progressUpdates[2].progress.step).toBe(3);

      console.log('Synthesis progress streamed successfully');
    });
  });

  describe('Error Handling', () => {
    test('should handle and propagate errors to clients', async () => {
      client1 = ioClient(wsUrl, { transports: ['websocket'] });

      const welcomeData = await new Promise<any>(resolve => {
        client1.on('welcome', resolve);
      });

      const errorPromise = new Promise((resolve) => {
        client1.on('error', resolve);
      });

      // Send error to specific session
      await wsManager.sendError(welcomeData.sessionId, {
        message: 'Test error message',
        code: 'TEST_ERROR',
        details: { reason: 'Testing error handling' }
      });

      const error = await errorPromise;

      expect(error).toBeDefined();
      expect(error).toHaveProperty('type', 'error');
      expect(error).toHaveProperty('error');
      expect((error as any).error.message).toBe('Test error message');
      expect((error as any).error.code).toBe('TEST_ERROR');

      console.log('Error handling verified');
    });

    test('should handle client disconnection gracefully', async () => {
      const initialCount = wsManager.getActiveSessionsCount();

      // Connect and then disconnect multiple clients
      const clients = await Promise.all([
        createConnectedClient(wsUrl),
        createConnectedClient(wsUrl)
      ]);

      expect(wsManager.getActiveSessionsCount()).toBe(initialCount + 2);

      // Disconnect clients
      clients.forEach(client => client.disconnect());

      await new Promise(resolve => setTimeout(resolve, 1000));

      expect(wsManager.getActiveSessionsCount()).toBe(initialCount);

      console.log('Client disconnection handled properly');
    });
  });

  describe('Performance and Scalability', () => {
    test('should handle high-frequency streaming', async () => {
      client1 = ioClient(wsUrl, { transports: ['websocket'] });
      await new Promise(resolve => client1.on('connect', resolve));

      const agentId = 'perf-test-' + Date.now();
      const streams: any[] = [];

      client1.on('agent_stream', (data) => streams.push(data));

      // Subscribe
      await new Promise(resolve => {
        client1.on('subscribed', resolve);
        client1.emit('subscribe', { agentId });
      });

      const streamer = wsManager.createAgentStreamer(agentId);

      // Send many messages rapidly
      const messageCount = 100;
      const startTime = Date.now();

      for (let i = 0; i < messageCount; i++) {
        await streamer(`Message ${i}`, { index: i });
      }

      await new Promise(resolve => setTimeout(resolve, 1000));

      const duration = Date.now() - startTime;

      expect(streams.length).toBe(messageCount);
      expect(streams[0].content).toBe('Message 0');
      expect(streams[messageCount - 1].content).toBe(`Message ${messageCount - 1}`);

      console.log(`Streamed ${messageCount} messages in ${duration}ms (${(messageCount / duration * 1000).toFixed(2)} msg/s)`);
    });

    test('should maintain performance with multiple concurrent streams', async () => {
      const clientCount = 5;
      const clients = await Promise.all(
        Array(clientCount).fill(null).map(() => createConnectedClient(wsUrl))
      );

      const agentIds = Array(clientCount).fill(null).map((_, i) => `concurrent-agent-${i}`);
      const clientStreams = clients.map(() => [] as any[]);

      // Each client subscribes to its own agent
      await Promise.all(
        clients.map((client, i) => new Promise(resolve => {
          client.on('agent_stream', (data) => clientStreams[i].push(data));
          client.on('subscribed', resolve);
          client.emit('subscribe', { agentId: agentIds[i] });
        }))
      );

      // Stream to all agents concurrently
      const streamers = agentIds.map(id => wsManager.createAgentStreamer(id));
      const startTime = Date.now();

      await Promise.all(
        streamers.map(async (streamer, i) => {
          for (let j = 0; j < 20; j++) {
            await streamer(`Agent ${i} message ${j}`);
          }
        })
      );

      await new Promise(resolve => setTimeout(resolve, 1000));

      const duration = Date.now() - startTime;

      // Verify all clients received their streams
      clientStreams.forEach((streams, i) => {
        expect(streams).toHaveLength(20);
        expect(streams[0].content).toContain(`Agent ${i}`);
      });

      console.log(`Handled ${clientCount} concurrent streams in ${duration}ms`);

      // Cleanup
      clients.forEach(client => client.disconnect());
    });
  });

  describe('Health Metrics', () => {
    test('should provide accurate health metrics', async () => {
      // Connect some clients
      const clients = await Promise.all([
        createConnectedClient(wsUrl),
        createConnectedClient(wsUrl)
      ]);

      // Subscribe to agents
      const agentIds = ['health-test-1', 'health-test-2'];

      await Promise.all([
        new Promise(resolve => {
          clients[0].on('subscribed', resolve);
          clients[0].emit('subscribe', { agentId: agentIds[0] });
        }),
        new Promise(resolve => {
          clients[0].on('subscribed', resolve);
          clients[0].emit('subscribe', { agentId: agentIds[1] });
        }),
        new Promise(resolve => {
          clients[1].on('subscribed', resolve);
          clients[1].emit('subscribe', { agentId: agentIds[0] });
        })
      ]);

      const metrics = wsManager.getHealthMetrics();

      expect(metrics).toHaveRealData();
      expect(metrics.activeSessions).toBe(2);
      expect(metrics.activeAgentStreams).toBe(2);
      expect(metrics.totalSubscriptions).toBe(3);
      expect(metrics.uptime).toBeGreaterThan(0);

      console.log('Health metrics:', metrics);

      // Cleanup
      clients.forEach(client => client.disconnect());
    });
  });
});

// Helper function to create connected client
async function createConnectedClient(url: string): Promise<ClientSocket> {
  const client = ioClient(url, {
    transports: ['websocket'],
    reconnection: false
  });

  await new Promise(resolve => client.on('connect', resolve));
  return client;
}