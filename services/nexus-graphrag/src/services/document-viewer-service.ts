/**
 * Document Viewer Service
 *
 * Provides core document operations for the Universal Document Viewer.
 * Handles:
 * - Document retrieval with metadata, summary, and outline
 * - Document content delivery (streamed for large files)
 * - Binary file access
 * - Semantic chunk access and navigation
 * - Chunk similarity search via Qdrant
 *
 * Integrates with:
 * - PostgreSQL: Document metadata and content
 * - Qdrant: Vector similarity search
 * - Redis: Caching (optional)
 */

import { Pool } from 'pg';
import { QdrantClient } from '@qdrant/js-client-rest';
import { VoyageAIClient } from '../clients/voyage-ai-unified-client';
import {
  DocumentResponse,
  DocumentListResponse,
  Chunk,
  ChunkSimilarity,
  DocumentType,
  RendererType,
  ThemeType,
} from '../types';
import { logger } from '../utils/logger';

// ============================================================================
// INTERFACES
// ============================================================================

export interface DocumentViewerConfig {
  postgresPool: Pool;
  qdrantClient: QdrantClient;
  voyageClient: VoyageAIClient;
  redisCache?: any;
}

export interface DocumentFilters {
  type?: DocumentType | DocumentType[];
  tags?: string[];
  searchQuery?: string;
  dateRange?: {
    start: Date;
    end: Date;
  };
  language?: string;
}

export interface PaginationOptions {
  page?: number;
  pageSize?: number;
  sortBy?: 'created_at' | 'updated_at' | 'title' | 'size';
  sortOrder?: 'asc' | 'desc';
}

export interface DocumentContentOptions {
  format?: 'raw' | 'html' | 'rendered';
  includeMetadata?: boolean;
}

// ============================================================================
// DOCUMENT VIEWER SERVICE
// ============================================================================

export class DocumentViewerService {
  private postgresPool: Pool;
  private qdrantClient: QdrantClient;
  private voyageClient: VoyageAIClient;
  private redisCache?: any;

  constructor(config: DocumentViewerConfig) {
    this.postgresPool = config.postgresPool;
    this.qdrantClient = config.qdrantClient;
    this.voyageClient = config.voyageClient;
    this.redisCache = config.redisCache;
  }

  // ──────────────────────────────────────────────────────────────────────────
  // DOCUMENT LIST & RETRIEVAL
  // ──────────────────────────────────────────────────────────────────────────

  /**
   * Get paginated list of documents with filters
   */
  async getDocuments(
    filters: DocumentFilters = {},
    pagination: PaginationOptions = {},
    tenantId: string
  ): Promise<DocumentListResponse> {
    const {
      page = 1,
      pageSize = 20,
      sortBy = 'created_at',
      sortOrder = 'desc',
    } = pagination;

    const offset = (page - 1) * pageSize;

    try {
      // Build WHERE clause
      const whereClauses: string[] = ['d.tenant_id = $1'];
      const values: any[] = [tenantId];
      let paramIndex = 2;

      // Type filter
      if (filters.type) {
        const types = Array.isArray(filters.type) ? filters.type : [filters.type];
        whereClauses.push(`d.type = ANY($${paramIndex})`);
        values.push(types);
        paramIndex++;
      }

      // Tags filter
      if (filters.tags && filters.tags.length > 0) {
        whereClauses.push(`d.tags && $${paramIndex}`);
        values.push(filters.tags);
        paramIndex++;
      }

      // Search query (searches title, source, and tags)
      if (filters.searchQuery) {
        whereClauses.push(`(
          d.title ILIKE $${paramIndex} OR
          d.source ILIKE $${paramIndex} OR
          EXISTS (SELECT 1 FROM unnest(d.tags) tag WHERE tag ILIKE $${paramIndex})
        )`);
        values.push(`%${filters.searchQuery}%`);
        paramIndex++;
      }

      // Date range filter
      if (filters.dateRange) {
        whereClauses.push(`d.created_at BETWEEN $${paramIndex} AND $${paramIndex + 1}`);
        values.push(filters.dateRange.start, filters.dateRange.end);
        paramIndex += 2;
      }

      // Language filter
      if (filters.language) {
        whereClauses.push(`d.language = $${paramIndex}`);
        values.push(filters.language);
        paramIndex++;
      }

      const whereClause = whereClauses.join(' AND ');

      // Get total count
      const countQuery = `
        SELECT COUNT(*) as total
        FROM graphrag.documents d
        WHERE ${whereClause}
      `;

      const countResult = await this.postgresPool.query(countQuery, values);
      const total = parseInt(countResult.rows[0].total, 10);

      // Get documents with stats
      const documentsQuery = `
        SELECT
          d.id,
          d.title,
          d.type,
          d.format,
          d.size,
          d.language,
          d.tags,
          d.source,
          d.created_at,
          d.updated_at,
          d.metadata,
          (SELECT COUNT(*) FROM graphrag.document_chunks WHERE document_id = d.id) as chunk_count,
          (SELECT COUNT(*) FROM graphrag.document_entity_mentions WHERE document_id = d.id) as entity_count,
          (SELECT COUNT(*) FROM graphrag.document_annotations WHERE document_id = d.id) as annotation_count,
          (SELECT COUNT(*) FROM graphrag.document_relationships WHERE source_document_id = d.id) as relationship_count
        FROM graphrag.documents d
        WHERE ${whereClause}
        ORDER BY d.${sortBy} ${sortOrder}
        LIMIT $${paramIndex} OFFSET $${paramIndex + 1}
      `;

      values.push(pageSize, offset);

      const documentsResult = await this.postgresPool.query(documentsQuery, values);

      const items: DocumentResponse[] = documentsResult.rows.map((row) => ({
        id: row.id,
        title: row.title,
        type: row.type as DocumentType,
        format: row.format,
        mimeType: this.getMimeTypeFromFormat(row.format),
        size: row.size,
        pageCount: row.metadata?.pageCount,
        wordCount: row.metadata?.wordCount,
        language: row.language || 'unknown',
        metadata: {
          author: row.metadata?.author,
          createdDate: row.metadata?.createdDate,
          modifiedDate: row.metadata?.modifiedDate,
          source: row.source,
          tags: row.tags || [],
          custom: row.metadata?.custom || {},
        },
        stats: {
          entityCount: parseInt(row.entity_count, 10) || 0,
          relationshipCount: parseInt(row.relationship_count, 10) || 0,
          chunkCount: parseInt(row.chunk_count, 10) || 0,
          annotationCount: parseInt(row.annotation_count, 10) || 0,
          memoryReferences: 0, // TODO: Implement memory references count
        },
        rendering: this.getSuggestedRendering(row.type, row.format),
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      }));

      return {
        items,
        total,
        page,
        pageSize,
        hasMore: offset + items.length < total,
      };
    } catch (error) {
      logger.error('Failed to get documents', { error, filters, pagination });
      throw new Error(`Failed to get documents: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Get full document by ID with metadata, summary, and outline
   */
  async getDocumentById(documentId: string, tenantId: string): Promise<DocumentResponse> {
    try {
      const query = `
        SELECT
          d.*,
          dc.summary_text,
          dc.summary_key_points,
          dc.outline_sections,
          (SELECT COUNT(*) FROM graphrag.document_chunks WHERE document_id = d.id) as chunk_count,
          (SELECT COUNT(*) FROM graphrag.document_entity_mentions WHERE document_id = d.id) as entity_count,
          (SELECT COUNT(*) FROM graphrag.document_annotations WHERE document_id = d.id) as annotation_count,
          (SELECT COUNT(*) FROM graphrag.document_relationships WHERE source_document_id = d.id) as relationship_count
        FROM graphrag.documents d
        LEFT JOIN graphrag.document_content dc ON dc.id = d.id
        WHERE d.id = $1 AND d.tenant_id = $2
      `;

      const result = await this.postgresPool.query(query, [documentId, tenantId]);

      if (result.rows.length === 0) {
        throw new Error(`Document not found: ${documentId}`);
      }

      const row = result.rows[0];

      return {
        id: row.id,
        title: row.title,
        type: row.type as DocumentType,
        format: row.format,
        mimeType: this.getMimeTypeFromFormat(row.format),
        size: row.size,
        pageCount: row.metadata?.pageCount,
        wordCount: row.metadata?.wordCount,
        language: row.language || 'unknown',
        metadata: {
          author: row.metadata?.author,
          createdDate: row.metadata?.createdDate,
          modifiedDate: row.metadata?.modifiedDate,
          source: row.source,
          tags: row.tags || [],
          custom: row.metadata?.custom || {},
        },
        summary: row.summary_text ? {
          text: row.summary_text,
          keyPoints: row.summary_key_points || [],
          generatedAt: row.created_at,
        } : undefined,
        outline: row.outline_sections ? {
          sections: row.outline_sections,
        } : undefined,
        stats: {
          entityCount: parseInt(row.entity_count, 10) || 0,
          relationshipCount: parseInt(row.relationship_count, 10) || 0,
          chunkCount: parseInt(row.chunk_count, 10) || 0,
          annotationCount: parseInt(row.annotation_count, 10) || 0,
          memoryReferences: 0, // TODO: Implement memory references count
        },
        rendering: this.getSuggestedRendering(row.type, row.format),
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      };
    } catch (error) {
      logger.error('Failed to get document by ID', { error, documentId });
      throw error;
    }
  }

  // ──────────────────────────────────────────────────────────────────────────
  // CONTENT ACCESS
  // ──────────────────────────────────────────────────────────────────────────

  /**
   * Get document content (text)
   */
  async getDocumentContent(
    documentId: string,
    tenantId: string,
    options: DocumentContentOptions = {}
  ): Promise<{ content: string; metadata?: any }> {
    try {
      const query = `
        SELECT dc.text_content, d.metadata, d.format
        FROM graphrag.document_content dc
        JOIN graphrag.documents d ON d.id = dc.id
        WHERE dc.id = $1 AND d.tenant_id = $2
      `;

      const result = await this.postgresPool.query(query, [documentId, tenantId]);

      if (result.rows.length === 0) {
        throw new Error(`Document content not found: ${documentId}`);
      }

      const row = result.rows[0];

      return {
        content: row.text_content,
        metadata: options.includeMetadata ? row.metadata : undefined,
      };
    } catch (error) {
      logger.error('Failed to get document content', { error, documentId });
      throw error;
    }
  }

  /**
   * Get document binary data (for PDFs, images, etc.)
   */
  async getDocumentBinary(
    documentId: string,
    tenantId: string
  ): Promise<{ data: Buffer; mimeType: string; filename: string }> {
    try {
      const query = `
        SELECT dc.binary_content, d.format, d.title, d.metadata
        FROM graphrag.document_content dc
        JOIN graphrag.documents d ON d.id = dc.id
        WHERE dc.id = $1 AND d.tenant_id = $2
      `;

      const result = await this.postgresPool.query(query, [documentId, tenantId]);

      if (result.rows.length === 0) {
        throw new Error(`Document binary not found: ${documentId}`);
      }

      const row = result.rows[0];

      if (!row.binary_content) {
        throw new Error(`Document has no binary content: ${documentId}`);
      }

      const mimeType = this.getMimeTypeFromFormat(row.format);
      const extension = this.getExtensionFromFormat(row.format);
      const filename = row.metadata?.filename || `${row.title}.${extension}`;

      return {
        data: row.binary_content,
        mimeType,
        filename,
      };
    } catch (error) {
      logger.error('Failed to get document binary', { error, documentId });
      throw error;
    }
  }

  // ──────────────────────────────────────────────────────────────────────────
  // CHUNKS & SIMILARITY
  // ──────────────────────────────────────────────────────────────────────────

  /**
   * Get semantic chunks for a document
   */
  async getDocumentChunks(
    documentId: string,
    tenantId: string,
    pagination: PaginationOptions = {}
  ): Promise<{ chunks: Chunk[]; total: number }> {
    const { page = 1, pageSize = 50 } = pagination;
    const offset = (page - 1) * pageSize;

    try {
      // Verify document belongs to tenant
      const tenantCheck = await this.postgresPool.query(
        'SELECT id FROM graphrag.documents WHERE id = $1 AND tenant_id = $2',
        [documentId, tenantId]
      );

      if (tenantCheck.rows.length === 0) {
        throw new Error(`Document not found: ${documentId}`);
      }

      // Get total count
      const countResult = await this.postgresPool.query(
        'SELECT COUNT(*) as total FROM graphrag.document_chunks WHERE document_id = $1',
        [documentId]
      );
      const total = parseInt(countResult.rows[0].total, 10);

      // Get chunks
      const chunksQuery = `
        SELECT *
        FROM graphrag.document_chunks
        WHERE document_id = $1
        ORDER BY position_start
        LIMIT $2 OFFSET $3
      `;

      const chunksResult = await this.postgresPool.query(chunksQuery, [documentId, pageSize, offset]);

      const chunks: Chunk[] = chunksResult.rows.map((row) => ({
        id: row.id,
        document_id: row.document_id,
        content: row.content,
        type: row.type,
        position: {
          start: row.position_start,
          end: row.position_end,
          line_start: row.line_start,
          line_end: row.line_end,
        },
        metadata: row.metadata || {},
        tokens: row.tokens || 0,
        summary: row.summary,
      }));

      return { chunks, total };
    } catch (error) {
      logger.error('Failed to get document chunks', { error, documentId });
      throw error;
    }
  }

  /**
   * Find similar chunks from other documents via Qdrant
   */
  async getSimilarChunks(
    documentId: string,
    chunkId: string,
    tenantId: string,
    limit: number = 10
  ): Promise<ChunkSimilarity[]> {
    try {
      // Verify document and chunk belong to tenant
      const checkQuery = `
        SELECT dc.id, dc.document_id
        FROM graphrag.document_chunks dc
        JOIN graphrag.documents d ON d.id = dc.document_id
        WHERE dc.id = $1 AND dc.document_id = $2 AND d.tenant_id = $3
      `;

      const checkResult = await this.postgresPool.query(checkQuery, [chunkId, documentId, tenantId]);

      if (checkResult.rows.length === 0) {
        throw new Error(`Chunk not found: ${chunkId}`);
      }

      // Get chunk embedding from Qdrant
      const collectionName = `tenant_${tenantId}_documents`;

      // Search for the point to get its vector
      const chunkPoints = await this.qdrantClient.retrieve(collectionName, {
        ids: [chunkId],
        with_vector: true,
      });

      if (chunkPoints.length === 0 || !chunkPoints[0].vector) {
        throw new Error(`Chunk embedding not found: ${chunkId}`);
      }

      const chunkVector = chunkPoints[0].vector as number[];

      // Search for similar chunks (excluding the same document)
      const searchResult = await this.qdrantClient.search(collectionName, {
        vector: chunkVector,
        limit: limit + 20, // Get extra to filter out same document
        filter: {
          must_not: [
            {
              key: 'document_id',
              match: { value: documentId },
            },
          ],
        },
        with_payload: true,
      });

      // Get chunk details from PostgreSQL
      const chunkIds = searchResult.slice(0, limit).map((r) => r.id);

      if (chunkIds.length === 0) {
        return [];
      }

      const chunksQuery = `
        SELECT
          dc.id as chunk_id,
          dc.document_id,
          dc.content,
          d.title as document_title,
          dc.metadata
        FROM graphrag.document_chunks dc
        JOIN graphrag.documents d ON d.id = dc.document_id
        WHERE dc.id = ANY($1)
      `;

      const chunksResult = await this.postgresPool.query(chunksQuery, [chunkIds]);

      // Map results with similarity scores
      const chunkMap = new Map(chunksResult.rows.map((row) => [row.chunk_id, row]));

      const similarities: ChunkSimilarity[] = searchResult
        .slice(0, limit)
        .map((result) => {
          const chunk = chunkMap.get(result.id as string);
          if (!chunk) return null;

          return {
            chunkId: chunk.chunk_id,
            documentId: chunk.document_id,
            documentTitle: chunk.document_title,
            content: chunk.content,
            similarityScore: result.score,
            pageNumber: chunk.metadata?.pageNumber,
          };
        })
        .filter((s): s is ChunkSimilarity => s !== null);

      return similarities;
    } catch (error) {
      logger.error('Failed to get similar chunks', { error, documentId, chunkId });
      throw error;
    }
  }

  // ──────────────────────────────────────────────────────────────────────────
  // HELPER METHODS
  // ──────────────────────────────────────────────────────────────────────────

  /**
   * Get MIME type from document format
   */
  private getMimeTypeFromFormat(format: string): string {
    const mimeMap: Record<string, string> = {
      pdf: 'application/pdf',
      docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      doc: 'application/msword',
      xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      xls: 'application/vnd.ms-excel',
      pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      ppt: 'application/vnd.ms-powerpoint',
      md: 'text/markdown',
      txt: 'text/plain',
      json: 'application/json',
      yaml: 'application/x-yaml',
      yml: 'application/x-yaml',
      xml: 'application/xml',
      html: 'text/html',
      css: 'text/css',
      js: 'text/javascript',
      ts: 'text/typescript',
      jsx: 'text/jsx',
      tsx: 'text/tsx',
      py: 'text/x-python',
      java: 'text/x-java',
      cpp: 'text/x-c++src',
      c: 'text/x-csrc',
      go: 'text/x-go',
      rs: 'text/x-rustsrc',
      png: 'image/png',
      jpg: 'image/jpeg',
      jpeg: 'image/jpeg',
      gif: 'image/gif',
      svg: 'image/svg+xml',
      webp: 'image/webp',
    };

    return mimeMap[format.toLowerCase()] || 'application/octet-stream';
  }

  /**
   * Get file extension from format
   */
  private getExtensionFromFormat(format: string): string {
    return format.toLowerCase();
  }

  /**
   * Get suggested rendering based on document type and format
   */
  private getSuggestedRendering(
    type: string,
    format: string
  ): { suggestedRenderer: RendererType; suggestedTheme: ThemeType; capabilities: string[] } {
    // Map document type to renderer
    let renderer: RendererType = 'fallback';
    let theme: ThemeType = 'minimal';
    const capabilities: string[] = [];

    if (format === 'pdf') {
      renderer = 'pdf';
      theme = 'immersive';
      capabilities.push('zoom', 'navigate', 'search', 'annotate');
    } else if (['md', 'markdown', 'mdx'].includes(format)) {
      renderer = 'markdown';
      theme = 'minimal';
      capabilities.push('toc', 'search', 'annotate');
    } else if (['js', 'ts', 'jsx', 'tsx', 'py', 'java', 'cpp', 'c', 'go', 'rs'].includes(format)) {
      renderer = 'code';
      theme = 'vscode';
      capabilities.push('syntax-highlight', 'line-numbers', 'search');
    } else if (['tex', 'latex'].includes(format)) {
      renderer = 'latex';
      theme = 'immersive';
      capabilities.push('math-render', 'toc');
    } else if (['docx', 'doc', 'odt', 'rtf'].includes(format)) {
      renderer = 'word';
      theme = 'professional';
      capabilities.push('format-preserve', 'annotate');
    } else if (['xlsx', 'xls', 'csv', 'tsv'].includes(format)) {
      renderer = 'spreadsheet';
      theme = 'professional';
      capabilities.push('filter', 'sort', 'freeze-panes');
    } else if (['pptx', 'ppt'].includes(format)) {
      renderer = 'presentation';
      theme = 'immersive';
      capabilities.push('slide-navigation', 'fullscreen');
    } else if (['json', 'yaml', 'yml', 'xml', 'toml'].includes(format)) {
      renderer = 'structured-data';
      theme = 'vscode';
      capabilities.push('tree-view', 'syntax-highlight', 'collapse');
    } else if (['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp'].includes(format)) {
      renderer = 'image';
      theme = 'gallery';
      capabilities.push('zoom', 'pan', 'rotate');
    }

    return {
      suggestedRenderer: renderer,
      suggestedTheme: theme,
      capabilities,
    };
  }
}
