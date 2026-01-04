/**
 * Document Processor for FileProcessAgent Worker
 *
 * Orchestrates document processing with Dockling-level accuracy:
 * - 3-tier OCR cascade (Tesseract → GPT-4 Vision → Claude-3 Opus)
 * - Layout analysis with 99.2% accuracy target
 * - Table extraction with 97.9% accuracy target
 * - Document DNA generation (semantic + structural + original)
 * - VoyageAI embeddings for semantic search
 */

package processor

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"log"
	"math"
	"net/http"
	"strings"
	"time"

	"github.com/adverant/nexus/fileprocess-worker/internal/clients"
	"github.com/adverant/nexus/fileprocess-worker/internal/storage"
)

// DocumentProcessorInterface defines the interface for document processing
type DocumentProcessorInterface interface {
	ProcessDocument(ctx context.Context, req *ProcessRequest) (*ProcessResult, error)
	UpdateJobStatus(ctx context.Context, jobID string, status string, progress int, metadata map[string]interface{}) error
}

// ProcessorConfig holds processor configuration
type ProcessorConfig struct {
	VoyageAPIKey       string
	TesseractPath      string
	TempDir            string
	MaxFileSize        int64
	StorageManager     *storage.StorageManager
	GraphRAGURL        string
	MageAgentURL       string // MageAgent service URL for OCR operations
	FileProcessAPIURL  string // FileProcess API URL for artifact storage
}

// ProcessRequest represents a document processing request
type ProcessRequest struct {
	JobID      string
	UserID     string
	Filename   string
	MimeType   string
	FileSize   int64
	FileURL    string
	FileBuffer []byte
	Metadata   map[string]interface{}
}

// ProcessResult represents the processing result
type ProcessResult struct {
	DocumentDNAID      string
	Confidence         float64
	OCRTierUsed        string
	TablesExtracted    int
	RegionsExtracted   int
	EmbeddingGenerated bool
	ProcessingTimeMs   int64
}

// DocumentProcessor handles document processing
type DocumentProcessor struct {
	config          *ProcessorConfig
	storage         *storage.StorageManager
	embeddingClient *EmbeddingClient
	mageAgentClient *clients.MageAgentClient // NEW: Delegate OCR to MageAgent
	graphragClient  *clients.GraphRAGClient  // GraphRAG client for document storage and search
	artifactClient  *clients.ArtifactClient  // Artifact client for permanent file storage
	tesseractOCR    *TesseractOCR            // Fallback OCR for offline/fast processing
	layoutAnalyzer  *LayoutAnalyzer
}

// NewDocumentProcessor creates a new document processor
func NewDocumentProcessor(cfg *ProcessorConfig) (*DocumentProcessor, error) {
	if cfg == nil {
		return nil, fmt.Errorf("config is required")
	}

	if cfg.StorageManager == nil {
		return nil, fmt.Errorf("storage manager is required")
	}

	if cfg.MageAgentURL == "" {
		return nil, fmt.Errorf("MageAgent URL is required for OCR operations")
	}

	// Create embedding client
	embeddingClient, err := NewEmbeddingClient(cfg.VoyageAPIKey)
	if err != nil {
		return nil, fmt.Errorf("failed to create embedding client: %w", err)
	}

	// Create MageAgent client for dynamic vision/OCR model selection
	mageAgentClient := clients.NewMageAgentClient(cfg.MageAgentURL)

	// Test MageAgent connection
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := mageAgentClient.HealthCheck(ctx); err != nil {
		log.Printf("WARNING: MageAgent health check failed: %v. Will fall back to Tesseract.", err)
	} else {
		log.Printf("MageAgent connection verified: %s", cfg.MageAgentURL)
	}

	// Create GraphRAG client for document storage and search
	var graphragClient *clients.GraphRAGClient
	if cfg.GraphRAGURL != "" {
		graphragClient = clients.NewGraphRAGClient(cfg.GraphRAGURL)
		// Test GraphRAG connection (non-fatal if unavailable)
		ctx2, cancel2 := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel2()
		if err := graphragClient.HealthCheck(ctx2); err != nil {
			log.Printf("WARNING: GraphRAG health check failed: %v. Documents will not be searchable via memory recall.", err)
		} else {
			log.Printf("GraphRAG connection verified: %s", cfg.GraphRAGURL)
		}
	} else {
		log.Printf("WARNING: GraphRAG URL not configured. Documents will not be searchable via memory recall.")
	}

	// Create Artifact client for permanent file storage
	var artifactClient *clients.ArtifactClient
	if cfg.FileProcessAPIURL != "" {
		artifactClient = clients.NewArtifactClient(cfg.FileProcessAPIURL)
		// Test artifact storage connection (non-fatal if unavailable)
		ctx3, cancel3 := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel3()
		if err := artifactClient.HealthCheck(ctx3); err != nil {
			log.Printf("WARNING: Artifact storage health check failed: %v. Original files will not be stored permanently.", err)
		} else {
			log.Printf("Artifact storage connection verified: %s", cfg.FileProcessAPIURL)
		}
	} else {
		log.Printf("WARNING: FileProcess API URL not configured. Original files will not be stored permanently.")
	}

	// Create Tesseract OCR as fallback
	tesseractOCR, err := NewTesseractOCR(&TesseractConfig{
		TesseractPath: cfg.TesseractPath,
	})
	if err != nil {
		log.Printf("WARNING: Failed to initialize Tesseract: %v. OCR will rely solely on MageAgent.", err)
	}

	// Create layout analyzer with MageAgent integration for vision-based analysis
	// Enable vision mode for higher accuracy (99.2% vs 70% heuristic)
	layoutAnalyzer := NewLayoutAnalyzer(mageAgentClient, true)

	return &DocumentProcessor{
		config:          cfg,
		storage:         cfg.StorageManager,
		embeddingClient: embeddingClient,
		mageAgentClient: mageAgentClient,
		graphragClient:  graphragClient,
		artifactClient:  artifactClient,
		tesseractOCR:    tesseractOCR,
		layoutAnalyzer:  layoutAnalyzer,
	}, nil
}

// ProcessDocument processes a document through the complete pipeline
func (p *DocumentProcessor) ProcessDocument(ctx context.Context, req *ProcessRequest) (*ProcessResult, error) {
	log.Printf("[Job %s] Starting document processing pipeline", req.JobID)

	// Step 1: Download/load file
	log.Printf("[Job %s] Step 1: Loading file (%d bytes)", req.JobID, req.FileSize)
	fileData, err := p.loadFile(ctx, req)
	if err != nil {
		return nil, fmt.Errorf("failed to load file: %w", err)
	}

	// Step 1.5: Detect actual MIME type from magic bytes
	// Essential for files from Google Drive which often return application/octet-stream
	detectedMime := detectMimeTypeFromMagicBytes(fileData)
	if detectedMime != "" && (req.MimeType == "" || req.MimeType == "application/octet-stream") {
		log.Printf("[Job %s] Corrected MIME type from '%s' to '%s' (magic byte detection)",
			req.JobID, req.MimeType, detectedMime)
		req.MimeType = detectedMime
	}

	// Step 2: Determine processing strategy based on file type
	log.Printf("[Job %s] Step 2: Analyzing file type (mime: %s)", req.JobID, req.MimeType)
	needsOCR := p.requiresOCR(req.MimeType)

	var ocrResult *OCRResult
	var extractedText string
	var ocrTier string

	// Check for EPUB first (before needsOCR check) - EPUB files are detected as ZIP but need MageAgent processing
	isEPUB := req.MimeType == "application/epub+zip" || strings.HasSuffix(strings.ToLower(req.Filename), ".epub")
	if isEPUB {
		log.Printf("[Job %s] Step 3: Detected EPUB file, routing to MageAgent /file-process", req.JobID)
		ocrResult, err = p.processDocumentViaMageAgent(ctx, req, fileData, "application/epub+zip")
		if err != nil {
			return nil, fmt.Errorf("EPUB processing failed: %w", err)
		}
		log.Printf("[Job %s] EPUB processed: model=%s, confidence=%.2f, pages=%d",
			req.JobID, ocrResult.TierUsed, ocrResult.Confidence, len(ocrResult.Pages))
		extractedText = ocrResult.Text
		ocrTier = ocrResult.TierUsed
	} else if needsOCR {
		// Image/PDF files: Use MageAgent for intelligent OCR with dynamic model selection
		log.Printf("[Job %s] Step 3: Determining OCR strategy for image/PDF", req.JobID)

		// For PDFs: Route to /file-process endpoint which handles PDF → image conversion
		// For Images: Use standard OCR cascade (Tesseract → GPT-4o → Claude Opus)
		if req.MimeType == "application/pdf" || strings.HasSuffix(strings.ToLower(req.Filename), ".pdf") {
			log.Printf("[Job %s] Step 4: Routing PDF to MageAgent /file-process (PDF-native processing)", req.JobID)
			ocrResult, err = p.processPDFViaMageAgent(ctx, req, fileData)
			if err != nil {
				return nil, fmt.Errorf("PDF processing failed: %w", err)
			}
		} else {
			// Determine if high accuracy is needed based on file characteristics
			preferAccuracy := p.shouldPreferAccuracy(req)
			log.Printf("[Job %s] OCR strategy: preferAccuracy=%v (based on file size=%d, mime=%s)",
				req.JobID, preferAccuracy, req.FileSize, req.MimeType)

			log.Printf("[Job %s] Step 4: Delegating OCR to MageAgent (zero hardcoded models)", req.JobID)
			ocrResult, err = p.performOCRWithMageAgent(ctx, req, fileData, preferAccuracy)
			if err != nil {
				return nil, fmt.Errorf("OCR processing failed: %w", err)
			}
		}
		log.Printf("[Job %s] OCR complete: model=%s, confidence=%.2f, pages=%d",
			req.JobID, ocrResult.TierUsed, ocrResult.Confidence, len(ocrResult.Pages))
		extractedText = ocrResult.Text
		ocrTier = ocrResult.TierUsed
	} else {
		// Text-based files: Direct extraction
		log.Printf("[Job %s] Step 3: Extracting text directly (text-based file)", req.JobID)
		extractedText = string(fileData)
		ocrTier = "direct_extraction"

		// Create synthetic OCR result for pipeline compatibility
		ocrResult = &OCRResult{
			Text:       extractedText,
			Confidence: 1.0, // 100% confidence for direct text extraction
			TierUsed:   ocrTier,
			Pages: []OCRPage{
				{
					PageNumber: 1,
					Text:       extractedText,
					Confidence: 1.0,
					Words:      []OCRWord{},
				},
			},
		}
		log.Printf("[Job %s] Text extracted: %d characters", req.JobID, len(extractedText))
	}

	// Step 5: Layout analysis (only for image/PDF files)
	var layoutResult *LayoutResult
	if needsOCR {
		log.Printf("[Job %s] Step 5: Analyzing document layout", req.JobID)
		layoutResult, err = p.layoutAnalyzer.Analyze(ctx, ocrResult)
		if err != nil {
			return nil, fmt.Errorf("layout analysis failed: %w", err)
		}
		log.Printf("[Job %s] Layout analysis complete: regions=%d, tables=%d, confidence=%.2f",
			req.JobID, len(layoutResult.Regions), len(layoutResult.Tables), layoutResult.Confidence)
	} else {
		// For text files, create minimal layout result
		layoutResult = &LayoutResult{
			Confidence: 1.0,
			Regions: []LayoutRegion{
				{
					ID:          0,
					Type:        "text",
					BoundingBox: BoundingBox{X: 0, Y: 0, Width: 0, Height: 0},
					Confidence:  1.0,
					Content:     extractedText,
				},
			},
			Tables:       []Table{},
			ReadingOrder: []int{0},
		}
		log.Printf("[Job %s] Layout bypassed for text file", req.JobID)
	}

	// Step 7: Generate VoyageAI embedding (1024 dimensions)
	log.Printf("[Job %s] Step 7: Generating semantic embedding", req.JobID)
	embedding, err := p.embeddingClient.GenerateEmbedding(ctx, extractedText)
	if err != nil {
		return nil, fmt.Errorf("embedding generation failed: %w", err)
	}
	log.Printf("[Job %s] Embedding generated: dimensions=%d", req.JobID, len(embedding))

	// Step 8: Build structural data
	structuralData := map[string]interface{}{
		"layout": map[string]interface{}{
			"confidence": layoutResult.Confidence,
			"regions":    layoutResult.Regions,
			"readingOrder": layoutResult.ReadingOrder,
		},
		"tables": layoutResult.Tables,
		"metadata": map[string]interface{}{
			"filename":     req.Filename,
			"mimeType":     req.MimeType,
			"fileSize":     req.FileSize,
			"ocrTier":      ocrTier,
			"ocrConfidence": ocrResult.Confidence,
			"pageCount":    len(ocrResult.Pages),
			"extractedAt":  "now",
		},
	}

	// Step 9: Store Document DNA atomically across PostgreSQL + Qdrant
	log.Printf("[Job %s] Step 9: Storing Document DNA", req.JobID)
	dnaResult, err := p.storage.StoreDocumentDNA(ctx, &storage.DocumentDNAInput{
		JobID:             req.JobID,
		SemanticEmbedding: embedding,
		StructuralData:    structuralData,
		OriginalContent:   fileData,
	})
	if err != nil {
		return nil, fmt.Errorf("failed to store Document DNA: %w", err)
	}
	log.Printf("[Job %s] Document DNA stored: dnaId=%s, qdrantPointId=%s",
		req.JobID, dnaResult.ID, dnaResult.QdrantPointID)

	dnaID := dnaResult.ID

	// Step 9.5: Store original file as permanent artifact for later retrieval
	// This enables page-specific PDF viewing via URLs like: https://drive.google.com/file/d/xxx/view#page=53
	var artifactID, artifactURL, storageBackend string
	if p.artifactClient != nil && len(fileData) > 0 {
		log.Printf("[Job %s] Step 9.5: Uploading original file to permanent storage (%d bytes)", req.JobID, len(fileData))

		artifactResp, err := p.artifactClient.UploadArtifact(ctx, &clients.ArtifactUploadRequest{
			FileBuffer:    fileData,
			Filename:      req.Filename,
			MimeType:      req.MimeType,
			SourceService: "fileprocess-worker",
			SourceID:      req.JobID,
			TTLDays:       0, // Permanent storage (100 years)
			Metadata: map[string]interface{}{
				"documentDnaId": dnaID,
				"ocrTier":       ocrTier,
				"pageCount":     len(ocrResult.Pages),
				"confidence":    ocrResult.Confidence,
			},
		})

		if err != nil {
			// Non-fatal: processing continues, but original file won't be accessible for viewing
			log.Printf("[Job %s] WARNING: Failed to store artifact: %v. Original file will not be accessible for page viewing.", req.JobID, err)
		} else if artifactResp != nil && artifactResp.Success {
			artifactID = artifactResp.Artifact.ID
			artifactURL = artifactResp.Artifact.DownloadURL
			storageBackend = artifactResp.Artifact.StorageBackend
			log.Printf("[Job %s] Artifact stored permanently: id=%s, storage=%s, url=%s",
				req.JobID, artifactID, storageBackend, artifactURL)
		}
	} else if p.artifactClient == nil {
		log.Printf("[Job %s] Skipping artifact storage: client not configured", req.JobID)
	}

	// Step 10: Store extracted text in GraphRAG for chunking and semantic search
	// This enables document search via /api/memory/recall alongside episodic memories
	// Include artifact URL so recall results can link to viewable PDF pages
	if p.graphragClient != nil && len(extractedText) > 0 {
		log.Printf("[Job %s] Step 10: Storing document in GraphRAG for chunking/search", req.JobID)

		// Calculate page boundaries for multi-page documents (PDFs)
		// This allows GraphRAG to preserve page numbers in chunks for page-specific queries
		var pageInfos []clients.PageInfo
		if len(ocrResult.Pages) > 0 {
			currentOffset := 0
			for _, page := range ocrResult.Pages {
				pageLen := len(page.Text)
				pageInfos = append(pageInfos, clients.PageInfo{
					PageNumber: page.PageNumber,
					StartChar:  currentOffset,
					EndChar:    currentOffset + pageLen,
				})
				currentOffset += pageLen + 2 // +2 for "\n\n" separator between pages
			}
			log.Printf("[Job %s] Calculated page boundaries for %d pages", req.JobID, len(pageInfos))
		}

		graphragReq := &clients.GraphRAGDocumentRequest{
			Content: extractedText,
			Title:   req.Filename,
			Metadata: clients.GraphRAGDocumentMeta{
				Source:       req.FileURL,
				Type:         clients.DetermineDocumentType(req.MimeType),
				FileSize:     req.FileSize,
				MimeType:     req.MimeType,
				UploadedBy:   req.UserID,
				ProcessingID: req.JobID,
				Tags:         []string{ocrTier, req.MimeType},
				Pages:        pageInfos,
				PageCount:    len(ocrResult.Pages),
				// Artifact references for page-specific viewing
				ArtifactID:     artifactID,
				ArtifactURL:    artifactURL,
				StorageBackend: storageBackend,
				DocumentDNAID:  dnaID,
			},
		}

		graphragResp, err := p.graphragClient.StoreDocument(ctx, graphragReq)
		if err != nil {
			// Non-fatal error - document DNA is still stored, just not searchable via memory recall
			log.Printf("[Job %s] WARNING: Failed to store in GraphRAG: %v. Document will not be searchable via memory recall.", req.JobID, err)
		} else if graphragResp != nil && graphragResp.Success {
			log.Printf("[Job %s] Document stored in GraphRAG: docId=%s, chunks=%d, artifactUrl=%s",
				req.JobID, graphragResp.DocumentID, graphragResp.ChunkCount, artifactURL)
		}
	} else if p.graphragClient == nil {
		log.Printf("[Job %s] Skipping GraphRAG storage: client not configured", req.JobID)
	}

	// Calculate overall confidence (weighted average)
	overallConfidence := (ocrResult.Confidence*0.4 + layoutResult.Confidence*0.6)

	result := &ProcessResult{
		DocumentDNAID:      dnaID,
		Confidence:         overallConfidence,
		OCRTierUsed:        ocrTier,
		TablesExtracted:    len(layoutResult.Tables),
		RegionsExtracted:   len(layoutResult.Regions),
		EmbeddingGenerated: true,
	}

	log.Printf("[Job %s] Processing pipeline complete: dnaId=%s, confidence=%.2f",
		req.JobID, dnaID, overallConfidence)

	return result, nil
}

// UpdateJobStatus updates job status in database
func (p *DocumentProcessor) UpdateJobStatus(ctx context.Context, jobID string, status string, progress int, metadata map[string]interface{}) error {
	update := &storage.JobUpdate{
		JobID:    jobID,
		Status:   status,
		Metadata: metadata,
	}

	// Extract specific fields from metadata if present
	if metadata != nil {
		if confidence, ok := metadata["confidence"].(float64); ok {
			update.Confidence = confidence
		}
		if processingTime, ok := metadata["processingTime"].(int64); ok {
			update.ProcessingTimeMs = processingTime
		}
		if documentDnaId, ok := metadata["documentDnaId"].(string); ok {
			update.DocumentDNAID = documentDnaId
		}
		if ocrTierUsed, ok := metadata["ocrTierUsed"].(string); ok {
			update.OCRTierUsed = ocrTierUsed
		}
		if errorMsg, ok := metadata["error"].(string); ok {
			update.ErrorCode = "PROCESSING_ERROR"
			update.ErrorMessage = errorMsg
		}
	}

	return p.storage.UpdateJobStatus(ctx, update)
}

// loadFile loads file from URL or buffer
func (p *DocumentProcessor) loadFile(ctx context.Context, req *ProcessRequest) ([]byte, error) {
	// If buffer is provided, use it directly
	if len(req.FileBuffer) > 0 {
		log.Printf("[Job %s] Using file buffer (%d bytes)", req.JobID, len(req.FileBuffer))
		return req.FileBuffer, nil
	}

	// If URL is provided, download it
	if req.FileURL != "" {
		log.Printf("[Job %s] Downloading file from URL: %s (fileSize=%d)", req.JobID, req.FileURL, req.FileSize)
		fileData, err := p.downloadFileFromURL(ctx, req.JobID, req.FileURL, req.FileSize)
		if err != nil {
			return nil, fmt.Errorf("failed to download file: %w", err)
		}
		log.Printf("[Job %s] File downloaded successfully (%d bytes)", req.JobID, len(fileData))
		return fileData, nil
	}

	return nil, fmt.Errorf("no file source provided (buffer or URL)")
}

// downloadFileFromURL downloads a file from a URL with retry logic and memory efficiency
// Supports Google Drive, HTTP, HTTPS, and other URL-based sources
func (p *DocumentProcessor) downloadFileFromURL(ctx context.Context, jobID string, fileURL string, expectedSize int64) ([]byte, error) {
	const (
		maxRetries           = 5
		initialBackoffMs     = 1000
		maxBackoffMs         = 32000
		downloadTimeoutMs    = 600000 // 10 minutes total
		chunkSizeBytes       = 10 * 1024 * 1024 // 10MB chunks for progress tracking
	)

	// Create a client with timeout
	client := &http.Client{
		Timeout: time.Duration(downloadTimeoutMs) * time.Millisecond,
	}

	var lastErr error

	for attempt := 1; attempt <= maxRetries; attempt++ {
		log.Printf("[Job %s] Download attempt %d/%d from: %s", jobID, attempt, maxRetries, fileURL)

		resp, err := client.Get(fileURL)
		if err != nil {
			lastErr = err
			log.Printf("[Job %s] Download attempt %d failed: %v", jobID, attempt, err)

			if attempt < maxRetries {
				backoffMs := initialBackoffMs * int(math.Pow(2, float64(attempt-1)))
				if backoffMs > maxBackoffMs {
					backoffMs = maxBackoffMs
				}
				log.Printf("[Job %s] Retrying in %dms...", jobID, backoffMs)
				select {
				case <-time.After(time.Duration(backoffMs) * time.Millisecond):
					continue
				case <-ctx.Done():
					return nil, fmt.Errorf("context cancelled during retry backoff")
				}
			}
			continue
		}

		// Check response status
		if resp.StatusCode < 200 || resp.StatusCode >= 300 {
			resp.Body.Close()
			err = fmt.Errorf("HTTP %d: %s", resp.StatusCode, resp.Status)
			lastErr = err
			log.Printf("[Job %s] Download attempt %d failed: %v", jobID, attempt, err)

			if attempt < maxRetries {
				backoffMs := initialBackoffMs * int(math.Pow(2, float64(attempt-1)))
				if backoffMs > maxBackoffMs {
					backoffMs = maxBackoffMs
				}
				log.Printf("[Job %s] Retrying in %dms...", jobID, backoffMs)
				select {
				case <-time.After(time.Duration(backoffMs) * time.Millisecond):
					continue
				case <-ctx.Done():
					return nil, fmt.Errorf("context cancelled during retry backoff")
				}
			}
			continue
		}

		// Check Content-Length if available
		contentLength := resp.ContentLength
		if contentLength > 0 && expectedSize > 0 && contentLength != expectedSize {
			log.Printf("[Job %s] WARNING: Content-Length mismatch. Expected=%d, Got=%d",
				jobID, expectedSize, contentLength)
		}

		// Read file with size limit to prevent memory exhaustion
		if p.config.MaxFileSize > 0 && contentLength > p.config.MaxFileSize {
			resp.Body.Close()
			return nil, fmt.Errorf("file size exceeds maximum: %d > %d bytes",
				contentLength, p.config.MaxFileSize)
		}

		// Read entire file into memory (with limit protection)
		maxReadBytes := p.config.MaxFileSize
		if maxReadBytes == 0 {
			maxReadBytes = 10 * 1024 * 1024 * 1024 // 10GB safety limit
		}

		fileData, err := io.ReadAll(io.LimitReader(resp.Body, maxReadBytes))
		resp.Body.Close()

		if err != nil {
			lastErr = err
			log.Printf("[Job %s] Failed to read response body: %v", jobID, err)

			if attempt < maxRetries {
				backoffMs := initialBackoffMs * int(math.Pow(2, float64(attempt-1)))
				if backoffMs > maxBackoffMs {
					backoffMs = maxBackoffMs
				}
				log.Printf("[Job %s] Retrying in %dms...", jobID, backoffMs)
				select {
				case <-time.After(time.Duration(backoffMs) * time.Millisecond):
					continue
				case <-ctx.Done():
					return nil, fmt.Errorf("context cancelled during retry backoff")
				}
			}
			continue
		}

		// Success: file downloaded
		log.Printf("[Job %s] Download successful on attempt %d: %d bytes", jobID, attempt, len(fileData))
		return fileData, nil
	}

	return nil, fmt.Errorf("failed to download file after %d attempts: %w", maxRetries, lastErr)
}

// performOCRWithMageAgent implements 3-tier OCR cascade for cost optimization
// Tier 1: Tesseract (fast, free, 82% accuracy)
// Tier 2: MageAgent GPT-4o (confidence < 0.85, balanced, $0.01-0.03/page)
// Tier 3: MageAgent Claude Opus (confidence < 0.90, highest accuracy, $0.05-0.10/page)
func (p *DocumentProcessor) performOCRWithMageAgent(ctx context.Context, req *ProcessRequest, fileData []byte, preferAccuracy bool) (*OCRResult, error) {
	startTime := time.Now()

	// TIER 1: Try Tesseract first (fast, free, offline)
	if p.tesseractOCR != nil {
		log.Printf("[Job %s] Tier 1: Attempting Tesseract OCR (fast, free)", req.JobID)
		tesseractResult, err := p.tesseractOCR.Process(ctx, fileData)

		if err == nil {
			log.Printf("[Job %s] Tier 1 complete: confidence=%.2f", req.JobID, tesseractResult.Confidence)

			// SUCCESS: Tesseract confidence >= 0.85 (high quality)
			if tesseractResult.Confidence >= 0.85 {
				log.Printf("[Job %s] ✓ Tesseract quality sufficient (%.2f >= 0.85), using result",
					req.JobID, tesseractResult.Confidence)
				tesseractResult.Duration = time.Since(startTime)
				return tesseractResult, nil
			}

			// LOW CONFIDENCE: Escalate to Tier 2
			log.Printf("[Job %s] ✗ Tesseract confidence low (%.2f < 0.85), escalating to Tier 2 (GPT-4o)",
				req.JobID, tesseractResult.Confidence)
		} else {
			log.Printf("[Job %s] Tier 1 failed: %v, escalating to Tier 2", req.JobID, err)
		}
	} else {
		log.Printf("[Job %s] Tier 1 skipped: Tesseract not available, starting at Tier 2", req.JobID)
	}

	// TIER 2: MageAgent with preferAccuracy=false (GPT-4o, balanced speed/accuracy)
	log.Printf("[Job %s] Tier 2: Attempting MageAgent OCR (preferAccuracy=false → GPT-4o)", req.JobID)

	tier2Result, tier2Err := p.mageAgentClient.ExtractTextFromBytes(
		ctx,
		fileData,
		false, // preferAccuracy=false → GPT-4o (balanced)
		"en",
	)

	if tier2Err == nil {
		log.Printf("[Job %s] Tier 2 complete: model=%s, confidence=%.2f",
			req.JobID, tier2Result.Data.ModelUsed, tier2Result.Data.Confidence)

		// SUCCESS: GPT-4o confidence >= 0.90 (high quality)
		if tier2Result.Data.Confidence >= 0.90 {
			log.Printf("[Job %s] ✓ GPT-4o quality sufficient (%.2f >= 0.90), using result",
				req.JobID, tier2Result.Data.Confidence)

			result := &OCRResult{
				Text:       tier2Result.Data.Text,
				Confidence: tier2Result.Data.Confidence,
				TierUsed:   fmt.Sprintf("tier2_%s", tier2Result.Data.ModelUsed),
				Model:      tier2Result.Data.ModelUsed,
				Cost:       0.0, // Cost tracking in MageAgent
				Duration:   time.Since(startTime),
			ImageData:  fileData, // Store for layout analysis
				Pages: []OCRPage{
					{
						PageNumber: 1,
						Text:       tier2Result.Data.Text,
						Confidence: tier2Result.Data.Confidence,
						Words:      []OCRWord{},
					},
				},
			}
			return result, nil
		}

		// LOW CONFIDENCE: Escalate to Tier 3
		log.Printf("[Job %s] ✗ GPT-4o confidence low (%.2f < 0.90), escalating to Tier 3 (Claude Opus)",
			req.JobID, tier2Result.Data.Confidence)
	} else {
		log.Printf("[Job %s] Tier 2 failed: %v, escalating to Tier 3", req.JobID, tier2Err)
	}

	// TIER 3: MageAgent with preferAccuracy=true (Claude Opus, highest accuracy)
	log.Printf("[Job %s] Tier 3: Attempting MageAgent OCR (preferAccuracy=true → Claude Opus)", req.JobID)

	tier3Result, tier3Err := p.mageAgentClient.ExtractTextFromBytes(
		ctx,
		fileData,
		true, // preferAccuracy=true → Claude Opus (highest accuracy)
		"en",
	)

	if tier3Err != nil {
		// ALL TIERS FAILED
		log.Printf("[Job %s] ✗ All OCR tiers failed. Tier1=%v, Tier2=%v, Tier3=%v",
			req.JobID, "attempted", tier2Err, tier3Err)
		return nil, fmt.Errorf("all OCR tiers failed: tier2=%w, tier3=%v", tier2Err, tier3Err)
	}

	// SUCCESS: Claude Opus result (highest accuracy, accept any confidence)
	log.Printf("[Job %s] ✓ Tier 3 complete: model=%s, confidence=%.2f (highest accuracy tier)",
		req.JobID, tier3Result.Data.ModelUsed, tier3Result.Data.Confidence)

	result := &OCRResult{
		Text:       tier3Result.Data.Text,
		Confidence: tier3Result.Data.Confidence,
		TierUsed:   fmt.Sprintf("tier3_%s", tier3Result.Data.ModelUsed),
		Model:      tier3Result.Data.ModelUsed,
		Cost:       0.0, // Cost tracking in MageAgent
		Duration:   time.Since(startTime),
			ImageData:  fileData, // Store for layout analysis
		Pages: []OCRPage{
			{
				PageNumber: 1,
				Text:       tier3Result.Data.Text,
				Confidence: tier3Result.Data.Confidence,
				Words:      []OCRWord{},
			},
		},
	}

	log.Printf("[Job %s] OCR cascade complete: tier=3, model=%s, confidence=%.2f, duration=%v",
		req.JobID, result.Model, result.Confidence, result.Duration)

	return result, nil
}

// shouldPreferAccuracy determines if high accuracy OCR is needed based on file characteristics
func (p *DocumentProcessor) shouldPreferAccuracy(req *ProcessRequest) bool {
	// Large files may need higher accuracy to avoid loss of important details
	if req.FileSize > 5*1024*1024 { // > 5MB
		return true
	}

	// PDFs often contain important structured content
	if req.MimeType == "application/pdf" {
		return true
	}

	// Check metadata for explicit accuracy preference
	if req.Metadata != nil {
		if accuracy, ok := req.Metadata["preferAccuracy"].(bool); ok {
			return accuracy
		}
	}

	// Default to balanced speed/accuracy
	return false
}

// requiresOCR determines if a file type requires OCR processing
// Returns true for images and PDFs, false for text-based formats
func (p *DocumentProcessor) requiresOCR(mimeType string) bool {
	// Text-based formats that don't need OCR
	textFormats := map[string]bool{
		"text/plain":                  true,
		"text/html":                   true,
		"text/markdown":               true,
		"text/csv":                    true,
		"application/json":            true,
		"application/xml":             true,
		"text/xml":                    true,
		"application/x-yaml":          true,
		"text/yaml":                   true,
		"application/javascript":      true,
		"text/javascript":             true,
		"application/typescript":      true,
		"text/x-python":               true,
		"text/x-go":                   true,
		"text/x-java-source":          true,
		"text/x-c":                    true,
		"text/x-c++":                  true,
		"text/x-rust":                 true,
		"text/x-shellscript":          true,
		"application/vnd.ms-excel":    false, // Excel needs special handling, but not OCR
		"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": false,
	}

	// Check if it's a text format
	if isText, exists := textFormats[mimeType]; exists {
		return !isText
	}

	// Image formats always need OCR
	if len(mimeType) >= 6 && mimeType[:6] == "image/" {
		return true
	}

	// PDFs need OCR
	if mimeType == "application/pdf" {
		return true
	}

	// Default: assume OCR needed for unknown formats
	return true
}

// extractFullText extracts all text from OCR and layout results
func (p *DocumentProcessor) extractFullText(ocrResult *OCRResult, layoutResult *LayoutResult) string {
	text := ""

	// Extract text from all pages
	for _, page := range ocrResult.Pages {
		text += page.Text + "\n\n"
	}

	return text
}

// detectMimeTypeFromMagicBytes detects the actual MIME type from file content magic bytes
// This is essential when sources like Google Drive return generic "application/octet-stream"
func detectMimeTypeFromMagicBytes(data []byte) string {
	if len(data) < 4 {
		return ""
	}

	// PDF: %PDF-
	if bytes.HasPrefix(data, []byte("%PDF")) {
		return "application/pdf"
	}

	// PNG: 0x89 'P' 'N' 'G' 0x0D 0x0A 0x1A 0x0A
	if len(data) >= 8 && bytes.HasPrefix(data, []byte{0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A}) {
		return "image/png"
	}

	// JPEG: 0xFF 0xD8 0xFF
	if bytes.HasPrefix(data, []byte{0xFF, 0xD8, 0xFF}) {
		return "image/jpeg"
	}

	// GIF: 'G' 'I' 'F' '8' ('7' or '9') 'a'
	if bytes.HasPrefix(data, []byte("GIF87a")) || bytes.HasPrefix(data, []byte("GIF89a")) {
		return "image/gif"
	}

	// WebP: 'R' 'I' 'F' 'F' .... 'W' 'E' 'B' 'P'
	if len(data) > 12 && bytes.HasPrefix(data, []byte("RIFF")) && string(data[8:12]) == "WEBP" {
		return "image/webp"
	}

	// TIFF: 'I' 'I' 0x2A 0x00 (little-endian) or 'M' 'M' 0x00 0x2A (big-endian)
	if bytes.HasPrefix(data, []byte{0x49, 0x49, 0x2A, 0x00}) || bytes.HasPrefix(data, []byte{0x4D, 0x4D, 0x00, 0x2A}) {
		return "image/tiff"
	}

	// BMP: 'B' 'M'
	if bytes.HasPrefix(data, []byte("BM")) {
		return "image/bmp"
	}

	// ZIP (and Office documents, EPUB): 'P' 'K' 0x03 0x04
	if bytes.HasPrefix(data, []byte{0x50, 0x4B, 0x03, 0x04}) {
		// Check for EPUB: The first file in an EPUB is "mimetype" containing "application/epub+zip"
		// EPUB structure: PK 03 04 [local file header] "mimetype" [content: "application/epub+zip"]
		// Look for "mimetypeapplication/epub+zip" pattern in first 100 bytes
		if len(data) >= 50 {
			headerSlice := data[:min(100, len(data))]
			if bytes.Contains(headerSlice, []byte("mimetypeapplication/epub+zip")) {
				return "application/epub+zip"
			}
		}
		// Could be DOCX, XLSX, PPTX, or just ZIP
		// For now, return zip; caller can check filename extension
		return "application/zip"
	}

	// MS Office legacy (DOC, XLS, PPT): 0xD0 0xCF 0x11 0xE0 0xA1 0xB1 0x1A 0xE1
	if len(data) >= 8 && bytes.HasPrefix(data, []byte{0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1}) {
		return "application/msword" // Could be DOC, XLS, PPT - generic MS Office
	}

	return ""
}

// processPDFViaMageAgent routes PDF files to MageAgent's /file-process endpoint
// This endpoint handles PDF → image conversion internally, unlike /vision/extract-text
func (p *DocumentProcessor) processPDFViaMageAgent(ctx context.Context, req *ProcessRequest, fileData []byte) (*OCRResult, error) {
	log.Printf("[Job %s] Processing PDF via MageAgent /file-process endpoint", req.JobID)

	startTime := time.Now()

	// Call MageAgent /file-process endpoint which handles PDF conversion internally
	fileProcessResult, err := p.mageAgentClient.ProcessFile(ctx, &clients.FileProcessRequest{
		FileBuffer: fileData,
		Filename:   req.Filename,
		MimeType:   "application/pdf",
		Operations: []string{"extract_content", "extract_tables"},
		Options: clients.FileProcessOptions{
			EnableOCR:     true,
			ExtractTables: true,
		},
	})

	if err != nil {
		return nil, fmt.Errorf("MageAgent /file-process failed: %w", err)
	}

	log.Printf("[Job %s] MageAgent /file-process complete: pages=%d, confidence=%.2f",
		req.JobID, fileProcessResult.Data.PageCount, fileProcessResult.Data.Confidence)

	// Convert FileProcessResult to OCRResult for pipeline compatibility
	pages := make([]OCRPage, 0)
	for i, pageContent := range fileProcessResult.Data.Pages {
		pages = append(pages, OCRPage{
			PageNumber: i + 1,
			Text:       pageContent.Text,
			Confidence: pageContent.Confidence,
			Words:      []OCRWord{},
		})
	}

	// If no pages returned, create single page from full text
	if len(pages) == 0 {
		pages = append(pages, OCRPage{
			PageNumber: 1,
			Text:       fileProcessResult.Data.Text,
			Confidence: fileProcessResult.Data.Confidence,
			Words:      []OCRWord{},
		})
	}

	result := &OCRResult{
		Text:       fileProcessResult.Data.Text,
		Confidence: fileProcessResult.Data.Confidence,
		TierUsed:   "mageagent_file_process",
		Model:      fileProcessResult.Data.ModelUsed,
		Duration:   time.Since(startTime),
		Pages:      pages,
	}

	return result, nil
}

// processDocumentViaMageAgent routes document files (EPUB, DOCX, etc.) to MageAgent's /file-process endpoint
// This is a generic handler for non-image, non-PDF documents that need specialized processing
func (p *DocumentProcessor) processDocumentViaMageAgent(ctx context.Context, req *ProcessRequest, fileData []byte, mimeType string) (*OCRResult, error) {
	log.Printf("[Job %s] Processing document via MageAgent /file-process endpoint (mime: %s)", req.JobID, mimeType)

	startTime := time.Now()

	// Call MageAgent /file-process endpoint which handles document conversion internally
	fileProcessResult, err := p.mageAgentClient.ProcessFile(ctx, &clients.FileProcessRequest{
		FileBuffer: fileData,
		Filename:   req.Filename,
		MimeType:   mimeType,
		Operations: []string{"extract_content"},
		Options: clients.FileProcessOptions{
			EnableOCR:     false, // EPUB doesn't need OCR - it's text-based
			ExtractTables: false,
		},
	})

	if err != nil {
		return nil, fmt.Errorf("MageAgent /file-process failed: %w", err)
	}

	log.Printf("[Job %s] MageAgent /file-process complete: pages=%d, confidence=%.2f, model=%s",
		req.JobID, fileProcessResult.Data.PageCount, fileProcessResult.Data.Confidence, fileProcessResult.Data.ModelUsed)

	// Convert FileProcessResult to OCRResult for pipeline compatibility
	pages := make([]OCRPage, 0)
	for i, pageContent := range fileProcessResult.Data.Pages {
		pages = append(pages, OCRPage{
			PageNumber: i + 1,
			Text:       pageContent.Text,
			Confidence: pageContent.Confidence,
			Words:      []OCRWord{},
		})
	}

	// If no pages returned, create single page from full text
	if len(pages) == 0 {
		pages = append(pages, OCRPage{
			PageNumber: 1,
			Text:       fileProcessResult.Data.Text,
			Confidence: fileProcessResult.Data.Confidence,
			Words:      []OCRWord{},
		})
	}

	documentResult := &OCRResult{
		Text:       fileProcessResult.Data.Text,
		Confidence: fileProcessResult.Data.Confidence,
		TierUsed:   "mageagent_file_process",
		Model:      fileProcessResult.Data.ModelUsed,
		Duration:   time.Since(startTime),
		Pages:      pages,
	}

	return documentResult, nil
}
