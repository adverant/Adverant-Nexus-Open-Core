/**
 * Configuration for FileProcessAgent Worker
 *
 * Loads configuration from environment variables matching .env.nexus
 */

package config

import (
	"fmt"
	"os"
	"strconv"
)

// Config holds worker configuration
type Config struct {
	// Redis configuration
	RedisURL string

	// PostgreSQL configuration
	DatabaseURL string

	// Qdrant vector database configuration
	QdrantURL        string
	QdrantCollection string

	// API Keys
	VoyageAPIKey     string
	OpenRouterAPIKey string
	GoogleClientID   string
	GoogleClientSecret string

	// Service URLs
	GraphRAGURL       string
	MageAgentURL      string
	LearningAgentURL  string
	SandboxURL        string
	FileProcessAPIURL string // FileProcess API for artifact storage

	// Worker configuration
	WorkerConcurrency int
	MaxFileSize       int64
	ChunkSize         int64
	ProcessingTimeout int

	// Tesseract configuration
	TesseractPath string

	// Temporary directory for file processing
	TempDir string

	// Node environment
	NodeEnv string
}

// LoadConfig loads configuration from environment variables
func LoadConfig() (*Config, error) {
	cfg := &Config{
		RedisURL:           getEnvOrDefault("REDIS_URL", "redis://nexus-redis:6379"),
		DatabaseURL:        getEnvOrThrow("DATABASE_URL"),
		QdrantURL:          getEnvOrDefault("QDRANT_URL", "nexus-qdrant:6334"),
		QdrantCollection:   getEnvOrDefault("QDRANT_COLLECTION", "fileprocess_documents"),
		VoyageAPIKey:       getEnvOrThrow("VOYAGE_API_KEY"),
		OpenRouterAPIKey:   getEnvOrThrow("OPENROUTER_API_KEY"),
		GoogleClientID:     getEnvOrDefault("GOOGLE_CLIENT_ID", ""),
		GoogleClientSecret: getEnvOrDefault("GOOGLE_CLIENT_SECRET", ""),
		GraphRAGURL:        getEnvOrDefault("GRAPHRAG_URL", "http://nexus-graphrag:8090"),
		MageAgentURL:       getEnvOrDefault("MAGEAGENT_URL", "http://nexus-mageagent:8080/api/internal/orchestrate"),
		LearningAgentURL:   getEnvOrDefault("LEARNINGAGENT_URL", "http://nexus-learningagent:8091"),
		SandboxURL:         getEnvOrDefault("SANDBOX_URL", "http://nexus-sandbox:8092"),
		FileProcessAPIURL:  getEnvOrDefault("FILEPROCESS_API_URL", "http://nexus-fileprocess-api:8096"),
		WorkerConcurrency:  getEnvAsIntOrDefault("WORKER_CONCURRENCY", 10),
		MaxFileSize:        getEnvAsInt64OrDefault("MAX_FILE_SIZE", 5368709120),  // 5GB
		ChunkSize:          getEnvAsInt64OrDefault("CHUNK_SIZE", 65536),          // 64KB
		ProcessingTimeout:  getEnvAsIntOrDefault("PROCESSING_TIMEOUT", 300000),    // 5 minutes
		TesseractPath:      getEnvOrDefault("TESSERACT_PATH", "/usr/bin/tesseract"),
		TempDir:            getEnvOrDefault("TEMP_DIR", "/tmp/fileprocess"),
		NodeEnv:            getEnvOrDefault("NODE_ENV", "development"),
	}

	// Validate required fields
	if err := cfg.Validate(); err != nil {
		return nil, fmt.Errorf("configuration validation failed: %w", err)
	}

	return cfg, nil
}

// Validate checks if configuration is valid
func (c *Config) Validate() error {
	if c.RedisURL == "" {
		return fmt.Errorf("REDIS_URL is required")
	}

	if c.DatabaseURL == "" {
		return fmt.Errorf("DATABASE_URL is required")
	}

	if c.VoyageAPIKey == "" {
		return fmt.Errorf("VOYAGE_API_KEY is required")
	}

	if c.OpenRouterAPIKey == "" {
		return fmt.Errorf("OPENROUTER_API_KEY is required")
	}

	if c.WorkerConcurrency < 1 || c.WorkerConcurrency > 100 {
		return fmt.Errorf("WORKER_CONCURRENCY must be between 1 and 100, got %d", c.WorkerConcurrency)
	}

	if c.MaxFileSize < 1024 || c.MaxFileSize > 10737418240 { // 1KB to 10GB
		return fmt.Errorf("MAX_FILE_SIZE must be between 1KB and 10GB, got %d", c.MaxFileSize)
	}

	if c.ChunkSize < 1024 || c.ChunkSize > 1048576 { // 1KB to 1MB
		return fmt.Errorf("CHUNK_SIZE must be between 1KB and 1MB, got %d", c.ChunkSize)
	}

	return nil
}

// getEnvOrDefault gets environment variable or returns default
func getEnvOrDefault(key, defaultValue string) string {
	if value := os.Getenv(key); value != "" {
		return value
	}
	return defaultValue
}

// getEnvOrThrow gets environment variable or returns error
func getEnvOrThrow(key string) string {
	value := os.Getenv(key)
	if value == "" {
		panic(fmt.Sprintf("Required environment variable %s is not set", key))
	}
	return value
}

// getEnvAsIntOrDefault gets environment variable as int or returns default
func getEnvAsIntOrDefault(key string, defaultValue int) int {
	valueStr := os.Getenv(key)
	if valueStr == "" {
		return defaultValue
	}

	value, err := strconv.Atoi(valueStr)
	if err != nil {
		return defaultValue
	}

	return value
}

// getEnvAsInt64OrDefault gets environment variable as int64 or returns default
func getEnvAsInt64OrDefault(key string, defaultValue int64) int64 {
	valueStr := os.Getenv(key)
	if valueStr == "" {
		return defaultValue
	}

	value, err := strconv.ParseInt(valueStr, 10, 64)
	if err != nil {
		return defaultValue
	}

	return value
}
