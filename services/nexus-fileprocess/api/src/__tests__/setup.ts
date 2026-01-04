/**
 * Jest test setup
 * Sets up mock environment variables for testing
 */

// Mock environment variables
process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = 'postgresql://test:test@localhost:5432/test';
process.env.REDIS_URL = 'redis://localhost:6379';
process.env.MINIO_ENDPOINT = 'localhost';
process.env.MINIO_PORT = '9000';
process.env.MINIO_ACCESS_KEY = 'test';
process.env.MINIO_SECRET_KEY = 'test';
process.env.MINIO_BUCKET = 'test';
process.env.MINIO_USE_SSL = 'false';
process.env.MAGEAGENT_URL = 'http://localhost:8080';
process.env.SANDBOX_URL = 'http://localhost:8090';
process.env.GRAPHRAG_URL = 'http://localhost:8091';
process.env.VOYAGEAI_API_KEY = 'test-key';
process.env.PORT = '9109';
process.env.WS_PORT = '9110';
process.env.MAX_FILE_SIZE = '5368709120';
process.env.CHUNK_SIZE = '65536';
process.env.BUFFER_THRESHOLD = '10485760';
process.env.ALLOWED_ORIGINS = 'http://localhost:3000';

// Mock logger to reduce noise in tests
jest.mock('../utils/logger', () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));
