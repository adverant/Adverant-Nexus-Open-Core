/**
 * HTTP Transport Client
 *
 * HTTP client for REST API communication with services
 */

import type {
  HTTPTransport,
  RequestOptions,
  TransportConfig,
  TransportError,
  RetryConfig,
} from '../../types/transport.js';

export class HTTPClient implements HTTPTransport {
  private baseUrl: string;
  private timeout: number;
  private headers: Record<string, string>;
  private retryConfig: RetryConfig;

  constructor(config: TransportConfig) {
    this.baseUrl = config.baseUrl;
    this.timeout = config.timeout || 30000;
    this.headers = {
      'Content-Type': 'application/json',
      ...config.headers,
    };

    if (config.auth) {
      this.setAuth(config.auth);
    }

    this.retryConfig = {
      maxAttempts: config.retries || 3,
      initialDelay: 1000,
      maxDelay: 10000,
      factor: 2,
      retryableErrors: ['ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND'],
    };
  }

  private setAuth(auth: TransportConfig['auth']): void {
    if (!auth) return;

    if (auth.type === 'api-key') {
      this.headers['X-API-Key'] = auth.credentials as string;
    } else if (auth.type === 'bearer') {
      this.headers['Authorization'] = `Bearer ${auth.credentials}`;
    } else if (auth.type === 'basic') {
      const creds = auth.credentials as Record<string, string>;
      const encoded = Buffer.from(`${creds.username}:${creds.password}`).toString('base64');
      this.headers['Authorization'] = `Basic ${encoded}`;
    }
  }

  async get<T = any>(path: string, options?: RequestOptions): Promise<T> {
    return this.request<T>('GET', path, undefined, options);
  }

  async post<T = any>(path: string, data?: any, options?: RequestOptions): Promise<T> {
    return this.request<T>('POST', path, data, options);
  }

  async put<T = any>(path: string, data?: any, options?: RequestOptions): Promise<T> {
    return this.request<T>('PUT', path, data, options);
  }

  async patch<T = any>(path: string, data?: any, options?: RequestOptions): Promise<T> {
    return this.request<T>('PATCH', path, data, options);
  }

  async delete<T = any>(path: string, options?: RequestOptions): Promise<T> {
    return this.request<T>('DELETE', path, undefined, options);
  }

  private async request<T>(
    method: string,
    path: string,
    data?: any,
    options?: RequestOptions
  ): Promise<T> {
    const url = this.buildUrl(path, options?.params);
    const requestOptions: RequestInit = {
      method,
      headers: {
        ...this.headers,
        ...options?.headers,
      },
      signal: options?.signal,
    };

    if (data) {
      requestOptions.body = JSON.stringify(data);
    }

    let lastError: TransportError | undefined;
    const maxAttempts = options?.retries ?? this.retryConfig.maxAttempts;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        const controller = new AbortController();
        const timeout = options?.timeout ?? this.timeout;
        const timeoutId = setTimeout(() => controller.abort(), timeout);

        const response = await fetch(url, {
          ...requestOptions,
          signal: controller.signal,
        });

        clearTimeout(timeoutId);

        if (!response.ok) {
          const error = await this.handleErrorResponse(response);
          if (!error.retryable || attempt === maxAttempts - 1) {
            throw error;
          }
          lastError = error;
        } else {
          const contentType = response.headers.get('content-type');
          if (contentType?.includes('application/json')) {
            return await response.json();
          }
          return (await response.text()) as T;
        }
      } catch (error: any) {
        if (error.name === 'AbortError') {
          const timeoutError: TransportError = {
            name: 'TransportError',
            message: 'Request timeout',
            code: 'ETIMEDOUT',
            retryable: true,
          };
          lastError = timeoutError;
        } else if (this.isRetryableError(error)) {
          lastError = error;
        } else {
          throw this.normalizeError(error);
        }
      }

      // Wait before retrying
      if (attempt < maxAttempts - 1) {
        const delay = Math.min(
          this.retryConfig.initialDelay * Math.pow(this.retryConfig.factor, attempt),
          this.retryConfig.maxDelay
        );
        await this.sleep(delay);
      }
    }

    throw lastError;
  }

  private buildUrl(path: string, params?: Record<string, any>): string {
    const url = new URL(path, this.baseUrl);
    if (params) {
      Object.entries(params).forEach(([key, value]) => {
        if (value !== undefined && value !== null) {
          url.searchParams.append(key, String(value));
        }
      });
    }
    return url.toString();
  }

  private async handleErrorResponse(response: Response): Promise<TransportError> {
    let details: any;
    try {
      const contentType = response.headers.get('content-type');
      if (contentType?.includes('application/json')) {
        details = await response.json();
      } else {
        details = await response.text();
      }
    } catch {
      details = response.statusText;
    }

    const error: TransportError = {
      name: 'TransportError',
      message: details?.message || `HTTP ${response.status}: ${response.statusText}`,
      code: `HTTP_${response.status}`,
      statusCode: response.status,
      details,
      retryable: response.status >= 500 || response.status === 429,
    };

    return error;
  }

  private isRetryableError(error: any): boolean {
    return (
      error.retryable === true ||
      this.retryConfig.retryableErrors?.includes(error.code) === true
    );
  }

  private normalizeError(error: any): TransportError {
    if (error.name === 'TransportError') {
      return error;
    }

    return {
      name: 'TransportError',
      message: error.message || 'Unknown error',
      code: error.code || 'UNKNOWN',
      details: error,
      retryable: false,
    };
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

export function createHTTPClient(config: TransportConfig): HTTPTransport {
  return new HTTPClient(config);
}
