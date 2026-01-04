/**
 * Plugin Validator
 *
 * Validates plugin manifests, structure, permissions, and dependencies
 */

import { z } from 'zod';
import type {
  Plugin,
  PluginManifest,
  PluginPermission,
  PluginCommandDef,
  PluginArgument,
  PluginOption,
} from '../types/plugin.js';
import { logger } from '../utils/logger.js';

/**
 * Validation result
 */
export interface ValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

/**
 * Zod schemas for validation
 */
const PluginArgumentSchema = z.object({
  name: z.string().min(1, 'Argument name is required'),
  description: z.string().min(1, 'Argument description is required'),
  required: z.boolean(),
  type: z.string().min(1, 'Argument type is required'),
  default: z.any().optional(),
});

const PluginOptionSchema = z.object({
  short: z.string().optional(),
  long: z.string().min(1, 'Option long name is required'),
  description: z.string().min(1, 'Option description is required'),
  type: z.string().min(1, 'Option type is required'),
  default: z.any().optional(),
});

const PluginCommandDefSchema = z.object({
  name: z.string().min(1, 'Command name is required'),
  description: z.string().min(1, 'Command description is required'),
  args: z.array(PluginArgumentSchema).optional(),
  options: z.array(PluginOptionSchema).optional(),
});

const PluginPermissionSchema = z.object({
  type: z.enum(['file', 'network', 'service', 'system'], {
    errorMap: () => ({ message: 'Permission type must be one of: file, network, service, system' }),
  }),
  scope: z.string().min(1, 'Permission scope is required'),
  level: z.enum(['read', 'write', 'execute'], {
    errorMap: () => ({ message: 'Permission level must be one of: read, write, execute' }),
  }),
});

const MCPServerConfigSchema = z.object({
  enabled: z.boolean(),
  command: z.string().min(1, 'MCP server command is required'),
  args: z.array(z.string()).optional(),
  env: z.record(z.string()).optional(),
  timeout: z.number().positive().optional(),
});

const PluginManifestSchema = z.object({
  name: z
    .string()
    .min(1, 'Plugin name is required')
    .regex(/^[a-z0-9-]+$/, 'Plugin name must be lowercase alphanumeric with hyphens'),
  version: z
    .string()
    .min(1, 'Plugin version is required')
    .regex(/^\d+\.\d+\.\d+$/, 'Plugin version must be semver (e.g., 1.0.0)'),
  description: z.string().min(1, 'Plugin description is required'),
  author: z.string().min(1, 'Plugin author is required'),
  main: z.string().min(1, 'Plugin main file is required'),
  commands: z.array(PluginCommandDefSchema).optional().default([]),
  dependencies: z.array(z.string()).optional(),
  permissions: z.array(PluginPermissionSchema).optional(),
  mcp: MCPServerConfigSchema.optional(),
});

/**
 * Plugin Validator Class
 */
export class PluginValidator {
  /**
   * Validate complete plugin
   */
  validatePlugin(plugin: Plugin): ValidationResult {
    const errors: string[] = [];
    const warnings: string[] = [];

    try {
      // Validate manifest
      const manifestResult = this.validateManifest(plugin as PluginManifest);
      errors.push(...manifestResult.errors);
      warnings.push(...manifestResult.warnings);

      // Validate commands have handlers
      if (plugin.commands && plugin.commands.length > 0) {
        for (const command of plugin.commands) {
          if (!command.handler || typeof command.handler !== 'function') {
            errors.push(`Command "${command.name}" missing handler function`);
          }
        }
      }

      // Validate permissions
      if (plugin.permissions && plugin.permissions.length > 0) {
        const permResult = this.validatePermissions(plugin.permissions);
        errors.push(...permResult.errors);
        warnings.push(...permResult.warnings);
      }

      // Validate dependencies
      if (plugin.dependencies && plugin.dependencies.length > 0) {
        const depResult = this.checkDependencies(plugin);
        errors.push(...depResult.errors);
        warnings.push(...depResult.warnings);
      }

      // Validate MCP config if present
      if (plugin.mcp) {
        if (!plugin.mcp.command) {
          errors.push('MCP server enabled but no command specified');
        }
      }
    } catch (error) {
      errors.push(`Plugin validation error: ${error instanceof Error ? error.message : String(error)}`);
    }

    return {
      valid: errors.length === 0,
      errors,
      warnings,
    };
  }

  /**
   * Validate plugin manifest
   */
  validateManifest(manifest: PluginManifest): ValidationResult {
    const errors: string[] = [];
    const warnings: string[] = [];

    try {
      // Parse with Zod schema
      PluginManifestSchema.parse(manifest);

      // Additional validation
      if (manifest.commands && manifest.commands.length === 0) {
        warnings.push('Plugin has no commands defined');
      }

      // Validate command names are unique
      if (manifest.commands) {
        const commandNames = manifest.commands.map((cmd) => cmd.name);
        const duplicates = commandNames.filter(
          (name, index) => commandNames.indexOf(name) !== index
        );
        if (duplicates.length > 0) {
          errors.push(`Duplicate command names: ${duplicates.join(', ')}`);
        }
      }

      // Validate main file extension
      if (manifest.main) {
        const validExtensions = ['.js', '.mjs', '.cjs', '.ts'];
        const hasValidExtension = validExtensions.some((ext) => manifest.main.endsWith(ext));
        if (!hasValidExtension) {
          warnings.push(
            `Main file "${manifest.main}" has unusual extension. Expected: ${validExtensions.join(', ')}`
          );
        }
      }
    } catch (error) {
      if (error instanceof z.ZodError) {
        errors.push(...error.errors.map((err) => `${err.path.join('.')}: ${err.message}`));
      } else {
        errors.push(
          `Manifest validation error: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }

    return {
      valid: errors.length === 0,
      errors,
      warnings,
    };
  }

  /**
   * Validate permissions
   */
  validatePermissions(permissions: string[]): ValidationResult {
    const errors: string[] = [];
    const warnings: string[] = [];

    try {
      // Validate each permission string format
      const validPermissionPattern = /^(file|network|service|docker|system):(read|write|execute|\*)$/;

      permissions.forEach((permission, index) => {
        if (!validPermissionPattern.test(permission)) {
          errors.push(
            `Permission ${index}: Invalid format "${permission}". Expected format: "type:level" (e.g., "file:read")`
          );
        }
      });

      // Warn about dangerous permissions
      const dangerousPermissions = permissions.filter(
        (perm) =>
          perm === 'system:execute' ||
          perm === 'file:write' ||
          perm === 'docker:write' ||
          perm === 'network:write'
      );

      if (dangerousPermissions.length > 0) {
        warnings.push(
          `Plugin requests ${dangerousPermissions.length} potentially dangerous permission(s)`
        );
      }
    } catch (error) {
      errors.push(
        `Permission validation error: ${error instanceof Error ? error.message : String(error)}`
      );
    }

    return {
      valid: errors.length === 0,
      errors,
      warnings,
    };
  }

  /**
   * Check plugin dependencies are available
   */
  checkDependencies(plugin: Plugin): ValidationResult {
    const errors: string[] = [];
    const warnings: string[] = [];

    if (!plugin.dependencies || plugin.dependencies.length === 0) {
      return { valid: true, errors, warnings };
    }

    // Known services in Nexus
    const knownServices = [
      'graphrag',
      'mageagent',
      'sandbox',
      'videoagent',
      'geoagent',
      'orchestration',
      'learning',
      'robotics',
      'nlp',
      'analytics',
      'workflow',
      'api-gateway',
      'auth',
      'docs',
      'crm',
    ];

    for (const dependency of plugin.dependencies) {
      if (!knownServices.includes(dependency)) {
        warnings.push(`Unknown service dependency: ${dependency}`);
      }
    }

    return {
      valid: errors.length === 0,
      errors,
      warnings,
    };
  }

  /**
   * Validate plugin command definition
   */
  validateCommand(command: PluginCommandDef): ValidationResult {
    const errors: string[] = [];
    const warnings: string[] = [];

    try {
      PluginCommandDefSchema.parse(command);

      // Validate argument names are unique
      if (command.args) {
        const argNames = command.args.map((arg) => arg.name);
        const duplicates = argNames.filter((name, index) => argNames.indexOf(name) !== index);
        if (duplicates.length > 0) {
          errors.push(`Duplicate argument names in command "${command.name}": ${duplicates.join(', ')}`);
        }
      }

      // Validate option names are unique
      if (command.options) {
        const optionLongs = command.options.map((opt) => opt.long);
        const duplicates = optionLongs.filter(
          (name, index) => optionLongs.indexOf(name) !== index
        );
        if (duplicates.length > 0) {
          errors.push(`Duplicate option names in command "${command.name}": ${duplicates.join(', ')}`);
        }
      }
    } catch (error) {
      if (error instanceof z.ZodError) {
        errors.push(...error.errors.map((err) => err.message));
      } else {
        errors.push(
          `Command validation error: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }

    return {
      valid: errors.length === 0,
      errors,
      warnings,
    };
  }
}

/**
 * Singleton instance
 */
export const pluginValidator = new PluginValidator();
