#!/bin/bash
set -e

# MageAgent Kubernetes Deployment Script
echo "========================================"
echo "MageAgent Kubernetes Deployment"
echo "========================================"

# Configuration
NAMESPACE="mage-agent"
IMAGE_NAME="mageagent"
IMAGE_TAG="latest"
REGISTRY="registry.vibe-platform.local"
DOCKER_IMAGE="${REGISTRY}/${IMAGE_NAME}:${IMAGE_TAG}"

# Function to check if kubectl is configured
check_kubectl() {
    if ! kubectl cluster-info &>/dev/null; then
        echo "❌ Error: kubectl is not configured or cluster is not accessible"
        echo "Please ensure kubectl is properly configured with your cluster"
        exit 1
    fi
    echo "✅ kubectl is configured"
}

# Function to build Docker image
build_image() {
    echo "Building Docker image..."
    docker build -t ${DOCKER_IMAGE} .
    echo "✅ Docker image built: ${DOCKER_IMAGE}"
}

# Function to push Docker image
push_image() {
    echo "Pushing Docker image to registry..."
    docker push ${DOCKER_IMAGE}
    echo "✅ Docker image pushed to registry"
}

# Function to create namespace if it doesn't exist
create_namespace() {
    if kubectl get namespace ${NAMESPACE} &>/dev/null; then
        echo "✅ Namespace ${NAMESPACE} already exists"
    else
        echo "Creating namespace ${NAMESPACE}..."
        kubectl apply -f k8s/namespace.yaml
        echo "✅ Namespace created"
    fi
}

# Function to apply Kubernetes manifests
deploy_to_kubernetes() {
    echo "Deploying to Kubernetes..."

    # Apply in order
    kubectl apply -f k8s/namespace.yaml
    kubectl apply -f k8s/configmap.yaml

    # Check if secret exists, if not create it
    if kubectl get secret mageagent-secrets -n ${NAMESPACE} &>/dev/null; then
        echo "⚠️  Secret already exists. Skipping secret creation."
        echo "   To update secrets, delete the existing secret first:"
        echo "   kubectl delete secret mageagent-secrets -n ${NAMESPACE}"
    else
        kubectl apply -f k8s/secret.yaml
        echo "✅ Secret created"
    fi

    kubectl apply -f k8s/networkpolicy.yaml
    kubectl apply -f k8s/service.yaml
    kubectl apply -f k8s/deployment.yaml
    kubectl apply -f k8s/hpa.yaml
    kubectl apply -f k8s/pdb.yaml
    kubectl apply -f k8s/virtualservice.yaml

    echo "✅ All Kubernetes resources deployed"
}

# Function to wait for deployment
wait_for_deployment() {
    echo "Waiting for deployment to be ready..."
    kubectl rollout status deployment/mageagent -n ${NAMESPACE} --timeout=5m
    echo "✅ Deployment is ready"
}

# Function to check pod status
check_pods() {
    echo "Checking pod status..."
    kubectl get pods -n ${NAMESPACE} -l app=mageagent
}

# Function to test health endpoint
test_health() {
    echo "Testing health endpoint..."

    # Get service endpoint
    SERVICE_IP=$(kubectl get svc mageagent -n ${NAMESPACE} -o jsonpath='{.spec.clusterIP}')

    if [ -z "$SERVICE_IP" ]; then
        echo "⚠️  Could not get service IP. Service may not be ready yet."
        return
    fi

    # Port-forward for testing
    kubectl port-forward -n ${NAMESPACE} svc/mageagent 8080:80 &
    PF_PID=$!
    sleep 5

    # Test health endpoint
    if curl -s http://localhost:8080/api/health | jq . ; then
        echo "✅ Health check passed"
    else
        echo "❌ Health check failed"
    fi

    # Kill port-forward
    kill $PF_PID 2>/dev/null || true
}

# Function to display access information
display_access_info() {
    echo ""
    echo "========================================"
    echo "Deployment Complete!"
    echo "========================================"
    echo ""
    echo "📍 Service endpoints:"
    echo "   - API: https://graphrag.adverant.ai/mageagent/api/*"
    echo "   - WebSocket: wss://graphrag.adverant.ai/mageagent/ws"
    echo "   - Health: https://graphrag.adverant.ai/mageagent/health"
    echo ""
    echo "🔍 Useful commands:"
    echo "   - View pods: kubectl get pods -n ${NAMESPACE}"
    echo "   - View logs: kubectl logs -n ${NAMESPACE} -l app=mageagent"
    echo "   - Port forward: kubectl port-forward -n ${NAMESPACE} svc/mageagent 8080:80"
    echo ""
}

# Main deployment flow
main() {
    echo "Starting deployment process..."

    # Check prerequisites
    check_kubectl

    # Build and push image
    read -p "Build and push Docker image? (y/n) " -n 1 -r
    echo
    if [[ $REPLY =~ ^[Yy]$ ]]; then
        build_image
        push_image
    fi

    # Deploy to Kubernetes
    create_namespace
    deploy_to_kubernetes
    wait_for_deployment
    check_pods

    # Test deployment
    read -p "Test health endpoint? (y/n) " -n 1 -r
    echo
    if [[ $REPLY =~ ^[Yy]$ ]]; then
        test_health
    fi

    # Display access information
    display_access_info
}

# Run main function
main "$@"