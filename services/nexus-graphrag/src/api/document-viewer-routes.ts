/**
 * Document Viewer API Routes
 *
 * Provides backend endpoints for the Universal Document Viewer feature.
 * Implements routes for:
 * - Document retrieval and content delivery
 * - GraphRAG integration (entities, relationships)
 * - Annotations and user data
 * - AI features (summarize, explain, extract, ask)
 * - Type detection and server-side rendering
 *
 * All routes require tenant context (X-Company-ID, X-App-ID headers).
 * User-specific routes require user context (X-User-ID header).
 *
 * Follows patterns from data-explorer-routes.ts
 */

import { Router, Request, Response, NextFunction } from 'express';
import { Pool } from 'pg';
import { QdrantClient } from '@qdrant/js-client-rest';
import * as neo4j from 'neo4j-driver';
import { logger } from '../utils/logger';
import {
  auditTenantOperation,
} from '../middleware/tenant-context';
import {
  extractTenantContextFromJwtOrHeaders,
  requireUserContextJwt,
} from '../middleware/jwt-tenant-context';
import { VoyageAIClient } from '../clients/voyage-ai-unified-client';
import { DocumentViewerService } from '../services/document-viewer-service';
import { DocumentGraphRAGService } from '../services/document-graphrag-service';
import { TypeDetectionService } from '../services/type-detection-service';
import { AIDocumentService } from '../services/ai-document-service';

import type {
  DocumentResponse,
  DocumentListResponse,
  DocumentEntity,
  Annotation,
  DocumentRelationship,
  RelatedDocument,
  ChunkSimilarity,
  UserDocumentPreferences,
  AIDocumentSummary,
  AIDocumentExplanation,
  AIDocumentQuestion,
  AITextExtraction,
  TypeDetectionResult,
} from '../types';

// ============================================================================
// TYPES
// ============================================================================

interface DocumentViewerDependencies {
  postgresPool: Pool;
  qdrantClient: QdrantClient;
  neo4jDriver: neo4j.Driver;
  voyageClient: VoyageAIClient;
  openRouterApiKey?: string;
  redisCache?: any;
}

// ============================================================================
// ROUTE FACTORY
// ============================================================================

export function createDocumentViewerRoutes(deps: DocumentViewerDependencies): Router {
  const router = Router();
  const { postgresPool, qdrantClient, neo4jDriver, voyageClient, openRouterApiKey, redisCache } = deps;

  // Initialize services
  const documentViewerService = new DocumentViewerService({
    postgresPool,
    qdrantClient,
    voyageClient,
    redisCache,
  });

  const documentGraphRAGService = new DocumentGraphRAGService({
    postgresPool,
    qdrantClient,
    neo4jDriver,
    redisCache,
  });

  const typeDetectionService = new TypeDetectionService();

  // Initialize AI service (only if API key provided)
  let aiDocumentService: AIDocumentService | null = null;
  if (openRouterApiKey) {
    aiDocumentService = new AIDocumentService({
      postgresPool,
      qdrantClient,
      voyageClient,
      openRouterApiKey,
      redisCache,
    });
    logger.info('AI Document Service enabled');
  } else {
    logger.warn('OpenRouter API key not provided - AI features will be disabled');
  }

  // ──────────────────────────────────────────────────────────────────────────
  // DOCUMENT RETRIEVAL ENDPOINTS
  // ──────────────────────────────────────────────────────────────────────────

  /**
   * GET /
   * Get paginated list of documents with metadata
   * (Mounted at /api/v1/data-explorer/documents)
   */
  router.get(
    '/',
    extractTenantContextFromJwtOrHeaders,
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const tenantContext = (req as any).tenantContext;
        if (!tenantContext?.userId) {
          return res.status(400).json({ error: 'Tenant context required' });
        }

        // Parse query params
        const page = parseInt(req.query.page as string) || 1;
        const pageSize = parseInt(req.query.pageSize as string) || parseInt(req.query.limit as string) || 20;

        // Map camelCase sortBy from frontend to snake_case column names
        const sortByMap: Record<string, string> = {
          createdAt: 'created_at',
          updatedAt: 'updated_at',
          created_at: 'created_at',
          updated_at: 'updated_at',
          title: 'title',
          size: 'size',
        };
        const rawSortBy = (req.query.sortBy as string) || 'created_at';
        const sortBy = sortByMap[rawSortBy] || 'created_at';
        const sortOrder = (req.query.sortOrder as 'asc' | 'desc') || 'desc';

        // Filters
        const filters: any = {};
        if (req.query.type) {
          filters.type = Array.isArray(req.query.type) ? req.query.type : [req.query.type];
        }
        if (req.query.tags) {
          filters.tags = Array.isArray(req.query.tags) ? req.query.tags : [req.query.tags];
        }
        if (req.query.searchQuery) {
          filters.searchQuery = req.query.searchQuery as string;
        }
        if (req.query.language) {
          filters.language = req.query.language as string;
        }
        if (req.query.startDate && req.query.endDate) {
          filters.dateRange = {
            start: new Date(req.query.startDate as string),
            end: new Date(req.query.endDate as string),
          };
        }

        // Use userId as tenant ID for documents - it's a UUID
        const result = await documentViewerService.getDocuments(
          filters,
          { page, pageSize, sortBy, sortOrder },
          tenantContext.userId
        );

        res.json(result);
      } catch (error) {
        logger.error('GET /documents failed', { error });
        next(error);
      }
    }
  );

  /**
   * GET /:id
   * Get full document metadata and summary
   * (Mounted at /api/v1/data-explorer/documents/:id)
   */
  router.get(
    '/:id',
    extractTenantContextFromJwtOrHeaders,
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const { id } = req.params;
        const tenantContext = (req as any).tenantContext;

        if (!tenantContext?.userId) {
          return res.status(400).json({ error: 'Tenant context required' });
        }

        // Use userId as tenant ID for documents - it's a UUID
        const document = await documentViewerService.getDocumentById(id, tenantContext.userId);
        res.json(document);
      } catch (error) {
        logger.error('GET /documents/:id failed', { error, documentId: req.params.id });
        next(error);
      }
    }
  );

  /**
   * GET /documents/:id/content
   * Get document content (streamed for large files)
   */
  router.get(
    '/documents/:id/content',
    extractTenantContextFromJwtOrHeaders,
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const { id } = req.params;
        const tenantContext = (req as any).tenantContext;

        if (!tenantContext?.tenantId) {
          return res.status(400).json({ error: 'Tenant context required' });
        }

        const format = (req.query.format as 'raw' | 'html' | 'rendered') || 'raw';
        const includeMetadata = req.query.includeMetadata === 'true';

        const result = await documentViewerService.getDocumentContent(
          id,
          tenantContext.userId,
          { format, includeMetadata }
        );

        res.json(result);
      } catch (error) {
        logger.error('GET /documents/:id/content failed', { error, documentId: req.params.id });
        next(error);
      }
    }
  );

  /**
   * GET /documents/:id/binary
   * Get raw binary file (PDF, images, etc.)
   */
  router.get(
    '/documents/:id/binary',
    extractTenantContextFromJwtOrHeaders,
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const { id } = req.params;
        const tenantContext = (req as any).tenantContext;

        if (!tenantContext?.tenantId) {
          return res.status(400).json({ error: 'Tenant context required' });
        }

        const result = await documentViewerService.getDocumentBinary(id, tenantContext.userId);

        res.setHeader('Content-Type', result.mimeType);
        res.setHeader('Content-Disposition', `attachment; filename="${result.filename}"`);
        res.send(result.data);
      } catch (error) {
        logger.error('GET /documents/:id/binary failed', { error, documentId: req.params.id });
        next(error);
      }
    }
  );

  /**
   * GET /documents/:id/chunks
   * Get semantic chunks with embeddings metadata
   */
  router.get(
    '/documents/:id/chunks',
    extractTenantContextFromJwtOrHeaders,
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const { id } = req.params;
        const tenantContext = (req as any).tenantContext;

        if (!tenantContext?.tenantId) {
          return res.status(400).json({ error: 'Tenant context required' });
        }

        const page = parseInt(req.query.page as string) || 1;
        const pageSize = parseInt(req.query.pageSize as string) || 50;

        const result = await documentViewerService.getDocumentChunks(
          id,
          tenantContext.userId,
          { page, pageSize }
        );

        res.json(result);
      } catch (error) {
        logger.error('GET /documents/:id/chunks failed', { error, documentId: req.params.id });
        next(error);
      }
    }
  );

  /**
   * GET /documents/:id/chunks/:chunkId/similar
   * Get similar chunks from other documents
   */
  router.get(
    '/documents/:id/chunks/:chunkId/similar',
    extractTenantContextFromJwtOrHeaders,
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const { id, chunkId } = req.params;
        const tenantContext = (req as any).tenantContext;

        if (!tenantContext?.tenantId) {
          return res.status(400).json({ error: 'Tenant context required' });
        }

        const limit = parseInt(req.query.limit as string) || 10;

        const result = await documentViewerService.getSimilarChunks(
          id,
          chunkId,
          tenantContext.userId,
          limit
        );

        res.json(result);
      } catch (error) {
        logger.error('GET /documents/:id/chunks/:chunkId/similar failed', {
          error,
          documentId: req.params.id,
          chunkId: req.params.chunkId
        });
        next(error);
      }
    }
  );

  // ──────────────────────────────────────────────────────────────────────────
  // GRAPHRAG INTEGRATION ENDPOINTS
  // ──────────────────────────────────────────────────────────────────────────

  /**
   * GET /documents/:id/entities
   * Get entities extracted from document with text spans
   */
  router.get(
    '/documents/:id/entities',
    extractTenantContextFromJwtOrHeaders,
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const { id } = req.params;
        const tenantContext = (req as any).tenantContext;

        if (!tenantContext?.tenantId) {
          return res.status(400).json({ error: 'Tenant context required' });
        }

        const entities = await documentGraphRAGService.getDocumentEntities(
          id,
          tenantContext.companyId
        );

        res.json(entities);
      } catch (error) {
        logger.error('GET /documents/:id/entities failed', { error, documentId: req.params.id });
        next(error);
      }
    }
  );

  /**
   * GET /documents/:id/relationships
   * Get relationships where document entities participate
   */
  router.get(
    '/documents/:id/relationships',
    extractTenantContextFromJwtOrHeaders,
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const { id } = req.params;
        const tenantContext = (req as any).tenantContext;

        if (!tenantContext?.tenantId) {
          return res.status(400).json({ error: 'Tenant context required' });
        }

        const relationships = await documentGraphRAGService.getDocumentRelationships(
          id,
          tenantContext.companyId
        );

        res.json(relationships);
      } catch (error) {
        logger.error('GET /documents/:id/relationships failed', { error, documentId: req.params.id });
        next(error);
      }
    }
  );

  /**
   * GET /documents/:id/related
   * Get related documents with similarity scores
   */
  router.get(
    '/documents/:id/related',
    extractTenantContextFromJwtOrHeaders,
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const { id } = req.params;
        const tenantContext = (req as any).tenantContext;

        if (!tenantContext?.tenantId) {
          return res.status(400).json({ error: 'Tenant context required' });
        }

        const method = (req.query.method as 'embedding' | 'entity' | 'citation' | 'all') || 'all';
        const limit = parseInt(req.query.limit as string) || 10;
        const minSimilarity = parseFloat(req.query.minSimilarity as string) || 0.7;
        const minSharedEntities = parseInt(req.query.minSharedEntities as string) || 2;

        const relatedDocs = await documentGraphRAGService.getRelatedDocuments(
          id,
          tenantContext.userId,
          { method, minSimilarity, minSharedEntities },
          limit
        );

        res.json(relatedDocs);
      } catch (error) {
        logger.error('GET /documents/:id/related failed', { error, documentId: req.params.id });
        next(error);
      }
    }
  );

  /**
   * GET /documents/:id/memories
   * Get memories that reference this document
   */
  router.get(
    '/documents/:id/memories',
    extractTenantContextFromJwtOrHeaders,
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const { id } = req.params;

        // TODO: Implement by Agent 2 (Backend APIs)
        // - Query memories table for references to this document
        // - Return memories with context

        logger.info(`GET /documents/${id}/memories - TODO: implement`);
        res.json([]);
      } catch (error) {
        next(error);
      }
    }
  );

  /**
   * POST /documents/:id/entities
   * Create new entity linked to document
   */
  router.post(
    '/documents/:id/entities',
    requireUserContextJwt,
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const { id } = req.params;
        const entityData = req.body;

        // TODO: Implement by Agent 2 (Backend APIs)
        // - Create entity in universal_entities
        // - Create mention in document_entity_mentions
        // - Return created entity

        logger.info(`POST /documents/${id}/entities - TODO: implement`);
        res.status(501).json({ error: 'Not implemented yet' });
      } catch (error) {
        next(error);
      }
    }
  );

  /**
   * POST /documents/:id/entities/:entityId/link
   * Link existing entity to text spans
   */
  router.post(
    '/documents/:id/entities/:entityId/link',
    requireUserContextJwt,
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const { id, entityId } = req.params;
        const { spans } = req.body;

        // TODO: Implement by Agent 2 (Backend APIs)
        // - Create mentions in document_entity_mentions
        // - Validate entity exists

        logger.info(`POST /documents/${id}/entities/${entityId}/link - TODO: implement`);
        res.status(201).json({ success: true });
      } catch (error) {
        next(error);
      }
    }
  );

  // ──────────────────────────────────────────────────────────────────────────
  // ANNOTATIONS ENDPOINTS
  // ──────────────────────────────────────────────────────────────────────────

  /**
   * GET /documents/:id/annotations
   * Get user annotations for document
   */
  router.get(
    '/documents/:id/annotations',
    requireUserContextJwt,
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const { id } = req.params;
        const userId = (req as any).userContext?.userId;

        // TODO: Implement by Agent 2 (Backend APIs)
        // - Query document_annotations table
        // - Filter by user_id and document_id

        logger.info(`GET /documents/${id}/annotations - TODO: implement`);
        res.json([]);
      } catch (error) {
        next(error);
      }
    }
  );

  /**
   * POST /documents/:id/annotations
   * Create annotation
   */
  router.post(
    '/documents/:id/annotations',
    requireUserContextJwt,
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const { id } = req.params;
        const annotationData = req.body;
        const userId = (req as any).userContext?.userId;

        // TODO: Implement by Agent 2 (Backend APIs)
        // - Insert into document_annotations table
        // - Return created annotation

        logger.info(`POST /documents/${id}/annotations - TODO: implement`);
        res.status(501).json({ error: 'Not implemented yet' });
      } catch (error) {
        next(error);
      }
    }
  );

  /**
   * PUT /documents/:id/annotations/:annotationId
   * Update annotation
   */
  router.put(
    '/documents/:id/annotations/:annotationId',
    requireUserContextJwt,
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const { id, annotationId } = req.params;
        const updates = req.body;
        const userId = (req as any).userContext?.userId;

        // TODO: Implement by Agent 2 (Backend APIs)
        // - Verify ownership (user_id matches)
        // - Update annotation

        logger.info(`PUT /documents/${id}/annotations/${annotationId} - TODO: implement`);
        res.status(501).json({ error: 'Not implemented yet' });
      } catch (error) {
        next(error);
      }
    }
  );

  /**
   * DELETE /documents/:id/annotations/:annotationId
   * Remove annotation
   */
  router.delete(
    '/documents/:id/annotations/:annotationId',
    requireUserContextJwt,
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const { id, annotationId } = req.params;
        const userId = (req as any).userContext?.userId;

        // TODO: Implement by Agent 2 (Backend APIs)
        // - Verify ownership
        // - Delete annotation

        logger.info(`DELETE /documents/${id}/annotations/${annotationId} - TODO: implement`);
        res.status(204).send();
      } catch (error) {
        next(error);
      }
    }
  );

  // ──────────────────────────────────────────────────────────────────────────
  // AI FEATURES ENDPOINTS
  // ──────────────────────────────────────────────────────────────────────────

  /**
   * POST /documents/:id/ai/summarize
   * AI-generated summary
   */
  router.post(
    '/documents/:id/ai/summarize',
    extractTenantContextFromJwtOrHeaders,
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const { id } = req.params;
        const tenantContext = (req as any).tenantContext;

        if (!tenantContext?.tenantId) {
          return res.status(400).json({ error: 'Tenant context required' });
        }

        if (!aiDocumentService) {
          return res.status(503).json({
            error: 'AI features not available',
            message: 'OpenRouter API key not configured'
          });
        }

        // Parse request body for options
        const { scope, sectionId, length } = req.body;

        const result = await aiDocumentService.summarizeDocument(
          id,
          tenantContext.userId,
          { scope: scope || 'full', sectionId, length: length || 'detailed' }
        );

        res.json(result);
      } catch (error) {
        logger.error('POST /documents/:id/ai/summarize failed', { error, documentId: req.params.id });
        next(error);
      }
    }
  );

  /**
   * POST /documents/:id/ai/explain
   * AI explanation of selected text
   */
  router.post(
    '/documents/:id/ai/explain',
    extractTenantContextFromJwtOrHeaders,
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const { id } = req.params;
        const tenantContext = (req as any).tenantContext;
        const { text, context } = req.body;

        if (!tenantContext?.tenantId) {
          return res.status(400).json({ error: 'Tenant context required' });
        }

        if (!text) {
          return res.status(400).json({ error: 'Text to explain is required' });
        }

        if (!aiDocumentService) {
          return res.status(503).json({
            error: 'AI features not available',
            message: 'OpenRouter API key not configured'
          });
        }

        const result = await aiDocumentService.explainText(
          id,
          tenantContext.userId,
          text,
          { context: context || undefined }
        );

        res.json(result);
      } catch (error) {
        logger.error('POST /documents/:id/ai/explain failed', { error, documentId: req.params.id });
        next(error);
      }
    }
  );

  /**
   * POST /documents/:id/ai/extract
   * Best-effort text extraction via LLM
   */
  router.post(
    '/documents/:id/ai/extract',
    extractTenantContextFromJwtOrHeaders,
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const { id } = req.params;
        const tenantContext = (req as any).tenantContext;
        const { format } = req.body;

        if (!tenantContext?.tenantId) {
          return res.status(400).json({ error: 'Tenant context required' });
        }

        if (!aiDocumentService) {
          return res.status(503).json({
            error: 'AI features not available',
            message: 'OpenRouter API key not configured'
          });
        }

        const result = await aiDocumentService.extractContent(
          id,
          tenantContext.userId,
          { format: format || 'text' }
        );

        res.json(result);
      } catch (error) {
        logger.error('POST /documents/:id/ai/extract failed', { error, documentId: req.params.id });
        next(error);
      }
    }
  );

  /**
   * POST /documents/:id/ai/ask
   * AI answer based on document
   */
  router.post(
    '/documents/:id/ai/ask',
    extractTenantContextFromJwtOrHeaders,
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const { id } = req.params;
        const tenantContext = (req as any).tenantContext;
        const { question, includeRelated, maxChunks } = req.body;

        if (!tenantContext?.tenantId) {
          return res.status(400).json({ error: 'Tenant context required' });
        }

        if (!question) {
          return res.status(400).json({ error: 'Question is required' });
        }

        if (!aiDocumentService) {
          return res.status(503).json({
            error: 'AI features not available',
            message: 'OpenRouter API key not configured'
          });
        }

        const result = await aiDocumentService.askQuestion(
          id,
          tenantContext.userId,
          question,
          {
            includeRelated: includeRelated || false,
            maxChunks: maxChunks || 5
          }
        );

        res.json(result);
      } catch (error) {
        logger.error('POST /documents/:id/ai/ask failed', { error, documentId: req.params.id });
        next(error);
      }
    }
  );

  // ──────────────────────────────────────────────────────────────────────────
  // TYPE DETECTION & RENDERING ENDPOINTS
  // ──────────────────────────────────────────────────────────────────────────

  /**
   * POST /documents/detect-type
   * Detect document type from content
   */
  router.post(
    '/documents/detect-type',
    extractTenantContextFromJwtOrHeaders,
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        // TODO: Implement by Agent 1 (Renderers)
        // - Implement type detection cascade
        // - Return detected type with confidence

        logger.info('POST /documents/detect-type - TODO: implement by Agent 1');
        res.status(501).json({ error: 'Not implemented yet' });
      } catch (error) {
        next(error);
      }
    }
  );

  /**
   * POST /documents/:id/render
   * Server-rendered output for complex conversions
   */
  router.post(
    '/documents/:id/render',
    extractTenantContextFromJwtOrHeaders,
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const { id } = req.params;
        const { rendererType, options } = req.body;

        // TODO: Implement by Agent 5 (Advanced Renderers)
        // - Server-side rendering for Word, Excel, etc.
        // - Cache rendered output

        logger.info(`POST /documents/${id}/render - TODO: implement by Agent 5`);
        res.status(501).json({ error: 'Not implemented yet' });
      } catch (error) {
        next(error);
      }
    }
  );

  // ──────────────────────────────────────────────────────────────────────────
  // USER PREFERENCES ENDPOINTS
  // ──────────────────────────────────────────────────────────────────────────

  /**
   * GET /documents/preferences
   * Get user document preferences
   */
  router.get(
    '/documents/preferences',
    requireUserContextJwt,
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const userId = (req as any).userContext?.userId;

        // TODO: Implement by Agent 4 (Themes + Sidebar)
        // - Query user_document_preferences table

        logger.info('GET /documents/preferences - TODO: implement by Agent 4');
        res.status(501).json({ error: 'Not implemented yet' });
      } catch (error) {
        next(error);
      }
    }
  );

  /**
   * PUT /documents/preferences
   * Update user document preferences
   */
  router.put(
    '/documents/preferences',
    requireUserContextJwt,
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const userId = (req as any).userContext?.userId;
        const updates = req.body;

        // TODO: Implement by Agent 4 (Themes + Sidebar)
        // - Upsert user_document_preferences

        logger.info('PUT /documents/preferences - TODO: implement by Agent 4');
        res.status(501).json({ error: 'Not implemented yet' });
      } catch (error) {
        next(error);
      }
    }
  );

  // ──────────────────────────────────────────────────────────────────────────
  // SEARCH ENDPOINT
  // ──────────────────────────────────────────────────────────────────────────

  /**
   * POST /documents/:id/search
   * Search within document
   */
  router.post(
    '/documents/:id/search',
    extractTenantContextFromJwtOrHeaders,
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const { id } = req.params;
        const { query, caseSensitive, wholeWord, regex, maxResults } = req.body;

        // TODO: Implement by Agent 7 (Toolbar + Search)
        // - Search document content
        // - Return results with highlights

        logger.info(`POST /documents/${id}/search - TODO: implement by Agent 7`);
        res.json([]);
      } catch (error) {
        next(error);
      }
    }
  );

  return router;
}

export default createDocumentViewerRoutes;
