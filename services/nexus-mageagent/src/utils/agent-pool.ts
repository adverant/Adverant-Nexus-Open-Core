import { Agent, AgentState } from '../agents/base-agent';
import { logger } from './logger';

interface PooledAgent {
  agent: Agent;
  lastUsed: Date;
  createdAt: Date;
  usageCount: number;
}

export class AgentPool {
  private agents = new Map<string, PooledAgent>();
  private readonly maxAgents: number;
  private readonly maxAgentAge: number; // milliseconds
  private readonly maxIdleTime: number; // milliseconds
  private cleanupInterval: NodeJS.Timeout | null = null;
  private aggressiveCleanupInterval: NodeJS.Timeout | null = null;
  private memoryPressure = false;

  constructor(
    maxAgents: number = 100,
    maxAgentAge: number = 3600000, // 1 hour
    maxIdleTime: number = 600000 // 10 minutes
  ) {
    this.maxAgents = maxAgents;
    this.maxAgentAge = maxAgentAge;
    this.maxIdleTime = maxIdleTime;

    // Start cleanup timer
    this.startCleanupTimer();
  }

  private startCleanupTimer(): void {
    // Regular cleanup every 30 seconds
    this.cleanupInterval = setInterval(() => {
      this.cleanup();
    }, 30000);

    // Aggressive cleanup every 5 seconds when under memory pressure
    this.aggressiveCleanupInterval = setInterval(() => {
      this.checkMemoryPressure();
      if (this.memoryPressure) {
        this.aggressiveCleanup();
      }
    }, 5000);
  }

  private checkMemoryPressure(): void {
    const used = process.memoryUsage();
    const heapUsedMB = used.heapUsed / 1024 / 1024;
    const heapUsedPercent = (used.heapUsed / used.heapTotal) * 100;

    // Check absolute memory usage instead of percentage
    // Only consider memory pressure if we're using > 1200MB (out of 1536MB)
    this.memoryPressure = heapUsedMB > 1200;

    if (this.memoryPressure) {
      logger.warn('Memory pressure detected', {
        heapUsedPercent: heapUsedPercent.toFixed(2),
        heapUsed: heapUsedMB.toFixed(2) + ' MB',
        heapTotal: (used.heapTotal / 1024 / 1024).toFixed(2) + ' MB'
      });
    }
  }

  private async aggressiveCleanup(): Promise<void> {
    const now = new Date().getTime();
    const toRemove: string[] = [];

    for (const [agentId, pooledAgent] of this.agents) {
      // More aggressive cleanup under memory pressure
      const idleTime = now - pooledAgent.lastUsed.getTime();

      // Remove if idle for more than 30 seconds under pressure
      if (idleTime > 30000 && pooledAgent.agent.state === AgentState.IDLE) {
        toRemove.push(agentId);
      }

      // Always remove errored or terminated agents immediately
      if (pooledAgent.agent.state === AgentState.ERROR ||
          pooledAgent.agent.state === AgentState.TERMINATED) {
        toRemove.push(agentId);
      }
    }

    // Process removals sequentially to ensure proper cleanup
    for (const agentId of toRemove) {
      await this.remove(agentId);
    }

    // Force garbage collection if available (requires --expose-gc flag)
    if (global.gc && this.memoryPressure) {
      global.gc();
      logger.info('Forced garbage collection due to memory pressure');
    }

    if (toRemove.length > 0) {
      logger.info('Aggressive cleanup completed', {
        removed: toRemove.length,
        remaining: this.agents.size,
        memoryPressure: this.memoryPressure
      });
    }
  }

  async add(agent: Agent): Promise<void> {
    // Check if we're at capacity
    if (this.agents.size >= this.maxAgents) {
      // Remove oldest unused agent with proper disposal
      await this.evictOldestUnused();
    }

    this.agents.set(agent.id, {
      agent,
      lastUsed: new Date(),
      createdAt: new Date(),
      usageCount: 0
    });

    logger.debug('Agent added to pool', {
      agentId: agent.id,
      poolSize: this.agents.size
    });
  }

  get(agentId: string): Agent | null {
    const pooledAgent = this.agents.get(agentId);
    if (!pooledAgent) return null;

    // Update last used time
    pooledAgent.lastUsed = new Date();
    pooledAgent.usageCount++;

    return pooledAgent.agent;
  }

  async remove(agentId: string): Promise<void> {
    const pooledAgent = this.agents.get(agentId);
    if (!pooledAgent) return;

    // Cleanup agent resources using dispose pattern
    await this._cleanupAgentResources(pooledAgent.agent);

    this.agents.delete(agentId);
    logger.debug('Agent removed from pool', {
      agentId,
      poolSize: this.agents.size
    });
  }

  private async cleanup(): Promise<void> {
    const now = new Date().getTime();
    const toRemove: string[] = [];

    for (const [agentId, pooledAgent] of this.agents) {
      const age = now - pooledAgent.createdAt.getTime();
      const idleTime = now - pooledAgent.lastUsed.getTime();

      // Adjust thresholds based on memory pressure
      const maxAge = this.memoryPressure ? this.maxAgentAge / 2 : this.maxAgentAge;
      const maxIdle = this.memoryPressure ? this.maxIdleTime / 2 : this.maxIdleTime;

      // Remove if too old or idle too long
      if (age > maxAge || idleTime > maxIdle) {
        toRemove.push(agentId);
      }

      // Remove if agent is in error or terminated state
      if (pooledAgent.agent.state === AgentState.ERROR ||
          pooledAgent.agent.state === AgentState.TERMINATED) {
        toRemove.push(agentId);
      }
    }

    // Process removals sequentially to avoid race conditions
    for (const agentId of toRemove) {
      await this.remove(agentId);
    }

    if (toRemove.length > 0) {
      logger.info('Agent pool cleanup completed', {
        removed: toRemove.length,
        remaining: this.agents.size
      });
    }
  }

  private async evictOldestUnused(): Promise<void> {
    let oldestId: string | null = null;
    let oldestTime = new Date();

    for (const [agentId, pooledAgent] of this.agents) {
      if (pooledAgent.agent.state === AgentState.IDLE &&
          pooledAgent.lastUsed < oldestTime) {
        oldestId = agentId;
        oldestTime = pooledAgent.lastUsed;
      }
    }

    if (oldestId) {
      await this.remove(oldestId);
    }
  }

  public async cleanupAgent(agentId: string): Promise<void> {
    const pooledAgent = this.agents.get(agentId);
    if (pooledAgent) {
      await this._cleanupAgentResources(pooledAgent.agent);
      await this.remove(agentId);
    }
  }

  private async _cleanupAgentResources(agent: Agent): Promise<void> {
    try {
      // PHASE 1 FIX: Use Dispose Pattern for comprehensive cleanup
      // The dispose() method handles:
      // - Removing ALL event listeners (prevents memory leaks)
      // - Clearing cached data (frees memory)
      // - Nulling task references (allows GC)
      // - Agent-specific cleanup via performCleanup() hook

      if ('dispose' in agent && typeof agent.dispose === 'function') {
        await agent.dispose();
        logger.debug('Agent disposed via dispose pattern', { agentId: agent.id });
      } else {
        // Fallback for agents that don't implement Disposable (shouldn't happen)
        logger.warn('Agent does not implement Disposable interface, using manual cleanup', {
          agentId: agent.id,
          hasDisposeMethod: 'dispose' in agent
        });

        // Manual cleanup as fallback
        if (agent.task) {
          agent.task = null;
        }
        agent.competitionGroup = undefined;
        agent.collaborationGroup = undefined;

        if ('memory' in agent) {
          (agent as any).memory = null;
        }
        if ('context' in agent) {
          (agent as any).context = null;
        }
        if ('result' in agent) {
          (agent as any).result = null;
        }

        agent.state = AgentState.TERMINATED;
      }

      logger.debug('Agent cleanup completed', { agentId: agent.id });
    } catch (error) {
      logger.error('Error cleaning up agent', {
        agentId: agent.id,
        error: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  }

  getActiveAgents(): Agent[] {
    const active: Agent[] = [];

    for (const pooledAgent of this.agents.values()) {
      if (pooledAgent.agent.state === AgentState.WORKING ||
          pooledAgent.agent.state === AgentState.IDLE) {
        active.push(pooledAgent.agent);
      }
    }

    return active;
  }

  getMetrics(): {
    total: number;
    active: number;
    idle: number;
    error: number;
    avgUsageCount: number;
    avgAge: number;
  } {
    const metrics = {
      total: this.agents.size,
      active: 0,
      idle: 0,
      error: 0,
      avgUsageCount: 0,
      avgAge: 0
    };

    const now = new Date().getTime();
    let totalUsage = 0;
    let totalAge = 0;

    for (const pooledAgent of this.agents.values()) {
      switch (pooledAgent.agent.state) {
        case AgentState.WORKING:
          metrics.active++;
          break;
        case AgentState.IDLE:
          metrics.idle++;
          break;
        case AgentState.ERROR:
          metrics.error++;
          break;
        case AgentState.TERMINATED:
          break;
      }

      totalUsage += pooledAgent.usageCount;
      totalAge += now - pooledAgent.createdAt.getTime();
    }

    if (metrics.total > 0) {
      metrics.avgUsageCount = totalUsage / metrics.total;
      metrics.avgAge = totalAge / metrics.total;
    }

    return metrics;
  }

  async destroy(): Promise<void> {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }

    if (this.aggressiveCleanupInterval) {
      clearInterval(this.aggressiveCleanupInterval);
      this.aggressiveCleanupInterval = null;
    }

    // Clean up all agents with proper disposal
    for (const agentId of this.agents.keys()) {
      await this.remove(agentId);
    }

    // Force cleanup
    this.agents.clear();

    logger.info('Agent pool destroyed');
  }
}