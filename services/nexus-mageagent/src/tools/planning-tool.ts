/**
 * Planning Tool - Visible, Trackable Execution Plans for GOD-MODE Agent
 *
 * Provides a structured way to create, track, and manage multi-step execution plans
 * with real-time WebSocket updates and Redis persistence.
 *
 * @pattern Repository Pattern (Redis storage)
 * @pattern Observer Pattern (WebSocket events)
 * @pattern State Machine (plan/step lifecycle)
 */

import { EventEmitter } from 'events';
import type { Redis } from 'ioredis';
import { v4 as uuidv4 } from 'uuid';
import { createLogger } from '../utils/logger.js';
import {
  NotFoundError,
  ValidationError,
  OperationError
} from '../utils/errors.js';

const logger = createLogger('PlanningTool');

// ============================================================================
// Type Definitions
// ============================================================================

/**
 * Status of an individual plan step
 */
export type StepStatus = 'pending' | 'in_progress' | 'completed' | 'failed' | 'skipped';

/**
 * Status of the overall execution plan
 */
export type PlanStatus = 'active' | 'completed' | 'failed' | 'cancelled';

/**
 * Individual step within an execution plan
 */
export interface PlanStep {
  /** Unique identifier for the step */
  id: string;
  /** Human-readable description of what this step does */
  description: string;
  /** Current execution status */
  status: StepStatus;
  /** Result or output from step execution */
  result?: string;
  /** Error message if step failed */
  error?: string;
  /** When step execution began */
  startedAt?: Date;
  /** When step execution finished */
  completedAt?: Date;
  /** Step IDs that must complete before this step can start */
  dependencies?: string[];
  /** Additional metadata for the step */
  metadata?: Record<string, any>;
}

/**
 * Complete execution plan with all steps and progress tracking
 */
export interface ExecutionPlan {
  /** Unique identifier for the plan */
  id: string;
  /** User ID who owns this plan */
  userId: string;
  /** High-level goal this plan achieves */
  goal: string;
  /** Ordered list of steps to execute */
  steps: PlanStep[];
  /** Current status of the plan */
  status: PlanStatus;
  /** Progress percentage (0-100) */
  progress: number;
  /** When the plan was created */
  createdAt: Date;
  /** When the plan was last modified */
  updatedAt: Date;
  /** When the plan completed (success or failure) */
  completedAt?: Date;
  /** Final summary when plan completes */
  summary?: string;
  /** Additional plan metadata */
  metadata?: Record<string, any>;
}

/**
 * Input for creating a new step
 */
export interface CreateStepInput {
  description: string;
  dependencies?: string[];
  metadata?: Record<string, any>;
}

/**
 * WebSocket event types emitted by the planning tool
 */
export type PlanEventType =
  | 'plan:created'
  | 'plan:step_started'
  | 'plan:step_completed'
  | 'plan:step_added'
  | 'plan:step_removed'
  | 'plan:completed'
  | 'plan:progress'
  | 'plan:cancelled';

/**
 * WebSocket event payload structure
 */
export interface PlanEvent {
  type: PlanEventType;
  planId: string;
  userId: string;
  timestamp: Date;
  data: {
    plan?: ExecutionPlan;
    step?: PlanStep;
    stepId?: string;
    progress?: number;
    summary?: string;
    success?: boolean;
  };
}

/**
 * MCP Tool Schema for agent integration
 */
export interface MCPToolSchema {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, any>;
    required: string[];
  };
}

/**
 * Configuration options for PlanningTool
 */
export interface PlanningToolConfig {
  /** Redis key prefix for plan storage */
  keyPrefix?: string;
  /** TTL for active plans in seconds (default: 7 days) */
  activePlanTTL?: number;
  /** TTL for completed plans in seconds (default: 24 hours) */
  completedPlanTTL?: number;
  /** Maximum steps per plan */
  maxStepsPerPlan?: number;
  /** Maximum active plans per user */
  maxActivePlansPerUser?: number;
}

// ============================================================================
// Planning Tool Implementation
// ============================================================================

/**
 * PlanningTool - Creates and manages visible, trackable execution plans
 *
 * Features:
 * - Create structured multi-step execution plans
 * - Real-time progress tracking via WebSocket events
 * - Dynamic step addition/removal during execution
 * - Dependency tracking between steps
 * - Redis persistence with TTL
 * - MCP tool registration for agent usage
 */
export class PlanningTool extends EventEmitter {
  private readonly redis: Redis;
  private readonly config: Required<PlanningToolConfig>;

  constructor(redis: Redis, config: PlanningToolConfig = {}) {
    super();

    if (!redis) {
      throw new ValidationError('Redis client is required for PlanningTool', {
        component: 'PlanningTool'
      });
    }

    this.redis = redis;
    this.config = {
      keyPrefix: config.keyPrefix ?? 'nexus:plans',
      activePlanTTL: config.activePlanTTL ?? 7 * 24 * 60 * 60, // 7 days
      completedPlanTTL: config.completedPlanTTL ?? 24 * 60 * 60, // 24 hours
      maxStepsPerPlan: config.maxStepsPerPlan ?? 100,
      maxActivePlansPerUser: config.maxActivePlansPerUser ?? 10
    };

    logger.info('PlanningTool initialized', {
      keyPrefix: this.config.keyPrefix,
      activePlanTTL: this.config.activePlanTTL,
      completedPlanTTL: this.config.completedPlanTTL
    });
  }

  // ==========================================================================
  // Core Plan Management Methods
  // ==========================================================================

  /**
   * Create a new execution plan with the given goal and steps
   *
   * @param userId - User ID who owns the plan
   * @param goal - High-level goal description
   * @param steps - Array of step inputs to create
   * @returns The created ExecutionPlan
   */
  async createPlan(
    userId: string,
    goal: string,
    steps: CreateStepInput[]
  ): Promise<ExecutionPlan> {
    // Validate inputs
    if (!userId?.trim()) {
      throw new ValidationError('User ID is required', { field: 'userId' });
    }
    if (!goal?.trim()) {
      throw new ValidationError('Goal is required', { field: 'goal' });
    }
    if (!steps || steps.length === 0) {
      throw new ValidationError('At least one step is required', { field: 'steps' });
    }
    if (steps.length > this.config.maxStepsPerPlan) {
      throw new ValidationError(
        `Maximum ${this.config.maxStepsPerPlan} steps allowed per plan`,
        { field: 'steps', maxSteps: this.config.maxStepsPerPlan }
      );
    }

    // Check active plan limit for user
    const activePlans = await this.getActivePlans(userId);
    if (activePlans.length >= this.config.maxActivePlansPerUser) {
      throw new OperationError(
        `User has reached maximum active plans limit (${this.config.maxActivePlansPerUser})`,
        { userId, activeCount: activePlans.length }
      );
    }

    // Create plan structure
    const planId = uuidv4();
    const now = new Date();

    const planSteps: PlanStep[] = steps.map((step, index) => ({
      id: `step_${index}_${uuidv4().slice(0, 8)}`,
      description: step.description,
      status: 'pending' as StepStatus,
      dependencies: step.dependencies,
      metadata: step.metadata
    }));

    // Validate dependencies reference valid step IDs
    const stepIds = new Set(planSteps.map(s => s.id));
    for (const step of planSteps) {
      if (step.dependencies) {
        for (const depId of step.dependencies) {
          if (!stepIds.has(depId)) {
            throw new ValidationError(
              `Step ${step.id} references non-existent dependency ${depId}`,
              { stepId: step.id, invalidDependency: depId }
            );
          }
        }
      }
    }

    const plan: ExecutionPlan = {
      id: planId,
      userId,
      goal,
      steps: planSteps,
      status: 'active',
      progress: 0,
      createdAt: now,
      updatedAt: now
    };

    // Save to Redis
    await this.savePlan(plan);

    // Add to user's active plans index
    await this.redis.sadd(this.getUserPlansKey(userId), planId);

    // Emit WebSocket event
    this.emitPlanEvent({
      type: 'plan:created',
      planId,
      userId,
      timestamp: now,
      data: { plan }
    });

    logger.info('Plan created', {
      planId,
      userId,
      goal,
      stepCount: planSteps.length
    });

    return plan;
  }

  /**
   * Update the status of a specific step
   *
   * @param planId - Plan ID containing the step
   * @param stepId - Step ID to update
   * @param status - New status for the step
   * @param result - Optional result/output from the step
   * @returns Updated plan
   */
  async updateStep(
    planId: string,
    stepId: string,
    status: StepStatus,
    result?: string
  ): Promise<ExecutionPlan> {
    const plan = await this.getPlan(planId);
    if (!plan) {
      throw new NotFoundError(`Plan ${planId} not found`, { planId });
    }

    const stepIndex = plan.steps.findIndex(s => s.id === stepId);
    if (stepIndex === -1) {
      throw new NotFoundError(`Step ${stepId} not found in plan ${planId}`, {
        planId,
        stepId
      });
    }

    const step = plan.steps[stepIndex];
    const previousStatus = step.status;
    const now = new Date();

    // Validate state transitions
    this.validateStepTransition(step, status);

    // Check dependencies for starting a step
    if (status === 'in_progress') {
      this.validateDependencies(plan, step);
    }

    // Update step
    step.status = status;
    if (result !== undefined) {
      if (status === 'failed') {
        step.error = result;
      } else {
        step.result = result;
      }
    }

    // Update timestamps
    if (status === 'in_progress' && !step.startedAt) {
      step.startedAt = now;
    }
    if (['completed', 'failed', 'skipped'].includes(status)) {
      step.completedAt = now;
    }

    // Recalculate progress
    plan.progress = this.calculateProgress(plan);
    plan.updatedAt = now;

    // Save updated plan
    await this.savePlan(plan);

    // Emit appropriate event
    if (status === 'in_progress' && previousStatus !== 'in_progress') {
      this.emitPlanEvent({
        type: 'plan:step_started',
        planId,
        userId: plan.userId,
        timestamp: now,
        data: { plan, step, stepId }
      });
    } else {
      this.emitPlanEvent({
        type: 'plan:step_completed',
        planId,
        userId: plan.userId,
        timestamp: now,
        data: { plan, step, stepId }
      });
    }

    // Also emit progress update
    this.emitPlanEvent({
      type: 'plan:progress',
      planId,
      userId: plan.userId,
      timestamp: now,
      data: { plan, progress: plan.progress }
    });

    logger.info('Step updated', {
      planId,
      stepId,
      status,
      progress: plan.progress
    });

    return plan;
  }

  /**
   * Dynamically add a step to an existing plan
   *
   * @param planId - Plan ID to add step to
   * @param description - Step description
   * @param afterStepId - Optional step ID to insert after
   * @returns Updated plan with new step
   */
  async addStep(
    planId: string,
    description: string,
    afterStepId?: string
  ): Promise<ExecutionPlan> {
    const plan = await this.getPlan(planId);
    if (!plan) {
      throw new NotFoundError(`Plan ${planId} not found`, { planId });
    }

    if (plan.status !== 'active') {
      throw new OperationError('Cannot add steps to a non-active plan', {
        planId,
        status: plan.status
      });
    }

    if (plan.steps.length >= this.config.maxStepsPerPlan) {
      throw new OperationError(
        `Maximum ${this.config.maxStepsPerPlan} steps allowed per plan`,
        { planId, currentSteps: plan.steps.length }
      );
    }

    const newStep: PlanStep = {
      id: `step_${plan.steps.length}_${uuidv4().slice(0, 8)}`,
      description,
      status: 'pending'
    };

    const now = new Date();

    // Insert at appropriate position
    if (afterStepId) {
      const afterIndex = plan.steps.findIndex(s => s.id === afterStepId);
      if (afterIndex === -1) {
        throw new NotFoundError(`Step ${afterStepId} not found`, {
          planId,
          afterStepId
        });
      }
      plan.steps.splice(afterIndex + 1, 0, newStep);
    } else {
      plan.steps.push(newStep);
    }

    // Recalculate progress (adding a step may reduce percentage)
    plan.progress = this.calculateProgress(plan);
    plan.updatedAt = now;

    // Save updated plan
    await this.savePlan(plan);

    // Emit event
    this.emitPlanEvent({
      type: 'plan:step_added',
      planId,
      userId: plan.userId,
      timestamp: now,
      data: { plan, step: newStep, stepId: newStep.id }
    });

    logger.info('Step added', {
      planId,
      stepId: newStep.id,
      description,
      afterStepId
    });

    return plan;
  }

  /**
   * Remove a step from an existing plan
   *
   * @param planId - Plan ID containing the step
   * @param stepId - Step ID to remove
   * @returns Updated plan
   */
  async removeStep(planId: string, stepId: string): Promise<ExecutionPlan> {
    const plan = await this.getPlan(planId);
    if (!plan) {
      throw new NotFoundError(`Plan ${planId} not found`, { planId });
    }

    if (plan.status !== 'active') {
      throw new OperationError('Cannot remove steps from a non-active plan', {
        planId,
        status: plan.status
      });
    }

    const stepIndex = plan.steps.findIndex(s => s.id === stepId);
    if (stepIndex === -1) {
      throw new NotFoundError(`Step ${stepId} not found in plan ${planId}`, {
        planId,
        stepId
      });
    }

    const step = plan.steps[stepIndex];

    // Cannot remove in-progress steps
    if (step.status === 'in_progress') {
      throw new OperationError('Cannot remove an in-progress step', {
        planId,
        stepId,
        status: step.status
      });
    }

    // Check if other steps depend on this one
    const dependentSteps = plan.steps.filter(
      s => s.dependencies?.includes(stepId)
    );
    if (dependentSteps.length > 0) {
      throw new OperationError('Cannot remove step with dependencies', {
        planId,
        stepId,
        dependentStepIds: dependentSteps.map(s => s.id)
      });
    }

    const now = new Date();

    // Remove the step
    plan.steps.splice(stepIndex, 1);

    // Recalculate progress
    plan.progress = this.calculateProgress(plan);
    plan.updatedAt = now;

    // Save updated plan
    await this.savePlan(plan);

    // Emit event
    this.emitPlanEvent({
      type: 'plan:step_removed',
      planId,
      userId: plan.userId,
      timestamp: now,
      data: { plan, stepId }
    });

    logger.info('Step removed', { planId, stepId });

    return plan;
  }

  /**
   * Get a plan by ID
   *
   * @param planId - Plan ID to retrieve
   * @returns The plan or null if not found
   */
  async getPlan(planId: string): Promise<ExecutionPlan | null> {
    const key = this.getPlanKey(planId);
    const data = await this.redis.get(key);

    if (!data) {
      return null;
    }

    try {
      return this.deserializePlan(data);
    } catch (error) {
      logger.error('Failed to deserialize plan', {
        planId,
        error: error instanceof Error ? error.message : String(error)
      });
      return null;
    }
  }

  /**
   * Get all active plans for a user
   *
   * @param userId - User ID to get plans for
   * @returns Array of active plans
   */
  async getActivePlans(userId: string): Promise<ExecutionPlan[]> {
    const planIds = await this.redis.smembers(this.getUserPlansKey(userId));

    const plans: ExecutionPlan[] = [];
    for (const planId of planIds) {
      const plan = await this.getPlan(planId);
      if (plan && plan.status === 'active') {
        plans.push(plan);
      }
    }

    return plans;
  }

  /**
   * Mark a plan as complete
   *
   * @param planId - Plan ID to complete
   * @param success - Whether the plan succeeded
   * @param summary - Summary of the plan execution
   * @returns The completed plan
   */
  async markComplete(
    planId: string,
    success: boolean,
    summary: string
  ): Promise<ExecutionPlan> {
    const plan = await this.getPlan(planId);
    if (!plan) {
      throw new NotFoundError(`Plan ${planId} not found`, { planId });
    }

    if (plan.status !== 'active') {
      throw new OperationError('Plan is already completed or cancelled', {
        planId,
        status: plan.status
      });
    }

    const now = new Date();

    // Update plan status
    plan.status = success ? 'completed' : 'failed';
    plan.progress = success ? 100 : plan.progress;
    plan.completedAt = now;
    plan.updatedAt = now;
    plan.summary = summary;

    // Save with shorter TTL for completed plans
    await this.savePlan(plan, this.config.completedPlanTTL);

    // Remove from user's active plans index
    await this.redis.srem(this.getUserPlansKey(plan.userId), planId);

    // Emit event
    this.emitPlanEvent({
      type: 'plan:completed',
      planId,
      userId: plan.userId,
      timestamp: now,
      data: { plan, success, summary }
    });

    logger.info('Plan completed', {
      planId,
      userId: plan.userId,
      success,
      summary
    });

    return plan;
  }

  /**
   * Cancel an active plan
   *
   * @param planId - Plan ID to cancel
   * @param reason - Reason for cancellation
   * @returns The cancelled plan
   */
  async cancelPlan(planId: string, reason: string): Promise<ExecutionPlan> {
    const plan = await this.getPlan(planId);
    if (!plan) {
      throw new NotFoundError(`Plan ${planId} not found`, { planId });
    }

    if (plan.status !== 'active') {
      throw new OperationError('Can only cancel active plans', {
        planId,
        status: plan.status
      });
    }

    const now = new Date();

    // Update plan status
    plan.status = 'cancelled';
    plan.completedAt = now;
    plan.updatedAt = now;
    plan.summary = `Cancelled: ${reason}`;

    // Mark any pending/in-progress steps as skipped
    for (const step of plan.steps) {
      if (step.status === 'pending' || step.status === 'in_progress') {
        step.status = 'skipped';
        step.completedAt = now;
      }
    }

    // Save with shorter TTL
    await this.savePlan(plan, this.config.completedPlanTTL);

    // Remove from user's active plans index
    await this.redis.srem(this.getUserPlansKey(plan.userId), planId);

    // Emit event
    this.emitPlanEvent({
      type: 'plan:cancelled',
      planId,
      userId: plan.userId,
      timestamp: now,
      data: { plan, summary: plan.summary }
    });

    logger.info('Plan cancelled', { planId, reason });

    return plan;
  }

  // ==========================================================================
  // MCP Tool Registration
  // ==========================================================================

  /**
   * Get MCP tool schemas for agent registration
   *
   * @returns Array of MCP tool schemas
   */
  getMCPToolSchemas(): MCPToolSchema[] {
    return [
      {
        name: 'planning_create_plan',
        description:
          'Create a new execution plan with a goal and ordered steps. Use this to outline multi-step tasks before executing them.',
        inputSchema: {
          type: 'object',
          properties: {
            goal: {
              type: 'string',
              description: 'The high-level goal or objective this plan achieves'
            },
            steps: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  description: {
                    type: 'string',
                    description: 'Clear description of what this step accomplishes'
                  },
                  dependencies: {
                    type: 'array',
                    items: { type: 'string' },
                    description: 'IDs of steps that must complete before this one'
                  }
                },
                required: ['description']
              },
              description: 'Ordered list of steps to execute'
            }
          },
          required: ['goal', 'steps']
        }
      },
      {
        name: 'planning_update_step',
        description:
          'Update the status of a plan step. Use when starting, completing, or failing a step.',
        inputSchema: {
          type: 'object',
          properties: {
            planId: {
              type: 'string',
              description: 'ID of the plan containing the step'
            },
            stepId: {
              type: 'string',
              description: 'ID of the step to update'
            },
            status: {
              type: 'string',
              enum: ['pending', 'in_progress', 'completed', 'failed', 'skipped'],
              description: 'New status for the step'
            },
            result: {
              type: 'string',
              description: 'Result output or error message for the step'
            }
          },
          required: ['planId', 'stepId', 'status']
        }
      },
      {
        name: 'planning_add_step',
        description:
          'Add a new step to an existing plan. Use when you discover additional work is needed.',
        inputSchema: {
          type: 'object',
          properties: {
            planId: {
              type: 'string',
              description: 'ID of the plan to add the step to'
            },
            description: {
              type: 'string',
              description: 'Description of the new step'
            },
            afterStepId: {
              type: 'string',
              description: 'Insert the new step after this step ID (optional)'
            }
          },
          required: ['planId', 'description']
        }
      },
      {
        name: 'planning_remove_step',
        description:
          'Remove a step from an existing plan. Use when a step is no longer needed.',
        inputSchema: {
          type: 'object',
          properties: {
            planId: {
              type: 'string',
              description: 'ID of the plan containing the step'
            },
            stepId: {
              type: 'string',
              description: 'ID of the step to remove'
            }
          },
          required: ['planId', 'stepId']
        }
      },
      {
        name: 'planning_get_plan',
        description:
          'Get the current state of a plan including all steps and progress.',
        inputSchema: {
          type: 'object',
          properties: {
            planId: {
              type: 'string',
              description: 'ID of the plan to retrieve'
            }
          },
          required: ['planId']
        }
      },
      {
        name: 'planning_complete_plan',
        description:
          'Mark a plan as complete with a final summary. Use when all steps are done.',
        inputSchema: {
          type: 'object',
          properties: {
            planId: {
              type: 'string',
              description: 'ID of the plan to complete'
            },
            success: {
              type: 'boolean',
              description: 'Whether the plan succeeded overall'
            },
            summary: {
              type: 'string',
              description: 'Summary of what was accomplished'
            }
          },
          required: ['planId', 'success', 'summary']
        }
      }
    ];
  }

  /**
   * Execute an MCP tool call
   *
   * @param toolName - Name of the tool to execute
   * @param userId - User ID making the call
   * @param args - Tool arguments
   * @returns Tool execution result
   */
  async executeMCPTool(
    toolName: string,
    userId: string,
    args: Record<string, any>
  ): Promise<any> {
    switch (toolName) {
      case 'planning_create_plan':
        return this.createPlan(userId, args.goal, args.steps);

      case 'planning_update_step':
        return this.updateStep(args.planId, args.stepId, args.status, args.result);

      case 'planning_add_step':
        return this.addStep(args.planId, args.description, args.afterStepId);

      case 'planning_remove_step':
        return this.removeStep(args.planId, args.stepId);

      case 'planning_get_plan':
        const plan = await this.getPlan(args.planId);
        if (!plan) {
          throw new NotFoundError(`Plan ${args.planId} not found`);
        }
        return plan;

      case 'planning_complete_plan':
        return this.markComplete(args.planId, args.success, args.summary);

      default:
        throw new ValidationError(`Unknown planning tool: ${toolName}`, {
          toolName,
          availableTools: this.getMCPToolSchemas().map(s => s.name)
        });
    }
  }

  // ==========================================================================
  // Private Helper Methods
  // ==========================================================================

  /**
   * Generate Redis key for a plan
   */
  private getPlanKey(planId: string): string {
    return `${this.config.keyPrefix}:${planId}`;
  }

  /**
   * Generate Redis key for user's plans index
   */
  private getUserPlansKey(userId: string): string {
    return `${this.config.keyPrefix}:user:${userId}`;
  }

  /**
   * Save a plan to Redis
   */
  private async savePlan(plan: ExecutionPlan, ttl?: number): Promise<void> {
    const key = this.getPlanKey(plan.id);
    const serialized = this.serializePlan(plan);
    const expiry = ttl ?? this.config.activePlanTTL;

    await this.redis.setex(key, expiry, serialized);
  }

  /**
   * Serialize a plan for Redis storage
   */
  private serializePlan(plan: ExecutionPlan): string {
    return JSON.stringify({
      ...plan,
      createdAt: plan.createdAt.toISOString(),
      updatedAt: plan.updatedAt.toISOString(),
      completedAt: plan.completedAt?.toISOString(),
      steps: plan.steps.map(step => ({
        ...step,
        startedAt: step.startedAt?.toISOString(),
        completedAt: step.completedAt?.toISOString()
      }))
    });
  }

  /**
   * Deserialize a plan from Redis storage
   */
  private deserializePlan(data: string): ExecutionPlan {
    const parsed = JSON.parse(data);
    return {
      ...parsed,
      createdAt: new Date(parsed.createdAt),
      updatedAt: new Date(parsed.updatedAt),
      completedAt: parsed.completedAt ? new Date(parsed.completedAt) : undefined,
      steps: parsed.steps.map((step: any) => ({
        ...step,
        startedAt: step.startedAt ? new Date(step.startedAt) : undefined,
        completedAt: step.completedAt ? new Date(step.completedAt) : undefined
      }))
    };
  }

  /**
   * Calculate progress percentage based on step statuses
   */
  private calculateProgress(plan: ExecutionPlan): number {
    if (plan.steps.length === 0) return 0;

    const completedSteps = plan.steps.filter(
      s => s.status === 'completed' || s.status === 'skipped'
    ).length;

    return Math.round((completedSteps / plan.steps.length) * 100);
  }

  /**
   * Validate step status transition
   */
  private validateStepTransition(step: PlanStep, newStatus: StepStatus): void {
    const validTransitions: Record<StepStatus, StepStatus[]> = {
      pending: ['in_progress', 'skipped'],
      in_progress: ['completed', 'failed', 'skipped'],
      completed: [], // Terminal state
      failed: ['pending', 'in_progress'], // Allow retry
      skipped: ['pending'] // Allow unskip
    };

    if (!validTransitions[step.status].includes(newStatus)) {
      throw new OperationError(
        `Invalid step transition from ${step.status} to ${newStatus}`,
        {
          stepId: step.id,
          currentStatus: step.status,
          requestedStatus: newStatus,
          validTransitions: validTransitions[step.status]
        }
      );
    }
  }

  /**
   * Validate that all dependencies are completed before starting a step
   */
  private validateDependencies(plan: ExecutionPlan, step: PlanStep): void {
    if (!step.dependencies || step.dependencies.length === 0) return;

    const incompleteDepIds: string[] = [];

    for (const depId of step.dependencies) {
      const depStep = plan.steps.find(s => s.id === depId);
      if (!depStep || depStep.status !== 'completed') {
        incompleteDepIds.push(depId);
      }
    }

    if (incompleteDepIds.length > 0) {
      throw new OperationError(
        'Cannot start step - dependencies not completed',
        {
          stepId: step.id,
          incompleteDependencies: incompleteDepIds
        }
      );
    }
  }

  /**
   * Emit a plan event to all listeners
   */
  private emitPlanEvent(event: PlanEvent): void {
    this.emit(event.type, event);
    this.emit('plan:event', event); // Generic event for broadcasting
  }

  // ==========================================================================
  // Cleanup Methods
  // ==========================================================================

  /**
   * Clean up expired plans for a user
   * (Called periodically or on demand)
   */
  async cleanupUserPlans(userId: string): Promise<number> {
    const planIds = await this.redis.smembers(this.getUserPlansKey(userId));
    let cleaned = 0;

    for (const planId of planIds) {
      const exists = await this.redis.exists(this.getPlanKey(planId));
      if (!exists) {
        await this.redis.srem(this.getUserPlansKey(userId), planId);
        cleaned++;
      }
    }

    if (cleaned > 0) {
      logger.info('Cleaned up expired plan references', { userId, cleaned });
    }

    return cleaned;
  }

  /**
   * Shutdown and cleanup
   */
  async shutdown(): Promise<void> {
    this.removeAllListeners();
    logger.info('PlanningTool shutdown complete');
  }
}

// ============================================================================
// Factory Functions
// ============================================================================

/**
 * Create a new PlanningTool instance
 */
export function createPlanningTool(
  redis: Redis,
  config?: PlanningToolConfig
): PlanningTool {
  return new PlanningTool(redis, config);
}

// ============================================================================
// Singleton Management (optional)
// ============================================================================

let planningToolInstance: PlanningTool | null = null;

/**
 * Initialize the global PlanningTool instance
 */
export function initializePlanningTool(
  redis: Redis,
  config?: PlanningToolConfig
): PlanningTool {
  if (!planningToolInstance) {
    planningToolInstance = new PlanningTool(redis, config);
  }
  return planningToolInstance;
}

/**
 * Get the global PlanningTool instance
 */
export function getPlanningTool(): PlanningTool {
  if (!planningToolInstance) {
    throw new Error('PlanningTool not initialized. Call initializePlanningTool first.');
  }
  return planningToolInstance;
}

/**
 * Destroy the global PlanningTool instance
 */
export async function destroyPlanningTool(): Promise<void> {
  if (planningToolInstance) {
    await planningToolInstance.shutdown();
    planningToolInstance = null;
  }
}
