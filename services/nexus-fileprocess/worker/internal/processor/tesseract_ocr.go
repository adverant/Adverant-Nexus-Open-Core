/**
 * Tesseract OCR - Fallback for offline/fast processing
 *
 * Simple, free, offline OCR using Tesseract.
 * Used as fallback when MageAgent is unavailable or for speed-optimized processing.
 */

package processor

import (
	"context"
	"fmt"
	"strings"
	"time"

	"github.com/otiai10/gosseract/v2"
)

// TesseractOCR handles basic OCR using Tesseract
type TesseractOCR struct {
	tesseractPath string
}

// TesseractConfig holds Tesseract configuration
type TesseractConfig struct {
	TesseractPath string
}

// NewTesseractOCR creates a new Tesseract OCR instance
func NewTesseractOCR(cfg *TesseractConfig) (*TesseractOCR, error) {
	if cfg.TesseractPath == "" {
		cfg.TesseractPath = "/usr/bin/tesseract"
	}

	return &TesseractOCR{
		tesseractPath: cfg.TesseractPath,
	}, nil
}

// Process performs OCR using Tesseract
func (t *TesseractOCR) Process(ctx context.Context, fileData []byte) (*OCRResult, error) {
	startTime := time.Now()

	// Create Tesseract client
	client := gosseract.NewClient()
	defer client.Close()

	// Set image from bytes
	if err := client.SetImageFromBytes(fileData); err != nil {
		return nil, fmt.Errorf("failed to set image: %w", err)
	}

	// Extract text
	text, err := client.Text()
	if err != nil {
		return nil, fmt.Errorf("tesseract OCR failed: %w", err)
	}

	// Calculate confidence based on text quality indicators
	confidence := calculateTesseractConfidence(text)

	// Build result
	result := &OCRResult{
		Text:       text,
		Confidence: confidence,
		TierUsed:   "tesseract",
		Model:      "tesseract-local",
		Cost:       0.0, // Tesseract is free
		Duration:   time.Since(startTime),
		Pages: []OCRPage{
			{
				PageNumber: 1,
				Text:       text,
				Confidence: confidence,
				Words:      []OCRWord{}, // Word-level extraction requires HOCR parsing
			},
		},
	}

	return result, nil
}

// calculateTesseractConfidence estimates confidence based on text quality
func calculateTesseractConfidence(text string) float64 {
	// Dynamic confidence calculation based on text quality
	confidence := 0.5 // Base confidence

	// Check text length
	if len(text) > 1000 {
		confidence += 0.1
	}
	if len(text) > 5000 {
		confidence += 0.1
	}

	// Check for coherent words (simple heuristic)
	words := strings.Fields(text)
	if len(words) > 100 {
		confidence += 0.1
	}

	// Check for reasonable character distribution
	alphaCount := 0
	for _, r := range text {
		if (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') {
			alphaCount++
		}
	}
	if len(text) > 0 {
		alphaRatio := float64(alphaCount) / float64(len(text))
		if alphaRatio > 0.5 && alphaRatio < 0.9 {
			confidence += 0.1
		}
	}

	// Cap at reasonable maximum for Tesseract
	if confidence > 0.85 {
		confidence = 0.85
	}

	return confidence
}
