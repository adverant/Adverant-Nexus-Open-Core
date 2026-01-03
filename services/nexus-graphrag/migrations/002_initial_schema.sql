-- GraphRAG Initial Database Schema
-- This migration creates the core tables for document storage and retrieval

-- Enable required extensions
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pg_trgm";
CREATE EXTENSION IF NOT EXISTS "btree_gin";

-- Create schema if it doesn't exist
CREATE SCHEMA IF NOT EXISTS graphrag;

-- Set search path
SET search_path TO graphrag, public;

-- Documents table - stores document metadata
CREATE TABLE IF NOT EXISTS documents (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    title TEXT NOT NULL,
    type VARCHAR(50) NOT NULL CHECK (type IN ('code', 'markdown', 'text', 'structured', 'multimodal')),
    format VARCHAR(50) NOT NULL, -- json, yaml, md, tsx, py, etc.
    size BIGINT NOT NULL,
    hash VARCHAR(64) NOT NULL UNIQUE, -- SHA256 hash for deduplication
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    version INTEGER NOT NULL DEFAULT 1,
    tags TEXT[] DEFAULT '{}',
    source TEXT, -- URL, file path, etc.
    language VARCHAR(50), -- For code files
    encoding VARCHAR(50) DEFAULT 'utf-8',
    metadata JSONB DEFAULT '{}', -- Custom metadata
    CONSTRAINT valid_size CHECK (size > 0),
    CONSTRAINT valid_version CHECK (version > 0)
);

-- Document content table - stores actual document content
CREATE TABLE IF NOT EXISTS document_content (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    document_id UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    content TEXT NOT NULL,
    encoding VARCHAR(50) DEFAULT 'utf-8',
    compressed BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT unique_document_content UNIQUE(document_id)
);

-- Document summaries table
CREATE TABLE IF NOT EXISTS document_summaries (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    document_id UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    summary TEXT NOT NULL,
    key_points JSONB DEFAULT '[]', -- Array of key points
    generated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    generation_model VARCHAR(100) DEFAULT 'claude-3-haiku',
    tokens_used INTEGER,
    CONSTRAINT unique_document_summary UNIQUE(document_id)
);

-- Document outlines table
CREATE TABLE IF NOT EXISTS document_outlines (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    document_id UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    outline_json JSONB NOT NULL, -- Hierarchical outline structure
    section_count INTEGER NOT NULL CHECK (section_count >= 0),
    max_depth INTEGER NOT NULL CHECK (max_depth >= 0),
    generated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT unique_document_outline UNIQUE(document_id)
);

-- Search index table with full-text search
CREATE TABLE IF NOT EXISTS search_index (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    document_id UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    content TEXT NOT NULL,
    title TEXT NOT NULL,
    tags TEXT,
    metadata JSONB DEFAULT '{}',
    indexed_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    search_vector tsvector,
    CONSTRAINT unique_document_search_index UNIQUE(document_id)
);

-- Create indexes for performance

-- Documents table indexes
CREATE INDEX idx_documents_title ON documents USING gin(to_tsvector('english', title));
CREATE INDEX idx_documents_type ON documents(type);
CREATE INDEX idx_documents_format ON documents(format);
CREATE INDEX idx_documents_created_at ON documents(created_at);
CREATE INDEX idx_documents_updated_at ON documents(updated_at);
CREATE INDEX idx_documents_hash ON documents(hash);
CREATE INDEX idx_documents_tags ON documents USING gin(tags);
CREATE INDEX idx_documents_source ON documents(source);
CREATE INDEX idx_documents_language ON documents(language);
CREATE INDEX idx_documents_metadata ON documents USING gin(metadata);

-- Document content indexes
CREATE INDEX idx_document_content_document_id ON document_content(document_id);

-- Document summaries indexes
CREATE INDEX idx_document_summaries_document_id ON document_summaries(document_id);
CREATE INDEX idx_document_summaries_generated_at ON document_summaries(generated_at);

-- Document outlines indexes
CREATE INDEX idx_document_outlines_document_id ON document_outlines(document_id);
CREATE INDEX idx_document_outlines_section_count ON document_outlines(section_count);
CREATE INDEX idx_document_outlines_max_depth ON document_outlines(max_depth);

-- Search index indexes
CREATE INDEX idx_search_index_document_id ON search_index(document_id);
CREATE INDEX idx_search_index_search_vector ON search_index USING gin(search_vector);
CREATE INDEX idx_search_index_indexed_at ON search_index(indexed_at);

-- Create full-text search configuration
-- PostgreSQL does not support CREATE TEXT SEARCH CONFIGURATION IF NOT EXISTS
-- Using DO block with explicit existence check
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_ts_config WHERE cfgname = 'graphrag_search'
    ) THEN
        CREATE TEXT SEARCH CONFIGURATION graphrag_search (COPY = pg_catalog.english);
    END IF;
EXCEPTION
    WHEN duplicate_object THEN
        NULL;
END $$;

-- Update function for search_vector
CREATE OR REPLACE FUNCTION update_search_vector() RETURNS trigger AS $$
BEGIN
    NEW.search_vector := 
        setweight(to_tsvector('graphrag_search', coalesce(NEW.title, '')), 'A') ||
        setweight(to_tsvector('graphrag_search', coalesce(NEW.content, '')), 'B') ||
        setweight(to_tsvector('graphrag_search', coalesce(NEW.tags, '')), 'C');
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Trigger to automatically update search_vector
CREATE TRIGGER tg_search_vector_update 
    BEFORE INSERT OR UPDATE ON search_index
    FOR EACH ROW 
    EXECUTE FUNCTION update_search_vector();

-- Update timestamp function
CREATE OR REPLACE FUNCTION update_updated_at_column() RETURNS trigger AS $$
BEGIN
    NEW.updated_at = CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Trigger to automatically update updated_at
CREATE TRIGGER tg_documents_updated_at 
    BEFORE UPDATE ON documents
    FOR EACH ROW 
    EXECUTE FUNCTION update_updated_at_column();

-- Version increment function
CREATE OR REPLACE FUNCTION increment_document_version() RETURNS trigger AS $$
BEGIN
    -- Only increment version if content is actually changing
    IF OLD.hash != NEW.hash THEN
        NEW.version = OLD.version + 1;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Trigger to automatically increment version
CREATE TRIGGER tg_documents_version_increment
    BEFORE UPDATE ON documents
    FOR EACH ROW 
    EXECUTE FUNCTION increment_document_version();

-- Audit table for document changes
CREATE TABLE IF NOT EXISTS document_audit (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    document_id UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    action VARCHAR(10) NOT NULL CHECK (action IN ('INSERT', 'UPDATE', 'DELETE')),
    changed_by TEXT,
    changed_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    old_values JSONB,
    new_values JSONB
);

CREATE INDEX idx_document_audit_document_id ON document_audit(document_id);
CREATE INDEX idx_document_audit_changed_at ON document_audit(changed_at);

-- Function to audit document changes
CREATE OR REPLACE FUNCTION audit_document_changes() RETURNS trigger AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        INSERT INTO document_audit (document_id, action, old_values)
        VALUES (OLD.id, TG_OP, to_jsonb(OLD));
        RETURN OLD;
    ELSIF TG_OP = 'UPDATE' THEN
        INSERT INTO document_audit (document_id, action, old_values, new_values)
        VALUES (NEW.id, TG_OP, to_jsonb(OLD), to_jsonb(NEW));
        RETURN NEW;
    ELSIF TG_OP = 'INSERT' THEN
        INSERT INTO document_audit (document_id, action, new_values)
        VALUES (NEW.id, TG_OP, to_jsonb(NEW));
        RETURN NEW;
    END IF;
END;
$$ LANGUAGE plpgsql;

-- Trigger for document auditing
CREATE TRIGGER tg_documents_audit
    AFTER INSERT OR UPDATE OR DELETE ON documents
    FOR EACH ROW 
    EXECUTE FUNCTION audit_document_changes();

-- Grant permissions (adjust as needed)
GRANT ALL ON SCHEMA graphrag TO PUBLIC;
GRANT ALL ON ALL TABLES IN SCHEMA graphrag TO PUBLIC;
GRANT ALL ON ALL SEQUENCES IN SCHEMA graphrag TO PUBLIC;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA graphrag TO PUBLIC;

-- Add comments for documentation
COMMENT ON TABLE documents IS 'Stores metadata for all documents in the GraphRAG system';
COMMENT ON TABLE document_content IS 'Stores the actual content of documents';
COMMENT ON TABLE document_summaries IS 'AI-generated summaries of documents';
COMMENT ON TABLE document_outlines IS 'Hierarchical outlines of document structure';
COMMENT ON TABLE search_index IS 'Full-text search index for documents';
COMMENT ON TABLE document_audit IS 'Audit trail for document changes';

COMMENT ON COLUMN documents.hash IS 'SHA256 hash of document content for deduplication';
COMMENT ON COLUMN documents.type IS 'Document type: code, markdown, text, structured, or multimodal';
COMMENT ON COLUMN document_summaries.key_points IS 'JSON array of key points extracted from document';
COMMENT ON COLUMN document_outlines.outline_json IS 'Hierarchical JSON structure representing document outline';
COMMENT ON COLUMN search_index.search_vector IS 'tsvector for full-text search, automatically maintained';
