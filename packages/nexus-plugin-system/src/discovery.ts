/**
 * Plugin Discovery System
 *
 * Automatically discovers and loads Nexus plugins from node_modules.
 * Supports:
 * - Scoped packages: @nexus-plugin/*
 * - Unscoped packages: nexus-plugin-*
 */

import { readdir, stat } from 'fs/promises';
import { join, resolve } from 'path';
import { existsSync } from 'fs';
import {
  PluginMetadata,
  NexusPlugin,
  PluginDiscovery as IPluginDiscovery,
  PluginLoaderOptions,
  PluginValidationError,
  PluginCompatibilityError,
} from './types';

const NEXUS_API_VERSION = '1.0';

/**
 * Default plugin discovery patterns
 */
const DEFAULT_SCOPED_PATTERN = '@nexus-plugin/*';
const DEFAULT_UNSCOPED_PREFIX = 'nexus-plugin-';

/**
 * Plugin Discovery Implementation
 */
export class PluginDiscovery implements IPluginDiscovery {
  private loadedPlugins: Map<string, NexusPlugin> = new Map();
  private options: Required<PluginLoaderOptions>;

  constructor(options?: Partial<PluginLoaderOptions>) {
    this.options = {
      autoLoad: options?.autoLoad ?? false,
      searchPaths: options?.searchPaths ?? [process.cwd()],
      pattern: options?.pattern ?? /^(@nexus-plugin\/|nexus-plugin-)/,
      apiVersion: options?.apiVersion ?? NEXUS_API_VERSION,
    };
  }

  /**
   * Discover all installed plugins
   */
  async discover(): Promise<PluginMetadata[]> {
    const discovered: PluginMetadata[] = [];

    for (const searchPath of this.options.searchPaths) {
      const nodeModulesPath = join(searchPath, 'node_modules');

      if (!existsSync(nodeModulesPath)) {
        continue;
      }

      try {
        // Scan for scoped packages: @nexus-plugin/*
        const scopedPlugins = await this.discoverScopedPlugins(nodeModulesPath);
        discovered.push(...scopedPlugins);

        // Scan for unscoped packages: nexus-plugin-*
        const unscopedPlugins = await this.discoverUnscopedPlugins(nodeModulesPath);
        discovered.push(...unscopedPlugins);
      } catch (error) {
        console.warn(`Failed to scan ${nodeModulesPath}:`, error);
      }
    }

    // Auto-load if configured
    if (this.options.autoLoad) {
      for (const metadata of discovered) {
        try {
          await this.load(metadata.name);
        } catch (error) {
          console.error(`Failed to auto-load plugin ${metadata.name}:`, error);
        }
      }
    }

    return discovered;
  }

  /**
   * Discover scoped plugins (@nexus-plugin/*)
   */
  private async discoverScopedPlugins(nodeModulesPath: string): Promise<PluginMetadata[]> {
    const scopedDir = join(nodeModulesPath, '@nexus-plugin');

    if (!existsSync(scopedDir)) {
      return [];
    }

    const plugins: PluginMetadata[] = [];
    const entries = await readdir(scopedDir);

    for (const entry of entries) {
      const pluginPath = join(scopedDir, entry);
      const pluginName = `@nexus-plugin/${entry}`;

      try {
        const metadata = await this.readPluginMetadata(pluginPath, pluginName);
        if (metadata) {
          plugins.push(metadata);
        }
      } catch (error) {
        console.warn(`Failed to read metadata for ${pluginName}:`, error);
      }
    }

    return plugins;
  }

  /**
   * Discover unscoped plugins (nexus-plugin-*)
   */
  private async discoverUnscopedPlugins(nodeModulesPath: string): Promise<PluginMetadata[]> {
    const entries = await readdir(nodeModulesPath);
    const plugins: PluginMetadata[] = [];

    for (const entry of entries) {
      if (!entry.startsWith(DEFAULT_UNSCOPED_PREFIX)) {
        continue;
      }

      const pluginPath = join(nodeModulesPath, entry);

      try {
        const metadata = await this.readPluginMetadata(pluginPath, entry);
        if (metadata) {
          plugins.push(metadata);
        }
      } catch (error) {
        console.warn(`Failed to read metadata for ${entry}:`, error);
      }
    }

    return plugins;
  }

  /**
   * Read plugin metadata from package.json
   */
  private async readPluginMetadata(
    pluginPath: string,
    pluginName: string
  ): Promise<PluginMetadata | null> {
    const packageJsonPath = join(pluginPath, 'package.json');

    if (!existsSync(packageJsonPath)) {
      return null;
    }

    try {
      const packageJson = await import(packageJsonPath);

      return {
        name: pluginName,
        version: packageJson.version || '0.0.0',
        apiVersion: packageJson.nexusApiVersion || '1.0',
        description: packageJson.description || '',
        author: packageJson.author || 'Unknown',
        license: packageJson.license || 'UNLICENSED',
        repository: packageJson.repository?.url || packageJson.repository,
        keywords: packageJson.keywords || [],
        homepage: packageJson.homepage,
      };
    } catch (error) {
      console.error(`Failed to parse package.json for ${pluginName}:`, error);
      return null;
    }
  }

  /**
   * Load plugin by name
   */
  async load(name: string): Promise<NexusPlugin> {
    // Return cached plugin if already loaded
    if (this.loadedPlugins.has(name)) {
      return this.loadedPlugins.get(name)!;
    }

    try {
      // Dynamically import the plugin module
      const pluginModule = await import(name);
      const plugin: NexusPlugin = pluginModule.default || pluginModule;

      // Validate plugin structure
      this.validatePlugin(plugin);

      // Check API version compatibility
      this.checkCompatibility(plugin);

      // Call onLoad hook
      if (plugin.hooks.onLoad) {
        await plugin.hooks.onLoad();
      }

      // Cache the loaded plugin
      this.loadedPlugins.set(name, plugin);

      console.log(`✓ Loaded plugin: ${name} (v${plugin.metadata.version})`);

      return plugin;
    } catch (error) {
      if (error instanceof PluginValidationError || error instanceof PluginCompatibilityError) {
        throw error;
      }

      throw new Error(`Failed to load plugin ${name}: ${(error as Error).message}`);
    }
  }

  /**
   * Validate plugin structure
   */
  private validatePlugin(plugin: any): asserts plugin is NexusPlugin {
    const errors: string[] = [];

    if (!plugin.metadata) {
      errors.push('Missing required field: metadata');
    } else {
      if (!plugin.metadata.name) {
        errors.push('Missing required field: metadata.name');
      }
      if (!plugin.metadata.version) {
        errors.push('Missing required field: metadata.version');
      }
      if (!plugin.metadata.apiVersion) {
        errors.push('Missing required field: metadata.apiVersion');
      }
    }

    if (!plugin.hooks) {
      errors.push('Missing required field: hooks');
    }

    if (errors.length > 0) {
      throw new PluginValidationError(
        `Plugin validation failed`,
        plugin.metadata?.name || 'unknown',
        errors
      );
    }
  }

  /**
   * Check API version compatibility
   */
  private checkCompatibility(plugin: NexusPlugin): void {
    const pluginApiVersion = plugin.metadata.apiVersion;
    const nexusApiVersion = this.options.apiVersion;

    // Extract major version
    const pluginMajor = pluginApiVersion.split('.')[0];
    const nexusMajor = nexusApiVersion.split('.')[0];

    if (pluginMajor !== nexusMajor) {
      throw new PluginCompatibilityError(
        `Plugin ${plugin.metadata.name} requires API version ${pluginApiVersion}, ` +
          `but Nexus is using ${nexusApiVersion}`,
        plugin.metadata.name,
        pluginApiVersion,
        nexusApiVersion
      );
    }
  }

  /**
   * Get all loaded plugins
   */
  getLoaded(): NexusPlugin[] {
    return Array.from(this.loadedPlugins.values());
  }

  /**
   * Unload plugin by name
   */
  async unload(name: string): Promise<void> {
    const plugin = this.loadedPlugins.get(name);

    if (!plugin) {
      throw new Error(`Plugin ${name} is not loaded`);
    }

    // Call onStop hook
    if (plugin.hooks.onStop) {
      await plugin.hooks.onStop();
    }

    // Remove from cache
    this.loadedPlugins.delete(name);

    console.log(`✓ Unloaded plugin: ${name}`);
  }

  /**
   * Reload plugin by name
   */
  async reload(name: string): Promise<NexusPlugin> {
    await this.unload(name);

    // Clear require cache to force re-import
    delete require.cache[require.resolve(name)];

    return await this.load(name);
  }

  /**
   * Start all loaded plugins
   */
  async startAll(): Promise<void> {
    const plugins = this.getLoaded();

    for (const plugin of plugins) {
      if (plugin.hooks.onStart) {
        try {
          await plugin.hooks.onStart();
          console.log(`✓ Started plugin: ${plugin.metadata.name}`);
        } catch (error) {
          console.error(`Failed to start plugin ${plugin.metadata.name}:`, error);
        }
      }
    }
  }

  /**
   * Stop all loaded plugins
   */
  async stopAll(): Promise<void> {
    const plugins = this.getLoaded();

    for (const plugin of plugins) {
      if (plugin.hooks.onStop) {
        try {
          await plugin.hooks.onStop();
          console.log(`✓ Stopped plugin: ${plugin.metadata.name}`);
        } catch (error) {
          console.error(`Failed to stop plugin ${plugin.metadata.name}:`, error);
        }
      }
    }
  }
}
