/**
 * Profile Manager for Nexus CLI
 *
 * Manages configuration profiles:
 * - Create/delete profiles
 * - Switch between profiles
 * - Export/import profiles
 * - List all profiles
 */

import * as fs from 'fs-extra';
import * as path from 'path';
import type { Profile, NexusConfig, GlobalConfig } from '../../types/config.js';
import { ConfigurationError } from '../../utils/error-handler.js';
import { logger } from '../../utils/logger.js';
import { ConfigManager } from './config-manager.js';

export class ProfileManager {
  constructor(private configManager: ConfigManager) {}

  /**
   * List all profiles
   */
  async listProfiles(): Promise<Profile[]> {
    const globalConfig = await this.configManager.loadGlobalConfig();
    return globalConfig.profiles;
  }

  /**
   * Get current profile
   */
  async getCurrentProfile(): Promise<Profile> {
    return await this.configManager.getCurrentProfile();
  }

  /**
   * Get profile by name
   */
  async getProfile(name: string): Promise<Profile | null> {
    const profiles = await this.listProfiles();
    return profiles.find((p) => p.name === name) || null;
  }

  /**
   * Create a new profile
   */
  async createProfile(name: string, config: NexusConfig, setAsDefault: boolean = false): Promise<Profile> {
    const globalConfig = await this.configManager.loadGlobalConfig();

    // Check if profile already exists
    if (globalConfig.profiles.some((p) => p.name === name)) {
      throw new ConfigurationError(`Profile '${name}' already exists`, { profileName: name });
    }

    const newProfile: Profile = {
      name,
      config,
      default: setAsDefault,
    };

    // If setting as default, unset other defaults
    if (setAsDefault) {
      globalConfig.profiles.forEach((p) => {
        p.default = false;
      });
      globalConfig.currentProfile = name;
    }

    globalConfig.profiles.push(newProfile);
    await this.configManager.saveGlobalConfig(globalConfig);

    logger.success(`Created profile '${name}'${setAsDefault ? ' (set as default)' : ''}`);

    return newProfile;
  }

  /**
   * Delete a profile
   */
  async deleteProfile(name: string): Promise<void> {
    const globalConfig = await this.configManager.loadGlobalConfig();

    // Cannot delete default profile if it's the only one
    if (globalConfig.profiles.length === 1) {
      throw new ConfigurationError('Cannot delete the only profile', { profileName: name });
    }

    const profileIndex = globalConfig.profiles.findIndex((p) => p.name === name);
    if (profileIndex === -1) {
      throw new ConfigurationError(`Profile '${name}' not found`, { profileName: name });
    }

    const wasDefault = globalConfig.profiles[profileIndex].default;
    const wasCurrent = globalConfig.currentProfile === name;

    // Remove profile
    globalConfig.profiles.splice(profileIndex, 1);

    // If we deleted the default or current profile, set a new one
    if (wasDefault || wasCurrent) {
      globalConfig.profiles[0].default = true;
      globalConfig.currentProfile = globalConfig.profiles[0].name;
    }

    await this.configManager.saveGlobalConfig(globalConfig);

    logger.success(`Deleted profile '${name}'`);
  }

  /**
   * Switch to a different profile
   */
  async switchProfile(name: string): Promise<void> {
    const globalConfig = await this.configManager.loadGlobalConfig();

    const profile = globalConfig.profiles.find((p) => p.name === name);
    if (!profile) {
      throw new ConfigurationError(`Profile '${name}' not found`, {
        profileName: name,
        availableProfiles: globalConfig.profiles.map((p) => p.name),
      });
    }

    globalConfig.currentProfile = name;
    await this.configManager.saveGlobalConfig(globalConfig);

    // Clear cached config
    this.configManager.clearCache();

    logger.success(`Switched to profile '${name}'`);
  }

  /**
   * Set a profile as default
   */
  async setDefaultProfile(name: string): Promise<void> {
    const globalConfig = await this.configManager.loadGlobalConfig();

    const profileIndex = globalConfig.profiles.findIndex((p) => p.name === name);
    if (profileIndex === -1) {
      throw new ConfigurationError(`Profile '${name}' not found`, { profileName: name });
    }

    // Unset all defaults
    globalConfig.profiles.forEach((p) => {
      p.default = false;
    });

    // Set new default
    globalConfig.profiles[profileIndex].default = true;
    globalConfig.currentProfile = name;

    await this.configManager.saveGlobalConfig(globalConfig);

    logger.success(`Set '${name}' as default profile`);
  }

  /**
   * Update profile configuration
   */
  async updateProfile(name: string, config: Partial<NexusConfig>): Promise<void> {
    const globalConfig = await this.configManager.loadGlobalConfig();

    const profileIndex = globalConfig.profiles.findIndex((p) => p.name === name);
    if (profileIndex === -1) {
      throw new ConfigurationError(`Profile '${name}' not found`, { profileName: name });
    }

    // Merge configurations
    const currentConfig = globalConfig.profiles[profileIndex].config;
    globalConfig.profiles[profileIndex].config = {
      ...currentConfig,
      workspace: { ...currentConfig.workspace, ...config.workspace },
      services: { ...currentConfig.services, ...config.services },
      auth: { ...currentConfig.auth, ...config.auth },
      defaults: { ...currentConfig.defaults, ...config.defaults },
      agent: { ...currentConfig.agent, ...config.agent },
      plugins: { ...currentConfig.plugins, ...config.plugins },
      nexus: { ...currentConfig.nexus, ...config.nexus },
      shortcuts: [...(currentConfig.shortcuts || []), ...(config.shortcuts || [])],
    };

    await this.configManager.saveGlobalConfig(globalConfig);

    // Clear cached config
    this.configManager.clearCache();

    logger.success(`Updated profile '${name}'`);
  }

  /**
   * Rename a profile
   */
  async renameProfile(oldName: string, newName: string): Promise<void> {
    const globalConfig = await this.configManager.loadGlobalConfig();

    // Check if new name already exists
    if (globalConfig.profiles.some((p) => p.name === newName)) {
      throw new ConfigurationError(`Profile '${newName}' already exists`, { profileName: newName });
    }

    const profileIndex = globalConfig.profiles.findIndex((p) => p.name === oldName);
    if (profileIndex === -1) {
      throw new ConfigurationError(`Profile '${oldName}' not found`, { profileName: oldName });
    }

    // Rename profile
    globalConfig.profiles[profileIndex].name = newName;

    // Update current profile if needed
    if (globalConfig.currentProfile === oldName) {
      globalConfig.currentProfile = newName;
    }

    await this.configManager.saveGlobalConfig(globalConfig);

    logger.success(`Renamed profile '${oldName}' to '${newName}'`);
  }

  /**
   * Export profile to JSON
   */
  async exportProfile(name: string): Promise<Profile> {
    const profile = await this.getProfile(name);
    if (!profile) {
      throw new ConfigurationError(`Profile '${name}' not found`, { profileName: name });
    }

    return profile;
  }

  /**
   * Export profile to file
   */
  async exportProfileToFile(name: string, filePath: string): Promise<void> {
    const profile = await this.exportProfile(name);

    try {
      await fs.writeJson(filePath, profile, { spaces: 2 });
      logger.success(`Exported profile '${name}' to ${filePath}`);
    } catch (error) {
      throw new ConfigurationError(
        `Failed to export profile: ${error instanceof Error ? error.message : String(error)}`,
        { profileName: name, filePath }
      );
    }
  }

  /**
   * Import profile from JSON
   */
  async importProfile(profileData: Profile, overwrite: boolean = false): Promise<void> {
    const globalConfig = await this.configManager.loadGlobalConfig();

    const existingIndex = globalConfig.profiles.findIndex((p) => p.name === profileData.name);

    if (existingIndex !== -1 && !overwrite) {
      throw new ConfigurationError(
        `Profile '${profileData.name}' already exists. Use overwrite option to replace it.`,
        { profileName: profileData.name }
      );
    }

    if (existingIndex !== -1) {
      // Overwrite existing
      globalConfig.profiles[existingIndex] = profileData;
      logger.success(`Overwrote profile '${profileData.name}'`);
    } else {
      // Add new profile
      globalConfig.profiles.push(profileData);
      logger.success(`Imported profile '${profileData.name}'`);
    }

    await this.configManager.saveGlobalConfig(globalConfig);
  }

  /**
   * Import profile from file
   */
  async importProfileFromFile(filePath: string, overwrite: boolean = false): Promise<void> {
    try {
      const profileData = await fs.readJson(filePath);
      await this.importProfile(profileData, overwrite);
      logger.success(`Imported profile from ${filePath}`);
    } catch (error) {
      throw new ConfigurationError(
        `Failed to import profile: ${error instanceof Error ? error.message : String(error)}`,
        { filePath }
      );
    }
  }

  /**
   * Copy profile
   */
  async copyProfile(sourceName: string, targetName: string, setAsDefault: boolean = false): Promise<Profile> {
    const sourceProfile = await this.getProfile(sourceName);
    if (!sourceProfile) {
      throw new ConfigurationError(`Profile '${sourceName}' not found`, { profileName: sourceName });
    }

    // Create a copy with new name
    return await this.createProfile(targetName, { ...sourceProfile.config }, setAsDefault);
  }
}

/**
 * Create profile manager instance
 */
export function createProfileManager(configManager: ConfigManager): ProfileManager {
  return new ProfileManager(configManager);
}
