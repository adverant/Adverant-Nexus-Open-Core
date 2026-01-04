/**
 * Storage Manager for FileProcessAgent Worker
 *
 * Coordinates storage operations across PostgreSQL (metadata) and Qdrant (vectors).
 * Implements atomic operations to ensure data consistency across both systems.
 */

package storage

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"regexp"
	"time"

	"github.com/google/uuid"
)

// StorageManager coordinates PostgreSQL and Qdrant operations
type StorageManager struct {
	postgres *PostgresClient
	qdrant   *QdrantClient
}

// DocumentDNAInput represents input for storing document DNA
type DocumentDNAInput struct {
	JobID             string
	SemanticEmbedding []float32
	StructuralData    map[string]interface{}
	OriginalContent   []byte
}

// DocumentDNAOutput represents stored document DNA with all IDs
type DocumentDNAOutput struct {
	ID            string
	JobID         string
	QdrantPointID string
	StructuralData map[string]interface{}
	CreatedAt     time.Time
}

// NewStorageManager creates a new storage manager
func NewStorageManager(postgresURL string, qdrantAddress string, qdrantCollection string) (*StorageManager, error) {
	// Initialize PostgreSQL client
	postgres, err := NewPostgresClient(postgresURL)
	if err != nil {
		return nil, fmt.Errorf("failed to initialize PostgreSQL client: %w", err)
	}

	// Initialize Qdrant client
	qdrant, err := NewQdrantClient(qdrantAddress, qdrantCollection)
	if err != nil {
		postgres.Close() // Cleanup on failure
		return nil, fmt.Errorf("failed to initialize Qdrant client: %w", err)
	}

	return &StorageManager{
		postgres: postgres,
		qdrant:   qdrant,
	}, nil
}

// StoreDocumentDNA atomically stores document DNA across PostgreSQL and Qdrant
func (sm *StorageManager) StoreDocumentDNA(ctx context.Context, input *DocumentDNAInput) (*DocumentDNAOutput, error) {
	if input == nil {
		return nil, fmt.Errorf("input is required")
	}

	if input.JobID == "" {
		return nil, fmt.Errorf("job ID is required")
	}

	if len(input.SemanticEmbedding) != 1024 {
		return nil, fmt.Errorf("invalid embedding dimensions: expected 1024, got %d", len(input.SemanticEmbedding))
	}

	// Step 1: Generate UUIDs for both systems
	dnaID := uuid.New().String()
	qdrantPointID := uuid.New().String()

	// Step 2: Store vector in Qdrant first (fails fast if vector invalid)
	qdrantPoint := &VectorPoint{
		ID:     qdrantPointID,
		Vector: input.SemanticEmbedding,
		Metadata: map[string]interface{}{
			"job_id":     input.JobID,
			"dna_id":     dnaID,
			"created_at": time.Now().Unix(),
		},
		Timestamp: time.Now().Unix(),
	}

	if err := sm.qdrant.UpsertVector(ctx, qdrantPoint); err != nil {
		return nil, fmt.Errorf("failed to store vector in Qdrant: %w", err)
	}

	// Step 3: Store metadata in PostgreSQL
	// Convert StructuralData to JSONB
	structuralJSON, err := json.Marshal(input.StructuralData)
	if err != nil {
		// Rollback: Delete Qdrant point
		sm.qdrant.DeleteVector(ctx, qdrantPointID)
		return nil, fmt.Errorf("failed to marshal structural data: %w", err)
	}

	// Sanitize JSON to remove problematic Unicode escape sequences that PostgreSQL rejects
	// PostgreSQL JSONB doesn't support certain Unicode escape sequences like \u0000
	structuralJSON = sanitizeJSONForPostgres(structuralJSON)

	// Insert into PostgreSQL
	query := `
		INSERT INTO fileprocess.document_dna (
			id,
			job_id,
			qdrant_point_id,
			structural_data,
			original_content,
			embedding_dimensions,
			created_at
		) VALUES ($1, $2, $3, $4, $5, $6, NOW())
		RETURNING created_at
	`

	var createdAt time.Time
	err = sm.postgres.db.QueryRowContext(
		ctx,
		query,
		dnaID,
		input.JobID,
		qdrantPointID,
		structuralJSON,
		input.OriginalContent,
		1024,
	).Scan(&createdAt)

	if err != nil {
		// Rollback: Delete Qdrant point
		sm.qdrant.DeleteVector(ctx, qdrantPointID)
		return nil, fmt.Errorf("failed to store metadata in PostgreSQL: %w", err)
	}

	// Return successful result
	return &DocumentDNAOutput{
		ID:             dnaID,
		JobID:          input.JobID,
		QdrantPointID:  qdrantPointID,
		StructuralData: input.StructuralData,
		CreatedAt:      createdAt,
	}, nil
}

// GetDocumentDNA retrieves document DNA with vector from both systems
func (sm *StorageManager) GetDocumentDNA(ctx context.Context, dnaID string) (*DocumentDNAFull, error) {
	if dnaID == "" {
		return nil, fmt.Errorf("DNA ID is required")
	}

	// Step 1: Get metadata from PostgreSQL
	query := `
		SELECT
			id,
			job_id,
			qdrant_point_id,
			structural_data,
			original_content,
			embedding_dimensions,
			created_at
		FROM fileprocess.document_dna
		WHERE id = $1
	`

	var (
		id, jobID, qdrantPointID string
		structuralJSON           []byte
		originalContent          []byte
		embeddingDims            int
		createdAt                time.Time
	)

	err := sm.postgres.db.QueryRowContext(ctx, query, dnaID).Scan(
		&id, &jobID, &qdrantPointID, &structuralJSON, &originalContent, &embeddingDims, &createdAt,
	)

	if err == sql.ErrNoRows {
		return nil, fmt.Errorf("document DNA not found: %s", dnaID)
	}

	if err != nil {
		return nil, fmt.Errorf("failed to get document DNA metadata: %w", err)
	}

	// Step 2: Parse structural data
	var structuralData map[string]interface{}
	if err := json.Unmarshal(structuralJSON, &structuralData); err != nil {
		return nil, fmt.Errorf("failed to unmarshal structural data: %w", err)
	}

	// Step 3: Get vector from Qdrant
	qdrantPoint, err := sm.qdrant.GetVector(ctx, qdrantPointID)
	if err != nil {
		return nil, fmt.Errorf("failed to get vector from Qdrant: %w", err)
	}

	// Return full document DNA
	return &DocumentDNAFull{
		ID:                id,
		JobID:             jobID,
		QdrantPointID:     qdrantPointID,
		SemanticEmbedding: qdrantPoint.Vector,
		StructuralData:    structuralData,
		OriginalContent:   originalContent,
		EmbeddingDims:     embeddingDims,
		CreatedAt:         createdAt,
	}, nil
}

// SearchSimilarDocuments performs semantic search across documents
func (sm *StorageManager) SearchSimilarDocuments(ctx context.Context, queryVector []float32, limit int) ([]*DocumentDNASearchResult, error) {
	if len(queryVector) != 1024 {
		return nil, fmt.Errorf("invalid query vector dimensions: expected 1024, got %d", len(queryVector))
	}

	// Search Qdrant for similar vectors
	points, err := sm.qdrant.SearchVectors(ctx, queryVector, limit)
	if err != nil {
		return nil, fmt.Errorf("failed to search vectors: %w", err)
	}

	// Retrieve metadata from PostgreSQL for each result
	results := make([]*DocumentDNASearchResult, 0, len(points))
	for _, point := range points {
		// Extract DNA ID from Qdrant metadata
		dnaIDRaw, ok := point.Metadata["dna_id"]
		if !ok {
			continue
		}

		dnaID, ok := dnaIDRaw.(string)
		if !ok {
			continue
		}

		// Get full metadata from PostgreSQL
		query := `
			SELECT job_id, structural_data, created_at
			FROM fileprocess.document_dna
			WHERE id = $1
		`

		var (
			jobID          string
			structuralJSON []byte
			createdAt      time.Time
		)

		err := sm.postgres.db.QueryRowContext(ctx, query, dnaID).Scan(&jobID, &structuralJSON, &createdAt)
		if err != nil {
			continue // Skip if metadata not found
		}

		var structuralData map[string]interface{}
		json.Unmarshal(structuralJSON, &structuralData)

		// Extract similarity score
		score := 0.0
		if scoreRaw, ok := point.Metadata["score"]; ok {
			if scoreFloat, ok := scoreRaw.(float64); ok {
				score = scoreFloat
			}
		}

		results = append(results, &DocumentDNASearchResult{
			DNAID:          dnaID,
			JobID:          jobID,
			QdrantPointID:  point.ID,
			StructuralData: structuralData,
			SimilarityScore: score,
			CreatedAt:      createdAt,
		})
	}

	return results, nil
}

// UpdateJobStatus updates job status in PostgreSQL
func (sm *StorageManager) UpdateJobStatus(ctx context.Context, update *JobUpdate) error {
	return sm.postgres.UpdateJobStatus(ctx, update)
}

// GetJobByID retrieves job by ID
func (sm *StorageManager) GetJobByID(ctx context.Context, jobID string) (map[string]interface{}, error) {
	return sm.postgres.GetJobByID(ctx, jobID)
}

// GetStats returns statistics from both systems
func (sm *StorageManager) GetStats(ctx context.Context) (map[string]interface{}, error) {
	// PostgreSQL stats
	pgStats := sm.postgres.GetStats()

	// Qdrant stats
	qdrantStats, err := sm.qdrant.GetCollectionInfo(ctx)
	if err != nil {
		return nil, fmt.Errorf("failed to get Qdrant stats: %w", err)
	}

	return map[string]interface{}{
		"postgres": map[string]interface{}{
			"max_open_connections": pgStats.MaxOpenConnections,
			"open_connections":     pgStats.OpenConnections,
			"in_use":               pgStats.InUse,
			"idle":                 pgStats.Idle,
			"wait_count":           pgStats.WaitCount,
			"wait_duration":        pgStats.WaitDuration.String(),
		},
		"qdrant": qdrantStats,
	}, nil
}

// Close closes all connections
func (sm *StorageManager) Close() error {
	var pgErr, qdErr error

	if sm.postgres != nil {
		pgErr = sm.postgres.Close()
	}

	if sm.qdrant != nil {
		qdErr = sm.qdrant.Close()
	}

	if pgErr != nil {
		return fmt.Errorf("failed to close PostgreSQL: %w", pgErr)
	}

	if qdErr != nil {
		return fmt.Errorf("failed to close Qdrant: %w", qdErr)
	}

	return nil
}

// DocumentDNAFull represents complete document DNA with vector
type DocumentDNAFull struct {
	ID                string
	JobID             string
	QdrantPointID     string
	SemanticEmbedding []float32
	StructuralData    map[string]interface{}
	OriginalContent   []byte
	EmbeddingDims     int
	CreatedAt         time.Time
}

// DocumentDNASearchResult represents search result with similarity score
type DocumentDNASearchResult struct {
	DNAID           string
	JobID           string
	QdrantPointID   string
	StructuralData  map[string]interface{}
	SimilarityScore float64
	CreatedAt       time.Time
}

// sanitizeJSONForPostgres removes problematic Unicode escape sequences from JSON
// PostgreSQL JSONB doesn't support certain Unicode escape sequences like \u0000 (null character)
// and some other control characters. This function removes or replaces them.
func sanitizeJSONForPostgres(jsonBytes []byte) []byte {
	// Pattern to match problematic Unicode escapes:
	// - \u0000 (null character) - completely invalid in PostgreSQL
	// - \u0001-\u001F (control characters) - can cause issues
	// We replace them with empty string or a safe placeholder

	// Remove null character escapes (\u0000)
	nullPattern := regexp.MustCompile(`\\u0000`)
	result := nullPattern.ReplaceAll(jsonBytes, []byte{})

	// Replace other control character escapes (\u0001-\u001F) with space
	// These are less common but can still cause issues
	controlPattern := regexp.MustCompile(`\\u00[01][0-9a-fA-F]`)
	result = controlPattern.ReplaceAll(result, []byte(" "))

	return result
}
