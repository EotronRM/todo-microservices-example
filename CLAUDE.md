# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Branches

The feature branches are stacked: `main` → `feature/saga-pattern` → `feature/kubernetes` → `feature/k8s-service-mesh`. Each branch adds one concept on top of the previous one. This file and `docs/architecture.md` describe **only the code on the current branch**, and each later branch carries an extended copy of both. Carry changes up the stack with `git rebase`, not merge commits.

This copy describes `feature/saga-pattern`. On top of `main` it adds RabbitMQ, the saga-orchestrator and both saga implementations. There is no `k8s/` directory or Kubernetes discovery backend here.

## Build & Run Commands

Each service is an independent Bun project (no root package.json). Run commands from inside a service directory. **Bun** is the package manager; `package-lock.json` is gitignored.

```bash
# Install dependencies. shared/ has its own package.json and bun.lock so its imports
# (express, @cloudamqp/amqp-client) resolve outside Docker; install it once per clone.
cd shared && bun install
cd api-gateway && bun install

# Development (runs TypeScript directly via tsx)
bun run dev

# Build (compiles TypeScript to dist/)
bun run build

# Production (runs dist/<service>/src/index.js)
bun run start

# Full stack with Docker + Consul (default)
docker compose up --build

# Full stack with Docker + etcd (alternative service discovery)
docker compose -f docker-compose.etcd.yml up --build

# Rebuild a single service
docker compose build api-gateway && docker compose up
```

The Docker builds run `bun install --frozen-lockfile`. After changing dependencies, commit the updated `bun.lock`, or the image build fails.

To run services outside Docker, start only the infrastructure and point the services at `localhost`. `docker-compose.infra.yml` starts postgres, rabbitmq and consul. Use etcd for discovery, though: Consul health-checks `http://<SERVICE_ADDRESS>:<port>/health` from inside its container, where `localhost` is the container itself, so local instances never pass their checks.

```bash
docker compose -f docker-compose.infra.yml up -d postgres rabbitmq
docker compose -f docker-compose.etcd.yml up -d etcd
cd todo-service && DISCOVERY_BACKEND=etcd SERVICE_ADDRESS=localhost bun run dev
```

The web UI (`web/`) is a Vite + React + Tailwind app. `cd web && bun run dev` serves it on `:5173` and proxies `/api` to the gateway on `localhost:3000`. `bun run build` type-checks with `tsc` and bundles to `web/dist/`. Don't scaffold or extend it with tools that import the `typescript` package (see TypeScript 7 below).

No test framework is configured. `bun scripts/smoke.mts` runs end-to-end checks through the gateway and the `web` container against a running stack (start it with `docker compose up -d --build` first). It waits up to 3 minutes for every service to register, and exits non-zero if any check fails. When a branch adds features, extend the script on that branch. To exercise the API by hand, use the request files in `http/` (JetBrains HTTP Client format, `@baseUrl = http://localhost:3000`). On this branch the smoke script also runs both sagas, including their failure paths, and `saga-orchestration.http` and `saga-choreography.http` cover them for manual testing.

## Architecture

Six Express 5 microservices + a shared utility module + PostgreSQL + RabbitMQ + a React web UI, run with Docker Compose and pluggable service discovery (Consul or etcd). The note-card-service runs 2 instances to demonstrate load distribution. Mermaid diagrams of everything below are in `docs/architecture.md`. `SAGA_README.md` explains the two sagas with curl examples, and `GLOSSARY.md` defines the message broker terms.

```
Browser -> web:8080 (nginx) -> api-gateway:3000

Client -> api-gateway:3000 -> [Consul|etcd] -> todo-service:3001 (PostgreSQL-backed)
                                            -> user-service:3002
                                            -> note-card-service:3004/3005 (2 instances)
                                            -> saga-orchestrator:3010

todo-service      -> [Consul|etcd] -> notification-service:3003 (on todo creation)
note-card-service -> [Consul|etcd] -> todo-service (fetches todo to render as PNG)

[RabbitMQ] carries the saga messages between every service except api-gateway
```

**Services:**

| Service | Port | Role |
|---------|------|------|
| api-gateway | 3000 | Proxies `/api/todos/*`, `/api/users/:id`, `/api/note-card/:todoId` and `/api/saga/*` to downstream services. Answers 503 if discovery or the call fails |
| todo-service | 3001 | List, get, create, delete and assign todos at `/todos` (PostgreSQL). Calls notification-service over HTTP on create. Handles saga commands and choreography events |
| user-service | 3002 | Serves three hardcoded users at `/users/:id`. Validates users for both sagas |
| notification-service | 3003 | Receives notifications at `POST /notify` and logs them. Handles the saga notification command and event |
| note-card-service | 3004, 3005 | Generates PNG note card images at `/note-card/:todoId` via sharp+SVG. Runs 2 instances for the load distribution demo. Handles the saga card-generation command |
| saga-orchestrator | 3010 | Coordinates the "Create Full Todo" orchestration saga (`POST /saga/create-full-todo`, `GET /saga/status/:sagaId`) |
| web | 8080 | React + Tailwind UI: list, create and delete todos and view their note cards. nginx serves it and proxies `/api/` to the gateway, because the gateway sends no CORS headers. Not registered in discovery |

All services except `web` expose `/health` for liveness checks (`shared/healthcheck.ts`).

**Shared module** (`shared/`): `consul.ts`, `etcd.ts`, `discovery.ts` (adapter that picks the backend from `DISCOVERY_BACKEND` with a top-level `await import()`), `healthcheck.ts` (health route factory), `rabbitmq.ts` (connection with automatic reconnect, publish and consume helpers), `saga-types.ts` (message interfaces and exchange/routing-key constants) and `tsconfig.base.json`. Services import from `discovery.js`, never from a backend directly. Each service's `tsc` compiles `shared/` inline.

### Service Discovery: Consul vs etcd

Both backends do client-side discovery: the caller fetches all live instances and picks one at random.

| Aspect | Consul | etcd |
|--------|--------|------|
| **Type** | Purpose-built service registry | Distributed key-value store |
| **Health checking** | Server-side: Consul polls `/health` every 10s | Client-side: services renew a lease (TTL=15s) every 5s |
| **Registration** | Single API call with health check config | 3 steps: grant lease, put key, start keepalive loop |
| **Discovery** | `GET /v1/health/service/{name}?passing=true` | Prefix range query on `/services/{name}/instances/` |
| **Failure detection** | Consul stops returning unhealthy instances | Lease expires, key auto-deleted |
| **Client state** | Stateless (each call is independent) | Stateful (must track lease ID and keepalive timer) |

Both backends deregister on SIGINT/SIGTERM via `setupGracefulShutdown()`.

### Saga Pattern (RabbitMQ)

Two saga implementations, side by side for comparison:

- **Orchestration ("Create Full Todo")**: `saga-orchestrator` sends commands (`cmd.*`) through the `saga.orchestration` direct exchange, and services publish `*.reply` messages back. State lives in memory as a `SagaStep` enum, and a restart loses in-flight sagas. On failure the orchestrator publishes `cmd.todo.delete` as compensation and moves straight to `FAILED`. It doesn't wait for a reply, and `SagaStep.COMPENSATING` is never used. The state machine is a set of pure functions in `saga-orchestrator/src/orchestrator.ts`.
- **Choreography ("Assign & Notify")**: services publish and consume past-tense events through the `saga.choreography` topic exchange. `PUT /todos/:id/assign` starts the chain. The state is implicit in the todo's `status` column: `unassigned` → `assigning` → `assigned` / `assignment_failed`.

How the messaging is wired:

- `shared/saga-types.ts` is the single source of truth for routing keys (`ORK`, `CRK`) and payload types. Every service calls `setupExchanges()` at startup, which declares one durable queue per routing key (`saga.<key>` or `choreography.<key>`). Adding a key to `ORK` or `CRK` is enough to create and bind its queue.
- With one queue per key, each message is handled by exactly one consumer. Several instances on the same queue compete for messages; both note-card instances consume `saga.cmd.notecard.generate`. A second subscriber to the same event would need its own queue.
- Consumers use manual ack with `prefetch(1)`. If a handler throws, the message is nacked **without requeue**, so it is dropped.
- Each service calls `startRabbit(attachConsumers)`. It connects with 10 startup retries (2s apart), then, whenever the connection or channel is lost, reconnects with backoff (2s, 4s, … capped at 30s) and calls `attachConsumers()` again on the new channel. Publishing while disconnected fails and is only logged (`publishMessage` catches it); there's no outbox, so a saga started during an outage stalls at its first step.
- `todo.assignment.rolledback` and `notification.sent` are published, but nothing consumes them.
- Startup order in each service is: database (todo-service only), then RabbitMQ, then discovery registration. A service only becomes discoverable once its consumers are attached.
- In all three compose files, postgres and rabbitmq have healthchecks (`pg_isready`, `rabbitmq-diagnostics check_port_connectivity`), and the services that need them wait for `service_healthy`, so the in-code retry loops normally succeed on the first try. Consul only starts returning a service after its first passing check, which can take up to 10s, so the gateway may answer 503 for a few seconds after `up`.
- Grep the logs for `[ORCHESTRATOR]`, `[SAGA-CMD]` and `[CHOREOGRAPHY]`. The RabbitMQ management UI is at http://localhost:15672 (guest/guest) with `docker-compose.yml`. The infra file's `rabbitmq:4.2-alpine` image doesn't include the UI.

## Key Technical Patterns

- **ESM + TypeScript 7**: All services use `"type": "module"` with `module: "nodenext"`. Relative imports require `.js` extensions even in `.ts` files.
- **TypeScript 7 toolchain**: `tsc` is the native Go compiler (`typescript@7`). It ships no `tsserver` and, in 7.0, no programmatic API, so tools that import the `typescript` package (ts-jest, typescript-eslint, and similar) won't work with it yet. `tsx` is unaffected because it transpiles with esbuild.
- **Shared code compilation**: Each service's `tsconfig.json` sets `rootDir: ".."` and includes `"../shared/**/*"`. Output lands in `dist/shared/` and `dist/<service>/src/`.
- **Dockerfiles**: multi-stage. The `oven/bun:1-alpine` stage copies `shared/` and the service into `/app` to mirror the repo layout, runs `bun install --frozen-lockfile`, symlinks the service's `node_modules` to `/app/node_modules` so `shared/` resolves its imports, and runs `bunx tsc`. The `node:20-alpine` runtime stage copies only `dist/` and `node_modules/`. `.dockerignore` keeps host `node_modules/` and `dist/` out of the build context. The note-card runtime image also installs `fontconfig` and `ttf-dejavu` so librsvg can render SVG `<text>`. `web/Dockerfile` differs: it copies only `web/`, runs `bun run build` (tsc + Vite), and its `nginx:1-alpine` runtime stage serves `dist/`. `web/nginx.conf.template` goes in `/etc/nginx/templates/`, where the nginx image fills in `${API_GATEWAY_URL}` at startup.
- **Multi-instance**: note-card-service runs 2 instances (ports 3004, 3005) under the same service name with different IDs (`note-card-service-3004`, `note-card-service-3005`). The `INSTANCE_ID` env var is drawn on the card and sent in the `X-Served-By` header. The gateway only forwards `Content-Type`, so that header is visible only when calling an instance directly.
- **Database**: todo-service uses PostgreSQL via the `pg` package with the `DATABASE_URL` env var. It creates the `todos` table (`id`, `title`, `completed`, `user_id`, `status` defaulting to `'unassigned'`) on startup, and runs `ALTER TABLE … ADD COLUMN IF NOT EXISTS` for databases created on `main`. It retries 5 times 2s apart while the container starts.
- **Express CJS interop**: Express 5 is still CJS. `esModuleInterop: true` and `verbatimModuleSyntax: false` in the base tsconfig enable `import express from 'express'` under nodenext.

## Environment Variables

| Variable | Used by | Purpose |
|----------|---------|---------|
| `DISCOVERY_BACKEND` | All services | `consul` (default) or `etcd`: selects the service discovery backend |
| `CONSUL_HOST` | All services | Consul API hostname (default: `localhost`) |
| `CONSUL_PORT` | All services | Consul API port (default: `8500`) |
| `ETCD_HOST` | All services | etcd API hostname (default: `localhost`) |
| `ETCD_PORT` | All services | etcd API port (default: `2379`) |
| `SERVICE_ADDRESS` | All services | How other services reach this one (default: the service name) |
| `RABBITMQ_URL` | All services except api-gateway | RabbitMQ connection string (default: `amqp://guest:guest@localhost:5672`) |
| `DATABASE_URL` | todo-service | PostgreSQL connection string (default: `postgresql://postgres:postgres@localhost:5432/todos`) |
| `PORT` | note-card-service | HTTP port (default: `3004`), set per instance |
| `INSTANCE_ID` | note-card-service | Instance identifier shown in logs and on generated cards (default: `1`) |
| `API_GATEWAY_URL` | web | Where nginx proxies `/api/` (default: `http://api-gateway:3000`, set in `web/Dockerfile`) |
