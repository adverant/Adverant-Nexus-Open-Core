/**
 * Configuration Loader
 * Loads and validates configuration from environment variables
 */

import * as dotenv from 'dotenv';
import * as path from 'path';
import { ConfigOptions, ConfigSchema, ConfigValidationResult, ValidationError } from './types';
import { validateConfig } from './validators/schema-validator';

export class ConfigLoader {
  private options: Required<Omit<ConfigOptions, 'secretProvider'>>;
  private secretProvider?: ConfigOptions['secretProvider'];
  private config: Record<string, any> = {};
  private loaded = false;

  constructor(options: ConfigOptions) {
    this.options = {
      schema: options.schema,
      environment: options.environment || (process.env.NODE_ENV as any) || 'development',
      envFilePath: options.envFilePath || '.env',
      loadEnvFile: options.loadEnvFile ?? true,
      envPrefix: options.envPrefix || '',
      throwOnValidationError: options.throwOnValidationError ?? true,
    };
    this.secretProvider = options.secretProvider;
  }

  /**
   * Load configuration
   */
  async load(): Promise<Record<string, any>> {
    if (this.loaded) {
      return this.config;
    }

    // Load .env file if enabled
    if (this.options.loadEnvFile) {
      this.loadEnvFile();
    }

    // Load from environment variables
    await this.loadFromEnvironment();

    // Validate configuration
    const validation = validateConfig(this.config, this.options.schema);

    if (!validation.valid) {
      const errorMessage = this.formatValidationErrors(validation.errors);

      if (this.options.throwOnValidationError) {
        throw new Error(`Configuration validation failed:\n${errorMessage}`);
      } else {
        console.error(`Configuration validation failed:\n${errorMessage}`);
      }
    }

    this.loaded = true;
    return this.config;
  }

  /**
   * Get configuration value
   */
  get<T = any>(key: string, defaultValue?: T): T | undefined {
    if (!this.loaded) {
      throw new Error('Configuration not loaded. Call load() first.');
    }

    const value = this.config[key];
    return value !== undefined ? value : defaultValue;
  }

  /**
   * Get all configuration
   */
  getAll(): Record<string, any> {
    if (!this.loaded) {
      throw new Error('Configuration not loaded. Call load() first.');
    }

    return { ...this.config };
  }

  /**
   * Check if configuration is loaded
   */
  isLoaded(): boolean {
    return this.loaded;
  }

  /**
   * Get environment
   */
  getEnvironment() {
    return this.options.environment;
  }

  /**
   * Check if running in production
   */
  isProduction(): boolean {
    return this.options.environment === 'production';
  }

  /**
   * Check if running in development
   */
  isDevelopment(): boolean {
    return this.options.environment === 'development';
  }

  /**
   * Load .env file
   */
  private loadEnvFile(): void {
    const envPath = path.resolve(process.cwd(), this.options.envFilePath);

    try {
      dotenv.config({ path: envPath });
    } catch (error) {
      // .env file not found or not readable - this is okay
      // Environment variables can be set externally
    }
  }

  /**
   * Load configuration from environment variables
   */
  private async loadFromEnvironment(): Promise<void> {
    const schema = this.options.schema;

    for (const [key, field] of Object.entries(schema)) {
      const envVar = field.env || this.options.envPrefix + key.toUpperCase();
      let value = process.env[envVar];

      // Try to load from secret provider if not found and field is a secret
      if (!value && field.secret && this.secretProvider) {
        try {
          value = (await this.secretProvider.getSecret(envVar)) || undefined;
        } catch (error) {
          // Secret not found - will use default or fail validation
        }
      }

      // Use default value if not provided
      if (value === undefined && field.default !== undefined) {
        value = field.default;
      }

      // Transform value if transform function provided
      if (value !== undefined && field.transform) {
        value = field.transform(value);
      } else if (value !== undefined && typeof value === 'string') {
        // Auto-transform based on type
        value = this.autoTransform(value, field.type);
      }

      this.config[key] = value;
    }
  }

  /**
   * Auto-transform value based on type
   */
  private autoTransform(value: string, type?: string): any {
    if (!type) return value;

    switch (type) {
      case 'number':
      case 'port':
        const num = Number(value);
        return isNaN(num) ? value : num;

      case 'boolean':
        return value === 'true' || value === '1' || value === 'yes';

      case 'json':
        try {
          return JSON.parse(value);
        } catch {
          return value;
        }

      default:
        return value;
    }
  }

  /**
   * Format validation errors for display
   */
  private formatValidationErrors(errors: ValidationError[]): string {
    return errors
      .map((err) => `  - ${err.field}: ${err.message}`)
      .join('\n');
  }
}

/**
 * Create and load configuration
 */
export async function loadConfig(options: ConfigOptions): Promise<Record<string, any>> {
  const loader = new ConfigLoader(options);
  return loader.load();
}

/**
 * Create configuration loader
 */
export function createConfigLoader(options: ConfigOptions): ConfigLoader {
  return new ConfigLoader(options);
}
