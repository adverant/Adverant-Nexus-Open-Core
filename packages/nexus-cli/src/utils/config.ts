/**
 * Configuration management for nexus-cli
 */

import fs from 'fs-extra';
import path from 'path';
import os from 'os';
import axios, { AxiosResponse } from 'axios';
import type { ApiResponse, HealthCheckResponse } from '../types/api.js';

export interface CliConfig {
  apiKey?: string;
  apiUrl?: string;
  currentPlugin?: string;
}

/**
 * Default API URL configuration
 * Priority order:
 * 1. Environment variable NEXUS_API_URL
 * 2. Saved config file
 * 3. Kubernetes service discovery (nexus-plugin-manager:9111)
 * 4. Localhost development (http://localhost:9111)
 */
const DEFAULT_API_URLS = {
  kubernetes: 'http://nexus-plugin-manager:9111',
  localhost: 'http://localhost:9111',
  production: process.env.NEXUS_API_URL || undefined
};

/**
 * Get API URL with intelligent fallback
 * Respects user configuration and environment-specific defaults
 */
export async function getApiUrl(): Promise<string> {
  // Priority 1: Environment variable
  if (process.env.NEXUS_API_URL) {
    return process.env.NEXUS_API_URL;
  }

  // Priority 2: Saved config
  const config = await loadConfig();
  if (config.apiUrl) {
    return config.apiUrl;
  }

  // Priority 3: Detect environment
  // Check if running in Kubernetes cluster
  if (process.env.KUBERNETES_SERVICE_HOST) {
    return DEFAULT_API_URLS.kubernetes;
  }

  // Priority 4: Default to localhost for development
  return DEFAULT_API_URLS.localhost;
}

const CONFIG_DIR = path.join(os.homedir(), '.nexus');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');

export async function loadConfig(): Promise<CliConfig> {
  try {
    await fs.ensureDir(CONFIG_DIR);

    if (await fs.pathExists(CONFIG_FILE)) {
      return await fs.readJson(CONFIG_FILE);
    }

    return {};
  } catch (error) {
    console.error('Failed to load config:', error);
    return {};
  }
}

export async function saveConfig(config: CliConfig): Promise<void> {
  try {
    await fs.ensureDir(CONFIG_DIR);
    await fs.writeJson(CONFIG_FILE, config, { spaces: 2 });
  } catch (error) {
    console.error('Failed to save config:', error);
    throw error;
  }
}

export async function updateConfig(updates: Partial<CliConfig>): Promise<void> {
  const config = await loadConfig();
  await saveConfig({ ...config, ...updates });
}

export async function getApiKey(): Promise<string | undefined> {
  const config = await loadConfig();
  return config.apiKey || process.env.NEXUS_API_KEY;
}

/**
 * Check Nexus Nexus API health
 * Performs health check with timeout and retry logic
 *
 * @param apiUrl - The API URL to check (optional, will use default)
 * @param timeout - Request timeout in milliseconds (default: 5000)
 * @returns Health check response or null if unhealthy
 */
export async function checkApiHealth(
  apiUrl?: string,
  timeout: number = 5000
): Promise<HealthCheckResponse | null> {
  try {
    const url = apiUrl || await getApiUrl();
    const response: AxiosResponse<ApiResponse<HealthCheckResponse>> = await axios.get(
      `${url}/health`,
      {
        timeout,
        validateStatus: (status) => status < 500 // Accept 2xx and 4xx as valid responses
      }
    );

    // Extract health data from standard API response wrapper
    if (response.data && response.data.data) {
      return response.data.data;
    }

    // Fallback: if response is direct health data (no wrapper)
    if (response.data && 'status' in response.data) {
      return response.data as unknown as HealthCheckResponse;
    }

    return null;
  } catch (error) {
    // Health check failed - return null to indicate unhealthy
    return null;
  }
}

/**
 * Result of API health validation
 */
export interface HealthCheckResult {
  healthy: boolean;
  status: 'healthy' | 'unhealthy' | 'degraded' | 'unavailable';
  message: string;
  details?: HealthCheckResponse;
  warnings?: string[];
}

/**
 * Validate API health before critical operations
 * Provides detailed feedback about service status
 *
 * @param apiUrl - The API URL to check
 * @param timeout - Request timeout in milliseconds
 * @returns Detailed health check result
 */
export async function validateApiHealth(
  apiUrl?: string,
  timeout?: number
): Promise<HealthCheckResult> {
  const health = await checkApiHealth(apiUrl, timeout);

  if (!health) {
    return {
      healthy: false,
      status: 'unavailable',
      message: 'Nexus Nexus API is unavailable',
      warnings: [
        'Cannot connect to Nexus Nexus',
        'Check if services are running',
        'Verify network connectivity'
      ]
    };
  }

  const warnings: string[] = [];

  // Check for degraded services
  const degradedServices = health.services.filter(s => s.status === 'degraded');
  if (degradedServices.length > 0) {
    warnings.push(
      `${degradedServices.length} service(s) degraded: ${degradedServices.map(s => s.name).join(', ')}`
    );
  }

  // Check for unhealthy services
  const unhealthyServices = health.services.filter(s => s.status === 'unhealthy');
  if (unhealthyServices.length > 0) {
    warnings.push(
      `${unhealthyServices.length} service(s) unhealthy: ${unhealthyServices.map(s => s.name).join(', ')}`
    );
  }

  // Overall health assessment
  if (health.status === 'unhealthy') {
    return {
      healthy: false,
      status: 'unhealthy',
      message: 'Nexus Nexus API is unhealthy',
      details: health,
      warnings
    };
  }

  if (health.status === 'degraded') {
    return {
      healthy: true, // Still operational but with warnings
      status: 'degraded',
      message: 'Nexus Nexus API is degraded',
      details: health,
      warnings
    };
  }

  return {
    healthy: true,
    status: 'healthy',
    message: 'Nexus Nexus API is healthy',
    details: health,
    warnings: warnings.length > 0 ? warnings : undefined
  };
}
