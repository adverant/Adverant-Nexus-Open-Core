/**
 * PostgreSQL Client for FileProcessAgent Worker
 *
 * Handles database operations for job persistence and Document DNA storage.
 */

package storage

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"time"

	"github.com/lib/pq"
	_ "github.com/lib/pq"
)

// PostgresClient handles database operations
type PostgresClient struct {
	db *sql.DB
}

// JobUpdate represents a job status update
type JobUpdate struct {
	JobID             string
	Status            string
	Confidence        float64
	ProcessingTimeMs  int64
	DocumentDNAID     string
	ErrorCode         string
	ErrorMessage      string
	OCRTierUsed       string
	Metadata          map[string]interface{}
}

// DocumentDNA represents the document DNA structure
type DocumentDNA struct {
	ID                string
	JobID             string
	SemanticEmbedding []float32
	StructuralData    map[string]interface{}
	OriginalContent   []byte
}

// sanitizeConfidence rounds confidence to 4 decimal places to prevent PostgreSQL float precision errors
// PostgreSQL FLOAT type can represent values with excessive precision (e.g., 0.9632000000000001)
// which causes "invalid input syntax for type integer" errors when used in certain contexts.
// This function enforces bounded precision by rounding to 4 decimals and clamping to [0.0, 1.0].
func sanitizeConfidence(confidence float64) float64 {
	if confidence < 0.0 {
		return 0.0
	}
	if confidence > 1.0 {
		return 1.0
	}
	// Round to 4 decimal places (e.g., 0.9632000000000001 → 0.9632)
	// Formula: round(x * 10^n) / 10^n where n=4
	return float64(int(confidence*10000+0.5)) / 10000
}

// NewPostgresClient creates a new PostgreSQL client
func NewPostgresClient(databaseURL string) (*PostgresClient, error) {
	if databaseURL == "" {
		return nil, fmt.Errorf("database URL is required")
	}

	// Connect to database
	db, err := sql.Open("postgres", databaseURL)
	if err != nil {
		return nil, fmt.Errorf("failed to open database: %w", err)
	}

	// Configure connection pool
	db.SetMaxOpenConns(25)
	db.SetMaxIdleConns(5)
	db.SetConnMaxLifetime(5 * time.Minute)
	db.SetConnMaxIdleTime(2 * time.Minute)

	// Test connection
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	if err := db.PingContext(ctx); err != nil {
		return nil, fmt.Errorf("failed to ping database: %w", err)
	}

	return &PostgresClient{db: db}, nil
}

// UpdateJobStatus updates job status in the database
func (p *PostgresClient) UpdateJobStatus(ctx context.Context, update *JobUpdate) error {
	if update.JobID == "" {
		return fmt.Errorf("job ID is required")
	}

	if update.Status == "" {
		return fmt.Errorf("status is required")
	}

	// Sanitize confidence to prevent PostgreSQL precision errors
	// Root cause: Float64 representations like 0.9632000000000001 cause PostgreSQL casting errors
	sanitizedConfidence := sanitizeConfidence(update.Confidence)

	// Convert metadata to JSONB
	metadataJSON, err := json.Marshal(update.Metadata)
	if err != nil {
		return fmt.Errorf("failed to marshal metadata: %w", err)
	}

	// Build update query (use UPSERT to handle job creation on first status update)
	// This allows Worker to create job record if API didn't create it yet
	// IMPORTANT: Use fileprocess schema, not graphrag - matches storage_manager.go
	//
	// FIX: Use explicit NUMERIC(5,4) casting for confidence to prevent precision errors
	// Context: PostgreSQL FLOAT type can represent 0.9632000000000001 which causes
	// "invalid input syntax for type integer" errors when confidence is used in contexts
	// expecting bounded precision. NUMERIC(5,4) enforces 4 decimal places (0.9632).
	query := `
		INSERT INTO fileprocess.processing_jobs (
			id, user_id, filename, mime_type, file_size,
			status, confidence, processing_time_ms, document_dna_id,
			error_code, error_message, ocr_tier_used, metadata,
			created_at, updated_at
		) VALUES (
			$1::uuid, COALESCE($13, 'anonymous'), COALESCE($10, 'unknown.txt'),
			COALESCE($11, 'application/octet-stream'), COALESCE($12, 0),
			$2, NULLIF($3::NUMERIC(5,4), 0), NULLIF($4, 0),
			CASE WHEN $5 = '' THEN NULL ELSE $5::uuid END,
			NULLIF($6, ''), NULLIF($7, ''), NULLIF($8, ''),
			COALESCE($9::jsonb, '{}'::jsonb),
			NOW(), NOW()
		)
		ON CONFLICT (id) DO UPDATE SET
			status = EXCLUDED.status,
			confidence = COALESCE(NULLIF(EXCLUDED.confidence::NUMERIC(5,4), 0), fileprocess.processing_jobs.confidence),
			processing_time_ms = COALESCE(NULLIF(EXCLUDED.processing_time_ms, 0), fileprocess.processing_jobs.processing_time_ms),
			document_dna_id = CASE
				WHEN EXCLUDED.document_dna_id IS NOT NULL THEN EXCLUDED.document_dna_id
				ELSE fileprocess.processing_jobs.document_dna_id
			END,
			error_code = NULLIF(EXCLUDED.error_code, ''),
			error_message = NULLIF(EXCLUDED.error_message, ''),
			ocr_tier_used = NULLIF(EXCLUDED.ocr_tier_used, ''),
			metadata = COALESCE(EXCLUDED.metadata, fileprocess.processing_jobs.metadata),
			filename = COALESCE(EXCLUDED.filename, fileprocess.processing_jobs.filename),
			mime_type = COALESCE(EXCLUDED.mime_type, fileprocess.processing_jobs.mime_type),
			file_size = COALESCE(NULLIF(EXCLUDED.file_size, 0), fileprocess.processing_jobs.file_size),
			user_id = COALESCE(EXCLUDED.user_id, fileprocess.processing_jobs.user_id),
			updated_at = NOW()
		RETURNING id
	`

	// Extract additional fields from metadata if present
	var filename, mimeType, userId string
	var fileSize int64
	if update.Metadata != nil {
		if fn, ok := update.Metadata["filename"].(string); ok {
			filename = fn
		}
		if mt, ok := update.Metadata["mimeType"].(string); ok {
			mimeType = mt
		}
		if fs, ok := update.Metadata["fileSize"].(int64); ok {
			fileSize = fs
		} else if fs, ok := update.Metadata["fileSize"].(float64); ok {
			fileSize = int64(fs)
		}
		if uid, ok := update.Metadata["userId"].(string); ok {
			userId = uid
		}
	}

	var returnedID string
	err = p.db.QueryRowContext(
		ctx,
		query,
		update.JobID,           // $1 - job_id
		update.Status,          // $2 - status
		sanitizedConfidence,    // $3 - confidence (sanitized to 4 decimals)
		update.ProcessingTimeMs, // $4 - processing_time_ms
		update.DocumentDNAID,   // $5 - document_dna_id
		update.ErrorCode,       // $6 - error_code
		update.ErrorMessage,    // $7 - error_message
		update.OCRTierUsed,     // $8 - ocr_tier_used
		metadataJSON,           // $9 - metadata
		filename,               // $10 - filename
		mimeType,               // $11 - mime_type
		fileSize,               // $12 - file_size
		userId,                 // $13 - user_id
	).Scan(&returnedID)

	if err == sql.ErrNoRows {
		return fmt.Errorf("job not found: %s", update.JobID)
	}

	if err != nil {
		// Enhanced error message with context for debugging
		return fmt.Errorf("failed to update job status (job=%s, status=%s, confidence=%.4f): %w",
			update.JobID, update.Status, sanitizedConfidence, err)
	}

	return nil
}

// StoreDocumentDNA stores document DNA in the database
func (p *PostgresClient) StoreDocumentDNA(ctx context.Context, dna *DocumentDNA) (string, error) {
	if dna.JobID == "" {
		return "", fmt.Errorf("job ID is required")
	}

	if len(dna.SemanticEmbedding) == 0 {
		return "", fmt.Errorf("semantic embedding is required")
	}

	// Convert structural data to JSONB
	structuralJSON, err := json.Marshal(dna.StructuralData)
	if err != nil {
		return "", fmt.Errorf("failed to marshal structural data: %w", err)
	}

	// Insert document DNA
	query := `
		INSERT INTO fileprocess.document_dna (
			job_id,
			semantic_embedding,
			structural_data,
			original_content,
			created_at
		) VALUES ($1, $2, $3, $4, NOW())
		RETURNING id
	`

	var dnaID string
	err = p.db.QueryRowContext(
		ctx,
		query,
		dna.JobID,
		pq.Array(dna.SemanticEmbedding),
		structuralJSON,
		dna.OriginalContent,
	).Scan(&dnaID)

	if err != nil {
		return "", fmt.Errorf("failed to store document DNA: %w", err)
	}

	return dnaID, nil
}

// GetDocumentDNA retrieves document DNA by ID
func (p *PostgresClient) GetDocumentDNA(ctx context.Context, dnaID string) (*DocumentDNA, error) {
	if dnaID == "" {
		return nil, fmt.Errorf("DNA ID is required")
	}

	query := `
		SELECT
			id,
			job_id,
			semantic_embedding,
			structural_data,
			original_content
		FROM fileprocess.document_dna
		WHERE id = $1
	`

	var dna DocumentDNA
	var embeddingArray pq.Float32Array
	var structuralJSON []byte

	err := p.db.QueryRowContext(ctx, query, dnaID).Scan(
		&dna.ID,
		&dna.JobID,
		&embeddingArray,
		&structuralJSON,
		&dna.OriginalContent,
	)

	if err == sql.ErrNoRows {
		return nil, fmt.Errorf("document DNA not found: %s", dnaID)
	}

	if err != nil {
		return nil, fmt.Errorf("failed to get document DNA: %w", err)
	}

	// Convert embedding array
	dna.SemanticEmbedding = []float32(embeddingArray)

	// Unmarshal structural data
	if err := json.Unmarshal(structuralJSON, &dna.StructuralData); err != nil {
		return nil, fmt.Errorf("failed to unmarshal structural data: %w", err)
	}

	return &dna, nil
}

// GetJobByID retrieves a job by ID
func (p *PostgresClient) GetJobByID(ctx context.Context, jobID string) (map[string]interface{}, error) {
	if jobID == "" {
		return nil, fmt.Errorf("job ID is required")
	}

	query := `
		SELECT
			id,
			user_id,
			filename,
			mime_type,
			file_size,
			status,
			confidence,
			processing_time_ms,
			document_dna_id,
			error_code,
			error_message,
			ocr_tier_used,
			metadata,
			created_at,
			updated_at
		FROM fileprocess.processing_jobs
		WHERE id = $1::uuid
	`

	var (
		id, userID, filename                         string
		mimeType, status                             sql.NullString
		fileSize                                     sql.NullInt64
		confidence                                   sql.NullFloat64
		processingTimeMs                             sql.NullInt64
		documentDNAID, errorCode, errorMessage       sql.NullString
		ocrTierUsed                                  sql.NullString
		metadataJSON                                 []byte
		createdAt, updatedAt                         time.Time
	)

	err := p.db.QueryRowContext(ctx, query, jobID).Scan(
		&id, &userID, &filename, &mimeType, &fileSize, &status,
		&confidence, &processingTimeMs, &documentDNAID,
		&errorCode, &errorMessage, &ocrTierUsed,
		&metadataJSON, &createdAt, &updatedAt,
	)

	if err == sql.ErrNoRows {
		return nil, fmt.Errorf("job not found: %s", jobID)
	}

	if err != nil {
		return nil, fmt.Errorf("failed to get job: %w", err)
	}

	// Parse metadata
	var metadata map[string]interface{}
	if len(metadataJSON) > 0 {
		if err := json.Unmarshal(metadataJSON, &metadata); err != nil {
			return nil, fmt.Errorf("failed to unmarshal metadata: %w", err)
		}
	}

	// Build result map
	result := map[string]interface{}{
		"id":        id,
		"userId":    userID,
		"filename":  filename,
		"status":    status.String,
		"createdAt": createdAt,
		"updatedAt": updatedAt,
		"metadata":  metadata,
	}

	if mimeType.Valid {
		result["mimeType"] = mimeType.String
	}
	if fileSize.Valid {
		result["fileSize"] = fileSize.Int64
	}
	if confidence.Valid {
		result["confidence"] = confidence.Float64
	}
	if processingTimeMs.Valid {
		result["processingTimeMs"] = processingTimeMs.Int64
	}
	if documentDNAID.Valid {
		result["documentDnaId"] = documentDNAID.String
	}
	if errorCode.Valid {
		result["errorCode"] = errorCode.String
	}
	if errorMessage.Valid {
		result["errorMessage"] = errorMessage.String
	}
	if ocrTierUsed.Valid {
		result["ocrTierUsed"] = ocrTierUsed.String
	}

	return result, nil
}

// Ping checks database connectivity
func (p *PostgresClient) Ping(ctx context.Context) error {
	return p.db.PingContext(ctx)
}

// Close closes the database connection
func (p *PostgresClient) Close() error {
	if p.db != nil {
		return p.db.Close()
	}
	return nil
}

// GetStats returns connection pool statistics
func (p *PostgresClient) GetStats() sql.DBStats {
	return p.db.Stats()
}
