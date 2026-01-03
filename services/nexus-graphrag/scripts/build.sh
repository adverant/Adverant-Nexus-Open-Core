#!/bin/bash
# Advanced build script with caching and layer optimization

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Configuration
REGISTRY="${REGISTRY:-localhost:32000}"
PROJECT="graphrag"
VERSION="${VERSION:-$(git describe --tags --always --dirty 2>/dev/null || echo 'dev')}"
BUILD_TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

# Build arguments
BUILD_ARGS=(
    --build-arg "GIT_COMMIT=$(git rev-parse --short HEAD 2>/dev/null || echo 'unknown')"
    --build-arg "BUILD_TIMESTAMP=${BUILD_TIMESTAMP}"
    --build-arg "VERSION=${VERSION}"
)

# Enable Docker BuildKit
export DOCKER_BUILDKIT=1
export COMPOSE_DOCKER_CLI_BUILD=1

echo -e "${BLUE}🔨 GraphRAG Advanced Build System${NC}"
echo -e "${BLUE}================================${NC}"
echo -e "Registry: ${REGISTRY}"
echo -e "Version: ${VERSION}"
echo -e "Timestamp: ${BUILD_TIMESTAMP}"
echo ""

# Function to build with caching
build_with_cache() {
    local target=$1
    local tag=$2
    local extra_args=("${@:3}")

    echo -e "${YELLOW}Building ${target} stage...${NC}"

    docker buildx build \
        --file Dockerfile.optimized \
        --target "${target}" \
        --tag "${tag}" \
        --cache-from "type=registry,ref=${REGISTRY}/${PROJECT}:buildcache-${target}" \
        --cache-to "type=registry,ref=${REGISTRY}/${PROJECT}:buildcache-${target},mode=max" \
        --cache-from "type=registry,ref=${REGISTRY}/${PROJECT}:latest" \
        "${BUILD_ARGS[@]}" \
        "${extra_args[@]}" \
        --progress=plain \
        .
}

# Function to check if rebuild is needed
check_rebuild_needed() {
    local layer=$1
    local hash_files=("${@:2}")

    # Calculate hash of specified files
    local current_hash=$(cat "${hash_files[@]}" 2>/dev/null | md5sum | cut -d' ' -f1)
    local cache_file=".build-cache/${layer}.hash"

    # Create cache directory if not exists
    mkdir -p .build-cache

    # Check if hash has changed
    if [ -f "$cache_file" ]; then
        local cached_hash=$(cat "$cache_file")
        if [ "$current_hash" = "$cached_hash" ]; then
            echo -e "${GREEN}✓ ${layer} unchanged, using cache${NC}"
            return 1
        fi
    fi

    # Save new hash
    echo "$current_hash" > "$cache_file"
    return 0
}

# Parse command line arguments
BUILD_TYPE="${1:-production}"
PUSH_REGISTRY="${2:-false}"

case "$BUILD_TYPE" in
    "production"|"prod")
        echo -e "${BLUE}🚀 Building production image...${NC}"

        # Check each layer for changes
        if check_rebuild_needed "deps" package.json package-lock.json; then
            build_with_cache "package-deps" "${REGISTRY}/${PROJECT}:deps-cache"
        fi

        if check_rebuild_needed "build" tsconfig.json .eslintrc*; then
            build_with_cache "build-tools" "${REGISTRY}/${PROJECT}:build-cache"
        fi

        # Always rebuild source and final stages
        build_with_cache "production" "${REGISTRY}/${PROJECT}:${VERSION}" --push

        # Tag as latest
        docker tag "${REGISTRY}/${PROJECT}:${VERSION}" "${REGISTRY}/${PROJECT}:latest"

        if [ "$PUSH_REGISTRY" = "true" ]; then
            echo -e "${YELLOW}📤 Pushing to registry...${NC}"
            docker push "${REGISTRY}/${PROJECT}:latest"
        fi
        ;;

    "development"|"dev")
        echo -e "${BLUE}🔧 Building development image...${NC}"
        build_with_cache "development" "${PROJECT}:dev" --load
        ;;

    "test")
        echo -e "${BLUE}🧪 Building test image...${NC}"
        build_with_cache "test" "${PROJECT}:test" --load
        ;;

    "security")
        echo -e "${BLUE}🔒 Building with security scanning...${NC}"
        build_with_cache "security-scan" "${PROJECT}:security" --load

        # Run security scan
        echo -e "${YELLOW}Running security scan...${NC}"
        docker run --rm "${PROJECT}:security" npm audit --production
        ;;

    "all")
        echo -e "${BLUE}🌟 Building all targets...${NC}"
        $0 production
        $0 development
        $0 test
        ;;

    "clean")
        echo -e "${RED}🧹 Cleaning build cache...${NC}"
        rm -rf .build-cache
        docker buildx prune -f
        ;;

    *)
        echo -e "${RED}Usage: $0 {production|development|test|security|all|clean} [push]${NC}"
        exit 1
        ;;
esac

echo -e "${GREEN}✅ Build completed successfully!${NC}"

# Show image info
if [ "$BUILD_TYPE" != "clean" ]; then
    echo ""
    echo -e "${BLUE}📊 Image Information:${NC}"
    docker images | grep -E "(REPOSITORY|${PROJECT})" | head -5
fi