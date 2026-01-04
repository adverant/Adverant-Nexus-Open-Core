# FileProcessAgent Deployment Guide

Complete guide for deploying FileProcessAgent in development, staging, and production environments.

## Table of Contents

- [Prerequisites](#prerequisites)
- [Environment Variables](#environment-variables)
- [Docker Deployment](#docker-deployment)
- [Kubernetes Deployment](#kubernetes-deployment)
- [Monitoring Setup](#monitoring-setup)
- [Scaling Guide](#scaling-guide)
- [Troubleshooting](#troubleshooting)
- [Security Best Practices](#security-best-practices)

---

## Prerequisites

### Required Services

1. **PostgreSQL 14+**
   - Database: `unified_nexus`
   - Schema: `fileprocess`
   - Required tables: `processing_jobs`, `document_dna`
   - Connection pooling: 10-50 connections

2. **Redis 6+**
   - Used for job queue (LIST operations)
   - Persistence: RDB + AOF recommended
   - Memory: 1-4GB depending on queue size

3. **MageAgent Service**
   - Vision AI API (OCR, table extraction)
   - Required for high-accuracy document processing
   - Endpoint: `http://nexus-mageagent:8080`

4. **GraphRAG Service**
   - Document storage and semantic search
   - Required for Document DNA storage
   - Endpoint: `http://nexus-graphrag:8090`

5. **VoyageAI API**
   - Embedding generation (voyage-3 model)
   - API key required
   - Rate limits: Check VoyageAI dashboard

### Optional Services

- **LearningAgent**: Progressive learning system
- **Prometheus**: Metrics collection
- **Grafana**: Metrics visualization
- **Jaeger/Tempo**: Distributed tracing
- **Google Drive**: Large file storage (5GB+ files)

### System Requirements

#### API Service (Node.js)
- **CPU**: 2-4 cores (4+ for production)
- **Memory**: 2-4GB (4-8GB for production)
- **Disk**: 10GB (for temporary file storage)
- **Network**: 1Gbps

#### Worker Service (Go)
- **CPU**: 4-8 cores (document processing is CPU-intensive)
- **Memory**: 4-8GB (for large document processing)
- **Disk**: 20-50GB (for temporary file processing)
- **Network**: 1Gbps (for downloading documents)

---

## Environment Variables

### Core Configuration

```bash
# Node.js API Service
NODE_ENV=production                    # Environment: development, staging, production
PORT=8096                              # HTTP API port
WS_PORT=8098                           # WebSocket port
LOG_LEVEL=info                         # Logging: debug, info, warn, error

# Database Connections
DATABASE_URL=postgresql://user:pass@postgres:5432/unified_nexus
REDIS_URL=redis://nexus-redis:6379

# Nexus Stack Services
GRAPHRAG_URL=http://nexus-graphrag:8090
MAGEAGENT_URL=http://nexus-mageagent:8080
LEARNINGAGENT_URL=http://nexus-learningagent:8097
SANDBOX_URL=http://nexus-sandbox:9095

# API Keys
VOYAGEAI_API_KEY=your_voyageai_api_key_here
OPENROUTER_API_KEY=your_openrouter_api_key_here  # For MageAgent vision models

# CORS Configuration
ALLOWED_ORIGINS=https://app.example.com,https://staging.example.com

# File Processing
MAX_FILE_SIZE=5368709120              # 5GB in bytes
CHUNK_SIZE=65536                      # 64KB chunks
PROCESSING_TIMEOUT=300000             # 5 minutes
WORKER_CONCURRENCY=10                 # Number of concurrent workers

# Google Drive (Optional, for large files)
GOOGLE_CLIENT_ID=your_client_id
GOOGLE_CLIENT_SECRET=your_client_secret
GOOGLE_SERVICE_ACCOUNT_EMAIL=service-account@project.iam.gserviceaccount.com
GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\n..."
GOOGLE_DRIVE_FOLDER_ID=folder_id_from_drive_url
BUFFER_THRESHOLD_MB=10                # Files > 10MB uploaded to Drive
```

### Monitoring & Observability

```bash
# Prometheus Metrics
PROMETHEUS_ENABLED=true               # Enable metrics collection
METRICS_PORT=8096                     # Metrics exposed at /metrics

# OpenTelemetry Tracing
OTEL_ENABLED=true                     # Enable distributed tracing
OTEL_EXPORTER_OTLP_ENDPOINT=http://jaeger:4318/v1/traces
OTEL_SERVICE_NAME=fileprocess-agent
OTEL_SERVICE_VERSION=1.0.0
OTEL_TRACES_SAMPLER=traceidratio     # Sampling strategy
OTEL_TRACES_SAMPLER_ARG=0.1          # 10% sampling rate
```

---

## Docker Deployment

### Using Docker Compose (Recommended)

#### 1. Update `docker-compose.nexus.yml`

```yaml
services:
  fileprocess-api:
    image: adverant/fileprocess-agent-api:latest
    container_name: nexus-fileprocess-api
    environment:
      NODE_ENV: production
      PORT: 8096
      WS_PORT: 8098
      DATABASE_URL: postgresql://postgres:${POSTGRES_PASSWORD}@nexus-postgres:5432/unified_nexus
      REDIS_URL: redis://nexus-redis:6379
      GRAPHRAG_URL: http://nexus-graphrag:8090
      MAGEAGENT_URL: http://nexus-mageagent:8080
      VOYAGEAI_API_KEY: ${VOYAGEAI_API_KEY}
      ALLOWED_ORIGINS: ${ALLOWED_ORIGINS}
      OTEL_EXPORTER_OTLP_ENDPOINT: http://jaeger:4318/v1/traces
    ports:
      - "8096:8096"
      - "8098:8098"
    networks:
      - nexus-network
    depends_on:
      - postgres
      - redis
      - graphrag
      - mageagent
    restart: unless-stopped
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:8096/health"]
      interval: 30s
      timeout: 10s
      retries: 3
      start_period: 60s

  fileprocess-worker:
    image: adverant/fileprocess-agent-worker:latest
    container_name: nexus-fileprocess-worker
    environment:
      REDIS_URL: redis://nexus-redis:6379
      POSTGRES_URL: postgresql://postgres:${POSTGRES_PASSWORD}@nexus-postgres:5432/unified_nexus
      MAGEAGENT_URL: http://nexus-mageagent:8080
      GRAPHRAG_URL: http://nexus-graphrag:8090
      VOYAGEAI_API_KEY: ${VOYAGEAI_API_KEY}
      WORKER_CONCURRENCY: 10
    networks:
      - nexus-network
    depends_on:
      - postgres
      - redis
      - mageagent
      - graphrag
    restart: unless-stopped
    deploy:
      replicas: 2  # Scale horizontally for throughput
```

#### 2. Start Services

```bash
# Create .env file with secrets
cat > .env.nexus <<EOF
POSTGRES_PASSWORD=your_secure_password
VOYAGEAI_API_KEY=your_voyageai_key
ALLOWED_ORIGINS=https://app.example.com
EOF

# Start services
docker-compose -f docker/docker-compose.nexus.yml up -d

# Check status
docker-compose -f docker/docker-compose.nexus.yml ps

# View logs
docker-compose -f docker/docker-compose.nexus.yml logs -f fileprocess-api
docker-compose -f docker/docker-compose.nexus.yml logs -f fileprocess-worker
```

#### 3. Initialize Database Schema

```bash
# Run database migrations
docker exec nexus-postgres psql -U postgres -d unified_nexus -f /docker-entrypoint-initdb.d/init-fileprocess.sql

# Verify tables created
docker exec nexus-postgres psql -U postgres -d unified_nexus -c "\dt fileprocess.*"
```

---

## Kubernetes Deployment

### 1. Create Namespace

```yaml
apiVersion: v1
kind: Namespace
metadata:
  name: nexus
```

### 2. Create Secrets

```yaml
apiVersion: v1
kind: Secret
metadata:
  name: fileprocess-secrets
  namespace: nexus
type: Opaque
stringData:
  database-url: postgresql://user:pass@postgres:5432/unified_nexus
  redis-url: redis://redis:6379
  voyageai-api-key: your_voyageai_api_key_here
  openrouter-api-key: your_openrouter_api_key_here
  google-service-account-key: |
    {
      "type": "service_account",
      "project_id": "your-project",
      ...
    }
```

### 3. API Deployment

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: fileprocess-api
  namespace: nexus
spec:
  replicas: 3
  selector:
    matchLabels:
      app: fileprocess-api
  template:
    metadata:
      labels:
        app: fileprocess-api
    spec:
      containers:
      - name: api
        image: adverant/fileprocess-agent-api:latest
        ports:
        - containerPort: 8096
          name: http
        - containerPort: 8098
          name: websocket
        env:
        - name: NODE_ENV
          value: "production"
        - name: PORT
          value: "8096"
        - name: WS_PORT
          value: "8098"
        - name: DATABASE_URL
          valueFrom:
            secretKeyRef:
              name: fileprocess-secrets
              key: database-url
        - name: REDIS_URL
          valueFrom:
            secretKeyRef:
              name: fileprocess-secrets
              key: redis-url
        - name: VOYAGEAI_API_KEY
          valueFrom:
            secretKeyRef:
              name: fileprocess-secrets
              key: voyageai-api-key
        - name: GRAPHRAG_URL
          value: "http://graphrag:8090"
        - name: MAGEAGENT_URL
          value: "http://mageagent:8080"
        resources:
          requests:
            cpu: 2000m
            memory: 4Gi
          limits:
            cpu: 4000m
            memory: 8Gi
        livenessProbe:
          httpGet:
            path: /health
            port: 8096
          initialDelaySeconds: 60
          periodSeconds: 30
          timeoutSeconds: 10
        readinessProbe:
          httpGet:
            path: /health/ready
            port: 8096
          initialDelaySeconds: 30
          periodSeconds: 10
          timeoutSeconds: 5
```

### 4. Worker Deployment

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: fileprocess-worker
  namespace: nexus
spec:
  replicas: 5  # Scale based on load
  selector:
    matchLabels:
      app: fileprocess-worker
  template:
    metadata:
      labels:
        app: fileprocess-worker
    spec:
      containers:
      - name: worker
        image: adverant/fileprocess-agent-worker:latest
        env:
        - name: REDIS_URL
          valueFrom:
            secretKeyRef:
              name: fileprocess-secrets
              key: redis-url
        - name: POSTGRES_URL
          valueFrom:
            secretKeyRef:
              name: fileprocess-secrets
              key: database-url
        - name: WORKER_CONCURRENCY
          value: "10"
        resources:
          requests:
            cpu: 4000m
            memory: 8Gi
          limits:
            cpu: 8000m
            memory: 16Gi
```

### 5. Service & Ingress

```yaml
---
apiVersion: v1
kind: Service
metadata:
  name: fileprocess-api
  namespace: nexus
spec:
  type: ClusterIP
  ports:
  - name: http
    port: 8096
    targetPort: 8096
  - name: websocket
    port: 8098
    targetPort: 8098
  selector:
    app: fileprocess-api

---
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: fileprocess-api
  namespace: nexus
  annotations:
    cert-manager.io/cluster-issuer: letsencrypt-prod
    nginx.ingress.kubernetes.io/proxy-body-size: "5g"
spec:
  tls:
  - hosts:
    - api.example.com
    secretName: fileprocess-tls
  rules:
  - host: api.example.com
    http:
      paths:
      - path: /fileprocess
        pathType: Prefix
        backend:
          service:
            name: fileprocess-api
            port:
              number: 8096
```

---

## Monitoring Setup

### Prometheus Configuration

```yaml
# prometheus.yml
scrape_configs:
  - job_name: 'fileprocess-api'
    scrape_interval: 15s
    kubernetes_sd_configs:
    - role: pod
      namespaces:
        names:
        - nexus
    relabel_configs:
    - source_labels: [__meta_kubernetes_pod_label_app]
      action: keep
      regex: fileprocess-api
    - source_labels: [__meta_kubernetes_pod_ip]
      action: replace
      target_label: __address__
      replacement: $1:8096
    - source_labels: [__meta_kubernetes_pod_name]
      action: replace
      target_label: pod
    metrics_path: /metrics
```

### Grafana Dashboard

Import dashboard from JSON:

```json
{
  "dashboard": {
    "title": "FileProcessAgent",
    "panels": [
      {
        "title": "Request Rate",
        "targets": [
          {
            "expr": "rate(fileprocess_http_requests_total[5m])"
          }
        ]
      },
      {
        "title": "Request Latency (p95)",
        "targets": [
          {
            "expr": "histogram_quantile(0.95, rate(fileprocess_http_request_duration_seconds_bucket[5m]))"
          }
        ]
      },
      {
        "title": "Active Jobs",
        "targets": [
          {
            "expr": "fileprocess_active_jobs"
          }
        ]
      },
      {
        "title": "MageAgent API Latency",
        "targets": [
          {
            "expr": "histogram_quantile(0.95, rate(fileprocess_mageagent_call_duration_seconds_bucket[5m]))"
          }
        ]
      }
    ]
  }
}
```

### Jaeger Tracing Setup

```yaml
# Jaeger all-in-one deployment
apiVersion: apps/v1
kind: Deployment
metadata:
  name: jaeger
  namespace: nexus
spec:
  replicas: 1
  selector:
    matchLabels:
      app: jaeger
  template:
    metadata:
      labels:
        app: jaeger
    spec:
      containers:
      - name: jaeger
        image: jaegertracing/all-in-one:latest
        ports:
        - containerPort: 5775  # Zipkin compact
        - containerPort: 6831  # Jaeger compact
        - containerPort: 6832  # Jaeger binary
        - containerPort: 5778  # Config
        - containerPort: 16686 # UI
        - containerPort: 4317  # OTLP gRPC
        - containerPort: 4318  # OTLP HTTP
        env:
        - name: COLLECTOR_OTLP_ENABLED
          value: "true"
```

---

## Scaling Guide

### Horizontal Scaling

#### API Service
```bash
# Kubernetes
kubectl scale deployment fileprocess-api --replicas=5 -n nexus

# Docker Compose
docker-compose -f docker-compose.yml up -d --scale fileprocess-api=5
```

**Scaling Guidelines**:
- **Light load** (< 10 req/s): 1-2 replicas
- **Medium load** (10-50 req/s): 3-5 replicas
- **Heavy load** (50+ req/s): 5-10 replicas

#### Worker Service
```bash
# Kubernetes
kubectl scale deployment fileprocess-worker --replicas=10 -n nexus

# Docker Compose
docker-compose -f docker-compose.yml up -d --scale fileprocess-worker=10
```

**Scaling Guidelines**:
- **Light load** (< 10 docs/min): 2-3 workers
- **Medium load** (10-50 docs/min): 5-10 workers
- **Heavy load** (50+ docs/min): 10-20 workers

### Vertical Scaling

#### Increase Resources

```yaml
resources:
  requests:
    cpu: 4000m      # 4 cores
    memory: 8Gi     # 8GB
  limits:
    cpu: 8000m      # 8 cores
    memory: 16Gi    # 16GB
```

### Autoscaling

```yaml
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: fileprocess-api-hpa
  namespace: nexus
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: fileprocess-api
  minReplicas: 3
  maxReplicas: 10
  metrics:
  - type: Resource
    resource:
      name: cpu
      target:
        type: Utilization
        averageUtilization: 70
  - type: Resource
    resource:
      name: memory
      target:
        type: Utilization
        averageUtilization: 80
```

---

## Troubleshooting

### Common Issues

#### 1. "Job not found" (404 errors)

**Symptom**: GET /jobs/:id returns 404
**Cause**: Queue inconsistency (fixed in Phase 1)
**Solution**: Ensure using latest version with JobRepository

```bash
# Check version
curl http://localhost:8096/ | jq .version

# Should be 1.0.1-enterprise-routing or later
```

#### 2. Worker not processing jobs

**Symptoms**:
- Jobs stuck in "queued" status
- Worker logs show no activity

**Diagnosis**:
```bash
# Check worker logs
docker logs nexus-fileprocess-worker

# Check Redis queue
docker exec nexus-redis redis-cli LLEN fileprocess:jobs

# Check worker connectivity
docker exec nexus-fileprocess-worker ping nexus-redis
```

**Solutions**:
- Restart worker service
- Verify Redis connectivity
- Check WORKER_CONCURRENCY setting

#### 3. Out of Memory errors

**Symptoms**:
- Worker crashes
- "JavaScript heap out of memory"

**Solutions**:
```bash
# Increase Node.js heap size (API)
NODE_OPTIONS="--max-old-space-size=8192"  # 8GB

# Increase worker memory (Kubernetes)
kubectl set resources deployment fileprocess-worker --limits=memory=16Gi
```

#### 4. MageAgent API errors

**Symptoms**:
- Vision OCR fails
- Table extraction returns empty

**Diagnosis**:
```bash
# Test MageAgent connectivity
curl http://nexus-mageagent:8080/api/health

# Check API logs
kubectl logs -l app=mageagent -n nexus
```

---

## Security Best Practices

### 1. API Keys & Secrets

- **Never commit secrets** to Git
- Use environment variables or secret management
- Rotate API keys regularly (quarterly)
- Use separate keys for dev/staging/prod

### 2. Network Security

```yaml
# Kubernetes NetworkPolicy
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: fileprocess-api-policy
spec:
  podSelector:
    matchLabels:
      app: fileprocess-api
  policyTypes:
  - Ingress
  - Egress
  ingress:
  - from:
    - podSelector:
        matchLabels:
          app: ingress-nginx
    ports:
    - protocol: TCP
      port: 8096
  egress:
  - to:
    - podSelector:
        matchLabels:
          app: postgres
    ports:
    - protocol: TCP
      port: 5432
```

### 3. CORS Configuration

```bash
# Production: Explicit origins only
ALLOWED_ORIGINS=https://app.example.com,https://admin.example.com

# Never use wildcard (*) in production
```

### 4. HTTPS/TLS

- **Always use HTTPS** in production
- Use Let's Encrypt for certificates
- Enable HSTS headers
- Set minimum TLS 1.2

### 5. Rate Limiting

```typescript
// Add rate limiting middleware
import rateLimit from 'express-rate-limit';

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // 100 requests per window
});

app.use('/fileprocess/api', limiter);
```

---

## Production Checklist

- [ ] PostgreSQL configured with replication
- [ ] Redis configured with persistence (RDB + AOF)
- [ ] All environment variables set correctly
- [ ] CORS configured with explicit origins
- [ ] HTTPS/TLS enabled
- [ ] Health checks configured
- [ ] Monitoring (Prometheus + Grafana) set up
- [ ] Distributed tracing (Jaeger) configured
- [ ] Log aggregation configured
- [ ] Backup strategy defined
- [ ] Disaster recovery plan documented
- [ ] Rate limiting enabled
- [ ] API keys rotated
- [ ] Security scan completed
- [ ] Load testing completed
- [ ] Documentation updated

---

## Support

For issues and questions:
- GitHub: https://github.com/adverant-ai/adverant-Nexus
- Email: support@adverant.com
- Docs: https://docs.adverant.com
