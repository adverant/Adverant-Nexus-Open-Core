/**
 * Episode Input Validation
 *
 * Defense-in-Depth validation layer for episode content storage.
 * Validates business rules BEFORE sending to GraphRAG service.
 *
 * VALIDATION RULES:
 * - Min content length: 10 characters (meaningful semantic content)
 * - Max content length: 50,000 characters (DoS prevention)
 * - Content must not be only whitespace
 * - Content must contain at least 3 distinct words (semantic quality)
 * - Metadata must be valid JSON objects
 *
 * ARCHITECTURE:
 * This is Layer 2 validation (Service Layer) in defense-in-depth strategy:
 * Layer 1: Express middleware (XSS/SQL sanitization)
 * Layer 2: Service layer (Business rules) ← THIS FILE
 * Layer 3: GraphRAG client (Pre-flight checks)
 * Layer 4: GraphRAG service (Final contract enforcement)
 */

import { z } from 'zod';

// ===== VALIDATION CONSTANTS =====

export const EPISODE_VALIDATION_RULES = {
  MIN_CONTENT_LENGTH: 2,  // Allow short commands like "hi" or "ok"
  MAX_CONTENT_LENGTH: 50000,
  MIN_WORD_COUNT: 1,  // Allow single-word commands - semantic quality is determined by AI
  MAX_TAG_LENGTH: 50,
  MAX_TAGS: 20,
} as const;

export const EPISODE_ERROR_MESSAGES = {
  CONTENT_TOO_SHORT: (minLength: number, actualLength: number) =>
    `Message must be at least ${minLength} characters. You provided ${actualLength} character${actualLength === 1 ? '' : 's'}. Please add ${minLength - actualLength} more character${minLength - actualLength === 1 ? '' : 's'} to provide meaningful context.`,

  CONTENT_TOO_LONG: (maxLength: number, actualLength: number) =>
    `Message exceeds maximum length of ${maxLength} characters. You provided ${actualLength} characters. Please shorten your message by ${actualLength - maxLength} characters.`,

  CONTENT_EMPTY: 'Message content cannot be empty or only whitespace',

  INSUFFICIENT_WORDS: (minWords: number, actualWords: number) =>
    `Message must contain at least ${minWords} distinct words for meaningful analysis. You provided ${actualWords} word${actualWords === 1 ? '' : 's'}. Please provide more descriptive content.`,

  INVALID_TYPE: (validTypes: string[]) =>
    `Invalid episode type. Must be one of: ${validTypes.join(', ')}`,

  INVALID_METADATA: 'Episode metadata must be a valid JSON object',

  MISSING_REQUIRED_FIELD: (field: string) =>
    `Required field '${field}' is missing`,
} as const;

// ===== CUSTOM ERROR CLASSES =====

/**
 * Base validation error for episode inputs
 */
export class EpisodeValidationError extends Error {
  public readonly code: string;
  public readonly field?: string;
  public readonly context: Record<string, unknown>;
  public readonly userMessage: string;

  constructor(
    message: string,
    code: string,
    context: Record<string, unknown> = {},
    field?: string
  ) {
    super(message);
    this.name = 'EpisodeValidationError';
    this.code = code;
    this.field = field;
    this.context = context;
    this.userMessage = message; // User-friendly message

    Error.captureStackTrace(this, this.constructor);
  }

  /**
   * Convert to API response format
   */
  toJSON() {
    return {
      success: false,
      error: {
        type: 'VALIDATION_ERROR',
        code: this.code,
        message: this.message,
        field: this.field,
        context: this.context,
        userMessage: this.userMessage,
      },
    };
  }
}

/**
 * Content too short error
 */
export class ContentTooShortError extends EpisodeValidationError {
  constructor(minLength: number, actualLength: number) {
    super(
      EPISODE_ERROR_MESSAGES.CONTENT_TOO_SHORT(minLength, actualLength),
      'CONTENT_TOO_SHORT',
      { minLength, actualLength, deficit: minLength - actualLength },
      'content'
    );
    this.name = 'ContentTooShortError';
  }
}

/**
 * Content too long error (DoS prevention)
 */
export class ContentTooLongError extends EpisodeValidationError {
  constructor(maxLength: number, actualLength: number) {
    super(
      EPISODE_ERROR_MESSAGES.CONTENT_TOO_LONG(maxLength, actualLength),
      'CONTENT_TOO_LONG',
      { maxLength, actualLength, excess: actualLength - maxLength },
      'content'
    );
    this.name = 'ContentTooLongError';
  }
}

/**
 * Insufficient semantic content error
 */
export class InsufficientContentError extends EpisodeValidationError {
  constructor(minWords: number, actualWords: number) {
    super(
      EPISODE_ERROR_MESSAGES.INSUFFICIENT_WORDS(minWords, actualWords),
      'INSUFFICIENT_CONTENT',
      { minWords, actualWords, deficit: minWords - actualWords },
      'content'
    );
    this.name = 'InsufficientContentError';
  }
}

// ===== ZOD VALIDATION SCHEMAS =====

/**
 * Episode type enum
 */
const EpisodeTypeSchema = z.enum([
  'user_query',
  'agent_response',
  'orchestration',
  'competition',
  'synthesis',
  'feedback',
  'system_response',
  'event',
  'observation',
  'insight',
]);

export type EpisodeType = z.infer<typeof EpisodeTypeSchema>;

/**
 * Episode metadata schema
 */
const EpisodeMetadataSchema = z
  .object({
    agentId: z.string().optional(),
    agentName: z.string().optional(),
    model: z.string().optional(),
    taskId: z.string().optional(),
    taskType: z.string().optional(),
    sessionId: z.string().optional(),
    timestamp: z.union([z.string(), z.date()]).optional(),
    importance: z.number().min(0).max(1).optional(),
    tokens: z.number().int().positive().optional(),
    latency: z.number().positive().optional(),
    temperature: z.number().min(0).max(2).optional(),
    parentEpisodeId: z.string().optional(),
    threadId: z.string().optional(),
    entities: z.array(z.string()).optional(),
    facts: z.array(z.string()).optional(),
    sentiment: z.number().min(-1).max(1).optional(),
    confidence: z.number().min(0).max(1).optional(),
    user_id: z.string().optional(),
  })
  .passthrough(); // Allow additional metadata fields

/**
 * Core episode content validation schema
 */
export const EpisodeContentSchema = z.object({
  content: z
    .string()
    .trim()
    .min(
      EPISODE_VALIDATION_RULES.MIN_CONTENT_LENGTH,
      EPISODE_ERROR_MESSAGES.CONTENT_TOO_SHORT(
        EPISODE_VALIDATION_RULES.MIN_CONTENT_LENGTH,
        0
      )
    )
    .max(
      EPISODE_VALIDATION_RULES.MAX_CONTENT_LENGTH,
      EPISODE_ERROR_MESSAGES.CONTENT_TOO_LONG(
        EPISODE_VALIDATION_RULES.MAX_CONTENT_LENGTH,
        0
      )
    )
    .refine(
      (content) => content.trim().length > 0,
      {
        message: EPISODE_ERROR_MESSAGES.CONTENT_EMPTY,
      }
    ),
  type: EpisodeTypeSchema,
  metadata: EpisodeMetadataSchema.optional(),
});

export type EpisodeContent = z.infer<typeof EpisodeContentSchema>;

/**
 * Full episode schema with additional validation
 */
export const EpisodeSchema = EpisodeContentSchema.extend({
  id: z.string().uuid().optional(),
  relationships: z
    .object({
      references: z.array(z.string()).optional(),
      contradicts: z.array(z.string()).optional(),
      supports: z.array(z.string()).optional(),
      extends: z.array(z.string()).optional(),
    })
    .optional(),
});

export type Episode = z.infer<typeof EpisodeSchema>;

// ===== VALIDATION FUNCTIONS =====

/**
 * Validate episode content with semantic checks
 *
 * Performs:
 * 1. Schema validation (Zod)
 * 2. Semantic word count check
 * 3. Whitespace-only detection
 *
 * @throws {EpisodeValidationError} If validation fails
 * @returns Validated and sanitized episode data
 */
export function validateEpisodeContent(input: unknown): EpisodeContent {
  // Step 1: Schema validation
  const result = EpisodeContentSchema.safeParse(input);

  if (!result.success) {
    const firstError = result.error.errors[0];

    // Extract length info for custom error messages
    const content = typeof input === 'object' && input !== null && 'content' in input
      ? (input as any).content
      : '';
    const contentLength = typeof content === 'string' ? content.trim().length : 0;

    // Handle specific validation errors with custom error classes
    if (firstError.path.includes('content')) {
      if (firstError.code === 'too_small') {
        throw new ContentTooShortError(
          EPISODE_VALIDATION_RULES.MIN_CONTENT_LENGTH,
          contentLength
        );
      }
      if (firstError.code === 'too_big') {
        throw new ContentTooLongError(
          EPISODE_VALIDATION_RULES.MAX_CONTENT_LENGTH,
          contentLength
        );
      }
    }

    // Generic validation error
    throw new EpisodeValidationError(
      firstError.message,
      'SCHEMA_VALIDATION_FAILED',
      {
        field: firstError.path.join('.'),
        code: firstError.code,
        zodError: result.error.format(),
      },
      firstError.path[0] as string
    );
  }

  const validatedData = result.data;

  // Step 2: Semantic validation - word count check
  const words = validatedData.content
    .trim()
    .split(/\s+/)
    .filter((word) => word.length > 0);

  if (words.length < EPISODE_VALIDATION_RULES.MIN_WORD_COUNT) {
    throw new InsufficientContentError(
      EPISODE_VALIDATION_RULES.MIN_WORD_COUNT,
      words.length
    );
  }

  // Step 3: Check for repetitive single character (e.g., "aaaaaaaaaa")
  const distinctChars = new Set(validatedData.content.trim().toLowerCase().replace(/\s/g, ''));
  if (distinctChars.size < 3) {
    throw new InsufficientContentError(
      EPISODE_VALIDATION_RULES.MIN_WORD_COUNT,
      1
    );
  }

  return validatedData;
}

/**
 * Validate full episode object
 */
export function validateEpisode(input: unknown): Episode {
  const result = EpisodeSchema.safeParse(input);

  if (!result.success) {
    const firstError = result.error.errors[0];

    throw new EpisodeValidationError(
      firstError.message,
      'EPISODE_VALIDATION_FAILED',
      {
        field: firstError.path.join('.'),
        code: firstError.code,
        zodError: result.error.format(),
      },
      firstError.path[0] as string
    );
  }

  return result.data;
}

/**
 * Type guard for episode validation errors
 */
export function isEpisodeValidationError(error: unknown): error is EpisodeValidationError {
  return error instanceof EpisodeValidationError;
}

/**
 * Extract user-friendly error message from validation error
 */
export function extractUserMessage(error: unknown): string {
  if (isEpisodeValidationError(error)) {
    return error.userMessage;
  }

  if (error instanceof Error) {
    return error.message;
  }

  return 'An unexpected validation error occurred';
}

/**
 * Validate user message input (simplified interface for direct message storage)
 */
export function validateUserMessage(message: string, sessionId: string): EpisodeContent {
  return validateEpisodeContent({
    content: message,
    type: 'user_query',
    metadata: {
      sessionId,
      timestamp: new Date().toISOString(),
      importance: 0.8,
    },
  });
}
