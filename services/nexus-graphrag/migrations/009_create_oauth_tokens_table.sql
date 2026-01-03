-- Migration 009: Create OAuth Tokens Table for Persistent Storage
-- Stores Google OAuth tokens in PostgreSQL for persistence across Redis restarts

-- Create schema if it doesn't exist
CREATE SCHEMA IF NOT EXISTS graphrag;

CREATE TABLE IF NOT EXISTS graphrag.oauth_tokens (
    id SERIAL PRIMARY KEY,

    -- Provider identification
    provider VARCHAR(50) NOT NULL DEFAULT 'google',

    -- Token data
    access_token TEXT NOT NULL,
    refresh_token TEXT,
    token_type VARCHAR(50) DEFAULT 'Bearer',

    -- Expiration tracking
    expiry_date BIGINT, -- Unix timestamp in milliseconds

    -- Scopes granted
    scope TEXT,

    -- Metadata
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    last_used_at TIMESTAMP WITH TIME ZONE,

    -- User/session tracking (optional)
    user_id VARCHAR(255),
    session_id VARCHAR(255),

    -- Additional metadata
    metadata JSONB DEFAULT '{}'::jsonb,

    -- Constraints
    CONSTRAINT unique_provider_user UNIQUE (provider, user_id)
);

-- Index for fast lookups
CREATE INDEX IF NOT EXISTS idx_oauth_tokens_provider ON graphrag.oauth_tokens(provider);
CREATE INDEX IF NOT EXISTS idx_oauth_tokens_user ON graphrag.oauth_tokens(user_id);
CREATE INDEX IF NOT EXISTS idx_oauth_tokens_updated ON graphrag.oauth_tokens(updated_at DESC);

-- Updated timestamp trigger
CREATE OR REPLACE FUNCTION graphrag.update_oauth_tokens_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER oauth_tokens_updated_at
    BEFORE UPDATE ON graphrag.oauth_tokens
    FOR EACH ROW
    EXECUTE FUNCTION graphrag.update_oauth_tokens_updated_at();

-- Comments
COMMENT ON TABLE graphrag.oauth_tokens IS 'Persistent storage for OAuth tokens (Google Drive, etc.)';
COMMENT ON COLUMN graphrag.oauth_tokens.provider IS 'OAuth provider name (google, github, etc.)';
COMMENT ON COLUMN graphrag.oauth_tokens.access_token IS 'OAuth access token (encrypted in production)';
COMMENT ON COLUMN graphrag.oauth_tokens.refresh_token IS 'OAuth refresh token for automatic renewal';
COMMENT ON COLUMN graphrag.oauth_tokens.expiry_date IS 'Token expiration timestamp (Unix milliseconds)';
COMMENT ON COLUMN graphrag.oauth_tokens.scope IS 'Granted OAuth scopes (space-separated)';
COMMENT ON COLUMN graphrag.oauth_tokens.last_used_at IS 'Last time this token was used';
