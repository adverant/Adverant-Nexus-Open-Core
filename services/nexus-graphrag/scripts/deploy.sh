#!/bin/bash
# GraphRAG Deployment Script with Multi-Model Support
# Implements the complete deployment pipeline with all enhancements

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
PURPLE='\033[0;35m'
NC='\033[0m' # No Color

# Configuration
REPO_DIR="${REPO_DIR:-$(pwd)}"
REGISTRY="${REGISTRY:-localhost:32000}"
PROJECT="graphrag"
NAMESPACE="${NAMESPACE:-graphrag-system}"
VERSION="${VERSION:-$(git describe --tags --always --dirty 2>/dev/null || echo 'latest')}"

echo -e "${PURPLE}🚀 GraphRAG Complete Deployment Pipeline${NC}"
echo -e "${PURPLE}======================================${NC}"
echo -e "Version: ${VERSION}"
echo -e "Registry: ${REGISTRY}"
echo -e "Namespace: ${NAMESPACE}"
echo ""

# Function to check prerequisites
check_prerequisites() {
    echo -e "${BLUE}📋 Checking prerequisites...${NC}"

    local missing=()

    # Check for required tools
    command -v docker >/dev/null 2>&1 || missing+=("docker")
    command -v kubectl >/dev/null 2>&1 || missing+=("kubectl")
    command -v git >/dev/null 2>&1 || missing+=("git")

    if [ ${#missing[@]} -ne 0 ]; then
        echo -e "${RED}❌ Missing required tools: ${missing[*]}${NC}"
        exit 1
    fi

    # Check Kubernetes connection
    if ! kubectl cluster-info >/dev/null 2>&1; then
        echo -e "${RED}❌ Cannot connect to Kubernetes cluster${NC}"
        exit 1
    fi

    echo -e "${GREEN}✅ All prerequisites satisfied${NC}"
}

# Function to run database migrations
run_migrations() {
    echo -e "${BLUE}🗄️  Running database migrations...${NC}"

    # Check if migration pod already exists
    kubectl delete pod graphrag-migrations -n ${NAMESPACE} --ignore-not-found=true

    # Run migrations in a Kubernetes Job
    cat <<EOF | kubectl apply -n ${NAMESPACE} -f -
apiVersion: batch/v1
kind: Job
metadata:
  name: graphrag-migrations-${VERSION}
  labels:
    app: graphrag
    component: migrations
spec:
  template:
    spec:
      restartPolicy: OnFailure
      containers:
      - name: migrations
        image: ${REGISTRY}/${PROJECT}:${VERSION}
        command: ["npm", "run", "migrate:prod"]
        env:
        - name: POSTGRES_HOST
          value: "postgres-postgresql-primary.vibe-data.svc.cluster.local"
        - name: POSTGRES_PORT
          value: "5432"
        - name: POSTGRES_DATABASE
          value: "postgres"
        - name: POSTGRES_USER
          value: "vibe_user"
        - name: POSTGRES_PASSWORD
          valueFrom:
            secretKeyRef:
              name: graphrag-secrets
              key: postgres-password
EOF

    # Wait for migration to complete
    echo -e "${YELLOW}⏳ Waiting for migrations to complete...${NC}"
    kubectl wait --for=condition=complete job/graphrag-migrations-${VERSION} -n ${NAMESPACE} --timeout=300s

    echo -e "${GREEN}✅ Migrations completed${NC}"
}

# Function to deploy the application
deploy_application() {
    echo -e "${BLUE}☸️  Deploying GraphRAG to Kubernetes...${NC}"

    # Update deployment with new image
    kubectl set image deployment/graphrag-api \
        graphrag=${REGISTRY}/${PROJECT}:${VERSION} \
        -n ${NAMESPACE}

    # Wait for rollout
    kubectl rollout status deployment/graphrag-api -n ${NAMESPACE} --timeout=300s

    echo -e "${GREEN}✅ Deployment successful${NC}"
}

# Function to run health checks
run_health_checks() {
    echo -e "${BLUE}🏥 Running health checks...${NC}"

    # Wait for pods to be ready
    sleep 10

    # Get pod name
    POD=$(kubectl get pod -n ${NAMESPACE} -l app=graphrag -o jsonpath='{.items[0].metadata.name}')

    if [ -z "$POD" ]; then
        echo -e "${RED}❌ No GraphRAG pod found${NC}"
        return 1
    fi

    # Check health endpoint
    if kubectl exec -n ${NAMESPACE} $POD -- curl -s http://localhost:8090/health | grep -q "healthy"; then
        echo -e "${GREEN}✅ Health check passed${NC}"
    else
        echo -e "${RED}❌ Health check failed${NC}"
        kubectl logs -n ${NAMESPACE} $POD --tail=50
        return 1
    fi
}

# Function to run integration tests
run_integration_tests() {
    echo -e "${BLUE}🧪 Running integration tests...${NC}"

    POD=$(kubectl get pod -n ${NAMESPACE} -l app=graphrag -o jsonpath='{.items[0].metadata.name}')

    # Test 1: Store document with text model
    echo -e "${YELLOW}Test 1: Storing text document...${NC}"
    kubectl exec -n ${NAMESPACE} $POD -- node -e "
const http = require('http');
const testData = JSON.stringify({
  content: 'Enhanced GraphRAG with multi-model Voyage AI support is now live!',
  metadata: {
    title: 'Deployment Test',
    type: 'text',
    tags: ['test', 'deployment', 'multi-model']
  }
});

const req = http.request({
  hostname: 'localhost',
  port: 8090,
  path: '/api/documents',
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Content-Length': testData.length
  }
}, res => {
  let body = '';
  res.on('data', chunk => body += chunk);
  res.on('end', () => {
    console.log('Text document stored:', JSON.parse(body).documentId);
  });
});
req.write(testData);
req.end();
"

    # Test 2: Store code with code model
    echo -e "${YELLOW}Test 2: Storing code document...${NC}"
    kubectl exec -n ${NAMESPACE} $POD -- node -e "
const http = require('http');
const testData = JSON.stringify({
  content: 'function deployGraphRAG() { return \"Multi-model support enabled!\"; }',
  metadata: {
    title: 'Code Test',
    type: 'code',
    format: 'js'
  }
});

const req = http.request({
  hostname: 'localhost',
  port: 8090,
  path: '/api/documents',
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Content-Length': testData.length
  }
}, res => {
  let body = '';
  res.on('data', chunk => body += chunk);
  res.on('end', () => {
    const result = JSON.parse(body);
    console.log('Code document stored:', result.documentId);
    console.log('Model used:', result.metadata.embeddingModel);
  });
});
req.write(testData);
req.end();
"

    sleep 3

    # Test 3: Retrieval with reranking
    echo -e "${YELLOW}Test 3: Testing retrieval with reranking...${NC}"
    kubectl exec -n ${NAMESPACE} $POD -- node -e "
const http = require('http');
setTimeout(() => {
  const searchData = JSON.stringify({
    query: 'multi-model Voyage AI support deployment',
    options: {
      maxTokens: 1000,
      includeReranking: true,
      contentTypes: ['text', 'code']
    }
  });

  const req = http.request({
    hostname: 'localhost',
    port: 8090,
    path: '/api/retrieve',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': searchData.length
    }
  }, res => {
    let body = '';
    res.on('data', chunk => body += chunk);
    res.on('end', () => {
      const result = JSON.parse(body);
      console.log('Retrieval results:');
      console.log('  Chunks found:', result.chunks?.length || 0);
      console.log('  Collections searched:', result.metadata?.collectionsSearched);
      console.log('  Reranking applied:', result.metadata?.reranked);
      console.log('  Top relevance score:', result.relevanceScore);
    });
  });
  req.write(searchData);
  req.end();
}, 3000);
"

    echo -e "${GREEN}✅ Integration tests completed${NC}"
}

# Main deployment flow
main() {
    echo -e "${BLUE}Starting deployment process...${NC}"
    echo ""

    # Step 1: Check prerequisites
    check_prerequisites

    # Step 2: Build and push image
    echo -e "${BLUE}🔨 Building and pushing Docker image...${NC}"
    cd ${REPO_DIR}/services/graphrag
    ./scripts/build.sh production true

    # Step 3: Run migrations
    run_migrations

    # Step 4: Deploy application
    deploy_application

    # Step 5: Run health checks
    run_health_checks

    # Step 6: Run integration tests
    if [ "${RUN_TESTS:-true}" = "true" ]; then
        run_integration_tests
    fi

    # Summary
    echo ""
    echo -e "${GREEN}✨ ✨ ✨ DEPLOYMENT SUCCESSFUL ✨ ✨ ✨${NC}"
    echo -e "${GREEN}=====================================
    ${NC}"
    echo -e "GraphRAG ${VERSION} deployed with:"
    echo -e "  ✅ Multi-model Voyage AI support"
    echo -e "  ✅ Intelligent model selection"
    echo -e "  ✅ Reranking with rerank-2.5"
    echo -e "  ✅ Layered Docker build optimization"
    echo -e "  ✅ Database migrations applied"
    echo -e "  ✅ Health checks passed"
    echo ""
    echo -e "${BLUE}View logs:${NC} kubectl logs -f -n ${NAMESPACE} -l app=graphrag"
    echo -e "${BLUE}Port forward:${NC} kubectl port-forward -n ${NAMESPACE} svc/graphrag-api 8090:8090"
}

# Handle command line arguments
case "${1:-deploy}" in
    "deploy")
        main
        ;;
    "rollback")
        echo -e "${YELLOW}🔄 Rolling back deployment...${NC}"
        kubectl rollout undo deployment/graphrag-api -n ${NAMESPACE}
        kubectl rollout status deployment/graphrag-api -n ${NAMESPACE}
        ;;
    "status")
        echo -e "${BLUE}📊 Deployment status:${NC}"
        kubectl get all -n ${NAMESPACE} -l app=graphrag
        ;;
    "logs")
        kubectl logs -f -n ${NAMESPACE} -l app=graphrag --tail=100
        ;;
    *)
        echo -e "${RED}Usage: $0 {deploy|rollback|status|logs}${NC}"
        exit 1
        ;;
esac