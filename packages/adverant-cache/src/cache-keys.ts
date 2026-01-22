/**
 * Cache Key Utilities
 *
 * Standardized cache key generators for common patterns across Nexus services.
 * Using consistent keys ensures cache efficiency and proper invalidation.
 */

/**
 * Cache key generators for Nexus services
 */
export const cacheKeys = {
  // GraphRAG query results
  graphragQuery: (query: string, options?: Record<string, any>) =>
    options
      ? `graphrag:query:${hashString(query)}:${hashObject(options)}`
      : `graphrag:query:${hashString(query)}`,

  // Memory recall results
  memoryRecall: (query: string, limit?: number) =>
    limit ? `memory:recall:${hashString(query)}:${limit}` : `memory:recall:${hashString(query)}`,

  // Document retrieval
  document: (documentId: string) => `document:${documentId}`,

  // Document list
  documentList: (filter?: string) =>
    filter ? `documents:list:${hashString(filter)}` : 'documents:list',

  // Entity queries
  entity: (entityId: string) => `entity:${entityId}`,

  entityByType: (type: string, searchText?: string) =>
    searchText
      ? `entity:type:${type}:${hashString(searchText)}`
      : `entity:type:${type}`,

  // Agent results
  agentResult: (agentId: string, taskId: string) => `agent:${agentId}:task:${taskId}`,

  agentModel: (modelId: string) => `agent:model:${modelId}`,

  agentModelList: () => 'agent:models:list',

  // Pattern and learning
  pattern: (context: string) => `pattern:${hashString(context)}`,

  learnedKnowledge: (topic: string, layer?: string) =>
    layer ? `learning:${topic}:${layer}` : `learning:${topic}`,

  // Validation results
  codeValidation: (codeHash: string) => `validation:code:${codeHash}`,

  commandValidation: (commandHash: string) => `validation:command:${commandHash}`,

  // Health and monitoring
  healthStatus: (service: string) => `health:${service}`,

  metrics: (service: string, metric: string) => `metrics:${service}:${metric}`,

  // User and session
  user: (userId: string) => `user:${userId}`,

  session: (sessionId: string) => `session:${sessionId}`,

  // Video processing
  videoJob: (jobId: string) => `video:job:${jobId}`,

  videoMetadata: (videoId: string) => `video:metadata:${videoId}`,

  // Geo processing
  geoInference: (modelId: string, inputHash: string) =>
    `geo:inference:${modelId}:${inputHash}`,

  // File processing
  fileProcessJob: (jobId: string) => `file:job:${jobId}`,

  fileMetadata: (fileId: string) => `file:metadata:${fileId}`,

  // Sandbox execution
  sandboxExecution: (executionId: string) => `sandbox:exec:${executionId}`,

  sandboxTemplate: (templateId: string) => `sandbox:template:${templateId}`,

  // Custom key with pattern
  custom: (category: string, ...parts: string[]) =>
    `${category}:${parts.join(':')}`,
};

/**
 * Cache invalidation patterns
 *
 * Use these patterns with invalidatePattern() to clear related cache entries.
 */
export const invalidationPatterns = {
  // GraphRAG
  allGraphragQueries: () => 'graphrag:query:*',

  graphragByQuery: (query: string) => `graphrag:query:${hashString(query)}:*`,

  // Memory
  allMemoryRecalls: () => 'memory:recall:*',

  memoryByQuery: (query: string) => `memory:recall:${hashString(query)}:*`,

  // Documents
  allDocuments: () => 'document:*',

  allDocumentLists: () => 'documents:list:*',

  // Entities
  allEntities: () => 'entity:*',

  entitiesByType: (type: string) => `entity:type:${type}:*`,

  // Agents
  allAgentResults: () => 'agent:*',

  agentResults: (agentId: string) => `agent:${agentId}:*`,

  allAgentModels: () => 'agent:model*',

  // Patterns and learning
  allPatterns: () => 'pattern:*',

  allLearning: () => 'learning:*',

  learningByTopic: (topic: string) => `learning:${topic}:*`,

  // Validation
  allValidations: () => 'validation:*',

  codeValidations: () => 'validation:code:*',

  commandValidations: () => 'validation:command:*',

  // Health and metrics
  allHealth: () => 'health:*',

  allMetrics: () => 'metrics:*',

  serviceMetrics: (service: string) => `metrics:${service}:*`,

  // Users and sessions
  allUsers: () => 'user:*',

  allSessions: () => 'session:*',

  userSessions: (userId: string) => `session:user:${userId}:*`,

  // Video
  allVideoJobs: () => 'video:job:*',

  allVideoMetadata: () => 'video:metadata:*',

  // Geo
  allGeoInference: () => 'geo:inference:*',

  geoInferenceByModel: (modelId: string) => `geo:inference:${modelId}:*`,

  // File processing
  allFileJobs: () => 'file:job:*',

  allFileMetadata: () => 'file:metadata:*',

  // Sandbox
  allSandboxExecutions: () => 'sandbox:exec:*',

  allSandboxTemplates: () => 'sandbox:template:*',

  // Custom pattern
  custom: (pattern: string) => pattern,
};

/**
 * Hash a string for use in cache keys
 *
 * Creates a short, consistent hash for variable-length strings.
 */
function hashString(str: string): string {
  const crypto = require('crypto');
  return crypto.createHash('sha256').update(str).digest('hex').substring(0, 16);
}

/**
 * Hash an object for use in cache keys
 *
 * Creates a deterministic hash based on object properties.
 */
function hashObject(obj: Record<string, any>): string {
  // Sort keys for consistent hashing
  const sortedKeys = Object.keys(obj).sort();
  const str = sortedKeys.map((key) => `${key}=${JSON.stringify(obj[key])}`).join('&');
  return hashString(str);
}
