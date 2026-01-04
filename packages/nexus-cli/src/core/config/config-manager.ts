/**
 * Configuration Manager for Nexus CLI
 *
 * Handles loading, merging, and managing configuration from multiple sources:
 * - Global config (~/.nexus/config.toml)
 * - Workspace config (.nexus.toml)
 * - Environment variables
 * - Command line arguments
 */

import * as fs from 'fs-extra';
import * as path from 'path';
import * as os from 'os';
import * as yaml from 'yaml';
import { z } from 'zod';
import type {
  NexusConfig,
  WorkspaceConfig,
  ServicesConfig,
  AuthConfig,
  DefaultsConfig,
  AgentConfig,
  PluginsConfig,
  NexusIntegrationConfig,
  Shortcut,
  GlobalConfig,
  Profile,
} from '../../types/config.js';
import { ConfigurationError } from '../../utils/error-handler.js';
import { logger } from '../../utils/logger.js';

/**
 * Zod schemas for configuration validation
 */
const WorkspaceConfigSchema = z.object({
  name: z.string().optional(),
  type: z.enum(['typescript', 'python', 'go', 'rust', 'java']).optional(),
});

const ServicesConfigSchema = z.object({
  apiUrl: z.string().url().optional(),
  mcpUrl: z.string().url().optional(),
  timeout: z.number().positive().optional(),
  retries: z.number().nonnegative().optional(),
});

const AuthConfigSchema = z.object({
  apiKey: z.string().optional(),
  strategy: z.enum(['api-key', 'oauth', 'jwt']).optional(),
  token: z.string().optional(),
});

const DefaultsConfigSchema = z.object({
  outputFormat: z.enum(['text', 'json', 'yaml', 'table', 'stream-json']).optional(),
  streaming: z.boolean().optional(),
  verbose: z.boolean().optional(),
  quiet: z.boolean().optional(),
});

const AgentConfigSchema = z.object({
  maxIterations: z.number().positive().optional(),
  autoApproveSafe: z.boolean().optional(),
  workspace: z.string().optional(),
  budget: z.number().positive().optional(),
});

const PluginsConfigSchema = z.object({
  enabled: z.array(z.string()).optional(),
  disabled: z.array(z.string()).optional(),
  autoUpdate: z.boolean().optional(),
});

const NexusIntegrationConfigSchema = z.object({
  autoStore: z.boolean().optional(),
  memoryTags: z.array(z.string()).optional(),
  healthCheckInterval: z.number().positive().optional(),
});

const ShortcutSchema = z.object({
  name: z.string(),
  command: z.string(),
  description: z.string().optional(),
});

const NexusConfigSchema = z.object({
  workspace: WorkspaceConfigSchema.optional(),
  services: ServicesConfigSchema.optional(),
  auth: AuthConfigSchema.optional(),
  defaults: DefaultsConfigSchema.optional(),
  agent: AgentConfigSchema.optional(),
  plugins: PluginsConfigSchema.optional(),
  nexus: NexusIntegrationConfigSchema.optional(),
  shortcuts: z.array(ShortcutSchema).optional(),
});

const ProfileSchema = z.object({
  name: z.string(),
  config: NexusConfigSchema,
  default: z.boolean().optional(),
});

const GlobalConfigSchema = z.object({
  profiles: z.array(ProfileSchema),
  currentProfile: z.string().optional(),
  pluginDirectory: z.string().optional(),
  cacheDirectory: z.string().optional(),
  updateCheck: z.boolean().optional(),
  telemetry: z.boolean().optional(),
});

/**
 * Default configuration values
 */
const DEFAULT_CONFIG: NexusConfig = {
  services: {
    apiUrl: 'http://localhost:9092',
    mcpUrl: 'http://localhost:9000',
    timeout: 30000,
    retries: 3,
  },
  defaults: {
    outputFormat: 'text',
    streaming: true,
    verbose: false,
    quiet: false,
  },
  agent: {
    maxIterations: 20,
    autoApproveSafe: false,
    workspace: '.',
  },
  plugins: {
    enabled: [],
    disabled: [],
    autoUpdate: false,
  },
  nexus: {
    autoStore: true,
    memoryTags: [],
    healthCheckInterval: 60000,
  },
};

/**
 * Configuration Manager
 */
export class ConfigManager {
  private readonly configDir: string;
  private readonly globalConfigFile: string;
  private readonly workspaceConfigFile: string = '.nexus.toml';

  private globalConfig: GlobalConfig | null = null;
  private workspaceConfig: NexusConfig | null = null;
  private mergedConfig: NexusConfig | null = null;

  constructor(configDir?: string) {
    this.configDir = configDir || path.join(os.homedir(), '.nexus');
    this.globalConfigFile = path.join(this.configDir, 'config.toml');
  }

  /**
   * Initialize configuration directory
   */
  async initialize(): Promise<void> {
    try {
      await fs.ensureDir(this.configDir);
      await fs.ensureDir(path.join(this.configDir, 'profiles'));
      await fs.ensureDir(path.join(this.configDir, 'plugins'));
      await fs.ensureDir(path.join(this.configDir, 'cache'));
      await fs.ensureDir(path.join(this.configDir, 'logs'));

      // Create default global config if it doesn't exist
      if (!(await fs.pathExists(this.globalConfigFile))) {
        const defaultGlobalConfig: GlobalConfig = {
          profiles: [
            {
              name: 'default',
              config: DEFAULT_CONFIG,
              default: true,
            },
          ],
          currentProfile: 'default',
          pluginDirectory: path.join(this.configDir, 'plugins'),
          cacheDirectory: path.join(this.configDir, 'cache'),
          updateCheck: true,
          telemetry: false,
        };
        await this.saveGlobalConfig(defaultGlobalConfig);
      }
    } catch (error) {
      throw new ConfigurationError(
        `Failed to initialize configuration directory: ${error instanceof Error ? error.message : String(error)}`,
        { configDir: this.configDir }
      );
    }
  }

  /**
   * Load global configuration
   */
  async loadGlobalConfig(): Promise<GlobalConfig> {
    try {
      if (!(await fs.pathExists(this.globalConfigFile))) {
        await this.initialize();
      }

      const content = await fs.readFile(this.globalConfigFile, 'utf-8');
      const parsed = yaml.parse(content);
      const validated = GlobalConfigSchema.parse(parsed) as GlobalConfig;

      this.globalConfig = validated;
      return validated;
    } catch (error) {
      if (error instanceof z.ZodError) {
        throw new ConfigurationError(
          `Invalid global configuration: ${error.errors.map((e) => e.message).join(', ')}`,
          { errors: error.errors }
        );
      }
      throw new ConfigurationError(
        `Failed to load global configuration: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * Save global configuration
   */
  async saveGlobalConfig(config: GlobalConfig): Promise<void> {
    try {
      const validated = GlobalConfigSchema.parse(config) as GlobalConfig;
      const content = yaml.stringify(validated);
      await fs.writeFile(this.globalConfigFile, content, 'utf-8');
      this.globalConfig = validated;
    } catch (error) {
      if (error instanceof z.ZodError) {
        throw new ConfigurationError(
          `Invalid global configuration: ${error.errors.map((e) => e.message).join(', ')}`,
          { errors: error.errors }
        );
      }
      throw new ConfigurationError(
        `Failed to save global configuration: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * Load workspace configuration
   */
  async loadWorkspaceConfig(cwd?: string): Promise<NexusConfig | null> {
    const workingDir = cwd || process.cwd();
    const configPath = path.join(workingDir, this.workspaceConfigFile);

    try {
      if (!(await fs.pathExists(configPath))) {
        logger.debug(`No workspace config found at ${configPath}`);
        return null;
      }

      const content = await fs.readFile(configPath, 'utf-8');
      const parsed = yaml.parse(content);
      const validated = NexusConfigSchema.parse(parsed) as NexusConfig;

      this.workspaceConfig = validated;
      return validated;
    } catch (error) {
      if (error instanceof z.ZodError) {
        throw new ConfigurationError(
          `Invalid workspace configuration: ${error.errors.map((e) => e.message).join(', ')}`,
          { configPath, errors: error.errors }
        );
      }
      logger.warn(`Failed to load workspace config: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  }

  /**
   * Get current profile configuration
   */
  async getCurrentProfile(): Promise<Profile> {
    const globalConfig = await this.loadGlobalConfig();
    const profileName = globalConfig.currentProfile || 'default';

    const profile = globalConfig.profiles.find((p) => p.name === profileName);
    if (!profile) {
      throw new ConfigurationError(`Profile '${profileName}' not found`, {
        profileName,
        availableProfiles: globalConfig.profiles.map((p) => p.name),
      });
    }

    return profile;
  }

  /**
   * Get merged configuration (workspace overrides profile)
   */
  async getConfig(cwd?: string): Promise<NexusConfig> {
    if (this.mergedConfig) {
      return this.mergedConfig;
    }

    // Load profile config
    const profile = await this.getCurrentProfile();
    let config = profile.config;

    // Merge with workspace config if available
    const workspaceConfig = await this.loadWorkspaceConfig(cwd);
    if (workspaceConfig) {
      config = this.mergeConfigs(config, workspaceConfig);
    }

    // Apply environment variables
    config = this.applyEnvironmentVariables(config);

    this.mergedConfig = config;
    return config;
  }

  /**
   * Merge two configurations (second overrides first)
   */
  private mergeConfigs(base: NexusConfig, override: NexusConfig): NexusConfig {
    return {
      workspace: { ...base.workspace, ...override.workspace },
      services: { ...base.services, ...override.services },
      auth: { ...base.auth, ...override.auth },
      defaults: { ...base.defaults, ...override.defaults },
      agent: { ...base.agent, ...override.agent },
      plugins: {
        enabled: override.plugins?.enabled || base.plugins?.enabled,
        disabled: override.plugins?.disabled || base.plugins?.disabled,
        autoUpdate: override.plugins?.autoUpdate ?? base.plugins?.autoUpdate,
      },
      nexus: { ...base.nexus, ...override.nexus },
      shortcuts: [...(base.shortcuts || []), ...(override.shortcuts || [])],
    };
  }

  /**
   * Apply environment variables to configuration
   */
  private applyEnvironmentVariables(config: NexusConfig): NexusConfig {
    const envConfig = { ...config };

    // Services
    if (process.env.NEXUS_API_URL) {
      envConfig.services = envConfig.services || {};
      envConfig.services.apiUrl = process.env.NEXUS_API_URL;
    }
    if (process.env.NEXUS_MCP_URL) {
      envConfig.services = envConfig.services || {};
      envConfig.services.mcpUrl = process.env.NEXUS_MCP_URL;
    }

    // Auth
    if (process.env.NEXUS_API_KEY) {
      envConfig.auth = envConfig.auth || {};
      envConfig.auth.apiKey = process.env.NEXUS_API_KEY;
    }

    // Handle ${VAR} syntax in config values
    if (envConfig.auth?.apiKey && envConfig.auth.apiKey.startsWith('${') && envConfig.auth.apiKey.endsWith('}')) {
      const varName = envConfig.auth.apiKey.slice(2, -1);
      envConfig.auth.apiKey = process.env[varName] || envConfig.auth.apiKey;
    }

    return envConfig;
  }

  /**
   * Get a specific configuration value
   */
  async getValue<T = unknown>(key: string, cwd?: string): Promise<T | undefined> {
    const config = await this.getConfig(cwd);
    const parts = key.split('.');

    let current: any = config;
    for (const part of parts) {
      if (current && typeof current === 'object' && part in current) {
        current = current[part];
      } else {
        return undefined;
      }
    }

    return current as T;
  }

  /**
   * Set a configuration value in the current profile
   */
  async setValue(key: string, value: unknown): Promise<void> {
    const globalConfig = await this.loadGlobalConfig();
    const profile = await this.getCurrentProfile();

    const parts = key.split('.');
    let current: any = profile.config;

    for (let i = 0; i < parts.length - 1; i++) {
      const part = parts[i];
      if (!(part in current)) {
        current[part] = {};
      }
      current = current[part];
    }

    current[parts[parts.length - 1]] = value;

    // Update profile in global config
    const profileIndex = globalConfig.profiles.findIndex((p) => p.name === profile.name);
    if (profileIndex !== -1) {
      globalConfig.profiles[profileIndex] = profile;
      await this.saveGlobalConfig(globalConfig);
      this.mergedConfig = null; // Invalidate cache
    }
  }

  /**
   * Create workspace configuration
   */
  async initWorkspaceConfig(config: NexusConfig, cwd?: string): Promise<void> {
    const workingDir = cwd || process.cwd();
    const configPath = path.join(workingDir, this.workspaceConfigFile);

    try {
      const validated = NexusConfigSchema.parse(config);
      const content = yaml.stringify(validated);
      await fs.writeFile(configPath, content, 'utf-8');
      logger.success(`Created workspace configuration at ${configPath}`);
    } catch (error) {
      if (error instanceof z.ZodError) {
        throw new ConfigurationError(
          `Invalid workspace configuration: ${error.errors.map((e) => e.message).join(', ')}`,
          { errors: error.errors }
        );
      }
      throw new ConfigurationError(
        `Failed to create workspace configuration: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * Clear cached configuration
   */
  clearCache(): void {
    this.mergedConfig = null;
    this.workspaceConfig = null;
  }
}

/**
 * Default configuration manager instance
 */
export const configManager = new ConfigManager();
