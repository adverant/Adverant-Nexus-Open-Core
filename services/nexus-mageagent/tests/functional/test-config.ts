export interface FunctionalTestConfig {
  // Service endpoints
  baseUrl: string;
  wsUrl: string;

  // Test configuration
  testTimeouts: {
    default: number;
    websocket: number;
    performance: number;
    rateLimiting: number;
  };

  // Performance test settings
  performanceTests: {
    requestsPerEndpoint: number;
    delayBetweenRequests: number;
    acceptableResponseTime: {
      p95: number;
      p99: number;
    };
  };

  // Rate limiting test settings
  rateLimitTests: {
    burstSize: number;
    waitForReset: number;
  };

  // WebSocket test settings
  websocketTests: {
    reconnectAttempts: number;
    reconnectDelay: number;
    messageTimeout: number;
  };

  // Security test settings
  securityTests: {
    enableDestructiveTests: boolean;
    testAuthBypass: boolean;
    testInjectionAttacks: boolean;
  };
}

export const defaultConfig: FunctionalTestConfig = {
  baseUrl: 'https://graphrag.adverant.ai/mageagent',
  wsUrl: 'wss://graphrag.adverant.ai/mageagent/ws',

  testTimeouts: {
    default: 30000,      // 30 seconds
    websocket: 15000,    // 15 seconds
    performance: 60000,  // 60 seconds
    rateLimiting: 120000 // 120 seconds
  },

  performanceTests: {
    requestsPerEndpoint: 50,
    delayBetweenRequests: 100, // 100ms
    acceptableResponseTime: {
      p95: 2000, // 2 seconds
      p99: 5000  // 5 seconds
    }
  },

  rateLimitTests: {
    burstSize: 20,
    waitForReset: 5000 // 5 seconds
  },

  websocketTests: {
    reconnectAttempts: 3,
    reconnectDelay: 1000,  // 1 second
    messageTimeout: 10000  // 10 seconds
  },

  securityTests: {
    enableDestructiveTests: false,
    testAuthBypass: true,
    testInjectionAttacks: true
  }
};

// Environment-specific overrides
export function getTestConfig(): FunctionalTestConfig {
  const env = process.env.TEST_ENV || 'production';

  switch (env) {
    case 'development':
      return {
        ...defaultConfig,
        baseUrl: process.env.DEV_BASE_URL || 'http://localhost:3000',
        wsUrl: process.env.DEV_WS_URL || 'ws://localhost:3000/ws',
        performanceTests: {
          ...defaultConfig.performanceTests,
          requestsPerEndpoint: 10 // Fewer requests in dev
        }
      };

    case 'staging':
      return {
        ...defaultConfig,
        baseUrl: process.env.STAGING_BASE_URL || 'https://staging.graphrag.adverant.ai/mageagent',
        wsUrl: process.env.STAGING_WS_URL || 'wss://staging.graphrag.adverant.ai/mageagent/ws'
      };

    case 'production':
    default:
      return defaultConfig;
  }
}