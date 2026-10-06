# Architecture

> This copy describes the **`main`** branch. Each feature branch has its own copy of this file, extended with what that branch adds:
>
> | Branch | Adds |
> |---|---|
> | `main` | HTTP microservices, PostgreSQL, client-side discovery with Consul or etcd |
> | `feature/saga-pattern` | RabbitMQ, `saga-orchestrator`, orchestration and choreography sagas |
> | `feature/kubernetes` | Kubernetes manifests and a DNS-based discovery backend |
> | `feature/k8s-service-mesh` | Linkerd sidecars, mTLS, retry and timeout policies |

The diagrams are [Mermaid](https://mermaid.js.org/). GitHub renders them inline, and [mermaid.live](https://mermaid.live) is handy for editing them.

## System overview

```mermaid
flowchart LR
    client([Client])

    subgraph services["Application services"]
        gw["api-gateway<br/>:3000"]
        todo["todo-service<br/>:3001"]
        user["user-service<br/>:3002"]
        notif["notification-service<br/>:3003"]
        nc1["note-card-service-1<br/>:3004"]
        nc2["note-card-service-2<br/>:3005"]
    end

    pg[("PostgreSQL<br/>todos table")]
    reg{{"Service registry<br/>Consul :8500 or etcd :2379"}}

    client -->|"/api/*"| gw
    gw -->|"/todos"| todo
    gw -->|"/users/:id"| user
    gw -->|"/note-card/:todoId"| nc1 & nc2
    todo -->|"POST /notify"| notif
    nc1 & nc2 -->|"GET /todos/:id"| todo
    todo --> pg
    services -.->|"register + discover"| reg
```

- Solid arrows are HTTP calls. Every service registers itself in the registry on startup, and every caller looks up a healthy instance before each call (dotted arrow).
- `note-card-service` runs as two instances under one service name. Callers pick one of them at random.
- `user-service` serves three hardcoded users, and `notification-service` only logs what it receives.
- `todo-service` creates the `todos` table (`id`, `title`, `completed`) on startup. It retries 5 times, 2s apart, while PostgreSQL starts.

The gateway is the only entry point:

| Gateway route | Forwards to |
|---|---|
| `GET /api/todos`, `POST /api/todos` | todo-service `/todos` |
| `GET /api/todos/:id`, `DELETE /api/todos/:id` | todo-service `/todos/:id` |
| `GET /api/users/:id` | user-service `/users/:id` |
| `GET /api/note-card/:todoId` | note-card-service `/note-card/:todoId` (binary passthrough) |

If discovery or the downstream call throws, the gateway answers `503 {"error": "<service> unavailable"}`.

## Service discovery

Services never hardcode each other's addresses. They import [`shared/discovery.ts`](../shared/discovery.ts), which loads a backend at startup based on `DISCOVERY_BACKEND`:

```mermaid
flowchart LR
    code["Service code"] -->|"registerService()<br/>discoverService()<br/>setupGracefulShutdown()"| adapter["shared/discovery.ts"]
    adapter -->|"consul (default)"| consul["shared/consul.ts"]
    adapter -->|"etcd"| etcd["shared/etcd.ts"]
```

Both backends use **client-side discovery**: the registry returns every live instance, and the caller picks one at random. That random pick is what spreads traffic across the two note-card instances.

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

### Consul vs etcd

| | Consul ([`consul.ts`](../shared/consul.ts)) | etcd ([`etcd.ts`](../shared/etcd.ts)) |
|---|---|---|
| Who checks health | Consul polls `/health` (server-side) | The service renews its lease (client-side) |
| Registration | One API call | Grant a lease, put the key, start a keepalive timer |
| Discovery query | `GET /v1/health/service/{name}?passing=true` | Prefix range on `/services/{name}/instances/` |
| A crashed instance disappears after | The next failed check (every 10s) | The lease TTL (15s) |
| State kept inside the service | None | Lease ID and keepalive timer |

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
    Note over G: discoverService("note-card-service")<br/>2 instances, random pick
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

## Running the stack

| Compose file | Registry | Containers |
|---|---|---|
| [`docker-compose.yml`](../docker-compose.yml) | Consul 1.15 dev agent on `:8500` (includes the UI) | postgres, consul, api-gateway, todo-service, user-service, notification-service, note-card-service-1, note-card-service-2 |
| [`docker-compose.etcd.yml`](../docker-compose.etcd.yml) | etcd on `:2379`, with `DISCOVERY_BACKEND=etcd` on every service | The same, with etcd instead of consul |

Each service registers under its `SERVICE_ADDRESS` (its compose service name), so the registry hands out hostnames on the Docker network. Every container also publishes its port on the host.
