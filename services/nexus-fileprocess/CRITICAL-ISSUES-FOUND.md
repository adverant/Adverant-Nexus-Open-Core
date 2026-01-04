# Critical Issues Found - FileProcessAgent E2E Testing

**Date**: 2025-11-27
**Testing Phase**: Phase 1 - Basic Health & Connectivity
**Status**: 🔴 CRITICAL BLOCKER FOUND

---

## Issue #1: Port Mismatch Between Application and Service (CRITICAL)

### Severity: **CRITICAL - Blocks ALL functionality**

### Symptom
- Health endpoint timeouts
- Metrics endpoint timeouts
- All API requests fail
- Pods show Running status but are not accessible

### Root Cause
**Port Mismatch**:
- Application listens on: **9109** (and WS on 9110)
- Kubernetes Service exposes: **9099** (and 9100)

### Evidence
```
# From logs:
[INFO] [FileProcessAgent] Starting FileProcessAgent API Gateway... {"port":9109,"wsPort":9110}
[INFO] [FileProcessAgent] FileProcessAgent API Gateway running {"port":9109}

# From service:
nexus-fileprocess          ClusterIP      10.43.32.130    <none>            9099/TCP,9100/TCP
```

### Impact
- **100% of API requests fail**
- Health checks fail
- Metrics scraping fails
- File upload endpoint unavailable
- Worker cannot communicate with API
- Complete service outage

### Fix Required
Choose ONE of the following approaches:

#### Option A: Update Service to Match Application (RECOMMENDED)
```yaml
# k8s/base/deployments/nexus-fileprocess.yaml
service:
  ports:
    - name: http
      port: 9109  # Change from 9099 to 9109
      targetPort: 9109
    - name: ws
      port: 9110  # Change from 9100 to 9110
      targetPort: 9110
```

####Option B: Update Application to Match Service
```typescript
// services/nexus-fileprocess/api/src/server.ts or config
const PORT = parseInt(process.env.PORT || '9099', 10);  // Change from 9109 to 9099
const WS_PORT = parseInt(process.env.WS_PORT || '9100', 10);  // Change from 9110 to 9100
```

### Testing After Fix
```bash
# Verify port configuration
k3s kubectl get svc -n nexus nexus-fileprocess -o yaml | grep -A5 "ports:"

# Test health endpoint
curl http://nexus-fileprocess:9109/health

# Test metrics endpoint
curl http://nexus-fileprocess:9109/metrics

# Check application logs for correct port
k3s kubectl logs -n nexus deployment/nexus-fileprocess | grep "port"
```

---

## Testing Status

| Test Category | Status | Pass | Fail | Notes |
|--------------|--------|------|------|-------|
| Phase 1: Health & Connectivity | 🔴 BLOCKED | 0 | 3 | Port mismatch blocks all tests |
| - API Health Endpoint | ❌ FAIL | | ✗ | Timeout due to port mismatch |
| - Metrics Endpoint | ❌ FAIL | | ✗ | Timeout due to port mismatch |
| - Pod Status | ✅ PASS | ✓ | | Pods running but unreachable |
| Phase 2-10 | ⏸️ BLOCKED | - | - | Cannot proceed until Issue #1 fixed |

---

## Next Steps

1. **IMMEDIATE**: Fix port mismatch (Issue #1)
2. Rebuild and redeploy affected services
3. Verify fix with health/metrics tests
4. Resume comprehensive E2E testing

---

## Additional Observations

### Working Components
- ✅ Pods are running and healthy
- ✅ No pod crash loops
- ✅ Application starts successfully
- ✅ MinIO connectivity confirmed in logs
- ✅ No obvious error messages in logs

### Blocked by Port Mismatch
- ❌ All HTTP API endpoints
- ❌ Health checks
- ❌ Metrics scraping
- ❌ File upload functionality
- ❌ Status queries
- ❌ Any external access to API

---

## Deployment Configuration Review Needed

The port mismatch suggests a configuration drift between:
1. Application source code (hardcoded or environment variables)
2. Kubernetes service definitions
3. Istio virtual service routing

**Action Required**: Audit all port configurations across:
- `services/nexus-fileprocess/api/src/server.ts`
- `services/nexus-fileprocess/api/src/config.ts`
- `k8s/base/deployments/nexus-fileprocess.yaml`
- `k8s/base/services/nexus-fileprocess.yaml`
- `k8s/base/istio/*-virtualservice.yaml`
- Environment variables in deployments

