/**
 * Task Decomposition Agent - Universal Task Analyzer
 *
 * Analyzes unknown tasks and decomposes them into:
 * - Required tools/packages
 * - Execution steps
 * - Expected inputs/outputs
 *
 * Example: "Convert EPS to SVG"
 * → Tools: ['inkscape']
 * → Steps: ['Install inkscape', 'Run conversion', 'Output to /output']
 * → Input: EPS file buffer
 * → Output: SVG file
 */

import { Agent, AgentRole, AgentTask, AgentDependencies } from './base-agent';
import { logger } from '../utils/logger';

export interface TaskDecomposition {
  taskDescription: string;
  requiredTools: {
    apt?: string[];
    npm?: string[];
    pip?: string[];
  };
  executionLanguage: 'bash' | 'python' | 'javascript' | 'go' | 'rust';
  steps: string[];
  inputRequirements: {
    files?: Array<{ name: string; type: string }>;
    parameters?: Record<string, string>;
  };
  expectedOutput: {
    files?: Array<{ name: string; type: string }>;
    stdout?: boolean;
  };
  estimatedDuration: number; // seconds
  complexity: 'low' | 'medium' | 'high';
}

export class TaskDecompositionAgent extends Agent {
  constructor(id: string, model: string, dependencies: AgentDependencies) {
    super(id, model, AgentRole.RESEARCH, dependencies);
  }

  protected async performTask(
    task: AgentTask,
    _memoryContext: any,
    _sharedContext?: any
  ): Promise<TaskDecomposition> {
    logger.info(`TaskDecompositionAgent ${this.id} analyzing task`, {
      objective: task.objective,
      model: this.model,
    });

    const messages = [
      {
        role: 'system',
        content: `You are an expert task decomposition agent that analyzes tasks and determines:
1. Required tools/packages (apt, npm, pip)
2. Execution steps
3. Input/output requirements
4. Programming language needed

Respond ONLY with valid JSON matching this schema:
{
  "taskDescription": "string",
  "requiredTools": {
    "apt": ["package1", "package2"],
    "npm": ["package1"],
    "pip": ["package1"]
  },
  "executionLanguage": "bash|python|javascript|go|rust",
  "steps": ["step1", "step2"],
  "inputRequirements": {
    "files": [{"name": "input.eps", "type": "application/postscript"}],
    "parameters": {}
  },
  "expectedOutput": {
    "files": [{"name": "output.svg", "type": "image/svg+xml"}],
    "stdout": false
  },
  "estimatedDuration": 30,
  "complexity": "low|medium|high"
}`,
      },
      {
        role: 'user',
        content: `Task: ${task.objective}

Context: ${JSON.stringify(task.context, null, 2)}

Analyze this task and provide decomposition as JSON.`,
      },
    ];

    const response = await this.callModel(messages);

    // Extract JSON from response
    const jsonMatch = response.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      throw new Error('Failed to extract JSON from task decomposition response');
    }

    const decomposition: TaskDecomposition = JSON.parse(jsonMatch[0]);

    logger.info('Task decomposition complete', {
      agentId: this.id,
      task: decomposition.taskDescription,
      tools: decomposition.requiredTools,
      language: decomposition.executionLanguage,
      complexity: decomposition.complexity,
    });

    // Store in database
    await this.dependencies.databaseManager.storeAgentResult(this.id, task.id, {
      agentId: this.id,
      model: this.model,
      role: this.role,
      decomposition,
      metadata: {
        timestamp: new Date().toISOString(),
      },
    });

    return decomposition;
  }

  protected summarizeResult(result: any): any {
    return {
      type: 'task_decomposition',
      tools: result.decomposition.requiredTools,
      language: result.decomposition.executionLanguage,
      complexity: result.decomposition.complexity,
    };
  }

  /**
   * Replan based on reflection feedback
   *
   * This method creates a new execution plan when the current plan
   * is not working or needs significant adjustment based on reflection.
   */
  async replan(
    goal: {
      id: string;
      description: string;
      originalRequest: string;
      successCriteria: Array<{ description: string }>;
      context: Record<string, unknown>;
    },
    currentPlan: {
      id: string;
      steps: Array<{
        id: string;
        description: string;
        service?: string;
        operation?: string;
        status: string;
      }>;
    },
    reflection: {
      observation: string;
      assessment: string;
      reasoning: string;
      suggestedAdjustments: Array<{
        type: string;
        description: string;
        reason: string;
      }>;
    }
  ): Promise<{
    id: string;
    goalId: string;
    steps: Array<{
      id: string;
      description: string;
      service?: string;
      operation?: string;
      dependencies: string[];
      status: 'pending';
    }>;
    createdAt: Date;
    version: number;
    replanReason: string;
  }> {
    logger.info('TaskDecompositionAgent creating new plan based on reflection', {
      goalId: goal.id,
      currentPlanId: currentPlan.id,
      assessment: reflection.assessment,
    });

    // Build context for replanning
    const completedSteps = currentPlan.steps.filter(s => s.status === 'completed');
    const failedSteps = currentPlan.steps.filter(s => s.status === 'failed');
    const pendingSteps = currentPlan.steps.filter(s => s.status === 'pending');

    const messages = [
      {
        role: 'system',
        content: `You are an expert autonomous agent planner performing a REPLAN operation.

The original plan is not working. Based on the reflection and feedback, create a NEW plan that:
1. Preserves progress from completed steps
2. Addresses the issues identified in reflection
3. Incorporates suggested adjustments
4. Provides a clearer path to the goal

Respond ONLY with valid JSON:
{
  "replanReason": "Brief explanation of why we're replanning",
  "steps": [
    {
      "id": "step_1",
      "description": "Step description",
      "service": "optional_service_name",
      "operation": "optional_operation",
      "dependencies": ["ids of steps this depends on"],
      "isRecovery": false
    }
  ],
  "changesFromOriginal": ["list of key changes from the original plan"]
}`,
      },
      {
        role: 'user',
        content: `REPLAN REQUEST:

Goal: ${goal.description}
Original Request: ${goal.originalRequest}

Success Criteria:
${goal.successCriteria.map((sc, i) => `${i + 1}. ${sc.description}`).join('\n')}

CURRENT PLAN STATUS:
Completed Steps (preserve these):
${completedSteps.length > 0
  ? completedSteps.map(s => `- [DONE] ${s.description}`).join('\n')
  : '- None completed yet'}

Failed Steps (need alternative approach):
${failedSteps.length > 0
  ? failedSteps.map(s => `- [FAILED] ${s.description} (service: ${s.service || 'N/A'})`).join('\n')
  : '- None failed'}

Pending Steps (may need adjustment):
${pendingSteps.length > 0
  ? pendingSteps.map(s => `- [PENDING] ${s.description}`).join('\n')
  : '- None pending'}

REFLECTION FEEDBACK:
Observation: ${reflection.observation}
Assessment: ${reflection.assessment}
Reasoning: ${reflection.reasoning}

Suggested Adjustments:
${reflection.suggestedAdjustments.map(adj =>
  `- ${adj.type}: ${adj.description} (Reason: ${adj.reason})`
).join('\n')}

Create a NEW execution plan that addresses these issues.`,
      },
    ];

    const response = await this.callModel(messages);

    // Extract JSON from response
    const jsonMatch = response.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      throw new Error('Failed to extract JSON from replan response');
    }

    const replanData = JSON.parse(jsonMatch[0]);
    const { v4: uuidv4 } = await import('uuid');

    const newPlan = {
      id: uuidv4(),
      goalId: goal.id,
      steps: replanData.steps.map((step: any) => ({
        id: step.id || uuidv4(),
        description: step.description,
        service: step.service,
        operation: step.operation,
        dependencies: step.dependencies || [],
        status: 'pending' as const,
      })),
      createdAt: new Date(),
      version: 2, // Increment version for replanned plans
      replanReason: replanData.replanReason,
    };

    logger.info('Replan complete', {
      goalId: goal.id,
      oldPlanId: currentPlan.id,
      newPlanId: newPlan.id,
      newStepsCount: newPlan.steps.length,
      replanReason: newPlan.replanReason,
    });

    // Store replan event in database
    await this.dependencies.databaseManager.storeAgentResult(this.id, goal.id, {
      agentId: this.id,
      model: this.model,
      role: this.role,
      replan: {
        originalPlanId: currentPlan.id,
        newPlanId: newPlan.id,
        reason: newPlan.replanReason,
        changesFromOriginal: replanData.changesFromOriginal,
        reflection: {
          assessment: reflection.assessment,
          observation: reflection.observation,
        },
      },
      metadata: {
        timestamp: new Date().toISOString(),
        type: 'replan',
      },
    });

    return newPlan;
  }

  /**
   * Decompose a goal into an execution plan
   *
   * This method creates an initial execution plan from a goal definition.
   * Used by orchestrateWithGoal() for autonomous execution.
   */
  async decomposeGoalToPlan(
    goal: {
      id: string;
      description: string;
      originalRequest: string;
      successCriteria: Array<{ description: string }>;
      context: Record<string, unknown>;
    }
  ): Promise<{
    id: string;
    goalId: string;
    steps: Array<{
      id: string;
      description: string;
      service?: string;
      operation?: string;
      dependencies: string[];
      status: 'pending';
    }>;
    createdAt: Date;
    version: number;
  }> {
    logger.info('TaskDecompositionAgent decomposing goal to execution plan', {
      goalId: goal.id,
      description: goal.description.substring(0, 100),
    });

    const messages = [
      {
        role: 'system',
        content: `You are an expert autonomous agent planner.

Given a goal with success criteria, create a detailed execution plan.

Available services to use:
- graphrag: Memory recall, knowledge storage, semantic search
- sandbox: Code execution, file operations, computations
- fileprocess: Document processing, OCR, text extraction
- videoagent: Video processing, transcription, scene detection
- geoagent: Geospatial analysis, mapping, LiDAR processing
- cyberagent: Security scanning, vulnerability assessment
- learningagent: Research, web search, information gathering
- mageagent: Multi-agent orchestration, complex reasoning

Respond ONLY with valid JSON:
{
  "steps": [
    {
      "id": "step_1",
      "description": "Step description",
      "service": "service_name or null for LLM-only",
      "operation": "specific operation or null",
      "dependencies": [],
      "estimatedDuration": 5000
    }
  ],
  "estimatedTotalDuration": 30000,
  "parallelGroups": [[0, 1], [2], [3, 4]]
}`,
      },
      {
        role: 'user',
        content: `Create an execution plan for this goal:

Goal: ${goal.description}
Original Request: ${goal.originalRequest}

Success Criteria:
${goal.successCriteria.map((sc, i) => `${i + 1}. ${sc.description}`).join('\n')}

Context:
${JSON.stringify(goal.context, null, 2)}

Decompose this into executable steps.`,
      },
    ];

    const response = await this.callModel(messages);

    const jsonMatch = response.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      throw new Error('Failed to extract JSON from goal decomposition response');
    }

    const planData = JSON.parse(jsonMatch[0]);
    const { v4: uuidv4 } = await import('uuid');

    const plan = {
      id: uuidv4(),
      goalId: goal.id,
      steps: planData.steps.map((step: any) => ({
        id: step.id || uuidv4(),
        description: step.description,
        service: step.service,
        operation: step.operation,
        dependencies: step.dependencies || [],
        status: 'pending' as const,
      })),
      createdAt: new Date(),
      version: 1,
    };

    logger.info('Goal decomposition complete', {
      goalId: goal.id,
      planId: plan.id,
      stepsCount: plan.steps.length,
    });

    return plan;
  }
}
