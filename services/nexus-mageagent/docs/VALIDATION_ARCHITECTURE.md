# Episode Validation Architecture

## Overview

The MageAgent service implements a **defense-in-depth validation strategy** for episode content storage. This ensures that invalid inputs are caught at the earliest possible layer, preventing wasted processing cycles and providing clear error messages to users.

## Problem Solved

**Before**: Users could submit messages shorter than 10 characters (e.g., "test"), which would:
- ❌ Pass through all frontend and backend layers unvalidated
- ❌ Waste network bandwidth to GraphRAG service
- ❌ Waste CPU cycles on embedding generation
- ❌ Return cryptic error messages ("Bad Request")
- ❌ Pollute vector database with non-semantic content

**After**: Multi-layer validation catches invalid inputs immediately:
- ✅ Validation at API gateway (Layer 1)
- ✅ Validation at service layer (Layer 2)
- ✅ Validation at HTTP client layer (Layer 3)
- ✅ Clear, actionable error messages
- ✅ No wasted network/CPU cycles

## Architecture

```
┌──────────────────────────────────────────────────────────────┐
│                    VALIDATION LAYERS                          │
├──────────────────────────────────────────────────────────────┤
│                                                               │
│  Layer 1: Express Middleware                                 │
│  📁 src/middleware/validation.ts                             │
│  ├─ XSS/SQL Injection sanitization                          │
│  ├─ Joi schema validation                                   │
│  ├─ Field normalization (task/prompt → task)                │
│  └─ Min/max length enforcement (10-50,000 chars)            │
│     ↓                                                         │
│  Layer 2: Service Layer (PRIMARY VALIDATION)                 │
│  📁 src/services/episode-service.ts                          │
│  📁 src/validation/episode-validation.ts                     │
│  ├─ Zod schema validation                                   │
│  ├─ Business rule enforcement                               │
│  ├─ Semantic content validation (word count, etc.)          │
│  └─ Custom error messages                                   │
│     ↓                                                         │
│  Layer 3: Client Layer (PRE-FLIGHT)                          │
│  📁 src/clients/graphrag-client.ts                           │
│  ├─ Final validation before HTTP calls                      │
│  ├─ Type guards for API responses                           │
│  └─ Prevents wasted network bandwidth                       │
│     ↓                                                         │
│  Layer 4: GraphRAG Service (FINAL CONTRACT)                  │
│  └─ Backend service validates (existing)                     │
│                                                               │
└──────────────────────────────────────────────────────────────┘
```

## Validation Rules

### Business Rules (Enforced at All Layers)

| Rule | Value | Rationale |
|------|-------|-----------|
| **Min Content Length** | 10 characters | Ensures meaningful semantic content for embeddings |
| **Max Content Length** | 50,000 characters | DoS prevention, reasonable context window |
| **Min Word Count** | 3 words | Prevents gibberish like "aaaaaaaaaa" |
| **Min Character Diversity** | 3 unique characters | Prevents repetitive content |

### Allowed Episode Types

```typescript
'user_query'        // User input messages
'agent_response'    // Agent-generated responses
'orchestration'     // Orchestration events
'competition'       // Competition challenges
'synthesis'         // Synthesis results
'feedback'          // User feedback
'system_response'   // System-generated events
'event'             // General events
'observation'       // Agent observations
'insight'           // Discovered insights
```

## Error Handling

### Custom Error Classes

All validation errors extend `EpisodeValidationError` and include:
- **User-friendly message** (shown to end users)
- **Error code** (for programmatic handling)
- **Field name** (which field failed validation)
- **Context** (additional debugging information)

```typescript
// Example: Content too short error
{
  "success": false,
  "error": {
    "type": "VALIDATION_ERROR",
    "code": "CONTENT_TOO_SHORT",
    "message": "Message must be at least 10 characters. You provided 4 characters. Please add 6 more characters to provide meaningful context.",
    "field": "content",
    "context": {
      "minLength": 10,
      "actualLength": 4,
      "deficit": 6
    },
    "userMessage": "Message must be at least 10 characters..."
  }
}
```

### Error Types

| Error Class | Code | Trigger | User Message |
|-------------|------|---------|--------------|
| `ContentTooShortError` | `CONTENT_TOO_SHORT` | Length < 10 chars | "Message must be at least 10 characters..." |
| `ContentTooLongError` | `CONTENT_TOO_LONG` | Length > 50,000 chars | "Message exceeds maximum length..." |
| `InsufficientContentError` | `INSUFFICIENT_CONTENT` | < 3 words or < 3 unique chars | "Message must contain at least 3 distinct words..." |
| `EpisodeValidationError` | `SCHEMA_VALIDATION_FAILED` | Invalid type/schema | Schema-specific error message |

## Usage Examples

### Service Layer (Primary Validation)

```typescript
import { episodeService } from './services/episode-service';
import { isEpisodeValidationError } from './validation/episode-validation';

try {
  // This will throw ContentTooShortError
  const episode = await episodeService.createFromUserInput(
    'test',        // Only 4 characters
    'session_123'
  );
} catch (error) {
  if (isEpisodeValidationError(error)) {
    console.error(error.userMessage);
    // "Message must be at least 10 characters. You provided 4 characters..."
    console.error(error.code); // "CONTENT_TOO_SHORT"
    console.error(error.context); // { minLength: 10, actualLength: 4, deficit: 6 }
  }
}
```

### Direct Validation (Library Usage)

```typescript
import {
  validateEpisodeContent,
  validateUserMessage,
  ContentTooShortError,
} from './validation/episode-validation';

// Validate episode content
try {
  const validatedData = validateEpisodeContent({
    content: 'This is a valid message with sufficient length',
    type: 'user_query',
    metadata: { sessionId: 'session_123' },
  });

  console.log('✅ Validation passed:', validatedData);
} catch (error) {
  if (error instanceof ContentTooShortError) {
    console.error('❌ Content too short:', error.message);
  }
}

// Simplified user message validation
try {
  const validated = validateUserMessage('test', 'session_123');
} catch (error) {
  // Throws ContentTooShortError
}
```

### API Response Handling

```typescript
// Express error handler middleware
app.use((error, req, res, next) => {
  if (isEpisodeValidationError(error)) {
    return res.status(400).json(error.toJSON());
  }

  // Handle other errors...
});
```

## Testing

Comprehensive test suite located at:
- **Unit Tests**: `tests/validation/episode-validation.test.ts`

### Test Coverage

- ✅ Valid inputs (minimum length, maximum length, all types)
- ✅ Invalid inputs (too short, too long, empty, whitespace-only)
- ✅ Semantic validation (word count, character diversity)
- ✅ Type validation (invalid types, missing types)
- ✅ Malformed data (null, undefined, non-objects)
- ✅ Edge cases (Unicode, special characters, newlines)
- ✅ Error handling (error types, serialization, user messages)

### Running Tests

```bash
# Run validation tests only
npm test -- episode-validation.test.ts

# Run all tests
npm test

# Run with coverage
npm run test:coverage
```

## Migration Guide

### For Frontend Developers

**No changes required** - Validation now happens server-side.

However, for better UX, consider adding client-side hints:
```typescript
// Add character counter
const [message, setMessage] = useState('');
const isValid = message.trim().length >= 10;

<input
  value={message}
  onChange={(e) => setMessage(e.target.value)}
  aria-invalid={!isValid}
/>
<span>{message.trim().length} / 10 characters (minimum)</span>
```

### For Backend Developers

**No breaking changes** - Validation happens automatically.

All existing code continues to work. Errors now provide better messages:

```typescript
// Before: Generic error
throw new Error('Bad Request');

// After: Specific validation error
throw new ContentTooShortError(10, 4);
// Error includes: code, field, context, userMessage
```

### For API Consumers

**Error response format enhanced**:

```diff
// Before
{
  "error": "Bad Request"
}

// After
{
  "success": false,
  "error": {
    "type": "VALIDATION_ERROR",
    "code": "CONTENT_TOO_SHORT",
    "message": "Message must be at least 10 characters. You provided 4 characters. Please add 6 more characters...",
    "field": "content",
    "context": { "minLength": 10, "actualLength": 4, "deficit": 6 },
+   "userMessage": "Message must be at least 10 characters..."
  }
}
```

## Configuration

Validation rules are centralized in constants:

```typescript
// src/validation/episode-validation.ts
export const EPISODE_VALIDATION_RULES = {
  MIN_CONTENT_LENGTH: 10,
  MAX_CONTENT_LENGTH: 50000,
  MIN_WORD_COUNT: 3,
  MAX_TAG_LENGTH: 50,
  MAX_TAGS: 20,
} as const;
```

**To change rules**: Update these constants (single source of truth).

## Performance Impact

### Before Validation

```
User sends "test" (4 chars)
  ↓ Network RTT: 50ms
MageAgent API receives
  ↓ Sanitization: 5ms
EpisodeService processes
  ↓ Network RTT: 100ms
GraphRAG validates
  ↓ Error: 10ms
Return error to user
━━━━━━━━━━━━━━━━━━━━
Total: ~165ms (wasted)
```

### After Validation

```
User sends "test" (4 chars)
  ↓ Network RTT: 50ms
MageAgent Middleware validates
  ↓ Validation: 1ms
Return error to user
━━━━━━━━━━━━━━━━━━━━
Total: ~51ms (69% faster!)
+ Saved GraphRAG CPU cycles
+ Prevented vector DB pollution
```

## Security Benefits

1. **DoS Prevention**
   - Max length limit (50,000 chars) prevents massive payloads
   - Early rejection at API gateway (before DB/service layer)

2. **Injection Prevention**
   - XSS/SQL sanitization at middleware (Layer 1)
   - Schema validation at service layer (Layer 2)
   - Defense-in-depth approach

3. **Data Quality**
   - Prevents non-semantic content in vector DB
   - Ensures meaningful embeddings
   - Maintains search relevance

## Troubleshooting

### "Message must be at least 10 characters"

**Cause**: User input too short
**Fix**: Ask user to provide more descriptive content

```typescript
// Bad
"test"

// Good
"What are the best practices for React hooks?"
```

### "Message exceeds maximum length"

**Cause**: User input > 50,000 characters
**Fix**: Split into multiple messages or summarize

```typescript
// Bad
content.length = 51,000

// Good
Split into 2 messages of 25,500 chars each
```

### "Message must contain at least 3 distinct words"

**Cause**: Gibberish or repetitive content
**Fix**: Provide meaningful, descriptive text

```typescript
// Bad
"aaaaaaaaaa"
"test test test"

// Good
"Please help me debug this error"
```

## Future Enhancements

- [ ] Add semantic analysis (detect spam/abuse)
- [ ] Add language detection (multi-language support)
- [ ] Add rate limiting per session/user
- [ ] Add content classification (question/statement/command)
- [ ] Add profanity filtering (optional)
- [ ] Add custom validation rules per tenant

## References

- **Zod Documentation**: https://zod.dev/
- **OWASP Input Validation**: https://cheatsheetseries.owasp.org/cheatsheets/Input_Validation_Cheat_Sheet.html
- **Defense in Depth**: https://en.wikipedia.org/wiki/Defense_in_depth_(computing)

## Contact

For questions or issues:
- **GitHub Issues**: https://github.com/adverant/Adverant-Nexus/issues
- **Documentation**: https://github.com/adverant/Adverant-Nexus/tree/main/services/nexus-mageagent#readme
