// Unused imports removed - uuidv4 and crypto not used in type definitions

// Page boundary information for multi-page documents (PDFs)
export interface PageInfo {
  pageNumber: number;  // 1-indexed page number
  startChar: number;   // Character offset where page content starts
  endChar: number;     // Character offset where page content ends
}

// Document storage and retrieval types
export interface DocumentHierarchy {
  document: {
    id: string;
    content: string;
    metadata: DocumentMetadata;
    chunks: Chunk[];
    summary: string;
    outline: DocumentOutline;
  };
  relationships: ChunkRelationship[];
  retrievalStrategy: RetrievalStrategy;
}

export interface DocumentMetadata {
  id?: string;
  title: string;
  type: 'code' | 'markdown' | 'text' | 'structured' | 'multimodal';
  format: string; // 'json', 'yaml', 'md', 'tsx', 'py', etc.
  size: number;
  hash: string;
  created_at: string;
  updated_at: string;
  version: number;
  tags: string[];
  source: string; // URL, file path, etc.
  language?: string; // For code files
  encoding?: string;
  custom: Record<string, any>;
  _chunkingHints?: any;
  filename?: string;
  domain?: string;
  // Document processor properties
  dna?: any;
  layout?: any;
  processingOptions?: any;
  originalFormat?: string;
  parsedFrom?: string;
  // Page information for multi-page documents (PDFs)
  pages?: PageInfo[];   // Page boundaries with character offsets
  pageCount?: number;   // Total number of pages
  // Artifact references for permanent file storage (PDFs, documents, binaries)
  artifactId?: string;      // UUID reference to fileprocess.artifacts table
  artifactUrl?: string;     // Permanent download URL (presigned or shareable link)
  storageBackend?: string;  // Storage type: postgres_buffer, minio, google_drive
  documentDnaId?: string;   // UUID reference to fileprocess.document_dna table
  [key: string]: any; // Allow additional properties
}

export interface Chunk {
  id: string;
  document_id: string;
  content: string;
  type: 'header' | 'section' | 'code_block' | 'function' | 'class' | 'paragraph' | 'list' | 'table' | 'image' | 'memory';
  position: {
    start: number;
    end: number;
    line_start?: number;
    line_end?: number;
  };
  metadata: ChunkMetadata;
  embedding?: number[];
  summary?: string;
  tokens: number;
  relevance_score?: number; // Added for retrieval results
}

export interface ChunkMetadata {
  level?: number; // For headers
  language?: string; // For code blocks
  function_name?: string;
  class_name?: string;
  dependencies?: string[];
  importance_score: number;
  semantic_density: number;
  contains_key_info: boolean;
  title?: string; // Added for document title reference
  type?: string; // Added for document type reference
  timestamp?: string; // For memories
  sessionId?: string; // For memories
  tags?: string[]; // For memories
  relevance_score?: number;
  // Multimodal chunking properties
  image_id?: string;
  image_type?: string;
  has_description?: boolean;
  visual_type?: string;
  code_length?: number;
  // Structured data properties
  paths?: string[];
  // Page information for multi-page documents (PDFs)
  pageNumber?: number; // Page number this chunk belongs to (1-indexed)
  [key: string]: any; // Allow additional properties
}

export interface ChunkRelationship {
  source_id: string;
  target_id: string;
  type: 'FOLLOWS' | 'SIMILAR_TO' | 'REFERENCES' | 'CONTAINS' | 'PARENT_OF' | 'CHILD_OF' | 'MEMORY_OF' | 'REFERS_TO';
  weight: number;
}

export interface DocumentSummary {
  content: string;
  keyPoints: string[];
  generationModel?: string;
}

export interface DocumentOutline {
  title: string;
  sections: OutlineSection[];
}

export interface OutlineSection {
  title: string;
  level: number;
  start_chunk: string;
  end_chunk: string;
  subsections?: OutlineSection[];
  children?: OutlineSection[]; // Alias for subsections
}

export interface RetrievalStrategy {
  type: 'full_document' | 'semantic_chunks' | 'hierarchical' | 'graph_traversal' | 'adaptive' | 'memory_only';
  parameters?: Record<string, any>;
}

export interface ChunkingOptions {
  maxTokens: number;
  overlap: number;
  metadata: DocumentMetadata;
}

export interface ChunkingResult {
  chunks: Chunk[];
  relationships: ChunkRelationship[];
  summary: DocumentSummary;
  outline: DocumentOutline;
}

export interface RetrievalOptions {
  maxTokens?: number;
  strategy?: 'full_document' | 'semantic_chunks' | 'hierarchical' | 'graph_traversal' | 'adaptive' | 'memory_only';
  includeFullDocument?: boolean;
  contentTypes?: string[] | 'all';
  limit?: number;      // Maximum number of results to return
  rerank?: boolean;    // Whether to apply reranking to results
}

export interface RetrievalResult {
  content: string;
  chunks: Chunk[];
  metadata: {
    strategy: string;
    source?: string;
    tokens: number;
    truncated?: boolean;
    totalChunks?: number;
    documents?: Array<{
      id: string;
      title: string;
      type: string;
    }>;
    optimized?: boolean;
    sections?: Array<{
      title: string;
      tokens: number;
    }>;
    // Hierarchical strategy properties
    summaryCount?: number;
    detailCount?: number;
    // Graph traversal properties
    nodesVisited?: number;
    graphDepth?: number;
    [key: string]: any; // Allow additional properties
  };
  relevanceScore: number;
}

export interface QueryAnalysis {
  intent: QueryIntent;
  entities: Array<{
    type: string;
    value: string;
  }>;
  requiresFullContext: boolean;
  estimatedResponseTokens: number;
  confidence: number;
}

export type QueryIntent = 'full_document' | 'specific_section' | 'code_search' | 'summary_request' | 'general' | 'memory_recall';

export interface StorageResult {
  success: boolean;
  documentId: string;
  message?: string;
  duplicate?: boolean;
  chunksCreated?: number;
  relationshipsCreated?: number;
  processingTimeMs?: number;
  metadata?: {
    tokens: number;
    embeddingModel: string;
  };
}

// Memory-specific types (mem-agent compatible)
export interface Memory {
  id: string;
  content: string;
  tags: string[];
  timestamp: string;
  metadata?: {
    sessionId?: string;
    userId?: string;
    source?: string;
    [key: string]: any;
  };
  embedding?: number[];
  relevanceScore?: number;
  tenantId?: string;
  userId?: string;
}

export interface MemoryStorageRequest {
  content: string;
  tags?: string[];
  metadata?: Record<string, any>;
  timestamp?: string;
}

export interface MemoryRecallRequest {
  query: string;
  limit?: number;
  filters?: {
    tags?: string[];
    dateRange?: {
      start: string;
      end: string;
    };
    sessionId?: string;
  };
}

export interface MemoryRecallResult {
  id: string;
  content: string;
  relevanceScore: number;
  metadata: {
    timestamp: string;
    tags: string[];
    // Document chunk specific fields
    contentType?: string;       // 'memory' or 'document_chunk'
    documentId?: string;        // Document UUID
    chunkId?: string;           // Chunk UUID
    pageNumber?: number;        // Page number for PDFs
    position?: { start: number; end: number }; // Character position for highlighting
    // Artifact references for page-specific viewing
    artifactId?: string;        // UUID of stored file
    artifactUrl?: string;       // Download URL (presigned or shareable)
    pdfViewerUrl?: string;      // Direct link to view specific page (e.g., #page=53)
    [key: string]: any;
  };
  score?: number;
  timestamp?: string;
  tags?: string[];
}

export interface UnifiedSearchRequest {
  query: string;
  contentTypes: ('memory' | 'document' | 'code' | 'all')[];
  limit?: number;
  options?: {
    includeMetadata?: boolean;
    maxTokens?: number;
  };
}

export interface UnifiedSearchResult {
  items: Array<{
    id: string;
    type: 'memory' | 'document' | 'chunk';
    content: string;
    relevance: number;
    metadata: Record<string, any>;
  }>;
  memoriesCount: number;
  documentsCount: number;
  contentTypes: string[];
}

// API request/response types
export interface StoreDocumentRequest {
  content: string | Buffer;
  metadata: Omit<DocumentMetadata, 'id' | 'hash' | 'created_at' | 'updated_at' | 'size' | 'version'> & {
    title: string;
    type: DocumentMetadata['type'];
    format: string;
    tags?: string[];
    source?: string;
    language?: string;
    custom?: Record<string, any>;
  };
  options?: {
    enableAgentAnalysis?: boolean;
  };
}

export interface StoreDocumentResponse {
  success: boolean;
  documentId: string;
  message: string;
  metadata?: {
    tokens: number;
    chunks: number;
    embeddingModel: string;
  };
}

export interface RetrievalRequest {
  query: string;
  options?: RetrievalOptions;
}

export interface RetrievalResponse {
  content: string;
  metadata: RetrievalResult['metadata'];
  relevanceScore: number;
  usage: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
}

export interface DocumentUpdate {
  content?: string;
  metadata?: Partial<DocumentMetadata>;
}

export interface UpdateResult {
  success: boolean;
  version: number;
  message: string;
}

export interface SearchFilters {
  type?: DocumentMetadata['type'];
  tags?: string[];
  language?: string;
  dateRange?: {
    start: Date;
    end: Date;
  };
  limit?: number;
}

export interface SearchResult {
  id: string;
  title: string;
  type: DocumentMetadata['type'];
  relevance: number;
  summary: string;
  metadata: DocumentMetadata;
}

// Service configuration types
export interface GraphRAGConfig {
  port: number;
  wsPort: number;
  postgres: {
    host: string;
    port: number;
    database: string;
    user: string;
    password: string;
    ssl?: boolean;
  };
  redis: {
    host: string;
    port: number;
    password?: string;
  };
  neo4j: {
    uri: string;
    user: string;
    password: string;
  };
  qdrant: {
    host: string;
    port: number;
    apiKey?: string;
    url?: string;
  };
  voyage: {
    apiKey: string;
    model: string;
    rerankModel: string;
  };
  voyageAI?: {
    apiKey: string;
    baseUrl?: string;
    model?: string;
    rerankModel?: string;
    dimensions?: number;
  };
  storage: {
    type: 'filesystem' | 's3' | 'postgres';
    config: any;
  };
  corsOrigins?: string[] | RegExp[];
  chunking?: {
    maxTokens: number;
    overlapTokens: number;
  };
}

// Unified Storage Engine Types
export interface UnifiedStorageConfig {
  voyageClient: any;
  qdrantClient: any;
  neo4jDriver: any;
  postgresPool: any;
  redisCache: any;
}

export interface UnifiedContent {
  id: string;
  type: 'memory' | 'document' | 'code' | 'conversation';
  size: 'micro' | 'small' | 'medium' | 'large';
  content: string;
  metadata: Record<string, any>;
}

export interface MemoryStorageResult {
  success: boolean;
  id: string;
  message?: string;
}

export interface MemoryListResult {
  items: Memory[];
  total: number;
}

// Chunking Engine Types
export interface ChunkingConfig {
  maxChunkTokens: number;
  overlapTokens: number;
}

// Database configuration types
export interface DatabaseConfig {
  postgres: {
    host: string;
    port: number;
    database: string;
    user: string;
    password: string;
  };
  redis: {
    host: string;
    port: number;
    password?: string;
  };
  neo4j: {
    uri: string;
    user: string;
    password: string;
  };
  qdrant: {
    url: string;
    apiKey?: string;
  };
}

// Additional types for chunking strategies
export interface CodeStructure {
  units: CodeUnit[];
  imports: string[];
  exports: string[];
}

export interface CodeUnit {
  type: 'function' | 'class' | 'module';
  name: string;
  startLine: number;
  endLine: number;
  startChar: number;
  endChar: number;
  dependencies: string[];
  importance: number;
}

export interface MarkdownSection {
  type: 'header' | 'section';
  level: number;
  title: string;
  content: string;
  position: {
    start: number;
    end: number;
  };
  children: MarkdownSection[];
}

// Retrieval Engine Types
export interface RetrievalConfig {
  voyageClient: any;
  qdrantClient: any;
  neo4jDriver: any;
  redisCache: any;
  postgresPool?: any;
  unifiedStorage?: any;
}

export interface ModelSelection {
  provider: string;
  model: string;
  reason: string;
}

export interface ArrangedContent {
  text: string;
  documents: Array<{
    id: string;
    title: string;
    type: string;
  }>;
}

export interface ComplexityScore {
  score: number;
  level: 'simple' | 'medium' | 'complex';
}

// Error types
export interface GraphRAGError extends Error {
  code: string;
  details?: any;
  statusCode?: number;
}

// ============================================================================
// Document Viewer Types
// ============================================================================

export type DocumentType =
  | 'pdf'
  | 'markdown'
  | 'code'
  | 'latex'
  | 'word'
  | 'excel'
  | 'powerpoint'
  | 'json'
  | 'yaml'
  | 'xml'
  | 'image'
  | 'google-docs'
  | 'text'
  | 'unknown';

export type RendererType =
  | 'pdf'
  | 'markdown'
  | 'code'
  | 'latex'
  | 'word'
  | 'spreadsheet'
  | 'presentation'
  | 'structured-data'
  | 'image'
  | 'google-docs'
  | 'fallback';

export type ThemeType =
  | 'immersive'
  | 'vscode'
  | 'professional'
  | 'minimal'
  | 'gallery'
  | 'auto';

export type ViewerMode =
  | 'closed'
  | 'slide-over'
  | 'full-tab'
  | 'split-dock'
  | 'modal';

export type AnnotationType =
  | 'highlight'
  | 'note'
  | 'comment'
  | 'bookmark';

export interface DocumentResponse {
  id: string;
  title: string;
  type: DocumentType;
  format: string;
  mimeType: string;
  size: number;
  pageCount?: number;
  wordCount?: number;
  language: string;

  metadata: {
    author?: string;
    createdDate?: string;
    modifiedDate?: string;
    source?: string;
    tags: string[];
    custom: Record<string, unknown>;
  };

  summary?: {
    text: string;
    keyPoints: string[];
    generatedAt: string;
  };

  outline?: {
    sections: OutlineSection[];
  };

  stats: {
    entityCount: number;
    relationshipCount: number;
    chunkCount: number;
    annotationCount: number;
    memoryReferences: number;
  };

  rendering: {
    suggestedRenderer: RendererType;
    suggestedTheme: ThemeType;
    capabilities: string[];
  };

  createdAt: string;
  updatedAt: string;
}

export interface DocumentEntity {
  id: string;
  name: string;
  type: string;
  mentions: EntityMention[];
  metadata?: Record<string, unknown>;
}

export interface EntityMention {
  id: string;
  documentId: string;
  entityId: string;
  chunkId?: string;
  startOffset: number;
  endOffset: number;
  matchedText: string;
  confidence: number;
  detectionMethod: string;
  createdAt: string;
}

export interface Annotation {
  id: string;
  documentId: string;
  userId: string;
  type: AnnotationType;
  chunkId?: string;
  startOffset?: number;
  endOffset?: number;
  pageNumber?: number;
  content?: string;
  color?: string;
  parentId?: string;
  resolved: boolean;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface DocumentRelationship {
  id: string;
  sourceDocumentId: string;
  targetDocumentId: string;
  relationshipType: string;
  similarityScore?: number;
  sharedEntityCount: number;
  evidenceText?: string;
  detectionMethod: string;
  confidence: number;
  createdAt: string;
  createdBy?: string;
}

export interface DocumentViewHistory {
  id: string;
  userId: string;
  documentId: string;
  viewerMode?: ViewerMode;
  sourceTab?: string;
  sourceEntityId?: string;
  lastPage?: number;
  lastSection?: string;
  scrollPosition: number;
  openedAt: string;
  closedAt?: string;
  durationSeconds?: number;
}

export interface UserDocumentPreferences {
  userId: string;
  defaultViewerMode: ViewerMode;
  defaultTheme: ThemeType;
  themeOverrides: Record<string, unknown>;
  fontSize: number;
  fontFamily: string;
  lineHeight: number;
  sidebarDefaultTab: string;
  sidebarCollapsed: boolean;
  showEntityHighlights: boolean;
  customShortcuts: Record<string, string>;
  createdAt: string;
  updatedAt: string;
}

export interface RenderCache {
  id: string;
  documentId: string;
  rendererType: RendererType;
  renderOptions: Record<string, unknown>;
  renderedContent?: string;
  renderedPages?: unknown;
  sourceHash: string;
  renderVersion: string;
  createdAt: string;
  expiresAt?: string;
}

export interface DocumentListResponse {
  items: DocumentResponse[];
  total: number;
  page: number;
  pageSize: number;
  hasMore: boolean;
}

export interface RelatedDocument {
  id: string;
  title: string;
  type: DocumentType;
  similarityScore: number;
  sharedEntityCount: number;
  sharedEntities: Array<{
    id: string;
    name: string;
    type: string;
  }>;
}

export interface ChunkSimilarity {
  chunkId: string;
  documentId: string;
  documentTitle: string;
  content: string;
  similarityScore: number;
  pageNumber?: number;
}

export interface AIDocumentSummary {
  summary: string;
  keyPoints: string[];
  topics: string[];
  confidence: number;
  model: string;
  generatedAt: string;
}

export interface AIDocumentExplanation {
  explanation: string;
  relatedConcepts: string[];
  sources: string[];
  confidence: number;
}

export interface AIDocumentQuestion {
  question: string;
  answer: string;
  confidence: number;
  sources: Array<{
    chunkId: string;
    pageNumber?: number;
    relevance: number;
  }>;
}

export interface AITextExtraction {
  extractedText: string;
  confidence: number;
  method: 'ocr' | 'llm' | 'hybrid';
  metadata: Record<string, unknown>;
}

export interface TypeDetectionResult {
  detectedType: DocumentType;
  confidence: number;
  suggestedRenderer: RendererType;
  suggestedTheme: ThemeType;
  detectionMethods: string[];
}
