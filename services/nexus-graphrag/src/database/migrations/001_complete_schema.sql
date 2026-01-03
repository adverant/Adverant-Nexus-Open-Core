-- GraphRAG Complete Schema Migration
-- This migration ensures all required tables for the 18 test scenarios are present

-- Create schema if not exists
CREATE SCHEMA IF NOT EXISTS graphrag;

-- 1. Documents table (core)
CREATE TABLE IF NOT EXISTS graphrag.documents (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    title TEXT NOT NULL,
    type VARCHAR(50) DEFAULT 'text',
    format VARCHAR(50) DEFAULT 'plain',
    size INTEGER,
    hash VARCHAR(256),
    tags TEXT[] DEFAULT '{}',
    source VARCHAR(500),
    language VARCHAR(10) DEFAULT 'en',
    encoding VARCHAR(20) DEFAULT 'utf-8',
    metadata JSONB DEFAULT '{}',
    version INTEGER DEFAULT 1,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

-- 2. Document content table
CREATE TABLE IF NOT EXISTS graphrag.document_content (
    document_id UUID PRIMARY KEY REFERENCES graphrag.documents(id) ON DELETE CASCADE,
    content TEXT NOT NULL,
    processed BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMP DEFAULT NOW()
);

-- 3. Document chunks table (for chunking service)
CREATE TABLE IF NOT EXISTS graphrag.document_chunks (
    id TEXT PRIMARY KEY,
    document_id UUID REFERENCES graphrag.documents(id) ON DELETE CASCADE,
    chunk_index INTEGER NOT NULL,
    content TEXT NOT NULL,
    metadata JSONB DEFAULT '{}',
    embedding_generated BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMP DEFAULT NOW()
);

-- 4. Document summaries table
CREATE TABLE IF NOT EXISTS graphrag.document_summaries (
    document_id UUID PRIMARY KEY REFERENCES graphrag.documents(id) ON DELETE CASCADE,
    summary TEXT,
    key_points TEXT[],
    entities JSONB,
    created_at TIMESTAMP DEFAULT NOW()
);

-- 5. Document outlines table
CREATE TABLE IF NOT EXISTS graphrag.document_outlines (
    document_id UUID PRIMARY KEY REFERENCES graphrag.documents(id) ON DELETE CASCADE,
    outline JSONB,
    created_at TIMESTAMP DEFAULT NOW()
);

-- 6. Search index table
CREATE TABLE IF NOT EXISTS graphrag.search_index (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    document_id UUID REFERENCES graphrag.documents(id) ON DELETE CASCADE,
    search_vector tsvector,
    content TEXT,
    metadata JSONB DEFAULT '{}',
    created_at TIMESTAMP DEFAULT NOW()
);

-- 7. Document tags table (for tag filtering)
CREATE TABLE IF NOT EXISTS graphrag.document_tags (
    document_id UUID REFERENCES graphrag.documents(id) ON DELETE CASCADE,
    tag TEXT NOT NULL,
    created_at TIMESTAMP DEFAULT NOW(),
    PRIMARY KEY (document_id, tag)
);

-- 8. Memories table (for memory storage)
CREATE TABLE IF NOT EXISTS graphrag.memories (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    content TEXT NOT NULL,
    tags TEXT[] DEFAULT '{}',
    metadata JSONB DEFAULT '{}',
    embedding_generated BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

-- 9. Processing jobs table (for tracking async operations)
CREATE TABLE IF NOT EXISTS graphrag.processing_jobs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    document_id UUID REFERENCES graphrag.documents(id) ON DELETE CASCADE,
    job_type VARCHAR(50) NOT NULL,
    status VARCHAR(20) DEFAULT 'pending',
    progress INTEGER DEFAULT 0,
    error TEXT,
    metadata JSONB DEFAULT '{}',
    created_at TIMESTAMP DEFAULT NOW(),
    started_at TIMESTAMP,
    completed_at TIMESTAMP
);

-- 10. API keys table (for authentication)
CREATE TABLE IF NOT EXISTS graphrag.api_keys (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    key_hash VARCHAR(256) NOT NULL UNIQUE,
    name VARCHAR(255),
    permissions JSONB DEFAULT '{}',
    rate_limit INTEGER DEFAULT 100,
    is_active BOOLEAN DEFAULT TRUE,
    last_used_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT NOW(),
    expires_at TIMESTAMP
);

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_documents_created_at ON graphrag.documents(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_documents_tags ON graphrag.documents USING GIN(tags);
CREATE INDEX IF NOT EXISTS idx_documents_metadata ON graphrag.documents USING GIN(metadata);
CREATE INDEX IF NOT EXISTS idx_document_chunks_document_id ON graphrag.document_chunks(document_id);
CREATE INDEX IF NOT EXISTS idx_document_chunks_index ON graphrag.document_chunks(document_id, chunk_index);
CREATE INDEX IF NOT EXISTS idx_search_index_vector ON graphrag.search_index USING GIN(search_vector);
CREATE INDEX IF NOT EXISTS idx_search_index_document ON graphrag.search_index(document_id);
CREATE INDEX IF NOT EXISTS idx_memories_created_at ON graphrag.memories(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_memories_tags ON graphrag.memories USING GIN(tags);
CREATE INDEX IF NOT EXISTS idx_processing_jobs_document ON graphrag.processing_jobs(document_id, job_type);
CREATE INDEX IF NOT EXISTS idx_processing_jobs_status ON graphrag.processing_jobs(status);

-- Full-text search configuration
ALTER TABLE graphrag.search_index ADD COLUMN IF NOT EXISTS search_vector tsvector;

-- Update search vectors function
CREATE OR REPLACE FUNCTION graphrag.update_search_vector()
RETURNS TRIGGER AS $$
BEGIN
    NEW.search_vector := to_tsvector('english', COALESCE(NEW.content, ''));
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Trigger to automatically update search vectors
DROP TRIGGER IF EXISTS update_search_vector_trigger ON graphrag.search_index;
CREATE TRIGGER update_search_vector_trigger
    BEFORE INSERT OR UPDATE ON graphrag.search_index
    FOR EACH ROW
    EXECUTE FUNCTION graphrag.update_search_vector();

-- Function to update document timestamps
CREATE OR REPLACE FUNCTION graphrag.update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Trigger for document timestamp updates
DROP TRIGGER IF EXISTS update_documents_updated_at ON graphrag.documents;
CREATE TRIGGER update_documents_updated_at
    BEFORE UPDATE ON graphrag.documents
    FOR EACH ROW
    EXECUTE FUNCTION graphrag.update_updated_at();

-- Trigger for memory timestamp updates
DROP TRIGGER IF EXISTS update_memories_updated_at ON graphrag.memories;
CREATE TRIGGER update_memories_updated_at
    BEFORE UPDATE ON graphrag.memories
    FOR EACH ROW
    EXECUTE FUNCTION graphrag.update_updated_at();

-- Grant permissions
GRANT ALL PRIVILEGES ON SCHEMA graphrag TO CURRENT_USER;
GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA graphrag TO CURRENT_USER;
GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA graphrag TO CURRENT_USER;