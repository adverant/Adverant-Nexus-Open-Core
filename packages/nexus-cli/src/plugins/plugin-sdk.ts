/**
 * Plugin SDK
 *
 * API for plugin developers to create Nexus plugins
 */

import type {
  Plugin,
  PluginCommand,
  PluginCommandHandler,
  PluginPermission,
  MCPServerConfig,
  PluginContext,
  PluginLogger,
  PluginArgument,
  PluginOption,
} from '../types/plugin.js';
import { createPluginStorage, type PluginStorage } from './plugin-storage.js';

/**
 * Plugin Builder - Fluent API for creating plugins
 */
export class PluginBuilder {
  private plugin: Partial<Plugin>;
  private commands: PluginCommand[] = [];
  private permissions: string[] = [];
  private dependencies: string[] = [];
  private hooks: {
    onLoad?: () => Promise<void>;
    onUnload?: () => Promise<void>;
    onEnable?: () => Promise<void>;
    onDisable?: () => Promise<void>;
  } = {};
  private mcpConfig?: MCPServerConfig;

  private constructor(name: string) {
    this.plugin = {
      name,
      version: '1.0.0',
      description: '',
      author: '',
      main: 'dist/index.js',
      commands: [],
      dependencies: [],
      permissions: [],
    };
  }

  /**
   * Create new plugin builder
   */
  static create(name: string): PluginBuilder {
    return new PluginBuilder(name);
  }

  /**
   * Set plugin version
   */
  version(version: string): this {
    this.plugin.version = version;
    return this;
  }

  /**
   * Set plugin description
   */
  description(description: string): this {
    this.plugin.description = description;
    return this;
  }

  /**
   * Set plugin author
   */
  author(author: string): this {
    this.plugin.author = author;
    return this;
  }

  /**
   * Set plugin homepage
   */
  homepage(homepage: string): this {
    this.plugin.homepage = homepage;
    return this;
  }

  /**
   * Set plugin repository
   */
  repository(repository: string): this {
    this.plugin.repository = repository;
    return this;
  }

  /**
   * Set main entry file
   */
  main(main: string): this {
    this.plugin.main = main;
    return this;
  }

  /**
   * Add command to plugin
   */
  command(
    name: string,
    config: {
      description: string;
      args?: PluginArgument[];
      options?: PluginOption[];
      handler: PluginCommandHandler;
      examples?: string[];
    }
  ): this {
    this.commands.push({
      name,
      description: config.description,
      args: config.args,
      options: config.options,
      handler: config.handler,
      examples: config.examples,
    });
    return this;
  }

  /**
   * Add onLoad lifecycle hook
   */
  onLoad(handler: () => Promise<void>): this {
    this.hooks.onLoad = handler;
    return this;
  }

  /**
   * Add onUnload lifecycle hook
   */
  onUnload(handler: () => Promise<void>): this {
    this.hooks.onUnload = handler;
    return this;
  }

  /**
   * Add onEnable lifecycle hook
   */
  onEnable(handler: () => Promise<void>): this {
    this.hooks.onEnable = handler;
    return this;
  }

  /**
   * Add onDisable lifecycle hook
   */
  onDisable(handler: () => Promise<void>): this {
    this.hooks.onDisable = handler;
    return this;
  }

  /**
   * Add permission to plugin
   */
  permission(permission: PluginPermission | string): this {
    // Convert PluginPermission object to string format if needed
    const permStr = typeof permission === 'string'
      ? permission
      : `${permission.type}:${permission.level}`;
    this.permissions.push(permStr);
    return this;
  }

  /**
   * Add service dependency
   */
  dependency(service: string): this {
    if (!this.dependencies.includes(service)) {
      this.dependencies.push(service);
    }
    return this;
  }

  /**
   * Configure MCP server
   */
  mcp(config: MCPServerConfig): this {
    this.mcpConfig = config;
    return this;
  }

  /**
   * Build plugin
   */
  build(): Plugin {
    if (!this.plugin.name) {
      throw new Error('Plugin name is required');
    }

    return {
      name: this.plugin.name,
      version: this.plugin.version!,
      description: this.plugin.description!,
      author: this.plugin.author!,
      homepage: this.plugin.homepage,
      repository: this.plugin.repository,
      main: this.plugin.main!,
      commands: this.commands,
      dependencies: this.dependencies.length > 0 ? this.dependencies : undefined,
      permissions: this.permissions.length > 0 ? this.permissions : undefined,
      onLoad: this.hooks.onLoad,
      onUnload: this.hooks.onUnload,
      onEnable: this.hooks.onEnable,
      onDisable: this.hooks.onDisable,
      mcp: this.mcpConfig,
      enabled: false,
      installed: false,
    };
  }
}

/**
 * Create plugin logger
 */
export function createPluginLogger(pluginName: string): PluginLogger {
  const prefix = `[${pluginName}]`;

  return {
    info(message: string, ...args: any[]): void {
      console.log(prefix, message, ...args);
    },
    warn(message: string, ...args: any[]): void {
      console.warn(prefix, message, ...args);
    },
    error(message: string, ...args: any[]): void {
      console.error(prefix, message, ...args);
    },
    debug(message: string, ...args: any[]): void {
      if (process.env.DEBUG || process.env.NEXUS_DEBUG) {
        console.debug(prefix, message, ...args);
      }
    },
  };
}

/**
 * Create plugin context
 */
export function createPluginContext(
  pluginName: string,
  services?: any,
  transport?: any
): PluginContext {
  return {
    config: {},
    workspace: undefined,
    services: services || new Map(),
    transport: transport || {},
    logger: createPluginLogger(pluginName),
  };
}

/**
 * Helper to create file permission
 */
export function filePermission(
  scope: string,
  level: 'read' | 'write' | 'execute' = 'read'
): PluginPermission {
  return { type: 'file', scope, level };
}

/**
 * Helper to create network permission
 */
export function networkPermission(
  scope: string,
  level: 'read' | 'write' | 'execute' = 'read'
): PluginPermission {
  return { type: 'network', scope, level };
}

/**
 * Helper to create service permission
 */
export function servicePermission(
  scope: string,
  level: 'read' | 'write' | 'execute' = 'read'
): PluginPermission {
  return { type: 'service', scope, level };
}

/**
 * Helper to create system permission
 */
export function systemPermission(
  scope: string,
  level: 'read' | 'write' | 'execute' = 'read'
): PluginPermission {
  return { type: 'system', scope, level };
}

/**
 * Helper to create plugin argument
 */
export function arg(
  name: string,
  config: {
    description: string;
    required?: boolean;
    type?: string;
    default?: any;
  }
): PluginArgument {
  return {
    name,
    description: config.description,
    required: config.required ?? false,
    type: config.type ?? 'string',
    default: config.default,
  };
}

/**
 * Helper to create plugin option
 */
export function option(
  long: string,
  config: {
    short?: string;
    description: string;
    type?: string;
    default?: any;
  }
): PluginOption {
  return {
    short: config.short,
    long,
    description: config.description,
    type: config.type ?? 'boolean',
    default: config.default,
  };
}

/**
 * Export all SDK components
 */
export {
  type Plugin,
  type PluginCommand,
  type PluginCommandHandler,
  type PluginPermission,
  type PluginContext,
  type PluginLogger,
  type PluginStorage,
  type MCPServerConfig,
  type PluginArgument,
  type PluginOption,
  createPluginStorage,
};
