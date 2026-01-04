/**
 * Discovery Module
 *
 * Exports all discovery functionality
 */

// Main service discovery
export {
  discoverServices,
  refreshDiscovery,
  getDiscovery,
  getService,
  getServiceHealth,
  getServiceCommands,
  getNexusCommands,
  getPlugins,
  searchCommands,
  getServiceStats,
  clearCache,
  getCacheStatus,
  validateService,
  getServiceDependencies,
  checkDependencies,
  type ServiceDiscoveryOptions,
  type DiscoveryResult
} from './service-discovery.js';

// Docker parser
export {
  parseDockerCompose,
  extractServiceMetadata,
  parseMultipleComposeFiles,
  filterApplicationServices,
  type DockerParserOptions
} from './docker-parser.js';

// OpenAPI parser
export {
  fetchOpenAPISpec,
  parseOpenAPIToCommands,
  getAllOperations,
  getAuthRequirements,
  resolveRefs,
  type OpenAPISpec,
  type OpenAPIPath,
  type OpenAPIOperation,
  type OpenAPIParameter,
  type OpenAPIParserOptions
} from './openapi-parser.js';

// MCP discovery
export {
  discoverMCPTools,
  discoverMCPCommands,
  mcpToolToCommand,
  type MCPTool,
  type MCPProperty,
  type MCPDiscoveryOptions
} from './mcp-discovery.js';

// Plugin discovery
export {
  discoverPlugins,
  loadPlugin,
  loadPluginManifest,
  checkPluginDependencies,
  filterPluginsByPermissions,
  getPlugin,
  getPluginCommands,
  searchPlugins,
  groupPluginsByCategory,
  getPluginStats,
  type PluginDiscoveryOptions
} from './plugin-discovery.js';
