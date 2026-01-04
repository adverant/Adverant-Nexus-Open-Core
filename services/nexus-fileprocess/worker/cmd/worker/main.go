/**
 * FileProcessAgent Worker - Main Entry Point
 *
 * Go worker for document processing with Dockling-level accuracy.
 *
 * Architecture:
 * - BullMQ/Asynq consumer for Redis-backed job queue
 * - Document processing pipeline with 3-tier OCR cascade
 * - Dockling integration for 97.9% table and 99.2% layout accuracy
 * - VoyageAI embeddings for Document DNA semantic layer
 * - PostgreSQL persistence for processing results
 *
 * Performance Targets:
 * - Throughput: 1200+ files/hour per worker
 * - Latency: 2-15s typical, 5-30s for large files
 * - Memory: ~700MB per worker
 * - Cost: Average $0.04/document through tier optimization
 *
 * OCR Tier Cascade:
 * 1. Tesseract - 82% accuracy, free, fast (default)
 * 2. GPT-4 Vision - 93% accuracy, $0.01-0.03/page (complex tables/layouts)
 * 3. Claude-3 Opus - 97% accuracy, $0.05-0.10/page (highest quality needed)
 */

package main

import (
	"context"
	"fmt"
	"log"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/adverant/nexus/fileprocess-worker/internal/config"
	"github.com/adverant/nexus/fileprocess-worker/internal/processor"
	"github.com/adverant/nexus/fileprocess-worker/internal/queue"
	"github.com/adverant/nexus/fileprocess-worker/internal/storage"
	"github.com/joho/godotenv"
)

func main() {
	// Load environment variables
	if err := godotenv.Load(".env.nexus"); err != nil {
		log.Printf("Warning: .env.nexus not found, using system environment variables")
	}

	// Load configuration
	cfg, err := config.LoadConfig()
	if err != nil {
		log.Fatalf("Failed to load configuration: %v", err)
	}

	log.Printf("FileProcessAgent Worker starting...")
	log.Printf("Configuration loaded: Redis=%s, PostgreSQL=%s, Qdrant=%s, Workers=%d",
		cfg.RedisURL, cfg.DatabaseURL, cfg.QdrantURL, cfg.WorkerConcurrency)

	// Initialize unified storage manager (PostgreSQL + Qdrant)
	log.Printf("Connecting to storage (PostgreSQL + Qdrant)...")
	storageManager, err := storage.NewStorageManager(
		cfg.DatabaseURL,
		cfg.QdrantURL,
		cfg.QdrantCollection,
	)
	if err != nil {
		log.Fatalf("Failed to initialize storage manager: %v", err)
	}
	defer storageManager.Close()
	log.Printf("Storage manager initialized (PostgreSQL + Qdrant)")

	// Initialize document processor
	log.Printf("Initializing document processor with MageAgent integration...")
	proc, err := processor.NewDocumentProcessor(&processor.ProcessorConfig{
		VoyageAPIKey:      cfg.VoyageAPIKey,
		TesseractPath:     cfg.TesseractPath,
		TempDir:           cfg.TempDir,
		MaxFileSize:       cfg.MaxFileSize,
		StorageManager:    storageManager,
		GraphRAGURL:       cfg.GraphRAGURL,
		MageAgentURL:      cfg.MageAgentURL,       // Delegate OCR to MageAgent (zero hardcoded models)
		FileProcessAPIURL: cfg.FileProcessAPIURL,  // Artifact storage for permanent file access
	})
	if err != nil {
		log.Fatalf("Failed to initialize document processor: %v", err)
	}
	log.Printf("Document processor initialized (MageAgent-powered OCR)")

	// Initialize queue consumer
	log.Printf("Connecting to Redis queue...")
	queueConsumer, err := queue.NewRedisConsumer(&queue.RedisConsumerConfig{
		RedisURL:    cfg.RedisURL,
		QueueName:   "fileprocess:jobs",
		Concurrency: cfg.WorkerConcurrency,
		Processor:   proc,
	})
	if err != nil {
		log.Fatalf("Failed to initialize queue consumer: %v", err)
	}
	log.Printf("Queue consumer initialized with concurrency=%d", cfg.WorkerConcurrency)

	// Start queue consumer
	log.Printf("Starting queue consumer...")
	if err := queueConsumer.Start(); err != nil {
		log.Fatalf("Failed to start queue consumer: %v", err)
	}
	log.Printf("Queue consumer started successfully")

	// Print startup summary
	log.Printf("===========================================")
	log.Printf("FileProcessAgent Worker is READY")
	log.Printf("===========================================")
	log.Printf("Queue: fileprocess-jobs")
	log.Printf("Workers: %d", cfg.WorkerConcurrency)
	log.Printf("Throughput Target: 1200+ files/hour")
	log.Printf("Latency Target: 2-15s typical")
	log.Printf("Memory Usage: ~700MB per worker")
	log.Printf("OCR Tiers: Tesseract (82%%) → GPT-4 (93%%) → Claude (97%%)")
	log.Printf("Accuracy Targets: 97.9%% tables, 99.2%% layout")
	log.Printf("===========================================")
	log.Printf("Waiting for jobs...")

	// Setup graceful shutdown
	sigChan := make(chan os.Signal, 1)
	signal.Notify(sigChan, os.Interrupt, syscall.SIGTERM, syscall.SIGINT)

	// Wait for shutdown signal
	sig := <-sigChan
	log.Printf("Received signal %v, initiating graceful shutdown...", sig)

	// Stop queue consumer
	log.Printf("Stopping queue consumer...")
	if err := queueConsumer.Stop(); err != nil {
		log.Printf("Error stopping queue consumer: %v", err)
	} else {
		log.Printf("Queue consumer stopped successfully")
	}

	// Close storage manager
	log.Printf("Closing storage manager...")
	if err := storageManager.Close(); err != nil {
		log.Printf("Error closing storage manager: %v", err)
	} else {
		log.Printf("Storage manager closed")
	}

	log.Printf("Shutdown complete")
}

// Health check endpoint (optional - can be added via HTTP server)
func healthCheck(db *storage.PostgresClient) error {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	// Check database
	if err := db.Ping(ctx); err != nil {
		return fmt.Errorf("database health check failed: %w", err)
	}

	return nil
}
