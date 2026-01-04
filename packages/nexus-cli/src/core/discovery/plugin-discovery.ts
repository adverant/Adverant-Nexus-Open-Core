/**
 * Plugin Discovery
 *
 * Auto-discovers plugins from ~/.nexus/plugins/ directory
 * Loads and validates plugin manifests
 */

import { readdir, readFile, stat } from 'fs/promises';
import { join, resolve } from 'path';
import { homedir } from 'os';
import type { Plugin, PluginManifest, PluginCommand } from '../../types/plugin.js';

export interface PluginDiscoveryOptions {
  pluginDir?: string;
  validateStructure?: boolean;
  loadDisabled?: boolean;
}

/**
 * Discover all plugins in plugin directory
 */
export async function discoverPlugins(
  options: PluginDiscoveryOptions = {}
): Promise<Plugin[]> {
  const {
    pluginDir = join(homedir(), '.nexus', 'plugins'),
    validateStructure = true,
    loadDisabled = false
  } = options;

  const plugins: Plugin[] = [];

  try {
    // Check if plugins directory exists
    try {
      await stat(pluginDir);
    } catch {
      // Directory doesn't exist, return empty array
      return plugins;
    }

    // Read all subdirectories
    const entries = await readdir(pluginDir, { withFileTypes: true });
    const directories = entries.filter(e => e.isDirectory());

    // Load each plugin
    for (const dir of directories) {
      const pluginPath = join(pluginDir, dir.name);

      try {
        const plugin = await loadPlugin(pluginPath, validateStructure);

        // Skip disabled plugins unless loadDisabled is true
        if (!loadDisabled && plugin.disabled) {
          continue;
        }

        plugins.push(plugin);
      } catch (error) {
        console.warn(`Warning: Could not load plugin from ${pluginPath}:`, error);
        // Continue with other plugins
      }
    }
  } catch (error) {
    console.warn(`Warning: Could not scan plugin directory ${pluginDir}:`, error);
  }

  return plugins;
}

/**
 * Load a single plugin from directory
 */
export async function loadPlugin(
  pluginPath: string,
  validateStructure: boolean = true
): Promise<Plugin> {
  // Load plugin.json manifest
  const manifestPath = join(pluginPath, 'plugin.json');
  const manifest = await loadPluginManifest(manifestPath);

  // Validate manifest
  validateManifest(manifest);

  // Validate directory structure if requested
  if (validateStructure) {
    await validatePluginStructure(pluginPath, manifest);
  }

  return {
    ...manifest,
    path: pluginPath,
    manifestPath,
    loaded: false,
    disabled: false,
    error: undefined
  };
}

/**
 * Load plugin.json manifest
 */
export async function loadPluginManifest(manifestPath: string): Promise<PluginManifest> {
  try {
    const content = await readFile(manifestPath, 'utf-8');
    const manifest = JSON.parse(content) as PluginManifest;
    return manifest;
  } catch (error) {
    throw new Error(`Failed to load plugin manifest from ${manifestPath}: ${error}`);
  }
}

/**
 * Validate plugin manifest
 */
function validateManifest(manifest: PluginManifest): void {
  const required = ['name', 'version', 'description', 'author', 'commands'];

  for (const field of required) {
    if (!(field in manifest)) {
      throw new Error(`Plugin manifest missing required field: ${field}`);
    }
  }

  // Validate version format (semver)
  if (!/^\d+\.\d+\.\d+/.test(manifest.version)) {
    throw new Error(`Invalid version format: ${manifest.version}. Expected semver (e.g., 1.0.0)`);
  }

  // Validate commands
  if (!Array.isArray(manifest.commands) || manifest.commands.length === 0) {
    throw new Error('Plugin must define at least one command');
  }

  for (const cmd of manifest.commands) {
    validateCommand(cmd);
  }

  // Validate permissions if present
  if (manifest.permissions) {
    validatePermissions(manifest.permissions);
  }
}

/**
 * Validate plugin command definition
 */
function validateCommand(command: import('../../types/plugin.js').PluginCommandDef): void {
  if (!command.name) {
    throw new Error('Command missing required field: name');
  }

  if (!command.description) {
    throw new Error(`Command ${command.name} missing required field: description`);
  }

  // Validate command name format (kebab-case)
  if (!/^[a-z][a-z0-9-]*$/.test(command.name)) {
    throw new Error(
      `Invalid command name: ${command.name}. Must be lowercase kebab-case (e.g., my-command)`
    );
  }

  // Validate args if present
  if (command.args) {
    for (const arg of command.args) {
      validateArgument(arg);
    }
  }
}

/**
 * Validate command argument
 */
function validateArgument(arg: any): void {
  const required = ['name', 'type', 'description'];

  for (const field of required) {
    if (!(field in arg)) {
      throw new Error(`Argument missing required field: ${field}`);
    }
  }

  // Validate type
  const validTypes = ['string', 'number', 'boolean', 'array', 'object', 'file'];
  if (!validTypes.includes(arg.type)) {
    throw new Error(`Invalid argument type: ${arg.type}. Must be one of: ${validTypes.join(', ')}`);
  }
}

/**
 * Validate plugin permissions
 */
function validatePermissions(permissions: string[]): void {
  const validPermissions = [
    'file:read',
    'file:write',
    'network:http',
    'network:https',
    'network:websocket',
    'service:graphrag',
    'service:mageagent',
    'service:sandbox',
    'docker:read',
    'docker:write'
  ];

  for (const perm of permissions) {
    // Check if it matches a valid permission pattern
    const isValid = validPermissions.some(valid => {
      if (valid.endsWith(':*')) {
        return perm.startsWith(valid.replace(':*', ':'));
      }
      return perm === valid;
    });

    if (!isValid) {
      console.warn(`Warning: Unknown permission: ${perm}`);
    }
  }
}

/**
 * Validate plugin directory structure
 */
async function validatePluginStructure(
  pluginPath: string,
  manifest: PluginManifest
): Promise<void> {
  // Check for required files
  const requiredFiles = ['plugin.json'];

  // If main field is specified, check if file exists
  if (manifest.main) {
    requiredFiles.push(manifest.main);
  }

  for (const file of requiredFiles) {
    const filePath = join(pluginPath, file);
    try {
      await stat(filePath);
    } catch {
      throw new Error(`Required file not found: ${file}`);
    }
  }

  // Check for commands directory if commands are defined
  if (manifest.commands && manifest.commands.length > 0) {
    const commandsDir = join(pluginPath, 'commands');
    try {
      const stats = await stat(commandsDir);
      if (!stats.isDirectory()) {
        console.warn(`Warning: commands path exists but is not a directory`);
      }
    } catch {
      console.warn(`Warning: commands directory not found (may be using main entry point)`);
    }
  }
}

/**
 * Check plugin dependencies
 */
export async function checkPluginDependencies(
  plugin: Plugin,
  availableServices: Set<string>
): Promise<{
  satisfied: boolean;
  missing: string[];
}> {
  const missing: string[] = [];

  if (plugin.dependencies) {
    for (const dep of plugin.dependencies) {
      if (!availableServices.has(dep)) {
        missing.push(dep);
      }
    }
  }

  return {
    satisfied: missing.length === 0,
    missing
  };
}

/**
 * Filter plugins by permission requirements
 */
export function filterPluginsByPermissions(
  plugins: Plugin[],
  allowedPermissions: Set<string>
): Plugin[] {
  return plugins.filter(plugin => {
    if (!plugin.permissions || plugin.permissions.length === 0) {
      return true; // No permissions required
    }

    // Check if all required permissions are allowed
    return plugin.permissions.every(perm => {
      // Check for exact match
      if (allowedPermissions.has(perm)) {
        return true;
      }

      // Check for wildcard match (e.g., service:* allows service:graphrag)
      const [category] = perm.split(':');
      if (allowedPermissions.has(`${category}:*`)) {
        return true;
      }

      return false;
    });
  });
}

/**
 * Get plugin by name
 */
export async function getPlugin(
  name: string,
  options: PluginDiscoveryOptions = {}
): Promise<Plugin | null> {
  const plugins = await discoverPlugins(options);
  return plugins.find(p => p.name === name) || null;
}

/**
 * Get all plugin commands
 */
export function getPluginCommands(plugins: Plugin[]): Map<string, PluginCommand[]> {
  const commandMap = new Map<string, PluginCommand[]>();

  for (const plugin of plugins) {
    commandMap.set(plugin.name, plugin.commands);
  }

  return commandMap;
}

/**
 * Search plugins by keyword
 */
export function searchPlugins(plugins: Plugin[], query: string): Plugin[] {
  const lowerQuery = query.toLowerCase();

  return plugins.filter(plugin => {
    // Search in name
    if (plugin.name.toLowerCase().includes(lowerQuery)) {
      return true;
    }

    // Search in description
    if (plugin.description.toLowerCase().includes(lowerQuery)) {
      return true;
    }

    // Search in command names
    if (plugin.commands.some(cmd => cmd.name.toLowerCase().includes(lowerQuery))) {
      return true;
    }

    // Search in tags (if present)
    if (plugin.tags && plugin.tags.some(tag => tag.toLowerCase().includes(lowerQuery))) {
      return true;
    }

    return false;
  });
}

/**
 * Group plugins by category
 */
export function groupPluginsByCategory(plugins: Plugin[]): Map<string, Plugin[]> {
  const groups = new Map<string, Plugin[]>();

  for (const plugin of plugins) {
    const category = plugin.category || 'Other';

    if (!groups.has(category)) {
      groups.set(category, []);
    }

    groups.get(category)!.push(plugin);
  }

  return groups;
}

/**
 * Get plugin statistics
 */
export function getPluginStats(plugins: Plugin[]): {
  total: number;
  enabled: number;
  disabled: number;
  totalCommands: number;
  byCategory: Record<string, number>;
  byPermission: Record<string, number>;
} {
  const stats = {
    total: plugins.length,
    enabled: plugins.filter(p => !p.disabled).length,
    disabled: plugins.filter(p => p.disabled).length,
    totalCommands: plugins.reduce((sum, p) => sum + p.commands.length, 0),
    byCategory: {} as Record<string, number>,
    byPermission: {} as Record<string, number>
  };

  // Group by category
  for (const plugin of plugins) {
    const category = plugin.category || 'Other';
    stats.byCategory[category] = (stats.byCategory[category] || 0) + 1;
  }

  // Count permissions
  for (const plugin of plugins) {
    if (plugin.permissions) {
      for (const perm of plugin.permissions) {
        stats.byPermission[perm] = (stats.byPermission[perm] || 0) + 1;
      }
    }
  }

  return stats;
}
