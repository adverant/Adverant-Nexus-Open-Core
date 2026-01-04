# Deprecated Files - FileProcess Worker

## Date: 2025-10-22

## Reason for Deprecation

These files have been deprecated as part of the MageAgent Vision Integration refactoring.
The goal was to **eliminate ALL hardcoded models** and delegate model selection to MageAgent service.

## Deprecated Files

### 1. `internal/processor/ocr_cascade.go` → `ocr_cascade.go.deprecated`
**Why:** This file contained hardcoded OpenRouter model selection logic that duplicated MageAgent's functionality.

**Replaced by:**
- `internal/clients/mageagent_client.go` - Delegates OCR to MageAgent
- `internal/processor/tesseract_ocr.go` - Simple Tesseract fallback

**Key Issues Fixed:**
- ❌ Hardcoded model names (gpt-4o, claude-3-opus, etc.)
- ❌ Hardcoded accuracy percentages (93%, 97%, etc.)
- ❌ Duplicated model selection logic from MageAgent
- ❌ No model health testing before use
- ❌ Required changes for every new vision model

**New Approach:**
- ✅ **Zero hardcoded models** - MageAgent selects dynamically
- ✅ **Single source of truth** - MageAgent orchestrates all AI operations
- ✅ **Automatic model updates** - New models available immediately
- ✅ **Model health testing** - MageAgent tests before assignment
- ✅ **Fallback chains** - Automatic failover to alternative models
- ✅ **Rate-limit exempt internal endpoint** - High throughput for microservices

### 2. `internal/clients/openrouter.go` → `openrouter.go.deprecated`
**Why:** Direct OpenRouter integration no longer needed. MageAgent handles all OpenRouter operations.

**Replaced by:**
- `internal/clients/mageagent_client.go` - Complete HTTP client for MageAgent API

**Key Issues Fixed:**
- ❌ Direct dependency on OpenRouter API
- ❌ Model selection logic duplicated in Go
- ❌ No integration with MageAgent's model tracking

**New Approach:**
- ✅ **Service-oriented architecture** - Go worker → MageAgent → OpenRouter
- ✅ **Consistent model selection** - Same logic used across all services
- ✅ **Better error handling** - MageAgent provides detailed error context
- ✅ **Centralized cost tracking** - All OpenRouter costs tracked in MageAgent

## Architecture Change

### Before (Hardcoded)
```
FileProcess Worker (Go)
    ├── OpenRouter Client (hardcoded models)
    ├── OCR Cascade (hardcoded tiers)
    └── Direct OpenRouter API calls
```

### After (Dynamic)
```
FileProcess Worker (Go)
    ├── MageAgent Client
    │   └── HTTP → MageAgent (TypeScript)
    │       └── Dynamic Model Selection
    │           ├── Tests model health
    │           ├── Tracks working/failed models
    │           ├── Automatic fallback chains
    │           └── OpenRouter API
    └── Tesseract (offline fallback)
```

## Migration Guide

If you need to reference the old implementation:

```bash
# View deprecated OCR cascade
git show HEAD:services/fileprocess-agent/worker/internal/processor/ocr_cascade.go

# View deprecated OpenRouter client
git show HEAD:services/fileprocess-agent/worker/internal/clients/openrouter.go
```

## Related Documentation

- `/MAGEAGENT_VISION_INTEGRATION.md` - Complete integration documentation
- `/FILEPROCESSAGENT_DEPLOYMENT_STATUS.md` - Deployment status

## Future Cleanup

These `.deprecated` files can be deleted after:
1. Integration testing confirms MageAgent OCR works correctly
2. Production deployment validates no regressions
3. All team members are aware of the architecture change

Estimated safe deletion date: **2025-11-22** (30 days from deprecation)
