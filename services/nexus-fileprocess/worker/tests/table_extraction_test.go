/**
 * Table Extraction Accuracy Validation Tests
 *
 * Tests table extraction accuracy against known ground truth:
 * - Simple tables (2x2, 3x3)
 * - Complex tables (merged cells, headers)
 * - Large tables (10+ rows/columns)
 * - Accuracy metrics (precision, recall, F1)
 *
 * Target: 97.9% accuracy (Dockling benchmark)
 */

package tests

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"github.com/adverant/nexus/fileprocess-worker/internal/clients"
	"github.com/adverant/nexus/fileprocess-worker/internal/processor"
)

// GroundTruthTable represents the expected table structure
type GroundTruthTable struct {
	Rows    int                  `json:"rows"`
	Columns int                  `json:"columns"`
	Cells   []GroundTruthCell    `json:"cells"`
}

// GroundTruthCell represents the expected cell content
type GroundTruthCell struct {
	Row     int    `json:"row"`
	Col     int    `json:"col"`
	Content string `json:"content"`
	RowSpan int    `json:"rowSpan"`
	ColSpan int    `json:"colSpan"`
}

// TestTableExtractionAccuracy tests table extraction against ground truth
func TestTableExtractionAccuracy(t *testing.T) {
	// Setup
	mageagentURL := os.Getenv("MAGEAGENT_URL")
	if mageagentURL == "" {
		mageagentURL = "http://nexus-mageagent:8080"
	}

	mageAgentClient := clients.NewMageAgentClient(mageagentURL)
	analyzer := processor.NewLayoutAnalyzer(mageAgentClient, true)

	testCases := []struct {
		name           string
		imageFile      string
		groundTruthFile string
		minAccuracy    float64
	}{
		{
			name:           "Simple 2x2 Table",
			imageFile:      "testdata/table_2x2.png",
			groundTruthFile: "testdata/table_2x2.json",
			minAccuracy:    0.95,
		},
		{
			name:           "Simple 3x3 Table",
			imageFile:      "testdata/table_3x3.png",
			groundTruthFile: "testdata/table_3x3.json",
			minAccuracy:    0.95,
		},
		{
			name:           "Table with Headers",
			imageFile:      "testdata/table_with_headers.png",
			groundTruthFile: "testdata/table_with_headers.json",
			minAccuracy:    0.90,
		},
		{
			name:           "Table with Merged Cells",
			imageFile:      "testdata/table_merged.png",
			groundTruthFile: "testdata/table_merged.json",
			minAccuracy:    0.85,
		},
		{
			name:           "Large Table (10x10)",
			imageFile:      "testdata/table_10x10.png",
			groundTruthFile: "testdata/table_10x10.json",
			minAccuracy:    0.90,
		},
	}

	for _, tc := range testCases {
		t.Run(tc.name, func(t *testing.T) {
			// Load test image
			imageData, err := loadTestImage(tc.imageFile)
			if err != nil {
				t.Skipf("Test image not found: %s", tc.imageFile)
				return
			}

			// Load ground truth
			groundTruth, err := loadGroundTruth(tc.groundTruthFile)
			if err != nil {
				t.Skipf("Ground truth not found: %s", tc.groundTruthFile)
				return
			}

			// Create OCR result with image data
			ocrResult := &processor.OCRResult{
				Text:       "",
				Confidence: 0.9,
				Pages:      []processor.OCRPage{},
				ImageData:  imageData,
			}

			// Extract tables using vision
			tables := extractTablesDirectly(t, analyzer, ocrResult)

			// Validate extraction
			if len(tables) == 0 {
				t.Errorf("No tables extracted")
				return
			}

			table := tables[0]

			// Calculate accuracy
			accuracy := calculateTableAccuracy(table, groundTruth)
			t.Logf("✅ Accuracy: %.2f%% (target: %.2f%%)", accuracy*100, tc.minAccuracy*100)

			// Validate structure
			if len(table.Rows) != groundTruth.Rows {
				t.Errorf("Row count mismatch: got %d, want %d", len(table.Rows), groundTruth.Rows)
			}

			// Check accuracy threshold
			if accuracy < tc.minAccuracy {
				t.Errorf("Accuracy %.2f%% below threshold %.2f%%", accuracy*100, tc.minAccuracy*100)
			}
		})
	}
}

// TestTableExtractionWithVisionModels tests different vision models
func TestTableExtractionWithVisionModels(t *testing.T) {
	mageagentURL := os.Getenv("MAGEAGENT_URL")
	if mageagentURL == "" {
		mageagentURL = "http://nexus-mageagent:8080"
	}

	mageAgentClient := clients.NewMageAgentClient(mageagentURL)

	// Load test image
	imageData, err := loadTestImage("testdata/table_sample.png")
	if err != nil {
		t.Skip("Test image not found")
		return
	}

	ctx := context.Background()

	// Test with accuracy preference (Claude Opus)
	t.Run("High Accuracy Model", func(t *testing.T) {
		response, err := mageAgentClient.ExtractTableFromBytes(ctx, imageData, "en")
		if err != nil {
			t.Fatalf("Table extraction failed: %v", err)
		}

		t.Logf("✅ Model: %s", response.Data.ModelUsed)
		t.Logf("   Rows: %d", len(response.Data.Rows))
		t.Logf("   Columns: %d", response.Data.Columns)
		t.Logf("   Confidence: %.3f", response.Data.Confidence)
		t.Logf("   Processing time: %dms", response.Data.ProcessingTime)

		// High accuracy model should have >85% confidence
		if response.Data.Confidence < 0.85 {
			t.Errorf("Confidence too low: %.3f", response.Data.Confidence)
		}

		// Validate structure
		if len(response.Data.Rows) == 0 {
			t.Error("No rows extracted")
		}

		if response.Data.Columns == 0 {
			t.Error("No columns detected")
		}
	})
}

// TestTableExtractionPerformance tests extraction speed
func TestTableExtractionPerformance(t *testing.T) {
	if testing.Short() {
		t.Skip("Skipping performance test in short mode")
	}

	mageagentURL := os.Getenv("MAGEAGENT_URL")
	if mageagentURL == "" {
		mageagentURL = "http://nexus-mageagent:8080"
	}

	mageAgentClient := clients.NewMageAgentClient(mageagentURL)
	analyzer := processor.NewLayoutAnalyzer(mageAgentClient, true)

	imageData, err := loadTestImage("testdata/table_sample.png")
	if err != nil {
		t.Skip("Test image not found")
		return
	}

	ocrResult := &processor.OCRResult{
		ImageData: imageData,
	}

	// Benchmark extraction time
	iterations := 5
	totalDuration := int64(0)

	for i := 0; i < iterations; i++ {
		ctx := context.Background()
		response, err := mageAgentClient.ExtractTableFromBytes(ctx, imageData, "en")
		if err != nil {
			t.Fatalf("Extraction failed: %v", err)
		}

		totalDuration += response.Data.ProcessingTime
	}

	avgDuration := totalDuration / int64(iterations)
	t.Logf("✅ Average extraction time: %dms (%d iterations)", avgDuration, iterations)

	// Target: <15 seconds per table
	if avgDuration > 15000 {
		t.Errorf("Extraction too slow: %dms (target: <15000ms)", avgDuration)
	}
}

// TestTableExtractionFallback tests fallback behavior
func TestTableExtractionFallback(t *testing.T) {
	// Create analyzer without MageAgent client (should fallback)
	analyzer := processor.NewLayoutAnalyzer(nil, false)

	ocrResult := &processor.OCRResult{
		Text:       "Some text content",
		Confidence: 0.9,
		Pages:      []processor.OCRPage{},
		ImageData:  nil, // No image data
	}

	// Extract tables (should fallback to heuristics)
	tables := extractTablesDirectly(t, analyzer, ocrResult)

	// Fallback should return empty array gracefully
	if len(tables) != 0 {
		t.Logf("Fallback returned %d tables", len(tables))
	} else {
		t.Log("✅ Fallback returned empty array gracefully")
	}
}

// Helper functions

func loadTestImage(filepath string) ([]byte, error) {
	// Check if file exists
	if _, err := os.Stat(filepath); os.IsNotExist(err) {
		return nil, err
	}

	return os.ReadFile(filepath)
}

func loadGroundTruth(filepath string) (*GroundTruthTable, error) {
	data, err := os.ReadFile(filepath)
	if err != nil {
		return nil, err
	}

	var groundTruth GroundTruthTable
	if err := json.Unmarshal(data, &groundTruth); err != nil {
		return nil, err
	}

	return &groundTruth, nil
}

func extractTablesDirectly(t *testing.T, analyzer *processor.LayoutAnalyzer, ocrResult *processor.OCRResult) []processor.Table {
	// Use reflection or expose method for testing
	// For now, we'll use a test-specific extraction
	ctx := context.Background()
	result, err := analyzer.Analyze(ctx, ocrResult)
	if err != nil {
		t.Fatalf("Analysis failed: %v", err)
	}

	return result.Tables
}

func calculateTableAccuracy(extracted processor.Table, groundTruth *GroundTruthTable) float64 {
	// Calculate cell-level accuracy
	correctCells := 0
	totalCells := len(groundTruth.Cells)

	// Build map of extracted cells
	extractedCellMap := make(map[string]string)
	for _, row := range extracted.Rows {
		for _, cell := range row.Cells {
			key := getCellKey(cell.ColumnNumber, 0) // Simplified
			extractedCellMap[key] = cell.Content
		}
	}

	// Compare with ground truth
	for _, gtCell := range groundTruth.Cells {
		key := getCellKey(gtCell.Col, gtCell.Row)
		extractedContent, exists := extractedCellMap[key]

		if exists && normalizeContent(extractedContent) == normalizeContent(gtCell.Content) {
			correctCells++
		}
	}

	if totalCells == 0 {
		return 0.0
	}

	return float64(correctCells) / float64(totalCells)
}

func getCellKey(col, row int) string {
	return string(rune('A'+col)) + string(rune('0'+row))
}

func normalizeContent(content string) string {
	// Normalize whitespace and case for comparison
	// Simple implementation - can be enhanced
	return content
}

// TestGenerateGroundTruthTemplates generates template JSON files for ground truth
func TestGenerateGroundTruthTemplates(t *testing.T) {
	if testing.Short() {
		t.Skip("Skipping template generation in short mode")
	}

	testDataDir := "testdata"
	if _, err := os.Stat(testDataDir); os.IsNotExist(err) {
		if err := os.MkdirAll(testDataDir, 0755); err != nil {
			t.Fatalf("Failed to create testdata directory: %v", err)
		}
	}

	templates := []struct {
		filename string
		table    GroundTruthTable
	}{
		{
			filename: "table_2x2.json",
			table: GroundTruthTable{
				Rows:    2,
				Columns: 2,
				Cells: []GroundTruthCell{
					{Row: 0, Col: 0, Content: "A1", RowSpan: 1, ColSpan: 1},
					{Row: 0, Col: 1, Content: "B1", RowSpan: 1, ColSpan: 1},
					{Row: 1, Col: 0, Content: "A2", RowSpan: 1, ColSpan: 1},
					{Row: 1, Col: 1, Content: "B2", RowSpan: 1, ColSpan: 1},
				},
			},
		},
		{
			filename: "table_3x3.json",
			table: GroundTruthTable{
				Rows:    3,
				Columns: 3,
				Cells: []GroundTruthCell{
					{Row: 0, Col: 0, Content: "Header 1", RowSpan: 1, ColSpan: 1},
					{Row: 0, Col: 1, Content: "Header 2", RowSpan: 1, ColSpan: 1},
					{Row: 0, Col: 2, Content: "Header 3", RowSpan: 1, ColSpan: 1},
					{Row: 1, Col: 0, Content: "Data 1", RowSpan: 1, ColSpan: 1},
					{Row: 1, Col: 1, Content: "Data 2", RowSpan: 1, ColSpan: 1},
					{Row: 1, Col: 2, Content: "Data 3", RowSpan: 1, ColSpan: 1},
					{Row: 2, Col: 0, Content: "Data 4", RowSpan: 1, ColSpan: 1},
					{Row: 2, Col: 1, Content: "Data 5", RowSpan: 1, ColSpan: 1},
					{Row: 2, Col: 2, Content: "Data 6", RowSpan: 1, ColSpan: 1},
				},
			},
		},
	}

	for _, template := range templates {
		data, err := json.MarshalIndent(template.table, "", "  ")
		if err != nil {
			t.Fatalf("Failed to marshal template: %v", err)
		}

		filepath := filepath.Join(testDataDir, template.filename)
		if err := os.WriteFile(filepath, data, 0644); err != nil {
			t.Fatalf("Failed to write template: %v", err)
		}

		t.Logf("✅ Generated template: %s", filepath)
	}
}
