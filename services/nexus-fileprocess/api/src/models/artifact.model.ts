/**
 * Artifact Model - Universal File Storage
 *
 * Tracks all files across the Nexus platform with unified metadata.
 * Supports both PostgreSQL buffer storage (<10MB) and MinIO object storage (>10MB).
 *
 * Storage Strategy:
 * - Small files (<10MB): PostgreSQL buffer (base64) for fast retrieval
 * - Large files (>10MB): MinIO object storage with presigned URLs
 * - Massive files (>5GB): MinIO reference-only (no upload, stream from source)
 */

export interface Artifact {
  id: string; // UUID
  source_service: 'sandbox' | 'fileprocess' | 'videoagent' | 'geoagent' | 'mageagent';
  source_id: string; // execution_id, job_id, etc.
  filename: string;
  mime_type: string;
  file_size: number; // bytes
  storage_backend: 'postgres_buffer' | 'minio' | 'reference_only';
  storage_path?: string; // MinIO object path or external URL
  buffer_data?: string; // base64 encoded data for small files
  presigned_url?: string; // Temporary download URL
  url_expires_at?: Date; // Presigned URL expiration
  metadata?: Record<string, any>; // Additional metadata (source, tags, etc.)
  created_at: Date;
  expires_at?: Date; // TTL for automatic cleanup
}

export interface CreateArtifactRequest {
  source_service: string;
  source_id: string;
  filename: string;
  mime_type: string;
  file_size: number;
  buffer?: Buffer; // For upload
  storage_path?: string; // For MinIO reference
  external_url?: string; // For reference-only files
  metadata?: Record<string, any>;
  ttl_days?: number; // Time-to-live in days (default 7)
}

export interface ArtifactDownloadResponse {
  artifact: Artifact;
  download_url?: string; // Presigned URL for direct download
  buffer?: Buffer; // Buffer data for small files
  stream?: NodeJS.ReadableStream; // Stream for large files
}

/**
 * Storage tier thresholds
 */
export const STORAGE_TIERS = {
  BUFFER_MAX_SIZE: 10 * 1024 * 1024, // 10MB - max size for PostgreSQL buffer
  MINIO_MAX_SIZE: 5 * 1024 * 1024 * 1024, // 5GB - max size for direct MinIO upload
  REFERENCE_ONLY_THRESHOLD: 5 * 1024 * 1024 * 1024, // >5GB - reference-only, no upload
};

/**
 * Default TTL for artifacts (7 days)
 */
export const DEFAULT_ARTIFACT_TTL_DAYS = 7;

/**
 * Presigned URL validity (1 hour)
 */
export const PRESIGNED_URL_EXPIRY_SECONDS = 3600;
