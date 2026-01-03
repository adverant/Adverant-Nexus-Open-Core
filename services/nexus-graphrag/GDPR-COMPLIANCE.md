# GDPR Compliance - Phase 2 Implementation

## Overview

This document describes the GDPR compliance implementation for user data rights in the Nexus GraphRAG service. The implementation provides **complete data export** and **complete data deletion** capabilities across all storage systems.

## Architecture

### Components

1. **GDPRService** (`src/services/gdpr-service.ts`)
   - Core business logic for GDPR operations
   - Handles data export and deletion across all databases
   - Provides audit logging for compliance

2. **GDPR Routes** (`src/api/gdpr-routes.ts`)
   - RESTful API endpoints for GDPR operations
   - Rate limiting and security controls
   - User context validation

3. **Database Migration** (`migrations/007_gdpr_audit_log.sql`)
   - Audit log table for tracking all GDPR operations
   - Required for regulatory compliance

## Supported Operations

### Article 15: Right of Access (Data Export)

Export **all** user data from:
- **PostgreSQL**: Memories and documents from `unified_content` table
- **Qdrant**: All vector embeddings with user metadata
- **Neo4j**: All episodes and entities in the knowledge graph

### Article 17: Right to Erasure (Data Deletion)

Permanently delete **all** user data from:
- **PostgreSQL**: All memories and documents (transactional)
- **Qdrant**: All vector points matching user_id
- **Neo4j**: All episodes and entities (with relationships)

## API Endpoints

### 1. Export User Data

**Endpoint**: `GET /api/user/data`

**Headers**:
```
X-Company-ID: <company_id>
X-App-ID: <app_id>
X-User-ID: <user_id>
```

**Response**:
```json
{
  "userId": "user123",
  "tenantId": "tenant456",
  "exportDate": "2025-01-18T10:30:00.000Z",
  "data": {
    "memories": [...],
    "documents": [...],
    "vectors": [...],
    "episodes": [...],
    "entities": [...]
  },
  "metadata": {
    "totalRecords": 1250,
    "recordsByType": {
      "memories": 450,
      "documents": 300,
      "vectors": 350,
      "episodes": 100,
      "entities": 50
    }
  }
}
```

**Rate Limit**: 5 requests per hour per user

### 2. Delete User Data

**Endpoint**: `DELETE /api/user/data`

**Headers**:
```
X-Company-ID: <company_id>
X-App-ID: <app_id>
X-User-ID: <user_id>
Content-Type: application/json
```

**Body**:
```json
{
  "confirmation": "DELETE_ALL_MY_DATA"
}
```

**Response**:
```json
{
  "message": "User data deletion completed",
  "report": {
    "userId": "user123",
    "tenantId": "tenant456",
    "deletionDate": "2025-01-18T10:30:00.000Z",
    "deletedCounts": {
      "postgres": {
        "memories": 450,
        "documents": 300,
        "total": 750
      },
      "qdrant": {
        "vectors": 350
      },
      "neo4j": {
        "episodes": 100,
        "entities": 50,
        "total": 150
      }
    },
    "totalDeleted": 1250,
    "errors": []
  }
}
```

**Rate Limit**: 5 requests per hour per user

### 3. Check Data Status

**Endpoint**: `GET /api/user/data/status`

**Headers**:
```
X-Company-ID: <company_id>
X-App-ID: <app_id>
X-User-ID: <user_id>
```

**Response**:
```json
{
  "userId": "user123",
  "tenantId": "tenant456",
  "dataStatus": {
    "totalRecords": 1250,
    "recordsByType": {
      "memories": 450,
      "documents": 300,
      "vectors": 350,
      "episodes": 100,
      "entities": 50
    }
  },
  "message": "Use GET /api/user/data to export or DELETE /api/user/data to delete"
}
```

## Security Features

### 1. User Context Validation
- **Tenant Isolation**: Users can only access data from their own tenant
- **User Verification**: All operations verify user identity via middleware
- **Surgical Deletion**: Only the authenticated user's data is affected

### 2. Rate Limiting
- **Export/Delete**: 5 requests per hour per user
- **Status Check**: Standard rate limits apply
- Prevents abuse and DoS attacks

### 3. Audit Logging
All GDPR operations are logged to `gdpr_audit_log` table:
- User ID and Tenant ID
- Operation type (EXPORT/DELETE)
- Timestamp
- Record counts
- IP address and user agent (via request logging)

### 4. Confirmation Required
- Deletion requires explicit confirmation: `"DELETE_ALL_MY_DATA"`
- Prevents accidental data loss

## Database Schema

### GDPR Audit Log Table

```sql
CREATE TABLE gdpr_audit_log (
  id BIGSERIAL PRIMARY KEY,
  user_id VARCHAR(255) NOT NULL,
  tenant_id VARCHAR(255) NOT NULL,
  operation VARCHAR(20) NOT NULL CHECK (operation IN ('EXPORT', 'DELETE')),
  record_count INTEGER NOT NULL DEFAULT 0,
  details JSONB,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);
```

**Indexes**:
- `idx_gdpr_audit_user_id` - Query by user
- `idx_gdpr_audit_tenant_id` - Query by tenant
- `idx_gdpr_audit_operation` - Query by operation type
- `idx_gdpr_audit_created_at` - Time-based queries

## Implementation Details

### Export Process

1. **Parallel Retrieval**: All data sources queried in parallel for performance
2. **Complete Dataset**: Returns all fields, not just summaries
3. **Downloadable Format**: Returns as JSON with proper headers
4. **Audit Trail**: Logs export operation with record counts

### Deletion Process

1. **PostgreSQL**: Transactional deletion with rollback support
2. **Qdrant**: Filter-based deletion using user_id + tenant_id
3. **Neo4j**: DETACH DELETE to remove nodes and relationships
4. **Partial Failure Handling**: Continues deletion across databases even if one fails
5. **Comprehensive Report**: Returns deletion counts and any errors

### Error Handling

- **Database Failures**: Each database operation wrapped in try-catch
- **Partial Deletions**: Errors logged but don't halt the entire process
- **Audit Logging**: Failures in audit logging don't affect the operation
- **Detailed Errors**: Returns specific error messages for debugging

## Multi-Tenant Support

### Tenant Isolation
- All queries filter by **both** `user_id` AND `tenant_id`
- Prevents cross-tenant data access
- Ensures data sovereignty per tenant

### User Context Middleware
```typescript
extractTenantContext  // Extracts tenant/user from headers
requireUserContext    // Validates user context exists
```

## Testing

### Manual Testing

1. **Export Data**:
```bash
curl -X GET http://localhost:8090/api/user/data \
  -H "X-Company-ID: company123" \
  -H "X-App-ID: app456" \
  -H "X-User-ID: user789"
```

2. **Delete Data**:
```bash
curl -X DELETE http://localhost:8090/api/user/data \
  -H "X-Company-ID: company123" \
  -H "X-App-ID: app456" \
  -H "X-User-ID: user789" \
  -H "Content-Type: application/json" \
  -d '{"confirmation": "DELETE_ALL_MY_DATA"}'
```

3. **Check Status**:
```bash
curl -X GET http://localhost:8090/api/user/data/status \
  -H "X-Company-ID: company123" \
  -H "X-App-ID: app456" \
  -H "X-User-ID: user789"
```

### Integration Testing

Create test data:
```typescript
// Store test memories
await unifiedStorageEngine.storeMemory({
  userId: 'test-user',
  tenantId: 'test-tenant',
  content: 'Test memory',
  metadata: { source: 'test' }
});

// Export and verify
const exportData = await gdprService.exportUserData({
  userId: 'test-user',
  tenantId: 'test-tenant'
});

// Delete and verify
const report = await gdprService.deleteUserData({
  userId: 'test-user',
  tenantId: 'test-tenant'
});
```

## Compliance Checklist

- [x] **Article 15 (Right of Access)**: Complete data export implemented
- [x] **Article 17 (Right to Erasure)**: Complete data deletion implemented
- [x] **Audit Logging**: All GDPR operations logged for compliance
- [x] **Data Portability**: Export format is machine-readable JSON
- [x] **Security**: Rate limiting and user validation in place
- [x] **Tenant Isolation**: Multi-tenant data isolation enforced
- [x] **Error Handling**: Comprehensive error reporting
- [x] **Documentation**: API documented with examples

## Deployment

### 1. Run Database Migration

```bash
# Inside GraphRAG container
docker exec -it nexus-graphrag npx tsx src/database/migration-runner.ts
```

### 2. Verify Routes

```bash
# Check health
curl http://localhost:8090/health

# Test GDPR status endpoint
curl -X GET http://localhost:8090/api/user/data/status \
  -H "X-Company-ID: test" \
  -H "X-App-ID: test" \
  -H "X-User-ID: test"
```

### 3. Monitor Logs

```bash
# Watch GDPR operations
docker logs -f nexus-graphrag | grep GDPR
```

## Future Enhancements

### Phase 3 (Optional)
- [ ] Data retention policies (auto-delete after N days)
- [ ] Anonymization option (instead of deletion)
- [ ] Bulk export API (for data portability to other systems)
- [ ] GDPR compliance dashboard
- [ ] Encrypted exports with user password

### Performance Optimizations
- [ ] Streaming export for large datasets
- [ ] Batch deletion for improved performance
- [ ] Pre-count vectors before deletion (Qdrant limitation)
- [ ] Background processing for large deletions

## Troubleshooting

### Issue: "GDPR service not initialized"
**Solution**: Ensure services are fully initialized before making requests. The GDPR routes are registered during the `start()` lifecycle.

### Issue: "User context required"
**Solution**: Ensure `X-Company-ID`, `X-App-ID`, and `X-User-ID` headers are present in all requests.

### Issue: Rate limit exceeded
**Solution**: Wait 1 hour between GDPR requests, or adjust rate limits in `gdpr-routes.ts` if testing.

### Issue: Partial deletion failures
**Solution**: Check the `errors` array in the deletion report. Individual database failures are logged but don't halt the process.

## References

- [GDPR Article 15: Right of Access](https://gdpr-info.eu/art-15-gdpr/)
- [GDPR Article 17: Right to Erasure](https://gdpr-info.eu/art-17-gdpr/)
- [Tenant Context Middleware](./src/middleware/tenant-context.ts)
- [GDPR Service Implementation](./src/services/gdpr-service.ts)
- [GDPR Routes](./src/api/gdpr-routes.ts)
