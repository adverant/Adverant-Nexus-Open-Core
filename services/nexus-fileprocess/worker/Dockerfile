# FileProcessAgent Worker Dockerfile
#
# Multi-stage build for Go worker with Tesseract OCR.
# Follows the same pattern as other Brain Stack services.
#
# Build: docker build -t adverant/fileprocess-agent-worker:latest -f services/nexus-fileprocess/worker/Dockerfile .
# Run: docker run --env-file .env.nexus adverant/fileprocess-agent-worker:latest

# Stage 1: Build stage
FROM --platform=linux/amd64 golang:1.21-alpine AS builder

# Install build dependencies (including g++ and OCR libraries for gosseract)
RUN apk add --no-cache git make gcc g++ musl-dev \
    tesseract-ocr-dev leptonica-dev pkgconfig

# Set working directory
WORKDIR /app

# Copy go mod files
COPY services/nexus-fileprocess/worker/go.mod services/nexus-fileprocess/worker/go.sum* ./

# Download dependencies
RUN go mod download

# Copy source code
COPY services/nexus-fileprocess/worker/ ./

# Build the worker
RUN CGO_ENABLED=1 GOOS=linux go build -a -installsuffix cgo -o worker ./cmd/worker

# Stage 2: Production stage
FROM --platform=linux/amd64 alpine:latest

# Install runtime dependencies
RUN apk add --no-cache \
    ca-certificates \
    tesseract-ocr \
    tesseract-ocr-data-eng \
    libc6-compat \
    dumb-init

# Create non-root user
RUN addgroup -g 1001 -S worker && \
    adduser -S worker -u 1001

# Set working directory
WORKDIR /app

# Create temp directory for file processing
RUN mkdir -p /tmp/fileprocess && \
    chown -R worker:worker /tmp/fileprocess

# Copy built binary from builder stage
COPY --from=builder --chown=worker:worker /app/worker ./worker

# Switch to non-root user
USER worker

# Health check (checks if binary is running)
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD pgrep -f worker || exit 1

# Use dumb-init to handle signals properly
ENTRYPOINT ["dumb-init", "--"]

# Start the worker
CMD ["./worker"]
