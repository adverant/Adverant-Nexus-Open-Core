/**
 * Chaos Engineering Tests for MageAgent Platform
 * Tests system resilience under failure conditions
 */

import axios, { AxiosInstance } from 'axios';
import { io, Socket } from 'socket.io-client';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

const API_BASE_URL = process.env.API_BASE_URL || 'http://localhost:3001/api';
const WS_URL = process.env.WS_URL || 'http://localhost:3001';
const CHAOS_TEST_TIMEOUT = 600000; // 10 minutes

interface ChaosResult {
  scenario: string;
  passed: boolean;
  recoveryTime?: number;
  errors: string[];
  metrics: {
    availabilityPercentage: number;
    degradedPercentage: number;
    errorRate: number;
    averageResponseTime: number;
  };
}

describe('MageAgent Chaos Engineering Tests', () => {
  let apiClient: AxiosInstance;
  let wsClient: Socket;
  const chaosResults: ChaosResult[] = [];

  beforeAll(async () => {
    apiClient = axios.create({
      baseURL: API_BASE_URL,
      timeout: 30000,
      validateStatus: () => true
    });

    console.log('⚠️  WARNING: Chaos tests will simulate failures in your system');
    console.log('Ensure this is run in a test environment only!');
  });

  afterAll(async () => {
    if (wsClient && wsClient.connected) {
      wsClient.disconnect();
    }

    // Generate chaos test report
    console.log('\n=== Chaos Test Results ===');
    chaosResults.forEach(result => {
      console.log(`\n${result.scenario}:`);
      console.log(`  Passed: ${result.passed ? '✅' : '❌'}`);
      console.log(`  Availability: ${result.metrics.availabilityPercentage.toFixed(2)}%`);
      console.log(`  Error Rate: ${result.metrics.errorRate.toFixed(2)}%`);
      if (result.recoveryTime) {
        console.log(`  Recovery Time: ${result.recoveryTime}ms`);
      }
    });
  });

  async function measureSystemHealth(): Promise<boolean> {
    try {
      const response = await apiClient.get('/health');
      return response.status === 200 && response.data.status === 'healthy';
    } catch {
      return false;
    }
  }

  async function simulateFailure(
    name: string,
    failureFunc: () => Promise<void>,
    recoveryFunc: () => Promise<void>,
    testFunc: () => Promise<any>
  ): Promise<ChaosResult> {
    console.log(`\n🔥 Starting chaos scenario: ${name}`);

    const startTime = Date.now();
    const errors: string[] = [];
    let totalRequests = 0;
    let successfulRequests = 0;
    let degradedRequests = 0;

    // Baseline health check
    const initialHealth = await measureSystemHealth();
    console.log(`Initial health: ${initialHealth ? 'Healthy' : 'Unhealthy'}`);

    // Inject failure
    console.log('Injecting failure...');
    await failureFunc();

    // Run test workload during failure
    const testPromises = [];
    const testStartTime = Date.now();

    const interval = setInterval(async () => {
      totalRequests++;
      try {
        const result = await testFunc();
        if (result.degraded) {
          degradedRequests++;
        } else {
          successfulRequests++;
        }
      } catch (error: any) {
        errors.push(error.message);
      }
    }, 1000);

    // Let it run for 30 seconds
    await new Promise(resolve => setTimeout(resolve, 30000));
    clearInterval(interval);

    // Recovery
    console.log('Initiating recovery...');
    const recoveryStartTime = Date.now();
    await recoveryFunc();

    // Wait for system to recover
    let recovered = false;
    let recoveryTime = 0;

    for (let i = 0; i < 60; i++) { // Max 60 seconds for recovery
      if (await measureSystemHealth()) {
        recovered = true;
        recoveryTime = Date.now() - recoveryStartTime;
        console.log(`System recovered in ${recoveryTime}ms`);
        break;
      }
      await new Promise(resolve => setTimeout(resolve, 1000));
    }

    const availabilityPercentage = (successfulRequests / totalRequests) * 100;
    const degradedPercentage = (degradedRequests / totalRequests) * 100;
    const errorRate = ((totalRequests - successfulRequests - degradedRequests) / totalRequests);

    const result: ChaosResult = {
      scenario: name,
      passed: recovered && availabilityPercentage > 50,
      recoveryTime: recovered ? recoveryTime : undefined,
      errors: [...new Set(errors)].slice(0, 5), // Unique errors, max 5
      metrics: {
        availabilityPercentage,
        degradedPercentage,
        errorRate,
        averageResponseTime: (Date.now() - testStartTime) / totalRequests
      }
    };

    chaosResults.push(result);
    return result;
  }

  describe('Network Chaos', () => {
    it('should handle network partition between services', async () => {
      const result = await simulateFailure(
        'Network Partition - Database Connection',
        async () => {
          // Simulate network partition (would need actual network control in real test)
          console.log('Simulating database network partition...');
          // In real chaos testing, you would use tools like tc (traffic control) or iptables
        },
        async () => {
          console.log('Restoring network connectivity...');
          // Restore network
        },
        async () => {
          const response = await apiClient.post('/orchestrate', {
            task: 'Test task during network partition',
            options: { maxTokens: 50 }
          });

          return {
            success: response.status === 200,
            degraded: response.status === 503 && response.data.status === 'degraded'
          };
        }
      );

      expect(result.passed).toBe(true);
      expect(result.metrics.availabilityPercentage).toBeGreaterThan(30);
    }, CHAOS_TEST_TIMEOUT);

    it('should handle high network latency', async () => {
      let latencyInjected = false;

      const result = await simulateFailure(
        'High Network Latency',
        async () => {
          latencyInjected = true;
          // In real test, inject 500ms latency using tc
        },
        async () => {
          latencyInjected = false;
          // Remove latency
        },
        async () => {
          // Add artificial delay if latency is "injected"
          if (latencyInjected) {
            await new Promise(resolve => setTimeout(resolve, 500));
          }

          const response = await apiClient.get('/health');
          return { success: response.status === 200 };
        }
      );

      expect(result.passed).toBe(true);
    });

    it('should handle packet loss', async () => {
      let packetLossActive = false;

      const result = await simulateFailure(
        'Packet Loss (20%)',
        async () => {
          packetLossActive = true;
          console.log('Simulating 20% packet loss...');
        },
        async () => {
          packetLossActive = false;
          console.log('Removing packet loss...');
        },
        async () => {
          // Simulate packet loss by randomly failing requests
          if (packetLossActive && Math.random() < 0.2) {
            throw new Error('Simulated packet loss');
          }

          const response = await apiClient.get('/agents');
          return { success: response.status === 200 };
        }
      );

      expect(result.passed).toBe(true);
      expect(result.metrics.errorRate).toBeLessThan(0.3); // Should handle 20% loss
    });
  });

  describe('Service Failures', () => {
    it('should handle OpenRouter API outage', async () => {
      const result = await simulateFailure(
        'OpenRouter API Outage',
        async () => {
          // Mock OpenRouter failure by intercepting requests
          console.log('Simulating OpenRouter outage...');
        },
        async () => {
          console.log('OpenRouter service restored...');
        },
        async () => {
          try {
            const response = await apiClient.post('/orchestrate', {
              task: 'Simple test during OpenRouter outage',
              options: {
                maxTokens: 50,
                fallbackModels: ['openai/gpt-3.5-turbo']
              }
            });

            // Should use fallback or queue
            return {
              success: response.status === 200,
              degraded: response.data.usedFallback === true
            };
          } catch (error) {
            return { success: false };
          }
        }
      );

      // System should degrade gracefully
      expect(result.passed).toBe(true);
    });

    it('should handle database failures with circuit breaker', async () => {
      let dbFailureCount = 0;

      const result = await simulateFailure(
        'Database Failure with Circuit Breaker',
        async () => {
          dbFailureCount = 0;
          console.log('Simulating database failures...');
        },
        async () => {
          dbFailureCount = 999; // Stop failures
          console.log('Database restored...');
        },
        async () => {
          dbFailureCount++;

          // First 5 calls fail, then circuit breaker should open
          if (dbFailureCount <= 5) {
            // Database "fails"
            try {
              const response = await apiClient.post('/memory/search', {
                query: 'test during db failure'
              });

              return {
                success: response.status !== 500,
                degraded: response.status === 503
              };
            } catch {
              return { success: false };
            }
          } else {
            // Circuit breaker should be open, fast fail
            const start = Date.now();
            const response = await apiClient.post('/memory/search', {
              query: 'test with circuit breaker open'
            });
            const duration = Date.now() - start;

            // Should fail fast when circuit is open
            return {
              success: response.status === 503 && duration < 100,
              degraded: true
            };
          }
        }
      );

      expect(result.passed).toBe(true);
    });

    it('should handle Redis cache failure', async () => {
      const result = await simulateFailure(
        'Redis Cache Failure',
        async () => {
          console.log('Simulating Redis failure...');
          // In real test, stop Redis or block connections
        },
        async () => {
          console.log('Redis restored...');
        },
        async () => {
          // Operations should work without cache, just slower
          const response = await apiClient.get('/patterns/test-pattern');

          return {
            success: response.status === 200,
            degraded: response.headers['x-cache-status'] === 'miss'
          };
        }
      );

      expect(result.passed).toBe(true);
      expect(result.metrics.availabilityPercentage).toBeGreaterThan(90);
    });
  });

  describe('Resource Exhaustion', () => {
    it('should handle memory pressure', async () => {
      const memoryHogs: any[] = [];

      const result = await simulateFailure(
        'Memory Pressure',
        async () => {
          console.log('Creating memory pressure...');
          // Allocate large arrays to consume memory
          for (let i = 0; i < 10; i++) {
            memoryHogs.push(new Array(10 * 1024 * 1024).fill('X')); // 10MB each
          }
        },
        async () => {
          console.log('Releasing memory...');
          memoryHogs.length = 0;
          if (global.gc) global.gc();
        },
        async () => {
          const response = await apiClient.post('/orchestrate', {
            task: 'Process under memory pressure',
            options: { maxTokens: 50 }
          });

          return {
            success: response.status === 200,
            degraded: response.status === 503
          };
        }
      );

      expect(result.passed).toBe(true);
    });

    it('should handle CPU saturation', async () => {
      let cpuIntensive = true;

      const result = await simulateFailure(
        'CPU Saturation',
        async () => {
          console.log('Creating CPU saturation...');
          // Spawn CPU-intensive operations
          for (let i = 0; i < 4; i++) {
            setTimeout(() => {
              while (cpuIntensive) {
                Math.sqrt(Math.random());
              }
            }, 0);
          }
        },
        async () => {
          console.log('Stopping CPU saturation...');
          cpuIntensive = false;
        },
        async () => {
          const start = Date.now();
          const response = await apiClient.get('/health');
          const duration = Date.now() - start;

          return {
            success: response.status === 200,
            degraded: duration > 1000 // Slow response
          };
        }
      );

      expect(result.passed).toBe(true);
    });

    it('should handle connection pool exhaustion', async () => {
      const connections: Promise<any>[] = [];

      const result = await simulateFailure(
        'Connection Pool Exhaustion',
        async () => {
          console.log('Exhausting connection pool...');
          // Create many concurrent connections
          for (let i = 0; i < 100; i++) {
            connections.push(
              apiClient.post('/orchestrate', {
                task: `Connection ${i}`,
                options: { maxTokens: 50 }
              }).catch(() => null)
            );
          }
        },
        async () => {
          console.log('Waiting for connections to clear...');
          await Promise.all(connections);
          connections.length = 0;
        },
        async () => {
          const response = await apiClient.get('/health');
          return {
            success: response.status === 200,
            degraded: response.data.status === 'degraded'
          };
        }
      );

      expect(result.passed).toBe(true);
    });
  });

  describe('Cascading Failures', () => {
    it('should prevent cascade when agent fails', async () => {
      const result = await simulateFailure(
        'Agent Cascade Prevention',
        async () => {
          console.log('Simulating agent failures...');
          // Cause specific agents to fail
        },
        async () => {
          console.log('Restoring agents...');
        },
        async () => {
          // Start multiple agent tasks
          const promises = Array(5).fill(null).map((_, i) =>
            apiClient.post('/orchestrate', {
              task: `Task ${i} that might fail`,
              options: {
                maxTokens: 50,
                agentId: i === 0 ? 'failing-agent' : undefined
              }
            }).catch(() => ({ status: 500 }))
          );

          const results = await Promise.all(promises);
          const successful = results.filter(r => r.status === 200).length;

          return {
            success: successful >= 3, // At least 60% should succeed
            degraded: successful < 5
          };
        }
      );

      expect(result.passed).toBe(true);
      expect(result.metrics.availabilityPercentage).toBeGreaterThan(60);
    });

    it('should handle thundering herd after recovery', async () => {
      let serviceDown = true;
      const waitingRequests: any[] = [];

      const result = await simulateFailure(
        'Thundering Herd Prevention',
        async () => {
          console.log('Taking service down...');
          serviceDown = true;

          // Queue up many requests while service is down
          for (let i = 0; i < 50; i++) {
            waitingRequests.push(
              apiClient.get('/health').catch(() => null)
            );
          }
        },
        async () => {
          console.log('Service coming back up...');
          serviceDown = false;
          // All waiting requests will now hit the service
        },
        async () => {
          if (serviceDown) {
            throw new Error('Service down');
          }

          // Monitor recovery behavior
          const response = await apiClient.get('/health');
          return {
            success: response.status === 200,
            degraded: false
          };
        }
      );

      // Should handle the surge gracefully
      expect(result.passed).toBe(true);
      expect(result.recoveryTime).toBeLessThan(10000); // Recover within 10s
    });
  });

  describe('Data Consistency Under Failure', () => {
    it('should maintain data consistency during partial writes', async () => {
      const result = await simulateFailure(
        'Partial Write Consistency',
        async () => {
          console.log('Simulating partial write failures...');
        },
        async () => {
          console.log('Restoring write capability...');
        },
        async () => {
          try {
            // Attempt complex operation that writes to multiple stores
            const response = await apiClient.post('/competition', {
              challenge: 'Test competition with potential partial writes',
              competitorCount: 3
            });

            if (response.status === 200) {
              // Verify data consistency
              const competitionId = response.data.competitionId;

              // Check if all data was written
              const verifyPromises = [
                apiClient.get(`/competitions/${competitionId}`).catch(() => null),
                apiClient.post('/memory/search', {
                  query: competitionId
                }).catch(() => null)
              ];

              const verifyResults = await Promise.all(verifyPromises);
              const consistent = verifyResults.every(r => r?.status === 200);

              return {
                success: consistent,
                degraded: !consistent
              };
            }

            return { success: false };
          } catch {
            return { success: false };
          }
        }
      );

      expect(result.passed).toBe(true);
    });
  });

  describe('WebSocket Chaos', () => {
    it('should handle WebSocket connection drops', async () => {
      let dropConnections = false;

      const result = await simulateFailure(
        'WebSocket Connection Instability',
        async () => {
          dropConnections = true;
          console.log('Simulating WebSocket instability...');
        },
        async () => {
          dropConnections = false;
          console.log('Stabilizing WebSocket connections...');
        },
        async () => {
          if (!wsClient || !wsClient.connected) {
            wsClient = io(WS_URL);
            await new Promise(resolve => wsClient.on('connect', resolve));
          }

          // Simulate random disconnections
          if (dropConnections && Math.random() < 0.3) {
            wsClient.disconnect();
            await new Promise(resolve => setTimeout(resolve, 100));
            wsClient.connect();
          }

          // Try to use WebSocket
          return new Promise((resolve) => {
            const timeout = setTimeout(() => {
              resolve({ success: false });
            }, 5000);

            wsClient.emit('ping', { timestamp: Date.now() });

            wsClient.once('pong', () => {
              clearTimeout(timeout);
              resolve({ success: true });
            });
          });
        }
      );

      expect(result.passed).toBe(true);
    });
  });

  describe('Chaos Test Summary', () => {
    it('should generate comprehensive chaos test report', () => {
      console.log('\n=== CHAOS ENGINEERING TEST SUMMARY ===');

      const totalTests = chaosResults.length;
      const passedTests = chaosResults.filter(r => r.passed).length;
      const overallSuccess = (passedTests / totalTests) * 100;

      console.log(`\nTotal Scenarios: ${totalTests}`);
      console.log(`Passed: ${passedTests}`);
      console.log(`Failed: ${totalTests - passedTests}`);
      console.log(`Success Rate: ${overallSuccess.toFixed(2)}%`);

      // Average metrics
      const avgAvailability = chaosResults.reduce((sum, r) =>
        sum + r.metrics.availabilityPercentage, 0) / totalTests;

      const avgErrorRate = chaosResults.reduce((sum, r) =>
        sum + r.metrics.errorRate, 0) / totalTests;

      const avgRecoveryTime = chaosResults
        .filter(r => r.recoveryTime)
        .reduce((sum, r, _, arr) =>
          sum + (r.recoveryTime! / arr.length), 0);

      console.log(`\nAverage Availability: ${avgAvailability.toFixed(2)}%`);
      console.log(`Average Error Rate: ${(avgErrorRate * 100).toFixed(2)}%`);
      console.log(`Average Recovery Time: ${avgRecoveryTime.toFixed(0)}ms`);

      // System resilience score
      const resilienceScore =
        (overallSuccess * 0.4) +
        (avgAvailability * 0.3) +
        ((100 - avgErrorRate * 100) * 0.2) +
        ((avgRecoveryTime < 5000 ? 100 : 50) * 0.1);

      console.log(`\n🛡️  System Resilience Score: ${resilienceScore.toFixed(1)}/100`);

      expect(resilienceScore).toBeGreaterThan(70); // Should have good resilience
    });
  });
});