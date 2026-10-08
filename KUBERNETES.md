# Kubernetes Deployment

Run the full microservices stack on Kubernetes using [minikube](https://minikube.sigs.k8s.io/) for local development.

## Prerequisites

- [Docker](https://docs.docker.com/get-docker/)
- [minikube](https://minikube.sigs.k8s.io/docs/start/)
- [kubectl](https://kubernetes.io/docs/tasks/tools/)

## Quick Start

```bash
# Start minikube
minikube start

# Point Docker to minikube's daemon (so it uses locally-built images)
eval $(minikube docker-env)

# Build all service images
docker compose build

# Deploy everything to the todo-app namespace
kubectl apply -f k8s/

# Get the API gateway URL
minikube service api-gateway -n todo-app --url

# Get the web UI URL
minikube service web -n todo-app --url
```

## How It Works

### Service Discovery

With `DISCOVERY_BACKEND=kubernetes`, services use Kubernetes DNS instead of Consul or etcd. Each K8s Service exposes port 80 and maps it to the container's actual port:

```
K8s Service (port 80) → Pod (containerPort 3001)
```

Application code just calls `http://todo-service/todos` -- no port, no discovery lookup. The `shared/kubernetes.ts` backend is effectively a no-op: registration and deregistration are handled automatically by Kubernetes Endpoints.

### Web UI

The `web` pod runs the same nginx image as in Docker Compose. nginx proxies `/api/` to the gateway, and `k8s/web.yaml` sets `API_GATEWAY_URL=http://api-gateway` because the gateway's Service listens on port 80 rather than the container's 3000. Like the gateway, `web` has a NodePort Service, so `minikube service web -n todo-app --url` opens it from the host.

### Manifests

All manifests live in `k8s/` and deploy to the `todo-app` namespace:

| File | Resources |
|------|-----------|
| `00-namespace.yaml` | Namespace `todo-app` |
| `postgres.yaml` | Deployment + Service + PersistentVolumeClaim |
| `rabbitmq.yaml` | Deployment + Service (AMQP + Management UI) |
| `api-gateway.yaml` | Deployment + NodePort Service (exposed on port 30000) |
| `todo-service.yaml` | Deployment + Service |
| `user-service.yaml` | Deployment + Service |
| `notification-service.yaml` | Deployment + Service |
| `note-card-service.yaml` | Deployment (2 replicas) + Service |
| `saga-orchestrator.yaml` | Deployment + Service |
| `web.yaml` | Deployment + NodePort Service (exposed on port 30080) |

### Health Checks

Every service has Kubernetes liveness and readiness probes configured against its `/health` endpoint (`web` probes `/`, since nginx has no `/health`). Kubernetes automatically removes unhealthy pods from the Service endpoints.

## Common Commands

```bash
# Check pod status
kubectl get pods -n todo-app

# Watch logs for a service
kubectl logs -f deployment/todo-service -n todo-app

# Scale a service
kubectl scale deployment note-card-service --replicas=4 -n todo-app

# Restart a service
kubectl rollout restart deployment/todo-service -n todo-app

# Access RabbitMQ Management UI
minikube service rabbitmq -n todo-app --url

# Tear down everything
kubectl delete namespace todo-app
```

## Docker Compose vs Kubernetes

| Aspect | Docker Compose | Kubernetes |
|--------|---------------|-----------|
| Service discovery | Consul or etcd (app code) | Built-in DNS (no app code) |
| Load balancing | Client-side random pick | kube-proxy (round-robin) |
| Scaling | Add entries to compose file | `kubectl scale --replicas=N` |
| Self-healing | Container restart only | Reschedules pods, replaces failures |
| Health checks | Consul polls `/health` | kubelet liveness/readiness probes |
| Config | Env vars in compose file | Env vars in manifests (or ConfigMaps/Secrets) |
