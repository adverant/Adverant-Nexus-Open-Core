#!/bin/bash

# Progressive Functional Testing Script
# Tests FileProcessAgent with increasing complexity
# Captures all errors and documents failures

set -e

# Configuration
API_URL="http://157.173.102.118:9099/api/process"
TEST_DIR="./test-files"
RESULTS_FILE="./PROGRESSIVE-TEST-RESULTS.md"
USER_ID="progressive-test-$(date +%s)"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Initialize results file
cat > "$RESULTS_FILE" << EOF
# Progressive Functional Test Results

**Test Date**: $(date -u +"%Y-%m-%d %H:%M:%S UTC")
**API Endpoint**: $API_URL
**Test User**: $USER_ID

---

## Test Execution Log

EOF

# Helper function to test file upload
test_file() {
    local file_path=$1
    local file_name=$(basename "$file_path")
    local description=$2
    local level=$3

    echo -e "\n${YELLOW}[LEVEL $level]${NC} Testing: $file_name - $description"

    # Record test start
    cat >> "$RESULTS_FILE" << EOF

### Test: $file_name
**Description**: $description
**Level**: $level
**File**: $file_path

EOF

    # Upload file
    local start_time=$(date +%s)
    local response=$(curl -s -X POST "$API_URL" \
        -F "file=@$file_path" \
        -F "userId=$USER_ID" \
        -w "\n%{http_code}" \
        --max-time 60 2>&1)

    local end_time=$(date +%s)
    local duration=$((end_time - start_time))

    # Extract HTTP code (last line)
    local http_code=$(echo "$response" | tail -1)
    local response_body=$(echo "$response" | sed '$d')

    # Check result
    if [ "$http_code" == "200" ] || [ "$http_code" == "202" ]; then
        echo -e "${GREEN}✓ PASS${NC} (${duration}s) - HTTP $http_code"

        cat >> "$RESULTS_FILE" << EOF
**Status**: ✅ PASS
**HTTP Code**: $http_code
**Duration**: ${duration}s
**Response**:
\`\`\`json
$response_body
\`\`\`

EOF
    else
        echo -e "${RED}✗ FAIL${NC} (${duration}s) - HTTP $http_code"

        cat >> "$RESULTS_FILE" << EOF
**Status**: ❌ FAIL
**HTTP Code**: $http_code
**Duration**: ${duration}s
**Error Response**:
\`\`\`
$response_body
\`\`\`

EOF
    fi

    # Small delay between tests
    sleep 2
}

# Create test directory
mkdir -p "$TEST_DIR"
cd "$TEST_DIR"

echo "============================================"
echo "  Progressive Functional Testing"
echo "  FileProcessAgent Universal File Processing"
echo "============================================"

# ============================================
# LEVEL 1: Simple Text Files
# ============================================
echo -e "\n${YELLOW}=== LEVEL 1: Simple Text Files ===${NC}"

# Test 1.1: Plain text
echo "Hello, World! This is a test file." > test1-plain.txt
test_file "test1-plain.txt" "Simple plain text file" "1"

# Test 1.2: JSON
cat > test1-data.json << 'EOF'
{
  "name": "Test Data",
  "type": "JSON",
  "items": [1, 2, 3, 4, 5]
}
EOF
test_file "test1-data.json" "Simple JSON file" "1"

# Test 1.3: CSV
cat > test1-data.csv << 'EOF'
name,age,city
Alice,30,New York
Bob,25,San Francisco
Charlie,35,Boston
EOF
test_file "test1-data.csv" "Simple CSV file" "1"

# ============================================
# LEVEL 2: Common Archive Formats
# ============================================
echo -e "\n${YELLOW}=== LEVEL 2: Common Archive Formats ===${NC}"

# Test 2.1: ZIP archive with text files
mkdir -p temp-zip
echo "File 1" > temp-zip/file1.txt
echo "File 2" > temp-zip/file2.txt
echo "File 3" > temp-zip/file3.txt
zip -q -r test2-simple.zip temp-zip/
rm -rf temp-zip
test_file "test2-simple.zip" "ZIP archive with 3 text files" "2"

# Test 2.2: TAR.GZ archive
mkdir -p temp-tar
echo "Data 1" > temp-tar/data1.txt
echo "Data 2" > temp-tar/data2.txt
tar -czf test2-simple.tar.gz temp-tar/
rm -rf temp-tar
test_file "test2-simple.tar.gz" "TAR.GZ archive with 2 files" "2"

# ============================================
# LEVEL 3: Office Documents
# ============================================
echo -e "\n${YELLOW}=== LEVEL 3: Office Documents ===${NC}"

# Test 3.1: Simple DOCX (if available)
if command -v python3 &> /dev/null; then
    python3 << 'EOF'
from zipfile import ZipFile
import os

# Create minimal DOCX structure
with ZipFile('test3-simple.docx', 'w') as docx:
    # Content Types
    docx.writestr('[Content_Types].xml', '''<?xml version="1.0"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>''')

    # Relationships
    docx.writestr('_rels/.rels', '''<?xml version="1.0"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>''')

    # Document
    docx.writestr('word/document.xml', '''<?xml version="1.0"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    <w:p><w:r><w:t>Test Document</w:t></w:r></w:p>
  </w:body>
</w:document>''')
EOF
    test_file "test3-simple.docx" "Simple DOCX document" "3"
fi

# ============================================
# LEVEL 4: Binary Formats (Unknown)
# ============================================
echo -e "\n${YELLOW}=== LEVEL 4: Binary Formats (Unknown) ===${NC}"

# Test 4.1: SQLite database
if command -v sqlite3 &> /dev/null; then
    sqlite3 test4-database.db << 'EOF'
CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT, email TEXT);
INSERT INTO users VALUES (1, 'Alice', 'alice@example.com');
INSERT INTO users VALUES (2, 'Bob', 'bob@example.com');
INSERT INTO users VALUES (3, 'Charlie', 'charlie@example.com');
EOF
    test_file "test4-database.db" "SQLite database with 3 records" "4"
fi

# Test 4.2: Mock point cloud (LAS-like)
python3 << 'EOF'
# Create a mock LAS file
with open('test4-pointcloud.las', 'wb') as f:
    # LAS header
    f.write(b'LASF')  # Signature
    f.write(b'\x00\x00\x00\x00')  # File source ID
    f.write(b'\x00\x00')  # Global encoding
    f.write(b'\x01\x02')  # Version 1.2
    f.write(b'\x00' * 100)  # Padding to minimal header

    # Some mock point data
    for i in range(10):
        f.write(b'\x00' * 20)  # Mock point record
EOF
test_file "test4-pointcloud.las" "Mock LAS point cloud file" "4"

# Test 4.3: Mock CAD (DWG-like)
python3 << 'EOF'
# Create a mock DWG file
with open('test4-drawing.dwg', 'wb') as f:
    # DWG signature
    f.write(b'AC1018')  # AutoCAD 2004 format
    f.write(b'\x00' * 100)  # Mock data
EOF
test_file "test4-drawing.dwg" "Mock AutoCAD DWG file" "4"

# ============================================
# LEVEL 5: Complex Nested Archives
# ============================================
echo -e "\n${YELLOW}=== LEVEL 5: Complex Nested Archives ===${NC}"

# Test 5.1: Nested ZIP archives
mkdir -p temp-nested
echo "Inner file 1" > temp-nested/inner1.txt
echo "Inner file 2" > temp-nested/inner2.txt
zip -q -r temp-nested/inner.zip temp-nested/inner*.txt
rm temp-nested/inner*.txt

# Add mock unknown file to nested archive
python3 << 'EOF'
with open('temp-nested/mock-data.hdf5', 'wb') as f:
    f.write(b'\x89HDF\r\n\x1a\n')  # HDF5 signature
    f.write(b'\x00' * 100)
EOF

zip -q -r test5-nested.zip temp-nested/
rm -rf temp-nested
test_file "test5-nested.zip" "Nested ZIP with unknown file types" "5"

# ============================================
# LEVEL 6: Large Files
# ============================================
echo -e "\n${YELLOW}=== LEVEL 6: Large Files ===${NC}"

# Test 6.1: 10MB file
dd if=/dev/urandom of=test6-large-10mb.bin bs=1M count=10 2>/dev/null
test_file "test6-large-10mb.bin" "10MB binary file" "6"

# ============================================
# LEVEL 7: Edge Cases
# ============================================
echo -e "\n${YELLOW}=== LEVEL 7: Edge Cases ===${NC}"

# Test 7.1: Empty file
touch test7-empty.txt
test_file "test7-empty.txt" "Empty file (0 bytes)" "7"

# Test 7.2: File with no extension
echo "No extension" > test7-no-ext
test_file "test7-no-ext" "File with no extension" "7"

# Test 7.3: File with unusual extension
echo "Unusual" > test7-unusual.xyz123
test_file "test7-unusual.xyz123" "File with unusual extension" "7"

# Test 7.4: Corrupted ZIP
echo "Not a real ZIP" > test7-corrupted.zip
test_file "test7-corrupted.zip" "Corrupted ZIP file" "7"

# ============================================
# Test Summary
# ============================================
echo -e "\n${YELLOW}=== Test Summary ===${NC}"

cat >> "$RESULTS_FILE" << EOF

---

## Test Summary

**Total Tests**: $(grep -c "^### Test:" "$RESULTS_FILE")
**Passed**: $(grep -c "✅ PASS" "$RESULTS_FILE")
**Failed**: $(grep -c "❌ FAIL" "$RESULTS_FILE")
**Completion Time**: $(date -u +"%Y-%m-%d %H:%M:%S UTC")

---

## Issues Found

EOF

# Count failures by level
for level in {1..7}; do
    failures=$(grep -B 3 "❌ FAIL" "$RESULTS_FILE" | grep "Level: $level" | wc -l | tr -d ' ')
    if [ "$failures" -gt 0 ]; then
        echo "Level $level: $failures failures"
        cat >> "$RESULTS_FILE" << EOF
- **Level $level**: $failures failures
EOF
    fi
done

echo -e "\n${GREEN}Testing complete!${NC}"
echo "Results saved to: $RESULTS_FILE"
echo ""
echo "View results:"
echo "  cat $RESULTS_FILE"
