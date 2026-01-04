/**
 * FileProcessAgent API Configuration
 *
 * Loads configuration from environment variables using the same pattern as
 * other Nexus Stack services (GraphRAG, MageAgent, LearningAgent).
 *
 * All credentials are loaded from .env.nexus file.
 */

export interface Config {
  // Service ports
  port: number;
  wsPort: number;

  // Database connections
  redisUrl: string;
  databaseUrl: string;

  // Nexus Stack service endpoints
  graphragUrl: string;
  mageagentUrl: string;
  learningagentUrl: string;
  sandboxUrl: string;
  cyberagentUrl: string;
  videoagentUrl: string;
  geoagentUrl: string;
  githubManagerUrl: string;

  // API keys (loaded from .env.nexus)
  voyageaiApiKey: string;
  openrouterApiKey: string;

  // Google OAuth (for Drive integration)
  googleClientId: string;
  googleClientSecret: string;
  googleRedirectUrl: string;

  // Google Drive Service Account (for server-to-server uploads)
  googleServiceAccountEmail: string;
  googleServiceAccountPrivateKey: string;
  googleDriveFolderId: string;
  bufferThresholdBytes: number; // Threshold for buffer vs. Drive storage
  googleDriveMaxRetries: number;
  googleDriveRetryBackoffMs: number;
  googleDriveUploadTimeoutMs: number;

  // Processing configuration
  maxFileSize: number;
  chunkSize: number;
  processingTimeout: number;
  workerConcurrency: number;

  // CORS configuration
  allowedOrigins: string[]; // Parsed from ALLOWED_ORIGINS env var

  // Environment
  nodeEnv: string;
  logLevel: string;
}

function getEnvOrThrow(key: string): string {
  const value = process.env[key];
  if (!value) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return value;
}

function getEnvOrDefault(key: string, defaultValue: string): string {
  return process.env[key] || defaultValue;
}

export const config: Config = {
  // Service ports
  port: parseInt(getEnvOrDefault('PORT', '8096'), 10),
  wsPort: parseInt(getEnvOrDefault('WS_PORT', '8098'), 10),

  // Database connections
  redisUrl: getEnvOrDefault('REDIS_URL', 'redis://nexus-redis:6379'),
  databaseUrl: getEnvOrThrow('DATABASE_URL'),

  // Nexus Stack services
  graphragUrl: getEnvOrDefault('GRAPHRAG_URL', 'http://nexus-graphrag:8090'),
  mageagentUrl: getEnvOrDefault('MAGEAGENT_URL', 'http://nexus-mageagent:8080/mageagent/api/internal/orchestrate'),
  learningagentUrl: getEnvOrDefault('LEARNINGAGENT_URL', 'http://nexus-learningagent:8097'),
  sandboxUrl: getEnvOrDefault('SANDBOX_URL', 'http://nexus-sandbox:9095'),
  cyberagentUrl: getEnvOrDefault('CYBERAGENT_URL', 'http://nexus-cyberagent:9050'),
  videoagentUrl: getEnvOrDefault('VIDEOAGENT_URL', 'http://nexus-videoagent:9065'),
  geoagentUrl: getEnvOrDefault('GEOAGENT_URL', 'http://nexus-geoagent:9103'),
  githubManagerUrl: getEnvOrDefault('GITHUB_MANAGER_URL', 'http://nexus-github-manager:9110'),

  // API keys
  voyageaiApiKey: getEnvOrThrow('VOYAGEAI_API_KEY'),
  openrouterApiKey: getEnvOrThrow('OPENROUTER_API_KEY'),

  // Google OAuth
  googleClientId: getEnvOrDefault('GOOGLE_CLIENT_ID', ''),
  googleClientSecret: getEnvOrDefault('GOOGLE_CLIENT_SECRET', ''),
  googleRedirectUrl: getEnvOrDefault('GOOGLE_REDIRECT_URL', 'http://localhost:9099/auth/callback'),

  // Google Drive Service Account (optional - if not provided, large files will fail gracefully)
  googleServiceAccountEmail: getEnvOrDefault('GOOGLE_SERVICE_ACCOUNT_EMAIL', ''),
  googleServiceAccountPrivateKey: getEnvOrDefault('GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY', ''),
  googleDriveFolderId: getEnvOrDefault('GOOGLE_DRIVE_FOLDER_ID', ''),
  bufferThresholdBytes: parseInt(getEnvOrDefault('BUFFER_THRESHOLD_MB', '10'), 10) * 1024 * 1024, // 10MB default
  googleDriveMaxRetries: parseInt(getEnvOrDefault('GOOGLE_DRIVE_MAX_RETRIES', '5'), 10),
  googleDriveRetryBackoffMs: parseInt(getEnvOrDefault('GOOGLE_DRIVE_RETRY_BACKOFF_MS', '1000'), 10),
  googleDriveUploadTimeoutMs: parseInt(getEnvOrDefault('GOOGLE_DRIVE_UPLOAD_TIMEOUT_MS', '300000'), 10), // 5min

  // Processing configuration
  maxFileSize: parseInt(getEnvOrDefault('MAX_FILE_SIZE', '5368709120'), 10), // 5GB default
  chunkSize: parseInt(getEnvOrDefault('CHUNK_SIZE', '65536'), 10), // 64KB default
  processingTimeout: parseInt(getEnvOrDefault('PROCESSING_TIMEOUT', '300000'), 10), // 5min default
  workerConcurrency: parseInt(getEnvOrDefault('WORKER_CONCURRENCY', '10'), 10),

  // CORS configuration
  // Parse ALLOWED_ORIGINS from comma-separated string to array
  // Examples:
  //   - Single origin: ALLOWED_ORIGINS=https://app.example.com
  //   - Multiple origins: ALLOWED_ORIGINS=https://app.example.com,https://staging.example.com,http://localhost:3000
  allowedOrigins: (() => {
    const originsEnv = getEnvOrDefault('ALLOWED_ORIGINS', 'http://localhost:3000,http://localhost:9099');
    return originsEnv.split(',').map(origin => origin.trim()).filter(origin => origin.length > 0);
  })(),

  // Environment
  nodeEnv: getEnvOrDefault('NODE_ENV', 'development'),
  logLevel: getEnvOrDefault('LOG_LEVEL', 'info')
};

// Validate critical configuration
if (config.maxFileSize > 10737418240) { // 10GB
  throw new Error('MAX_FILE_SIZE cannot exceed 10GB');
}

if (config.chunkSize < 4096 || config.chunkSize > 1048576) { // 4KB - 1MB
  throw new Error('CHUNK_SIZE must be between 4KB and 1MB');
}

if (config.bufferThresholdBytes < 1 || config.bufferThresholdBytes > config.maxFileSize) {
  throw new Error('BUFFER_THRESHOLD_MB must be between 1MB and MAX_FILE_SIZE');
}

// Validate Google Drive credentials if provided
if (config.googleServiceAccountEmail && !config.googleServiceAccountEmail.includes('@')) {
  throw new Error('GOOGLE_SERVICE_ACCOUNT_EMAIL must be a valid service account email if provided');
}

if (config.googleServiceAccountPrivateKey && config.googleServiceAccountPrivateKey.length < 100) {
  throw new Error('GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY must be a valid private key if provided (check .env file)');
}

// Validate Google Drive folder ID if credentials are provided
if (config.googleServiceAccountEmail && (!config.googleDriveFolderId || config.googleDriveFolderId.length < 10)) {
  throw new Error('GOOGLE_DRIVE_FOLDER_ID must be set (e.g., from Google Drive folder URL)');
}

// Validate CORS configuration
if (config.allowedOrigins.length === 0) {
  throw new Error('ALLOWED_ORIGINS must contain at least one origin');
}

// Validate origin format
for (const origin of config.allowedOrigins) {
  try {
    const url = new URL(origin);

    // In production, enforce HTTPS (except for localhost)
    if (config.nodeEnv === 'production') {
      if (url.protocol !== 'https:' && !url.hostname.includes('localhost') && url.hostname !== '127.0.0.1') {
        throw new Error(`Production origins must use HTTPS: ${origin}`);
      }
    }
  } catch (error) {
    if (error instanceof TypeError) {
      throw new Error(`Invalid origin URL format in ALLOWED_ORIGINS: ${origin}`);
    }
    throw error;
  }
}

// In production, fail-fast if CORS not properly configured
if (config.nodeEnv === 'production' && config.allowedOrigins.length === 0) {
  throw new Error('ALLOWED_ORIGINS must be explicitly configured in production (not using defaults)');
}

console.log('[FileProcessAgent] Configuration loaded:', {
  port: config.port,
  wsPort: config.wsPort,
  nodeEnv: config.nodeEnv,
  graphragUrl: config.graphragUrl,
  mageagentUrl: config.mageagentUrl,
  maxFileSize: `${(config.maxFileSize / 1073741824).toFixed(2)}GB`,
  chunkSize: `${(config.chunkSize / 1024).toFixed(0)}KB`,
  bufferThreshold: `${(config.bufferThresholdBytes / 1024 / 1024).toFixed(0)}MB`,
  googleDriveConfig: 'Configured (service account)',
  googleDriveFolderIdLength: `${config.googleDriveFolderId.length} chars`,
  allowedOrigins: config.allowedOrigins.join(', '),
  corsOriginsCount: config.allowedOrigins.length
});
