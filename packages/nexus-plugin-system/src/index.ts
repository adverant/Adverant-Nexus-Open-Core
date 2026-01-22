/**
 * Nexus Plugin System
 *
 * Entry point for the plugin system.
 * Exports all types, discovery, and utility functions.
 */

export * from './types';
export * from './discovery';

// Re-export main classes for convenience
export { PluginDiscovery } from './discovery';
export type {
  NexusPlugin,
  PluginMetadata,
  PluginHooks,
  PluginCapabilities,
  PluginDiscovery as IPluginDiscovery,
  DocumentProcessor,
  Retriever,
  Agent,
  Tool,
  Route,
  Middleware,
} from './types';
