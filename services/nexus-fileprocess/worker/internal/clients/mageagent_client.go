/**
 * MageAgent Client - Dynamic Vision/OCR Model Selection
 *
 * This client delegates ALL model operations to MageAgent service.
 * No hardcoded models - MageAgent dynamically selects best vision model based on:
 * - Available models from OpenRouter
 * - Model health testing
 * - Accuracy vs. speed preferences
 * - Automatic fallback chains
 *
 * Architecture Benefits:
 * - Single source of truth for model selection (MageAgent)
 * - Automatic model updates (new models available immediately)
 * - Proven reliability (MageAgent's battle-tested selection logic)
 * - No model hardcoding in Go codebase
 */

package clients

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"time"

	"github.com/adverant/nexus/fileprocess-worker/internal/logging"
)

// MageAgentClient handles communication with MageAgent service
type MageAgentClient struct {
	baseURL    string
	httpClient *http.Client
	logger     *logging.Logger
}

// VisionOCRRequest represents a request to extract text from an image
type VisionOCRRequest struct {
	Image           string                 `json:"image"`           // Base64 encoded image
	Format          string                 `json:"format"`          // "base64", "url", or "buffer"
	PreferAccuracy  bool                   `json:"preferAccuracy"`  // true = use highest accuracy models (Claude Opus)
	Language        string                 `json:"language"`        // Optional: "en", "multi", etc.
	Metadata        map[string]interface{} `json:"metadata"`        // Optional metadata
	JobID           string                 `json:"jobId,omitempty"` // Optional: FileProcess job ID for tracking
	Async           bool                   `json:"async,omitempty"` // Optional: Use async mode for job tracking
}

// VisionOCRResponse represents a synchronous response from MageAgent vision endpoint
type VisionOCRResponse struct {
	Success bool                   `json:"success"`
	Data    VisionOCRData          `json:"data"`
	Message string                 `json:"message"`
	Meta    map[string]interface{} `json:"meta"`
}

// VisionOCRAsyncResponse represents an async (202 Accepted) response with taskId
type VisionOCRAsyncResponse struct {
	Success bool              `json:"success"`
	Data    VisionOCRTaskData `json:"data"`
	Message string            `json:"message"`
	Meta    AsyncMeta         `json:"meta"`
}

// VisionOCRTaskData contains task ID and polling information
type VisionOCRTaskData struct {
	TaskID string `json:"taskId"`
}

// AsyncMeta contains metadata about async task
type AsyncMeta struct {
	PollURL           string                 `json:"pollUrl"`
	EstimatedDuration string                 `json:"estimatedDuration"`
	ModelSelection    string                 `json:"modelSelection"`
	JobID             string                 `json:"jobId,omitempty"`
	WebSocket         map[string]interface{} `json:"websocket"`
	Polling           map[string]interface{} `json:"polling"`
}

// TaskStatusResponse represents the response from polling /api/tasks/:taskId
type TaskStatusResponse struct {
	Success bool              `json:"success"`
	Data    TaskStatusData    `json:"data"`
	Message string            `json:"message"`
}

// TaskStatusData contains task status and result
type TaskStatusData struct {
	Task TaskInfo `json:"task"`
}

// TaskInfo contains detailed task information
type TaskInfo struct {
	ID          string                 `json:"id"`
	Type        string                 `json:"type"`
	Status      string                 `json:"status"` // "pending", "processing", "completed", "failed"
	Progress    int                    `json:"progress"` // 0-100
	Result      map[string]interface{} `json:"result,omitempty"`
	Error       string                 `json:"error,omitempty"`
	CreatedAt   string                 `json:"createdAt"`
	StartedAt   string                 `json:"startedAt,omitempty"`
	CompletedAt string                 `json:"completedAt,omitempty"`
	Metadata    map[string]interface{} `json:"metadata,omitempty"`
}

// VisionOCRData contains the extracted text and metadata
type VisionOCRData struct {
	Text           string  `json:"text"`
	Confidence     float64 `json:"confidence"`
	ModelUsed      string  `json:"modelUsed"`
	ProcessingTime int64   `json:"processingTime"` // milliseconds
	JobID          string  `json:"jobId,omitempty"`
	Metadata       struct {
		Language       string `json:"language"`
		PreferAccuracy bool   `json:"preferAccuracy"`
		Format         string `json:"format"`
		Mode           string `json:"mode,omitempty"` // "synchronous" or "asynchronous"
	} `json:"metadata"`
}

// NewMageAgentClient creates a new MageAgent client
func NewMageAgentClient(baseURL string) *MageAgentClient {
	return &MageAgentClient{
		baseURL: baseURL,
		httpClient: &http.Client{
			Timeout: 120 * time.Second, // Vision tasks can take time
		},
		logger: logging.NewLogger("MageAgentClient"),
	}
}

// ExtractText extracts text from an image using MageAgent's dynamic vision model selection
func (c *MageAgentClient) ExtractText(ctx context.Context, req *VisionOCRRequest) (*VisionOCRResponse, error) {
	c.logger.Info("Requesting text extraction from MageAgent",
		"preferAccuracy", req.PreferAccuracy,
		"language", req.Language,
		"imageSize", len(req.Image))

	// Use internal endpoint (rate-limit exempt for high throughput)
	endpoint := fmt.Sprintf("%s/api/internal/vision/extract-text", c.baseURL)

	// Marshal request
	reqBody, err := json.Marshal(req)
	if err != nil {
		return nil, fmt.Errorf("failed to marshal request: %w", err)
	}

	// Create HTTP request
	httpReq, err := http.NewRequestWithContext(ctx, "POST", endpoint, bytes.NewReader(reqBody))
	if err != nil {
		return nil, fmt.Errorf("failed to create request: %w", err)
	}

	httpReq.Header.Set("Content-Type", "application/json")
	httpReq.Header.Set("X-Source", "fileprocess-worker") // Identify source for logging
	httpReq.Header.Set("X-Request-ID", fmt.Sprintf("ocr-%d", time.Now().UnixNano()))

	// Execute request
	resp, err := c.httpClient.Do(httpReq)
	if err != nil {
		return nil, fmt.Errorf("request to MageAgent failed: %w", err)
	}
	defer resp.Body.Close()

	// Read response body
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, fmt.Errorf("failed to read response body: %w", err)
	}

	// Check status code
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("MageAgent returned error status %d: %s", resp.StatusCode, string(body))
	}

	// Parse response
	var ocrResp VisionOCRResponse
	if err := json.Unmarshal(body, &ocrResp); err != nil {
		return nil, fmt.Errorf("failed to parse response: %w", err)
	}

	if !ocrResp.Success {
		return nil, fmt.Errorf("MageAgent operation failed: %s", ocrResp.Message)
	}

	c.logger.Info("Text extraction complete",
		"modelUsed", ocrResp.Data.ModelUsed,
		"confidence", ocrResp.Data.Confidence,
		"processingTime", ocrResp.Data.ProcessingTime,
		"textLength", len(ocrResp.Data.Text))

	return &ocrResp, nil
}

// ExtractTextFromBytes is a convenience method that handles base64 encoding (SYNC mode)
func (c *MageAgentClient) ExtractTextFromBytes(ctx context.Context, imageData []byte, preferAccuracy bool, language string) (*VisionOCRResponse, error) {
	// Encode image to base64
	base64Image := base64.StdEncoding.EncodeToString(imageData)

	req := &VisionOCRRequest{
		Image:          base64Image,
		Format:         "base64",
		PreferAccuracy: preferAccuracy,
		Language:       language,
		Async:          false, // Synchronous mode
		Metadata: map[string]interface{}{
			"source":    "fileprocess-worker",
			"timestamp": time.Now().Unix(),
		},
	}

	return c.ExtractText(ctx, req)
}

// ExtractTextAsync starts an async OCR task and returns the taskId for polling
func (c *MageAgentClient) ExtractTextAsync(ctx context.Context, req *VisionOCRRequest) (*VisionOCRAsyncResponse, error) {
	c.logger.Info("Starting async text extraction from MageAgent",
		"preferAccuracy", req.PreferAccuracy,
		"language", req.Language,
		"jobId", req.JobID)

	// Force async mode
	req.Async = true

	// Use internal endpoint
	endpoint := fmt.Sprintf("%s/api/internal/vision/extract-text", c.baseURL)

	// Marshal request
	reqBody, err := json.Marshal(req)
	if err != nil {
		return nil, fmt.Errorf("failed to marshal request: %w", err)
	}

	// Create HTTP request
	httpReq, err := http.NewRequestWithContext(ctx, "POST", endpoint, bytes.NewReader(reqBody))
	if err != nil {
		return nil, fmt.Errorf("failed to create request: %w", err)
	}

	httpReq.Header.Set("Content-Type", "application/json")
	httpReq.Header.Set("X-Source", "fileprocess-worker")
	httpReq.Header.Set("X-Request-ID", fmt.Sprintf("ocr-async-%d", time.Now().UnixNano()))

	// Execute request
	resp, err := c.httpClient.Do(httpReq)
	if err != nil {
		return nil, fmt.Errorf("async request to MageAgent failed: %w", err)
	}
	defer resp.Body.Close()

	// Read response body
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, fmt.Errorf("failed to read response body: %w", err)
	}

	// Check status code - expect 202 Accepted for async
	if resp.StatusCode != http.StatusAccepted {
		return nil, fmt.Errorf("MageAgent returned unexpected status %d: %s", resp.StatusCode, string(body))
	}

	// Parse async response
	var asyncResp VisionOCRAsyncResponse
	if err := json.Unmarshal(body, &asyncResp); err != nil {
		return nil, fmt.Errorf("failed to parse async response: %w", err)
	}

	if !asyncResp.Success {
		return nil, fmt.Errorf("MageAgent async operation failed: %s", asyncResp.Message)
	}

	c.logger.Info("Async OCR task created",
		"taskId", asyncResp.Data.TaskID,
		"estimatedDuration", asyncResp.Meta.EstimatedDuration,
		"modelSelection", asyncResp.Meta.ModelSelection,
		"pollUrl", asyncResp.Meta.PollURL)

	return &asyncResp, nil
}

// GetTaskStatus polls for the status of an async task
func (c *MageAgentClient) GetTaskStatus(ctx context.Context, taskID string) (*TaskStatusResponse, error) {
	endpoint := fmt.Sprintf("%s/api/tasks/%s", c.baseURL, taskID)

	req, err := http.NewRequestWithContext(ctx, "GET", endpoint, nil)
	if err != nil {
		return nil, fmt.Errorf("failed to create status request: %w", err)
	}

	req.Header.Set("X-Source", "fileprocess-worker")

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("status request failed: %w", err)
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, fmt.Errorf("failed to read status response: %w", err)
	}

	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("status check failed with status %d: %s", resp.StatusCode, string(body))
	}

	var statusResp TaskStatusResponse
	if err := json.Unmarshal(body, &statusResp); err != nil {
		return nil, fmt.Errorf("failed to parse status response: %w", err)
	}

	return &statusResp, nil
}

// WaitForTaskCompletion polls the task status until completion or timeout
func (c *MageAgentClient) WaitForTaskCompletion(ctx context.Context, taskID string, pollInterval time.Duration) (*VisionOCRData, error) {
	c.logger.Info("Waiting for task completion", "taskId", taskID)

	ticker := time.NewTicker(pollInterval)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return nil, fmt.Errorf("context cancelled while waiting for task: %w", ctx.Err())

		case <-ticker.C:
			status, err := c.GetTaskStatus(ctx, taskID)
			if err != nil {
				c.logger.Warn("Failed to get task status", "taskId", taskID, "error", err)
				continue
			}

			c.logger.Debug("Task status update",
				"taskId", taskID,
				"status", status.Data.Task.Status,
				"progress", status.Data.Task.Progress)

			switch status.Data.Task.Status {
			case "completed":
				// Extract result from task
				result := status.Data.Task.Result
				ocrData := &VisionOCRData{
					Text:           getStringFromMap(result, "text"),
					Confidence:     getFloatFromMap(result, "confidence"),
					ModelUsed:      getStringFromMap(result, "modelUsed"),
					ProcessingTime: int64(getFloatFromMap(result, "processingTime")),
				}
				c.logger.Info("Task completed successfully",
					"taskId", taskID,
					"modelUsed", ocrData.ModelUsed,
					"confidence", ocrData.Confidence)
				return ocrData, nil

			case "failed":
				return nil, fmt.Errorf("task failed: %s", status.Data.Task.Error)

			case "pending", "processing":
				// Continue polling
				continue

			default:
				c.logger.Warn("Unknown task status", "status", status.Data.Task.Status)
			}
		}
	}
}

// Helper functions for extracting values from result map
func getStringFromMap(m map[string]interface{}, key string) string {
	if val, ok := m[key]; ok {
		if str, ok := val.(string); ok {
			return str
		}
	}
	return ""
}

func getFloatFromMap(m map[string]interface{}, key string) float64 {
	if val, ok := m[key]; ok {
		if num, ok := val.(float64); ok {
			return num
		}
	}
	return 0.0
}

// LayoutAnalysisRequest represents a request to analyze document layout
type LayoutAnalysisRequest struct {
	Image    string `json:"image"`    // Base64 encoded image
	Format   string `json:"format"`   // "base64", "url", or "buffer"
	Language string `json:"language"` // Optional: "en", "multi", etc.
	JobID    string `json:"jobId,omitempty"`
}

// LayoutAnalysisResponse represents the response from layout analysis
type LayoutAnalysisResponse struct {
	Success bool              `json:"success"`
	Data    LayoutAnalysisData `json:"data"`
	Message string            `json:"message"`
}

// LayoutAnalysisData contains the extracted layout information
type LayoutAnalysisData struct {
	Elements       []LayoutElement `json:"elements"`
	ReadingOrder   []int           `json:"readingOrder"`
	Confidence     float64         `json:"confidence"`
	ModelUsed      string          `json:"modelUsed"`
	ProcessingTime int64           `json:"processingTime"` // milliseconds
}

// LayoutElement represents a detected element in the document
type LayoutElement struct {
	ID          int                    `json:"id"`
	Type        string                 `json:"type"` // heading, paragraph, list, table, image, etc.
	BoundingBox LayoutBoundingBox      `json:"boundingBox"`
	Content     string                 `json:"content"`
	Confidence  float64                `json:"confidence"`
	Metadata    map[string]interface{} `json:"metadata,omitempty"` // Level for headings, etc.
}

// LayoutBoundingBox represents the position of an element (client-specific type)
type LayoutBoundingBox struct {
	X      int `json:"x"`
	Y      int `json:"y"`
	Width  int `json:"width"`
	Height int `json:"height"`
}

// AnalyzeLayout analyzes document layout using GPT-4 Vision
func (c *MageAgentClient) AnalyzeLayout(ctx context.Context, req *LayoutAnalysisRequest) (*LayoutAnalysisResponse, error) {
	c.logger.Info("Requesting layout analysis from MageAgent",
		"language", req.Language,
		"imageSize", len(req.Image))

	// Use internal endpoint for layout analysis
	endpoint := fmt.Sprintf("%s/api/internal/vision/analyze-layout", c.baseURL)

	// Marshal request
	reqBody, err := json.Marshal(req)
	if err != nil {
		return nil, fmt.Errorf("failed to marshal request: %w", err)
	}

	// Create HTTP request
	httpReq, err := http.NewRequestWithContext(ctx, "POST", endpoint, bytes.NewReader(reqBody))
	if err != nil {
		return nil, fmt.Errorf("failed to create request: %w", err)
	}

	httpReq.Header.Set("Content-Type", "application/json")
	httpReq.Header.Set("X-Source", "fileprocess-worker")
	httpReq.Header.Set("X-Request-ID", fmt.Sprintf("layout-%d", time.Now().UnixNano()))

	// Execute request
	resp, err := c.httpClient.Do(httpReq)
	if err != nil {
		return nil, fmt.Errorf("request to MageAgent failed: %w", err)
	}
	defer resp.Body.Close()

	// Read response body
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, fmt.Errorf("failed to read response body: %w", err)
	}

	// Check status code
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("MageAgent returned error status %d: %s", resp.StatusCode, string(body))
	}

	// Parse response
	var layoutResp LayoutAnalysisResponse
	if err := json.Unmarshal(body, &layoutResp); err != nil {
		return nil, fmt.Errorf("failed to parse response: %w", err)
	}

	if !layoutResp.Success {
		return nil, fmt.Errorf("MageAgent operation failed: %s", layoutResp.Message)
	}

	c.logger.Info("Layout analysis complete",
		"modelUsed", layoutResp.Data.ModelUsed,
		"confidence", layoutResp.Data.Confidence,
		"elements", len(layoutResp.Data.Elements),
		"processingTime", layoutResp.Data.ProcessingTime)

	return &layoutResp, nil
}

// AnalyzeLayoutFromBytes is a convenience method that handles base64 encoding
func (c *MageAgentClient) AnalyzeLayoutFromBytes(ctx context.Context, imageData []byte, language string) (*LayoutAnalysisResponse, error) {
	// Encode image to base64
	base64Image := base64.StdEncoding.EncodeToString(imageData)

	req := &LayoutAnalysisRequest{
		Image:    base64Image,
		Format:   "base64",
		Language: language,
	}

	return c.AnalyzeLayout(ctx, req)
}

// Table Extraction Types (Phase 2.3)

// TableExtractionRequest represents a request to extract table structure
type TableExtractionRequest struct {
	Image    string `json:"image"`    // Base64 encoded image
	Format   string `json:"format"`   // "base64", "url", or "buffer"
	Language string `json:"language"` // Optional: "en", "multi", etc.
	JobID    string `json:"jobId,omitempty"`
	Async    bool   `json:"async,omitempty"`
}

// TableExtractionResponse represents response from table extraction endpoint
type TableExtractionResponse struct {
	Success bool                  `json:"success"`
	Data    TableExtractionData   `json:"data"`
	Message string                `json:"message"`
	Meta    map[string]interface{} `json:"meta"`
}

// TableExtractionData contains extracted table structure
type TableExtractionData struct {
	Rows           []TableRow `json:"rows"`
	Columns        int        `json:"columns"`
	Confidence     float64    `json:"confidence"`
	ModelUsed      string     `json:"modelUsed"`
	ProcessingTime int64      `json:"processingTime"`
}

// TableRow represents a single row in the extracted table
type TableRow struct {
	RowIndex int        `json:"rowIndex"`
	IsHeader bool       `json:"isHeader"`
	Cells    []TableCell `json:"cells"`
}

// TableCell represents a single cell in the table
type TableCell struct {
	RowIndex   int     `json:"rowIndex"`
	ColIndex   int     `json:"colIndex"`
	Content    string  `json:"content"`
	Confidence float64 `json:"confidence"`
	IsHeader   bool    `json:"isHeader"`
	RowSpan    int     `json:"rowSpan,omitempty"`
	ColSpan    int     `json:"colSpan,omitempty"`
}

// ExtractTable extracts table structure using GPT-4 Vision
func (c *MageAgentClient) ExtractTable(ctx context.Context, req *TableExtractionRequest) (*TableExtractionResponse, error) {
	c.logger.Info("Requesting table extraction from MageAgent",
		"language", req.Language,
		"imageSize", len(req.Image))

	// Use internal endpoint for table extraction
	endpoint := fmt.Sprintf("%s/api/internal/vision/extract-table", c.baseURL)

	// Marshal request
	reqBody, err := json.Marshal(req)
	if err != nil {
		return nil, fmt.Errorf("failed to marshal request: %w", err)
	}

	// Create HTTP request
	httpReq, err := http.NewRequestWithContext(ctx, "POST", endpoint, bytes.NewReader(reqBody))
	if err != nil {
		return nil, fmt.Errorf("failed to create request: %w", err)
	}

	httpReq.Header.Set("Content-Type", "application/json")
	httpReq.Header.Set("X-Source", "fileprocess-worker")
	httpReq.Header.Set("X-Request-ID", fmt.Sprintf("table-%d", time.Now().UnixNano()))

	// Execute request
	resp, err := c.httpClient.Do(httpReq)
	if err != nil {
		return nil, fmt.Errorf("request to MageAgent failed: %w", err)
	}
	defer resp.Body.Close()

	// Read response body
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, fmt.Errorf("failed to read response body: %w", err)
	}

	// Check status code
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("MageAgent returned error status %d: %s", resp.StatusCode, string(body))
	}

	// Parse response
	var tableResp TableExtractionResponse
	if err := json.Unmarshal(body, &tableResp); err != nil {
		return nil, fmt.Errorf("failed to parse response: %w", err)
	}

	if !tableResp.Success {
		return nil, fmt.Errorf("MageAgent operation failed: %s", tableResp.Message)
	}

	c.logger.Info("Table extraction complete",
		"modelUsed", tableResp.Data.ModelUsed,
		"confidence", tableResp.Data.Confidence,
		"rows", len(tableResp.Data.Rows),
		"columns", tableResp.Data.Columns,
		"processingTime", tableResp.Data.ProcessingTime)

	return &tableResp, nil
}

// ExtractTableFromBytes is a convenience method that handles base64 encoding
func (c *MageAgentClient) ExtractTableFromBytes(ctx context.Context, imageData []byte, language string) (*TableExtractionResponse, error) {
	// Encode image to base64
	base64Image := base64.StdEncoding.EncodeToString(imageData)

	req := &TableExtractionRequest{
		Image:    base64Image,
		Format:   "base64",
		Language: language,
	}

	return c.ExtractTable(ctx, req)
}

// HealthCheck verifies MageAgent service is available
func (c *MageAgentClient) HealthCheck(ctx context.Context) error {
	endpoint := fmt.Sprintf("%s/api/health", c.baseURL)

	req, err := http.NewRequestWithContext(ctx, "GET", endpoint, nil)
	if err != nil {
		return fmt.Errorf("failed to create health check request: %w", err)
	}

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return fmt.Errorf("health check request failed: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("health check failed with status %d: %s", resp.StatusCode, string(body))
	}

	return nil
}

// =============================================================================
// File Process Types and Methods (for PDF and Document Processing)
// =============================================================================

// FileProcessRequest represents a request to process a document file (PDF, DOCX, etc.)
type FileProcessRequest struct {
	FileBuffer []byte             `json:"-"`                      // Binary file data (not sent as JSON, encoded separately)
	Filename   string             `json:"filename"`               // Original filename
	MimeType   string             `json:"mimeType"`               // MIME type
	Operations []string           `json:"operations"`             // e.g., ["extract_content", "extract_tables"]
	Options    FileProcessOptions `json:"options"`                // Processing options
}

// FileProcessOptions contains options for file processing
type FileProcessOptions struct {
	EnableOCR     bool `json:"enableOcr"`
	ExtractTables bool `json:"extractTables"`
}

// FileProcessResponse represents the response from /file-process endpoint
type FileProcessResponse struct {
	Success bool              `json:"success"`
	Data    FileProcessData   `json:"data"`
	Message string            `json:"message"`
}

// FileProcessData contains the extracted document content
type FileProcessData struct {
	Text           string                 `json:"text"`           // Full extracted text
	Pages          []FileProcessPage      `json:"pages"`          // Per-page content
	Tables         []FileProcessTable     `json:"tables"`         // Extracted tables
	Metadata       map[string]interface{} `json:"metadata"`       // Document metadata
	PageCount      int                    `json:"pageCount"`      // Number of pages
	Confidence     float64                `json:"confidence"`     // Overall confidence
	ModelUsed      string                 `json:"modelUsed"`      // Model used for processing
	ProcessingTime int64                  `json:"processingTime"` // Processing time in ms
}

// FileProcessPage represents a single page's content
type FileProcessPage struct {
	PageNumber int     `json:"pageNumber"`
	Text       string  `json:"text"`
	Confidence float64 `json:"confidence"`
}

// FileProcessTable represents an extracted table
type FileProcessTable struct {
	PageNumber int                      `json:"pageNumber"`
	Rows       []map[string]interface{} `json:"rows"`
	Confidence float64                  `json:"confidence"`
}

// ProcessFile processes a document file (PDF, DOCX, etc.) using MageAgent's /file-process endpoint
// This endpoint handles PDF → image conversion internally and is optimized for document processing
func (c *MageAgentClient) ProcessFile(ctx context.Context, req *FileProcessRequest) (*FileProcessResponse, error) {
	c.logger.Info("Processing file via MageAgent /file-process",
		"filename", req.Filename,
		"mimeType", req.MimeType,
		"operations", req.Operations,
		"fileSize", len(req.FileBuffer))

	// Use internal endpoint for file processing
	endpoint := fmt.Sprintf("%s/api/internal/file-process", c.baseURL)

	// Build request body with base64-encoded file
	requestBody := map[string]interface{}{
		"fileBuffer": base64.StdEncoding.EncodeToString(req.FileBuffer),
		"filename":   req.Filename,
		"mimeType":   req.MimeType,
		"operations": req.Operations,
		"options": map[string]interface{}{
			"enableOcr":     req.Options.EnableOCR,
			"extractTables": req.Options.ExtractTables,
		},
	}

	// Marshal request
	reqBody, err := json.Marshal(requestBody)
	if err != nil {
		return nil, fmt.Errorf("failed to marshal request: %w", err)
	}

	// Create HTTP request with extended timeout for large files
	httpReq, err := http.NewRequestWithContext(ctx, "POST", endpoint, bytes.NewReader(reqBody))
	if err != nil {
		return nil, fmt.Errorf("failed to create request: %w", err)
	}

	httpReq.Header.Set("Content-Type", "application/json")
	httpReq.Header.Set("X-Source", "fileprocess-worker")
	httpReq.Header.Set("X-Request-ID", fmt.Sprintf("file-process-%d", time.Now().UnixNano()))

	// Execute request with extended timeout for document processing
	client := &http.Client{
		Timeout: 300 * time.Second, // 5 minutes for large documents
	}
	resp, err := client.Do(httpReq)
	if err != nil {
		return nil, fmt.Errorf("request to MageAgent /file-process failed: %w", err)
	}
	defer resp.Body.Close()

	// Read response body
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, fmt.Errorf("failed to read response body: %w", err)
	}

	// Check status code
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("MageAgent /file-process returned error status %d: %s", resp.StatusCode, string(body))
	}

	// Parse response
	var fileResp FileProcessResponse
	if err := json.Unmarshal(body, &fileResp); err != nil {
		return nil, fmt.Errorf("failed to parse response: %w", err)
	}

	if !fileResp.Success {
		return nil, fmt.Errorf("MageAgent /file-process failed: %s", fileResp.Message)
	}

	c.logger.Info("File processing complete",
		"modelUsed", fileResp.Data.ModelUsed,
		"confidence", fileResp.Data.Confidence,
		"pageCount", fileResp.Data.PageCount,
		"textLength", len(fileResp.Data.Text),
		"processingTime", fileResp.Data.ProcessingTime)

	return &fileResp, nil
}
