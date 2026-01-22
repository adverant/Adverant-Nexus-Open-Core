/**
 * Billing Routes (Enterprise Feature - Stub for Open Core)
 * 
 * This file provides type-safe stubs for billing and subscription routes.
 * Full implementation is available in Enterprise version.
 */

import { Router } from 'express';

export function createBillingRoutes(): Router {
  const router = Router();
  
  // Stub implementation - returns 501 Not Implemented
  router.all('*', (req, res) => {
    res.status(501).json({
      error: 'Billing routes are an Enterprise feature',
      message: 'Upgrade to Enterprise for full billing and subscription features'
    });
  });
  
  return router;
}
