/**
 * Plugin Storage
 *
 * Provides persistent storage for plugins
 */

import fs from 'fs-extra';
import path from 'path';
import os from 'os';
import { logger } from '../utils/logger.js';

/**
 * Get the Nexus home directory
 */
export function getNexusHome(): string {
  return process.env.NEXUS_HOME || path.join(os.homedir(), '.nexus');
}

/**
 * Plugin Storage Class
 *
 * Each plugin gets its own isolated storage directory
 */
export class PluginStorage {
  private pluginName: string;
  private storagePath: string;
  private data: Map<string, any>;

  constructor(pluginName: string) {
    this.pluginName = pluginName;
    this.storagePath = path.join(getNexusHome(), 'plugin-data', pluginName);
    this.data = new Map();
  }

  /**
   * Initialize storage directory
   */
  async initialize(): Promise<void> {
    try {
      await fs.ensureDir(this.storagePath);
      await this.loadFromDisk();
      logger.debug(`Plugin storage initialized for: ${this.pluginName}`);
    } catch (error) {
      logger.error(`Failed to initialize plugin storage for ${this.pluginName}:`, error);
      throw error;
    }
  }

  /**
   * Get value by key
   */
  get<T = any>(key: string): T | undefined {
    return this.data.get(key) as T | undefined;
  }

  /**
   * Set value by key
   */
  async set<T = any>(key: string, value: T): Promise<void> {
    this.data.set(key, value);
    await this.persistToDisk();
  }

  /**
   * Check if key exists
   */
  has(key: string): boolean {
    return this.data.has(key);
  }

  /**
   * Delete value by key
   */
  async delete(key: string): Promise<boolean> {
    const result = this.data.delete(key);
    await this.persistToDisk();
    return result;
  }

  /**
   * Get all keys
   */
  keys(): string[] {
    return Array.from(this.data.keys());
  }

  /**
   * Get all values
   */
  values(): any[] {
    return Array.from(this.data.values());
  }

  /**
   * Get all entries
   */
  entries(): [string, any][] {
    return Array.from(this.data.entries());
  }

  /**
   * Clear all data
   */
  async clear(): Promise<void> {
    this.data.clear();
    await this.persistToDisk();
  }

  /**
   * Get storage size (number of keys)
   */
  size(): number {
    return this.data.size;
  }

  /**
   * Load data from disk
   */
  private async loadFromDisk(): Promise<void> {
    const dataFile = path.join(this.storagePath, 'storage.json');

    try {
      if (await fs.pathExists(dataFile)) {
        const content = await fs.readFile(dataFile, 'utf-8');
        const parsed = JSON.parse(content);

        this.data = new Map(Object.entries(parsed));
        logger.debug(`Loaded ${this.data.size} entries for plugin: ${this.pluginName}`);
      }
    } catch (error) {
      logger.warn(`Failed to load storage for plugin ${this.pluginName}:`, error);
      // Don't throw - start with empty storage
      this.data = new Map();
    }
  }

  /**
   * Persist data to disk
   */
  private async persistToDisk(): Promise<void> {
    const dataFile = path.join(this.storagePath, 'storage.json');

    try {
      const obj = Object.fromEntries(this.data.entries());
      await fs.writeFile(dataFile, JSON.stringify(obj, null, 2), 'utf-8');
    } catch (error) {
      logger.error(`Failed to persist storage for plugin ${this.pluginName}:`, error);
      throw error;
    }
  }

  /**
   * Get file storage path for plugin
   */
  getFilePath(filename: string): string {
    return path.join(this.storagePath, filename);
  }

  /**
   * Write file to plugin storage
   */
  async writeFile(filename: string, content: string | Buffer): Promise<void> {
    const filePath = this.getFilePath(filename);
    await fs.writeFile(filePath, content);
  }

  /**
   * Read file from plugin storage
   */
  async readFile(filename: string): Promise<string> {
    const filePath = this.getFilePath(filename);
    return fs.readFile(filePath, 'utf-8');
  }

  /**
   * Check if file exists in plugin storage
   */
  async fileExists(filename: string): Promise<boolean> {
    const filePath = this.getFilePath(filename);
    return fs.pathExists(filePath);
  }

  /**
   * Delete file from plugin storage
   */
  async deleteFile(filename: string): Promise<void> {
    const filePath = this.getFilePath(filename);
    await fs.remove(filePath);
  }

  /**
   * List files in plugin storage
   */
  async listFiles(): Promise<string[]> {
    const files = await fs.readdir(this.storagePath);
    return files.filter((file) => file !== 'storage.json');
  }
}

/**
 * Create plugin storage instance
 */
export function createPluginStorage(pluginName: string): PluginStorage {
  return new PluginStorage(pluginName);
}

/**
 * Get plugins directory
 */
export function getPluginsDirectory(): string {
  return path.join(getNexusHome(), 'plugins');
}

/**
 * Get plugin data directory
 */
export function getPluginDataDirectory(pluginName: string): string {
  return path.join(getNexusHome(), 'plugin-data', pluginName);
}

/**
 * Ensure Nexus directories exist
 */
export async function ensureNexusDirectories(): Promise<void> {
  const nexusHome = getNexusHome();
  const pluginsDir = getPluginsDirectory();
  const pluginDataDir = path.join(nexusHome, 'plugin-data');

  await fs.ensureDir(nexusHome);
  await fs.ensureDir(pluginsDir);
  await fs.ensureDir(pluginDataDir);

  logger.debug(`Nexus directories initialized at: ${nexusHome}`);
}
