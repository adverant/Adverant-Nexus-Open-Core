# Advanced Layered Docker Build Strategy for GraphRAG

## Overview
This document outlines an optimized Docker build strategy that maximizes cache efficiency, reduces build times, and enables rapid deployment of fixes.

## Multi-Stage Build Architecture

### Stage 1: Base Dependencies Layer
- **Purpose**: Install system dependencies that rarely change
- **Cache Key**: System packages
- **Invalidation**: Only when base image or system deps change

### Stage 2: Package Dependencies Layer
- **Purpose**: Install Node.js dependencies
- **Cache Key**: package.json + package-lock.json
- **Invalidation**: Only when dependencies change

### Stage 3: Build Tools Layer
- **Purpose**: TypeScript compilation and build tools
- **Cache Key**: TypeScript config + build scripts
- **Invalidation**: When build configuration changes

### Stage 4: Source Code Layer
- **Purpose**: Application source code
- **Cache Key**: Source files
- **Invalidation**: When code changes

### Stage 5: Runtime Layer
- **Purpose**: Minimal production runtime
- **Cache Key**: Production dependencies only
- **Invalidation**: When runtime deps change

## Implementation Strategy

### 1. Dependency Hash-Based Caching
```dockerfile
# Create hash of dependencies for cache invalidation
COPY package*.json /tmp/
RUN md5sum /tmp/package*.json > /tmp/deps.hash
```

### 2. Layer Ordering Optimization
- Place least-changing layers first
- System dependencies → NPM packages → Build tools → Source code

### 3. Build Cache Mount Points
```dockerfile
# Use BuildKit cache mounts
RUN --mount=type=cache,target=/root/.npm \
    npm ci --only=production
```

### 4. Multi-Architecture Support
```dockerfile
# Support ARM64 and AMD64
FROM --platform=$BUILDPLATFORM node:20-alpine AS builder
```

### 5. Development vs Production Builds
- Separate Dockerfiles for dev and prod
- Shared base stages
- Different final stages

## Benefits

1. **Faster Builds**: Only rebuild changed layers
2. **Smaller Images**: Multi-stage builds remove build deps
3. **Better Caching**: Intelligent layer ordering
4. **Easy Hotfixes**: Code changes don't invalidate dep layers
5. **Parallel Builds**: Independent stages can build concurrently

## Cache Invalidation Strategy

### Level 1: System Dependencies
- Triggered by: Base image updates, system package changes
- Frequency: Monthly

### Level 2: NPM Dependencies
- Triggered by: package.json changes
- Frequency: Weekly

### Level 3: Build Configuration
- Triggered by: tsconfig.json, webpack config changes
- Frequency: Bi-weekly

### Level 4: Source Code
- Triggered by: Any source file change
- Frequency: Multiple times daily

## CI/CD Integration

### GitHub Actions Cache
```yaml
- uses: docker/build-push-action@v5
  with:
    cache-from: type=gha
    cache-to: type=gha,mode=max
```

### Registry-Based Caching
```yaml
cache-from: |
  type=registry,ref=myregistry.com/myapp:buildcache
cache-to: |
  type=registry,ref=myregistry.com/myapp:buildcache,mode=max
```

## Monitoring and Metrics

1. **Build Time Tracking**: Monitor each stage's build time
2. **Cache Hit Rate**: Track cache effectiveness
3. **Image Size**: Monitor final image sizes
4. **Layer Count**: Keep under Docker's layer limit

## Best Practices

1. **Pin Base Images**: Use specific tags, not `latest`
2. **Minimize Layers**: Combine related RUN commands
3. **Clean as You Go**: Remove temp files in same layer
4. **Use .dockerignore**: Exclude unnecessary files
5. **Health Checks**: Include proper health check commands
6. **Security Scanning**: Scan layers for vulnerabilities

## Emergency Hotfix Process

1. **Code-Only Fix**:
   - Only final layers rebuild
   - Deploy in < 2 minutes

2. **Dependency Update**:
   - Middle layers rebuild
   - Deploy in < 5 minutes

3. **System Update**:
   - Full rebuild required
   - Deploy in < 10 minutes