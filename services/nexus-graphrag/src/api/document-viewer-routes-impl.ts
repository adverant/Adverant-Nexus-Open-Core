/**
 * Document Viewer Routes Implementation
 *
 * This file contains all the route handler implementations.
 * Copy these into document-viewer-routes.ts to replace the TODO stubs.
 */

// GET /documents/:id
export const getDocumentByIdHandler = `
router.get(
  '/documents/:id',
  extractTenantContextFromJwtOrHeaders,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { id } = req.params;
      const tenantContext = (req as any).tenantContext;

      if (!tenantContext?.tenantId) {
        return res.status(400).json({ error: 'Tenant context required' });
      }

      const document = await documentViewerService.getDocumentById(id, tenantContext.tenantId);
      res.json(document);
    } catch (error) {
      logger.error('GET /documents/:id failed', { error, documentId: req.params.id });
      next(error);
    }
  }
);`;

// GET /documents/:id/content
export const getDocumentContentHandler = `
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
        tenantContext.tenantId,
        { format, includeMetadata }
      );

      res.json(result);
    } catch (error) {
      logger.error('GET /documents/:id/content failed', { error, documentId: req.params.id });
      next(error);
    }
  }
);`;

// GET /documents/:id/binary
export const getDocumentBinaryHandler = `
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

      const result = await documentViewerService.getDocumentBinary(id, tenantContext.tenantId);

      res.setHeader('Content-Type', result.mimeType);
      res.setHeader('Content-Disposition', \`attachment; filename="\${result.filename}"\`);
      res.send(result.data);
    } catch (error) {
      logger.error('GET /documents/:id/binary failed', { error, documentId: req.params.id });
      next(error);
    }
  }
);`;

// GET /documents/:id/chunks
export const getDocumentChunksHandler = `
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
        tenantContext.tenantId,
        { page, pageSize }
      );

      res.json(result);
    } catch (error) {
      logger.error('GET /documents/:id/chunks failed', { error, documentId: req.params.id });
      next(error);
    }
  }
);`;

// GET /documents/:id/chunks/:chunkId/similar
export const getSimilarChunksHandler = `
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
        tenantContext.tenantId,
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
);`;

// GET /documents/:id/entities
export const getDocumentEntitiesHandler = `
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
        tenantContext.tenantId
      );

      res.json(entities);
    } catch (error) {
      logger.error('GET /documents/:id/entities failed', { error, documentId: req.params.id });
      next(error);
    }
  }
);`;

// GET /documents/:id/relationships
export const getDocumentRelationshipsHandler = `
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
        tenantContext.tenantId
      );

      res.json(relationships);
    } catch (error) {
      logger.error('GET /documents/:id/relationships failed', { error, documentId: req.params.id });
      next(error);
    }
  }
);`;

// GET /documents/:id/related
export const getRelatedDocumentsHandler = `
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
        tenantContext.tenantId,
        { method, minSimilarity, minSharedEntities },
        limit
      );

      res.json(relatedDocs);
    } catch (error) {
      logger.error('GET /documents/:id/related failed', { error, documentId: req.params.id });
      next(error);
    }
  }
);`;

// GET /documents/:id/memories
export const getDocumentMemoriesHandler = `
router.get(
  '/documents/:id/memories',
  extractTenantContextFromJwtOrHeaders,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { id } = req.params;
      const tenantContext = (req as any).tenantContext;

      if (!tenantContext?.tenantId) {
        return res.status(400).json({ error: 'Tenant context required' });
      }

      const limit = parseInt(req.query.limit as string) || 20;

      const memories = await documentGraphRAGService.getDocumentMemories(
        id,
        tenantContext.tenantId,
        limit
      );

      res.json(memories);
    } catch (error) {
      logger.error('GET /documents/:id/memories failed', { error, documentId: req.params.id });
      next(error);
    }
  }
);`;

// POST /documents/:id/entities
export const createEntityHandler = `
router.post(
  '/documents/:id/entities',
  requireUserContextJwt,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { id } = req.params;
      const tenantContext = (req as any).tenantContext;
      const userContext = (req as any).userContext;

      if (!tenantContext?.tenantId || !userContext?.userId) {
        return res.status(400).json({ error: 'Tenant and user context required' });
      }

      const entityData = req.body;

      const entity = await documentGraphRAGService.createEntityFromDocument(
        id,
        tenantContext.tenantId,
        userContext.userId,
        entityData
      );

      res.status(201).json(entity);
    } catch (error) {
      logger.error('POST /documents/:id/entities failed', { error, documentId: req.params.id });
      next(error);
    }
  }
);`;

// POST /documents/:id/entities/:entityId/link
export const linkEntityHandler = `
router.post(
  '/documents/:id/entities/:entityId/link',
  requireUserContextJwt,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { id, entityId } = req.params;
      const tenantContext = (req as any).tenantContext;
      const userContext = (req as any).userContext;

      if (!tenantContext?.tenantId || !userContext?.userId) {
        return res.status(400).json({ error: 'Tenant and user context required' });
      }

      const { spans } = req.body;

      await documentGraphRAGService.linkEntityToDocument(
        id,
        entityId,
        tenantContext.tenantId,
        userContext.userId,
        { spans }
      );

      res.status(200).json({ success: true });
    } catch (error) {
      logger.error('POST /documents/:id/entities/:entityId/link failed', {
        error,
        documentId: req.params.id,
        entityId: req.params.entityId
      });
      next(error);
    }
  }
);`;

// POST /documents/detect-type
export const detectTypeHandler = `
router.post(
  '/documents/detect-type',
  extractTenantContextFromJwtOrHeaders,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { content, filename, mimeType, explicitType } = req.body;

      if (!content) {
        return res.status(400).json({ error: 'Content required' });
      }

      const result = await typeDetectionService.detectType(
        content,
        filename,
        mimeType,
        explicitType
      );

      res.json(result);
    } catch (error) {
      logger.error('POST /documents/detect-type failed', { error });
      next(error);
    }
  }
);`;
