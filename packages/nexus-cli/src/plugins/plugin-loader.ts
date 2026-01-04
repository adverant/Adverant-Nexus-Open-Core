/**
 * Plugin Loader
 *
 * Loads and initializes plugins from directory paths
 */

import fs from 'fs-extra';
import path from 'path';
import { pathToFileURL } from 'url';
import type { Plugin, PluginManifest, PluginCommand } from '../types/plugin.js';
import { logger } from '../utils/logger.js';

export class PluginLoader {
  /**
   * Load plugin from directory path
   */
  async load(pluginPath: string): Promise<Plugin> {
    try {
      logger.debug(`Loading plugin from: ${pluginPath}`);

      // Verify plugin directory exists
      if (!(await fs.pathExists(pluginPath))) {
        throw new Error(`Plugin directory not found: ${pluginPath}`);
      }

      // Load and parse plugin.json manifest
      const manifest = await this.loadPluginManifest(pluginPath);

      // Load plugin main file
      const pluginModule = await this.loadPluginModule(pluginPath, manifest.main);

      // Create plugin instance
      const plugin: Plugin = {
        ...manifest,
        commands: [],
        enabled: false,
        installed: true,
      };

      // Initialize plugin commands
      if (pluginModule.default) {
        // Plugin exported as default (SDK style)
        const pluginExport = pluginModule.default;

        if (typeof pluginExport === 'object' && pluginExport.commands) {
          plugin.commands = pluginExport.commands;
          plugin.onLoad = pluginExport.onLoad;
          plugin.onUnload = pluginExport.onUnload;
          plugin.onEnable = pluginExport.onEnable;
          plugin.onDisable = pluginExport.onDisable;
        }
      } else if (pluginModule.commands) {
        // Plugin exported commands directly
        plugin.commands = pluginModule.commands;
      }

      logger.info(`Plugin loaded: ${plugin.name} v${plugin.version}`);
      return plugin;
    } catch (error) {
      logger.error(`Failed to load plugin from ${pluginPath}:`, error);
      throw new Error(
        `Failed to load plugin: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * Load and parse plugin.json manifest
   */
  async loadPluginManifest(pluginPath: string): Promise<PluginManifest> {
    const manifestPath = path.join(pluginPath, 'plugin.json');

    try {
      if (!(await fs.pathExists(manifestPath))) {
        throw new Error('plugin.json not found');
      }

      const manifestContent = await fs.readFile(manifestPath, 'utf-8');
      const manifest = JSON.parse(manifestContent) as PluginManifest;

      // Validate required fields
      if (!manifest.name) {
        throw new Error('Plugin manifest missing required field: name');
      }
      if (!manifest.version) {
        throw new Error('Plugin manifest missing required field: version');
      }
      if (!manifest.main) {
        throw new Error('Plugin manifest missing required field: main');
      }

      return manifest;
    } catch (error) {
      throw new Error(
        `Failed to load plugin manifest: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * Load plugin main module (ESM/CommonJS)
   */
  private async loadPluginModule(pluginPath: string, mainFile: string): Promise<any> {
    const mainPath = path.join(pluginPath, mainFile);

    try {
      if (!(await fs.pathExists(mainPath))) {
        throw new Error(`Plugin main file not found: ${mainFile}`);
      }

      // Convert to file URL for ESM import
      const fileUrl = pathToFileURL(mainPath).href;

      // Dynamic import (supports both ESM and CommonJS)
      const module = await import(fileUrl);

      return module;
    } catch (error) {
      throw new Error(
        `Failed to load plugin module: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * Initialize plugin lifecycle hooks
   */
  async initializePlugin(plugin: Plugin): Promise<void> {
    try {
      if (plugin.onLoad) {
        logger.debug(`Calling onLoad hook for plugin: ${plugin.name}`);
        await plugin.onLoad();
      }
    } catch (error) {
      logger.error(`Plugin ${plugin.name} onLoad hook failed:`, error);
      throw new Error(
        `Plugin initialization failed: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * Execute plugin lifecycle hook
   */
  async executePluginHook(
    plugin: Plugin,
    hook: 'onLoad' | 'onUnload' | 'onEnable' | 'onDisable'
  ): Promise<void> {
    try {
      const hookFn = plugin[hook];
      if (hookFn && typeof hookFn === 'function') {
        logger.debug(`Executing ${hook} hook for plugin: ${plugin.name}`);
        await hookFn();
      }
    } catch (error) {
      logger.error(`Plugin ${plugin.name} ${hook} hook failed:`, error);
      throw new Error(
        `Plugin ${hook} hook failed: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * Hot-reload plugin (for development)
   */
  async reload(pluginPath: string): Promise<Plugin> {
    logger.debug(`Hot-reloading plugin from: ${pluginPath}`);

    // Clear module cache for hot-reload
    // Note: This is simplified; full hot-reload requires more sophisticated cache clearing
    const manifest = await this.loadPluginManifest(pluginPath);
    const mainPath = path.join(pluginPath, manifest.main);
    const fileUrl = pathToFileURL(mainPath).href;

    // Delete from import cache (if supported)
    if (typeof require !== 'undefined' && require.cache) {
      delete require.cache[require.resolve(mainPath)];
    }

    // Reload plugin
    return this.load(pluginPath);
  }
}

/**
 * Singleton instance
 */
export const pluginLoader = new PluginLoader();
