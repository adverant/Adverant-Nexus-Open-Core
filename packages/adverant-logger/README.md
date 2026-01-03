# @adverant/logger

Unified logging package for the Nexus stack with correlation ID support, structured logging, and multiple transport options.

## Features

- ✅ **Correlation ID Support** - Automatic request correlation tracking
- ✅ **Structured Logging** - JSON-formatted logs for easy parsing
- ✅ **Multiple Transports** - Console, file, daily rotate file
- ✅ **Log Levels** - debug, info, warn, error, with configurable level
- ✅ **Context Enrichment** - Add service name, environment, version
- ✅ **Performance** - Asynchronous logging with minimal overhead
- ✅ **TypeScript** - Full type safety
- ✅ **Express Middleware** - Built-in Express integration

## Installation

```bash
npm install @adverant/logger
```

## Quick Start

```typescript
import { createLogger } from '@adverant/logger';

const logger = createLogger({
  service: 'mageagent',
  level: 'info'
});

logger.info('Service started', { port: 3000 });
logger.error('Database connection failed', { error: err.message });
```

## Express Middleware

```typescript
import express from 'express';
import { createLoggerMiddleware, createLogger } from '@adverant/logger';

const app = express();
const logger = createLogger({ service: 'api' });

// Add correlation ID and request logging
app.use(createLoggerMiddleware(logger));

app.get('/api/users', (req, res) => {
  // Correlation ID automatically attached
  req.logger.info('Fetching users');
  res.json({ users: [] });
});
```

## Configuration

```typescript
interface LoggerConfig {
  service: string;              // Service name (required)
  level?: string;               // Log level (default: 'info')
  enableConsole?: boolean;      // Console transport (default: true)
  enableFile?: boolean;         // File transport (default: false)
  filePath?: string;            // Log file path
  enableDailyRotate?: boolean;  // Daily rotate file (default: false)
  maxFiles?: string;            // Max files for rotation (default: '14d')
  maxSize?: string;             // Max file size (default: '20m')
  format?: 'json' | 'pretty';   // Log format (default: 'json')
  metadata?: Record<string, any>; // Additional metadata
}
```

## Correlation ID

The logger automatically supports correlation IDs from:
- `x-correlation-id` header
- `x-request-id` header
- `x-trace-id` header
- Generated UUID if not provided

```typescript
// In Express middleware
app.use(createLoggerMiddleware(logger));

// In route handler
app.get('/api/data', (req, res) => {
  // Correlation ID in req.correlationId
  req.logger.info('Processing request', {
    userId: req.user.id,
    correlationId: req.correlationId
  });
});
```

## Advanced Usage

### Child Logger with Context

```typescript
const parentLogger = createLogger({ service: 'orchestrator' });

const childLogger = parentLogger.child({
  agentId: 'agent-123',
  sessionId: 'session-456'
});

childLogger.info('Agent started'); // Includes agentId and sessionId
```

### Structured Logging

```typescript
logger.info('User login', {
  userId: '123',
  email: 'user@example.com',
  ip: '192.168.1.1',
  timestamp: new Date(),
  duration: 150
});
```

### Error Logging

```typescript
try {
  await processData();
} catch (error) {
  logger.error('Data processing failed', {
    error: error.message,
    stack: error.stack,
    data: inputData
  });
}
```

## Log Format

### JSON Format (Production)
```json
{
  "level": "info",
  "message": "User login",
  "service": "auth-service",
  "timestamp": "2025-11-07T10:00:00.000Z",
  "correlationId": "abc-123-def",
  "userId": "123",
  "email": "user@example.com"
}
```

### Pretty Format (Development)
```
2025-11-07 10:00:00 [INFO] [auth-service] [abc-123-def] User login { userId: '123', email: 'user@example.com' }
```

## Best Practices

1. **Always include service name**
   ```typescript
   const logger = createLogger({ service: 'my-service' });
   ```

2. **Use appropriate log levels**
   - `debug`: Detailed diagnostic information
   - `info`: General informational messages
   - `warn`: Warning messages for potential issues
   - `error`: Error messages for failures

3. **Include context in metadata**
   ```typescript
   logger.info('Processing task', {
     taskId: task.id,
     userId: user.id,
     duration: elapsed
   });
   ```

4. **Don't log sensitive data**
   ```typescript
   // BAD
   logger.info('User authenticated', { password: user.password });

   // GOOD
   logger.info('User authenticated', { userId: user.id });
   ```

5. **Use correlation IDs**
   ```typescript
   // In Express middleware
   app.use(createLoggerMiddleware(logger));

   // Automatically available in all handlers
   ```

## Migration from Existing Loggers

### From Console.log

```typescript
// Before
console.log('User logged in:', userId);

// After
logger.info('User logged in', { userId });
```

### From Winston

```typescript
// Before
import winston from 'winston';
const logger = winston.createLogger({
  level: 'info',
  format: winston.format.json(),
  transports: [new winston.transports.Console()]
});

// After
import { createLogger } from '@adverant/logger';
const logger = createLogger({ service: 'my-service', level: 'info' });
```

## Performance

- Asynchronous logging with minimal blocking
- JSON serialization optimized
- Daily rotation prevents disk space issues
- Typical overhead: <1ms per log statement

## License

MIT
