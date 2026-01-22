/**
 * Type definitions for @adverant/config
 */

export type ConfigEnvironment = 'development' | 'production' | 'test' | 'staging';

export interface ConfigSchema {
  [key: string]: ConfigField;
}

export interface ConfigField {
  /** Environment variable name */
  env?: string;

  /** Default value if not provided */
  default?: any;

  /** Whether this field is required */
  required?: boolean;

  /** Field type */
  type?: 'string' | 'number' | 'boolean' | 'url' | 'email' | 'port' | 'json';

  /** Validation function */
  validate?: (value: any) => boolean | string;

  /** Description of the field */
  description?: string;

  /** Whether this is a secret (should not be logged) */
  secret?: boolean;

  /** Transform function to convert string to desired type */
  transform?: (value: string) => any;
}

export interface ConfigOptions {
  /** Configuration schema */
  schema: ConfigSchema;

  /** Environment to load (default: process.env.NODE_ENV) */
  environment?: ConfigEnvironment;

  /** Path to .env file (default: .env) */
  envFilePath?: string;

  /** Whether to load .env file (default: true) */
  loadEnvFile?: boolean;

  /** Prefix for environment variables (e.g., 'APP_') */
  envPrefix?: string;

  /** Whether to throw on validation errors (default: true) */
  throwOnValidationError?: boolean;

  /** Secret manager provider */
  secretProvider?: SecretProvider;
}

export interface SecretProvider {
  /** Get secret value by name */
  getSecret(name: string): Promise<string | null>;

  /** Get multiple secrets */
  getSecrets(names: string[]): Promise<Record<string, string>>;
}

export interface ValidationError {
  field: string;
  message: string;
  value?: any;
}

export interface ConfigValidationResult {
  valid: boolean;
  errors: ValidationError[];
  config: Record<string, any>;
}
