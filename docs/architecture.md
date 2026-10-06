# Architecture

> This copy describes the **`feature/k8s-service-mesh`** branch. Each feature branch has its own copy of this file, extended with what that branch adds:
>
> | Branch | Adds |
> |---|---|
> | `main` | HTTP microservices, PostgreSQL, client-side discovery with Consul or etcd, React web UI |
> | `feature/saga-pattern` | RabbitMQ, `saga-orchestrator`, orchestration and choreography sagas |
> | `feature/kubernetes` | Kubernetes manifests and a DNS-based discovery backend |
> | `feature/k8s-service-mesh` | Linkerd sidecars, mTLS, retry and timeout policies |

The diagrams are [Mermaid](https://mermaid.js.org/). GitHub renders them inline, and [mermaid.live](https://mermaid.live) is handy for editing them.

## System overview

```mermaid
flowchart LR
    client([Client])
    browser([Browser])
    web["web (nginx)<br/>:8080"]

    subgraph services["Application services"]
        gw["api-gateway<br/>:3000"]
        orch["saga-orchestrator<br/>:3010"]
        todo["todo-service<br/>:3001"]
        user["user-service<br/>:3002"]
        notif["notification-service<br/>:3003"]
        nc1["note-card-service-1<br/>:3004"]
        nc2["note-card-service-2<br/>:3005"]
    end

    pg[("PostgreSQL<br/>todos table")]
    mq[["RabbitMQ :5672<br/>saga.orchestration (direct)<br/>saga.choreography (topic)"]]
    reg{{"Service discovery<br/>Consul :8500, etcd :2379<br/>or Kubernetes DNS"}}

    browser --> web
    web -->|"/api/*"| gw
    client -->|"/api/*"| gw
    gw -->|"/todos"| todo
    gw -->|"/users/:id"| user
    gw -->|"/note-card/:todoId"| nc1 & nc2
    gw -->|"/saga/*"| orch
    todo -->|"POST /notify"| notif
    nc1 & nc2 -->|"GET /todos/:id"| todo
    todo --> pg
    orch & todo & user & notif & nc1 & nc2 <==>|AMQP| mq
    services -.->|"register + discover"| reg
```

- Solid arrows are HTTP calls, and thick arrows are AMQP connections to RabbitMQ. Every caller looks up the target before each HTTP call (dotted arrow). With Consul or etcd, each service registers itself on startup. On Kubernetes, the platform does that.
- `note-card-service` runs as two instances under one service name, and requests are spread across both.
- Ports are container ports. On Kubernetes, every Service listens on `:80` and forwards to these.
- `user-service` serves three hardcoded users, and `notification-service` only logs what it receives.
- `web` is the React UI. nginx serves the bundle and proxies `/api/*` to the gateway on the same origin, because the gateway sends no CORS headers. It isn't registered in the registry.
- `todo-service` creates the `todos` table (`id`, `title`, `completed`, `user_id`, `status`) on startup. It retries 5 times, 2s apart, while PostgreSQL starts.

The gateway is the only entry point:

| Gateway route | Forwards to |
|---|---|
| `GET /api/todos`, `POST /api/todos` | todo-service `/todos` |
| `GET /api/todos/:id`, `DELETE /api/todos/:id` | todo-service `/todos/:id` |
| `PUT /api/todos/:id/assign` | todo-service `/todos/:id/assign` (starts the choreography saga) |
| `GET /api/users/:id` | user-service `/users/:id` |
| `GET /api/note-card/:todoId` | note-card-service `/note-card/:todoId` (binary passthrough) |
| `POST /api/saga/create-full-todo` | saga-orchestrator `/saga/create-full-todo` (starts the orchestration saga) |
| `GET /api/saga/status/:sagaId` | saga-orchestrator `/saga/status/:sagaId` |

If discovery or the downstream call throws, the gateway answers `503 {"error": "<service> unavailable"}`.

## Service discovery

Services never hardcode each other's addresses. They import [`shared/discovery.ts`](../shared/discovery.ts), which loads a backend at startup based on `DISCOVERY_BACKEND`:

```mermaid
flowchart LR
    code["Service code"] -->|"registerService()<br/>discoverService()<br/>setupGracefulShutdown()"| adapter["shared/discovery.ts"]
    adapter -->|"consul (default)"| consul["shared/consul.ts"]
    adapter -->|"etcd"| etcd["shared/etcd.ts"]
    adapter -->|"kubernetes"| k8s["shared/kubernetes.ts"]
```

Consul and etcd use **client-side discovery**: the registry returns every live instance, and the caller picks one at random. That random pick is what spreads traffic across the two note-card instances. The Kubernetes backend hands this job to the platform (**server-side discovery**). See [Kubernetes](#kubernetes) below.

### Consul

Consul owns the health checks. It polls each instance's `/health` endpoint and only returns instances whose check passes.

```mermaid
sequenceDiagram
    autonumber
    participant S as todo-service
    participant C as Consul
    participant G as api-gateway

    S->>C: PUT /v1/agent/service/register<br/>ID todo-service-3001, HTTP check on /health every 10s
    loop every 10s
        C->>S: GET /health
        S-->>C: 200 OK
    end
    G->>C: GET /v1/health/service/todo-service?passing=true
    C-->>G: healthy instances
    Note over G: pick one at random
    G->>S: GET /todos
    alt SIGINT or SIGTERM
        S->>C: PUT /v1/agent/service/deregister/todo-service-3001
    else crash
        Note over C: health check fails, so the instance is no longer passing
    end
```

### etcd

etcd is only a key-value store, so a service proves it is alive by renewing a lease. If the renewals stop, etcd deletes the key.

```mermaid
sequenceDiagram
    autonumber
    participant S as todo-service
    participant E as etcd
    participant G as api-gateway

    S->>E: POST /v3/lease/grant (TTL 15s)
    E-->>S: lease ID
    S->>E: POST /v3/kv/put<br/>/services/todo-service/instances/todo-service-3001, attached to the lease
    loop every 5s
        S->>E: POST /v3/lease/keepalive
    end
    G->>E: POST /v3/kv/range (prefix /services/todo-service/instances/)
    E-->>G: registered instances
    Note over G: pick one at random
    G->>S: GET /todos
    alt SIGINT or SIGTERM
        S->>E: POST /v3/kv/deleterange, then /v3/lease/revoke
    else crash
        Note over E: no keepalive for 15s, so the lease expires and the key is deleted
    end
```

### Kubernetes

There's no registry to talk to. `registerService()` and `deregisterService()` do nothing, and `discoverService(name)` returns `{address: name, port: 80}` without any network call. Cluster DNS and the Service's endpoints do the rest.

```mermaid
sequenceDiagram
    autonumber
    participant K as kubelet
    participant P as todo-service pod
    participant G as api-gateway pod
    participant DNS as CoreDNS
    participant SVC as Service todo-service

    loop readinessProbe every 5s
        K->>P: GET /health
        P-->>K: 200 OK
    end
    Note over SVC,P: only Ready pods are listed in the Service's endpoints
    Note over G: discoverService("todo-service")<br/>returns todo-service:80
    G->>DNS: resolve todo-service
    DNS-->>G: ClusterIP
    G->>SVC: GET http://todo-service:80/todos
    SVC->>P: kube-proxy forwards to a Ready pod on :3001
    Note over K,P: a terminating pod is removed from the endpoints<br/>if the liveness probe fails, kubelet restarts the container
```

The load-balancing decision moves from the caller to kube-proxy, which picks a pod **per connection**, not per request. Node's `fetch` keeps connections alive and reuses them, so a burst of requests from one caller can all land on the same note-card pod. Once Linkerd is installed, its proxy balances per request instead. See [Service mesh (Linkerd)](#service-mesh-linkerd).

### Comparison

| | Consul ([`consul.ts`](../shared/consul.ts)) | etcd ([`etcd.ts`](../shared/etcd.ts)) | Kubernetes ([`kubernetes.ts`](../shared/kubernetes.ts)) |
|---|---|---|---|
| Who checks health | Consul polls `/health` (server-side) | The service renews its lease (client-side) | kubelet runs the liveness and readiness probes |
| Registration | One API call | Grant a lease, put the key, start a keepalive timer | None, because the Deployment and Service define it |
| Discovery | `GET /v1/health/service/{name}?passing=true` | Prefix range on `/services/{name}/instances/` | DNS name `http://{name}:80` |
| Who picks the instance | The caller, at random | The caller, at random | kube-proxy, per connection |
| A dead instance disappears after | The next failed check (every 10s) | The lease TTL (15s) | Immediately if the process exits, or 3 failed readiness probes (about 15s) if it hangs |
| State kept inside the service | None | Lease ID and keepalive timer | None |

## Request flows

### Create a todo

```mermaid
sequenceDiagram
    autonumber
    actor C as Client
    participant G as api-gateway
    participant T as todo-service
    participant DB as PostgreSQL
    participant N as notification-service

    C->>G: POST /api/todos {title}
    Note over G: discoverService("todo-service")
    G->>T: POST /todos
    alt title missing
        T-->>G: 400
    else
        T->>DB: INSERT INTO todos
        Note over T: discoverService("notification-service")
        T->>N: POST /notify {message}
        N-->>T: 200
        T-->>G: 201 with the new todo
    end
    G-->>C: same status and body
```

`todo-service` waits for the notification call, but if it fails the error is only logged. The todo is already saved, so a notification failure doesn't fail the request.

### Render a note card

```mermaid
sequenceDiagram
    autonumber
    actor C as Client
    participant G as api-gateway
    participant NC as note-card-service (instance 1 or 2)
    participant T as todo-service

    C->>G: GET /api/note-card/:todoId
    Note over G: discoverService("note-card-service")<br/>2 instances (Consul/etcd: random pick)
    G->>NC: GET /note-card/:todoId
    Note over NC: discoverService("todo-service")
    NC->>T: GET /todos/:todoId
    alt todo not found
        T-->>NC: 404
        NC-->>G: 404
    else
        T-->>NC: todo
        Note over NC: build SVG, render PNG with sharp
        NC-->>G: 200 image/png, X-Served-By header
    end
    G-->>C: status, Content-Type and body
```

The serving instance's ID is drawn on the card. The gateway copies only `Content-Type`, so the `X-Served-By` header is visible only when you call an instance directly on `:3004` or `:3005`.

## Messaging (RabbitMQ)

Every service except the gateway opens an AMQP connection on startup and calls `setupExchanges()` in [`shared/rabbitmq.ts`](../shared/rabbitmq.ts). That call declares both exchanges and one durable queue per routing key (`saga.<key>` and `choreography.<key>`). It is idempotent, so startup order doesn't matter. Consumers use manual acks with `prefetch(1)`. If a handler throws, its message is nacked without requeue, which drops it.

Connections recover by themselves. If the broker restarts, every service reconnects with backoff (2s, 4s, … up to 30s) and attaches its consumers to the new channel. Messages published while a service is disconnected are dropped and logged.

Each routing key is bound to exactly one queue, so each message is handled by exactly one consumer. When several instances read the same queue they compete for messages; both note-card instances consume `saga.cmd.notecard.generate`. The topic exchange therefore behaves like a direct one: a second subscriber to an event would need its own queue.

The message contracts live in [`shared/saga-types.ts`](../shared/saga-types.ts):

| Exchange | Routing key | Published by | Consumed by |
|---|---|---|---|
| `saga.orchestration` (direct) | `cmd.todo.create` | saga-orchestrator | todo-service |
| | `cmd.todo.create.reply` | todo-service | saga-orchestrator |
| | `cmd.user.validate` | saga-orchestrator | user-service |
| | `cmd.user.validate.reply` | user-service | saga-orchestrator |
| | `cmd.notification.send` | saga-orchestrator | notification-service |
| | `cmd.notification.send.reply` | notification-service | saga-orchestrator |
| | `cmd.notecard.generate` | saga-orchestrator | note-card-service (both instances compete) |
| | `cmd.notecard.generate.reply` | note-card-service | saga-orchestrator |
| | `cmd.todo.delete` | saga-orchestrator | todo-service (compensation, no reply) |
| `saga.choreography` (topic) | `todo.assignment.requested` | todo-service | user-service |
| | `user.validated` | user-service | todo-service |
| | `user.validation.failed` | user-service | todo-service |
| | `todo.assignment.confirmed` | todo-service | notification-service |
| | `todo.assignment.rolledback` | todo-service | none, so messages pile up in the queue |
| | `notification.sent` | notification-service | none, so messages pile up in the queue |

[`SAGA_README.md`](../SAGA_README.md) has curl examples and a side-by-side comparison of the two sagas.

## Orchestration saga: "Create Full Todo"

`saga-orchestrator` drives every step. It sends a command, waits for the reply, and decides what happens next. Half-arrows (`-)`) are messages that go through the `saga.orchestration` exchange.

```mermaid
sequenceDiagram
    autonumber
    actor C as Client
    participant G as api-gateway
    participant O as saga-orchestrator
    participant T as todo-service
    participant U as user-service
    participant N as notification-service
    participant NC as note-card-service

    C->>G: POST /api/saga/create-full-todo {title, userId}
    G->>O: POST /saga/create-full-todo
    Note over O: new saga in memory, step CREATING_TODO
    O-)T: cmd.todo.create
    O-->>G: 202 {sagaId, status}
    G-->>C: 202 {sagaId, status}
    Note over T: INSERT INTO todos (user_id, status = 'assigned')
    T-)O: cmd.todo.create.reply {todoId}
    O-)U: cmd.user.validate
    U-)O: cmd.user.validate.reply
    alt user not found
        O-)T: cmd.todo.delete (compensation)
        Note over O: step FAILED
    else user found
        O-)N: cmd.notification.send
        N-)O: cmd.notification.send.reply
        O-)NC: cmd.notecard.generate
        NC->>T: GET /todos/:id (HTTP)
        T-->>NC: todo
        Note over NC: render the PNG (not stored)
        NC-)O: cmd.notecard.generate.reply
        Note over O: step COMPLETED
    end
    C->>G: GET /api/saga/status/:sagaId
    G->>O: GET /saga/status/:sagaId
    O-->>G: saga state
    G-->>C: saga state
```

The orchestrator's state machine ([`orchestrator.ts`](../saga-orchestrator/src/orchestrator.ts)):

```mermaid
stateDiagram-v2
    [*] --> CREATING_TODO: saga started
    CREATING_TODO --> VALIDATING_USER: todo created
    CREATING_TODO --> FAILED: insert failed
    VALIDATING_USER --> SENDING_NOTIFICATION: user found
    VALIDATING_USER --> FAILED: user not found, send cmd.todo.delete
    SENDING_NOTIFICATION --> GENERATING_NOTECARD: notification sent
    SENDING_NOTIFICATION --> FAILED: failed, send cmd.todo.delete
    GENERATING_NOTECARD --> COMPLETED: card rendered
    GENERATING_NOTECARD --> FAILED: failed, send cmd.todo.delete
    COMPLETED --> [*]
    FAILED --> [*]
```

- Compensation is fire-and-forget. The orchestrator publishes `cmd.todo.delete` and moves straight to `FAILED` without waiting for confirmation. `SagaStep.COMPENSATING` is defined but never used.
- The `FAILED` path after `SENDING_NOTIFICATION` can't happen today, because notification-service always replies `success: true`.
- Saga state lives in a `Map` inside the orchestrator process, so a restart forgets in-flight sagas. A reply that doesn't match the saga's current step is ignored.

## Choreography saga: "Assign & Notify"

There is no coordinator. Each service reacts to an event and publishes the next one. Half-arrows (`-)`) are messages that go through the `saga.choreography` exchange.

```mermaid
sequenceDiagram
    autonumber
    actor C as Client
    participant G as api-gateway
    participant T as todo-service
    participant DB as PostgreSQL
    participant U as user-service
    participant N as notification-service

    C->>G: PUT /api/todos/:id/assign {userId}
    G->>T: PUT /todos/:id/assign
    T->>DB: UPDATE todos SET user_id, status = 'assigning'
    T-)U: todo.assignment.requested {correlationId}
    T-->>G: 202 {status: assigning, correlationId}
    G-->>C: 202
    alt user exists
        U-)T: user.validated
        T->>DB: UPDATE todos SET status = 'assigned'
        T-)N: todo.assignment.confirmed
        Note over N: log the notification, then publish notification.sent (no consumer)
    else user not found
        U-)T: user.validation.failed
        T->>DB: UPDATE todos SET user_id = NULL, status = 'assignment_failed'
        Note over T: publish todo.assignment.rolledback (no consumer)
    end
```

The saga's state is the todo's `status` column:

```mermaid
stateDiagram-v2
    [*] --> unassigned: POST /todos
    [*] --> assigned: cmd.todo.create (orchestration saga)
    unassigned --> assigning: PUT assign
    assigning --> assigned: user.validated
    assigning --> assignment_failed: user.validation.failed
    assigned --> assigning: PUT assign again
    assignment_failed --> assigning: PUT assign again
```

- The assign handler doesn't check the current status, so a todo can be reassigned from any state.
- The orchestration saga inserts its todo with `user_id` set and `status = 'assigned'` before validating the user. If the user doesn't exist, compensation deletes the todo, so it shows as `assigned` only until `cmd.todo.delete` is handled.

## Running the stack

### Docker Compose

| Compose file | Registry | Containers |
|---|---|---|
| [`docker-compose.yml`](../docker-compose.yml) | Consul 1.15 dev agent on `:8500` (includes the UI) | postgres, rabbitmq (management UI on `:15672`), consul, api-gateway, saga-orchestrator, todo-service, user-service, notification-service, note-card-service-1, note-card-service-2, web |
| [`docker-compose.etcd.yml`](../docker-compose.etcd.yml) | etcd on `:2379`, with `DISCOVERY_BACKEND=etcd` on every service | The same, with etcd instead of consul |
| [`docker-compose.infra.yml`](../docker-compose.infra.yml) | Consul | postgres, rabbitmq (`4.2-alpine`, without the management UI) and consul only, for running services locally with `bun run dev` |

Each service registers under its `SERVICE_ADDRESS` (its compose service name), so the registry hands out hostnames on the Docker network. Every container also publishes its port on the host.

postgres and rabbitmq have healthchecks, and the services that use them start only once they report healthy (`depends_on: condition: service_healthy`).

### Kubernetes

The manifests in [`k8s/`](../k8s/) deploy everything into the `todo-app` namespace. [`KUBERNETES.md`](../KUBERNETES.md) has the minikube steps.

```mermaid
flowchart LR
    client([Client]) -->|"minikube IP :30000"| gw
    browser([Browser]) -->|"minikube IP :30080"| web

    subgraph ns["namespace todo-app"]
        gw["api-gateway<br/>NodePort 30000 → :3000"]
        web["web (nginx)<br/>NodePort 30080 → :80"]
        orch["saga-orchestrator<br/>:80 → :3010"]
        todo["todo-service<br/>:80 → :3001"]
        user["user-service<br/>:80 → :3002"]
        notif["notification-service<br/>:80 → :3003"]
        nc["note-card-service<br/>2 replicas, :80 → :3004"]
        pg[("postgres :5432<br/>PVC postgres-pvc 1Gi")]
        mq[["rabbitmq<br/>:5672, :15672"]]
    end

    web -->|"/api/* via :80"| gw
    gw --> todo & user & nc & orch
    todo --> notif
    nc --> todo
    todo --> pg
    orch & todo & user & notif & nc <==>|AMQP| mq
```

- Each box is a Deployment plus a Service. Application Services map port `80` to the container port, which is why `discoverService()` returns port `80`. Only the gateway and `web` are reachable from outside the cluster. `web` sets `API_GATEWAY_URL=http://api-gateway`, because the gateway's Service listens on `80`.
- Every application pod has a liveness probe (every 10s) and a readiness probe (every 5s) on `/health` (`web` probes `/`). postgres and rabbitmq have no probes.
- Images come from `docker compose build` run against minikube's Docker daemon (`imagePullPolicy: Never`). There's no Consul or etcd in the cluster.
- `INSTANCE_ID` isn't set in `note-card-service.yaml`, so both replicas draw "instance 1" on the card.

| Concern | Docker Compose | Kubernetes |
|---|---|---|
| Discovery | Consul or etcd container | CoreDNS plus Service endpoints |
| Health | Consul HTTP check or etcd lease | Liveness and readiness probes |
| Two note-card instances | Two compose services, each with its own port | One Deployment with `replicas: 2` |
| Load balancing | Random pick in the caller | kube-proxy, per connection |
| Reachable from the host | Every service | Only api-gateway (NodePort `30000`) and web (NodePort `30080`) |
| PostgreSQL data | No named volume | PersistentVolumeClaim (`1Gi`) |

## Service mesh (Linkerd)

[`SERVICE_MESH.md`](../SERVICE_MESH.md) installs Linkerd on top of the Kubernetes deployment. The `todo-app` namespace carries `linkerd.io/inject: enabled`, so every pod gets a `linkerd-proxy` sidecar when it's created. The application code doesn't change.

```mermaid
flowchart LR
    subgraph cp["Linkerd control plane (namespace linkerd)"]
        ident["identity<br/>issues mTLS certificates"]
        dest["destination<br/>endpoints and route policy"]
        inj["proxy-injector<br/>adds the sidecar at pod creation"]
    end

    subgraph ns["namespace todo-app (linkerd.io/inject: enabled)"]
        subgraph gwpod["api-gateway pod"]
            gwapp["api-gateway"] --> gwproxy["linkerd-proxy"]
        end
        subgraph todopod["todo-service pod"]
            todoproxy["linkerd-proxy"] --> todoapp["todo-service"]
        end
    end

    subgraph viz["linkerd-viz"]
        prom["Prometheus"] --> dash["dashboard, tap, top"]
    end

    gwproxy ==>|"mTLS"| todoproxy
    ident -.-> gwproxy & todoproxy
    dest -.-> gwproxy
    inj -.-> ns
    prom -.->|"scrape metrics"| gwproxy & todoproxy
```

- Only two pods are drawn. After `kubectl rollout restart`, every pod in `todo-app` has a sidecar, including postgres and rabbitmq.
- The apps still call `http://todo-service:80`, and the local proxy intercepts the connection. The two proxies encrypt traffic between themselves with mTLS. That includes AMQP and PostgreSQL connections, but retries and timeouts only apply to HTTP.
- The calling side's proxy picks the target pod **per request** (EWMA, least loaded), which replaces kube-proxy's per-connection choice.

### Request path with route policies

[`k8s/linkerd/retry-policy.yaml`](../k8s/linkerd/retry-policy.yaml) attaches an `HTTPRoute` to two Services:

| HTTPRoute | Service | Matches | Timeout | Retries |
|---|---|---|---|---|
| `todo-service-route` | `todo-service:80` | `GET` | 5s | Up to 2, on 500, 502 or 503 |
| `user-service-route` | `user-service:80` | `GET` | 3s | Up to 2, on 500, 502 or 503 |

The calling side's proxy applies the policy, so the application never sees the retry:

```mermaid
sequenceDiagram
    autonumber
    participant GA as api-gateway
    participant GP as linkerd-proxy (gateway pod)
    participant TP as linkerd-proxy (todo pod)
    participant TA as todo-service

    GA->>GP: GET http://todo-service/todos (plain HTTP)
    Note over GP: route todo-service-route matches GET<br/>5s timeout starts, pick a pod (EWMA)
    GP->>TP: GET /todos over mTLS
    TP->>TA: GET /todos
    TA-->>TP: 503
    TP-->>GP: 503
    Note over GP: 503 is retryable, attempt 1 of 2
    GP->>TP: GET /todos over mTLS
    TP->>TA: GET /todos
    TA-->>TP: 200
    TP-->>GP: 200
    GP-->>GA: 200
```

> [!NOTE]
> Linkerd 2.16+ reads HTTPRoute retry settings from the `retry.linkerd.io/http` and `retry.linkerd.io/limit` annotations ([docs](https://linkerd.io/2/reference/retries/)). The `retry:` block under `spec.rules` in this manifest isn't part of that API. Check that retries are actually applied before relying on the flow above.

Injecting the sidecars restarts every pod, rabbitmq included, so all RabbitMQ connections drop; the services reconnect by themselves. [`SERVICE_MESH.md`](../SERVICE_MESH.md#known-issues) explains how to check that the consumers are back.
