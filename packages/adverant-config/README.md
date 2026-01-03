# @adverant/config

Unified configuration management for Nexus Nexus services with validation, type safety, secret management, and **centralized port registry**.

## Features

- ✅ **Type-Safe Configuration** - TypeScript with full type safety
- ✅ **Schema Validation** - Define and validate configuration schema
- ✅ **Environment Variables** - Load from .env files and environment
- ✅ **Secret Management** - Integration with Google Secret Manager
- ✅ **Default Values** - Sensible defaults with override capability
- ✅ **Required Fields** - Enforce required configuration
- ✅ **Type Coercion** - Auto-convert strings to numbers, booleans, JSON
- ✅ **Custom Validation** - Add custom validation functions
- ✅ **Secret Protection** - Mark sensitive fields (not logged)
- ✅ **Centralized Port Registry** - Single source of truth for all port allocations
- ✅ **Environment-Aware Ports** - Auto-detect Docker/Kubernetes/Istio
- ✅ **Port Conflict Detection** - Prevents port allocation conflicts

## Installation

```bash
npm install @adverant/config
```

For Google Secret Manager support:
```bash
npm install @google-cloud/secret-manager
```

## Quick Start

```typescript
import { createConfigLoader, createServiceConfig } from '@adverant/config';

// Define configuration schema
const schema = {
  port: {
    env: 'PORT',
    type: 'port',
    required: true,
    default: 3000,
  },
  databaseUrl: {
    env: 'DATABASE_URL',
    type: 'url',
    required: true,
    secret: true,
  },
  jwtSecret: {
    env: 'JWT_SECRET',
    type: 'string',
    required: true,
    secret: true,
    validate: (value) => value.length >= 32 || 'Must be at least 32 characters',
  },
  logLevel: {
    env: 'LOG_LEVEL',
    type: 'string',
    default: 'info',
  },
};

// Load configuration
const loader = createConfigLoader({ schema });
const config = await loader.load();

// Use configuration
console.log(`Starting server on port ${config.port}`);
```

## Configuration Schema

Define your configuration schema with validation:

```typescript
import { ConfigSchema } from '@adverant/config';

const schema: ConfigSchema = {
  // Basic field
  serviceName: {
    default: 'my-service',
    type: 'string',
    description: 'Service name',
  },

  // Required field
  apiKey: {
    env: 'API_KEY',
    type: 'string',
    required: true,
    secret: true,
  },

  // With validation
  port: {
    env: 'PORT',
    type: 'port',
    required: true,
    validate: (value) => {
      return value >= 1024 || 'Port must be >= 1024';
    },
  },

  // With transform
  features: {
    env: 'FEATURES',
    type: 'json',
    default: {},
    transform: (value) => JSON.parse(value),
  },

  // Boolean
  enableCache: {
    env: 'ENABLE_CACHE',
    type: 'boolean',
    default: true,
  },
};
```

## Field Types

Supported types with auto-conversion:

| Type | Description | Auto-Convert |
|------|-------------|--------------|
| `string` | String value | No |
| `number` | Numeric value | Yes (`"123"` → `123`) |
| `boolean` | Boolean value | Yes (`"true"` → `true`) |
| `port` | Port number (1-65535) | Yes + validation |
| `url` | Valid URL | No (validates) |
| `email` | Valid email | No (validates) |
| `json` | JSON object | Yes (parses) |

## Google Secret Manager Integration

Load secrets from Google Cloud Secret Manager:

```typescript
import { createConfigLoader, createGoogleSecretProvider } from '@adverant/config';

const secretProvider = createGoogleSecretProvider('my-project-id');

const schema = {
  apiKey: {
    env: 'API_KEY',
    type: 'string',
    required: true,
    secret: true, // Will try to load from Secret Manager
  },
};

const loader = createConfigLoader({
  schema,
  secretProvider,
});

const config = await loader.load();
```

Secret loading fallback:
1. Check environment variable
2. If not found and field is `secret: true`, check Secret Manager
3. If still not found, use default or fail validation

## Using with Services

### Example: MageAgent Configuration

```typescript
import { createConfigLoader } from '@adverant/config';

const schema = {
  // Service
  port: { env: 'PORT', type: 'port', required: true, default: 9002 },
  environment: { env: 'NODE_ENV', default: 'development' },

  // Database
  postgresUrl: { env: 'POSTGRES_URL', type: 'url', required: true, secret: true },
  redisUrl: { env: 'REDIS_URL', type: 'url', required: true, secret: true },
  neo4jUrl: { env: 'NEO4J_URL', type: 'url', required: true, secret: true },
  qdrantUrl: { env: 'QDRANT_URL', type: 'url', required: true, secret: true },

  // Auth
  jwtSecret: {
    env: 'JWT_SECRET',
    type: 'string',
    required: true,
    secret: true,
    validate: (v) => v.length >= 32 || 'JWT secret must be at least 32 characters',
  },

  // External services
  graphragUrl: { env: 'GRAPHRAG_URL', type: 'url', required: true },
  openrouterApiKey: { env: 'OPENROUTER_API_KEY', type: 'string', secret: true },

  // Logging
  logLevel: {
    env: 'LOG_LEVEL',
    default: 'info',
    validate: (v) => ['debug', 'info', 'warn', 'error'].includes(v),
  },
};

const loader = createConfigLoader({ schema });
const config = await loader.load();

export default config;
```

### Example: GraphRAG Configuration

```typescript
import { createConfigLoader, createGoogleSecretProvider } from '@adverant/config';

const secretProvider = createGoogleSecretProvider(process.env.GCP_PROJECT_ID);

const schema = {
  port: { env: 'PORT', type: 'port', default: 9001 },
  postgresUrl: { env: 'POSTGRES_URL', type: 'url', required: true, secret: true },
  redisUrl: { env: 'REDIS_URL', type: 'url', required: true, secret: true },
  neo4jUrl: { env: 'NEO4J_URL', type: 'url', required: true, secret: true },
  qdrantUrl: { env: 'QDRANT_URL', type: 'url', required: true, secret: true },
  voyageApiKey: { env: 'VOYAGE_API_KEY', type: 'string', required: true, secret: true },
};

const loader = createConfigLoader({ schema, secretProvider });
const config = await loader.load();

export default config;
```

## Helper: Create Service Config

Use the built-in helper for common service configuration:

```typescript
import { createServiceConfig, createConfigLoader } from '@adverant/config';

// Creates schema with common fields (port, database, redis, jwt, logging)
const schema = createServiceConfig('mageagent');

// Extend with service-specific fields
const extendedSchema = {
  ...schema,
  openrouterApiKey: {
    env: 'OPENROUTER_API_KEY',
    type: 'string',
    secret: true,
  },
};

const loader = createConfigLoader({ schema: extendedSchema });
const config = await loader.load();
```

## Validation

Configuration is validated when loaded:

```typescript
const loader = createConfigLoader({
  schema: {
    port: { type: 'port', required: true },
  },
  throwOnValidationError: true, // Default
});

try {
  await loader.load();
} catch (error) {
  console.error('Configuration validation failed:', error.message);
  // Output:
  // Configuration validation failed:
  //   - port: Required field is missing
}
```

## Environment-Specific Configuration

```typescript
const loader = createConfigLoader({
  schema,
  environment: 'production', // or process.env.NODE_ENV
  envFilePath: '.env.production',
});

// Check environment
if (loader.isProduction()) {
  console.log('Running in production');
}
```

## API Reference

### createConfigLoader(options)

Create a configuration loader.

**Options**:
- `schema` - Configuration schema (required)
- `environment` - Environment (`development`, `production`, `test`, `staging`)
- `envFilePath` - Path to .env file (default: `.env`)
- `loadEnvFile` - Load .env file (default: `true`)
- `envPrefix` - Prefix for environment variables
- `throwOnValidationError` - Throw on validation errors (default: `true`)
- `secretProvider` - Secret manager provider

**Returns**: `ConfigLoader` instance

### loader.load()

Load and validate configuration.

**Returns**: `Promise<Record<string, any>>` - Loaded configuration

### loader.get(key, defaultValue)

Get configuration value.

**Parameters**:
- `key` - Configuration key
- `defaultValue` - Default value if not found

**Returns**: Configuration value

### loader.getAll()

Get all configuration.

**Returns**: `Record<string, any>` - All configuration

## Best Practices

1. **Define schema explicitly**
   ```typescript
   // Good: Explicit schema with validation
   const schema = {
     port: { type: 'port', required: true, default: 3000 },
   };

   // Bad: No schema
   const port = process.env.PORT || 3000;
   ```

2. **Mark secrets appropriately**
   ```typescript
   const schema = {
     jwtSecret: { env: 'JWT_SECRET', secret: true }, // Won't be logged
   };
   ```

3. **Use validation for critical fields**
   ```typescript
   const schema = {
     jwtSecret: {
       validate: (v) => v.length >= 32 || 'Must be at least 32 characters',
     },
   };
   ```

4. **Provide defaults for optional fields**
   ```typescript
   const schema = {
     logLevel: { default: 'info' },
     enableCache: { default: true },
   };
   ```

5. **Use Google Secret Manager in production**
   ```typescript
   const secretProvider = process.env.NODE_ENV === 'production'
     ? createGoogleSecretProvider(projectId)
     : undefined;
   ```

## Migration from Existing Code

### From process.env

```typescript
// Before
const port = parseInt(process.env.PORT || '3000');
const dbUrl = process.env.DATABASE_URL;
if (!dbUrl) throw new Error('DATABASE_URL is required');

// After
const loader = createConfigLoader({
  schema: {
    port: { env: 'PORT', type: 'port', default: 3000 },
    databaseUrl: { env: 'DATABASE_URL', type: 'url', required: true },
  },
});
const config = await loader.load();
```

### From dotenv

```typescript
// Before
import dotenv from 'dotenv';
dotenv.config();

// After
import { createConfigLoader } from '@adverant/config';
const loader = createConfigLoader({ schema, loadEnvFile: true });
```

## License

MIT
