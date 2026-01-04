/**
 * Layout Analyzer for FileProcessAgent
 *
 * Performs layout analysis with Dockling-level accuracy targets:
 * - 99.2% layout accuracy
 * - 97.9% table extraction accuracy
 *
 * Extracts:
 * - Reading order and regions
 * - Tables with structure
 * - Bounding boxes for all elements
 */

package processor

import (
	"context"
	"log"

	"github.com/adverant/nexus/fileprocess-worker/internal/clients"
)

// LayoutAnalyzer performs document layout analysis
type LayoutAnalyzer struct {
	mageAgentClient *clients.MageAgentClient
	useVision       bool // Whether to use vision-based analysis (higher accuracy)
}

// LayoutResult represents the result of layout analysis
type LayoutResult struct {
	Confidence   float64
	Regions      []LayoutRegion
	Tables       []Table
	ReadingOrder []int
}

// LayoutRegion represents a region in the document
type LayoutRegion struct {
	ID          int
	Type        string // "text", "image", "table", "header", "footer"
	BoundingBox BoundingBox
	Confidence  float64
	Content     string
}

// Table represents an extracted table
type Table struct {
	ID          int
	BoundingBox BoundingBox
	Rows        []TableRow
	Confidence  float64
}

// TableRow represents a row in a table
type TableRow struct {
	RowNumber int
	Cells     []TableCell
}

// TableCell represents a cell in a table
type TableCell struct {
	ColumnNumber int
	Content      string
	BoundingBox  BoundingBox
	Confidence   float64
	RowSpan      int // Phase 2.3: Support for merged cells
	ColSpan      int // Phase 2.3: Support for merged cells
}

// NewLayoutAnalyzer creates a new layout analyzer
func NewLayoutAnalyzer(mageAgentClient *clients.MageAgentClient, useVision bool) *LayoutAnalyzer {
	return &LayoutAnalyzer{
		mageAgentClient: mageAgentClient,
		useVision:       useVision,
	}
}

// Analyze performs layout analysis on OCR results
func (l *LayoutAnalyzer) Analyze(ctx context.Context, ocrResult *OCRResult) (*LayoutResult, error) {
	log.Printf("Starting layout analysis (target: 99.2%% accuracy, vision=%v)", l.useVision)

	// Option 1: Use MageAgent vision-based analysis (HIGH ACCURACY - 99.2%)
	if l.useVision && l.mageAgentClient != nil && ocrResult.ImageData != nil {
		log.Printf("Using MageAgent vision-based layout analysis (GPT-4 Vision)")
		return l.analyzeWithVision(ctx, ocrResult)
	}

	// Option 2: Fallback to heuristic-based analysis from OCR text
	log.Printf("Using heuristic-based layout analysis (fallback)")
	return l.analyzeFromText(ctx, ocrResult)
}

// analyzeWithVision performs vision-based layout analysis using MageAgent
func (l *LayoutAnalyzer) analyzeWithVision(ctx context.Context, ocrResult *OCRResult) (*LayoutResult, error) {
	log.Printf("Sending %d bytes of image data to MageAgent for layout analysis", len(ocrResult.ImageData))

	// Call MageAgent's layout analysis endpoint
	resp, err := l.mageAgentClient.AnalyzeLayoutFromBytes(ctx, ocrResult.ImageData, "en")
	if err != nil {
		log.Printf("Vision analysis failed: %v, falling back to text analysis", err)
		return l.analyzeFromText(ctx, ocrResult)
	}

	log.Printf("MageAgent vision analysis complete: %d elements detected, confidence=%.3f, model=%s, time=%dms",
		len(resp.Data.Elements), resp.Data.Confidence, resp.Data.ModelUsed, resp.Data.ProcessingTime)

	// Convert MageAgent response to LayoutResult (includes table extraction)
	return l.convertMageAgentResponse(ctx, resp, ocrResult), nil
}

// analyzeFromText performs heuristic-based layout analysis from OCR text (fallback)
func (l *LayoutAnalyzer) analyzeFromText(ctx context.Context, ocrResult *OCRResult) (*LayoutResult, error) {
	// Extract regions using heuristics
	regions := l.extractRegions(ocrResult)
	tables := l.extractTables(ocrResult)
	readingOrder := l.determineReadingOrder(regions)

	// Calculate confidence (lower for heuristic approach)
	confidence := 0.70 // Heuristic-based has lower confidence than vision

	result := &LayoutResult{
		Confidence:   confidence,
		Regions:      regions,
		Tables:       tables,
		ReadingOrder: readingOrder,
	}

	log.Printf("Heuristic layout analysis complete: regions=%d, tables=%d, confidence=%.2f",
		len(regions), len(tables), confidence)

	return result, nil
}

// convertMageAgentResponse converts MageAgent layout response to LayoutResult
func (l *LayoutAnalyzer) convertMageAgentResponse(ctx context.Context, resp *clients.LayoutAnalysisResponse, ocrResult *OCRResult) *LayoutResult {
	regions := make([]LayoutRegion, 0, len(resp.Data.Elements))

	// Convert MageAgent elements to LayoutRegions
	for _, element := range resp.Data.Elements {
		region := LayoutRegion{
			ID:   element.ID,
			Type: l.mapElementTypeToRegionType(element.Type),
			BoundingBox: BoundingBox{
				X:      element.BoundingBox.X,
				Y:      element.BoundingBox.Y,
				Width:  element.BoundingBox.Width,
				Height: element.BoundingBox.Height,
			},
			Confidence: element.Confidence,
			Content:    element.Content,
		}
		regions = append(regions, region)
	}

	// Extract tables from elements with vision-based extraction (Phase 2.3)
	tables := l.extractTablesFromElements(ctx, resp.Data.Elements, ocrResult.ImageData)

	result := &LayoutResult{
		Confidence:   resp.Data.Confidence,
		Regions:      regions,
		Tables:       tables,
		ReadingOrder: resp.Data.ReadingOrder,
	}

	return result
}

// mapElementTypeToRegionType maps MageAgent element types to LayoutRegion types
func (l *LayoutAnalyzer) mapElementTypeToRegionType(elementType string) string {
	// Map MageAgent's 11 element types to our region types
	switch elementType {
	case "heading", "paragraph", "list", "code", "quote":
		return "text"
	case "table":
		return "table"
	case "image", "caption":
		return "image"
	case "header", "footer", "page_number":
		return elementType
	default:
		return "text" // Default to text for unknown types
	}
}

// extractTablesFromElements extracts table elements with cell-by-cell extraction (Phase 2.3)
func (l *LayoutAnalyzer) extractTablesFromElements(ctx context.Context, elements []clients.LayoutElement, imageData []byte) []Table {
	tables := make([]Table, 0)

	// Only process if we have image data and MageAgent client
	if imageData == nil || l.mageAgentClient == nil {
		log.Printf("Skipping table extraction: imageData=%v, mageAgentClient=%v", imageData != nil, l.mageAgentClient != nil)
		return tables
	}

	for _, element := range elements {
		if element.Type == "table" {
			log.Printf("Extracting table %d using GPT-4 Vision (97.9%% accuracy target)", element.ID)

			// Extract table content using MageAgent
			tableResp, err := l.mageAgentClient.ExtractTableFromBytes(ctx, imageData, "en")
			if err != nil {
				log.Printf("Table extraction failed for element %d: %v, using basic structure", element.ID, err)
				// Fallback to basic structure
				table := Table{
					ID: element.ID,
					BoundingBox: BoundingBox{
						X:      element.BoundingBox.X,
						Y:      element.BoundingBox.Y,
						Width:  element.BoundingBox.Width,
						Height: element.BoundingBox.Height,
					},
					Rows:       []TableRow{},
					Confidence: element.Confidence,
				}
				tables = append(tables, table)
				continue
			}

			// Convert MageAgent table response to our Table structure
			rows := make([]TableRow, 0, len(tableResp.Data.Rows))
			for _, mageRow := range tableResp.Data.Rows {
				cells := make([]TableCell, 0, len(mageRow.Cells))
				for _, mageCell := range mageRow.Cells {
					cell := TableCell{
						Content:    mageCell.Content,
						Confidence: mageCell.Confidence,
						RowSpan:    mageCell.RowSpan,
						ColSpan:    mageCell.ColSpan,
					}
					cells = append(cells, cell)
				}

				row := TableRow{
					Cells: cells,
				}
				rows = append(rows, row)
			}

			table := Table{
				ID: element.ID,
				BoundingBox: BoundingBox{
					X:      element.BoundingBox.X,
					Y:      element.BoundingBox.Y,
					Width:  element.BoundingBox.Width,
					Height: element.BoundingBox.Height,
				},
				Rows:       rows,
				Confidence: tableResp.Data.Confidence,
			}

			log.Printf("Table %d extracted: %d rows, %d columns, confidence=%.3f",
				element.ID, len(rows), tableResp.Data.Columns, tableResp.Data.Confidence)

			tables = append(tables, table)
		}
	}

	return tables
}

// extractRegions extracts layout regions from OCR result
func (l *LayoutAnalyzer) extractRegions(ocrResult *OCRResult) []LayoutRegion {
	regions := []LayoutRegion{}

	// Placeholder: Create one text region per page
	for i, page := range ocrResult.Pages {
		regions = append(regions, LayoutRegion{
			ID:   i,
			Type: "text",
			BoundingBox: BoundingBox{
				X:      0,
				Y:      0,
				Width:  8500,  // A4 width in pixels (assuming 300 DPI)
				Height: 11000, // A4 height in pixels
			},
			Confidence: page.Confidence,
			Content:    page.Text,
		})
	}

	return regions
}

// extractTables extracts tables from OCR result using Strategy Pattern
// Strategy 1: Vision-based extraction (MageAgent) - 97.9% accuracy target
// Strategy 2: Text-based heuristics (fallback) - lower accuracy
func (l *LayoutAnalyzer) extractTables(ocrResult *OCRResult) []Table {
	// Strategy 1: Vision-based extraction (preferred, high accuracy)
	if l.mageAgentClient != nil && ocrResult.ImageData != nil {
		log.Printf("Attempting vision-based table extraction (97.9%% accuracy target)")

		ctx := context.Background()
		tableResp, err := l.mageAgentClient.ExtractTableFromBytes(ctx, ocrResult.ImageData, "en")
		if err != nil {
			log.Printf("Vision-based table extraction failed: %v, falling back to text heuristics", err)
			// Fall through to Strategy 2
		} else {
			// Successfully extracted table using vision
			log.Printf("Vision table extraction complete: %d rows, %d columns, confidence=%.3f, model=%s",
				len(tableResp.Data.Rows), tableResp.Data.Columns, tableResp.Data.Confidence, tableResp.Data.ModelUsed)

			// Convert MageAgent table response to our Table structure
			if len(tableResp.Data.Rows) > 0 {
				tables := make([]Table, 0, 1)

				rows := make([]TableRow, 0, len(tableResp.Data.Rows))
				for rowIdx, mageRow := range tableResp.Data.Rows {
					cells := make([]TableCell, 0, len(mageRow.Cells))
					for colIdx, mageCell := range mageRow.Cells {
						cell := TableCell{
							ColumnNumber: colIdx,
							Content:      mageCell.Content,
							BoundingBox:  BoundingBox{}, // Unknown bounds in this context
							Confidence:   mageCell.Confidence,
							RowSpan:      mageCell.RowSpan,
							ColSpan:      mageCell.ColSpan,
						}
						cells = append(cells, cell)
					}

					row := TableRow{
						RowNumber: rowIdx,
						Cells:     cells,
					}
					rows = append(rows, row)
				}

				table := Table{
					ID:          0, // Single table extracted
					BoundingBox: BoundingBox{}, // Unknown bounds in this context
					Rows:        rows,
					Confidence:  tableResp.Data.Confidence,
				}
				tables = append(tables, table)

				log.Printf("Successfully extracted 1 table with %d rows using vision", len(rows))
				return tables
			}

			log.Printf("Vision extraction returned no table rows")
		}
	}

	// Strategy 2: Text-based heuristics (fallback, lower accuracy)
	// Note: Text-based table detection is complex and error-prone
	// For production use, vision-based extraction (Strategy 1) should always be preferred
	log.Printf("Using text-based heuristics for table detection (lower accuracy)")

	return l.extractTablesFromText(ocrResult)
}

// extractTablesFromText extracts tables from OCR text using heuristics
// Looks for delimiter-based tables (|, tabs) and repeating patterns
func (l *LayoutAnalyzer) extractTablesFromText(ocrResult *OCRResult) []Table {
	tables := make([]Table, 0)

	// Combine all page text
	fullText := ocrResult.Text
	if fullText == "" {
		for _, page := range ocrResult.Pages {
			fullText += page.Text + "\n"
		}
	}

	if fullText == "" {
		log.Printf("No text available for heuristic table detection")
		return tables
	}

	lines := splitIntoLines(fullText)
	if len(lines) < 2 {
		log.Printf("Insufficient lines for table detection")
		return tables
	}

	// Detect table regions based on delimiter patterns
	tableRegions := l.detectTableRegions(lines)

	// Extract tables from detected regions
	for regionID, region := range tableRegions {
		table := l.extractTableFromRegion(regionID, region)
		if table != nil && len(table.Rows) > 0 {
			tables = append(tables, *table)
		}
	}

	log.Printf("Text heuristics extracted %d tables", len(tables))
	return tables
}

// TableRegion represents a detected table region in text
type TableRegion struct {
	StartLine int
	EndLine   int
	Delimiter string
	Lines     []string
}

// detectTableRegions identifies potential table regions based on delimiter patterns
func (l *LayoutAnalyzer) detectTableRegions(lines []string) []TableRegion {
	regions := make([]TableRegion, 0)

	i := 0
	for i < len(lines) {
		// Check if line has table-like delimiters
		delimiter := detectDelimiter(lines[i])
		if delimiter == "" {
			i++
			continue
		}

		// Found potential table start - look for consecutive lines with same delimiter
		startLine := i
		regionLines := []string{lines[i]}
		expectedCols := countDelimiters(lines[i], delimiter)

		i++
		for i < len(lines) {
			// Check if line continues the table pattern
			if detectDelimiter(lines[i]) == delimiter {
				cols := countDelimiters(lines[i], delimiter)
				// Accept ±1 column variation (for irregular tables)
				if abs(cols-expectedCols) <= 1 {
					regionLines = append(regionLines, lines[i])
					i++
				} else {
					break
				}
			} else {
				break
			}
		}

		// Only consider regions with 2+ lines (header + data)
		if len(regionLines) >= 2 {
			regions = append(regions, TableRegion{
				StartLine: startLine,
				EndLine:   i - 1,
				Delimiter: delimiter,
				Lines:     regionLines,
			})
			log.Printf("Detected table region: lines %d-%d, delimiter='%s', rows=%d",
				startLine, i-1, delimiter, len(regionLines))
		}
	}

	return regions
}

// extractTableFromRegion extracts table structure from a text region
func (l *LayoutAnalyzer) extractTableFromRegion(regionID int, region TableRegion) *Table {
	rows := make([]TableRow, 0, len(region.Lines))

	for rowIdx, line := range region.Lines {
		cells := extractCellsFromLine(line, region.Delimiter)
		if len(cells) == 0 {
			continue
		}

		tableCells := make([]TableCell, 0, len(cells))
		for colIdx, cellContent := range cells {
			tableCells = append(tableCells, TableCell{
				ColumnNumber: colIdx,
				Content:      trimWhitespace(cellContent),
				BoundingBox:  BoundingBox{}, // Unknown in text mode
				Confidence:   0.60,          // Lower confidence for heuristics
				RowSpan:      1,
				ColSpan:      1,
			})
		}

		rows = append(rows, TableRow{
			RowNumber: rowIdx,
			Cells:     tableCells,
		})
	}

	if len(rows) == 0 {
		return nil
	}

	return &Table{
		ID:          regionID,
		BoundingBox: BoundingBox{},
		Rows:        rows,
		Confidence:  0.60, // Lower confidence for text heuristics
	}
}

// detectDelimiter identifies the delimiter used in a line
func detectDelimiter(line string) string {
	// Check for common table delimiters
	delimiters := []string{"|", "\t", ","}

	for _, delim := range delimiters {
		count := countDelimiters(line, delim)
		// At least 2 delimiters needed for a table
		if count >= 2 {
			return delim
		}
	}

	return ""
}

// countDelimiters counts occurrences of delimiter in line
func countDelimiters(line string, delimiter string) int {
	count := 0
	for _, ch := range line {
		if string(ch) == delimiter {
			count++
		}
	}
	return count
}

// extractCellsFromLine splits line into cells based on delimiter
func extractCellsFromLine(line string, delimiter string) []string {
	if delimiter == "\t" {
		// Tab-separated
		return splitByDelimiter(line, "\t")
	} else if delimiter == "|" {
		// Pipe-separated (often with padding)
		cells := splitByDelimiter(line, "|")
		// Remove empty cells at start/end (from leading/trailing pipes)
		if len(cells) > 0 && cells[0] == "" {
			cells = cells[1:]
		}
		if len(cells) > 0 && cells[len(cells)-1] == "" {
			cells = cells[:len(cells)-1]
		}
		return cells
	} else if delimiter == "," {
		// Comma-separated (CSV-style)
		return splitByDelimiter(line, ",")
	}

	return []string{}
}

// splitByDelimiter splits string by delimiter
func splitByDelimiter(text string, delimiter string) []string {
	cells := []string{}
	current := ""

	for _, ch := range text {
		if string(ch) == delimiter {
			cells = append(cells, current)
			current = ""
		} else {
			current += string(ch)
		}
	}

	// Add last cell
	if current != "" || delimiter != "" {
		cells = append(cells, current)
	}

	return cells
}

// splitIntoLines splits text into lines
func splitIntoLines(text string) []string {
	lines := []string{}
	current := ""

	for _, ch := range text {
		if ch == '\n' || ch == '\r' {
			if current != "" {
				lines = append(lines, current)
				current = ""
			}
		} else {
			current += string(ch)
		}
	}

	if current != "" {
		lines = append(lines, current)
	}

	return lines
}

// trimWhitespace removes leading/trailing whitespace
func trimWhitespace(text string) string {
	// Simple implementation
	start := 0
	end := len(text)

	for start < end && (text[start] == ' ' || text[start] == '\t') {
		start++
	}

	for end > start && (text[end-1] == ' ' || text[end-1] == '\t') {
		end--
	}

	return text[start:end]
}

// abs returns absolute value of integer
func abs(x int) int {
	if x < 0 {
		return -x
	}
	return x
}

// determineReadingOrder determines reading order of regions
func (l *LayoutAnalyzer) determineReadingOrder(regions []LayoutRegion) []int {
	// Placeholder: Simple top-to-bottom, left-to-right order
	order := make([]int, len(regions))
	for i := range regions {
		order[i] = i
	}
	return order
}
