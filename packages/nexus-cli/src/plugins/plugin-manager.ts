/**
 * Plugin Manager
 *
 * Manages plugin lifecycle: discovery, registration, enable/disable
 */

import fs from 'fs-extra';
import path from 'path';
import type { Plugin, PluginRegistry } from '../types/plugin.js';
import { pluginLoader } from './plugin-loader.js';
import { pluginValidator } from './plugin-validator.js';
import { getPluginsDirectory, ensureNexusDirectories } from './plugin-storage.js';
import { logger } from '../utils/logger.js';

/**
 * Plugin Manager Class
 */
export class PluginManager implements PluginRegistry {
  private plugins: Map<string, Plugin> = new Map();
  private initialized = false;

  /**
   * Initialize plugin manager
   */
  async initialize(): Promise<void> {
    if (this.initialized) {
      return;
    }

    try {
      // Ensure Nexus directories exist
      await ensureNexusDirectories();

      // Discover and load plugins
      await this.discover();

      this.initialized = true;
      logger.info(`Plugin manager initialized with ${this.plugins.size} plugin(s)`);
    } catch (error) {
      logger.error('Failed to initialize plugin manager:', error);
      throw error;
    }
  }

  /**
   * Discover plugins from ~/.nexus/plugins/
   */
  async discover(): Promise<Plugin[]> {
    const pluginsDir = getPluginsDirectory();
    const discoveredPlugins: Plugin[] = [];

    try {
      // Ensure plugins directory exists
      await fs.ensureDir(pluginsDir);

      // Read plugin directories
      const entries = await fs.readdir(pluginsDir, { withFileTypes: true });

      for (const entry of entries) {
        if (!entry.isDirectory()) {
          continue;
        }

        const pluginPath = path.join(pluginsDir, entry.name);

        try {
          // Check if plugin.json exists
          const manifestPath = path.join(pluginPath, 'plugin.json');
          if (!(await fs.pathExists(manifestPath))) {
            logger.warn(`Skipping ${entry.name}: No plugin.json found`);
            continue;
          }

          // Load plugin
          const plugin = await pluginLoader.load(pluginPath);

          // Validate plugin
          const validationResult = pluginValidator.validatePlugin(plugin);

          if (!validationResult.valid) {
            logger.error(
              `Plugin ${plugin.name} validation failed:`,
              validationResult.errors.join(', ')
            );
            continue;
          }

          // Show warnings
          if (validationResult.warnings.length > 0) {
            logger.warn(
              `Plugin ${plugin.name} warnings:`,
              validationResult.warnings.join(', ')
            );
          }

          discoveredPlugins.push(plugin);
          logger.info(`Discovered plugin: ${plugin.name} v${plugin.version}`);
        } catch (error) {
          logger.error(`Failed to load plugin from ${entry.name}:`, error);
        }
      }

      return discoveredPlugins;
    } catch (error) {
      logger.error('Failed to discover plugins:', error);
      return [];
    }
  }

  /**
   * Register plugin
   */
  async register(plugin: Plugin): Promise<void> {
    try {
      // Validate plugin
      const validationResult = pluginValidator.validatePlugin(plugin);

      if (!validationResult.valid) {
        throw new Error(
          `Plugin validation failed: ${validationResult.errors.join(', ')}`
        );
      }

      // Check if already registered
      if (this.plugins.has(plugin.name)) {
        throw new Error(`Plugin ${plugin.name} is already registered`);
      }

      // Call onLoad hook
      await pluginLoader.executePluginHook(plugin, 'onLoad');

      // Register plugin
      this.plugins.set(plugin.name, plugin);

      logger.info(`Plugin registered: ${plugin.name} v${plugin.version}`);
    } catch (error) {
      logger.error(`Failed to register plugin ${plugin.name}:`, error);
      throw error;
    }
  }

  /**
   * Unregister plugin
   */
  async unregister(name: string): Promise<void> {
    const plugin = this.plugins.get(name);

    if (!plugin) {
      throw new Error(`Plugin ${name} not found`);
    }

    try {
      // Call onUnload hook
      await pluginLoader.executePluginHook(plugin, 'onUnload');

      // Unregister
      this.plugins.delete(name);

      logger.info(`Plugin unregistered: ${name}`);
    } catch (error) {
      logger.error(`Failed to unregister plugin ${name}:`, error);
      throw error;
    }
  }

  /**
   * Get plugin by name
   */
  get(name: string): Plugin | undefined {
    return this.plugins.get(name);
  }

  /**
   * List all plugins
   */
  list(): Plugin[] {
    return Array.from(this.plugins.values());
  }

  /**
   * Enable plugin
   */
  async enable(name: string): Promise<void> {
    const plugin = this.plugins.get(name);

    if (!plugin) {
      throw new Error(`Plugin ${name} not found`);
    }

    if (plugin.enabled) {
      logger.info(`Plugin ${name} is already enabled`);
      return;
    }

    try {
      // Call onEnable hook
      await pluginLoader.executePluginHook(plugin, 'onEnable');

      // Mark as enabled
      plugin.enabled = true;

      // Persist state
      await this.persistPluginState(plugin);

      logger.info(`Plugin enabled: ${name}`);
    } catch (error) {
      logger.error(`Failed to enable plugin ${name}:`, error);
      throw error;
    }
  }

  /**
   * Disable plugin
   */
  async disable(name: string): Promise<void> {
    const plugin = this.plugins.get(name);

    if (!plugin) {
      throw new Error(`Plugin ${name} not found`);
    }

    if (!plugin.enabled) {
      logger.info(`Plugin ${name} is already disabled`);
      return;
    }

    try {
      // Call onDisable hook
      await pluginLoader.executePluginHook(plugin, 'onDisable');

      // Mark as disabled
      plugin.enabled = false;

      // Persist state
      await this.persistPluginState(plugin);

      logger.info(`Plugin disabled: ${name}`);
    } catch (error) {
      logger.error(`Failed to disable plugin ${name}:`, error);
      throw error;
    }
  }

  /**
   * Update plugin
   */
  async update(name: string): Promise<void> {
    const plugin = this.plugins.get(name);

    if (!plugin) {
      throw new Error(`Plugin ${name} not found`);
    }

    try {
      // Unregister current version
      await this.unregister(name);

      // Reload plugin
      const pluginPath = path.join(getPluginsDirectory(), name);
      const updatedPlugin = await pluginLoader.load(pluginPath);

      // Register updated version
      await this.register(updatedPlugin);

      logger.info(`Plugin updated: ${name} to v${updatedPlugin.version}`);
    } catch (error) {
      logger.error(`Failed to update plugin ${name}:`, error);
      throw error;
    }
  }

  /**
   * Install plugin from path
   */
  async install(sourcePath: string): Promise<Plugin> {
    try {
      // Load plugin from source
      const plugin = await pluginLoader.load(sourcePath);

      // Validate plugin
      const validationResult = pluginValidator.validatePlugin(plugin);

      if (!validationResult.valid) {
        throw new Error(
          `Plugin validation failed: ${validationResult.errors.join(', ')}`
        );
      }

      // Copy plugin to plugins directory
      const destPath = path.join(getPluginsDirectory(), plugin.name);

      if (await fs.pathExists(destPath)) {
        throw new Error(
          `Plugin ${plugin.name} already exists. Use update to upgrade.`
        );
      }

      await fs.copy(sourcePath, destPath);

      // Register plugin
      await this.register(plugin);

      logger.info(`Plugin installed: ${plugin.name} v${plugin.version}`);

      return plugin;
    } catch (error) {
      logger.error(`Failed to install plugin from ${sourcePath}:`, error);
      throw error;
    }
  }

  /**
   * Uninstall plugin
   */
  async uninstall(name: string): Promise<void> {
    const plugin = this.plugins.get(name);

    if (!plugin) {
      throw new Error(`Plugin ${name} not found`);
    }

    try {
      // Unregister plugin
      await this.unregister(name);

      // Remove plugin directory
      const pluginPath = path.join(getPluginsDirectory(), name);
      await fs.remove(pluginPath);

      logger.info(`Plugin uninstalled: ${name}`);
    } catch (error) {
      logger.error(`Failed to uninstall plugin ${name}:`, error);
      throw error;
    }
  }

  /**
   * Get enabled plugins
   */
  getEnabledPlugins(): Plugin[] {
    return this.list().filter((plugin) => plugin.enabled);
  }

  /**
   * Get disabled plugins
   */
  getDisabledPlugins(): Plugin[] {
    return this.list().filter((plugin) => !plugin.enabled);
  }

  /**
   * Persist plugin state to disk
   */
  private async persistPluginState(plugin: Plugin): Promise<void> {
    const pluginPath = path.join(getPluginsDirectory(), plugin.name);
    const statePath = path.join(pluginPath, '.plugin-state.json');

    const state = {
      enabled: plugin.enabled,
      installed: plugin.installed,
      lastUpdated: new Date().toISOString(),
    };

    await fs.writeFile(statePath, JSON.stringify(state, null, 2));
  }

  /**
   * Load plugin state from disk
   */
  private async loadPluginState(plugin: Plugin): Promise<void> {
    const pluginPath = path.join(getPluginsDirectory(), plugin.name);
    const statePath = path.join(pluginPath, '.plugin-state.json');

    if (await fs.pathExists(statePath)) {
      const state = await fs.readJson(statePath);
      plugin.enabled = state.enabled ?? false;
      plugin.installed = state.installed ?? true;
    }
  }
}

/**
 * Singleton instance
 */
export const pluginManager = new PluginManager();
