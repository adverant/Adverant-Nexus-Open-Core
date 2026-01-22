// Functional test setup
import dotenv from 'dotenv';
import path from 'path';

// Load environment variables
dotenv.config({ path: path.join(__dirname, '../../.env.test') });

// Set longer timeout for functional tests
jest.setTimeout(120000); // 2 minutes

// Global test configuration
global.testConfig = {
  baseUrl: process.env.TEST_BASE_URL || 'https://graphrag.adverant.ai/mageagent',
  wsUrl: process.env.TEST_WS_URL || 'wss://graphrag.adverant.ai/mageagent/ws',
  verbose: process.env.TEST_VERBOSE === 'true',
  skipDestructiveTests: process.env.SKIP_DESTRUCTIVE_TESTS === 'true'
};

// Global error handler for unhandled promises
process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

// Clean up function
afterAll(async () => {
  // Close any open connections
  await new Promise(resolve => setTimeout(resolve, 1000));
});