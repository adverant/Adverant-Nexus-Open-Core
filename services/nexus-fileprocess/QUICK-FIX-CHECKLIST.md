# FileProcessAgent - Quick Fix Checklist

**Priority**: CRITICAL
**Estimated Time**: 3.5 hours for Phase 1 fixes
**Success Criteria**: Zero HTTP 500 errors, 100% test pass rate

---

## 🚨 Critical Errors (Fix Today)

### Error #1: Empty PDF Returns HTTP 500
- **File**: `services/nexus-fileprocess/api/src/routes/process.routes.ts`
- **Line**: Queue submission section
- **Fix**: Add validation before queuing

```typescript
// Add before jobRepository.submitJob()
if (!fileBuffer || fileBuffer.length === 0) {
  return res.status(422).json({
    success: false,
    error: 'Empty file',
    message: 'File contains no data'
  });
}

if (mimeType === 'application/pdf' && fileBuffer.length < 100) {
  return res.status(422).json({
    success: false,
    error: 'Invalid PDF',
    message: 'PDF file is too small or corrupted'
  });
}
```

**Test**:
```bash
curl -X POST http://10.43.32.130:9099/fileprocess/api/process \
  -F "file=@empty.pdf" -F "userId=test"
# Should return HTTP 422, not HTTP 500
```

---

### Error #2: Disguised Binary Returns HTTP 500
- **File**: `services/nexus-fileprocess/api/src/routes/process.routes.ts`
- **Line**: Before queue submission
- **Fix**: Add MIME type whitelist validation

```typescript
// Install dependency first:
// npm install file-type@18.7.0

import { fromBuffer } from 'file-type';

const SUPPORTED_MIME_TYPES = [
  'application/pdf',
  'image/png',
  'image/jpeg',
  'text/plain'
];

// Before queuing:
const detected = await fromBuffer(fileBuffer);
const mimeType = detected?.mime || 'application/octet-stream';

if (!SUPPORTED_MIME_TYPES.includes(mimeType)) {
  return res.status(422).json({
    success: false,
    error: 'Unsupported file format',
    message: `File type ${mimeType} is not supported`
  });
}
```

**Test**:
```bash
dd if=/dev/urandom of=fake.txt bs=1K count=5
curl -X POST http://10.43.32.130:9099/fileprocess/api/process \
  -F "file=@fake.txt" -F "userId=test"
# Should return HTTP 422, not HTTP 500
```

---

### Error #3: Try-Catch Missing
- **File**: `services/nexus-fileprocess/api/src/routes/process.routes.ts`
- **Line**: Wrap entire route handler
- **Fix**: Add comprehensive error handling

```typescript
router.post('/process', upload.single('file'), async (req, res) => {
  try {
    // All existing code here...

  } catch (error) {
    logger.error('Processing failed', {
      error: error.message,
      filename: req.file?.originalname
    });

    if (error instanceof ValidationError) {
      return res.status(422).json({
        success: false,
        error: 'Validation failed',
        message: error.message
      });
    }

    res.status(500).json({
      success: false,
      error: 'Internal server error',
      message: 'Failed to queue document',
      requestId: uuidv4()
    });
  }
});
```

---

## ⏱️ Performance Issue (Fix This Week)

### Issue: 30-60 Second Delays for Invalid Files

**Current Behavior**:
- Invalid files are queued → worker processes → timeout → return error
- Takes 30-60 seconds per invalid file

**Fix**: Validate BEFORE queuing (saves 30-60 seconds)

```typescript
// Move validation BEFORE jobRepository.submitJob()
// Order:
// 1. Check file exists
// 2. Check file not empty
// 3. Detect MIME type
// 4. Validate MIME type (BEFORE queuing!)
// 5. Queue job (only if validation passes)

// Result: Invalid files rejected in <1 second
```

---

## 📝 Deployment Checklist

### Before Deployment
- [ ] Install `file-type` dependency: `npm install file-type@18.7.0`
- [ ] Update `process.routes.ts` with validation code
- [ ] Add try-catch error handling
- [ ] Test locally with edge cases
- [ ] Run full test suite: `./test-edge-cases.sh all`

### Deployment Steps
```bash
# 1. Build updated API
cd services/nexus-fileprocess/api
npm install
npm run build

# 2. Copy to production server
scp -r dist root@157.173.102.118:/opt/adverant-nexus/services/nexus-fileprocess/api/

# 3. Restart service on server
ssh root@157.173.102.118
k3s kubectl rollout restart deployment/nexus-fileprocess -n nexus

# 4. Verify deployment
k3s kubectl get pods -n nexus | grep fileprocess
# Wait for Running status

# 5. Test health
curl http://10.43.32.130:9099/health
```

### After Deployment
- [ ] Run test suite: `./test-edge-cases.sh all`
- [ ] Check error logs: `k3s kubectl logs -n nexus deployment/nexus-fileprocess --tail=100`
- [ ] Monitor error rate in next 24 hours
- [ ] Verify no HTTP 500 errors

---

## 🧪 Quick Validation Tests

```bash
# SSH to production
ssh root@157.173.102.118
export API_URL="http://10.43.32.130:9099"

# Test 1: Empty file (should be HTTP 422, not 500)
echo "" > /tmp/empty.txt
curl -X POST $API_URL/fileprocess/api/process \
  -F "file=@/tmp/empty.txt" -F "userId=test"

# Test 2: Binary file (should be HTTP 422, <1 sec)
dd if=/dev/urandom of=/tmp/binary.bin bs=1K count=10 2>/dev/null
time curl -X POST $API_URL/fileprocess/api/process \
  -F "file=@/tmp/binary.bin" -F "userId=test"

# Test 3: Disguised binary (should be HTTP 422, not 500)
dd if=/dev/urandom of=/tmp/fake.txt bs=1K count=5 2>/dev/null
curl -X POST $API_URL/fileprocess/api/process \
  -F "file=@/tmp/fake.txt" -F "userId=test"

# All should return HTTP 422, none should return HTTP 500
```

---

## 📊 Success Metrics

**Before Fix**:
- ❌ HTTP 500 errors: 2 out of 8 tests (25% failure rate)
- ❌ Invalid file rejection time: 30-60 seconds
- ❌ Test success rate: 87.5%

**After Fix (Expected)**:
- ✅ HTTP 500 errors: 0 (0% failure rate)
- ✅ Invalid file rejection time: <1 second
- ✅ Test success rate: 100%

---

## 🔍 Files to Modify

1. **services/nexus-fileprocess/api/src/routes/process.routes.ts**
   - Add file-type import
   - Add MIME type whitelist
   - Add validation before queuing
   - Add try-catch wrapper

2. **services/nexus-fileprocess/api/package.json**
   - Add: `"file-type": "^18.7.0"`

3. **Optional: services/nexus-fileprocess/worker/internal/processor/processor.go**
   - Add fast-fail validation (Phase 2)

---

## 💡 Quick Tips

1. **Test locally first**: Don't deploy untested code to production
2. **Deploy during low traffic**: Minimize impact on users
3. **Monitor logs**: Watch for any unexpected errors post-deployment
4. **Keep rollback plan**: Be ready to revert if issues arise
5. **Update docs**: Document new supported formats

---

## 🆘 If Something Goes Wrong

### Rollback Procedure
```bash
ssh root@157.173.102.118

# Rollback to previous version
k3s kubectl rollout undo deployment/nexus-fileprocess -n nexus

# Verify rollback
k3s kubectl get pods -n nexus | grep fileprocess
curl http://10.43.32.130:9099/health
```

### Emergency Contacts
- Check logs: `k3s kubectl logs -n nexus deployment/nexus-fileprocess`
- Check pods: `k3s kubectl describe pod -n nexus <pod-name>`
- Check events: `k3s kubectl get events -n nexus --sort-by='.lastTimestamp'`

---

## ✅ Definition of Done

- [ ] No HTTP 500 errors in test suite
- [ ] All validation errors return HTTP 422
- [ ] Invalid files rejected in <1 second
- [ ] Test suite passes 100%
- [ ] Production logs show no errors
- [ ] Documentation updated
- [ ] Team notified of changes

---

**Estimated Time**: 3.5 hours
**Risk Level**: Low (validation changes only)
**Rollback Time**: <5 minutes
**Impact**: High (eliminates critical errors)
