/**
 * GraphRAG Client for FileProcess Worker
 *
 * Stores extracted document content in GraphRAG for:
 * - Semantic chunking and embedding
 * - Vector search via unified_content collection
 * - Memory recall via /api/memory/recall
 *
 * This enables document search alongside episodic memories.
 */

package clients

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"time"
)

// GraphRAGClient handles communication with the GraphRAG service
type GraphRAGClient struct {
	baseURL    string
	httpClient *http.Client
}

// GraphRAGDocumentRequest represents a document storage request
type GraphRAGDocumentRequest struct {
	Content  string                 `json:"content"`
	Title    string                 `json:"title"`
	Metadata GraphRAGDocumentMeta   `json:"metadata,omitempty"`
}

// PageInfo represents page boundary information for multi-page documents
type PageInfo struct {
	PageNumber int `json:"pageNumber"` // 1-indexed page number
	StartChar  int `json:"startChar"`  // Character offset where page content starts
	EndChar    int `json:"endChar"`    // Character offset where page content ends
}

// GraphRAGDocumentMeta contains document metadata
type GraphRAGDocumentMeta struct {
	Source       string     `json:"source,omitempty"`
	Tags         []string   `json:"tags,omitempty"`
	Type         string     `json:"type,omitempty"` // "text", "code", "markdown", etc.
	FileSize     int64      `json:"fileSize,omitempty"`
	MimeType     string     `json:"mimeType,omitempty"`
	UploadedBy   string     `json:"uploadedBy,omitempty"`
	ProcessingID string     `json:"processingJobId,omitempty"`
	Pages        []PageInfo `json:"pages,omitempty"`    // Page boundaries for multi-page documents (PDFs)
	PageCount    int        `json:"pageCount,omitempty"` // Total number of pages

	// Artifact references for permanent file storage
	ArtifactID     string `json:"artifactId,omitempty"`     // UUID reference to fileprocess.artifacts table
	ArtifactURL    string `json:"artifactUrl,omitempty"`    // Permanent download URL (presigned or shareable link)
	StorageBackend string `json:"storageBackend,omitempty"` // Storage type: postgres_buffer, minio, google_drive
	DocumentDNAID  string `json:"documentDnaId,omitempty"`  // UUID reference to fileprocess.document_dna table
}

// GraphRAGDocumentResponse represents the response from storing a document
type GraphRAGDocumentResponse struct {
	Success    bool   `json:"success"`
	DocumentID string `json:"documentId,omitempty"`
	ChunkCount int    `json:"chunkCount,omitempty"`
	Message    string `json:"message,omitempty"`
	Error      string `json:"error,omitempty"`
}

// NewGraphRAGClient creates a new GraphRAG client
func NewGraphRAGClient(baseURL string) *GraphRAGClient {
	return &GraphRAGClient{
		baseURL: baseURL,
		httpClient: &http.Client{
			Timeout: 120 * time.Second, // Long timeout for large documents
		},
	}
}

// HealthCheck verifies GraphRAG service is available
func (c *GraphRAGClient) HealthCheck(ctx context.Context) error {
	req, err := http.NewRequestWithContext(ctx, "GET", c.baseURL+"/health", nil)
	if err != nil {
		return fmt.Errorf("failed to create health check request: %w", err)
	}

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return fmt.Errorf("GraphRAG health check failed: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("GraphRAG health check returned status %d", resp.StatusCode)
	}

	return nil
}

// StoreDocument stores extracted content in GraphRAG for chunking and search
func (c *GraphRAGClient) StoreDocument(ctx context.Context, req *GraphRAGDocumentRequest) (*GraphRAGDocumentResponse, error) {
	if req.Content == "" {
		return nil, fmt.Errorf("document content is required")
	}

	// Minimum content length for useful chunking
	if len(req.Content) < 100 {
		log.Printf("[GraphRAG] Content too short for chunking (%d chars), skipping storage", len(req.Content))
		return &GraphRAGDocumentResponse{
			Success: true,
			Message: "Content too short for chunking, skipped",
		}, nil
	}

	// Build request payload
	payload, err := json.Marshal(req)
	if err != nil {
		return nil, fmt.Errorf("failed to marshal document request: %w", err)
	}

	// Create HTTP request
	httpReq, err := http.NewRequestWithContext(ctx, "POST", c.baseURL+"/graphrag/api/documents", bytes.NewReader(payload))
	if err != nil {
		return nil, fmt.Errorf("failed to create store request: %w", err)
	}
	httpReq.Header.Set("Content-Type", "application/json")

	// Add tenant context headers (system-level for file processing)
	httpReq.Header.Set("X-Company-ID", "adverant")
	httpReq.Header.Set("X-App-ID", "fileprocess")
	httpReq.Header.Set("X-User-ID", "system")

	log.Printf("[GraphRAG] Storing document: title=%s, contentLength=%d", req.Title, len(req.Content))

	// Execute request
	resp, err := c.httpClient.Do(httpReq)
	if err != nil {
		return nil, fmt.Errorf("failed to store document in GraphRAG: %w", err)
	}
	defer resp.Body.Close()

	// Read response body
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, fmt.Errorf("failed to read GraphRAG response: %w", err)
	}

	// Check for error status
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, fmt.Errorf("GraphRAG returned error status %d: %s", resp.StatusCode, string(body))
	}

	// Parse response
	var result GraphRAGDocumentResponse
	if err := json.Unmarshal(body, &result); err != nil {
		// Non-fatal: document may still be stored successfully
		log.Printf("[GraphRAG] Warning: failed to parse response: %v", err)
		return &GraphRAGDocumentResponse{
			Success: true,
			Message: "Document stored (response parse warning)",
		}, nil
	}

	if result.Success {
		log.Printf("[GraphRAG] Document stored successfully: id=%s, chunks=%d", result.DocumentID, result.ChunkCount)
	} else {
		log.Printf("[GraphRAG] Document storage failed: %s", result.Error)
	}

	return &result, nil
}

// DetermineDocumentType maps MIME type to GraphRAG document type
func DetermineDocumentType(mimeType string) string {
	switch mimeType {
	case "application/pdf":
		return "text"
	case "text/plain":
		return "text"
	case "text/markdown":
		return "markdown"
	case "application/json":
		return "structured"
	case "text/html":
		return "text"
	default:
		// Check for code-related MIME types
		if isCodeMimeType(mimeType) {
			return "code"
		}
		return "text"
	}
}

// isCodeMimeType checks if the MIME type is a programming language
func isCodeMimeType(mimeType string) bool {
	codeMimeTypes := map[string]bool{
		"text/x-python":     true,
		"text/javascript":   true,
		"application/javascript": true,
		"text/x-java-source": true,
		"text/x-go":         true,
		"text/x-rust":       true,
		"text/x-c":          true,
		"text/x-c++":        true,
		"text/typescript":   true,
	}
	return codeMimeTypes[mimeType]
}
