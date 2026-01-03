/**
 * @adverant/config
 * Unified configuration management for Nexus stack services
 */

// Legacy config loader (Phase 0)
export { ConfigLoader, loadConfig, createConfigLoader } from './config-loader';
export { createGoogleSecretProvider, GoogleSecretManagerProvider } from './providers/google-secret-manager';
export { validateConfig } from './validators/schema-validator';
export {
  PortRegistryManager,
  getPortRegistry,
  resetPortRegistry,
  PORTS,
  type ServicePortConfig,
  type PortRegistry,
  type ServiceName,
} from './port-registry';
export {
  validatePortRegistry,
  enforceValidation,
  formatValidationResult,
  findAvailablePort,
  getPortStatistics,
  type PortConflict,
  type ValidationResult,
} from './validators/port-conflict-validator';
export type {
  ConfigSchema,
  ConfigField,
  ConfigOptions,
  ConfigEnvironment,
  SecretProvider,
  ValidationError,
  ConfigValidationResult,
} from './types';

// Phase 1: Unified Configuration Service
export {
  UnifiedConfigService,
  getConfigService,
  resetConfigService,
  type IConfigSource,
  type UnifiedConfigServiceOptions,
} from './unified-config-service';

/**
 * Helper function to create common config schemas
 */
export function createServiceConfig(serviceName: string) {
  return {
    // Service info
    serviceName: {
      default: serviceName,
      type: 'string' as const,
      description: 'Service name',
    },
    environment: {
      env: 'NODE_ENV',
      default: 'development',
      type: 'string' as const,
      description: 'Environment (development, production, test, staging)',
    },
    port: {
      env: 'PORT',
      type: 'port' as const,
      required: true,
      description: 'Service port',
    },

    // Database
    databaseUrl: {
      env: 'DATABASE_URL',
      type: 'url' as const,
      required: true,
      secret: true,
      description: 'PostgreSQL connection URL',
    },
    redisUrl: {
      env: 'REDIS_URL',
      type: 'url' as const,
      required: true,
      secret: true,
      description: 'Redis connection URL',
    },

    // Auth
    jwtSecret: {
      env: 'JWT_SECRET',
      type: 'string' as const,
      required: true,
      secret: true,
      description: 'JWT signing secret',
      validate: (value: string) => {
        if (value.length < 32) {
          return 'JWT secret must be at least 32 characters';
        }
        return true;
      },
    },

    // Logging
    logLevel: {
      env: 'LOG_LEVEL',
      default: 'info',
      type: 'string' as const,
      description: 'Log level (debug, info, warn, error)',
      validate: (value: string) => {
        return ['debug', 'info', 'warn', 'error'].includes(value) || 'Invalid log level';
      },
    },
  };
}
