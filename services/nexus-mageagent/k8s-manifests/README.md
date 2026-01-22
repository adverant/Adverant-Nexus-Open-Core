# MageAgent Kubernetes Deployment Manifests

This directory contains all the Kubernetes manifests required to deploy the MageAgent service to production.

## Manifest Files

1. **01-namespace.yaml**: Creates the `mage-agent` namespace with Istio injection enabled and RBAC resources
2. **02-configmap.yaml**: Contains non-sensitive configuration including database endpoints, service discovery, and application settings
3. **03-secret.yaml**: Template for sensitive data (API keys, passwords) - MUST be edited with real values before deployment
4. **04-networkpolicy.yaml**: Network policies allowing cross-namespace communication with databases and GraphRAG services
5. **05-deployment.yaml**: Deployment configuration with 3 replicas, resource limits, health checks, and security context
6. **06-service.yaml**: ClusterIP service, headless service, and ServiceMonitor for Prometheus
7. **07-virtualservice.yaml**: Istio VirtualService for routing, including WebSocket support
8. **08-gateway.yaml**: Istio Gateway for external access on graphrag.adverant.ai

## Deployment Process

### Prerequisites
- Kubernetes cluster with Istio installed
- Access to cluster registry (localhost:32000)
- Database services running in vibe-data namespace
- Valid API keys for OpenRouter and other services

### Manual Deployment Steps

1. **Build and push Docker image:**
```bash
cd ../
docker build -t mageagent:v1.0.0 .
docker tag mageagent:v1.0.0 localhost:32000/mageagent:v1.0.0
docker push localhost:32000/mageagent:v1.0.0
```

2. **Apply namespace and RBAC:**
```bash
kubectl apply -f 01-namespace.yaml
```

3. **Create secrets with actual values:**
```bash
# Copy 03-secret.yaml to a temporary location and edit with real values
cp 03-secret.yaml /tmp/mageagent-secrets.yaml
# Edit the file to add real credentials
kubectl apply -f /tmp/mageagent-secrets.yaml
rm /tmp/mageagent-secrets.yaml
```

4. **Apply remaining manifests:**
```bash
kubectl apply -f 02-configmap.yaml
kubectl apply -f 04-networkpolicy.yaml
kubectl apply -f 06-service.yaml
kubectl apply -f 05-deployment.yaml
kubectl apply -f 08-gateway.yaml
kubectl apply -f 07-virtualservice.yaml
```

5. **Verify deployment:**
```bash
kubectl rollout status deployment/mageagent -n mage-agent
kubectl get pods -n mage-agent
```

### Automated Deployment

Use the provided deploy.sh script:
```bash
cd ../
./deploy.sh
```

## Access URLs

- Internal API: `http://mageagent.mage-agent.svc.cluster.local:8080`
- External API: `https://graphrag.adverant.ai/mageagent/`
- WebSocket: `wss://graphrag.adverant.ai/mageagent/ws`

## Troubleshooting

1. **Check pod logs:**
```bash
kubectl logs -f -n mage-agent -l app=mageagent
```

2. **Describe pods for events:**
```bash
kubectl describe pod -n mage-agent -l app=mageagent
```

3. **Test internal connectivity:**
```bash
kubectl run -it --rm debug --image=curlimages/curl -n mage-agent -- sh
# Inside the pod:
curl http://mageagent:8080/api/health
```

4. **Port forward for local testing:**
```bash
kubectl port-forward -n mage-agent svc/mageagent 8080:8080
```