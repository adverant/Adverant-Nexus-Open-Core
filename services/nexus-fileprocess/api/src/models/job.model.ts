/**
 * FileProcessAgent Data Models
 *
 * TypeScript interfaces matching the PostgreSQL schema defined in
 * scripts/database/init-nexus.sql (fileprocess schema).
 */

export enum JobStatus {
  PENDING = 'pending',
  QUEUED = 'queued',
  PROCESSING = 'processing',
  COMPLETED = 'completed',
  FAILED = 'failed',
  CANCELLED = 'cancelled'
}

export enum OCRTier {
  TESSERACT = 'tesseract',      // Tier 1: Fast, free, 82% accuracy
  GPT4_VISION = 'gpt4-vision',  // Tier 2: 93% accuracy, $0.01-0.03/page
  CLAUDE_OPUS = 'claude-opus'   // Tier 3: 97% accuracy, $0.05-0.10/page
}

export interface ProcessingJob {
  id: string;                           // UUID
  userId: string;
  filename: string;
  mimeType?: string;
  fileSize?: number;
  fileUrl?: string;                     // For large files (GCS/S3/Drive)
  fileBuffer?: Buffer;                  // For small files (<10MB)
  status: JobStatus;
  confidence?: number;                  // 0-1 scale
  processingTimeMs?: number;
  documentDnaId?: string;               // UUID reference
  errorCode?: string;
  errorMessage?: string;
  ocrTierUsed?: OCRTier;
  metadata?: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
}

export interface DocumentDNA {
  id: string;                           // UUID
  jobId: string;
  semanticEmbedding: number[];          // 1024-dim from VoyageAI voyage-3
  structuralData: {
    layout: LayoutAnalysis;
    tables: Table[];
    metadata: Record<string, unknown>;
  };
  originalContent: Buffer;              // Full fidelity original file
  createdAt: Date;
}

export interface LayoutAnalysis {
  confidence: number;                   // 0-1 scale (target: 99.2%)
  regions: LayoutRegion[];
  readingOrder: number[];               // Indices of regions in reading order
  metadata: {
    pageCount?: number;
    hasImages?: boolean;
    hasHeaders?: boolean;
    hasFooters?: boolean;
  };
}

export interface LayoutRegion {
  id: number;
  type: 'text' | 'image' | 'table' | 'header' | 'footer' | 'caption';
  bbox: BoundingBox;
  content?: string;
  confidence: number;
}

export interface BoundingBox {
  x: number;
  y: number;
  width: number;
  height: number;
  page?: number;
}

export interface Table {
  id: number;
  bbox: BoundingBox;
  rows: TableRow[];
  confidence: number;                   // Target: 97.9%
  metadata?: {
    hasHeader?: boolean;
    columnCount?: number;
    rowCount?: number;
  };
}

export interface TableRow {
  cells: TableCell[];
}

export interface TableCell {
  content: string;
  colspan?: number;
  rowspan?: number;
  bbox?: BoundingBox;
}

export interface ProcessingPlugin {
  id: string;
  formatName: string;
  mimePatterns: string[];
  pluginCode?: string;                  // Go plugin source
  pluginHash?: string;                  // SHA-256 for cache validation
  successRate: number;
  avgConfidence: number;
  usageCount: number;
  metadata?: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
}

export interface ProcessingMetric {
  id: string;
  timestamp: Date;
  workerId: string;
  jobId?: string;
  metricType: 'throughput' | 'latency' | 'confidence' | 'error_rate';
  value: number;
  metadata?: Record<string, unknown>;
}

// API Request/Response types
export interface ProcessFileRequest {
  filename: string;
  mimeType?: string;
  fileSize?: number;
  fileBuffer?: string;                  // Base64-encoded
  fileUrl?: string;                     // Alternative to fileBuffer
  userId?: string;
  metadata?: Record<string, unknown>;
}

export interface ProcessFileResponse {
  success: boolean;
  jobId: string;
  message: string;
  estimatedTime?: string;
}

export interface GetJobStatusResponse {
  success: boolean;
  job: ProcessingJob;
  documentDna?: DocumentDNA;
}

export interface JobError {
  code: string;
  message: string;
  details?: Record<string, unknown>;
  retryable: boolean;
  suggestion?: string;
}
