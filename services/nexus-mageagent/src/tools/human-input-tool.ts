/**
 * Human-in-the-Loop Approval System for GOD-MODE Autonomous Execution
 *
 * Provides human oversight for risky actions during autonomous agent execution:
 * - Request approval for dangerous operations
 * - Ask questions to users for clarification
 * - Send notifications for important events
 * - Track approval status with timeout management
 *
 * Integrates with WebSocket for real-time client communication
 * and Redis for persistent approval state with TTL.
 *
 * @module tools/human-input-tool
 */

import { v4 as uuidv4 } from 'uuid';
import { EventEmitter } from 'events';
import { Redis } from 'ioredis';
import { logger } from '../utils/logger.js';
import {
  ValidationError,
  NotFoundError,
  OperationError,
} from '../utils/errors.js';

// ============================================================================
// Types and Interfaces
// ============================================================================

/**
 * Categories of risky actions that may require human approval
 */
export type RiskyActionType =
  | 'form_submit' // Submitting forms on websites
  | 'purchase' // Any payment-related action
  | 'login' // Authentication actions
  | 'delete' // Deletion operations (files, records, etc.)
  | 'external_api' // Calling external APIs with side effects
  | 'file_write' // Writing or modifying files
  | 'database_modify' // Database insert/update/delete operations
  | 'infrastructure' // K8s/server/deployment operations
  | 'send_message' // Sending emails, SMS, Slack messages
  | 'data_export' // Exporting sensitive data
  | 'configuration_change' // Modifying system configurations
  | 'permission_change' // Changing user permissions
  | 'financial_operation'; // Non-purchase financial operations

/**
 * Risk levels for categorizing action severity
 */
export type RiskLevel = 'low' | 'medium' | 'high' | 'critical';

/**
 * Approval status for pending requests
 */
export type ApprovalStatus =
  | 'pending'
  | 'granted'
  | 'denied'
  | 'timeout'
  | 'cancelled';

/**
 * Notification severity levels
 */
export type NotificationSeverity = 'info' | 'warning' | 'critical';

/**
 * User approval mode preferences
 */
export type ApprovalMode =
  | 'always' // Always require approval for any action
  | 'risky_only' // Only require approval for risky actions
  | 'never' // Never require approval (admin/power users)
  | 'custom'; // User-defined list of actions requiring approval

/**
 * Risky action definition
 */
export interface RiskyAction {
  id: string;
  type: RiskyActionType;
  description: string;
  details: Record<string, unknown>;
  riskLevel: RiskLevel;
  timeout: number; // Milliseconds to wait for approval
  autoApprove?: boolean; // For low-risk actions with user preference
  loopId?: string; // Associated autonomous loop ID
  stepId?: string; // Associated step ID
  goalDescription?: string; // Human-readable goal context
  reversible?: boolean; // Whether the action can be undone
  estimatedImpact?: string; // Description of potential impact
}

/**
 * Approval request stored in Redis
 */
export interface ApprovalRequest {
  id: string;
  action: RiskyAction;
  userId: string;
  sessionId?: string;
  status: ApprovalStatus;
  requestedAt: Date;
  respondedAt?: Date;
  responseReason?: string;
  timeoutAt: Date;
  metadata: Record<string, unknown>;
}

/**
 * Question request for user input
 */
export interface QuestionRequest {
  id: string;
  question: string;
  options?: string[];
  allowFreeText: boolean;
  timeout: number;
  requestedAt: Date;
  respondedAt?: Date;
  answer?: string;
  userId: string;
  loopId?: string;
  context?: Record<string, unknown>;
}

/**
 * User approval preferences
 */
export interface UserApprovalPreferences {
  userId: string;
  mode: ApprovalMode;
  customRules?: {
    actionTypes: RiskyActionType[];
    riskLevels: RiskLevel[];
    autoApproveBelow?: RiskLevel;
  };
  trustedSources?: string[]; // Services that can bypass approval
  defaultTimeout: number;
  notifyOnAutoApprove: boolean;
  updatedAt: Date;
}

/**
 * WebSocket event types for approval system
 */
export type ApprovalEventType =
  | 'approval:requested'
  | 'approval:granted'
  | 'approval:denied'
  | 'approval:timeout'
  | 'approval:cancelled'
  | 'approval:question'
  | 'approval:answer'
  | 'approval:notification';

/**
 * Approval event payload
 */
export interface ApprovalEvent {
  type: ApprovalEventType;
  requestId: string;
  timestamp: string;
  payload: Record<string, unknown>;
}

/**
 * Human Input Tool configuration
 */
export interface HumanInputToolConfig {
  defaultTimeout: number; // Default approval timeout in ms (e.g., 300000 = 5 minutes)
  redisKeyPrefix: string; // Redis key prefix for approval data
  redisExpiry: number; // TTL for Redis entries in seconds
  maxPendingPerUser: number; // Max pending approvals per user
  defaultApprovalMode: ApprovalMode;
  riskLevelTimeouts: Record<RiskLevel, number>; // Timeout per risk level
}

/**
 * Result of an approval request
 */
export interface ApprovalResult {
  approved: boolean;
  reason?: string;
  respondedBy?: string;
  responseTime: number; // Time taken to respond in ms
  wasAutoApproved: boolean;
  metadata?: Record<string, unknown>;
}

/**
 * Result of asking a question
 */
export interface QuestionResult {
  answered: boolean;
  answer?: string;
  selectedOption?: string;
  responseTime: number;
  timedOut: boolean;
}

// ============================================================================
// Default Configuration
// ============================================================================

export const DEFAULT_CONFIG: HumanInputToolConfig = {
  defaultTimeout: 300000, // 5 minutes
  redisKeyPrefix: 'mageagent:approval:',
  redisExpiry: 3600, // 1 hour
  maxPendingPerUser: 10,
  defaultApprovalMode: 'risky_only',
  riskLevelTimeouts: {
    low: 60000, // 1 minute
    medium: 180000, // 3 minutes
    high: 300000, // 5 minutes
    critical: 600000, // 10 minutes
  },
};

/**
 * Risk level mappings for action types
 */
export const ACTION_TYPE_RISK_LEVELS: Record<RiskyActionType, RiskLevel> = {
  form_submit: 'medium',
  purchase: 'critical',
  login: 'high',
  delete: 'high',
  external_api: 'medium',
  file_write: 'medium',
  database_modify: 'high',
  infrastructure: 'critical',
  send_message: 'medium',
  data_export: 'high',
  configuration_change: 'high',
  permission_change: 'critical',
  financial_operation: 'critical',
};

// ============================================================================
// Human Input Tool Implementation
// ============================================================================

export class HumanInputTool extends EventEmitter {
  private config: HumanInputToolConfig;
  private pendingApprovals: Map<string, ApprovalRequest> = new Map();
  private pendingQuestions: Map<string, QuestionRequest> = new Map();
  private userPreferences: Map<string, UserApprovalPreferences> = new Map();
  private approvalResolvers: Map<
    string,
    {
      resolve: (result: ApprovalResult) => void;
      reject: (error: Error) => void;
      timer: NodeJS.Timeout;
    }
  > = new Map();
  private questionResolvers: Map<
    string,
    {
      resolve: (result: QuestionResult) => void;
      reject: (error: Error) => void;
      timer: NodeJS.Timeout;
    }
  > = new Map();

  constructor(
    private redisClient: Redis,
    private wsEmitter: (event: ApprovalEvent, userId: string) => void,
    config?: Partial<HumanInputToolConfig>
  ) {
    super();
    this.config = { ...DEFAULT_CONFIG, ...config };

    logger.info('HumanInputTool initialized', {
      defaultTimeout: this.config.defaultTimeout,
      maxPendingPerUser: this.config.maxPendingPerUser,
    });
  }

  // =========================================================================
  // Core Approval Methods
  // =========================================================================

  /**
   * Request approval for a risky action
   * Pauses execution until user responds or timeout occurs
   */
  async requestApproval(
    action: RiskyAction,
    userId: string,
    sessionId?: string
  ): Promise<ApprovalResult> {
    // Validate action
    this.validateAction(action);

    // Check user preferences for auto-approval
    const preferences = await this.getUserPreferences(userId);
    const shouldAutoApprove = this.checkAutoApproval(action, preferences);

    if (shouldAutoApprove) {
      logger.info('Auto-approving action based on user preferences', {
        actionId: action.id,
        actionType: action.type,
        userId,
      });

      // Optionally notify user of auto-approval
      if (preferences.notifyOnAutoApprove) {
        await this.notifyUser(
          `Auto-approved: ${action.description}`,
          'info',
          userId
        );
      }

      return {
        approved: true,
        wasAutoApproved: true,
        responseTime: 0,
      };
    }

    // Check pending approval limit
    const pendingCount = await this.getPendingCountForUser(userId);
    if (pendingCount >= this.config.maxPendingPerUser) {
      throw new OperationError(
        `Maximum pending approvals (${this.config.maxPendingPerUser}) reached for user`,
        { userId, pendingCount }
      );
    }

    // Determine timeout based on risk level
    const timeout =
      action.timeout || this.config.riskLevelTimeouts[action.riskLevel];

    // Create approval request
    const request: ApprovalRequest = {
      id: action.id,
      action,
      userId,
      sessionId,
      status: 'pending',
      requestedAt: new Date(),
      timeoutAt: new Date(Date.now() + timeout),
      metadata: {
        riskLevel: action.riskLevel,
        actionType: action.type,
      },
    };

    // Store in Redis
    await this.storeApprovalRequest(request);
    this.pendingApprovals.set(request.id, request);

    // Emit WebSocket event to client
    this.emitApprovalEvent('approval:requested', request.id, userId, {
      action: {
        id: action.id,
        type: action.type,
        description: action.description,
        riskLevel: action.riskLevel,
        details: action.details,
        reversible: action.reversible,
        estimatedImpact: action.estimatedImpact,
        goalDescription: action.goalDescription,
      },
      timeout,
      timeoutAt: request.timeoutAt.toISOString(),
    });

    logger.info('Approval request created', {
      requestId: request.id,
      actionType: action.type,
      riskLevel: action.riskLevel,
      userId,
      timeout,
    });

    // Wait for response or timeout
    return this.waitForApproval(request);
  }

  /**
   * Grant approval for a pending request
   * Called when user approves via WebSocket
   */
  async grantApproval(
    requestId: string,
    userId: string,
    reason?: string
  ): Promise<void> {
    const request = await this.getApprovalRequest(requestId);

    if (!request) {
      throw new NotFoundError(`Approval request not found: ${requestId}`);
    }

    if (request.userId !== userId) {
      throw new OperationError(
        'Cannot approve request for different user',
        { requestId, requestUserId: request.userId, userId }
      );
    }

    if (request.status !== 'pending') {
      throw new OperationError(
        `Request is no longer pending: ${request.status}`,
        { requestId, status: request.status }
      );
    }

    // Update request status
    request.status = 'granted';
    request.respondedAt = new Date();
    request.responseReason = reason;

    await this.updateApprovalRequest(request);

    // Resolve pending promise
    const resolver = this.approvalResolvers.get(requestId);
    if (resolver) {
      clearTimeout(resolver.timer);
      resolver.resolve({
        approved: true,
        reason,
        respondedBy: userId,
        responseTime: request.respondedAt.getTime() - request.requestedAt.getTime(),
        wasAutoApproved: false,
      });
      this.approvalResolvers.delete(requestId);
    }

    // Emit event
    this.emitApprovalEvent('approval:granted', requestId, userId, {
      reason,
      respondedAt: request.respondedAt.toISOString(),
    });

    logger.info('Approval granted', {
      requestId,
      userId,
      responseTime:
        request.respondedAt.getTime() - request.requestedAt.getTime(),
    });

    // Clean up
    this.pendingApprovals.delete(requestId);
  }

  /**
   * Deny approval for a pending request
   * Called when user denies via WebSocket
   */
  async denyApproval(
    requestId: string,
    userId: string,
    reason?: string
  ): Promise<void> {
    const request = await this.getApprovalRequest(requestId);

    if (!request) {
      throw new NotFoundError(`Approval request not found: ${requestId}`);
    }

    if (request.userId !== userId) {
      throw new OperationError(
        'Cannot deny request for different user',
        { requestId, requestUserId: request.userId, userId }
      );
    }

    if (request.status !== 'pending') {
      throw new OperationError(
        `Request is no longer pending: ${request.status}`,
        { requestId, status: request.status }
      );
    }

    // Update request status
    request.status = 'denied';
    request.respondedAt = new Date();
    request.responseReason = reason || 'User denied the action';

    await this.updateApprovalRequest(request);

    // Resolve pending promise with denial
    const resolver = this.approvalResolvers.get(requestId);
    if (resolver) {
      clearTimeout(resolver.timer);
      resolver.resolve({
        approved: false,
        reason: request.responseReason,
        respondedBy: userId,
        responseTime: request.respondedAt.getTime() - request.requestedAt.getTime(),
        wasAutoApproved: false,
      });
      this.approvalResolvers.delete(requestId);
    }

    // Emit event
    this.emitApprovalEvent('approval:denied', requestId, userId, {
      reason: request.responseReason,
      respondedAt: request.respondedAt.toISOString(),
    });

    logger.info('Approval denied', {
      requestId,
      userId,
      reason: request.responseReason,
    });

    // Clean up
    this.pendingApprovals.delete(requestId);
  }

  /**
   * Check status of an approval request
   */
  async getApprovalStatus(requestId: string): Promise<ApprovalStatus | null> {
    const request = await this.getApprovalRequest(requestId);
    return request?.status || null;
  }

  /**
   * Cancel a pending approval request
   */
  async cancelPendingApproval(requestId: string, reason?: string): Promise<void> {
    const request = this.pendingApprovals.get(requestId);

    if (!request) {
      // Try to get from Redis
      const storedRequest = await this.getApprovalRequest(requestId);
      if (!storedRequest) {
        throw new NotFoundError(`Approval request not found: ${requestId}`);
      }
      if (storedRequest.status !== 'pending') {
        throw new OperationError(
          `Cannot cancel non-pending request: ${storedRequest.status}`,
          { requestId, status: storedRequest.status }
        );
      }
    }

    // Update status
    const updatedRequest: ApprovalRequest = request || (await this.getApprovalRequest(requestId))!;
    updatedRequest.status = 'cancelled';
    updatedRequest.respondedAt = new Date();
    updatedRequest.responseReason = reason || 'Request cancelled';

    await this.updateApprovalRequest(updatedRequest);

    // Resolve pending promise with cancellation
    const resolver = this.approvalResolvers.get(requestId);
    if (resolver) {
      clearTimeout(resolver.timer);
      resolver.resolve({
        approved: false,
        reason: updatedRequest.responseReason,
        responseTime:
          updatedRequest.respondedAt.getTime() - updatedRequest.requestedAt.getTime(),
        wasAutoApproved: false,
      });
      this.approvalResolvers.delete(requestId);
    }

    // Emit event
    this.emitApprovalEvent('approval:cancelled', requestId, updatedRequest.userId, {
      reason: updatedRequest.responseReason,
    });

    logger.info('Approval cancelled', {
      requestId,
      reason: updatedRequest.responseReason,
    });

    // Clean up
    this.pendingApprovals.delete(requestId);
  }

  // =========================================================================
  // Question/Input Methods
  // =========================================================================

  /**
   * Ask user a question and wait for answer
   */
  async askQuestion(
    question: string,
    userId: string,
    options?: {
      choices?: string[];
      allowFreeText?: boolean;
      timeout?: number;
      loopId?: string;
      context?: Record<string, unknown>;
    }
  ): Promise<QuestionResult> {
    const requestId = uuidv4();
    const timeout = options?.timeout || this.config.defaultTimeout;

    const questionRequest: QuestionRequest = {
      id: requestId,
      question,
      options: options?.choices,
      allowFreeText: options?.allowFreeText ?? true,
      timeout,
      requestedAt: new Date(),
      userId,
      loopId: options?.loopId,
      context: options?.context,
    };

    // Store in Redis
    await this.storeQuestionRequest(questionRequest);
    this.pendingQuestions.set(requestId, questionRequest);

    // Emit WebSocket event
    this.emitApprovalEvent('approval:question', requestId, userId, {
      question,
      options: options?.choices,
      allowFreeText: options?.allowFreeText ?? true,
      timeout,
      loopId: options?.loopId,
      context: options?.context,
    });

    logger.info('Question sent to user', {
      requestId,
      question: question.substring(0, 100),
      hasOptions: !!options?.choices,
      userId,
    });

    // Wait for answer or timeout
    return this.waitForAnswer(questionRequest);
  }

  /**
   * Handle user's answer to a question
   */
  async answerQuestion(
    requestId: string,
    userId: string,
    answer: string
  ): Promise<void> {
    const question = this.pendingQuestions.get(requestId);

    if (!question) {
      const storedQuestion = await this.getQuestionRequest(requestId);
      if (!storedQuestion) {
        throw new NotFoundError(`Question request not found: ${requestId}`);
      }
      if (storedQuestion.answer !== undefined) {
        throw new OperationError('Question already answered', { requestId });
      }
    }

    const questionRequest = question || (await this.getQuestionRequest(requestId))!;

    if (questionRequest.userId !== userId) {
      throw new OperationError(
        'Cannot answer question for different user',
        { requestId }
      );
    }

    // Validate answer against options if provided
    if (questionRequest.options && !questionRequest.allowFreeText) {
      if (!questionRequest.options.includes(answer)) {
        throw new ValidationError(
          'Answer must be one of the provided options',
          { providedOptions: questionRequest.options, answer }
        );
      }
    }

    // Update question
    questionRequest.answer = answer;
    questionRequest.respondedAt = new Date();

    await this.updateQuestionRequest(questionRequest);

    // Resolve pending promise
    const resolver = this.questionResolvers.get(requestId);
    if (resolver) {
      clearTimeout(resolver.timer);
      resolver.resolve({
        answered: true,
        answer,
        selectedOption: questionRequest.options?.includes(answer) ? answer : undefined,
        responseTime:
          questionRequest.respondedAt.getTime() - questionRequest.requestedAt.getTime(),
        timedOut: false,
      });
      this.questionResolvers.delete(requestId);
    }

    // Emit event
    this.emitApprovalEvent('approval:answer', requestId, userId, {
      answer,
      respondedAt: questionRequest.respondedAt.toISOString(),
    });

    logger.info('Question answered', {
      requestId,
      userId,
      responseTime:
        questionRequest.respondedAt.getTime() - questionRequest.requestedAt.getTime(),
    });

    // Clean up
    this.pendingQuestions.delete(requestId);
  }

  // =========================================================================
  // Notification Methods
  // =========================================================================

  /**
   * Send a notification to the user
   * Non-blocking - doesn't wait for response
   */
  async notifyUser(
    message: string,
    severity: NotificationSeverity,
    userId: string,
    metadata?: Record<string, unknown>
  ): Promise<void> {
    const notificationId = uuidv4();

    this.emitApprovalEvent('approval:notification', notificationId, userId, {
      message,
      severity,
      metadata,
    });

    logger.info('Notification sent to user', {
      notificationId,
      severity,
      userId,
      message: message.substring(0, 100),
    });
  }

  // =========================================================================
  // User Preferences
  // =========================================================================

  /**
   * Get user's approval preferences
   */
  async getUserPreferences(userId: string): Promise<UserApprovalPreferences> {
    // Check cache first
    const cached = this.userPreferences.get(userId);
    if (cached) {
      return cached;
    }

    // Load from Redis
    const key = `${this.config.redisKeyPrefix}preferences:${userId}`;
    const stored = await this.redisClient.get(key);

    if (stored) {
      const preferences = JSON.parse(stored) as UserApprovalPreferences;
      preferences.updatedAt = new Date(preferences.updatedAt);
      this.userPreferences.set(userId, preferences);
      return preferences;
    }

    // Return default preferences
    const defaultPrefs: UserApprovalPreferences = {
      userId,
      mode: this.config.defaultApprovalMode,
      defaultTimeout: this.config.defaultTimeout,
      notifyOnAutoApprove: true,
      updatedAt: new Date(),
    };

    return defaultPrefs;
  }

  /**
   * Update user's approval preferences
   */
  async updateUserPreferences(
    userId: string,
    preferences: Partial<UserApprovalPreferences>
  ): Promise<UserApprovalPreferences> {
    const current = await this.getUserPreferences(userId);

    const updated: UserApprovalPreferences = {
      ...current,
      ...preferences,
      userId, // Ensure userId is not overwritten
      updatedAt: new Date(),
    };

    // Store in Redis
    const key = `${this.config.redisKeyPrefix}preferences:${userId}`;
    await this.redisClient.setex(
      key,
      this.config.redisExpiry * 24, // 24 hours for preferences
      JSON.stringify(updated)
    );

    // Update cache
    this.userPreferences.set(userId, updated);

    logger.info('User preferences updated', {
      userId,
      mode: updated.mode,
    });

    return updated;
  }

  // =========================================================================
  // Helper Methods
  // =========================================================================

  /**
   * Check if action should be auto-approved based on user preferences
   */
  private checkAutoApproval(
    action: RiskyAction,
    preferences: UserApprovalPreferences
  ): boolean {
    // Never auto-approve if user explicitly set action to require approval
    if (action.autoApprove === false) {
      return false;
    }

    // Check approval mode
    switch (preferences.mode) {
      case 'always':
        return false;
      case 'never':
        return true;
      case 'risky_only':
        // Auto-approve low risk actions
        return action.riskLevel === 'low';
      case 'custom':
        if (preferences.customRules) {
          // Check if action type is in the required list
          if (
            preferences.customRules.actionTypes.includes(action.type)
          ) {
            return false;
          }
          // Check if risk level is in the required list
          if (
            preferences.customRules.riskLevels.includes(action.riskLevel)
          ) {
            return false;
          }
          // Auto-approve if below threshold
          if (preferences.customRules.autoApproveBelow) {
            const riskOrder: RiskLevel[] = ['low', 'medium', 'high', 'critical'];
            const actionIndex = riskOrder.indexOf(action.riskLevel);
            const thresholdIndex = riskOrder.indexOf(
              preferences.customRules.autoApproveBelow
            );
            return actionIndex < thresholdIndex;
          }
        }
        return false;
      default:
        return false;
    }
  }

  /**
   * Wait for approval with timeout
   */
  private waitForApproval(request: ApprovalRequest): Promise<ApprovalResult> {
    return new Promise((resolve, reject) => {
      const timeout = request.timeoutAt.getTime() - Date.now();

      const timer = setTimeout(() => {
        // Handle timeout
        this.handleApprovalTimeout(request).then(() => {
          resolve({
            approved: false,
            reason: 'Approval request timed out',
            responseTime: timeout,
            wasAutoApproved: false,
          });
        });
      }, timeout);

      this.approvalResolvers.set(request.id, { resolve, reject, timer });
    });
  }

  /**
   * Wait for question answer with timeout
   */
  private waitForAnswer(question: QuestionRequest): Promise<QuestionResult> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        // Handle timeout
        this.handleQuestionTimeout(question).then(() => {
          resolve({
            answered: false,
            responseTime: question.timeout,
            timedOut: true,
          });
        });
      }, question.timeout);

      this.questionResolvers.set(question.id, { resolve, reject, timer });
    });
  }

  /**
   * Handle approval timeout
   */
  private async handleApprovalTimeout(request: ApprovalRequest): Promise<void> {
    request.status = 'timeout';
    request.respondedAt = new Date();
    request.responseReason = 'Request timed out';

    await this.updateApprovalRequest(request);

    this.emitApprovalEvent('approval:timeout', request.id, request.userId, {
      reason: 'Request timed out',
      timeoutAt: request.timeoutAt.toISOString(),
    });

    logger.warn('Approval request timed out', {
      requestId: request.id,
      actionType: request.action.type,
      userId: request.userId,
    });

    this.pendingApprovals.delete(request.id);
    this.approvalResolvers.delete(request.id);
  }

  /**
   * Handle question timeout
   */
  private async handleQuestionTimeout(question: QuestionRequest): Promise<void> {
    await this.redisClient.del(
      `${this.config.redisKeyPrefix}question:${question.id}`
    );

    logger.warn('Question timed out', {
      requestId: question.id,
      userId: question.userId,
    });

    this.pendingQuestions.delete(question.id);
    this.questionResolvers.delete(question.id);
  }

  /**
   * Validate risky action definition
   */
  private validateAction(action: RiskyAction): void {
    if (!action.id) {
      throw new ValidationError('Action ID is required');
    }
    if (!action.type) {
      throw new ValidationError('Action type is required');
    }
    if (!action.description) {
      throw new ValidationError('Action description is required');
    }
    if (!action.riskLevel) {
      throw new ValidationError('Risk level is required');
    }

    const validRiskLevels: RiskLevel[] = ['low', 'medium', 'high', 'critical'];
    if (!validRiskLevels.includes(action.riskLevel)) {
      throw new ValidationError(
        `Invalid risk level: ${action.riskLevel}. Must be one of: ${validRiskLevels.join(', ')}`
      );
    }
  }

  /**
   * Store approval request in Redis
   */
  private async storeApprovalRequest(request: ApprovalRequest): Promise<void> {
    const key = `${this.config.redisKeyPrefix}approval:${request.id}`;
    await this.redisClient.setex(
      key,
      this.config.redisExpiry,
      JSON.stringify({
        ...request,
        requestedAt: request.requestedAt.toISOString(),
        timeoutAt: request.timeoutAt.toISOString(),
      })
    );

    // Add to user's pending list
    const userKey = `${this.config.redisKeyPrefix}user:${request.userId}:pending`;
    await this.redisClient.sadd(userKey, request.id);
    await this.redisClient.expire(userKey, this.config.redisExpiry);
  }

  /**
   * Get approval request from Redis
   */
  private async getApprovalRequest(
    requestId: string
  ): Promise<ApprovalRequest | null> {
    const key = `${this.config.redisKeyPrefix}approval:${requestId}`;
    const stored = await this.redisClient.get(key);

    if (!stored) {
      return null;
    }

    const request = JSON.parse(stored);
    return {
      ...request,
      requestedAt: new Date(request.requestedAt),
      timeoutAt: new Date(request.timeoutAt),
      respondedAt: request.respondedAt
        ? new Date(request.respondedAt)
        : undefined,
    };
  }

  /**
   * Update approval request in Redis
   */
  private async updateApprovalRequest(request: ApprovalRequest): Promise<void> {
    const key = `${this.config.redisKeyPrefix}approval:${request.id}`;
    await this.redisClient.setex(
      key,
      this.config.redisExpiry,
      JSON.stringify({
        ...request,
        requestedAt: request.requestedAt.toISOString(),
        timeoutAt: request.timeoutAt.toISOString(),
        respondedAt: request.respondedAt?.toISOString(),
      })
    );

    // Remove from pending if no longer pending
    if (request.status !== 'pending') {
      const userKey = `${this.config.redisKeyPrefix}user:${request.userId}:pending`;
      await this.redisClient.srem(userKey, request.id);
    }
  }

  /**
   * Store question request in Redis
   */
  private async storeQuestionRequest(question: QuestionRequest): Promise<void> {
    const key = `${this.config.redisKeyPrefix}question:${question.id}`;
    await this.redisClient.setex(
      key,
      this.config.redisExpiry,
      JSON.stringify({
        ...question,
        requestedAt: question.requestedAt.toISOString(),
      })
    );
  }

  /**
   * Get question request from Redis
   */
  private async getQuestionRequest(
    requestId: string
  ): Promise<QuestionRequest | null> {
    const key = `${this.config.redisKeyPrefix}question:${requestId}`;
    const stored = await this.redisClient.get(key);

    if (!stored) {
      return null;
    }

    const question = JSON.parse(stored);
    return {
      ...question,
      requestedAt: new Date(question.requestedAt),
      respondedAt: question.respondedAt
        ? new Date(question.respondedAt)
        : undefined,
    };
  }

  /**
   * Update question request in Redis
   */
  private async updateQuestionRequest(question: QuestionRequest): Promise<void> {
    const key = `${this.config.redisKeyPrefix}question:${question.id}`;
    await this.redisClient.setex(
      key,
      this.config.redisExpiry,
      JSON.stringify({
        ...question,
        requestedAt: question.requestedAt.toISOString(),
        respondedAt: question.respondedAt?.toISOString(),
      })
    );
  }

  /**
   * Get count of pending approvals for a user
   */
  private async getPendingCountForUser(userId: string): Promise<number> {
    const userKey = `${this.config.redisKeyPrefix}user:${userId}:pending`;
    return this.redisClient.scard(userKey);
  }

  /**
   * Emit WebSocket event to client
   */
  private emitApprovalEvent(
    type: ApprovalEventType,
    requestId: string,
    userId: string,
    payload: Record<string, unknown>
  ): void {
    const event: ApprovalEvent = {
      type,
      requestId,
      timestamp: new Date().toISOString(),
      payload,
    };

    this.wsEmitter(event, userId);
    this.emit(type, event);
  }

  // =========================================================================
  // Batch Operations
  // =========================================================================

  /**
   * Get all pending approvals for a user
   */
  async getPendingApprovals(userId: string): Promise<ApprovalRequest[]> {
    const userKey = `${this.config.redisKeyPrefix}user:${userId}:pending`;
    const requestIds = await this.redisClient.smembers(userKey);

    const requests: ApprovalRequest[] = [];
    for (const requestId of requestIds) {
      const request = await this.getApprovalRequest(requestId);
      if (request && request.status === 'pending') {
        requests.push(request);
      }
    }

    return requests;
  }

  /**
   * Cancel all pending approvals for a user
   */
  async cancelAllPendingApprovals(userId: string, reason?: string): Promise<number> {
    const pending = await this.getPendingApprovals(userId);
    let cancelled = 0;

    for (const request of pending) {
      try {
        await this.cancelPendingApproval(
          request.id,
          reason || 'Bulk cancellation'
        );
        cancelled++;
      } catch (error) {
        logger.warn('Failed to cancel pending approval', {
          requestId: request.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return cancelled;
  }

  // =========================================================================
  // Health & Metrics
  // =========================================================================

  /**
   * Get health metrics for monitoring
   */
  getHealthMetrics(): {
    pendingApprovals: number;
    pendingQuestions: number;
    cachedPreferences: number;
    activeResolvers: number;
  } {
    return {
      pendingApprovals: this.pendingApprovals.size,
      pendingQuestions: this.pendingQuestions.size,
      cachedPreferences: this.userPreferences.size,
      activeResolvers:
        this.approvalResolvers.size + this.questionResolvers.size,
    };
  }

  /**
   * Clean up expired entries and resources
   */
  async cleanup(): Promise<void> {
    // Clear all timers
    for (const [_id, resolver] of this.approvalResolvers) {
      clearTimeout(resolver.timer);
    }
    for (const [_id, resolver] of this.questionResolvers) {
      clearTimeout(resolver.timer);
    }

    this.pendingApprovals.clear();
    this.pendingQuestions.clear();
    this.approvalResolvers.clear();
    this.questionResolvers.clear();
    this.userPreferences.clear();

    this.removeAllListeners();

    logger.info('HumanInputTool cleaned up');
  }
}

// ============================================================================
// Factory Functions
// ============================================================================

/**
 * Create a new HumanInputTool instance
 */
export function createHumanInputTool(
  redisClient: Redis,
  wsEmitter: (event: ApprovalEvent, userId: string) => void,
  config?: Partial<HumanInputToolConfig>
): HumanInputTool {
  return new HumanInputTool(redisClient, wsEmitter, config);
}

/**
 * Create a risky action object with defaults
 */
export function createRiskyAction(
  type: RiskyActionType,
  description: string,
  details: Record<string, unknown>,
  options?: Partial<Omit<RiskyAction, 'id' | 'type' | 'description' | 'details'>>
): RiskyAction {
  return {
    id: uuidv4(),
    type,
    description,
    details,
    riskLevel: options?.riskLevel || ACTION_TYPE_RISK_LEVELS[type],
    timeout: options?.timeout || DEFAULT_CONFIG.riskLevelTimeouts[
      options?.riskLevel || ACTION_TYPE_RISK_LEVELS[type]
    ],
    autoApprove: options?.autoApprove,
    loopId: options?.loopId,
    stepId: options?.stepId,
    goalDescription: options?.goalDescription,
    reversible: options?.reversible,
    estimatedImpact: options?.estimatedImpact,
  };
}

// Singleton instance management
let humanInputToolInstance: HumanInputTool | null = null;

export function getHumanInputTool(): HumanInputTool | null {
  return humanInputToolInstance;
}

export function setHumanInputTool(tool: HumanInputTool): void {
  humanInputToolInstance = tool;
}
