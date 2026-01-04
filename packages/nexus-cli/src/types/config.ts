/**
 * Configuration Type Definitions
 *
 * Types for CLI configuration, profiles, and workspace settings
 */

export interface NexusConfig {
  workspace?: WorkspaceConfig;
  services?: ServicesConfig;
  auth?: AuthConfig;
  defaults?: DefaultsConfig;
  agent?: AgentConfig;
  plugins?: PluginsConfig;
  nexus?: NexusIntegrationConfig;
  shortcuts?: Shortcut[];
}

export interface WorkspaceConfig {
  name?: string;
  type?: 'typescript' | 'python' | 'go' | 'rust' | 'java';
}

export interface ServicesConfig {
  apiUrl?: string;
  mcpUrl?: string;
  timeout?: number;
  retries?: number;
}

export interface AuthConfig {
  type?: 'api-key' | 'bearer' | 'basic' | 'oauth';
  credentials?: string | Record<string, string>;
  apiKey?: string; // Legacy support
}

export interface DefaultsConfig {
  outputFormat?: 'text' | 'json' | 'yaml' | 'table' | 'stream-json';
  streaming?: boolean;
  verbose?: boolean;
  quiet?: boolean;
}

export interface AgentConfig {
  maxIterations?: number;
  autoApproveSafe?: boolean;
  workspace?: string;
  budget?: number;
}

export interface PluginsConfig {
  enabled?: string[];
  disabled?: string[];
  autoUpdate?: boolean;
}

export interface NexusIntegrationConfig {
  autoStore?: boolean;
  memoryTags?: string[];
  healthCheckInterval?: number;
}

export interface Shortcut {
  name: string;
  command: string;
  description?: string;
}

export interface Profile {
  name: string;
  config: NexusConfig;
  default?: boolean;
}

export interface GlobalConfig {
  profiles: Profile[];
  currentProfile?: string;
  pluginDirectory?: string;
  cacheDirectory?: string;
  updateCheck?: boolean;
  telemetry?: boolean;
}
