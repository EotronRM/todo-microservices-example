# Service Mesh (Linkerd)

This guide walks through deploying the microservices on Kubernetes with [Linkerd](https://linkerd.io/) as a service mesh. By the end you'll have **automatic mTLS**, **observability**, **retry/timeout policies**, and **improved load balancing** — all without changing application code.

## What Linkerd Adds

| Concern | K8s alone | K8s + Linkerd |
|---------|-----------|---------------|
| Encryption | Plain HTTP between pods | Automatic mTLS |
| Retries | None | Configurable per-service |
| Timeouts | None | Configurable per-service |
| Circuit breaking | None | Automatic (failure budgets) |
| Observability | `console.log` | Golden metrics (latency, success rate, RPS), live dashboard |
| Load balancing | kube-proxy round-robin | EWMA (least-loaded) |

```
Without mesh:                      With Linkerd:
+-----------+                      +-----------+
| api-gw    |--HTTP-->             | api-gw    |
+-----------+       |              |  [proxy]  |--mTLS-->
                    |              +-----------+
+-----------+       |              +-----------+
| todo-svc  |<-----+              | todo-svc  |
+-----------+                      |  [proxy]  |
                                   +-----------+
                                   + retries, timeouts, metrics,
                                     circuit breaking
```

Every pod gets a lightweight Rust-based sidecar proxy injected automatically. Services keep calling `http://service-name/path` — the proxy intercepts traffic transparently.

## Prerequisites

- [Docker](https://docs.docker.com/get-docker/)
- [minikube](https://minikube.sigs.k8s.io/docs/start/)
- [kubectl](https://kubernetes.io/docs/tasks/tools/)
- [Linkerd CLI](https://linkerd.io/2/getting-started/)

## Step 1: Start the Kubernetes Cluster

```bash
minikube start
```

Point your local Docker CLI at minikube's Docker daemon so that images built locally are available to the cluster:

```bash
eval $(minikube docker-env)
```

## Step 2: Build the Service Images

From the project root, build all service images:

```bash
docker compose build
```

Since we ran `eval $(minikube docker-env)` first, these images are now inside minikube's Docker and the K8s manifests can pull them with `imagePullPolicy: Never`.

## Step 3: Deploy to Kubernetes

Apply the manifests in order — the namespace first, then infrastructure, then services:

```bash
# Namespace (includes Linkerd injection annotation)
kubectl apply -f k8s/00-namespace.yaml

# Infrastructure (PostgreSQL, RabbitMQ)
kubectl apply -f k8s/postgres.yaml
kubectl apply -f k8s/rabbitmq.yaml

# Wait for infrastructure to be ready
kubectl wait --for=condition=ready pod -l app=postgres -n todo-app --timeout=60s
kubectl wait --for=condition=ready pod -l app=rabbitmq -n todo-app --timeout=60s

# Application services
kubectl apply -f k8s/todo-service.yaml
kubectl apply -f k8s/user-service.yaml
kubectl apply -f k8s/notification-service.yaml
kubectl apply -f k8s/note-card-service.yaml
kubectl apply -f k8s/saga-orchestrator.yaml
kubectl apply -f k8s/api-gateway.yaml
```

Verify all pods are running:

```bash
kubectl get pods -n todo-app
```

Get the API gateway URL:

```bash
minikube service api-gateway -n todo-app --url
```

Test that the services are responding:

```bash
curl $(minikube service api-gateway -n todo-app --url)/api/todos
```

## Step 4: Install Linkerd CLI

```bash
curl --proto '=https' --tlsv1.2 -sSfL https://run.linkerd.io/install | sh
export PATH=$HOME/.linkerd2/bin:$PATH
```

Validate that the cluster is ready for Linkerd:

```bash
linkerd check --pre
```

## Step 5: Install Linkerd Control Plane

Linkerd depends on the Kubernetes Gateway API CRDs. Install them first:

```bash
kubectl apply --server-side -f https://github.com/kubernetes-sigs/gateway-api/releases/download/v1.4.0/standard-install.yaml
```

Then install Linkerd:

```bash
# Install Linkerd Custom Resource Definitions
linkerd install --crds | kubectl apply -f -

# Install the control plane (runAsRoot needed for minikube's Docker runtime)
linkerd install --set proxyInit.runAsRoot=true | kubectl apply -f -

# Verify everything is healthy
linkerd check
```

## Step 6: Install Viz Extension (Observability Dashboard)

```bash
linkerd viz install | kubectl apply -f -
linkerd viz check
```

This adds Prometheus for metrics collection, a web dashboard, and `tap`/`top` commands for live traffic inspection.

## Step 7: Inject Sidecars into Running Pods

The `todo-app` namespace already has the injection annotation in `k8s/00-namespace.yaml`:

```yaml
metadata:
  name: todo-app
  annotations:
    linkerd.io/inject: enabled
```

Since the pods were created before Linkerd was installed, restart the deployments to trigger sidecar injection:

```bash
kubectl rollout restart deployment -n todo-app
```

Wait for all pods to come back up:

```bash
kubectl rollout status deployment -n todo-app --timeout=120s
```

Confirm each pod now has 2 containers (the app + `linkerd-proxy`):

```bash
kubectl get pods -n todo-app
```

The `READY` column should show `2/2` for every pod.

## Step 8: Apply Retry and Timeout Policies

Policies are defined in `k8s/linkerd/retry-policy.yaml` and configure automatic retries for HTTP GET requests:

| Service | Timeout | Retries | Retry on |
|---------|---------|---------|----------|
| todo-service | 5s | 2 | 500, 502, 503 |
| user-service | 3s | 2 | 500, 502, 503 |

Apply them:

```bash
kubectl apply -f k8s/linkerd/
```

## Step 9: Verify the Mesh

```bash
# Check Linkerd is healthy
linkerd check

# Check mTLS is active between services
linkerd viz edges deployment -n todo-app
# Should show "secured" for all edges

# Open the observability dashboard
linkerd viz dashboard
# Browse to the todo-app namespace to see live traffic, success rates, and latency

# Live traffic inspection on the API gateway
linkerd viz tap deployment/api-gateway -n todo-app

# Golden metrics: success rate, RPS, latency per deployment
linkerd viz stat deployment -n todo-app
```

## Quick Reference

### Full setup from scratch (copy-paste)

```bash
# 1. Cluster + images
minikube start
eval $(minikube docker-env)
docker compose build

# 2. Deploy to K8s
kubectl apply -f k8s/00-namespace.yaml
kubectl apply -f k8s/postgres.yaml
kubectl apply -f k8s/rabbitmq.yaml
kubectl wait --for=condition=ready pod -l app=postgres -n todo-app --timeout=60s
kubectl wait --for=condition=ready pod -l app=rabbitmq -n todo-app --timeout=60s
kubectl apply -f k8s/todo-service.yaml
kubectl apply -f k8s/user-service.yaml
kubectl apply -f k8s/notification-service.yaml
kubectl apply -f k8s/note-card-service.yaml
kubectl apply -f k8s/saga-orchestrator.yaml
kubectl apply -f k8s/api-gateway.yaml

# 3. Install Linkerd
curl --proto '=https' --tlsv1.2 -sSfL https://run.linkerd.io/install | sh
export PATH=$HOME/.linkerd2/bin:$PATH
linkerd check --pre
kubectl apply --server-side -f https://github.com/kubernetes-sigs/gateway-api/releases/download/v1.4.0/standard-install.yaml
linkerd install --crds | kubectl apply -f -
linkerd install | kubectl apply -f -
linkerd check

# 4. Viz extension
linkerd viz install | kubectl apply -f -
linkerd viz check

# 5. Inject sidecars + apply policies
kubectl rollout restart deployment -n todo-app
kubectl rollout status deployment -n todo-app --timeout=120s
kubectl apply -f k8s/linkerd/

# 6. Verify
linkerd viz dashboard
```

### Tearing down

```bash
# 1. Remove sidecar injection and restart pods without proxies
kubectl annotate namespace todo-app linkerd.io/inject-
kubectl rollout restart deployment -n todo-app
kubectl rollout status deployment -n todo-app --timeout=120s

# 2. Remove Linkerd
linkerd viz uninstall | kubectl delete -f -
linkerd uninstall | kubectl delete -f -

# 3. Remove the application
kubectl delete namespace todo-app

# 4. Stop minikube
minikube stop
```

## RabbitMQ Management UI

RabbitMQ includes a web UI for inspecting queues, consumers, bindings, and message rates. To access it from outside the cluster:

```bash
kubectl port-forward svc/rabbitmq -n todo-app 15672:15672
```

Then open http://localhost:15672 (login: `guest` / `guest`).

This is useful for verifying that all queues have active consumers and no messages are stuck. Look at the **Queues** tab — every queue should show at least 1 consumer.

## Known Issues

### RabbitMQ consumers lost after sidecar injection restart

**Symptom:** Saga workflows get stuck (e.g. stuck at `VALIDATING_USER`). The RabbitMQ management UI shows queues with 0 consumers and messages piling up.

**Cause:** When Step 7 (`kubectl rollout restart`) restarts pods to inject Linkerd sidecars, the existing RabbitMQ TCP connections are dropped. The `@cloudamqp/amqp-client` library does not auto-reconnect, so the consumers are silently lost even though the service logs say "RabbitMQ consumers ready" (that message was printed before the restart).

**Fix:** Restart the affected deployments again after Linkerd injection is complete:

```bash
kubectl rollout restart deployment -n todo-app
kubectl rollout status deployment -n todo-app --timeout=120s
```

**Verify** by checking consumer counts:

```bash
kubectl exec deployment/rabbitmq -n todo-app -c rabbitmq -- rabbitmqctl list_queues name consumers messages
```

Every queue should show at least 1 consumer and 0 pending messages.

**Note:** This is a one-time issue that happens during initial Linkerd setup. It does not recur during normal operation.

## Manifest Files

| File | Purpose |
|------|---------|
| `k8s/00-namespace.yaml` | Namespace with `linkerd.io/inject: enabled` annotation |
| `k8s/linkerd/retry-policy.yaml` | HTTP retry + timeout policies for todo-service and user-service |
