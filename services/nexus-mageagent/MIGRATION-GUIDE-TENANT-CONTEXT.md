# MageAgent Tenant Context Migration Guide

## Overview

This guide provides step-by-step instructions for migrating all MageAgent route handlers to use the new tenant-aware GraphRAG client with multi-tenant security.

## Changes Required

### 1. Import Changes

**Before**:
```typescript
import { graphRAGClient } from '../clients/graphrag-client';
```

**After**:
```typescript
import { createGraphRAGClient, TenantContext } from '../clients/graphrag-client';
import { extractTenantContext } from '../middleware/tenant-context';
```

### 2. Add Middleware to Routes

All routes that interact with GraphRAG **MUST** use the tenant context middleware:

```typescript
router.post('/memory/store',
  extractTenantContext,  // ← ADD THIS
  apiRateLimiters.orchestrate,
  sanitizeInputs,
  asyncHandler(async (req: Request, res: Response) => {
    // ... handler code
  })
);
```

### 3. Create Per-Request GraphRAG Client

**Before** (INSECURE - uses global singleton):
```typescript
const result = await graphRAGClient.storeMemory({
  content,
  tags,
  metadata
});
```

**After** (SECURE - uses tenant-scoped client):
```typescript
const graphRAGClient = createGraphRAGClient(req.tenantContext!);
const result = await graphRAGClient.storeMemory({
  content,
  tags,
  metadata
});
```

## Migration Pattern Examples

### Example 1: Simple Memory Storage

**Before**:
```typescript
router.post('/memory/store',
  apiRateLimiters.orchestrate,
  sanitizeInputs,
  asyncHandler(async (req: Request, res: Response) => {
    const { content, tags, metadata } = req.body;

    const result = await graphRAGClient.storeMemory({
      content,
      tags,
      metadata
    });

    return ApiResponse.success(res, result);
  })
);
```

**After**:
```typescript
router.post('/memory/store',
  extractTenantContext,  // ← ADDED
  apiRateLimiters.orchestrate,
  sanitizeInputs,
  asyncHandler(async (req: Request, res: Response) => {
    const { content, tags, metadata } = req.body;

    // ← CHANGED: Create tenant-scoped client
    const graphRAGClient = createGraphRAGClient(req.tenantContext!);

    const result = await graphRAGClient.storeMemory({
      content,
      tags,
      metadata
    });

    return ApiResponse.success(res, result);
  })
);
```

### Example 2: Memory Search with Validation

**Before**:
```typescript
router.post('/memory/search',
  apiRateLimiters.memorySearch,
  sanitizeInputs,
  validateSchema(validationSchemas.memorySearch),
  asyncHandler(async (req: Request, res: Response) => {
    const { query, limit = 10 } = req.body;

    const results = await graphRAGClient.recallMemory({ query, limit });

    return ApiResponse.success(res, { results });
  })
);
```

**After**:
```typescript
router.post('/memory/search',
  extractTenantContext,  // ← ADDED
  apiRateLimiters.memorySearch,
  sanitizeInputs,
  validateSchema(validationSchemas.memorySearch),
  asyncHandler(async (req: Request, res: Response) => {
    const { query, limit = 10 } = req.body;

    // ← CHANGED: Create tenant-scoped client
    const graphRAGClient = createGraphRAGClient(req.tenantContext!);

    const results = await graphRAGClient.recallMemory({ query, limit });

    return ApiResponse.success(res, { results });
  })
);
```

### Example 3: Competition Endpoint (Store Results)

**Before**:
```typescript
router.post('/competition',
  apiRateLimiters.competition,
  sanitizeInputs,
  asyncHandler(async (req: Request, res: Response) => {
    const result = await orchestrator.runCompetition(params);

    // Store results in GraphRAG
    await graphRAGClient.storeMemory({
      content: JSON.stringify(result),
      tags: ['competition'],
      metadata: { type: 'competition-result' }
    });

    return ApiResponse.success(res, result);
  })
);
```

**After**:
```typescript
router.post('/competition',
  extractTenantContext,  // ← ADDED
  apiRateLimiters.competition,
  sanitizeInputs,
  asyncHandler(async (req: Request, res: Response) => {
    const result = await orchestrator.runCompetition(params);

    // ← CHANGED: Create tenant-scoped client
    const graphRAGClient = createGraphRAGClient(req.tenantContext!);

    // Store results in GraphRAG
    await graphRAGClient.storeMemory({
      content: JSON.stringify(result),
      tags: ['competition'],
      metadata: { type: 'competition-result' }
    });

    return ApiResponse.success(res, result);
  })
);
```

### Example 4: Smart Process Endpoint

**Before**:
```typescript
switch (operation) {
  case 'store':
    result = await graphRAGClient.storeMemory({
      content: mainInput,
      tags: req.body.tags || ['user-input']
    });
    break;

  case 'search':
    result = await graphRAGClient.recallMemory({
      query: mainInput,
      limit: req.body.limit || 10
    });
    break;
}
```

**After**:
```typescript
// ← ADDED: Create tenant-scoped client at the beginning
const graphRAGClient = createGraphRAGClient(req.tenantContext!);

switch (operation) {
  case 'store':
    result = await graphRAGClient.storeMemory({
      content: mainInput,
      tags: req.body.tags || ['user-input']
    });
    break;

  case 'search':
    result = await graphRAGClient.recallMemory({
      query: mainInput,
      limit: req.body.limit || 10
    });
    break;
}
```

## Routes Requiring Migration

Based on `/routes/index.ts`, the following routes need updates:

### Priority 1 (Direct GraphRAG Interaction)
1. ✅ Line 183-191: `/process` (store operation)
2. ✅ Line 194-198: `/process` (search operation)
3. ✅ Line 220: `/health` (graphRAG health check)
4. ✅ Line 734-738: `/process` (search case)
5. ✅ Line 748-760: `/process` (store case)
6. ✅ Line 887-899: `/competition` (store results)
7. ✅ Line 1566-1603: `/memory/store`
8. ✅ Line 2054-2066: `/patterns/:context` (recall memory)
9. ✅ Line 2070-2090: `/memory/search`
10. ✅ Line 2139-2147: `/websocket/stats` (get stats)
11. ✅ Line 2151-2182: `/patterns` (store pattern)

### Priority 2 (Health Checks)
12. ✅ Line 220: `/health` endpoint health check

## Migration Checklist

For **EACH** route that uses `graphRAGClient`:

- [ ] Add `extractTenantContext` middleware as **first** middleware in chain
- [ ] Import `createGraphRAGClient` and `TenantContext`
- [ ] Create `const graphRAGClient = createGraphRAGClient(req.tenantContext!);` at top of handler
- [ ] Replace ALL occurrences of global `graphRAGClient` with local instance
- [ ] Test the route with valid tenant headers
- [ ] Test the route WITHOUT tenant headers (should return 401)
- [ ] Test cross-tenant access (should return 403 from GraphRAG)

## Testing Each Route

### Test 1: Valid Tenant Context
```bash
curl -X POST http://localhost:8080/api/memory/store \
  -H "Content-Type: application/json" \
  -H "X-Company-ID: test-company-a" \
  -H "X-App-ID: test-app-1" \
  -d '{"content": "Test memory"}'
```

**Expected**: 200 OK with memory stored

### Test 2: Missing Tenant Context
```bash
curl -X POST http://localhost:8080/api/memory/store \
  -H "Content-Type: application/json" \
  -d '{"content": "Test memory"}'
```

**Expected**: 401 Unauthorized with error message about missing tenant context

### Test 3: Invalid Tenant ID Format
```bash
curl -X POST http://localhost:8080/api/memory/store \
  -H "Content-Type: application/json" \
  -H "X-Company-ID: invalid!@#$" \
  -H "X-App-ID: test-app-1" \
  -d '{"content": "Test memory"}'
```

**Expected**: 400 Bad Request with error about invalid company_id format

## Health Check Special Case

The `/health` endpoint should NOT require tenant context (it's a system endpoint).

**Solution**: Use `extractTenantContextOptional` middleware:

```typescript
router.get('/health',
  extractTenantContextOptional,  // ← Optional, not required
  asyncHandler(async (req: Request, res: Response) => {
    // Only check GraphRAG health if we have tenant context
    let graphRAGHealthy = false;

    if (req.tenantContext) {
      const graphRAGClient = createGraphRAGClient(req.tenantContext);
      graphRAGHealthy = await graphRAGClient.checkHealth();
    }

    return ApiResponse.success(res, {
      status: 'healthy',
      graphRAG: req.tenantContext ? graphRAGHealthy : 'not checked (no tenant context)'
    });
  })
);
```

## Internal Routes

Internal routes (in `internalRouter`) should also use tenant context if they interact with GraphRAG. If internal services don't provide tenant headers, they need to be updated.

**Option 1**: Require tenant headers from internal services
```typescript
internalRouter.post('/orchestrate',
  extractTenantContext,  // ← Still required
  // ... rest of middleware
);
```

**Option 2**: Use a default "system" tenant for internal operations
```typescript
internalRouter.post('/orchestrate',
  // Add middleware that injects system tenant if missing
  (req, res, next) => {
    if (!req.tenantContext) {
      req.tenantContext = {
        companyId: 'system',
        appId: 'internal'
      };
    }
    next();
  },
  // ... rest of middleware
);
```

## Verification Steps

After migrating all routes:

1. **Run the integration tests**:
   ```bash
   cd tests
   chmod +x run-integration-tests.sh
   ./run-integration-tests.sh
   ```

2. **Verify Suite 33 now PASSES**:
   - The critical tenant context propagation test should succeed
   - No cross-tenant data leakage

3. **Check logs** for any warnings about missing tenant context:
   ```bash
   docker logs nexus-mageagent 2>&1 | grep "without tenant context"
   ```

4. **Manual smoke tests**:
   - Test each migrated route with curl
   - Verify 401 responses without headers
   - Verify 200 responses with valid headers

## Rollback Plan

If issues are discovered after deployment:

1. **Immediate**: Revert to backup:
   ```bash
   cp services/nexus-mageagent/src/clients/graphrag-client.ts.backup \
      services/nexus-mageagent/src/clients/graphrag-client.ts
   ```

2. **Restart service**:
   ```bash
   docker restart nexus-mageagent
   ```

3. **Investigate** using logs and test failures

## Timeline

**Phase 1** (Day 1): Deploy refactored client (backward compatible)
- ✅ Already deployed (client accepts optional tenant context)

**Phase 2** (Day 2-3): Migrate critical routes
- `/memory/store`
- `/memory/search`
- `/competition`
- `/process`

**Phase 3** (Day 4-5): Migrate remaining routes
- All other routes with GraphRAG interaction

**Phase 4** (Day 6): Enforce & Verify
- Make tenant context REQUIRED in GraphRAGClient
- Run full test suite
- Production verification

## Support

If you encounter issues during migration:

1. Check logs: `docker logs nexus-mageagent`
2. Review this guide
3. Consult `CRITICAL-SECURITY-FIX-TENANT-CONTEXT-PROPAGATION.md`
4. Check test suite: `tests/security/tenant-context-propagation.test.ts`
