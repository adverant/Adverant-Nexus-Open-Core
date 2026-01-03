/**
 * Episode Validation Test Suite
 *
 * Tests defense-in-depth validation for episode content storage.
 * Validates that all validation layers correctly enforce business rules.
 */

import {
  validateEpisodeContent,
  validateUserMessage,
  validateEpisode,
  ContentTooShortError,
  ContentTooLongError,
  InsufficientContentError,
  EpisodeValidationError,
  isEpisodeValidationError,
  extractUserMessage,
  EPISODE_VALIDATION_RULES,
  type EpisodeContent,
} from '../../src/validation/episode-validation';

describe('Episode Validation - Defense-in-Depth', () => {
  describe('validateEpisodeContent()', () => {
    describe('✅ VALID INPUTS', () => {
      it('should accept valid episode with minimum length', () => {
        const validInput = {
          content: 'This is a valid message with sufficient length',
          type: 'user_query' as const,
          metadata: {},
        };

        expect(() => validateEpisodeContent(validInput)).not.toThrow();
        const result = validateEpisodeContent(validInput);
        expect(result.content).toBe(validInput.content);
        expect(result.type).toBe('user_query');
      });

      it('should accept episode with exactly minimum length', () => {
        const exactMinInput = {
          content: 'A'.repeat(EPISODE_VALIDATION_RULES.MIN_CONTENT_LENGTH),
          type: 'agent_response' as const,
        };

        expect(() => validateEpisodeContent(exactMinInput)).not.toThrow();
      });

      it('should accept episode with long content', () => {
        const longInput = {
          content: 'This is a very detailed and comprehensive message that contains a lot of contextual information. '.repeat(10),
          type: 'synthesis' as const,
        };

        expect(() => validateEpisodeContent(longInput)).not.toThrow();
      });

      it('should accept all valid episode types', () => {
        const validTypes = [
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
        ];

        validTypes.forEach((type) => {
          const input = {
            content: 'This is a valid message with sufficient length',
            type: type as any,
          };

          expect(() => validateEpisodeContent(input)).not.toThrow();
        });
      });

      it('should trim whitespace and validate trimmed length', () => {
        const inputWithWhitespace = {
          content: '   This is valid content with whitespace   ',
          type: 'user_query' as const,
        };

        const result = validateEpisodeContent(inputWithWhitespace);
        expect(result.content).toBe('This is valid content with whitespace');
      });
    });

    describe('❌ INVALID INPUTS - Length Violations', () => {
      it('should reject content shorter than minimum', () => {
        const tooShortInput = {
          content: 'test',
          type: 'user_query' as const,
        };

        expect(() => validateEpisodeContent(tooShortInput)).toThrow(ContentTooShortError);

        try {
          validateEpisodeContent(tooShortInput);
        } catch (error) {
          expect(error).toBeInstanceOf(ContentTooShortError);
          expect((error as ContentTooShortError).code).toBe('CONTENT_TOO_SHORT');
          expect((error as ContentTooShortError).field).toBe('content');
          expect((error as ContentTooShortError).context.actualLength).toBe(4);
          expect((error as ContentTooShortError).context.deficit).toBe(6); // 10 - 4
        }
      });

      it('should reject empty content', () => {
        const emptyInput = {
          content: '',
          type: 'user_query' as const,
        };

        expect(() => validateEpisodeContent(emptyInput)).toThrow(EpisodeValidationError);
      });

      it('should reject content that is only whitespace', () => {
        const whitespaceInput = {
          content: '    ',
          type: 'user_query' as const,
        };

        expect(() => validateEpisodeContent(whitespaceInput)).toThrow();
      });

      it('should reject content exceeding maximum length', () => {
        const tooLongInput = {
          content: 'A'.repeat(EPISODE_VALIDATION_RULES.MAX_CONTENT_LENGTH + 1),
          type: 'user_query' as const,
        };

        expect(() => validateEpisodeContent(tooLongInput)).toThrow(ContentTooLongError);

        try {
          validateEpisodeContent(tooLongInput);
        } catch (error) {
          expect(error).toBeInstanceOf(ContentTooLongError);
          expect((error as ContentTooLongError).code).toBe('CONTENT_TOO_LONG');
          expect((error as ContentTooLongError).context.excess).toBe(1);
        }
      });
    });

    describe('❌ INVALID INPUTS - Semantic Validation', () => {
      it('should reject content with insufficient words', () => {
        const insufficientWordsInput = {
          content: 'test test',
          type: 'user_query' as const,
        };

        expect(() => validateEpisodeContent(insufficientWordsInput)).toThrow(InsufficientContentError);

        try {
          validateEpisodeContent(insufficientWordsInput);
        } catch (error) {
          expect(error).toBeInstanceOf(InsufficientContentError);
          expect((error as InsufficientContentError).code).toBe('INSUFFICIENT_CONTENT');
          expect((error as InsufficientContentError).context.actualWords).toBeLessThan(
            EPISODE_VALIDATION_RULES.MIN_WORD_COUNT
          );
        }
      });

      it('should reject repetitive single character content', () => {
        const repetitiveInput = {
          content: 'aaaaaaaaaa',
          type: 'user_query' as const,
        };

        expect(() => validateEpisodeContent(repetitiveInput)).toThrow(InsufficientContentError);
      });

      it('should reject gibberish content', () => {
        const gibberishInput = {
          content: 'asdfasdfasdf',
          type: 'user_query' as const,
        };

        expect(() => validateEpisodeContent(gibberishInput)).toThrow(InsufficientContentError);
      });
    });

    describe('❌ INVALID INPUTS - Type Validation', () => {
      it('should reject invalid episode type', () => {
        const invalidTypeInput = {
          content: 'This is a valid message with sufficient length',
          type: 'invalid_type' as any,
        };

        expect(() => validateEpisodeContent(invalidTypeInput)).toThrow(EpisodeValidationError);
      });

      it('should reject missing episode type', () => {
        const missingTypeInput = {
          content: 'This is a valid message with sufficient length',
        };

        expect(() => validateEpisodeContent(missingTypeInput as any)).toThrow(EpisodeValidationError);
      });
    });

    describe('❌ INVALID INPUTS - Malformed Data', () => {
      it('should reject null input', () => {
        expect(() => validateEpisodeContent(null as any)).toThrow(EpisodeValidationError);
      });

      it('should reject undefined input', () => {
        expect(() => validateEpisodeContent(undefined as any)).toThrow(EpisodeValidationError);
      });

      it('should reject non-object input', () => {
        expect(() => validateEpisodeContent('string' as any)).toThrow(EpisodeValidationError);
        expect(() => validateEpisodeContent(123 as any)).toThrow(EpisodeValidationError);
        expect(() => validateEpisodeContent(true as any)).toThrow(EpisodeValidationError);
      });

      it('should reject missing content field', () => {
        const missingContentInput = {
          type: 'user_query' as const,
        };

        expect(() => validateEpisodeContent(missingContentInput as any)).toThrow(EpisodeValidationError);
      });
    });
  });

  describe('validateUserMessage()', () => {
    it('should validate and wrap user message correctly', () => {
      const message = 'This is a user message with sufficient length';
      const sessionId = 'session_123';

      const result = validateUserMessage(message, sessionId);

      expect(result.content).toBe(message);
      expect(result.type).toBe('user_query');
      expect(result.metadata?.sessionId).toBe(sessionId);
      expect(result.metadata?.importance).toBe(0.8);
    });

    it('should reject short user message', () => {
      expect(() => validateUserMessage('test', 'session_123')).toThrow(ContentTooShortError);
    });
  });

  describe('validateEpisode()', () => {
    it('should validate full episode with all fields', () => {
      const fullEpisode = {
        id: '550e8400-e29b-41d4-a716-446655440000',
        content: 'This is a complete episode with all metadata',
        type: 'agent_response' as const,
        metadata: {
          agentId: 'agent_123',
          agentName: 'Research Agent',
          model: 'gpt-4',
          taskId: 'task_123',
          sessionId: 'session_123',
          timestamp: new Date().toISOString(),
          importance: 0.9,
        },
        relationships: {
          references: ['episode_1', 'episode_2'],
          supports: ['episode_3'],
        },
      };

      expect(() => validateEpisode(fullEpisode)).not.toThrow();
      const result = validateEpisode(fullEpisode);
      expect(result.id).toBe(fullEpisode.id);
      expect(result.relationships).toEqual(fullEpisode.relationships);
    });
  });

  describe('Error Handling Utilities', () => {
    it('should correctly identify EpisodeValidationError', () => {
      const validationError = new EpisodeValidationError('Test error', 'TEST_CODE');
      const genericError = new Error('Generic error');

      expect(isEpisodeValidationError(validationError)).toBe(true);
      expect(isEpisodeValidationError(genericError)).toBe(false);
      expect(isEpisodeValidationError(null)).toBe(false);
      expect(isEpisodeValidationError(undefined)).toBe(false);
    });

    it('should extract user message from validation errors', () => {
      const validationError = new ContentTooShortError(10, 4);
      const genericError = new Error('Generic error');

      expect(extractUserMessage(validationError)).toContain('10 characters');
      expect(extractUserMessage(genericError)).toBe('Generic error');
      expect(extractUserMessage(null)).toBe('An unexpected validation error occurred');
    });

    it('should serialize validation error to JSON correctly', () => {
      const error = new ContentTooShortError(10, 4);
      const json = error.toJSON();

      expect(json.success).toBe(false);
      expect(json.error.type).toBe('VALIDATION_ERROR');
      expect(json.error.code).toBe('CONTENT_TOO_SHORT');
      expect(json.error.field).toBe('content');
      expect(json.error.context.deficit).toBe(6);
    });
  });

  describe('Edge Cases', () => {
    it('should handle content with exactly minimum word count', () => {
      const exactWordCountInput = {
        content: 'one two three',
        type: 'user_query' as const,
      };

      expect(() => validateEpisodeContent(exactWordCountInput)).not.toThrow();
    });

    it('should handle content with Unicode characters', () => {
      const unicodeInput = {
        content: 'こんにちは世界 Hello World! 🌍',
        type: 'user_query' as const,
      };

      expect(() => validateEpisodeContent(unicodeInput)).not.toThrow();
    });

    it('should handle content with special characters', () => {
      const specialCharsInput = {
        content: 'Valid content with special chars: !@#$%^&*()',
        type: 'user_query' as const,
      };

      expect(() => validateEpisodeContent(specialCharsInput)).not.toThrow();
    });

    it('should handle content with newlines', () => {
      const newlineInput = {
        content: 'Valid content\nwith multiple\nlines of text',
        type: 'user_query' as const,
      };

      expect(() => validateEpisodeContent(newlineInput)).not.toThrow();
    });

    it('should handle optional metadata fields', () => {
      const withOptionalMetadata = {
        content: 'Valid content with comprehensive metadata',
        type: 'agent_response' as const,
        metadata: {
          agentId: 'agent_123',
          model: 'gpt-4',
          temperature: 0.7,
          confidence: 0.95,
          entities: ['Entity1', 'Entity2'],
          facts: ['Fact1', 'Fact2'],
        },
      };

      expect(() => validateEpisodeContent(withOptionalMetadata)).not.toThrow();
    });
  });

  describe('Performance - Validation Constants', () => {
    it('should expose validation constants for configuration', () => {
      expect(EPISODE_VALIDATION_RULES.MIN_CONTENT_LENGTH).toBe(10);
      expect(EPISODE_VALIDATION_RULES.MAX_CONTENT_LENGTH).toBe(50000);
      expect(EPISODE_VALIDATION_RULES.MIN_WORD_COUNT).toBe(3);
    });
  });
});
