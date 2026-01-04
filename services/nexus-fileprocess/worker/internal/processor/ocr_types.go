/**
 * OCR Types - Shared data structures for OCR operations
 *
 * Common types used by both MageAgent OCR and Tesseract fallback
 */

package processor

import (
	"time"
)

// OCRResult represents the result of OCR processing
type OCRResult struct {
	Text       string
	Confidence float64
	Pages      []OCRPage
	TierUsed   string  // Which OCR method was used (model name or "tesseract")
	Model      string  // Specific model used (for MageAgent)
	Cost       float64 // Cost of OCR operation (if applicable)
	Duration   time.Duration
	ImageData  []byte  // Original image data for layout analysis (optional)
}

// OCRPage represents a single page of OCR results
type OCRPage struct {
	PageNumber int
	Text       string
	Confidence float64
	Words      []OCRWord
}

// OCRWord represents a single word with bounding box
type OCRWord struct {
	Text        string
	Confidence  float64
	BoundingBox BoundingBox
}

// BoundingBox represents coordinates of a region
type BoundingBox struct {
	X      int
	Y      int
	Width  int
	Height int
}
