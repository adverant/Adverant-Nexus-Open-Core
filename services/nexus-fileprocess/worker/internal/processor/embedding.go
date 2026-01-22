/**
 * Embedding Client for FileProcessAgent
 *
 * Generates VoyageAI voyage-3 embeddings (1024 dimensions) for Document DNA semantic layer.
 */

package processor

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

// EmbeddingClient handles VoyageAI embedding generation
type EmbeddingClient struct {
	apiKey     string
	httpClient *http.Client
	baseURL    string
}

// VoyageEmbeddingRequest represents the request to VoyageAI API (single text)
type VoyageEmbeddingRequest struct {
	Input string `json:"input"`
	Model string `json:"model"`
}

// VoyageBatchEmbeddingRequest represents a batch request to VoyageAI API (multiple texts)
type VoyageBatchEmbeddingRequest struct {
	Input []string `json:"input"` // Array of texts for batch processing
	Model string   `json:"model"`
}

// VoyageEmbeddingResponse represents the response from VoyageAI API
type VoyageEmbeddingResponse struct {
	Data []struct {
		Embedding []float32 `json:"embedding"`
		Index     int       `json:"index"`
	} `json:"data"`
	Model string `json:"model"`
	Usage struct {
		TotalTokens int `json:"total_tokens"`
	} `json:"usage"`
}

// NewEmbeddingClient creates a new embedding client
func NewEmbeddingClient(apiKey string) (*EmbeddingClient, error) {
	if apiKey == "" {
		return nil, fmt.Errorf("VoyageAI API key is required")
	}

	return &EmbeddingClient{
		apiKey:  apiKey,
		baseURL: "https://api.voyageai.com/v1/embeddings",
		httpClient: &http.Client{
			Timeout: 30 * time.Second,
		},
	}, nil
}

// GenerateEmbedding generates a 1024-dimensional embedding for the given text
func (e *EmbeddingClient) GenerateEmbedding(ctx context.Context, text string) ([]float32, error) {
	if text == "" {
		return nil, fmt.Errorf("text is required")
	}

	log.Printf("Generating VoyageAI embedding (model: voyage-3, dimensions: 1024)")

	// Truncate text if too long (VoyageAI has token limits)
	maxChars := 16000 // Approximate limit
	if len(text) > maxChars {
		log.Printf("Warning: Text too long (%d chars), truncating to %d chars", len(text), maxChars)
		text = text[:maxChars]
	}

	// Build request
	reqBody := VoyageEmbeddingRequest{
		Input: text,
		Model: "voyage-3",
	}

	jsonData, err := json.Marshal(reqBody)
	if err != nil {
		return nil, fmt.Errorf("failed to marshal request: %w", err)
	}

	// Create HTTP request
	req, err := http.NewRequestWithContext(ctx, "POST", e.baseURL, bytes.NewBuffer(jsonData))
	if err != nil {
		return nil, fmt.Errorf("failed to create request: %w", err)
	}

	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", fmt.Sprintf("Bearer %s", e.apiKey))

	// Send request
	startTime := time.Now()
	resp, err := e.httpClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("request failed: %w", err)
	}
	defer resp.Body.Close()

	duration := time.Since(startTime)

	// Read response
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, fmt.Errorf("failed to read response: %w", err)
	}

	// Check status code
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("VoyageAI API returned status %d: %s", resp.StatusCode, string(body))
	}

	// Parse response
	var voyageResp VoyageEmbeddingResponse
	if err := json.Unmarshal(body, &voyageResp); err != nil {
		return nil, fmt.Errorf("failed to parse response: %w", err)
	}

	// Extract embedding
	if len(voyageResp.Data) == 0 {
		return nil, fmt.Errorf("no embedding data in response")
	}

	embedding := voyageResp.Data[0].Embedding

	log.Printf("VoyageAI embedding generated: dimensions=%d, tokens=%d, duration=%v",
		len(embedding), voyageResp.Usage.TotalTokens, duration)

	// Validate embedding dimensions
	if len(embedding) != 1024 {
		return nil, fmt.Errorf("unexpected embedding dimensions: got %d, expected 1024", len(embedding))
	}

	return embedding, nil
}

// GenerateEmbeddingBatch generates embeddings for multiple texts using VoyageAI batch API
// Implements chunking at 100 texts per batch (VoyageAI API limit)
// Falls back to individual processing if batch API fails
func (e *EmbeddingClient) GenerateEmbeddingBatch(ctx context.Context, texts []string) ([][]float32, error) {
	if len(texts) == 0 {
		return nil, fmt.Errorf("no texts provided")
	}

	log.Printf("Generating batch embeddings for %d texts (VoyageAI voyage-3, batch size: 100)", len(texts))

	// VoyageAI batch API limit: 100 texts per request
	const batchSize = 100
	allEmbeddings := make([][]float32, 0, len(texts))

	// Process in batches of 100
	for i := 0; i < len(texts); i += batchSize {
		end := i + batchSize
		if end > len(texts) {
			end = len(texts)
		}

		batch := texts[i:end]
		log.Printf("Processing batch %d-%d of %d texts", i, end-1, len(texts))

		// Attempt batch API call
		batchEmbeddings, err := e.generateBatchInternal(ctx, batch)
		if err != nil {
			log.Printf("Batch API call failed for texts %d-%d: %v, falling back to individual processing", i, end-1, err)

			// Fallback: Process individually
			for j, text := range batch {
				embedding, err := e.GenerateEmbedding(ctx, text)
				if err != nil {
					return nil, fmt.Errorf("failed to generate embedding for text %d (fallback): %w", i+j, err)
				}
				allEmbeddings = append(allEmbeddings, embedding)
			}
		} else {
			allEmbeddings = append(allEmbeddings, batchEmbeddings...)
		}
	}

	log.Printf("Batch embedding generation complete: %d embeddings generated", len(allEmbeddings))
	return allEmbeddings, nil
}

// generateBatchInternal makes the actual batch API call to VoyageAI
func (e *EmbeddingClient) generateBatchInternal(ctx context.Context, texts []string) ([][]float32, error) {
	// Truncate texts if too long
	maxChars := 16000
	truncatedTexts := make([]string, len(texts))
	for i, text := range texts {
		if len(text) > maxChars {
			log.Printf("Warning: Text %d too long (%d chars), truncating to %d chars", i, len(text), maxChars)
			truncatedTexts[i] = text[:maxChars]
		} else {
			truncatedTexts[i] = text
		}
	}

	// Build batch request
	reqBody := VoyageBatchEmbeddingRequest{
		Input: truncatedTexts,
		Model: "voyage-3",
	}

	jsonData, err := json.Marshal(reqBody)
	if err != nil {
		return nil, fmt.Errorf("failed to marshal batch request: %w", err)
	}

	// Create HTTP request
	req, err := http.NewRequestWithContext(ctx, "POST", e.baseURL, bytes.NewBuffer(jsonData))
	if err != nil {
		return nil, fmt.Errorf("failed to create batch request: %w", err)
	}

	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", fmt.Sprintf("Bearer %s", e.apiKey))

	// Send request
	startTime := time.Now()
	resp, err := e.httpClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("batch request failed: %w", err)
	}
	defer resp.Body.Close()

	duration := time.Since(startTime)

	// Read response
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, fmt.Errorf("failed to read batch response: %w", err)
	}

	// Check status code
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("VoyageAI batch API returned status %d: %s", resp.StatusCode, string(body))
	}

	// Parse response
	var voyageResp VoyageEmbeddingResponse
	if err := json.Unmarshal(body, &voyageResp); err != nil {
		return nil, fmt.Errorf("failed to parse batch response: %w", err)
	}

	// Extract embeddings (sorted by index)
	if len(voyageResp.Data) != len(texts) {
		return nil, fmt.Errorf("unexpected number of embeddings: got %d, expected %d", len(voyageResp.Data), len(texts))
	}

	embeddings := make([][]float32, len(texts))
	for _, data := range voyageResp.Data {
		if data.Index < 0 || data.Index >= len(texts) {
			return nil, fmt.Errorf("invalid embedding index: %d", data.Index)
		}
		embeddings[data.Index] = data.Embedding

		// Validate embedding dimensions
		if len(data.Embedding) != 1024 {
			return nil, fmt.Errorf("unexpected embedding dimensions for text %d: got %d, expected 1024", data.Index, len(data.Embedding))
		}
	}

	log.Printf("VoyageAI batch embedding complete: %d texts, %d tokens, duration=%v",
		len(texts), voyageResp.Usage.TotalTokens, duration)

	return embeddings, nil
}
