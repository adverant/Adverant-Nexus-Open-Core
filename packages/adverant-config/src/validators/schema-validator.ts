/**
 * Schema Validator
 * Validates configuration against schema
 */

import { ConfigSchema, ConfigValidationResult, ValidationError } from '../types';

export function validateConfig(
  config: Record<string, any>,
  schema: ConfigSchema
): ConfigValidationResult {
  const errors: ValidationError[] = [];

  for (const [key, field] of Object.entries(schema)) {
    const value = config[key];

    // Check required fields
    if (field.required && (value === undefined || value === null || value === '')) {
      errors.push({
        field: key,
        message: 'Required field is missing',
        value,
      });
      continue;
    }

    // Skip validation if value is not provided and not required
    if (value === undefined || value === null) {
      continue;
    }

    // Type validation
    if (field.type) {
      const typeError = validateType(key, value, field.type);
      if (typeError) {
        errors.push(typeError);
        continue;
      }
    }

    // Custom validation
    if (field.validate) {
      const result = field.validate(value);
      if (result !== true) {
        errors.push({
          field: key,
          message: typeof result === 'string' ? result : 'Validation failed',
          value,
        });
      }
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    config,
  };
}

function validateType(field: string, value: any, type: string): ValidationError | null {
  switch (type) {
    case 'string':
      if (typeof value !== 'string') {
        return { field, message: 'Must be a string', value };
      }
      break;

    case 'number':
      if (typeof value !== 'number' || isNaN(value)) {
        return { field, message: 'Must be a number', value };
      }
      break;

    case 'boolean':
      if (typeof value !== 'boolean') {
        return { field, message: 'Must be a boolean', value };
      }
      break;

    case 'port':
      if (typeof value !== 'number' || value < 1 || value > 65535) {
        return { field, message: 'Must be a valid port (1-65535)', value };
      }
      break;

    case 'url':
      try {
        new URL(value);
      } catch {
        return { field, message: 'Must be a valid URL', value };
      }
      break;

    case 'email':
      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      if (!emailRegex.test(value)) {
        return { field, message: 'Must be a valid email', value };
      }
      break;

    case 'json':
      if (typeof value !== 'object') {
        return { field, message: 'Must be valid JSON', value };
      }
      break;
  }

  return null;
}
