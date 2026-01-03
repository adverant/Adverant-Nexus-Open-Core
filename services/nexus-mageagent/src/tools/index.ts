/**
 * MageAgent Tools Module
 *
 * Provides specialized tools for autonomous agent execution:
 * - Human-in-the-loop approval system
 * - Planning tool for visible execution plans
 * - (Future: Browser automation tools)
 * - (Future: Code execution tools)
 *
 * @module tools
 */

// Human Input Tool
export {
  HumanInputTool,
  createHumanInputTool,
  createRiskyAction,
  getHumanInputTool,
  setHumanInputTool,
  // Types
  RiskyActionType,
  RiskLevel,
  ApprovalStatus,
  NotificationSeverity,
  ApprovalMode,
  RiskyAction,
  ApprovalRequest,
  QuestionRequest,
  UserApprovalPreferences,
  ApprovalEventType,
  ApprovalEvent,
  HumanInputToolConfig,
  ApprovalResult,
  QuestionResult,
  // Constants
  DEFAULT_CONFIG as HUMAN_INPUT_DEFAULT_CONFIG,
  ACTION_TYPE_RISK_LEVELS,
} from './human-input-tool.js';

// Planning Tool - Visible execution plan management
export {
  PlanningTool,
  createPlanningTool,
  initializePlanningTool,
  getPlanningTool,
  destroyPlanningTool,
} from './planning-tool.js';

// Planning Tool Types
export type {
  PlanStep,
  ExecutionPlan,
  CreateStepInput,
  StepStatus,
  PlanStatus,
  PlanEvent,
  PlanEventType,
  MCPToolSchema,
  PlanningToolConfig,
} from './planning-tool.js';
