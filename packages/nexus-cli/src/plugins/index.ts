/**
 * Plugin System - Public Exports
 *
 * Central export point for all plugin system components
 */

// Plugin loader
export { PluginLoader, pluginLoader } from './plugin-loader.js';

// Plugin validator
export {
  PluginValidator,
  pluginValidator,
  type ValidationResult,
} from './plugin-validator.js';

// Plugin manager
export { PluginManager, pluginManager } from './plugin-manager.js';

// Plugin storage
export {
  PluginStorage,
  createPluginStorage,
  getNexusHome,
  getPluginsDirectory,
  getPluginDataDirectory,
  ensureNexusDirectories,
} from './plugin-storage.js';

// Plugin SDK
export {
  PluginBuilder,
  createPluginLogger,
  createPluginContext,
  filePermission,
  networkPermission,
  servicePermission,
  systemPermission,
  arg,
  option,
  type Plugin,
  type PluginCommand,
  type PluginCommandHandler,
  type PluginPermission,
  type PluginContext,
  type PluginLogger,
  type MCPServerConfig,
  type PluginArgument,
  type PluginOption,
} from './plugin-sdk.js';

// Template generator
export {
  PluginTemplateGenerator,
  pluginTemplateGenerator,
  type PluginTemplateType,
  type PluginScaffoldOptions,
} from './template-generator.js';
