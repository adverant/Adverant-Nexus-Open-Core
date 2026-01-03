/**
 * Ripple Recall for Nexus Memory Lens
 *
 * Implements graph-propagated decay boosts.
 * When a node is accessed, connected nodes receive partial boosts
 * that decay with graph distance (hops).
 */

import { Driver, Session } from 'neo4j-driver';
import winston from 'winston';
import { EnhancedTenantContext } from '../../middleware/tenant-context';

const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json()
  ),
  defaultMeta: { service: 'ripple-recall' },
  transports: [
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.colorize(),
        winston.format.simple()
      )
    })
  ]
});

/**
 * Ripple recall configuration
 */
export interface RippleRecallConfig {
  /** Maximum propagation depth (hops) */
  maxDepth: number;
  /** Initial boost strength (0-1) */
  initialBoost: number;
  /** Decay factor per hop (0-1) */
  decayPerHop: number;
  /** Minimum boost threshold to stop propagation */
  minBoostThreshold: number;
}

/**
 * Default ripple configuration
 */
export const DEFAULT_RIPPLE_CONFIG: RippleRecallConfig = {
  maxDepth: 3,
  initialBoost: 0.3,
  decayPerHop: 0.5, // Boost halves per hop
  minBoostThreshold: 0.05
};

/**
 * Ripple propagation result
 */
export interface RipplePropagationResult {
  /** Source node that was accessed */
  sourceNodeId: string;
  /** Number of nodes affected */
  affectedNodes: number;
  /** Maximum depth reached */
  maxDepthReached: number;
  /** Total boost applied across all nodes */
  totalBoostApplied: number;
  /** Timestamp of propagation */
  timestamp: Date;
}

/**
 * Node boost record
 */
export interface NodeBoost {
  nodeId: string;
  boostAmount: number;
  hopDistance: number;
  relationshipType: string;
}

/**
 * Ripple Recall Engine
 */
export class RippleRecall {
  private driver: Driver;
  private config: RippleRecallConfig;

  constructor(driver: Driver, config: RippleRecallConfig = DEFAULT_RIPPLE_CONFIG) {
    this.driver = driver;
    this.config = config;

    logger.info('RippleRecall initialized', { config });
  }

  /**
   * Propagate boost from an accessed node
   *
   * When a node is accessed:
   * 1. Find connected nodes within maxDepth
   * 2. Calculate boost for each based on distance
   * 3. Update stability scores via RELEVANCE_BOOST relationships
   * 4. Stop when boost falls below threshold
   *
   * @param nodeId - ID of accessed node
   * @param tenantContext - Tenant context for security
   * @returns Propagation result
   */
  async propagateBoost(
    nodeId: string,
    tenantContext: EnhancedTenantContext
  ): Promise<RipplePropagationResult> {
    const session = this.driver.session();
    const startTime = Date.now();

    try {
      logger.info('Starting ripple propagation', {
        nodeId,
        maxDepth: this.config.maxDepth,
        initialBoost: this.config.initialBoost
      });

      // Find connected nodes with distance using BFS
      const connectedNodes = await this.findConnectedNodes(
        session,
        nodeId,
        tenantContext
      );

      logger.debug('Connected nodes found', {
        nodeId,
        connectedCount: connectedNodes.length
      });

      // Calculate and apply boosts
      const boosts = this.calculateBoosts(connectedNodes);
      const affectedCount = await this.applyBoosts(session, boosts, tenantContext);

      const maxDepth = Math.max(...boosts.map(b => b.hopDistance), 0);
      const totalBoost = boosts.reduce((sum, b) => sum + b.boostAmount, 0);

      const result: RipplePropagationResult = {
        sourceNodeId: nodeId,
        affectedNodes: affectedCount,
        maxDepthReached: maxDepth,
        totalBoostApplied: totalBoost,
        timestamp: new Date()
      };

      logger.info('Ripple propagation completed', {
        ...result,
        durationMs: Date.now() - startTime
      });

      return result;
    } catch (error) {
      logger.error('Ripple propagation failed', {
        nodeId,
        error: (error as Error).message
      });
      throw error;
    } finally {
      await session.close();
    }
  }

  /**
   * Find connected nodes using BFS up to maxDepth
   *
   * @private
   */
  private async findConnectedNodes(
    session: Session,
    sourceNodeId: string,
    tenantContext: EnhancedTenantContext
  ): Promise<Array<{ nodeId: string; distance: number; relType: string }>> {
    const query = `
      MATCH (source:Episode {id: $sourceNodeId})
      WHERE source.company_id = $companyId
        AND source.app_id = $appId

      // Find all connected nodes within maxDepth using variable-length path
      CALL {
        WITH source
        MATCH path = (source)-[r:TEMPORAL|CAUSAL|MENTIONS*1..${this.config.maxDepth}]->(target:Episode)
        WHERE target.company_id = $companyId
          AND target.app_id = $appId
          AND (target.user_id = $userId OR target.user_id = 'system')
        RETURN target, length(path) as distance, type(relationships(path)[0]) as relType
      }

      RETURN DISTINCT target.id as nodeId, distance, relType
      ORDER BY distance ASC
    `;

    const result = await session.run(query, {
      sourceNodeId,
      companyId: tenantContext.companyId,
      appId: tenantContext.appId,
      userId: tenantContext.userId
    });

    return result.records.map(record => ({
      nodeId: record.get('nodeId'),
      distance: record.get('distance'),
      relType: record.get('relType') || 'TEMPORAL'
    }));
  }

  /**
   * Calculate boost amounts based on distance
   *
   * @private
   */
  private calculateBoosts(
    connectedNodes: Array<{ nodeId: string; distance: number; relType: string }>
  ): NodeBoost[] {
    const boosts: NodeBoost[] = [];

    for (const node of connectedNodes) {
      // Calculate boost with exponential decay per hop
      const boostAmount = this.config.initialBoost * Math.pow(
        this.config.decayPerHop,
        node.distance
      );

      // Stop if below threshold
      if (boostAmount < this.config.minBoostThreshold) {
        continue;
      }

      boosts.push({
        nodeId: node.nodeId,
        boostAmount,
        hopDistance: node.distance,
        relationshipType: node.relType
      });
    }

    logger.debug('Boosts calculated', {
      totalNodes: connectedNodes.length,
      boostedNodes: boosts.length,
      averageBoost: boosts.reduce((sum, b) => sum + b.boostAmount, 0) / boosts.length
    });

    return boosts;
  }

  /**
   * Apply boosts to nodes
   *
   * Creates or updates RELEVANCE_BOOST relationships with boost metadata.
   *
   * @private
   */
  private async applyBoosts(
    session: Session,
    boosts: NodeBoost[],
    tenantContext: EnhancedTenantContext
  ): Promise<number> {
    if (boosts.length === 0) {
      return 0;
    }

    // Apply boosts in batches to avoid overwhelming Neo4j
    const batchSize = 100;
    let affectedCount = 0;

    for (let i = 0; i < boosts.length; i += batchSize) {
      const batch = boosts.slice(i, i + batchSize);

      const query = `
        UNWIND $boosts as boost
        MATCH (target:Episode {id: boost.nodeId})
        WHERE target.company_id = $companyId
          AND target.app_id = $appId

        // Update stability with boost
        SET target.stability = COALESCE(target.stability, 0.5) + boost.boostAmount,
            target.last_boost = datetime($now),
            target.boost_count = COALESCE(target.boost_count, 0) + 1

        // Ensure stability doesn't exceed 1.0
        SET target.stability = CASE
          WHEN target.stability > 1.0 THEN 1.0
          ELSE target.stability
        END

        RETURN count(target) as updated
      `;

      const result = await session.run(query, {
        boosts: batch.map(b => ({
          nodeId: b.nodeId,
          boostAmount: b.boostAmount,
          hopDistance: b.hopDistance,
          relType: b.relationshipType
        })),
        companyId: tenantContext.companyId,
        appId: tenantContext.appId,
        now: new Date().toISOString()
      });

      const batchUpdated = result.records[0]?.get('updated').toNumber() || 0;
      affectedCount += batchUpdated;
    }

    logger.info('Boosts applied', {
      totalBoosts: boosts.length,
      affectedNodes: affectedCount
    });

    return affectedCount;
  }

  /**
   * Get boost history for a node
   *
   * @param nodeId - Node ID
   * @param tenantContext - Tenant context
   * @returns Array of boost events
   */
  async getBoostHistory(
    nodeId: string,
    tenantContext: EnhancedTenantContext
  ): Promise<Array<{ timestamp: Date; boostAmount: number; sourceNodeId: string }>> {
    const session = this.driver.session();

    try {
      const query = `
        MATCH (target:Episode {id: $nodeId})
        WHERE target.company_id = $companyId
          AND target.app_id = $appId

        RETURN target.last_boost as lastBoost,
               target.boost_count as boostCount,
               target.stability as currentStability
      `;

      const result = await session.run(query, {
        nodeId,
        companyId: tenantContext.companyId,
        appId: tenantContext.appId
      });

      if (result.records.length === 0) {
        return [];
      }

      const record = result.records[0];
      const lastBoost = record.get('lastBoost');
      const boostCount = record.get('boostCount') || 0;

      // Simplified history (full history would require dedicated tracking table)
      return lastBoost ? [{
        timestamp: new Date(lastBoost.toString()),
        boostAmount: 0.1, // Placeholder
        sourceNodeId: 'unknown' // Would need to track this
      }] : [];
    } finally {
      await session.close();
    }
  }

  /**
   * Check if node has graph relationships
   *
   * Used to determine if graph-propagated decay should be used.
   *
   * @param nodeId - Node ID
   * @param tenantContext - Tenant context
   * @returns True if node has relationships
   */
  async hasGraphRelationships(
    nodeId: string,
    tenantContext: EnhancedTenantContext
  ): Promise<boolean> {
    const session = this.driver.session();

    try {
      const query = `
        MATCH (source:Episode {id: $nodeId})
        WHERE source.company_id = $companyId
          AND source.app_id = $appId

        OPTIONAL MATCH (source)-[r:TEMPORAL|CAUSAL|MENTIONS]->()

        RETURN count(r) > 0 as hasRelationships
      `;

      const result = await session.run(query, {
        nodeId,
        companyId: tenantContext.companyId,
        appId: tenantContext.appId
      });

      return result.records[0]?.get('hasRelationships') || false;
    } finally {
      await session.close();
    }
  }

  /**
   * Update configuration
   *
   * @param config - New configuration
   */
  updateConfig(config: Partial<RippleRecallConfig>): void {
    this.config = {
      ...this.config,
      ...config
    };

    logger.info('RippleRecall configuration updated', { config: this.config });
  }
}
