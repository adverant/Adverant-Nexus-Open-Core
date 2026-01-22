/**
 * Service Catalog API Routes
 *
 * REST API for the Living Service Knowledge Graph.
 * Provides endpoints for service registration, capability matching,
 * and performance metrics.
 */

import { Router, Request, Response } from 'express';
import { Pool } from 'pg';
import {
  ServiceCatalogRepository,
  getServiceCatalogRepository,
  CapabilityMatcher,
  createCapabilityMatcher,
  PerformanceScorer,
  createPerformanceScorer,
  ServiceRegistrationRequest,
  ServiceQueryRequest,
  InteractionRecord,
} from '../services/service-catalog/index.js';

/**
 * Create service catalog routes
 */
export function createServiceCatalogRoutes(pool: Pool, qdrantUrl?: string): Router {
  const router = Router();

  // Initialize services
  const repository = getServiceCatalogRepository(pool);
  const scorer = createPerformanceScorer(repository);
  const matcher = createCapabilityMatcher(repository, scorer, qdrantUrl);

  // ============================================================================
  // SERVICE ENDPOINTS
  // ============================================================================

  /**
   * GET /api/v1/service-catalog
   * List all registered services
   */
  router.get('/', async (req: Request, res: Response) => {
    try {
      const { status, limit, offset } = req.query;

      const result = await repository.listServices({
        status: status as 'active' | 'degraded' | 'offline' | 'deprecated' | undefined,
        limit: limit ? parseInt(limit as string, 10) : 50,
        offset: offset ? parseInt(offset as string, 10) : 0,
      });

      res.json({
        success: true,
        services: result.services.map(s => ({
          id: s.id,
          name: s.structuredData.name,
          version: s.structuredData.version,
          status: s.structuredData.status,
          description: s.structuredData.description,
          capabilities: s.structuredData.capabilities,
          protocols: s.structuredData.protocols,
          lastHealthCheck: s.metadata.lastHealthCheck,
        })),
        total: result.total,
      });
    } catch (error) {
      console.error('Error listing services:', error);
      res.status(500).json({
        success: false,
        error: (error as Error).message,
      });
    }
  });

  /**
   * GET /api/v1/service-catalog/:serviceId
   * Get service details with capabilities
   */
  router.get('/:serviceId', async (req: Request, res: Response) => {
    try {
      const { serviceId } = req.params;
      const { includeCapabilities, includeMetrics } = req.query;

      const service = await repository.getService(serviceId);
      if (!service) {
        return res.status(404).json({
          success: false,
          error: `Service ${serviceId} not found`,
        });
      }

      let capabilities = undefined;
      if (includeCapabilities === 'true') {
        capabilities = await repository.getCapabilities(serviceId);
      }

      let metrics = undefined;
      if (includeMetrics === 'true') {
        metrics = await repository.getMetrics(serviceId, 'daily', 7);
      }

      let score = undefined;
      score = await scorer.calculateScore(serviceId);

      res.json({
        success: true,
        service: {
          id: service.id,
          name: service.structuredData.name,
          version: service.structuredData.version,
          status: service.structuredData.status,
          description: service.structuredData.description,
          endpoints: service.structuredData.endpoints,
          capabilities: service.structuredData.capabilities,
          protocols: service.structuredData.protocols,
          authRequired: service.structuredData.authRequired,
          rateLimits: service.structuredData.rateLimits,
          dependencies: service.structuredData.dependencies,
          metadata: service.metadata,
        },
        ...(capabilities && { capabilities: capabilities.map(c => ({
          id: c.id,
          name: c.structuredData.name,
          description: c.textContent,
          endpoint: c.structuredData.endpoint,
          method: c.structuredData.method,
          inputTypes: c.structuredData.inputTypes,
          outputTypes: c.structuredData.outputTypes,
          estimatedDuration: c.structuredData.estimatedDuration,
        })) }),
        ...(metrics && { metrics }),
        score,
      });
    } catch (error) {
      console.error('Error getting service:', error);
      res.status(500).json({
        success: false,
        error: (error as Error).message,
      });
    }
  });

  /**
   * POST /api/v1/service-catalog/register
   * Register or update a service
   */
  router.post('/register', async (req: Request, res: Response) => {
    try {
      const request: ServiceRegistrationRequest = req.body;

      // Validate required fields
      if (!request.name || !request.version || !request.description || !request.endpoints) {
        return res.status(400).json({
          success: false,
          error: 'Missing required fields: name, version, description, endpoints',
        });
      }

      const service = await repository.registerService(request);

      // Index capabilities for semantic search
      const capabilities = await repository.getCapabilities(service.id);
      for (const capability of capabilities) {
        await matcher.indexCapability(capability, service);
      }

      res.status(201).json({
        success: true,
        service: {
          id: service.id,
          name: service.structuredData.name,
          version: service.structuredData.version,
          status: service.structuredData.status,
          registeredAt: service.metadata.registeredAt,
        },
        capabilitiesIndexed: capabilities.length,
      });
    } catch (error) {
      console.error('Error registering service:', error);
      res.status(500).json({
        success: false,
        error: (error as Error).message,
      });
    }
  });

  /**
   * DELETE /api/v1/service-catalog/:serviceId
   * Deregister a service
   */
  router.delete('/:serviceId', async (req: Request, res: Response) => {
    try {
      const { serviceId } = req.params;

      const deleted = await repository.deleteService(serviceId);
      if (!deleted) {
        return res.status(404).json({
          success: false,
          error: `Service ${serviceId} not found`,
        });
      }

      res.json({
        success: true,
        message: `Service ${serviceId} deregistered`,
      });
    } catch (error) {
      console.error('Error deleting service:', error);
      res.status(500).json({
        success: false,
        error: (error as Error).message,
      });
    }
  });

  // ============================================================================
  // CAPABILITY ENDPOINTS
  // ============================================================================

  /**
   * GET /api/v1/service-catalog/capabilities
   * List all capabilities across services
   */
  router.get('/capabilities', async (_req: Request, res: Response) => {
    try {
      const capabilities = await repository.listAllCapabilities();

      res.json({
        success: true,
        capabilities: await Promise.all(capabilities.map(async c => {
          const service = await repository.getService(c.parentId);
          return {
            id: c.id,
            name: c.structuredData.name,
            serviceName: service?.structuredData.name,
            serviceStatus: service?.structuredData.status,
            description: c.textContent,
            endpoint: c.structuredData.endpoint,
            method: c.structuredData.method,
            queryPatterns: c.structuredData.queryPatterns,
            inputTypes: c.structuredData.inputTypes,
            outputTypes: c.structuredData.outputTypes,
          };
        })),
        total: capabilities.length,
      });
    } catch (error) {
      console.error('Error listing capabilities:', error);
      res.status(500).json({
        success: false,
        error: (error as Error).message,
      });
    }
  });

  /**
   * POST /api/v1/service-catalog/capabilities/match
   * Match a query to capabilities
   */
  router.post('/capabilities/match', async (req: Request, res: Response) => {
    try {
      const request: ServiceQueryRequest = req.body;

      if (!request.query) {
        return res.status(400).json({
          success: false,
          error: 'query is required',
        });
      }

      const result = await matcher.matchCapabilities(request);

      res.json({
        success: true,
        ...result,
      });
    } catch (error) {
      console.error('Error matching capabilities:', error);
      res.status(500).json({
        success: false,
        error: (error as Error).message,
      });
    }
  });

  // ============================================================================
  // METRICS ENDPOINTS
  // ============================================================================

  /**
   * GET /api/v1/service-catalog/metrics/:serviceId
   * Get performance metrics for a service
   */
  router.get('/metrics/:serviceId', async (req: Request, res: Response) => {
    try {
      const { serviceId } = req.params;
      const { period, limit } = req.query;

      const metrics = await repository.getMetrics(
        serviceId,
        (period as 'hourly' | 'daily' | 'weekly') || 'daily',
        limit ? parseInt(limit as string, 10) : 24
      );

      const score = await scorer.calculateScore(serviceId);

      res.json({
        success: true,
        serviceId,
        metrics: metrics.map(m => m.structuredData),
        score,
      });
    } catch (error) {
      console.error('Error getting metrics:', error);
      res.status(500).json({
        success: false,
        error: (error as Error).message,
      });
    }
  });

  /**
   * POST /api/v1/service-catalog/metrics/record
   * Record a service interaction
   */
  router.post('/metrics/record', async (req: Request, res: Response) => {
    try {
      const record: InteractionRecord = {
        ...req.body,
        timestamp: req.body.timestamp || new Date().toISOString(),
      };

      if (!record.serviceId || !record.serviceName || !record.capabilityName) {
        return res.status(400).json({
          success: false,
          error: 'serviceId, serviceName, and capabilityName are required',
        });
      }

      await repository.recordInteraction(record);

      // Invalidate score cache for this service
      scorer.invalidateService(record.serviceId);

      res.json({
        success: true,
        message: 'Interaction recorded',
      });
    } catch (error) {
      console.error('Error recording interaction:', error);
      res.status(500).json({
        success: false,
        error: (error as Error).message,
      });
    }
  });

  // ============================================================================
  // QUERY ENDPOINT
  // ============================================================================

  /**
   * POST /api/v1/service-catalog/query
   * Semantic capability search with scoring
   */
  router.post('/query', async (req: Request, res: Response) => {
    try {
      const request: ServiceQueryRequest = req.body;

      if (!request.query) {
        return res.status(400).json({
          success: false,
          error: 'query is required',
        });
      }

      const result = await matcher.matchCapabilities({
        ...request,
        includeMetrics: true,
      });

      res.json({
        success: true,
        ...result,
      });
    } catch (error) {
      console.error('Error querying services:', error);
      res.status(500).json({
        success: false,
        error: (error as Error).message,
      });
    }
  });

  // ============================================================================
  // HEALTH SUMMARY
  // ============================================================================

  /**
   * GET /api/v1/service-catalog/health-summary
   * Get health summary of all services
   */
  router.get('/health-summary', async (_req: Request, res: Response) => {
    try {
      const { services } = await repository.listServices();

      const summary = {
        total: services.length,
        active: 0,
        degraded: 0,
        offline: 0,
        deprecated: 0,
      };

      for (const service of services) {
        const status = service.structuredData.status;
        if (status in summary) {
          summary[status as keyof typeof summary]++;
        }
      }

      res.json({
        success: true,
        summary,
        services: services.map(s => ({
          name: s.structuredData.name,
          status: s.structuredData.status,
          lastHealthCheck: s.metadata.lastHealthCheck,
        })),
      });
    } catch (error) {
      console.error('Error getting health summary:', error);
      res.status(500).json({
        success: false,
        error: (error as Error).message,
      });
    }
  });

  return router;
}

export default createServiceCatalogRoutes;
