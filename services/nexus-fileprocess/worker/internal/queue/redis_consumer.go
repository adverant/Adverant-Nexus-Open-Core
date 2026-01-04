/**
 * Direct Redis Queue Consumer for FileProcessAgent Worker
 *
 * Compatible with TypeScript RedisQueue implementation.
 * Uses simple Redis LIST operations for perfect compatibility.
 */

package queue

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"log"
	"sync"
	"time"

	"github.com/adverant/nexus/fileprocess-worker/internal/errors"
	"github.com/adverant/nexus/fileprocess-worker/internal/processor"
	"github.com/redis/go-redis/v9"
)

// RedisJobData represents a job from the Redis queue
type RedisJobData struct {
	ID        string                 `json:"id"`
	Type      string                 `json:"type"`
	Payload   JobPayload             `json:"payload"`
	CreatedAt time.Time              `json:"createdAt"`
	Attempts  int                    `json:"attempts"`
	MaxRetries int                   `json:"maxRetries"`
}

// JobPayload contains the actual job data
type JobPayload struct {
	JobID      string                 `json:"jobId"`
	UserID     string                 `json:"userId"`
	Filename   string                 `json:"filename"`
	MimeType   string                 `json:"mimeType,omitempty"`
	FileSize   int64                  `json:"fileSize,omitempty"`
	FileURL    string                 `json:"fileUrl,omitempty"`
	FileBuffer []byte                 // Will be set by custom UnmarshalJSON
	Metadata   map[string]interface{} `json:"metadata,omitempty"`
}

// UnmarshalJSON implements custom JSON unmarshaling for JobPayload to handle Buffer serialization
// Supports both base64 string format (new) and Node.js Buffer object format (legacy)
func (p *JobPayload) UnmarshalJSON(data []byte) error {
	// Create alias type to avoid recursion
	type Alias JobPayload
	aux := &struct {
		FileBuffer interface{} `json:"fileBuffer,omitempty"`
		*Alias
	}{
		Alias: (*Alias)(p),
	}

	// Unmarshal with alias
	if err := json.Unmarshal(data, &aux); err != nil {
		return fmt.Errorf("failed to unmarshal JobPayload: %w", err)
	}

	// Handle fileBuffer field with multiple format support
	if aux.FileBuffer != nil {
		switch v := aux.FileBuffer.(type) {
		case string:
			// Base64 string format (new format from TypeScript)
			decoded, err := base64.StdEncoding.DecodeString(v)
			if err != nil {
				return fmt.Errorf("failed to decode base64 fileBuffer: %w", err)
			}
			p.FileBuffer = decoded

		case map[string]interface{}:
			// Node.js Buffer object format (legacy compatibility)
			if bufferType, ok := v["type"].(string); ok && bufferType == "Buffer" {
				if dataArray, ok := v["data"].([]interface{}); ok {
					p.FileBuffer = make([]byte, len(dataArray))
					for i, val := range dataArray {
						if byteVal, ok := val.(float64); ok {
							p.FileBuffer[i] = byte(byteVal)
						} else {
							return fmt.Errorf("invalid byte value in Buffer data array at index %d", i)
						}
					}
				} else {
					return fmt.Errorf("Buffer object missing 'data' array")
				}
			} else {
				return fmt.Errorf("invalid Buffer object format (missing or incorrect 'type' field)")
			}

		default:
			return fmt.Errorf("fileBuffer must be either base64 string or Buffer object, got %T", v)
		}
	}

	return nil
}

// RedisConsumer handles job consumption from Redis queue
type RedisConsumer struct {
	client      *redis.Client
	processor   processor.DocumentProcessorInterface
	config      *RedisConsumerConfig
	ctx         context.Context
	cancel      context.CancelFunc
	wg          sync.WaitGroup
}

// RedisConsumerConfig holds consumer configuration
type RedisConsumerConfig struct {
	RedisURL          string
	QueueName         string
	Concurrency       int
	Processor         processor.DocumentProcessorInterface
	ProcessingTimeout int64 // Processing timeout in milliseconds (default: 300000 = 5 minutes)
}

// NewRedisConsumer creates a new Redis-based queue consumer
func NewRedisConsumer(cfg *RedisConsumerConfig) (*RedisConsumer, error) {
	if cfg.RedisURL == "" {
		return nil, fmt.Errorf("RedisURL is required")
	}

	if cfg.QueueName == "" {
		cfg.QueueName = "fileprocess:jobs"
	}

	if cfg.Processor == nil {
		return nil, fmt.Errorf("Processor is required")
	}

	if cfg.Concurrency <= 0 {
		cfg.Concurrency = 10
	}

	// Parse Redis URL
	opt, err := redis.ParseURL(cfg.RedisURL)
	if err != nil {
		return nil, fmt.Errorf("failed to parse Redis URL: %w", err)
	}

	// Create Redis client
	client := redis.NewClient(opt)

	// Test connection
	ctx := context.Background()
	if err := client.Ping(ctx).Err(); err != nil {
		return nil, fmt.Errorf("failed to connect to Redis: %w", err)
	}

	consumerCtx, cancel := context.WithCancel(context.Background())

	return &RedisConsumer{
		client:    client,
		processor: cfg.Processor,
		config:    cfg,
		ctx:       consumerCtx,
		cancel:    cancel,
	}, nil
}

// Start begins processing jobs from the queue
func (c *RedisConsumer) Start() error {
	log.Printf("Starting Redis queue consumer (concurrency=%d, queue=%s)...",
		c.config.Concurrency, c.config.QueueName)

	// Start worker goroutines
	for i := 0; i < c.config.Concurrency; i++ {
		c.wg.Add(1)
		go c.worker(i)
	}

	log.Println("Queue consumer started successfully")
	return nil
}

// Stop gracefully stops the consumer
func (c *RedisConsumer) Stop() error {
	log.Println("Stopping queue consumer...")
	c.cancel()
	c.wg.Wait()
	return c.client.Close()
}

// worker is a goroutine that processes jobs
func (c *RedisConsumer) worker(id int) {
	defer c.wg.Done()
	log.Printf("Worker %d started", id)

	for {
		select {
		case <-c.ctx.Done():
			log.Printf("Worker %d stopping", id)
			return
		default:
			// Try to get a job from the queue
			if err := c.processNextJob(); err != nil {
				if err.Error() != "no jobs available" {
					log.Printf("Worker %d error: %v", id, err)
				}
				// Small delay before trying again
				time.Sleep(1 * time.Second)
			}
		}
	}
}

// processNextJob fetches and processes the next job from the queue
func (c *RedisConsumer) processNextJob() error {
	// Block for up to 5 seconds waiting for a job
	result, err := c.client.BRPop(c.ctx, 5*time.Second, c.config.QueueName).Result()
	if err != nil {
		if err == redis.Nil {
			return fmt.Errorf("no jobs available")
		}
		return fmt.Errorf("failed to fetch job: %w", err)
	}

	if len(result) < 2 {
		return fmt.Errorf("invalid job result")
	}

	jobID := result[1]

	// Get job data
	jobData, err := c.client.HGet(c.ctx, fmt.Sprintf("%s:data", c.config.QueueName), jobID).Result()
	if err != nil {
		return fmt.Errorf("failed to get job data: %w", err)
	}

	var job RedisJobData
	if err := json.Unmarshal([]byte(jobData), &job); err != nil {
		return fmt.Errorf("failed to unmarshal job: %w", err)
	}

	// Create/update job record in PostgreSQL (ensures job exists in database)
	// This is idempotent - if job already exists, it will update status to processing
	if err := c.processor.UpdateJobStatus(c.ctx, job.Payload.JobID, "processing", 0, map[string]interface{}{
		"filename": job.Payload.Filename,
		"mimeType": job.Payload.MimeType,
		"fileSize": job.Payload.FileSize,
		"userId":   job.Payload.UserID,
	}); err != nil {
		// Job record might not exist yet - this is OK, we'll create it on first update
		log.Printf("Note: Could not update job status to processing (job may not exist in DB yet): %v", err)
	}

	// Update job status to processing in Redis
	c.updateJobStatus(job.Payload.JobID, "processing", nil)

	// Process the job
	log.Printf("Processing job %s: %s", job.Payload.JobID, job.Payload.Filename)

	processResult, err := c.processJob(&job)
	if err != nil {
		log.Printf("Job %s failed: %v", job.Payload.JobID, err)

		// Handle retry logic
		job.Attempts++
		if job.Attempts < job.MaxRetries {
			// Re-queue for retry
			updatedData, _ := json.Marshal(job)
			c.client.HSet(c.ctx, fmt.Sprintf("%s:data", c.config.QueueName), job.ID, updatedData)
			c.client.LPush(c.ctx, c.config.QueueName, job.ID)
			log.Printf("Job %s re-queued for retry (attempt %d/%d)", job.Payload.JobID, job.Attempts, job.MaxRetries)
		} else {
			// Mark as failed
			c.updateJobStatus(job.Payload.JobID, "failed", map[string]interface{}{
				"error": err.Error(),
				"attempts": job.Attempts,
			})
		}
	} else {
		// Mark as completed
		c.updateJobStatus(job.Payload.JobID, "completed", processResult)
		log.Printf("Job %s completed successfully", job.Payload.JobID)
	}

	return nil
}

// processJob handles the actual document processing
func (c *RedisConsumer) processJob(job *RedisJobData) (interface{}, error) {
	startTime := time.Now()

	// Convert to processor format
	request := &processor.ProcessRequest{
		JobID:      job.Payload.JobID,
		UserID:     job.Payload.UserID,
		Filename:   job.Payload.Filename,
		MimeType:   job.Payload.MimeType,
		FileSize:   job.Payload.FileSize,
		FileURL:    job.Payload.FileURL,
		FileBuffer: job.Payload.FileBuffer,
		Metadata:   job.Payload.Metadata,
	}

	// =========================================================================
	// CRITICAL FIX: Create timeout context to prevent 30-60 second hangs
	// =========================================================================
	// Default timeout: 5 minutes (300000ms)
	// Configurable via RedisConsumerConfig.ProcessingTimeout
	// =========================================================================
	timeout := time.Duration(300000) * time.Millisecond
	if c.config.ProcessingTimeout > 0 {
		timeout = time.Duration(c.config.ProcessingTimeout) * time.Millisecond
	}

	log.Printf("[Job %s] Processing timeout set to: %v", job.Payload.JobID, timeout)

	// Create timeout context
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()

	// Process document with timeout
	result, err := c.processor.ProcessDocument(ctx, request)

	duration := time.Since(startTime)

	if err != nil {
		// Check if error was due to timeout
		if ctx.Err() == context.DeadlineExceeded {
			log.Printf("[Job %s] Processing timed out after %v (timeout: %v)", job.Payload.JobID, duration, timeout)

			// Create structured timeout error
			timeoutErr := errors.NewProcessingTimeoutError(job.Payload.JobID, timeout, err)
			errorMap := timeoutErr.ToMap()

			// Update job status to failed with timeout error
			if updateErr := c.processor.UpdateJobStatus(c.ctx, job.Payload.JobID, "failed", 100, errorMap); updateErr != nil {
				log.Printf("[Job %s] Warning: Failed to update status to failed: %v", job.Payload.JobID, updateErr)
			}

			return nil, fmt.Errorf("processing timeout: %w", timeoutErr)
		}

		return nil, err
	}

	log.Printf("[Job %s] Processing completed in %v", job.Payload.JobID, duration)
	return result, nil
}

// updateJobStatus updates the status of a job in both Redis AND PostgreSQL
func (c *RedisConsumer) updateJobStatus(jobID string, status string, result interface{}) {
	// Update Redis for queue management
	if status == "processing" {
		c.client.SAdd(c.ctx, fmt.Sprintf("%s:processing", c.config.QueueName), jobID)
	} else if status == "completed" {
		c.client.SRem(c.ctx, fmt.Sprintf("%s:processing", c.config.QueueName), jobID)
		c.client.SAdd(c.ctx, fmt.Sprintf("%s:completed", c.config.QueueName), jobID)
		if result != nil {
			resultData, _ := json.Marshal(result)
			c.client.HSet(c.ctx, fmt.Sprintf("%s:results", c.config.QueueName), jobID, resultData)
		}
	} else if status == "failed" {
		c.client.SRem(c.ctx, fmt.Sprintf("%s:processing", c.config.QueueName), jobID)
		c.client.SAdd(c.ctx, fmt.Sprintf("%s:failed", c.config.QueueName), jobID)
		if result != nil {
			errorData, _ := json.Marshal(result)
			c.client.HSet(c.ctx, fmt.Sprintf("%s:errors", c.config.QueueName), jobID, errorData)
		}
	}

	// Update PostgreSQL for persistent job tracking
	if status == "completed" {
		// Convert processor.ProcessResult to storage update
		if processResult, ok := result.(*processor.ProcessResult); ok {
			log.Printf("[PostgreSQL] Updating job %s to completed with full details", jobID)
			if err := c.processor.UpdateJobStatus(c.ctx, jobID, status, 100, map[string]interface{}{
				"confidence":      processResult.Confidence,
				"processingTime":  processResult.ProcessingTimeMs,
				"documentDnaId":   processResult.DocumentDNAID,
				"ocrTierUsed":     processResult.OCRTierUsed,
				"embeddingGenerated": processResult.EmbeddingGenerated,
				"tablesExtracted": processResult.TablesExtracted,
				"regionsExtracted": processResult.RegionsExtracted,
			}); err != nil {
				log.Printf("[PostgreSQL] ERROR: Failed to update job status: %v", err)
			} else {
				log.Printf("[PostgreSQL] ✓ Job %s updated successfully (confidence=%.2f, tier=%s, dnaId=%s)",
					jobID, processResult.Confidence, processResult.OCRTierUsed, processResult.DocumentDNAID)
			}
		} else {
			// Fallback: Type assertion failed, but still try to mark as completed
			log.Printf("[PostgreSQL] WARNING: ProcessResult type assertion failed. Marking as completed without details.")
			if err := c.processor.UpdateJobStatus(c.ctx, jobID, status, 100, nil); err != nil {
				log.Printf("[PostgreSQL] ERROR: Failed to update job status (fallback): %v", err)
			}
		}
	} else if status == "failed" {
		// Extract error message from result
		errorMsg := "Unknown error"
		if resultMap, ok := result.(map[string]interface{}); ok {
			if errStr, ok := resultMap["error"].(string); ok {
				errorMsg = errStr
			}
		}

		if err := c.processor.UpdateJobStatus(c.ctx, jobID, status, 0, map[string]interface{}{
			"error": errorMsg,
		}); err != nil {
			log.Printf("WARNING: Failed to update PostgreSQL job status for failed job: %v", err)
		}
	} else if status == "processing" {
		// Mark job as processing in PostgreSQL
		if err := c.processor.UpdateJobStatus(c.ctx, jobID, status, 0, nil); err != nil {
			log.Printf("WARNING: Failed to update PostgreSQL job status to processing: %v", err)
		}
	}

	// Publish event for WebSocket streaming
	event := map[string]interface{}{
		"event":     fmt.Sprintf("job:%s", status),
		"jobId":     jobID,
		"timestamp": time.Now().Format(time.RFC3339),
	}
	eventData, _ := json.Marshal(event)
	c.client.Publish(c.ctx, fmt.Sprintf("%s:events", c.config.QueueName), eventData)
}

// GetStats returns queue statistics
func (c *RedisConsumer) GetStats() (map[string]int64, error) {
	ctx := context.Background()

	waiting, _ := c.client.LLen(ctx, c.config.QueueName).Result()
	processing, _ := c.client.SCard(ctx, fmt.Sprintf("%s:processing", c.config.QueueName)).Result()
	completed, _ := c.client.SCard(ctx, fmt.Sprintf("%s:completed", c.config.QueueName)).Result()
	failed, _ := c.client.SCard(ctx, fmt.Sprintf("%s:failed", c.config.QueueName)).Result()

	return map[string]int64{
		"waiting":    waiting,
		"processing": processing,
		"completed":  completed,
		"failed":     failed,
	}, nil
}