# Service Mesh (Linkerd)

This project uses [Linkerd](https://linkerd.io/) as a service mesh layer on top of Kubernetes. Linkerd adds **automatic mTLS**, **observability**, **retry/timeout policies**, and **improved load balancing** — all without changing application code.

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

- Kubernetes cluster running (see [KUBERNETES.md](KUBERNETES.md))
- [Linkerd CLI](https://linkerd.io/2/getting-started/)

## Installation

### 1. Install Linkerd CLI

```bash
curl --proto '=https' --tlsv1.2 -sSfL https://run.linkerd.io/install | sh
export PATH=$HOME/.linkerd2/bin:$PATH
```

### 2. Validate cluster readiness

```bash
linkerd check --pre
```

### 3. Install control plane

```bash
linkerd install --crds | kubectl apply -f -
linkerd install | kubectl apply -f -
linkerd check
```

### 4. Install Viz extension (observability dashboard)

```bash
linkerd viz install | kubectl apply -f -
linkerd viz check
```

This adds Prometheus for metrics collection, a web dashboard, and `tap`/`top` commands for live traffic inspection.

## Enabling the Mesh

The namespace `todo-app` has the injection annotation in `k8s/00-namespace.yaml`:

```yaml
metadata:
  name: todo-app
  annotations:
    linkerd.io/inject: enabled
```

All new pods automatically get the Linkerd sidecar proxy. To inject into existing pods, restart the deployments:

```bash
kubectl rollout restart deployment -n todo-app
```

## Retry and Timeout Policies

Policies are defined in `k8s/linkerd/retry-policy.yaml` and configure automatic retries for HTTP calls:

| Service | Timeout | Retries | Retry on |
|---------|---------|---------|----------|
| todo-service | 5s | 2 | 500, 502, 503 |
| user-service | 3s | 2 | 500, 502, 503 |

Only GET requests are retried (safe, idempotent). Apply with:

```bash
kubectl apply -f k8s/linkerd/
```

## Verification

```bash
# Check Linkerd is healthy
linkerd check

# Verify sidecars are injected (each pod should show 2 containers)
kubectl get pods -n todo-app

# Check mTLS is active between services
linkerd viz edges deployment -n todo-app

# Open the observability dashboard
linkerd viz dashboard

# Live traffic inspection on the API gateway
linkerd viz tap deployment/api-gateway -n todo-app

# Golden metrics: success rate, RPS, latency per deployment
linkerd viz stat deployment -n todo-app
```

## Manifest Files

| File | Purpose |
|------|---------|
| `k8s/00-namespace.yaml` | Namespace with `linkerd.io/inject: enabled` annotation |
| `k8s/linkerd/retry-policy.yaml` | HTTP retry + timeout policies for todo-service and user-service |
