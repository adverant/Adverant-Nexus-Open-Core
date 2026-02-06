-- NexusCRM Schema Extension
-- Extends existing GraphRAG database with CRM-specific tables
-- **IMPORTANT**: This adds to the existing database, does NOT create a new one

-- Enable required extensions (if not already enabled)
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pg_trgm";

-- Create NexusCRM schema
CREATE SCHEMA IF NOT EXISTS nexuscrm;

-- Set search path
SET search_path TO nexuscrm, graphrag, public;

-- ============================================================================
-- CORE CRM ENTITIES
-- ============================================================================

-- Companies table
CREATE TABLE IF NOT EXISTS nexuscrm.companies (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name VARCHAR(255) NOT NULL,
    domain VARCHAR(255) UNIQUE,
    industry VARCHAR(100),
    size VARCHAR(50) CHECK (size IN ('1-10', '11-50', '51-200', '201-500', '501-1000', '1001-5000', '5001+')),
    revenue_range VARCHAR(50), -- e.g., '$1M-$10M'
    employee_count INTEGER,
    founded_year INTEGER,
    description TEXT,
    website VARCHAR(500),
    phone VARCHAR(50),
    address JSONB, -- { street, city, state, country, postal_code, coordinates: {lat, lng} }
    social_links JSONB DEFAULT '{}', -- { linkedin, twitter, facebook, etc. }
    enrichment_data JSONB DEFAULT '{}', -- Data from enrichment APIs
    enrichment_source VARCHAR(100), -- 'clearbit', 'scraper', 'manual', etc.
    enrichment_confidence DECIMAL(3, 2) CHECK (enrichment_confidence >= 0 AND enrichment_confidence <= 1),
    enriched_at TIMESTAMP WITH TIME ZONE,
    tags TEXT[] DEFAULT '{}',
    custom_fields JSONB DEFAULT '{}',
    owner_id UUID, -- Sales rep owner
    organization_id UUID NOT NULL, -- Multi-tenant support
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    deleted_at TIMESTAMP WITH TIME ZONE, -- Soft delete
    CONSTRAINT valid_employee_count CHECK (employee_count IS NULL OR employee_count >= 0),
    CONSTRAINT valid_founded_year CHECK (founded_year IS NULL OR (founded_year >= 1800 AND founded_year <= EXTRACT(YEAR FROM CURRENT_DATE)))
);

-- Contacts table
CREATE TABLE IF NOT EXISTS nexuscrm.contacts (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    company_id UUID REFERENCES nexuscrm.companies(id) ON DELETE SET NULL,
    first_name VARCHAR(100),
    last_name VARCHAR(100),
    full_name VARCHAR(255) GENERATED ALWAYS AS (
        TRIM(COALESCE(first_name, '') || ' ' || COALESCE(last_name, ''))
    ) STORED,
    email VARCHAR(255),
    email_verified BOOLEAN DEFAULT FALSE,
    phone VARCHAR(50),
    phone_verified BOOLEAN DEFAULT FALSE,
    mobile VARCHAR(50),
    job_title VARCHAR(150),
    department VARCHAR(100),
    seniority VARCHAR(50) CHECK (seniority IN ('IC', 'Manager', 'Director', 'VP', 'C-Level', 'Owner')),
    decision_maker BOOLEAN DEFAULT FALSE,
    linkedin_url VARCHAR(500),
    twitter_handle VARCHAR(100),
    address JSONB, -- { street, city, state, country, postal_code }
    timezone VARCHAR(50), -- e.g., 'America/New_York'
    language VARCHAR(10) DEFAULT 'en', -- ISO 639-1 code
    lead_score INTEGER DEFAULT 0 CHECK (lead_score >= 0 AND lead_score <= 100),
    lead_status VARCHAR(50) DEFAULT 'new' CHECK (lead_status IN (
        'new', 'contacted', 'qualified', 'unqualified', 'customer', 'churned', 'unsubscribed'
    )),
    lead_source VARCHAR(100), -- 'website', 'referral', 'cold-call', 'event', etc.
    lifecycle_stage VARCHAR(50) CHECK (lifecycle_stage IN (
        'subscriber', 'lead', 'mql', 'sql', 'opportunity', 'customer', 'evangelist'
    )),
    do_not_call BOOLEAN DEFAULT FALSE,
    do_not_email BOOLEAN DEFAULT FALSE,
    unsubscribed BOOLEAN DEFAULT FALSE,
    unsubscribed_at TIMESTAMP WITH TIME ZONE,
    bounced BOOLEAN DEFAULT FALSE,
    bounced_at TIMESTAMP WITH TIME ZONE,
    enrichment_data JSONB DEFAULT '{}',
    enrichment_source VARCHAR(100),
    enrichment_confidence DECIMAL(3, 2) CHECK (enrichment_confidence >= 0 AND enrichment_confidence <= 1),
    enriched_at TIMESTAMP WITH TIME ZONE,
    tags TEXT[] DEFAULT '{}',
    custom_fields JSONB DEFAULT '{}',
    owner_id UUID, -- Sales rep owner
    organization_id UUID NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    last_contacted_at TIMESTAMP WITH TIME ZONE,
    last_scored_at TIMESTAMP WITH TIME ZONE,
    deleted_at TIMESTAMP WITH TIME ZONE,
    CONSTRAINT unique_email_per_org UNIQUE NULLS NOT DISTINCT (email, organization_id),
    CONSTRAINT contact_has_identifier CHECK (
        email IS NOT NULL OR phone IS NOT NULL OR mobile IS NOT NULL
    )
);

-- Deals table
CREATE TABLE IF NOT EXISTS nexuscrm.deals (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name VARCHAR(255) NOT NULL,
    company_id UUID REFERENCES nexuscrm.companies(id) ON DELETE CASCADE,
    primary_contact_id UUID REFERENCES nexuscrm.contacts(id) ON DELETE SET NULL,
    amount DECIMAL(15, 2) CHECK (amount >= 0),
    currency VARCHAR(3) DEFAULT 'USD',
    stage VARCHAR(100) NOT NULL, -- e.g., 'prospecting', 'qualification', 'proposal', 'negotiation', 'closed-won', 'closed-lost'
    stage_changed_at TIMESTAMP WITH TIME ZONE,
    probability INTEGER CHECK (probability >= 0 AND probability <= 100),
    expected_close_date DATE,
    actual_close_date DATE,
    close_reason VARCHAR(500), -- For won/lost deals
    deal_type VARCHAR(50) CHECK (deal_type IN ('new-business', 'expansion', 'renewal', 'upsell', 'cross-sell')),
    lost_reason VARCHAR(500),
    lost_to_competitor VARCHAR(255),
    mrr DECIMAL(15, 2) CHECK (mrr >= 0), -- Monthly recurring revenue
    arr DECIMAL(15, 2) CHECK (arr >= 0), -- Annual recurring revenue
    contract_term_months INTEGER CHECK (contract_term_months > 0),
    products_sold JSONB DEFAULT '[]', -- Array of {product_id, quantity, price}
    custom_fields JSONB DEFAULT '{}',
    tags TEXT[] DEFAULT '{}',
    owner_id UUID, -- Sales rep owner
    organization_id UUID NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    deleted_at TIMESTAMP WITH TIME ZONE
);

-- Activities table (calls, emails, meetings, tasks)
CREATE TABLE IF NOT EXISTS nexuscrm.activities (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    type VARCHAR(50) NOT NULL CHECK (type IN (
        'call', 'email', 'meeting', 'task', 'note', 'sms', 'whatsapp', 'linkedin-message'
    )),
    subject VARCHAR(500),
    body TEXT,
    direction VARCHAR(20) CHECK (direction IN ('inbound', 'outbound', 'internal')),

    -- Related entities
    contact_id UUID REFERENCES nexuscrm.contacts(id) ON DELETE CASCADE,
    company_id UUID REFERENCES nexuscrm.companies(id) ON DELETE CASCADE,
    deal_id UUID REFERENCES nexuscrm.deals(id) ON DELETE CASCADE,

    -- Call-specific fields
    from_number VARCHAR(50),
    to_number VARCHAR(50),
    duration_seconds INTEGER CHECK (duration_seconds >= 0),
    call_status VARCHAR(50) CHECK (call_status IN (
        'completed', 'no-answer', 'busy', 'failed', 'voicemail', 'cancelled'
    )),
    recording_url VARCHAR(1000),
    transcript TEXT,
    transcript_segments JSONB, -- Array of {speaker, text, start_time, end_time}

    -- Sentiment analysis (from MageAgent)
    sentiment VARCHAR(20) CHECK (sentiment IN ('positive', 'neutral', 'negative', 'mixed')),
    sentiment_score DECIMAL(3, 2) CHECK (sentiment_score >= -1 AND sentiment_score <= 1),
    sentiment_analysis JSONB, -- Detailed analysis from MageAgent

    -- Keywords and entities extracted
    keywords_detected TEXT[] DEFAULT '{}',
    entities_mentioned JSONB DEFAULT '[]', -- Array of {type, value, confidence}

    -- AI analysis
    ai_summary TEXT, -- Generated by MageAgent
    action_items JSONB DEFAULT '[]', -- Array of {item, assigned_to, due_date}
    objections_raised JSONB DEFAULT '[]', -- Array of {objection, response}
    buying_signals JSONB DEFAULT '[]', -- Array of signals detected

    -- Email-specific fields
    from_email VARCHAR(255),
    to_emails JSONB, -- Array of email addresses
    cc_emails JSONB,
    bcc_emails JSONB,
    email_opened BOOLEAN DEFAULT FALSE,
    email_opened_at TIMESTAMP WITH TIME ZONE,
    email_clicked BOOLEAN DEFAULT FALSE,
    email_clicked_at TIMESTAMP WITH TIME ZONE,
    email_bounced BOOLEAN DEFAULT FALSE,
    email_bounced_reason VARCHAR(500),

    -- Meeting-specific fields
    meeting_start_time TIMESTAMP WITH TIME ZONE,
    meeting_end_time TIMESTAMP WITH TIME ZONE,
    meeting_location VARCHAR(500),
    meeting_attendees JSONB, -- Array of {email, name, status}
    meeting_url VARCHAR(1000), -- Zoom/Teams link

    -- Task-specific fields
    task_status VARCHAR(50) CHECK (task_status IN ('pending', 'in-progress', 'completed', 'cancelled')),
    task_priority VARCHAR(20) CHECK (task_priority IN ('low', 'medium', 'high', 'urgent')),
    task_due_date TIMESTAMP WITH TIME ZONE,
    task_completed_at TIMESTAMP WITH TIME ZONE,

    -- Cost tracking
    cost_usd DECIMAL(10, 4) CHECK (cost_usd >= 0),

    -- Metadata
    external_id VARCHAR(255), -- ID from external system (Vapi, Twilio, etc.)
    metadata JSONB DEFAULT '{}',
    tags TEXT[] DEFAULT '{}',

    -- Ownership
    created_by UUID,
    assigned_to UUID,
    organization_id UUID NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    completed_at TIMESTAMP WITH TIME ZONE,
    deleted_at TIMESTAMP WITH TIME ZONE
);

-- ============================================================================
-- MARKETING AUTOMATION
-- ============================================================================

-- Campaigns table
CREATE TABLE IF NOT EXISTS nexuscrm.campaigns (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name VARCHAR(255) NOT NULL,
    description TEXT,
    type VARCHAR(50) NOT NULL CHECK (type IN (
        'email-drip', 'voice-outbound', 'sms-blast', 'whatsapp-campaign', 'multi-channel'
    )),
    status VARCHAR(50) DEFAULT 'draft' CHECK (status IN (
        'draft', 'scheduled', 'active', 'paused', 'completed', 'cancelled'
    )),

    -- Workflow integration (uses OrchestrationAgent)
    workflow_goal TEXT, -- Natural language goal for OrchestrationAgent
    workflow_config JSONB, -- Configuration passed to OrchestrationAgent
    orchestration_execution_id UUID, -- ID from OrchestrationAgent

    -- Campaign configuration
    target_segment_id UUID, -- Reference to segment definition
    target_count INTEGER DEFAULT 0,

    -- Scheduling
    scheduled_at TIMESTAMP WITH TIME ZONE,
    launched_at TIMESTAMP WITH TIME ZONE,
    completed_at TIMESTAMP WITH TIME ZONE,

    -- Campaign content (for email/sms)
    email_subject VARCHAR(500),
    email_body_html TEXT,
    email_body_text TEXT,
    email_from_name VARCHAR(255),
    email_from_email VARCHAR(255),
    email_reply_to VARCHAR(255),
    sms_message TEXT,
    voice_script TEXT,
    voice_assistant_config JSONB, -- Vapi assistant configuration

    -- Metrics (updated as campaign runs)
    sent_count INTEGER DEFAULT 0,
    delivered_count INTEGER DEFAULT 0,
    opened_count INTEGER DEFAULT 0,
    clicked_count INTEGER DEFAULT 0,
    replied_count INTEGER DEFAULT 0,
    converted_count INTEGER DEFAULT 0,
    bounced_count INTEGER DEFAULT 0,
    unsubscribed_count INTEGER DEFAULT 0,
    failed_count INTEGER DEFAULT 0,

    -- Calculated rates
    open_rate DECIMAL(5, 4) GENERATED ALWAYS AS (
        CASE WHEN delivered_count > 0
        THEN ROUND(opened_count::DECIMAL / delivered_count, 4)
        ELSE 0 END
    ) STORED,
    click_rate DECIMAL(5, 4) GENERATED ALWAYS AS (
        CASE WHEN opened_count > 0
        THEN ROUND(clicked_count::DECIMAL / opened_count, 4)
        ELSE 0 END
    ) STORED,
    conversion_rate DECIMAL(5, 4) GENERATED ALWAYS AS (
        CASE WHEN delivered_count > 0
        THEN ROUND(converted_count::DECIMAL / delivered_count, 4)
        ELSE 0 END
    ) STORED,

    -- Cost tracking
    total_cost_usd DECIMAL(10, 2) DEFAULT 0,

    -- Metadata
    tags TEXT[] DEFAULT '{}',
    custom_fields JSONB DEFAULT '{}',

    -- Ownership
    created_by UUID,
    organization_id UUID NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    deleted_at TIMESTAMP WITH TIME ZONE
);

-- Segments table (for targeting)
CREATE TABLE IF NOT EXISTS nexuscrm.segments (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name VARCHAR(255) NOT NULL,
    description TEXT,
    type VARCHAR(50) CHECK (type IN ('static', 'dynamic')),

    -- Filter criteria (SQL WHERE clause or JSONB query)
    filter_criteria JSONB NOT NULL,

    -- Cached results for static segments
    cached_contacts JSONB, -- Array of contact IDs
    cached_count INTEGER,
    cached_at TIMESTAMP WITH TIME ZONE,

    tags TEXT[] DEFAULT '{}',
    organization_id UUID NOT NULL,
    created_by UUID,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    deleted_at TIMESTAMP WITH TIME ZONE
);

-- ============================================================================
-- VOICE CALLING (NEW CAPABILITY)
-- ============================================================================

-- Voice calls table (detailed call records)
CREATE TABLE IF NOT EXISTS nexuscrm.voice_calls (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    activity_id UUID REFERENCES nexuscrm.activities(id) ON DELETE CASCADE,

    -- Call details
    platform VARCHAR(50) CHECK (platform IN ('vapi', 'twilio', 'internal')),
    external_call_id VARCHAR(255), -- ID from Vapi/Twilio
    from_number VARCHAR(50) NOT NULL,
    to_number VARCHAR(50) NOT NULL,

    -- Call flow
    status VARCHAR(50) CHECK (status IN (
        'initiated', 'ringing', 'in-progress', 'completed', 'no-answer', 'busy', 'failed', 'voicemail'
    )),
    initiated_at TIMESTAMP WITH TIME ZONE,
    answered_at TIMESTAMP WITH TIME ZONE,
    ended_at TIMESTAMP WITH TIME ZONE,
    duration_seconds INTEGER,

    -- Voice AI configuration
    assistant_config JSONB, -- Vapi assistant configuration used
    stt_provider VARCHAR(50), -- 'deepgram', 'whisper', etc.
    tts_provider VARCHAR(50), -- 'elevenlabs', 'cartesia', etc.
    llm_model VARCHAR(100), -- 'gpt-4-turbo', 'claude-opus-4-6-20260206', etc.

    -- Recording and transcript
    recording_url VARCHAR(1000),
    recording_duration INTEGER,
    transcript TEXT,
    transcript_language VARCHAR(10),

    -- AI analysis (from MageAgent)
    sentiment_overall VARCHAR(20),
    sentiment_timeline JSONB, -- Array of {timestamp, sentiment, score}
    keywords_detected TEXT[],
    topics_discussed JSONB, -- Array of {topic, relevance, mentions}
    objections_raised JSONB,
    buying_signals JSONB,
    action_items JSONB,
    call_outcome VARCHAR(100), -- 'qualified', 'not-interested', 'callback-requested', 'meeting-booked', etc.
    deal_score INTEGER CHECK (deal_score >= 0 AND deal_score <= 100),

    -- Cost tracking
    cost_usd DECIMAL(10, 4),
    cost_breakdown JSONB, -- {stt: X, llm: Y, tts: Z, telephony: W}

    -- Metadata
    metadata JSONB DEFAULT '{}',
    organization_id UUID NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- ============================================================================
-- EMAIL TRACKING
-- ============================================================================

-- Email messages table (detailed email records)
CREATE TABLE IF NOT EXISTS nexuscrm.email_messages (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    activity_id UUID REFERENCES nexuscrm.activities(id) ON DELETE CASCADE,
    campaign_id UUID REFERENCES nexuscrm.campaigns(id) ON DELETE SET NULL,

    -- Email details
    from_email VARCHAR(255) NOT NULL,
    from_name VARCHAR(255),
    to_email VARCHAR(255) NOT NULL,
    cc_emails JSONB,
    bcc_emails JSONB,
    reply_to VARCHAR(255),
    subject VARCHAR(500),
    body_html TEXT,
    body_text TEXT,

    -- Delivery tracking
    sent_at TIMESTAMP WITH TIME ZONE,
    delivered_at TIMESTAMP WITH TIME ZONE,
    bounced_at TIMESTAMP WITH TIME ZONE,
    bounce_reason VARCHAR(500),

    -- Engagement tracking
    opened_at TIMESTAMP WITH TIME ZONE,
    opened_count INTEGER DEFAULT 0,
    clicked_at TIMESTAMP WITH TIME ZONE,
    clicked_count INTEGER DEFAULT 0,
    clicked_links JSONB, -- Array of {url, clicked_at}
    replied_at TIMESTAMP WITH TIME ZONE,
    unsubscribed_at TIMESTAMP WITH TIME ZONE,

    -- External tracking
    external_message_id VARCHAR(255), -- SendGrid/SES message ID
    tracking_pixel_url VARCHAR(1000),

    -- Metadata
    metadata JSONB DEFAULT '{}',
    organization_id UUID NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- ============================================================================
-- ENRICHMENT & INTEGRATIONS
-- ============================================================================

-- Enrichment jobs table (track enrichment requests)
CREATE TABLE IF NOT EXISTS nexuscrm.enrichment_jobs (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    entity_type VARCHAR(50) CHECK (entity_type IN ('contact', 'company')),
    entity_id UUID NOT NULL,
    enrichment_type VARCHAR(100), -- 'clearbit', 'scraper', 'linkedin', etc.
    status VARCHAR(50) CHECK (status IN ('pending', 'in-progress', 'completed', 'failed')),

    -- Results
    data_found JSONB,
    confidence_score DECIMAL(3, 2) CHECK (confidence_score >= 0 AND confidence_score <= 1),

    -- Execution details
    started_at TIMESTAMP WITH TIME ZONE,
    completed_at TIMESTAMP WITH TIME ZONE,
    error_message TEXT,
    cost_usd DECIMAL(10, 4),

    organization_id UUID NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Webhooks table (for external integrations)
CREATE TABLE IF NOT EXISTS nexuscrm.webhooks (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name VARCHAR(255) NOT NULL,
    url VARCHAR(1000) NOT NULL,
    method VARCHAR(10) DEFAULT 'POST' CHECK (method IN ('GET', 'POST', 'PUT', 'PATCH')),
    events TEXT[] NOT NULL, -- e.g., ['contact.created', 'deal.won', 'call.completed']
    active BOOLEAN DEFAULT TRUE,
    secret VARCHAR(255), -- For signature verification

    -- Retry configuration
    retry_enabled BOOLEAN DEFAULT TRUE,
    max_retries INTEGER DEFAULT 3,

    -- Statistics
    total_deliveries INTEGER DEFAULT 0,
    successful_deliveries INTEGER DEFAULT 0,
    failed_deliveries INTEGER DEFAULT 0,
    last_delivery_at TIMESTAMP WITH TIME ZONE,
    last_delivery_status VARCHAR(50),

    organization_id UUID NOT NULL,
    created_by UUID,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    deleted_at TIMESTAMP WITH TIME ZONE
);

-- ============================================================================
-- INDEXES FOR PERFORMANCE
-- ============================================================================

-- Companies indexes
CREATE INDEX idx_companies_name ON nexuscrm.companies USING gin(to_tsvector('english', name));
CREATE INDEX idx_companies_domain ON nexuscrm.companies(domain) WHERE domain IS NOT NULL;
CREATE INDEX idx_companies_industry ON nexuscrm.companies(industry);
CREATE INDEX idx_companies_size ON nexuscrm.companies(size);
CREATE INDEX idx_companies_owner ON nexuscrm.companies(owner_id);
CREATE INDEX idx_companies_org ON nexuscrm.companies(organization_id);
CREATE INDEX idx_companies_created ON nexuscrm.companies(created_at DESC);
CREATE INDEX idx_companies_tags ON nexuscrm.companies USING gin(tags);
CREATE INDEX idx_companies_active ON nexuscrm.companies(id) WHERE deleted_at IS NULL;

-- Contacts indexes
CREATE INDEX idx_contacts_name ON nexuscrm.contacts USING gin(to_tsvector('english', full_name));
CREATE INDEX idx_contacts_email ON nexuscrm.contacts(email) WHERE email IS NOT NULL;
CREATE INDEX idx_contacts_phone ON nexuscrm.contacts(phone) WHERE phone IS NOT NULL;
CREATE INDEX idx_contacts_company ON nexuscrm.contacts(company_id);
CREATE INDEX idx_contacts_owner ON nexuscrm.contacts(owner_id);
CREATE INDEX idx_contacts_org ON nexuscrm.contacts(organization_id);
CREATE INDEX idx_contacts_status ON nexuscrm.contacts(lead_status);
CREATE INDEX idx_contacts_score ON nexuscrm.contacts(lead_score DESC);
CREATE INDEX idx_contacts_lifecycle ON nexuscrm.contacts(lifecycle_stage);
CREATE INDEX idx_contacts_created ON nexuscrm.contacts(created_at DESC);
CREATE INDEX idx_contacts_last_contacted ON nexuscrm.contacts(last_contacted_at DESC NULLS LAST);
CREATE INDEX idx_contacts_tags ON nexuscrm.contacts USING gin(tags);
CREATE INDEX idx_contacts_active ON nexuscrm.contacts(id) WHERE deleted_at IS NULL;

-- Deals indexes
CREATE INDEX idx_deals_name ON nexuscrm.deals USING gin(to_tsvector('english', name));
CREATE INDEX idx_deals_company ON nexuscrm.deals(company_id);
CREATE INDEX idx_deals_contact ON nexuscrm.deals(primary_contact_id);
CREATE INDEX idx_deals_owner ON nexuscrm.deals(owner_id);
CREATE INDEX idx_deals_org ON nexuscrm.deals(organization_id);
CREATE INDEX idx_deals_stage ON nexuscrm.deals(stage);
CREATE INDEX idx_deals_amount ON nexuscrm.deals(amount DESC);
CREATE INDEX idx_deals_close_date ON nexuscrm.deals(expected_close_date) WHERE expected_close_date IS NOT NULL;
CREATE INDEX idx_deals_probability ON nexuscrm.deals(probability DESC) WHERE probability IS NOT NULL;
CREATE INDEX idx_deals_created ON nexuscrm.deals(created_at DESC);
CREATE INDEX idx_deals_tags ON nexuscrm.deals USING gin(tags);
CREATE INDEX idx_deals_active ON nexuscrm.deals(id) WHERE deleted_at IS NULL;

-- Activities indexes
CREATE INDEX idx_activities_type ON nexuscrm.activities(type);
CREATE INDEX idx_activities_contact ON nexuscrm.activities(contact_id);
CREATE INDEX idx_activities_company ON nexuscrm.activities(company_id);
CREATE INDEX idx_activities_deal ON nexuscrm.activities(deal_id);
CREATE INDEX idx_activities_assigned ON nexuscrm.activities(assigned_to);
CREATE INDEX idx_activities_org ON nexuscrm.activities(organization_id);
CREATE INDEX idx_activities_created ON nexuscrm.activities(created_at DESC);
CREATE INDEX idx_activities_sentiment ON nexuscrm.activities(sentiment) WHERE sentiment IS NOT NULL;
CREATE INDEX idx_activities_call_status ON nexuscrm.activities(call_status) WHERE call_status IS NOT NULL;
CREATE INDEX idx_activities_task_status ON nexuscrm.activities(task_status) WHERE task_status IS NOT NULL;
CREATE INDEX idx_activities_active ON nexuscrm.activities(id) WHERE deleted_at IS NULL;

-- Campaigns indexes
CREATE INDEX idx_campaigns_type ON nexuscrm.campaigns(type);
CREATE INDEX idx_campaigns_status ON nexuscrm.campaigns(status);
CREATE INDEX idx_campaigns_org ON nexuscrm.campaigns(organization_id);
CREATE INDEX idx_campaigns_launched ON nexuscrm.campaigns(launched_at DESC NULLS LAST);
CREATE INDEX idx_campaigns_conversion_rate ON nexuscrm.campaigns(conversion_rate DESC);

-- Voice calls indexes
CREATE INDEX idx_voice_calls_activity ON nexuscrm.voice_calls(activity_id);
CREATE INDEX idx_voice_calls_platform ON nexuscrm.voice_calls(platform);
CREATE INDEX idx_voice_calls_status ON nexuscrm.voice_calls(status);
CREATE INDEX idx_voice_calls_org ON nexuscrm.voice_calls(organization_id);
CREATE INDEX idx_voice_calls_initiated ON nexuscrm.voice_calls(initiated_at DESC);
CREATE INDEX idx_voice_calls_outcome ON nexuscrm.voice_calls(call_outcome) WHERE call_outcome IS NOT NULL;

-- Email messages indexes
CREATE INDEX idx_email_messages_activity ON nexuscrm.email_messages(activity_id);
CREATE INDEX idx_email_messages_campaign ON nexuscrm.email_messages(campaign_id);
CREATE INDEX idx_email_messages_org ON nexuscrm.email_messages(organization_id);
CREATE INDEX idx_email_messages_sent ON nexuscrm.email_messages(sent_at DESC);
CREATE INDEX idx_email_messages_opened ON nexuscrm.email_messages(opened_at DESC NULLS LAST);

-- ============================================================================
-- TRIGGERS FOR UPDATED_AT TIMESTAMPS
-- ============================================================================

CREATE OR REPLACE FUNCTION nexuscrm.update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Apply trigger to tables with updated_at
CREATE TRIGGER update_companies_updated_at
    BEFORE UPDATE ON nexuscrm.companies
    FOR EACH ROW EXECUTE FUNCTION nexuscrm.update_updated_at_column();

CREATE TRIGGER update_contacts_updated_at
    BEFORE UPDATE ON nexuscrm.contacts
    FOR EACH ROW EXECUTE FUNCTION nexuscrm.update_updated_at_column();

CREATE TRIGGER update_deals_updated_at
    BEFORE UPDATE ON nexuscrm.deals
    FOR EACH ROW EXECUTE FUNCTION nexuscrm.update_updated_at_column();

CREATE TRIGGER update_activities_updated_at
    BEFORE UPDATE ON nexuscrm.activities
    FOR EACH ROW EXECUTE FUNCTION nexuscrm.update_updated_at_column();

CREATE TRIGGER update_campaigns_updated_at
    BEFORE UPDATE ON nexuscrm.campaigns
    FOR EACH ROW EXECUTE FUNCTION nexuscrm.update_updated_at_column();

CREATE TRIGGER update_voice_calls_updated_at
    BEFORE UPDATE ON nexuscrm.voice_calls
    FOR EACH ROW EXECUTE FUNCTION nexuscrm.update_updated_at_column();

CREATE TRIGGER update_email_messages_updated_at
    BEFORE UPDATE ON nexuscrm.email_messages
    FOR EACH ROW EXECUTE FUNCTION nexuscrm.update_updated_at_column();

-- ============================================================================
-- ROW-LEVEL SECURITY (RLS) FOR MULTI-TENANCY
-- ============================================================================

-- Enable RLS on all CRM tables
ALTER TABLE nexuscrm.companies ENABLE ROW LEVEL SECURITY;
ALTER TABLE nexuscrm.contacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE nexuscrm.deals ENABLE ROW LEVEL SECURITY;
ALTER TABLE nexuscrm.activities ENABLE ROW LEVEL SECURITY;
ALTER TABLE nexuscrm.campaigns ENABLE ROW LEVEL SECURITY;
ALTER TABLE nexuscrm.segments ENABLE ROW LEVEL SECURITY;
ALTER TABLE nexuscrm.voice_calls ENABLE ROW LEVEL SECURITY;
ALTER TABLE nexuscrm.email_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE nexuscrm.enrichment_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE nexuscrm.webhooks ENABLE ROW LEVEL SECURITY;

-- Create RLS policies (enforced by application via SET SESSION)
-- Example policy (application sets current_setting('app.current_organization_id'))

CREATE POLICY companies_isolation_policy ON nexuscrm.companies
    USING (organization_id = current_setting('app.current_organization_id')::UUID);

CREATE POLICY contacts_isolation_policy ON nexuscrm.contacts
    USING (organization_id = current_setting('app.current_organization_id')::UUID);

CREATE POLICY deals_isolation_policy ON nexuscrm.deals
    USING (organization_id = current_setting('app.current_organization_id')::UUID);

CREATE POLICY activities_isolation_policy ON nexuscrm.activities
    USING (organization_id = current_setting('app.current_organization_id')::UUID);

CREATE POLICY campaigns_isolation_policy ON nexuscrm.campaigns
    USING (organization_id = current_setting('app.current_organization_id')::UUID);

CREATE POLICY segments_isolation_policy ON nexuscrm.segments
    USING (organization_id = current_setting('app.current_organization_id')::UUID);

CREATE POLICY voice_calls_isolation_policy ON nexuscrm.voice_calls
    USING (organization_id = current_setting('app.current_organization_id')::UUID);

CREATE POLICY email_messages_isolation_policy ON nexuscrm.email_messages
    USING (organization_id = current_setting('app.current_organization_id')::UUID);

CREATE POLICY enrichment_jobs_isolation_policy ON nexuscrm.enrichment_jobs
    USING (organization_id = current_setting('app.current_organization_id')::UUID);

CREATE POLICY webhooks_isolation_policy ON nexuscrm.webhooks
    USING (organization_id = current_setting('app.current_organization_id')::UUID);

-- ============================================================================
-- INITIAL DATA / SAMPLE DATA (Optional)
-- ============================================================================

-- Add sample lead statuses, stages, etc. (can be customized per organization)
-- This is just metadata for reference

COMMENT ON SCHEMA nexuscrm IS 'NexusCRM schema - extends GraphRAG database with CRM-specific tables';
COMMENT ON TABLE nexuscrm.companies IS 'Companies (B2B accounts)';
COMMENT ON TABLE nexuscrm.contacts IS 'Contacts (people within companies)';
COMMENT ON TABLE nexuscrm.deals IS 'Sales opportunities';
COMMENT ON TABLE nexuscrm.activities IS 'All interactions (calls, emails, meetings, tasks)';
COMMENT ON TABLE nexuscrm.campaigns IS 'Marketing campaigns leveraging OrchestrationAgent';
COMMENT ON TABLE nexuscrm.voice_calls IS 'Voice calling details with AI analysis';
COMMENT ON TABLE nexuscrm.email_messages IS 'Email tracking and engagement';

-- Migration complete
-- NexusCRM schema has been added to the existing GraphRAG database
-- Next: Run this migration and test CRM operations
