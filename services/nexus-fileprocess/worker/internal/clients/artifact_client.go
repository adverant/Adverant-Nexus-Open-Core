/**
 * Artifact Client for FileProcess Worker
 *
 * Uploads original document files to permanent storage via the FileProcess API.
 * Storage backends:
 * - PostgreSQL buffer: Files <10MB (fast retrieval)
 * - MinIO: Files 10MB-5GB (object storage with presigned URLs)
 * - Google Drive: Optional permanent storage with shareable links
 *
 * Storage Flow:
 * 1. Worker downloads file from source (Google Drive, URL, upload)
 * 2. Worker calls FileProcess API /api/files/upload endpoint
 * 3. API stores file in appropriate backend based on size
 * 4. API returns artifact ID and download URL
 * 5. Worker stores artifact ID/URL in GraphRAG document metadata
 *
 * This enables:
 * - Permanent storage of original PDFs/documents
 * - Page-specific viewing URLs (e.g., "view page 53 of this PDF")
 * - Document recall with source file access
 */

package clients

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"mime/multipart"
	"net/http"
	"time"
)

// ArtifactClient handles communication with the FileProcess API for artifact storage
type ArtifactClient struct {
	baseURL    string
	httpClient *http.Client
}

// ArtifactUploadRequest represents a file upload request
type ArtifactUploadRequest struct {
	FileBuffer    []byte                 // File content
	Filename      string                 // Original filename
	MimeType      string                 // MIME type (e.g., application/pdf)
	SourceService string                 // Service creating the artifact (e.g., "fileprocess-worker")
	SourceID      string                 // Source identifier (e.g., job_id)
	TTLDays       int                    // Time-to-live in days (0 = use 36500 for ~100 years)
	Metadata      map[string]interface{} // Additional metadata (documentDnaId, ocrTier, etc.)
}

// ArtifactUploadResponse represents the response from uploading an artifact
type ArtifactUploadResponse struct {
	Success  bool   `json:"success"`
	Artifact struct {
		ID             string `json:"id"`
		Filename       string `json:"filename"`
		FileSize       int64  `json:"file_size"`
		MimeType       string `json:"mime_type"`
		StorageBackend string `json:"storage_backend"` // postgres_buffer, minio, google_drive
		DownloadURL    string `json:"download_url"`    // Presigned URL or shareable link
		CreatedAt      string `json:"created_at"`
		ExpiresAt      string `json:"expires_at,omitempty"`
	} `json:"artifact,omitempty"`
	Error   string `json:"error,omitempty"`
	Message string `json:"message,omitempty"`
}

// NewArtifactClient creates a new artifact client
func NewArtifactClient(baseURL string) *ArtifactClient {
	return &ArtifactClient{
		baseURL: baseURL,
		httpClient: &http.Client{
			Timeout: 300 * time.Second, // 5 minutes for large file uploads
		},
	}
}

// HealthCheck verifies the FileProcess API is available
func (c *ArtifactClient) HealthCheck(ctx context.Context) error {
	req, err := http.NewRequestWithContext(ctx, "GET", c.baseURL+"/health", nil)
	if err != nil {
		return fmt.Errorf("failed to create health check request: %w", err)
	}

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return fmt.Errorf("artifact service health check failed: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("artifact service health check returned status %d: %s", resp.StatusCode, string(body))
	}

	return nil
}

// UploadArtifact uploads a file to permanent storage
// Returns the artifact ID and shareable download URL
func (c *ArtifactClient) UploadArtifact(ctx context.Context, req *ArtifactUploadRequest) (*ArtifactUploadResponse, error) {
	if len(req.FileBuffer) == 0 {
		return nil, fmt.Errorf("file buffer is required: received empty buffer")
	}

	if req.Filename == "" {
		return nil, fmt.Errorf("filename is required: received empty string")
	}

	if req.SourceService == "" {
		return nil, fmt.Errorf("source_service is required: identifies the service creating this artifact")
	}

	if req.SourceID == "" {
		return nil, fmt.Errorf("source_id is required: identifies the job/execution creating this artifact")
	}

	log.Printf("[ArtifactClient] Uploading artifact: filename=%s, size=%d bytes, mimeType=%s, sourceId=%s",
		req.Filename, len(req.FileBuffer), req.MimeType, req.SourceID)

	// Create multipart form request
	var body bytes.Buffer
	writer := multipart.NewWriter(&body)

	// Add file part
	part, err := writer.CreateFormFile("file", req.Filename)
	if err != nil {
		return nil, fmt.Errorf("failed to create form file part: %w", err)
	}
	bytesWritten, err := part.Write(req.FileBuffer)
	if err != nil {
		return nil, fmt.Errorf("failed to write file data to form: %w", err)
	}
	if bytesWritten != len(req.FileBuffer) {
		return nil, fmt.Errorf("incomplete file write: expected %d bytes, wrote %d bytes", len(req.FileBuffer), bytesWritten)
	}

	// Add source_service field
	if err := writer.WriteField("source_service", req.SourceService); err != nil {
		return nil, fmt.Errorf("failed to write source_service field: %w", err)
	}

	// Add source_id field
	if err := writer.WriteField("source_id", req.SourceID); err != nil {
		return nil, fmt.Errorf("failed to write source_id field: %w", err)
	}

	// Add ttl_days field
	// Use 36500 (100 years) for permanent storage when TTLDays is 0 or negative
	ttlDays := req.TTLDays
	if ttlDays <= 0 {
		ttlDays = 36500 // ~100 years for "permanent" storage
	}
	if err := writer.WriteField("ttl_days", fmt.Sprintf("%d", ttlDays)); err != nil {
		return nil, fmt.Errorf("failed to write ttl_days field: %w", err)
	}

	// Add metadata if present
	if req.Metadata != nil && len(req.Metadata) > 0 {
		metadataJSON, err := json.Marshal(req.Metadata)
		if err != nil {
			return nil, fmt.Errorf("failed to marshal metadata to JSON: %w", err)
		}
		if err := writer.WriteField("metadata", string(metadataJSON)); err != nil {
			return nil, fmt.Errorf("failed to write metadata field: %w", err)
		}
	}

	// Close multipart writer to finalize the form
	if err := writer.Close(); err != nil {
		return nil, fmt.Errorf("failed to close multipart writer: %w", err)
	}

	// Create HTTP request
	// FileProcess API mounts routes at /fileprocess/api/*, so full path is /fileprocess/api/files/upload
	httpReq, err := http.NewRequestWithContext(ctx, "POST", c.baseURL+"/fileprocess/api/files/upload", &body)
	if err != nil {
		return nil, fmt.Errorf("failed to create HTTP request: %w", err)
	}
	httpReq.Header.Set("Content-Type", writer.FormDataContentType())

	// Execute request with timing
	startTime := time.Now()
	resp, err := c.httpClient.Do(httpReq)
	if err != nil {
		return nil, fmt.Errorf("HTTP request to artifact storage failed after %v: %w", time.Since(startTime), err)
	}
	defer resp.Body.Close()

	// Read response body
	respBody, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, fmt.Errorf("failed to read response body: %w", err)
	}

	// Check for error status codes
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, fmt.Errorf("artifact upload failed with HTTP %d: %s", resp.StatusCode, string(respBody))
	}

	// Parse response
	var result ArtifactUploadResponse
	if err := json.Unmarshal(respBody, &result); err != nil {
		return nil, fmt.Errorf("failed to parse artifact upload response: %w (raw response: %s)", err, string(respBody))
	}

	// Validate response
	if !result.Success {
		return nil, fmt.Errorf("artifact upload returned success=false: %s", result.Error)
	}

	if result.Artifact.ID == "" {
		return nil, fmt.Errorf("artifact upload succeeded but returned empty artifact ID")
	}

	uploadDuration := time.Since(startTime)
	uploadSpeedMBps := float64(len(req.FileBuffer)) / 1024 / 1024 / uploadDuration.Seconds()

	log.Printf("[ArtifactClient] Artifact uploaded successfully: id=%s, storage=%s, url=%s, duration=%v, speed=%.2f MB/s",
		result.Artifact.ID, result.Artifact.StorageBackend, result.Artifact.DownloadURL, uploadDuration, uploadSpeedMBps)

	return &result, nil
}

// GetArtifactByID retrieves artifact metadata by ID
func (c *ArtifactClient) GetArtifactByID(ctx context.Context, artifactID string) (*ArtifactUploadResponse, error) {
	if artifactID == "" {
		return nil, fmt.Errorf("artifact ID is required")
	}

	req, err := http.NewRequestWithContext(ctx, "GET", c.baseURL+"/fileprocess/api/files/"+artifactID, nil)
	if err != nil {
		return nil, fmt.Errorf("failed to create get artifact request: %w", err)
	}

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("failed to get artifact: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode == http.StatusNotFound {
		return nil, fmt.Errorf("artifact not found: %s", artifactID)
	}

	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		return nil, fmt.Errorf("get artifact returned HTTP %d: %s", resp.StatusCode, string(body))
	}

	var result ArtifactUploadResponse
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		return nil, fmt.Errorf("failed to parse artifact response: %w", err)
	}

	return &result, nil
}

// GetArtifactsBySourceID retrieves all artifacts for a given source (e.g., job_id)
func (c *ArtifactClient) GetArtifactsBySourceID(ctx context.Context, sourceService, sourceID string) ([]ArtifactUploadResponse, error) {
	if sourceService == "" || sourceID == "" {
		return nil, fmt.Errorf("source_service and source_id are required")
	}

	url := fmt.Sprintf("%s/fileprocess/api/files/source/%s/%s", c.baseURL, sourceService, sourceID)
	req, err := http.NewRequestWithContext(ctx, "GET", url, nil)
	if err != nil {
		return nil, fmt.Errorf("failed to create list artifacts request: %w", err)
	}

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("failed to list artifacts: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		return nil, fmt.Errorf("list artifacts returned HTTP %d: %s", resp.StatusCode, string(body))
	}

	var result struct {
		Success   bool                     `json:"success"`
		Artifacts []ArtifactUploadResponse `json:"artifacts"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		return nil, fmt.Errorf("failed to parse artifacts list response: %w", err)
	}

	return result.Artifacts, nil
}
