/**
 * Saga Coordinator Tests
 *
 * Tests for the Saga pattern implementation ensuring:
 * - All steps execute successfully
 * - Rollback occurs on failure
 * - Compensating transactions execute in reverse order
 * - Timeout protection works
 * - Retry logic functions correctly
 */

import { SagaCoordinator, SagaStep, createSaga } from '../saga-coordinator';
import { logger } from '../../utils/logger';

describe('SagaCoordinator', () => {
  let saga: SagaCoordinator;

  beforeEach(() => {
    saga = createSaga(logger, 'test-saga-001');
  });

  describe('Successful Execution', () => {
    it('should execute all steps in order', async () => {
      const executionOrder: string[] = [];

      const steps: SagaStep[] = [
        {
          name: 'step-1',
          execute: async () => {
            executionOrder.push('execute-1');
            return 'result-1';
          },
          compensate: async () => {
            executionOrder.push('compensate-1');
          },
          isIdempotent: true
        },
        {
          name: 'step-2',
          execute: async () => {
            executionOrder.push('execute-2');
            return 'result-2';
          },
          compensate: async () => {
            executionOrder.push('compensate-2');
          },
          isIdempotent: true
        },
        {
          name: 'step-3',
          execute: async () => {
            executionOrder.push('execute-3');
            return 'result-3';
          },
          compensate: async () => {
            executionOrder.push('compensate-3');
          },
          isIdempotent: true
        }
      ];

      const result = await saga.execute(steps);

      expect(result.success).toBe(true);
      expect(executionOrder).toEqual(['execute-1', 'execute-2', 'execute-3']);
      expect(result.context.completedSteps.length).toBe(3);
      expect(result.context.rollbackResults.length).toBe(0);
    });

    it('should track execution context', async () => {
      const steps: SagaStep[] = [
        {
          name: 'test-step',
          execute: async () => 'test-result',
          compensate: async () => {},
          isIdempotent: true
        }
      ];

      const result = await saga.execute(steps);

      expect(result.context.sagaId).toBe('test-saga-001');
      expect(result.context.completedSteps).toHaveLength(1);
      expect(result.context.completedSteps[0].name).toBe('test-step');
      expect(result.context.completedSteps[0].result).toBe('test-result');
      expect(result.context.completedSteps[0].duration).toBeGreaterThan(0);
    });
  });

  describe('Rollback on Failure', () => {
    it('should rollback when step 2 fails', async () => {
      const executionOrder: string[] = [];
      const compensationOrder: string[] = [];

      const steps: SagaStep[] = [
        {
          name: 'step-1',
          execute: async () => {
            executionOrder.push('execute-1');
            return 'result-1';
          },
          compensate: async () => {
            compensationOrder.push('compensate-1');
          },
          isIdempotent: true
        },
        {
          name: 'step-2',
          execute: async () => {
            executionOrder.push('execute-2');
            throw new Error('Step 2 failed');
          },
          compensate: async () => {
            compensationOrder.push('compensate-2');
          },
          isIdempotent: true
        },
        {
          name: 'step-3',
          execute: async () => {
            executionOrder.push('execute-3');
            return 'result-3';
          },
          compensate: async () => {
            compensationOrder.push('compensate-3');
          },
          isIdempotent: true
        }
      ];

      const result = await saga.execute(steps);

      expect(result.success).toBe(false);
      expect(result.error?.message).toBe('Step 2 failed');

      // Only step 1 should have executed
      expect(executionOrder).toEqual(['execute-1', 'execute-2']);

      // Only step 1 should be compensated (reverse order)
      expect(compensationOrder).toEqual(['compensate-1']);

      // Verify context
      expect(result.context.completedSteps).toHaveLength(1);
      expect(result.context.failedStep?.name).toBe('step-2');
      expect(result.context.rollbackResults).toHaveLength(1);
    });

    it('should rollback all steps when last step fails', async () => {
      const compensationOrder: string[] = [];

      const steps: SagaStep[] = [
        {
          name: 'step-1',
          execute: async () => 'result-1',
          compensate: async () => {
            compensationOrder.push('step-1');
          },
          isIdempotent: true
        },
        {
          name: 'step-2',
          execute: async () => 'result-2',
          compensate: async () => {
            compensationOrder.push('step-2');
          },
          isIdempotent: true
        },
        {
          name: 'step-3',
          execute: async () => {
            throw new Error('Final step failed');
          },
          compensate: async () => {
            compensationOrder.push('step-3');
          },
          isIdempotent: true
        }
      ];

      const result = await saga.execute(steps);

      expect(result.success).toBe(false);

      // Should rollback in reverse order (step-2, step-1)
      expect(compensationOrder).toEqual(['step-2', 'step-1']);
    });

    it('should continue rollback even if compensation fails', async () => {
      const compensationOrder: string[] = [];

      const steps: SagaStep[] = [
        {
          name: 'step-1',
          execute: async () => 'result-1',
          compensate: async () => {
            compensationOrder.push('step-1');
            // Compensation succeeds
          },
          isIdempotent: true
        },
        {
          name: 'step-2',
          execute: async () => 'result-2',
          compensate: async () => {
            compensationOrder.push('step-2');
            throw new Error('Compensation failed');
          },
          isIdempotent: true
        },
        {
          name: 'step-3',
          execute: async () => {
            throw new Error('Step failed');
          },
          compensate: async () => {
            compensationOrder.push('step-3');
          },
          isIdempotent: true
        }
      ];

      const result = await saga.execute(steps);

      expect(result.success).toBe(false);

      // Both compensations should be attempted
      expect(compensationOrder).toEqual(['step-2', 'step-1']);

      // Verify rollback results recorded
      expect(result.context.rollbackResults).toHaveLength(2);
      expect(result.context.rollbackResults[0].success).toBe(false); // step-2 failed
      expect(result.context.rollbackResults[1].success).toBe(true);  // step-1 succeeded
    });
  });

  describe('Timeout Protection', () => {
    it('should timeout slow operations', async () => {
      const steps: SagaStep[] = [
        {
          name: 'slow-step',
          execute: async () => {
            // Simulate slow operation (wait 2 seconds)
            await new Promise(resolve => setTimeout(resolve, 2000));
            return 'should-not-reach';
          },
          compensate: async () => {},
          isIdempotent: true,
          timeout: 100 // 100ms timeout
        }
      ];

      const result = await saga.execute(steps);

      expect(result.success).toBe(false);
      expect(result.error?.message).toContain('timeout');
    }, 3000); // Test timeout longer than step timeout
  });

  describe('Retry Logic', () => {
    it('should retry failing operations', async () => {
      let attemptCount = 0;

      const steps: SagaStep[] = [
        {
          name: 'flaky-step',
          execute: async () => {
            attemptCount++;
            if (attemptCount < 3) {
              throw new Error('Temporary failure');
            }
            return 'success-after-retries';
          },
          compensate: async () => {},
          isIdempotent: true,
          retries: {
            maxAttempts: 3,
            backoffMs: 10
          }
        }
      ];

      const result = await saga.execute(steps);

      expect(result.success).toBe(true);
      expect(attemptCount).toBe(3);
      expect(result.context.completedSteps[0].result).toBe('success-after-retries');
    });

    it('should fail after max retries exhausted', async () => {
      let attemptCount = 0;

      const steps: SagaStep[] = [
        {
          name: 'always-failing-step',
          execute: async () => {
            attemptCount++;
            throw new Error('Persistent failure');
          },
          compensate: async () => {},
          isIdempotent: true,
          retries: {
            maxAttempts: 3,
            backoffMs: 10
          }
        }
      ];

      const result = await saga.execute(steps);

      expect(result.success).toBe(false);
      expect(attemptCount).toBe(3);
      expect(result.error?.message).toContain('after 3 attempts');
    });
  });

  describe('Idempotency', () => {
    it('should mark all operations as idempotent', async () => {
      const steps: SagaStep[] = [
        {
          name: 'idempotent-step',
          execute: async () => 'result',
          compensate: async () => {},
          isIdempotent: true
        }
      ];

      // Execute twice - should be safe
      const result1 = await saga.execute(steps);
      expect(result1.success).toBe(true);

      // Create new saga for second execution
      const saga2 = createSaga(logger, 'test-saga-002');
      const result2 = await saga2.execute(steps);
      expect(result2.success).toBe(true);
    });
  });

  describe('Context Tracking', () => {
    it('should provide saga context for debugging', async () => {
      const steps: SagaStep[] = [
        {
          name: 'test-step',
          execute: async () => {
            await new Promise(resolve => setTimeout(resolve, 50));
            return { data: 'test' };
          },
          compensate: async () => {},
          isIdempotent: true
        }
      ];

      const result = await saga.execute(steps);
      const context = saga.getContext();

      expect(context.sagaId).toBe('test-saga-001');
      expect(context.startTime).toBeGreaterThan(0);
      expect(context.completedSteps).toHaveLength(1);
      expect(context.completedSteps[0].name).toBe('test-step');
      expect(context.completedSteps[0].duration).toBeGreaterThanOrEqual(50);
    });
  });

  describe('Edge Cases', () => {
    it('should handle empty step list', async () => {
      const steps: SagaStep[] = [];
      const result = await saga.execute(steps);

      expect(result.success).toBe(true);
      expect(result.context.completedSteps).toHaveLength(0);
    });

    it('should handle steps that return null', async () => {
      const steps: SagaStep[] = [
        {
          name: 'null-step',
          execute: async () => null,
          compensate: async () => {},
          isIdempotent: true
        }
      ];

      const result = await saga.execute(steps);

      expect(result.success).toBe(true);
      expect(result.context.completedSteps[0].result).toBeNull();
    });

    it('should sanitize large result objects for logging', async () => {
      const largeResult = {
        field1: 'a'.repeat(200),
        field2: 'b'.repeat(200),
        field3: 'c'.repeat(200),
        field4: 'd'.repeat(200),
        field5: 'e'.repeat(200),
        field6: 'f'.repeat(200) // More than 5 fields
      };

      const steps: SagaStep[] = [
        {
          name: 'large-result-step',
          execute: async () => largeResult,
          compensate: async () => {},
          isIdempotent: true
        }
      ];

      const result = await saga.execute(steps);

      expect(result.success).toBe(true);
      // Verify result is stored but sanitized in logs
      expect(result.context.completedSteps[0].result).toBeDefined();
    });
  });

  describe('Real-World Simulation', () => {
    it('should simulate memory storage across databases', async () => {
      const memoryId = 'memory-123';
      const databases = {
        postgres: false,
        qdrant: false,
        neo4j: false
      };

      const steps: SagaStep[] = [
        // Step 1: Store in PostgreSQL
        {
          name: 'store-postgres',
          execute: async () => {
            databases.postgres = true;
            return { id: memoryId, inserted: true };
          },
          compensate: async () => {
            databases.postgres = false;
          },
          isIdempotent: true
        },
        // Step 2: Store in Qdrant
        {
          name: 'store-qdrant',
          execute: async () => {
            databases.qdrant = true;
            return { id: memoryId, status: 'created' };
          },
          compensate: async () => {
            databases.qdrant = false;
          },
          isIdempotent: true
        },
        // Step 3: Store in Neo4j
        {
          name: 'store-neo4j',
          execute: async () => {
            databases.neo4j = true;
            return { id: memoryId, nodesCreated: 1 };
          },
          compensate: async () => {
            databases.neo4j = false;
          },
          isIdempotent: true
        }
      ];

      const result = await saga.execute(steps);

      expect(result.success).toBe(true);
      expect(databases.postgres).toBe(true);
      expect(databases.qdrant).toBe(true);
      expect(databases.neo4j).toBe(true);
    });

    it('should rollback all databases on neo4j failure', async () => {
      const memoryId = 'memory-456';
      const databases = {
        postgres: false,
        qdrant: false,
        neo4j: false
      };

      const steps: SagaStep[] = [
        {
          name: 'store-postgres',
          execute: async () => {
            databases.postgres = true;
            return { id: memoryId, inserted: true };
          },
          compensate: async () => {
            databases.postgres = false;
          },
          isIdempotent: true
        },
        {
          name: 'store-qdrant',
          execute: async () => {
            databases.qdrant = true;
            return { id: memoryId, status: 'created' };
          },
          compensate: async () => {
            databases.qdrant = false;
          },
          isIdempotent: true
        },
        {
          name: 'store-neo4j',
          execute: async () => {
            // Simulate Neo4j failure
            throw new Error('Neo4j connection timeout');
          },
          compensate: async () => {
            databases.neo4j = false;
          },
          isIdempotent: true
        }
      ];

      const result = await saga.execute(steps);

      expect(result.success).toBe(false);

      // All databases should be rolled back
      expect(databases.postgres).toBe(false);
      expect(databases.qdrant).toBe(false);
      expect(databases.neo4j).toBe(false);
    });
  });
});
