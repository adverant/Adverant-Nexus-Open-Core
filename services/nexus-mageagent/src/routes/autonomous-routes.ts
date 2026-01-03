/**
 * Autonomous Execution Routes
 *
 * Exposes the autonomous execution modules via HTTP endpoints:
 * - Goal definition and tracking (GoalTracker)
 * - Execution planning (TaskDecompositionAgent)
 * - Reflection and self-assessment (ReflectionEngine)
 * - Replanning (TaskDecompositionAgent.replan())
 * - Goal evaluation (GoalTracker.evaluateProgress())
 *
 * These endpoints are called by nexus-gateway's autonomous-bridge.ts
 * to enable Manus.ai-style autonomous task execution.
 */

import { Router, Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { asyncHandler } from '../middleware/error-handler.js';
import { ValidationError, ErrorFactory } from '../utils/errors.js';
import { logger } from '../utils/logger.js';
import { extractTenantContext } from '../middleware/tenant-context.js';

// Autonomous module imports
import {
  GoalTracker,
  Goal,
  StepResult,
} from '../autonomous/goal-tracker.js';
import {
  ReflectionEngine,
  ExecutionPlan,
} from '../autonomous/reflection-engine.js';
import {
  PatternLearner,
} from '../autonomous/pattern-learner.js';
import { TaskDecompositionAgent } from '../agents/task-decomposition-agent.js';

// GOD-MODE tool imports for autonomous agent execution
import type { PlanningTool } from '../tools/planning-tool.js';
import type { HumanInputTool } from '../tools/human-input-tool.js';
import type { VisionAnalyzer } from '../services/vision-analyzer.js';

const autonomousRouter = Router();

// Dependency container (set during initialization)
let goalTracker: GoalTracker | null = null;
let reflectionEngine: ReflectionEngine | null = null;
let patternLearner: PatternLearner | null = null;
let taskDecomposer: TaskDecompositionAgent | null = null;

// GOD-MODE tools container
let planningTool: PlanningTool | null = null;
let humanInputTool: HumanInputTool | null = null;
let visionAnalyzer: VisionAnalyzer | null = null;

/**
 * Autonomous Routes Configuration Interface
 * Includes core autonomous modules and GOD-MODE tools
 */
export interface AutonomousRoutesConfig {
  // Core autonomous modules
  goalTracker: GoalTracker;
  reflectionEngine: ReflectionEngine;
  patternLearner: PatternLearner;
  taskDecomposer: TaskDecompositionAgent;
  // GOD-MODE tools (optional - initialized after WebSocket manager)
  planningTool?: PlanningTool | null;
  humanInputTool?: HumanInputTool | null;
  visionAnalyzer?: VisionAnalyzer | null;
}

/**
 * Initialize autonomous routes with dependencies
 */
export function initializeAutonomousRoutes(deps: AutonomousRoutesConfig): void {
  goalTracker = deps.goalTracker;
  reflectionEngine = deps.reflectionEngine;
  patternLearner = deps.patternLearner;
  taskDecomposer = deps.taskDecomposer;

  // Initialize GOD-MODE tools
  planningTool = deps.planningTool ?? null;
  humanInputTool = deps.humanInputTool ?? null;
  visionAnalyzer = deps.visionAnalyzer ?? null;

  logger.info('Autonomous routes initialized', {
    endpoints: [
      'POST /api/autonomous/define-goal',
      'POST /api/autonomous/create-plan',
      'POST /api/autonomous/reflect',
      'POST /api/autonomous/replan',
      'POST /api/autonomous/evaluate',
    ],
    godModeTools: {
      planningTool: planningTool ? 'enabled' : 'disabled',
      humanInputTool: humanInputTool ? 'enabled' : 'disabled',
      visionAnalyzer: visionAnalyzer ? 'enabled' : 'disabled',
    },
  });
}

/**
 * Update GOD-MODE tools after WebSocket initialization
 * Called to set HumanInputTool which requires WebSocket callback
 */
export function updateGodModeTools(tools: {
  humanInputTool?: HumanInputTool | null;
}): void {
  if (tools.humanInputTool !== undefined) {
    humanInputTool = tools.humanInputTool;
    logger.info('GOD-MODE: HumanInputTool updated in autonomous routes');
  }
}

/**
 * Get GOD-MODE tools for external use (e.g., AutonomousLoop)
 */
export function getGodModeTools() {
  return {
    planningTool,
    humanInputTool,
    visionAnalyzer,
  };
}

/**
 * POST /api/autonomous/define-goal
 * Extract a goal from natural language with success criteria
 */
autonomousRouter.post('/define-goal',
  extractTenantContext,
  asyncHandler(async (req: Request, res: Response) => {
    if (!goalTracker) {
      throw ErrorFactory.serviceUnavailable('GoalTracker not initialized');
    }

    const { message, context } = req.body;
    if (!message) {
      throw new ValidationError('Message is required');
    }

    logger.info('Defining goal from message', {
      messageLength: message.length,
      hasContext: !!context,
    });

    const goal = await goalTracker.defineGoal(message, {
      ...context,
      tenantContext: (req as any).tenantContext,
    });

    // Return direct JSON response (not wrapped in ApiResponse)
    // autonomous-bridge.ts expects: response.data.id, not response.data.data.id
    return res.status(200).json({
      id: goal.id,
      description: goal.description,
      successCriteria: goal.successCriteria,
      estimatedDuration: goal.metadata?.estimatedDuration,
      estimatedSteps: goal.metadata?.stepsTotal,
    });
  })
);

/**
 * POST /api/autonomous/create-plan
 * Create an execution plan from a goal
 */
autonomousRouter.post('/create-plan',
  extractTenantContext,
  asyncHandler(async (req: Request, res: Response) => {
    if (!taskDecomposer) {
      throw ErrorFactory.serviceUnavailable('TaskDecomposer not initialized');
    }

    const { goalId, description, successCriteria } = req.body;
    if (!description) {
      throw new ValidationError('Description is required');
    }

    logger.info('Creating execution plan', {
      goalId,
      descriptionLength: description.length,
      criteriaCount: successCriteria?.length || 0,
    });

    // Check for matching patterns first (pattern learning)
    if (patternLearner) {
      try {
        const patterns = await patternLearner.findSimilarPatterns(description);
        if (patterns.length > 0 && patterns[0].similarity > 0.75) {
          const pattern = patterns[0].pattern;
          const plan = await patternLearner.applyPattern(pattern, {
            id: goalId || uuidv4(),
            description,
            originalRequest: description,
            successCriteria: (successCriteria || []).map((sc: string) => ({
              id: uuidv4(),
              description: typeof sc === 'string' ? sc : sc.description,
              evaluator: 'llm' as const,
              met: false,
              confidence: 0,
            })),
            subGoals: [],
            status: 'pending' as const,
            progress: 0,
            attempts: 0,
            maxAttempts: 5,
            context: {},
            createdAt: new Date(),
            updatedAt: new Date(),
            metadata: {
              stepsExecuted: 0,
              stepsTotal: 0,
              reflections: [],
              failureReasons: [],
            },
          } as Goal);

          logger.info('Applied pattern for plan creation', {
            patternId: pattern.id,
            patternName: pattern.name,
            similarity: patterns[0].similarity,
          });

          return res.status(200).json({
            id: plan.id,
            goalId: plan.goalId,
            steps: plan.steps,
            version: 1,
            appliedPattern: {
              patternId: pattern.id,
              patternName: pattern.name,
              similarity: patterns[0].similarity,
            },
          });
        }
      } catch (patternError) {
        logger.debug('Pattern matching failed, proceeding with fresh decomposition', {
          error: (patternError as Error).message,
        });
      }
    }

    // No pattern match - decompose from scratch
    const goalObj = {
      id: goalId || uuidv4(),
      description,
      originalRequest: description,
      successCriteria: (successCriteria || []).map((sc: string | { description: string }) => ({
        description: typeof sc === 'string' ? sc : sc.description,
      })),
      context: {},
    };

    const plan = await taskDecomposer.decomposeGoalToPlan(goalObj);

    logger.info('Execution plan created', {
      planId: plan.id,
      goalId: plan.goalId,
      stepsCount: plan.steps.length,
    });

    return res.status(200).json({
      id: plan.id,
      goalId: plan.goalId,
      steps: plan.steps,
      version: plan.version || 1,
    });
  })
);

/**
 * POST /api/autonomous/reflect
 * Reflect on step execution and determine next action
 */
autonomousRouter.post('/reflect',
  extractTenantContext,
  asyncHandler(async (req: Request, res: Response) => {
    if (!reflectionEngine) {
      throw ErrorFactory.serviceUnavailable('ReflectionEngine not initialized');
    }

    const {
      goalId,
      goalDescription,
      successCriteria,
      currentProgress,
      step,
      result,
      remainingSteps,
    } = req.body;

    if (!goalDescription || !step || !result) {
      throw new ValidationError('goalDescription, step, and result are required');
    }

    logger.info('Reflecting on step execution', {
      goalId,
      stepId: step.id,
      stepSuccess: result.success,
      remainingSteps,
    });

    // Build goal and plan objects for reflection
    const goal: Goal = {
      id: goalId || uuidv4(),
      description: goalDescription,
      originalRequest: goalDescription,
      successCriteria: (successCriteria || []).map((sc: string | { description: string }) => ({
        id: uuidv4(),
        description: typeof sc === 'string' ? sc : sc.description,
        evaluator: 'llm' as const,
        met: false,
        confidence: 0,
      })),
      subGoals: [],
      status: 'in_progress',
      progress: currentProgress || 0,
      attempts: 1,
      maxAttempts: 5,
      context: {},
      createdAt: new Date(),
      updatedAt: new Date(),
      metadata: {
        stepsExecuted: 1,
        stepsTotal: (remainingSteps || 0) + 1,
        reflections: [],
        failureReasons: [],
      },
    };

    const plan: ExecutionPlan = {
      id: uuidv4(),
      goalId: goalId || goal.id,
      steps: [{
        id: step.id || uuidv4(),
        description: step.description,
        service: step.service,
        dependencies: [],
        status: result.success ? 'completed' : 'failed',
      }],
      createdAt: new Date(),
      version: 1,
    };

    const stepResult: StepResult = {
      stepId: step.id || uuidv4(),
      success: result.success,
      output: result.output,
      error: result.error,
      duration: 0,
      service: step.service,
    };

    const reflection = await reflectionEngine.reflectOnStep(goal, plan, stepResult, []);

    logger.info('Reflection complete', {
      stepId: reflection.stepId,
      assessment: reflection.assessment,
      shouldReplan: reflection.shouldReplan,
      confidence: reflection.confidenceInPlan,
    });

    return res.status(200).json({
      stepId: reflection.stepId,
      assessment: reflection.assessment,
      confidence: reflection.confidenceInPlan,
      reasoning: reflection.reasoning,
      shouldReplan: reflection.shouldReplan,
      recommendation: reflection.recommendation,
      suggestedAdjustments: reflection.suggestedAdjustments,
    });
  })
);

/**
 * POST /api/autonomous/replan
 * Create a new execution plan based on reflection feedback
 */
autonomousRouter.post('/replan',
  extractTenantContext,
  asyncHandler(async (req: Request, res: Response) => {
    if (!taskDecomposer) {
      throw ErrorFactory.serviceUnavailable('TaskDecomposer not initialized');
    }

    const { goalId, goalDescription, currentPlan, reflection } = req.body;
    if (!goalDescription || !currentPlan || !reflection) {
      throw new ValidationError('goalDescription, currentPlan, and reflection are required');
    }

    logger.info('Replanning based on reflection', {
      goalId,
      currentPlanId: currentPlan.id,
      assessment: reflection.assessment,
    });

    const goal = {
      id: goalId || uuidv4(),
      description: goalDescription,
      originalRequest: goalDescription,
      successCriteria: [],
      context: {},
    };

    // Ensure currentPlan has the right structure
    const planForReplan = {
      id: currentPlan.id || uuidv4(),
      steps: (currentPlan.steps || []).map((s: any) => ({
        id: s.id || uuidv4(),
        description: s.description || '',
        service: s.service,
        operation: s.operation,
        status: s.status || 'pending',
      })),
    };

    // Ensure reflection has the right structure
    const reflectionForReplan = {
      observation: reflection.observation || reflection.reasoning || '',
      assessment: reflection.assessment || 'minor_deviation',
      reasoning: reflection.reasoning || '',
      suggestedAdjustments: reflection.suggestedAdjustments || [],
    };

    const newPlan = await taskDecomposer.replan(goal, planForReplan, reflectionForReplan);

    logger.info('Replan complete', {
      goalId: newPlan.goalId,
      newPlanId: newPlan.id,
      newStepsCount: newPlan.steps.length,
      replanReason: newPlan.replanReason,
    });

    return res.status(200).json({
      id: newPlan.id,
      goalId: newPlan.goalId,
      steps: newPlan.steps,
      version: newPlan.version,
      replanReason: newPlan.replanReason,
    });
  })
);

/**
 * POST /api/autonomous/evaluate
 * Evaluate if goal is achieved based on step results
 */
autonomousRouter.post('/evaluate',
  extractTenantContext,
  asyncHandler(async (req: Request, res: Response) => {
    if (!goalTracker) {
      throw ErrorFactory.serviceUnavailable('GoalTracker not initialized');
    }

    const { goalId, goalDescription, successCriteria, stepResults } = req.body;
    if (!goalDescription || !stepResults) {
      throw new ValidationError('goalDescription and stepResults are required');
    }

    logger.info('Evaluating goal achievement', {
      goalId,
      criteriaCount: successCriteria?.length || 0,
      stepResultsCount: stepResults.length,
    });

    // Build goal for evaluation
    const goal: Goal = {
      id: goalId || uuidv4(),
      description: goalDescription,
      originalRequest: goalDescription,
      successCriteria: (successCriteria || []).map((sc: string | { description: string }) => ({
        id: uuidv4(),
        description: typeof sc === 'string' ? sc : sc.description,
        evaluator: 'llm' as const,
        met: false,
        confidence: 0,
      })),
      subGoals: [],
      status: 'in_progress',
      progress: 0,
      attempts: 1,
      maxAttempts: 5,
      context: {},
      createdAt: new Date(),
      updatedAt: new Date(),
      metadata: {
        stepsExecuted: stepResults.length,
        stepsTotal: stepResults.length,
        reflections: [],
        failureReasons: [],
      },
    };

    const results: StepResult[] = stepResults.map((sr: any) => ({
      stepId: sr.stepId || uuidv4(),
      success: sr.success,
      output: sr.output,
      error: sr.error,
      duration: sr.duration || 0,
    }));

    const evaluation = await goalTracker.evaluateProgress(goal, results);

    logger.info('Goal evaluation complete', {
      goalId,
      achieved: evaluation.achieved,
      progress: evaluation.progress,
      recommendation: evaluation.recommendation,
    });

    return res.status(200).json({
      achieved: evaluation.achieved,
      progress: evaluation.progress,
      criteriaResults: evaluation.criteriaResults,
      overallConfidence: evaluation.overallConfidence,
      recommendation: evaluation.recommendation,
      reasoning: evaluation.reasoning,
    });
  })
);

export { autonomousRouter };
