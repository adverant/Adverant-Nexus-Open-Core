# Comprehensive End-to-End Testing Plan - FileProcessAgent

**Date**: 2025-11-27
**Objective**: Test ALL aspects of deployed FileProcessAgent to find failures, issues, bottlenecks
**Approach**: Systematic testing from API → Worker → Storage → Metrics

---

## Test Phases

### Phase 1: Basic Health & Connectivity ✅ START HERE
- [ ] API health endpoint
- [ ] Metrics endpoint accessibility
- [ ] Database connectivity
- [ ] Redis connectivity
- [ ] MinIO/S3 connectivity
- [ ] MageAgent connectivity
- [ ] Worker pod status

### Phase 2: File Upload & Validation
- [ ] Valid PDF upload
- [ ] Valid PNG upload
- [ ] Valid TXT upload
- [ ] Valid ZIP archive upload
- [ ] Valid Office documents (DOCX, XLSX, PPTX)
- [ ] Invalid file rejection
- [ ] Oversized file handling
- [ ] Empty file handling
- [ ] Malformed files

### Phase 3: Queue & Job Processing
- [ ] Job creation in database
- [ ] Job queued to Redis/BullMQ
- [ ] Worker picks up job
- [ ] Job status transitions (pending → processing → completed/failed)
- [ ] Job metadata persistence
- [ ] Error handling and retry logic

### Phase 4: Archive Extraction
- [ ] ZIP extraction with nested files
- [ ] TAR extraction
- [ ] GZIP extraction
- [ ] Recursive archive processing
- [ ] Archive with mixed file types

### Phase 5: MageAgent Integration
- [ ] OCR processing for images
- [ ] PDF text extraction
- [ ] Vision model integration
- [ ] Table extraction
- [ ] Embedding generation

### Phase 6: Storage & Artifacts
- [ ] Original file storage in MinIO
- [ ] Extracted artifacts storage
- [ ] Artifact metadata in database
- [ ] Artifact retrieval
- [ ] Storage cleanup on failure

### Phase 7: Metrics & Monitoring
- [ ] Prometheus metrics exposed
- [ ] Job processing metrics
- [ ] MageAgent call metrics
- [ ] Pattern learning metrics
- [ ] Circuit breaker metrics
- [ ] Queue depth metrics
- [ ] Error rate metrics

### Phase 8: Error Scenarios
- [ ] Database connection failure
- [ ] Redis connection failure
- [ ] MinIO connection failure
- [ ] MageAgent unavailable
- [ ] Worker crash recovery
- [ ] Timeout handling
- [ ] Memory limit handling

### Phase 9: Performance & Load
- [ ] Single file processing time
- [ ] Concurrent file uploads (5, 10, 20)
- [ ] Large file handling (50MB, 100MB)
- [ ] Memory usage under load
- [ ] Queue backlog handling

### Phase 10: Integration Points
- [ ] Istio routing
- [ ] Service mesh communication
- [ ] Network policies
- [ ] DNS resolution
- [ ] Port forwarding

---

## Test Execution Log

### Test Environment
- Kubernetes Cluster: k3s on 157.173.102.118
- Namespace: nexus
- API Pod: nexus-fileprocess
- Worker Pod: nexus-fileprocess-worker
- MageAgent: nexus-mageagent

### Test Commands

```bash
# Health checks
curl -v http://nexus-fileprocess:9099/health
curl -v http://nexus-fileprocess:9099/metrics

# File upload test
curl -X POST http://nexus-fileprocess:9099/api/fileprocess/process \
  -F file=@test.pdf \
  -F userId=test-user \
  -v

# Job status check
curl -v http://nexus-fileprocess:9099/api/fileprocess/status/{jobId}

# Worker logs
k3s kubectl logs -n nexus deployment/nexus-fileprocess-worker --tail=100

# API logs
k3s kubectl logs -n nexus deployment/nexus-fileprocess --tail=100

# Database check
k3s kubectl exec -n nexus deployment/nexus-fileprocess -- psql $DATABASE_URL -c "SELECT * FROM jobs ORDER BY created_at DESC LIMIT 5;"

# Redis check
k3s kubectl exec -n nexus deployment/nexus-fileprocess -- redis-cli -h $REDIS_HOST LLEN nexus:queue:fileprocess

# MinIO check
k3s kubectl exec -n nexus deployment/nexus-fileprocess -- mc ls minio/nexus-fileprocess/
```

---

## Issues Found

### Critical Issues
<!-- Track critical failures that block functionality -->

### High Priority Issues
<!-- Track important issues that degrade functionality -->

### Medium Priority Issues
<!-- Track issues that cause inconvenience -->

### Low Priority Issues
<!-- Track minor issues and improvements -->

---

## Test Results Summary

| Phase | Tests | Pass | Fail | Skip | Notes |
|-------|-------|------|------|------|-------|
| 1. Health & Connectivity | 0 | 0 | 0 | 0 | Not started |
| 2. File Upload | 0 | 0 | 0 | 0 | Not started |
| 3. Queue & Jobs | 0 | 0 | 0 | 0 | Not started |
| 4. Archive Extraction | 0 | 0 | 0 | 0 | Not started |
| 5. MageAgent Integration | 0 | 0 | 0 | 0 | Not started |
| 6. Storage & Artifacts | 0 | 0 | 0 | 0 | Not started |
| 7. Metrics | 0 | 0 | 0 | 0 | Not started |
| 8. Error Scenarios | 0 | 0 | 0 | 0 | Not started |
| 9. Performance | 0 | 0 | 0 | 0 | Not started |
| 10. Integration | 0 | 0 | 0 | 0 | Not started |
| **TOTAL** | **0** | **0** | **0** | **0** | |

---

## Next Steps

1. Start with Phase 1: Basic Health & Connectivity
2. Document all failures immediately
3. Fix critical blockers before proceeding
4. Continue systematic testing through all phases
5. Create comprehensive failure analysis report
