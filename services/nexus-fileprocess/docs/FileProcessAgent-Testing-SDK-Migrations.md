# FileProcessAgent Database Migrations, Testing, and Client SDK

## SQL Migration Scripts

### Initial Schema (001_initial_schema.sql)

```sql
-- services/fileprocess-agent/migrations/001_initial_schema.sql

-- Enable extensions
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";
CREATE EXTENSION IF NOT EXISTS "vector";  -- For pgvector

-- Create custom types
CREATE TYPE processing_status AS ENUM (
    'pending',
    'queued',
    'processing',
    'completed',
    'failed',
    'cancelled'
);

CREATE TYPE ocr_tier AS ENUM (
    'tier1_tesseract',
    'tier2_gpt4vision',
    'tier3_claude3opus'
);

CREATE TYPE storage_tier AS ENUM (
    'hot',
    'warm',
    'cold',
    'archive'
);

-- Processing jobs table
CREATE TABLE processing_jobs (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    job_id VARCHAR(100) UNIQUE NOT NULL,
    user_id VARCHAR(100),
    status processing_status NOT NULL DEFAULT 'pending',
    mime_type VARCHAR(100),
    file_name VARCHAR(500),
    file_size BIGINT,
    drive_file_id VARCHAR(200),
    
    -- Processing metadata
    started_at TIMESTAMP WITH TIME ZONE,
    completed_at TIMESTAMP WITH TIME ZONE,
    processing_time_ms INTEGER,
    worker_id VARCHAR(100),
    
    -- Results
    confidence DECIMAL(3,2),
    text_extracted TEXT,
    tables_count INTEGER DEFAULT 0,
    figures_count INTEGER DEFAULT 0,
    layout_elements_count INTEGER DEFAULT 0,
    
    -- Document DNA references
    semantic_hash VARCHAR(64),
    structural_hash VARCHAR(64),
    original_hash VARCHAR(64),
    
    -- Errors
    error_message TEXT,
    error_stack TEXT,
    retry_count INTEGER DEFAULT 0,
    max_retries INTEGER DEFAULT 3,
    
    -- Metadata
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    metadata JSONB,
    
    -- Indexes for JSON queries
    CONSTRAINT valid_confidence CHECK (confidence >= 0 AND confidence <= 1)
);

-- Create indexes
CREATE INDEX idx_jobs_status ON processing_jobs(status);
CREATE INDEX idx_jobs_user_id ON processing_jobs(user_id);
CREATE INDEX idx_jobs_created_at ON processing_jobs(created_at DESC);
CREATE INDEX idx_jobs_mime_type ON processing_jobs(mime_type);
CREATE INDEX idx_jobs_drive_file_id ON processing_jobs(drive_file_id);
CREATE INDEX idx_jobs_worker_id ON processing_jobs(worker_id);
CREATE INDEX idx_jobs_metadata ON processing_jobs USING GIN (metadata);

-- Create trigger for updated_at
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER update_processing_jobs_updated_at 
    BEFORE UPDATE ON processing_jobs 
    FOR EACH ROW 
    EXECUTE FUNCTION update_updated_at_column();

-- Processing plugins table
CREATE TABLE processing_plugins (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    plugin_id VARCHAR(100) UNIQUE NOT NULL,
    mime_type VARCHAR(100) NOT NULL,
    extension VARCHAR(50),
    code TEXT NOT NULL,
    compiled_code BYTEA,
    language VARCHAR(50) NOT NULL,
    dependencies TEXT[],
    confidence DECIMAL(3,2),
    usage_count INTEGER DEFAULT 0,
    success_count INTEGER DEFAULT 0,
    failure_count INTEGER DEFAULT 0,
    total_processing_time_ms BIGINT DEFAULT 0,
    average_processing_time_ms INTEGER GENERATED ALWAYS AS 
        (CASE 
            WHEN usage_count > 0 THEN total_processing_time_ms / usage_count 
            ELSE 0 
        END) STORED,
    last_used TIMESTAMP WITH TIME ZONE,
    last_error TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    created_by VARCHAR(100),
    metadata JSONB,
    
    CONSTRAINT valid_plugin_confidence CHECK (confidence >= 0 AND confidence <= 1)
);

-- Indexes
CREATE INDEX idx_plugins_mime_type ON processing_plugins(mime_type);
CREATE INDEX idx_plugins_extension ON processing_plugins(extension);
CREATE INDEX idx_plugins_confidence ON processing_plugins(confidence DESC);
CREATE INDEX idx_plugins_usage_count ON processing_plugins(usage_count DESC);
CREATE INDEX idx_plugins_last_used ON processing_plugins(last_used DESC);

-- Document DNA storage with vector embeddings
CREATE TABLE document_dna (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    job_id VARCHAR(100) REFERENCES processing_jobs(job_id) ON DELETE CASCADE,
    
    -- Semantic layer
    semantic_embedding vector(1536),  -- OpenAI/Voyage embedding dimension
    semantic_hash VARCHAR(64) UNIQUE NOT NULL,
    summary TEXT,
    keywords TEXT[],
    entities JSONB,
    topics TEXT[],
    sentiment DECIMAL(3,2),
    
    -- Structural layer
    structural_embedding vector(1536),
    structural_hash VARCHAR(64) UNIQUE NOT NULL,
    layout_elements JSONB,
    document_structure JSONB,
    table_count INTEGER DEFAULT 0,
    figure_count INTEGER DEFAULT 0,
    page_count INTEGER DEFAULT 0,
    word_count INTEGER DEFAULT 0,
    
    -- Original layer
    original_hash VARCHAR(64) UNIQUE NOT NULL,
    original_size BIGINT,
    mime_type VARCHAR(100),
    compressed_data BYTEA,
    compression_type VARCHAR(20) DEFAULT 'zstd',
    compression_ratio DECIMAL(3,2),
    
    -- Storage tier
    storage_tier storage_tier DEFAULT 'hot',
    tier_transition_date TIMESTAMP WITH TIME ZONE,
    access_count INTEGER DEFAULT 0,
    last_accessed TIMESTAMP WITH TIME ZONE,
    
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    metadata JSONB
);

-- Indexes
CREATE INDEX idx_dna_job_id ON document_dna(job_id);
CREATE INDEX idx_dna_semantic_hash ON document_dna(semantic_hash);
CREATE INDEX idx_dna_structural_hash ON document_dna(structural_hash);
CREATE INDEX idx_dna_original_hash ON document_dna(original_hash);
CREATE INDEX idx_dna_storage_tier ON document_dna(storage_tier);
CREATE INDEX idx_dna_last_accessed ON document_dna(last_accessed DESC);

-- Vector similarity search indexes (using IVFFlat)
CREATE INDEX idx_dna_semantic_embedding ON document_dna 
    USING ivfflat (semantic_embedding vector_cosine_ops)
    WITH (lists = 100);
    
CREATE INDEX idx_dna_structural_embedding ON document_dna 
    USING ivfflat (structural_embedding vector_cosine_ops)
    WITH (lists = 100);

-- Processing metrics table
CREATE TABLE processing_metrics (
    id BIGSERIAL PRIMARY KEY,
    timestamp TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    worker_id VARCHAR(100) NOT NULL,
    job_id VARCHAR(100),
    metric_type VARCHAR(50) NOT NULL,
    mime_type VARCHAR(100),
    processing_time_ms INTEGER,
    confidence DECIMAL(3,2),
    file_size BIGINT,
    ocr_tier ocr_tier,
    tables_extracted INTEGER,
    figures_extracted INTEGER,
    text_length INTEGER,
    success BOOLEAN,
    error_type VARCHAR(100),
    metadata JSONB
);

-- Indexes for time-series queries
CREATE INDEX idx_metrics_timestamp ON processing_metrics(timestamp DESC);
CREATE INDEX idx_metrics_worker_id ON processing_metrics(worker_id);
CREATE INDEX idx_metrics_job_id ON processing_metrics(job_id);
CREATE INDEX idx_metrics_mime_type ON processing_metrics(mime_type);
CREATE INDEX idx_metrics_success ON processing_metrics(success);

-- Partitioning for metrics (monthly)
CREATE TABLE processing_metrics_y2024m01 PARTITION OF processing_metrics
    FOR VALUES FROM ('2024-01-01') TO ('2024-02-01');
    
CREATE TABLE processing_metrics_y2024m02 PARTITION OF processing_metrics
    FOR VALUES FROM ('2024-02-01') TO ('2024-03-01');

-- Add more partitions as needed

-- Storage tier transitions
CREATE TABLE storage_transitions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    document_id UUID REFERENCES document_dna(id) ON DELETE CASCADE,
    file_id VARCHAR(200) NOT NULL,
    file_name VARCHAR(500),
    from_tier storage_tier,
    to_tier storage_tier NOT NULL,
    transition_time TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    reason VARCHAR(100),
    bytes_moved BIGINT,
    metadata JSONB
);

CREATE INDEX idx_transitions_document_id ON storage_transitions(document_id);
CREATE INDEX idx_transitions_file_id ON storage_transitions(file_id);
CREATE INDEX idx_transitions_time ON storage_transitions(transition_time DESC);

-- Learning history
CREATE TABLE learning_history (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    mime_type VARCHAR(100) NOT NULL,
    plugin_id VARCHAR(100) REFERENCES processing_plugins(plugin_id),
    research_summary TEXT,
    code_generated TEXT,
    test_results JSONB,
    success BOOLEAN,
    confidence DECIMAL(3,2),
    generation_time_ms INTEGER,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    metadata JSONB
);

CREATE INDEX idx_learning_mime_type ON learning_history(mime_type);
CREATE INDEX idx_learning_plugin_id ON learning_history(plugin_id);
CREATE INDEX idx_learning_created_at ON learning_history(created_at DESC);
```

### Add Performance Views (002_performance_views.sql)

```sql
-- services/fileprocess-agent/migrations/002_performance_views.sql

-- View for job statistics
CREATE OR REPLACE VIEW job_statistics AS
SELECT 
    DATE_TRUNC('hour', created_at) as hour,
    COUNT(*) as total_jobs,
    COUNT(*) FILTER (WHERE status = 'completed') as completed_jobs,
    COUNT(*) FILTER (WHERE status = 'failed') as failed_jobs,
    AVG(processing_time_ms) FILTER (WHERE status = 'completed') as avg_processing_time_ms,
    AVG(confidence) FILTER (WHERE status = 'completed') as avg_confidence,
    SUM(file_size) as total_bytes_processed
FROM processing_jobs
GROUP BY DATE_TRUNC('hour', created_at);

-- View for worker performance
CREATE OR REPLACE VIEW worker_performance AS
SELECT 
    worker_id,
    COUNT(*) as jobs_processed,
    AVG(processing_time_ms) as avg_processing_time_ms,
    AVG(confidence) as avg_confidence,
    COUNT(*) FILTER (WHERE status = 'failed') as failed_jobs,
    MAX(completed_at) as last_active
FROM processing_jobs
WHERE worker_id IS NOT NULL
GROUP BY worker_id;

-- View for plugin effectiveness
CREATE OR REPLACE VIEW plugin_effectiveness AS
SELECT 
    p.plugin_id,
    p.mime_type,
    p.language,
    p.usage_count,
    p.success_count,
    p.failure_count,
    CASE 
        WHEN p.usage_count > 0 
        THEN ROUND((p.success_count::DECIMAL / p.usage_count) * 100, 2)
        ELSE 0 
    END as success_rate,
    p.average_processing_time_ms,
    p.confidence,
    p.last_used
FROM processing_plugins p
ORDER BY p.usage_count DESC;

-- Materialized view for similarity search optimization
CREATE MATERIALIZED VIEW document_similarity_index AS
SELECT 
    d.id,
    d.job_id,
    d.semantic_embedding,
    d.structural_embedding,
    j.file_name,
    j.mime_type,
    j.created_at
FROM document_dna d
JOIN processing_jobs j ON d.job_id = j.job_id
WHERE j.status = 'completed';

CREATE INDEX idx_similarity_semantic ON document_similarity_index 
    USING ivfflat (semantic_embedding vector_cosine_ops);
    
CREATE INDEX idx_similarity_structural ON document_similarity_index 
    USING ivfflat (structural_embedding vector_cosine_ops);
```

### Add Functions and Procedures (003_functions.sql)

```sql
-- services/fileprocess-agent/migrations/003_functions.sql

-- Function to find similar documents
CREATE OR REPLACE FUNCTION find_similar_documents(
    query_embedding vector(1536),
    similarity_threshold FLOAT DEFAULT 0.8,
    limit_count INTEGER DEFAULT 10
)
RETURNS TABLE (
    document_id UUID,
    job_id VARCHAR(100),
    file_name VARCHAR(500),
    similarity_score FLOAT
) AS $$
BEGIN
    RETURN QUERY
    SELECT 
        d.id as document_id,
        d.job_id,
        j.file_name,
        1 - (d.semantic_embedding <=> query_embedding) as similarity_score
    FROM document_dna d
    JOIN processing_jobs j ON d.job_id = j.job_id
    WHERE 1 - (d.semantic_embedding <=> query_embedding) >= similarity_threshold
    ORDER BY similarity_score DESC
    LIMIT limit_count;
END;
$$ LANGUAGE plpgsql;

-- Function to transition storage tiers
CREATE OR REPLACE FUNCTION transition_storage_tier()
RETURNS void AS $$
DECLARE
    rec RECORD;
BEGIN
    -- Transition from hot to warm (7 days)
    FOR rec IN 
        SELECT id, job_id 
        FROM document_dna 
        WHERE storage_tier = 'hot' 
        AND last_accessed < NOW() - INTERVAL '7 days'
    LOOP
        UPDATE document_dna 
        SET storage_tier = 'warm',
            tier_transition_date = NOW()
        WHERE id = rec.id;
        
        INSERT INTO storage_transitions (
            document_id, file_id, from_tier, to_tier, reason
        ) VALUES (
            rec.id, rec.job_id, 'hot', 'warm', 'Age-based transition'
        );
    END LOOP;
    
    -- Transition from warm to cold (90 days)
    FOR rec IN 
        SELECT id, job_id 
        FROM document_dna 
        WHERE storage_tier = 'warm' 
        AND last_accessed < NOW() - INTERVAL '90 days'
    LOOP
        UPDATE document_dna 
        SET storage_tier = 'cold',
            tier_transition_date = NOW()
        WHERE id = rec.id;
        
        INSERT INTO storage_transitions (
            document_id, file_id, from_tier, to_tier, reason
        ) VALUES (
            rec.id, rec.job_id, 'warm', 'cold', 'Age-based transition'
        );
    END LOOP;
END;
$$ LANGUAGE plpgsql;

-- Procedure to clean up old data
CREATE OR REPLACE PROCEDURE cleanup_old_data(
    retention_days INTEGER DEFAULT 365
)
LANGUAGE plpgsql
AS $$
BEGIN
    -- Delete old failed jobs
    DELETE FROM processing_jobs 
    WHERE status = 'failed' 
    AND created_at < NOW() - INTERVAL '30 days';
    
    -- Delete old metrics
    DELETE FROM processing_metrics 
    WHERE timestamp < NOW() - (retention_days || ' days')::INTERVAL;
    
    -- Archive cold storage documents
    UPDATE document_dna 
    SET storage_tier = 'archive'
    WHERE storage_tier = 'cold' 
    AND last_accessed < NOW() - INTERVAL '365 days';
    
    COMMIT;
END;
$$;
```

## Go Testing Suite

### Unit Tests (internal/worker/worker_test.go)

```go
package worker

import (
    "context"
    "testing"
    "time"
    
    "github.com/stretchr/testify/assert"
    "github.com/stretchr/testify/mock"
    "github.com/fileprocess-agent/internal/config"
    "github.com/fileprocess-agent/internal/mocks"
)

func TestWorker_ProcessFile(t *testing.T) {
    tests := []struct {
        name    string
        payload FilePayload
        setup   func(*mocks.MockClients)
        wantErr bool
    }{
        {
            name: "successful PDF processing",
            payload: FilePayload{
                JobID:       "test-job-1",
                DriveFileID: "drive-file-1",
                MimeType:    "application/pdf",
                FileName:    "test.pdf",
            },
            setup: func(m *mocks.MockClients) {
                m.GoogleDrive.On("Download", mock.Anything, "drive-file-1").
                    Return([]byte("pdf content"), map[string]string{}, nil)
                m.DocklingProcessor.On("Process", mock.Anything, mock.Anything, "application/pdf", mock.Anything).
                    Return(&ProcessingResult{
                        Text:       "Extracted text",
                        Confidence: 0.95,
                    }, nil)
                m.GraphRAG.On("StoreDocument", mock.Anything, mock.Anything).
                    Return(nil)
            },
            wantErr: false,
        },
        {
            name: "video file routed to VideoAgent",
            payload: FilePayload{
                JobID:       "test-job-2",
                DriveFileID: "drive-file-2",
                MimeType:    "video/mp4",
                FileName:    "video.mp4",
            },
            setup: func(m *mocks.MockClients) {
                m.VideoRouter.On("ShouldRouteToVideoAgent", "video.mp4", "video/mp4").
                    Return(true)
                m.VideoRouter.On("RouteToVideoAgent", mock.Anything, mock.Anything).
                    Return(&VideoProcessingResult{
                        TaskID:   "video-task-1",
                        Pipeline: "default",
                    }, nil)
            },
            wantErr: false,
        },
        {
            name: "unknown format triggers learning",
            payload: FilePayload{
                JobID:       "test-job-3",
                DriveFileID: "drive-file-3",
                MimeType:    "application/x-custom",
                FileName:    "custom.xyz",
            },
            setup: func(m *mocks.MockClients) {
                m.GoogleDrive.On("Download", mock.Anything, "drive-file-3").
                    Return([]byte("custom content"), map[string]string{}, nil)
                m.DocklingProcessor.On("CanHandle", "application/x-custom").
                    Return(false)
                m.Learner.On("LearnFormat", mock.Anything, mock.Anything, "application/x-custom").
                    Return(&ProcessingPlugin{
                        ID:         "plugin-custom",
                        Code:       "processing code",
                        Confidence: 0.90,
                    }, nil)
                m.Sandbox.On("Execute", mock.Anything, mock.Anything).
                    Return(&SandboxResult{
                        Output: `{"text": "extracted text", "confidence": 0.90}`,
                    }, nil)
                m.GraphRAG.On("StoreDocument", mock.Anything, mock.Anything).
                    Return(nil)
            },
            wantErr: false,
        },
    }
    
    for _, tt := range tests {
        t.Run(tt.name, func(t *testing.T) {
            // Setup mocks
            mocks := mocks.NewMockClients()
            tt.setup(mocks)
            
            // Create worker with mocks
            w := &Worker{
                cfg:           &config.Config{},
                logger:        &testLogger{},
                docklingProc:  mocks.DocklingProcessor,
                learner:       mocks.Learner,
                graphRAG:      mocks.GraphRAG,
                googleDrive:   mocks.GoogleDrive,
                videoRouter:   mocks.VideoRouter,
                sandbox:       mocks.Sandbox,
            }
            
            // Create task
            task := createTestTask(tt.payload)
            
            // Process file
            err := w.ProcessFile(context.Background(), task)
            
            // Assert
            if tt.wantErr {
                assert.Error(t, err)
            } else {
                assert.NoError(t, err)
            }
            
            // Verify mock expectations
            mocks.AssertExpectations(t)
        })
    }
}

func TestOCRCascade_ExtractText(t *testing.T) {
    tests := []struct {
        name             string
        tesseractConf    float64
        gpt4Conf        float64
        claudeConf      float64
        minConfidence   float64
        expectedTier    int
        expectedText    string
    }{
        {
            name:          "tier 1 sufficient",
            tesseractConf: 0.90,
            minConfidence: 0.85,
            expectedTier:  1,
            expectedText:  "Tesseract extracted text",
        },
        {
            name:          "escalate to tier 2",
            tesseractConf: 0.70,
            gpt4Conf:     0.92,
            minConfidence: 0.85,
            expectedTier:  2,
            expectedText:  "GPT-4 extracted text",
        },
        {
            name:          "escalate to tier 3",
            tesseractConf: 0.70,
            gpt4Conf:     0.88,
            claudeConf:   0.96,
            minConfidence: 0.85,
            expectedTier:  3,
            expectedText:  "Claude extracted text",
        },
    }
    
    for _, tt := range tests {
        t.Run(tt.name, func(t *testing.T) {
            // Create mock image
            img := createTestImage()
            
            // Create mock OpenRouter client
            mockOpenRouter := &mocks.MockOpenRouterClient{}
            
            // Setup expectations based on expected tier
            if tt.expectedTier >= 2 {
                mockOpenRouter.On("CallVisionModel", "gpt-4-vision-preview", mock.Anything, mock.Anything).
                    Return(&VisionResponse{
                        Content: fmt.Sprintf(`{"text": "GPT-4 extracted text", "confidence": %f}`, tt.gpt4Conf),
                    }, nil).Maybe()
            }
            
            if tt.expectedTier >= 3 {
                mockOpenRouter.On("CallVisionModel", "claude-3-opus-20240229", mock.Anything, mock.Anything).
                    Return(&VisionResponse{
                        Content: fmt.Sprintf(`{"text": "Claude extracted text", "confidence": %f}`, tt.claudeConf),
                    }, nil).Maybe()
            }
            
            // Create OCR cascade with mock Tesseract
            ocr := &OCRCascade{
                openRouter:    mockOpenRouter,
                minConfidence: tt.minConfidence,
                tesseract:     &mockTesseract{confidence: tt.tesseractConf},
            }
            
            // Extract text
            text, confidence, err := ocr.ExtractText(img)
            
            // Assert
            assert.NoError(t, err)
            assert.Equal(t, tt.expectedText, text)
            assert.Greater(t, confidence, tt.minConfidence)
            
            mockOpenRouter.AssertExpectations(t)
        })
    }
}
```

### Integration Tests (tests/integration_test.go)

```go
package tests

import (
    "bytes"
    "context"
    "encoding/json"
    "io"
    "net/http"
    "testing"
    "time"
    
    "github.com/stretchr/testify/assert"
    "github.com/stretchr/testify/require"
)

func TestE2E_FileProcessing(t *testing.T) {
    if testing.Short() {
        t.Skip("Skipping E2E test in short mode")
    }
    
    // Setup test environment
    client := setupTestClient(t)
    
    tests := []struct {
        name     string
        file     string
        mimeType string
        validate func(*testing.T, *ProcessingResponse)
    }{
        {
            name:     "PDF processing",
            file:     "testdata/sample.pdf",
            mimeType: "application/pdf",
            validate: func(t *testing.T, resp *ProcessingResponse) {
                assert.NotEmpty(t, resp.JobID)
                assert.Equal(t, "completed", resp.Status)
                assert.Greater(t, resp.Confidence, 0.85)
                assert.NotEmpty(t, resp.Text)
                assert.Greater(t, resp.TablesCount, 0)
            },
        },
        {
            name:     "Image with OCR",
            file:     "testdata/document.png",
            mimeType: "image/png",
            validate: func(t *testing.T, resp *ProcessingResponse) {
                assert.NotEmpty(t, resp.JobID)
                assert.Equal(t, "completed", resp.Status)
                assert.NotEmpty(t, resp.Text)
                assert.Greater(t, resp.Confidence, 0.80)
            },
        },
        {
            name:     "Large file streaming",
            file:     "testdata/large_document.pdf",
            mimeType: "application/pdf",
            validate: func(t *testing.T, resp *ProcessingResponse) {
                assert.NotEmpty(t, resp.JobID)
                assert.Equal(t, "completed", resp.Status)
                assert.True(t, resp.StreamProcessed)
                assert.Greater(t, resp.ChunksProcessed, 1)
            },
        },
    }
    
    for _, tt := range tests {
        t.Run(tt.name, func(t *testing.T) {
            // Upload file
            fileData := loadTestFile(t, tt.file)
            
            resp, err := client.ProcessFile(context.Background(), &ProcessFileRequest{
                FileName: tt.file,
                MimeType: tt.mimeType,
                Content:  fileData,
                Options: ProcessingOptions{
                    EnableOCR:      true,
                    ExtractTables:  true,
                    ExtractFigures: true,
                    GenerateDNA:    true,
                },
            })
            
            require.NoError(t, err)
            require.NotNil(t, resp)
            
            // Wait for processing to complete
            result := waitForCompletion(t, client, resp.JobID, 60*time.Second)
            
            // Validate result
            tt.validate(t, result)
        })
    }
}

func TestWebSocketProgress(t *testing.T) {
    if testing.Short() {
        t.Skip("Skipping WebSocket test in short mode")
    }
    
    client := setupTestClient(t)
    wsClient := setupWebSocketClient(t)
    
    // Start file processing
    resp, err := client.ProcessFile(context.Background(), &ProcessFileRequest{
        FileName: "test.pdf",
        MimeType: "application/pdf",
        Content:  loadTestFile(t, "testdata/sample.pdf"),
    })
    require.NoError(t, err)
    
    // Subscribe to progress updates
    progressChan := make(chan ProgressUpdate, 100)
    go wsClient.SubscribeToJob(resp.JobID, progressChan)
    
    // Collect progress updates
    var updates []ProgressUpdate
    timeout := time.After(30 * time.Second)
    
    for {
        select {
        case update := <-progressChan:
            updates = append(updates, update)
            if update.Type == "completed" || update.Type == "failed" {
                goto done
            }
        case <-timeout:
            t.Fatal("Timeout waiting for completion")
        }
    }
    
done:
    // Validate progress updates
    assert.Greater(t, len(updates), 0)
    
    // Check for expected update types
    hasProgress := false
    hasCompleted := false
    
    for _, update := range updates {
        switch update.Type {
        case "progress":
            hasProgress = true
            assert.GreaterOrEqual(t, update.Percentage, 0.0)
            assert.LessOrEqual(t, update.Percentage, 100.0)
        case "completed":
            hasCompleted = true
            assert.Equal(t, 100.0, update.Percentage)
        }
    }
    
    assert.True(t, hasProgress, "Should have progress updates")
    assert.True(t, hasCompleted, "Should have completion update")
}
```

### Load Testing (tests/load_test.go)

```go
package tests

import (
    "context"
    "sync"
    "testing"
    "time"
    
    "github.com/stretchr/testify/require"
)

func TestLoad_ConcurrentProcessing(t *testing.T) {
    if testing.Short() {
        t.Skip("Skipping load test in short mode")
    }
    
    client := setupTestClient(t)
    
    // Configuration
    concurrentRequests := 50
    filesPerRequest := 5
    timeout := 5 * time.Minute
    
    // Metrics
    var (
        totalRequests   int
        successCount    int
        failureCount    int
        totalDuration   time.Duration
        mu              sync.Mutex
        wg              sync.WaitGroup
    )
    
    // Create worker pool
    requestChan := make(chan int, concurrentRequests)
    
    // Start workers
    for i := 0; i < concurrentRequests; i++ {
        wg.Add(1)
        go func() {
            defer wg.Done()
            
            for reqNum := range requestChan {
                start := time.Now()
                
                // Process multiple files
                for j := 0; j < filesPerRequest; j++ {
                    resp, err := client.ProcessFile(context.Background(), &ProcessFileRequest{
                        FileName: fmt.Sprintf("test_%d_%d.pdf", reqNum, j),
                        MimeType: "application/pdf",
                        Content:  generateTestPDF(1024 * 1024), // 1MB
                    })
                    
                    mu.Lock()
                    totalRequests++
                    
                    if err == nil && resp != nil {
                        successCount++
                    } else {
                        failureCount++
                    }
                    
                    totalDuration += time.Since(start)
                    mu.Unlock()
                }
            }
        }()
    }
    
    // Send requests
    testStart := time.Now()
    for i := 0; i < concurrentRequests*2; i++ {
        select {
        case requestChan <- i:
        case <-time.After(timeout):
            t.Fatal("Timeout sending requests")
        }
    }
    
    close(requestChan)
    wg.Wait()
    
    testDuration := time.Since(testStart)
    
    // Calculate metrics
    successRate := float64(successCount) / float64(totalRequests) * 100
    avgDuration := totalDuration / time.Duration(totalRequests)
    throughput := float64(totalRequests) / testDuration.Seconds()
    
    // Log results
    t.Logf("Load Test Results:")
    t.Logf("  Total Requests: %d", totalRequests)
    t.Logf("  Success Count: %d", successCount)
    t.Logf("  Failure Count: %d", failureCount)
    t.Logf("  Success Rate: %.2f%%", successRate)
    t.Logf("  Average Duration: %v", avgDuration)
    t.Logf("  Throughput: %.2f req/s", throughput)
    t.Logf("  Test Duration: %v", testDuration)
    
    // Assertions
    require.Greater(t, successRate, 95.0, "Success rate should be > 95%")
    require.Less(t, avgDuration, 10*time.Second, "Average duration should be < 10s")
    require.Greater(t, throughput, 10.0, "Throughput should be > 10 req/s")
}
```

## Client SDK

### Go Client (sdk/go/client.go)

```go
package fileprocessclient

import (
    "bytes"
    "context"
    "encoding/json"
    "fmt"
    "io"
    "net/http"
    "time"
    
    "github.com/gorilla/websocket"
)

// Client is the FileProcessAgent client
type Client struct {
    baseURL    string
    apiKey     string
    httpClient *http.Client
    wsConn     *websocket.Conn
}

// NewClient creates a new FileProcessAgent client
func NewClient(baseURL, apiKey string) *Client {
    return &Client{
        baseURL: baseURL,
        apiKey:  apiKey,
        httpClient: &http.Client{
            Timeout: 30 * time.Second,
        },
    }
}

// ProcessFileRequest represents a file processing request
type ProcessFileRequest struct {
    DriveFileID string            `json:"driveFileId,omitempty"`
    FileURL     string            `json:"fileUrl,omitempty"`
    LocalPath   string            `json:"localPath,omitempty"`
    Options     ProcessingOptions `json:"options"`
}

// ProcessingOptions contains processing configuration
type ProcessingOptions struct {
    Priority       int      `json:"priority"`
    EnableOCR      bool     `json:"enableOCR"`
    ExtractTables  bool     `json:"extractTables"`
    ExtractFigures bool     `json:"extractFigures"`
    GenerateDNA    bool     `json:"generateDNA"`
    TargetAccuracy float64  `json:"targetAccuracy"`
    AutoLearn      bool     `json:"autoLearn"`
    Context        string   `json:"context"`
}

// ProcessFileResponse represents the initial response
type ProcessFileResponse struct {
    JobID         string `json:"jobId"`
    Status        string `json:"status"`
    CheckStatusURL string `json:"checkStatusUrl"`
    WebSocketURL  string `json:"websocketUrl"`
}

// ProcessFile submits a file for processing
func (c *Client) ProcessFile(ctx context.Context, req *ProcessFileRequest) (*ProcessFileResponse, error) {
    url := fmt.Sprintf("%s/api/process", c.baseURL)
    
    body, err := json.Marshal(req)
    if err != nil {
        return nil, fmt.Errorf("failed to marshal request: %w", err)
    }
    
    httpReq, err := http.NewRequestWithContext(ctx, "POST", url, bytes.NewReader(body))
    if err != nil {
        return nil, fmt.Errorf("failed to create request: %w", err)
    }
    
    httpReq.Header.Set("Content-Type", "application/json")
    httpReq.Header.Set("Authorization", fmt.Sprintf("Bearer %s", c.apiKey))
    
    resp, err := c.httpClient.Do(httpReq)
    if err != nil {
        return nil, fmt.Errorf("request failed: %w", err)
    }
    defer resp.Body.Close()
    
    if resp.StatusCode != http.StatusOK {
        body, _ := io.ReadAll(resp.Body)
        return nil, fmt.Errorf("request failed with status %d: %s", resp.StatusCode, body)
    }
    
    var result ProcessFileResponse
    if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
        return nil, fmt.Errorf("failed to decode response: %w", err)
    }
    
    return &result, nil
}

// GetJobStatus retrieves the status of a processing job
func (c *Client) GetJobStatus(ctx context.Context, jobID string) (*JobStatus, error) {
    url := fmt.Sprintf("%s/api/jobs/%s", c.baseURL, jobID)
    
    req, err := http.NewRequestWithContext(ctx, "GET", url, nil)
    if err != nil {
        return nil, err
    }
    
    req.Header.Set("Authorization", fmt.Sprintf("Bearer %s", c.apiKey))
    
    resp, err := c.httpClient.Do(req)
    if err != nil {
        return nil, err
    }
    defer resp.Body.Close()
    
    var status JobStatus
    if err := json.NewDecoder(resp.Body).Decode(&status); err != nil {
        return nil, err
    }
    
    return &status, nil
}

// SubscribeToProgress subscribes to real-time progress updates
func (c *Client) SubscribeToProgress(jobID string) (<-chan ProgressUpdate, error) {
    wsURL := fmt.Sprintf("ws://%s/ws/jobs/%s", c.baseURL, jobID)
    
    conn, _, err := websocket.DefaultDialer.Dial(wsURL, nil)
    if err != nil {
        return nil, fmt.Errorf("failed to connect to websocket: %w", err)
    }
    
    c.wsConn = conn
    
    // Subscribe to job
    if err := conn.WriteJSON(map[string]string{
        "type":  "subscribe",
        "jobId": jobID,
    }); err != nil {
        return nil, err
    }
    
    progressChan := make(chan ProgressUpdate, 100)
    
    go func() {
        defer close(progressChan)
        defer conn.Close()
        
        for {
            var update ProgressUpdate
            if err := conn.ReadJSON(&update); err != nil {
                if websocket.IsUnexpectedCloseError(err, websocket.CloseGoingAway, websocket.CloseAbnormalClosure) {
                    fmt.Printf("WebSocket error: %v\n", err)
                }
                break
            }
            
            progressChan <- update
            
            if update.Type == "completed" || update.Type == "failed" {
                break
            }
        }
    }()
    
    return progressChan, nil
}

// WaitForCompletion waits for a job to complete
func (c *Client) WaitForCompletion(ctx context.Context, jobID string, timeout time.Duration) (*JobResult, error) {
    ctx, cancel := context.WithTimeout(ctx, timeout)
    defer cancel()
    
    ticker := time.NewTicker(2 * time.Second)
    defer ticker.Stop()
    
    for {
        select {
        case <-ctx.Done():
            return nil, fmt.Errorf("timeout waiting for job completion")
        case <-ticker.C:
            status, err := c.GetJobStatus(ctx, jobID)
            if err != nil {
                return nil, err
            }
            
            switch status.State {
            case "completed":
                return status.Result, nil
            case "failed":
                return nil, fmt.Errorf("job failed: %s", status.Error)
            }
        }
    }
}
```

### TypeScript/JavaScript Client (sdk/typescript/src/client.ts)

```typescript
// sdk/typescript/src/client.ts

import axios, { AxiosInstance } from 'axios';
import WebSocket from 'ws';
import { EventEmitter } from 'events';

export interface ProcessFileRequest {
    driveFileId?: string;
    fileUrl?: string;
    localPath?: string;
    file?: Buffer | Blob;
    options?: ProcessingOptions;
}

export interface ProcessingOptions {
    priority?: number;
    enableOCR?: boolean;
    extractTables?: boolean;
    extractFigures?: boolean;
    generateDNA?: boolean;
    targetAccuracy?: number;
    autoLearn?: boolean;
    context?: string;
}

export interface ProcessFileResponse {
    jobId: string;
    status: string;
    checkStatusUrl: string;
    websocketUrl: string;
}

export interface JobStatus {
    jobId: string;
    state: 'pending' | 'queued' | 'processing' | 'completed' | 'failed';
    progress?: ProgressInfo;
    result?: JobResult;
    error?: string;
    createdAt: string;
    processedAt?: string;
    finishedAt?: string;
}

export interface ProgressInfo {
    percentage: number;
    stage: string;
    currentOperation: string;
    processedBytes?: number;
    totalBytes?: number;
}

export interface JobResult {
    text: string;
    confidence: number;
    tablesCount: number;
    figuresCount: number;
    documentDNA?: DocumentDNA;
    processingTime: number;
}

export interface DocumentDNA {
    semanticHash: string;
    structuralHash: string;
    originalHash: string;
}

export class FileProcessClient extends EventEmitter {
    private apiClient: AxiosInstance;
    private wsConnections: Map<string, WebSocket> = new Map();
    
    constructor(
        private baseURL: string,
        private apiKey: string
    ) {
        super();
        
        this.apiClient = axios.create({
            baseURL: this.baseURL,
            headers: {
                'Authorization': `Bearer ${this.apiKey}`,
                'Content-Type': 'application/json'
            },
            timeout: 30000
        });
    }
    
    /**
     * Process a file
     */
    async processFile(request: ProcessFileRequest): Promise<ProcessFileResponse> {
        const response = await this.apiClient.post<ProcessFileResponse>('/api/process', request);
        return response.data;
    }
    
    /**
     * Upload and process a file
     */
    async uploadAndProcess(
        file: Buffer | Blob,
        filename: string,
        options?: ProcessingOptions
    ): Promise<ProcessFileResponse> {
        const formData = new FormData();
        
        if (file instanceof Buffer) {
            formData.append('file', new Blob([file]), filename);
        } else {
            formData.append('file', file, filename);
        }
        
        if (options) {
            formData.append('options', JSON.stringify(options));
        }
        
        const response = await this.apiClient.post<ProcessFileResponse>(
            '/api/upload-and-process',
            formData,
            {
                headers: {
                    'Content-Type': 'multipart/form-data'
                }
            }
        );
        
        return response.data;
    }
    
    /**
     * Get job status
     */
    async getJobStatus(jobId: string): Promise<JobStatus> {
        const response = await this.apiClient.get<JobStatus>(`/api/jobs/${jobId}`);
        return response.data;
    }
    
    /**
     * List jobs
     */
    async listJobs(params?: {
        status?: 'all' | 'waiting' | 'active' | 'completed' | 'failed';
        limit?: number;
        offset?: number;
    }): Promise<{ jobs: JobStatus[]; total: number }> {
        const response = await this.apiClient.get('/api/jobs', { params });
        return response.data;
    }
    
    /**
     * Subscribe to job progress via WebSocket
     */
    subscribeToProgress(jobId: string): void {
        const wsUrl = `${this.baseURL.replace('http', 'ws')}/ws/jobs/${jobId}`;
        const ws = new WebSocket(wsUrl);
        
        ws.on('open', () => {
            ws.send(JSON.stringify({
                type: 'subscribe',
                jobId: jobId
            }));
            
            this.emit('connected', { jobId });
        });
        
        ws.on('message', (data: string) => {
            const message = JSON.parse(data);
            
            switch (message.type) {
                case 'progress':
                    this.emit('progress', {
                        jobId,
                        progress: message.data
                    });
                    break;
                    
                case 'completed':
                    this.emit('completed', {
                        jobId,
                        result: message.data
                    });
                    this.closeConnection(jobId);
                    break;
                    
                case 'failed':
                    this.emit('failed', {
                        jobId,
                        error: message.data
                    });
                    this.closeConnection(jobId);
                    break;
            }
        });
        
        ws.on('error', (error) => {
            this.emit('error', { jobId, error });
        });
        
        ws.on('close', () => {
            this.emit('disconnected', { jobId });
            this.wsConnections.delete(jobId);
        });
        
        this.wsConnections.set(jobId, ws);
    }
    
    /**
     * Unsubscribe from job progress
     */
    unsubscribeFromProgress(jobId: string): void {
        this.closeConnection(jobId);
    }
    
    /**
     * Wait for job completion
     */
    async waitForCompletion(
        jobId: string,
        options?: {
            timeout?: number;
            pollInterval?: number;
        }
    ): Promise<JobResult> {
        const timeout = options?.timeout || 300000; // 5 minutes default
        const pollInterval = options?.pollInterval || 2000; // 2 seconds default
        
        const startTime = Date.now();
        
        while (Date.now() - startTime < timeout) {
            const status = await this.getJobStatus(jobId);
            
            if (status.state === 'completed') {
                return status.result!;
            }
            
            if (status.state === 'failed') {
                throw new Error(`Job failed: ${status.error}`);
            }
            
            await this.sleep(pollInterval);
        }
        
        throw new Error(`Timeout waiting for job ${jobId} to complete`);
    }
    
    /**
     * Close all WebSocket connections
     */
    closeAllConnections(): void {
        this.wsConnections.forEach((ws, jobId) => {
            this.closeConnection(jobId);
        });
    }
    
    private closeConnection(jobId: string): void {
        const ws = this.wsConnections.get(jobId);
        if (ws) {
            ws.send(JSON.stringify({
                type: 'unsubscribe',
                jobId: jobId
            }));
            ws.close();
            this.wsConnections.delete(jobId);
        }
    }
    
    private sleep(ms: number): Promise<void> {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
}

// Example usage
export async function example() {
    const client = new FileProcessClient(
        'http://localhost:8096',
        'your-api-key'
    );
    
    // Subscribe to events
    client.on('progress', (data) => {
        console.log(`Progress for job ${data.jobId}:`, data.progress);
    });
    
    client.on('completed', (data) => {
        console.log(`Job ${data.jobId} completed:`, data.result);
    });
    
    // Process a file
    const response = await client.processFile({
        driveFileId: 'drive-file-id',
        options: {
            enableOCR: true,
            extractTables: true,
            generateDNA: true,
            targetAccuracy: 0.95
        }
    });
    
    console.log('Job created:', response.jobId);
    
    // Subscribe to progress
    client.subscribeToProgress(response.jobId);
    
    // Wait for completion
    const result = await client.waitForCompletion(response.jobId);
    console.log('Processing complete:', result);
}
```

## Deployment Scripts

### Build Script (scripts/build.sh)

```bash
#!/bin/bash
set -e

VERSION=${1:-latest}
REGISTRY=${2:-registry.yourdomain.com}

echo "🔨 Building FileProcessAgent v${VERSION}..."

# Build Go worker
echo "Building Go worker..."
cd services/fileprocess-agent
CGO_ENABLED=1 GOOS=linux GOARCH=amd64 go build \
    -ldflags="-w -s -X main.Version=${VERSION}" \
    -o bin/fileprocess-worker \
    ./cmd/worker

# Build Docker images
echo "Building Docker images..."
docker build -f Dockerfile.worker -t ${REGISTRY}/fileprocess-worker:${VERSION} .
docker build -f Dockerfile.api -t ${REGISTRY}/fileprocess-api:${VERSION} .

# Run tests
echo "Running tests..."
go test -v -race -coverprofile=coverage.out ./...

# Push images
echo "Pushing images to registry..."
docker push ${REGISTRY}/fileprocess-worker:${VERSION}
docker push ${REGISTRY}/fileprocess-api:${VERSION}

echo "✅ Build complete!"
```

This completes the comprehensive FileProcessAgent implementation with production-ready Kubernetes deployment, testing suite, and client SDKs for multiple languages.
