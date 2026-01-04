/**
 * Plugin Type Definitions
 *
 * Types for plugin system, registration, and lifecycle
 */

import type { Command } from './command.js';

export interface Plugin {
  name: string;
  version: string;
  description: string;
  author: string;
  homepage?: string;
  repository?: string;

  // Plugin metadata
  main: string;
  commands: PluginCommand[];
  dependencies?: string[]; // Required services
  permissions?: string[]; // Permission strings like "file:read", "network:http"
  tags?: string[];
  category?: string;

  // Lifecycle hooks
  onLoad?: () => Promise<void>;
  onUnload?: () => Promise<void>;
  onEnable?: () => Promise<void>;
  onDisable?: () => Promise<void>;

  // MCP integration
  mcp?: MCPServerConfig;

  // Plugin state
  enabled?: boolean;
  installed?: boolean;
  disabled?: boolean;
  loaded?: boolean;
  path?: string;
  manifestPath?: string;
  error?: string;
}

export interface PluginCommand {
  name: string;
  description: string;
  args?: PluginArgument[];
  options?: PluginOption[];
  handler?: PluginCommandHandler; // Optional during discovery, required at runtime
  examples?: string[];
}

export interface PluginArgument {
  name: string;
  description: string;
  required: boolean;
  type: string;
  default?: any;
}

export interface PluginOption {
  short?: string;
  long: string;
  description: string;
  type: string;
  default?: any;
}

export type PluginCommandHandler = (
  args: any,
  context: PluginContext
) => Promise<PluginResult>;

export interface PluginContext {
  config: any;
  workspace?: any;
  services: any;
  transport: any;
  logger: PluginLogger;
}

export interface PluginLogger {
  info(message: string, ...args: any[]): void;
  warn(message: string, ...args: any[]): void;
  error(message: string, ...args: any[]): void;
  debug(message: string, ...args: any[]): void;
}

export interface PluginResult {
  success: boolean;
  data?: any;
  message?: string;
  error?: string;
}

export interface PluginPermission {
  type: 'file' | 'network' | 'service' | 'system';
  scope: string;
  level: 'read' | 'write' | 'execute';
}

export interface MCPServerConfig {
  enabled: boolean;
  command: string;
  args?: string[];
  env?: Record<string, string>;
  timeout?: number;
}

export interface PluginManifest {
  name: string;
  version: string;
  description: string;
  author: string;
  main: string;
  commands: PluginCommandDef[];
  dependencies?: string[];
  permissions?: string[]; // Permission strings like "file:read", "network:http"
  mcp?: MCPServerConfig;
}

export interface PluginCommandDef {
  name: string;
  description: string;
  args?: PluginArgument[];
  options?: PluginOption[];
}

export interface PluginRegistry {
  register(plugin: Plugin): Promise<void>;
  unregister(name: string): Promise<void>;
  get(name: string): Plugin | undefined;
  list(): Plugin[];
  enable(name: string): Promise<void>;
  disable(name: string): Promise<void>;
  update(name: string): Promise<void>;
}

export interface PluginLoader {
  load(path: string): Promise<Plugin>;
  validate(plugin: Plugin): Promise<boolean>;
  install(name: string, version?: string): Promise<Plugin>;
  uninstall(name: string): Promise<void>;
}
