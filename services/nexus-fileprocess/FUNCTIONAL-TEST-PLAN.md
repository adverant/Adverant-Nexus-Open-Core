# Comprehensive Functional Test Plan - FileProcessAgent

## Objective
Test FileProcessAgent with real-world complex file types to identify failures, non-working features, and integration issues with MageAgent and Sandbox services.

## Test File Types

### Point Cloud Data
1. **LAS** (LIDAR Data Exchange Format)
   - Binary point cloud format
   - Contains: XYZ coordinates, intensity, classification
   - Test: Parse header, extract point count, coordinate bounds

2. **LAZ** (Compressed LAS)
   - LASzip compressed format
   - Requires decompression library
   - Test: Detect compression, attempt decompression

3. **PLY** (Polygon File Format)
   - ASCII or binary mesh/point cloud
   - Contains: vertices, faces, properties
   - Test: Parse header, detect format (ASCII/binary)

4. **E57** (ASTM E57 3D Imaging Format)
   - XML-based container with binary data
   - Contains: multiple scans, images, metadata
   - Test: Parse XML structure, extract scan metadata

### CAD Files
1. **DWG** (AutoCAD Drawing)
   - Binary proprietary format
   - Contains: entities, layers, blocks
   - Test: Detect version, extract metadata

2. **DXF** (Drawing Exchange Format)
   - ASCII or binary CAD format
   - Contains: entities, header, tables
   - Test: Parse header section, entity count

3. **STL** (Stereolithography)
   - ASCII or binary 3D model
   - Contains: triangular facets
   - Test: Detect format, count triangles

4. **STEP/STP** (ISO 10303)
   - ASCII CAD exchange format
   - Contains: product data, geometry
   - Test: Parse header, extract entities

### Database Files
1. **SQLite** (.db, .sqlite)
   - Binary database format
   - Contains: tables, indexes, data
   - Test: Open database, list tables, schema

2. **Access** (.mdb, .accdb)
   - Microsoft Access database
   - Binary proprietary format
   - Test: Detect format, extract table list

3. **PostgreSQL Dump** (.dump, .sql)
   - SQL text or binary dump
   - Contains: schema, data
   - Test: Parse SQL, count tables

### Video/Audio Files
1. **MP4** (MPEG-4 Part 14)
   - Container format with H.264/AAC
   - Contains: video, audio, metadata
   - Test: Extract duration, resolution, codec

2. **MKV** (Matroska)
   - Open container format
   - Contains: multiple streams
   - Test: Parse EBML structure, stream count

3. **AVI** (Audio Video Interleave)
   - Microsoft container format
   - Contains: video, audio chunks
   - Test: Parse RIFF header, extract metadata

4. **FLAC** (Free Lossless Audio Codec)
   - Lossless audio compression
   - Contains: audio samples, metadata
   - Test: Parse metadata blocks, duration

### Scientific Data
1. **HDF5** (Hierarchical Data Format)
   - Binary scientific data format
   - Contains: datasets, groups, attributes
   - Test: Parse file structure, dataset count

2. **NetCDF** (Network Common Data Form)
   - Scientific data format
   - Contains: dimensions, variables, attributes
   - Test: Parse header, extract dimensions

3. **FITS** (Flexible Image Transport System)
   - Astronomy data format
   - Contains: image data, tables, metadata
   - Test: Parse header, extract keywords

### GIS/Mapping
1. **Shapefile** (.shp + .shx + .dbf)
   - Vector GIS format
   - Contains: geometries, attributes
   - Test: Parse header, geometry type, record count

2. **GeoTIFF** (.tif with GeoTIFF tags)
   - Georeferenced raster image
   - Contains: image, coordinate system
   - Test: Extract coordinate system, bounds

3. **KML/KMZ** (Keyhole Markup Language)
   - XML-based geographic data
   - Contains: placemarks, paths, polygons
   - Test: Parse XML, extract features

### Specialized Formats
1. **DICOM** (Medical Imaging)
   - Binary medical image format
   - Contains: patient data, image, metadata
   - Test: Parse header, extract patient info (anonymized)

2. **EPS** (Encapsulated PostScript)
   - Vector graphics format
   - Contains: PostScript code, preview
   - Test: Extract bounding box, preview image

3. **Parquet** (Apache Parquet)
   - Columnar storage format
   - Contains: structured data, schema
   - Test: Parse footer, extract schema

## Test Scenarios

### Scenario 1: Unknown File Type - First Upload
**File**: sample.las (Point cloud data)
**Expected Flow**:
1. FileValidator accepts (no MIME whitelist)
2. Routes to MageAgent UniversalTaskExecutor
3. MageAgent generates Python processing code
4. Code execution in Sandbox
5. Pattern stored in processing_patterns table
6. Results returned (~60 seconds)

**What to Test**:
- Does FileValidator accept the file?
- Is MageAgent called with correct parameters?
- Does Sandbox execute the code?
- Is the pattern stored in database?
- Are results returned correctly?

### Scenario 2: Unknown File Type - Cached Pattern
**File**: sample2.las (Same type as Scenario 1)
**Expected Flow**:
1. FileValidator accepts
2. PatternRepository cache hit (or PostgreSQL lookup)
3. Code execution in Sandbox with cached pattern
4. Results returned (~10 seconds)

**What to Test**:
- Is pattern found in cache/database?
- Is execution faster than first upload?
- Does cached code still work?

### Scenario 3: Archive with Unknown Files
**File**: pointcloud-bundle.zip (contains .las, .laz, .ply files)
**Expected Flow**:
1. ArchiveValidator detects ZIP
2. ArchiveExtractor extracts all files
3. Each file queued for processing
4. Unknown types route to MageAgent
5. All files processed successfully

**What to Test**:
- Are all files extracted from archive?
- Are unknown types in archive processed?
- Is recursive extraction working?

### Scenario 4: Complex Binary Format
**File**: model.dwg (AutoCAD drawing)
**Expected Flow**:
1. FileValidator accepts
2. Routes to MageAgent
3. MageAgent generates code to parse DWG
4. Sandbox executes with appropriate libraries
5. Metadata extracted (version, layers, entities)

**What to Test**:
- Can MageAgent handle complex binary formats?
- Are necessary libraries available in Sandbox?
- Is metadata extraction successful?

### Scenario 5: Large File Processing
**File**: large-scan.e57 (500MB point cloud)
**Expected Flow**:
1. FileValidator accepts (under 5GB limit)
2. Chunked upload to MinIO
3. Processing with memory limits
4. Streaming results

**What to Test**:
- Does file upload succeed?
- Are memory limits respected?
- Does processing complete without timeout?

### Scenario 6: Multi-Container Format
**File**: video.mkv (Matroska video)
**Expected Flow**:
1. FileValidator accepts
2. MageAgent generates FFmpeg-based code
3. Sandbox executes video analysis
4. Multiple streams identified

**What to Test**:
- Are container formats handled correctly?
- Is FFmpeg available in Sandbox?
- Are all streams detected?

## Integration Points to Test

### MageAgent Integration
1. **UniversalTaskExecutor Endpoint**
   - URL: `http://nexus-mageagent:8080/mageagent/api/internal/orchestrate`
   - Test: POST request with file metadata
   - Expected: Code generation response

2. **Code Generation Quality**
   - Test: Generated code is valid
   - Test: Generated code includes error handling
   - Test: Generated code has required imports

3. **Error Handling**
   - Test: MageAgent unavailable (circuit breaker)
   - Test: Code generation timeout
   - Test: Invalid response format

### Sandbox Integration
1. **Execution Endpoint**
   - URL: `http://nexus-sandbox:8090/execute`
   - Test: POST with code, language, packages
   - Expected: Execution results

2. **Language Support**
   - Test: Python (for most formats)
   - Test: Node.js (for JSON processing)
   - Test: Go (for performance-critical tasks)

3. **Package Installation**
   - Test: numpy, pandas (data science)
   - Test: laspy (point cloud)
   - Test: ezdxf (CAD)
   - Test: ffmpeg-python (video)
   - Test: h5py (scientific data)

4. **Resource Limits**
   - Test: CPU limit enforcement
   - Test: Memory limit enforcement (2GB)
   - Test: Timeout enforcement (5 minutes)

5. **Circuit Breaker**
   - Test: 5 consecutive failures trigger OPEN state
   - Test: Recovery after timeout period
   - Test: HALF_OPEN state testing

### PatternRepository Integration
1. **Cache Lookup**
   - Test: In-memory cache hit
   - Test: PostgreSQL lookup
   - Test: Cache eviction (LRU, 100 max)

2. **GraphRAG Integration**
   - URL: `http://nexus-graphrag:8091`
   - Test: Pattern embedding generation
   - Test: Semantic similarity search
   - Test: Pattern storage in knowledge graph

3. **Success Tracking**
   - Test: Success count increment
   - Test: Failure count increment
   - Test: Success rate calculation
   - Test: Average execution time update

## Failure Scenarios to Test

### Expected Failures
1. **Corrupted Files**
   - Test: Truncated binary file
   - Expected: Error with code, graceful handling

2. **Unsupported Compression**
   - Test: RAR5 with encryption
   - Expected: Error message with suggestion

3. **Malformed Archives**
   - Test: ZIP with wrong CRC
   - Expected: Extraction failure, error logged

4. **Timeout**
   - Test: Very large file processing
   - Expected: Timeout error after 5 minutes

5. **Memory Exhaustion**
   - Test: Processing requiring >2GB
   - Expected: OOM error, process killed

### Potential Issues to Find
1. **MageAgent Not Responding**
   - Symptom: Timeout on code generation
   - Cause: Service down or overloaded
   - Expected: Circuit breaker activates

2. **Sandbox Unavailable**
   - Symptom: Connection refused
   - Cause: Sandbox pods not running
   - Expected: Circuit breaker OPEN state

3. **Pattern Not Found**
   - Symptom: Cache miss + DB miss
   - Cause: New file type
   - Expected: Route to MageAgent

4. **GraphRAG Failure**
   - Symptom: Pattern stored without embedding
   - Cause: GraphRAG service unavailable
   - Expected: Pattern stored in PostgreSQL only

5. **Database Connection Lost**
   - Symptom: Pattern storage fails
   - Cause: PostgreSQL pod restarted
   - Expected: Retry logic, then error

## Test Execution Plan

### Phase 1: Basic File Upload
- Test with each file type
- Verify file acceptance (no rejection)
- Check logs for routing decisions

### Phase 2: MageAgent Integration
- Monitor MageAgent requests
- Verify code generation
- Check generated code quality

### Phase 3: Sandbox Execution
- Monitor Sandbox requests
- Verify package installation
- Check execution results
- Monitor resource usage

### Phase 4: Pattern Learning
- Verify pattern storage
- Test cache hits
- Check GraphRAG integration
- Monitor success/failure tracking

### Phase 5: Error Handling
- Test all failure scenarios
- Verify error codes and messages
- Check circuit breaker behavior
- Validate retry logic

### Phase 6: Performance
- Measure processing times
- Monitor memory usage
- Check concurrent processing
- Validate timeout enforcement

## Success Criteria

1. ✅ All file types accepted (no MIME whitelist rejection)
2. ✅ MageAgent integration working
3. ✅ Sandbox integration working
4. ✅ Pattern learning functional
5. ✅ Cache hits returning faster results
6. ✅ Error handling graceful for all scenarios
7. ✅ Circuit breakers activating correctly
8. ✅ Resource limits enforced
9. ✅ Complete audit trail in logs

## Failure Documentation

For each failure found, document:
1. **File Type**: What was being processed
2. **Error Message**: Exact error returned
3. **Root Cause**: Why it failed
4. **Expected Behavior**: What should happen
5. **Actual Behavior**: What actually happened
6. **Fix Required**: What needs to be changed
7. **Severity**: Critical/High/Medium/Low
8. **Workaround**: Temporary solution if available

---

**Test Plan Created**: 2025-11-27
**Engineer**: Claude Code
**Status**: Ready for Execution
