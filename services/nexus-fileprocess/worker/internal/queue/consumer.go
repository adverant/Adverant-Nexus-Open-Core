/**
 * Queue Consumer for FileProcessAgent Worker
 *
 * Consumes jobs from BullMQ/Redis queue and processes documents.
 * Uses Asynq (Go BullMQ-compatible library) for queue management.
 */

package queue

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"time"

	"github.com/adverant/nexus/fileprocess-worker/internal/errors"
	"github.com/adverant/nexus/fileprocess-worker/internal/processor"
	"github.com/hibiken/asynq"
)

// JobData represents the structure of job data from BullMQ
type JobData struct {
	JobID      string                 `json:"jobId"`
	UserID     string                 `json:"userId"`
	Filename   string                 `json:"filename"`
	MimeType   string                 `json:"mimeType,omitempty"`
	FileSize   int64                  `json:"fileSize,omitempty"`
	FileURL    string                 `json:"fileUrl,omitempty"`
	FileBuffer []byte                 `json:"fileBuffer,omitempty"`
	Metadata   map[string]interface{} `json:"metadata,omitempty"`
}

// Consumer handles job consumption from Redis queue
type Consumer struct {
	client    *asynq.Client
	server    *asynq.Server
	mux       *asynq.ServeMux
	processor processor.DocumentProcessorInterface
	config    *ConsumerConfig
}

// ConsumerConfig holds consumer configuration
type ConsumerConfig struct {
	RedisURL          string
	QueueName         string
	Concurrency       int
	Processor         processor.DocumentProcessorInterface
	ProcessingTimeout int64 // Processing timeout in milliseconds (default: 300000 = 5 minutes)
}

// NewConsumer creates a new queue consumer
func NewConsumer(cfg *ConsumerConfig) (*Consumer, error) {
	if cfg.RedisURL == "" {
		return nil, fmt.Errorf("RedisURL is required")
	}

	if cfg.QueueName == "" {
		return nil, fmt.Errorf("QueueName is required")
	}

	if cfg.Processor == nil {
		return nil, fmt.Errorf("Processor is required")
	}

	// Parse Redis connection options
	redisOpt, err := asynq.ParseRedisURI(cfg.RedisURL)
	if err != nil {
		return nil, fmt.Errorf("failed to parse Redis URL: %w", err)
	}

	// Create Asynq client for task submission (if needed)
	client := asynq.NewClient(redisOpt)

	// Create Asynq server for task processing
	server := asynq.NewServer(
		redisOpt,
		asynq.Config{
			Concurrency: cfg.Concurrency,
			Queues: map[string]int{
				cfg.QueueName: 10, // Priority 10 for main queue
				"default":     1,  // Priority 1 for fallback
			},
			// Retry configuration
			RetryDelayFunc: func(n int, err error, task *asynq.Task) time.Duration {
				// Exponential backoff: 5s, 10s, 20s
				delay := time.Duration(5*(1<<uint(n))) * time.Second
				if delay > 60*time.Second {
					delay = 60 * time.Second
				}
				return delay
			},
			// Error handling
			ErrorHandler: asynq.ErrorHandlerFunc(func(ctx context.Context, task *asynq.Task, err error) {
				log.Printf("Task processing error: type=%s, payload=%s, error=%v",
					task.Type(), string(task.Payload()), err)
			}),
			// Logging - asynq provides a default logger if not specified
			// The standard log package doesn't implement asynq.Logger interface
			// Logger is optional and asynq will use its own internal logger if not provided
		},
	)

	// Create multiplexer for task routing
	mux := asynq.NewServeMux()

	consumer := &Consumer{
		client:    client,
		server:    server,
		mux:       mux,
		processor: cfg.Processor,
		config:    cfg,
	}

	// Register task handler
	mux.HandleFunc("process-document", consumer.handleProcessDocument)

	return consumer, nil
}

// Start starts the queue consumer
func (c *Consumer) Start(ctx context.Context) error {
	log.Printf("Starting queue consumer (concurrency=%d, queue=%s)...",
		c.config.Concurrency, c.config.QueueName)

	// Start server in a goroutine
	go func() {
		if err := c.server.Run(c.mux); err != nil {
			log.Printf("Queue consumer error: %v", err)
		}
	}()

	return nil
}

// Stop stops the queue consumer gracefully
func (c *Consumer) Stop(ctx context.Context) error {
	log.Printf("Stopping queue consumer...")

	// Shutdown server gracefully
	c.server.Shutdown()

	// Close client
	if err := c.client.Close(); err != nil {
		return fmt.Errorf("failed to close client: %w", err)
	}

	log.Printf("Queue consumer stopped")
	return nil
}

// handleProcessDocument processes a document processing job
func (c *Consumer) handleProcessDocument(ctx context.Context, task *asynq.Task) error {
	startTime := time.Now()

	// Parse job data
	var jobData JobData
	if err := json.Unmarshal(task.Payload(), &jobData); err != nil {
		return fmt.Errorf("failed to unmarshal job data: %w", err)
	}

	log.Printf("[Job %s] Processing document: filename=%s, size=%d bytes, user=%s",
		jobData.JobID, jobData.Filename, jobData.FileSize, jobData.UserID)

	// Update job status to processing
	if err := c.processor.UpdateJobStatus(ctx, jobData.JobID, "processing", 0, nil); err != nil {
		log.Printf("[Job %s] Warning: Failed to update status to processing: %v", jobData.JobID, err)
	}

	// =========================================================================
	// CRITICAL FIX: Create timeout context to prevent 30-60 second hangs
	// =========================================================================
	// Default timeout: 5 minutes (300000ms)
	// Configurable via ConsumerConfig.ProcessingTimeout
	// =========================================================================
	timeout := time.Duration(300000) * time.Millisecond
	if c.config.ProcessingTimeout > 0 {
		timeout = time.Duration(c.config.ProcessingTimeout) * time.Millisecond
	}

	log.Printf("[Job %s] Processing timeout set to: %v", jobData.JobID, timeout)

	// Create timeout context
	processCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()

	// Process document with timeout
	result, err := c.processor.ProcessDocument(processCtx, &processor.ProcessRequest{
		JobID:      jobData.JobID,
		UserID:     jobData.UserID,
		Filename:   jobData.Filename,
		MimeType:   jobData.MimeType,
		FileSize:   jobData.FileSize,
		FileURL:    jobData.FileURL,
		FileBuffer: jobData.FileBuffer,
		Metadata:   jobData.Metadata,
	})

	duration := time.Since(startTime)

	if err != nil {
		// Check if error was due to timeout
		if processCtx.Err() == context.DeadlineExceeded {
			log.Printf("[Job %s] Processing timed out after %v (timeout: %v)", jobData.JobID, duration, timeout)

			// Create structured timeout error
			timeoutErr := errors.NewProcessingTimeoutError(jobData.JobID, timeout, err)
			errorMap := timeoutErr.ToMap()

			// Update job status to failed with timeout error
			if updateErr := c.processor.UpdateJobStatus(ctx, jobData.JobID, "failed", 100, errorMap); updateErr != nil {
				log.Printf("[Job %s] Warning: Failed to update status to failed: %v", jobData.JobID, updateErr)
			}

			return fmt.Errorf("processing timeout: %w", timeoutErr)
		}

		log.Printf("[Job %s] Processing failed after %v: %v", jobData.JobID, duration, err)

		// Update job status to failed
		if updateErr := c.processor.UpdateJobStatus(ctx, jobData.JobID, "failed", 100, map[string]interface{}{
			"error":           err.Error(),
			"processingTime": duration.Milliseconds(),
		}); updateErr != nil {
			log.Printf("[Job %s] Warning: Failed to update status to failed: %v", jobData.JobID, updateErr)
		}

		return fmt.Errorf("document processing failed: %w", err)
	}

	log.Printf("[Job %s] Processing completed successfully in %v: confidence=%.2f, tier=%s, dnaId=%s",
		jobData.JobID, duration, result.Confidence, result.OCRTierUsed, result.DocumentDNAID)

	// Update job status to completed
	if err := c.processor.UpdateJobStatus(ctx, jobData.JobID, "completed", 100, map[string]interface{}{
		"confidence":         result.Confidence,
		"processingTime":     duration.Milliseconds(),
		"documentDnaId":      result.DocumentDNAID,
		"ocrTierUsed":        result.OCRTierUsed,
		"tablesExtracted":    result.TablesExtracted,
		"regionsExtracted":   result.RegionsExtracted,
		"embeddingGenerated": result.EmbeddingGenerated,
	}); err != nil {
		log.Printf("[Job %s] Warning: Failed to update status to completed: %v", jobData.JobID, err)
	}

	return nil
}

// GetStatistics returns consumer statistics
func (c *Consumer) GetStatistics() map[string]interface{} {
	return map[string]interface{}{
		"concurrency": c.config.Concurrency,
		"queue":       c.config.QueueName,
		"redisURL":    c.config.RedisURL,
	}
}
