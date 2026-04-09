# Microservices Demo

A microservices architecture demo built with Express 5, TypeScript 6, and Docker Compose. Features pluggable service discovery (Consul or etcd), PostgreSQL persistence, multi-instance load distribution, and **saga pattern implementations** (orchestration and choreography) with RabbitMQ.

## Requirements

- [Docker](https://docs.docker.com/get-docker/) and [Docker Compose](https://docs.docker.com/compose/install/)
- [Node.js 20+](https://nodejs.org/) (only for local development without Docker)
- npm (included with Node.js)

## Quick Start

### Run with Docker (Consul — default)

```bash
docker compose up --build
```

### Run with Docker (etcd — alternative)

```bash
docker compose -f docker-compose.etcd.yml up --build
```

Once running, the API gateway is available at `http://localhost:3000`.

### Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/todos` | List all todos |
| POST | `/api/todos` | Create a todo (sends notification) |
| GET | `/api/todos/:id` | Get a single todo |
| DELETE | `/api/todos/:id` | Delete a todo |
| PUT | `/api/todos/:id/assign` | Assign todo to user (choreography saga) |
| GET | `/api/users/:id` | Get user by ID |
| GET | `/api/note-card/:todoId` | Generate a PNG card for a todo |
| POST | `/api/saga/create-full-todo` | Start orchestration saga |
| GET | `/api/saga/status/:sagaId` | Check orchestration saga status |

### Example requests

```bash
# Create a todo
curl -X POST http://localhost:3000/api/todos \
  -H "Content-Type: application/json" \
  -d '{"title": "Buy groceries", "description": "Milk, eggs, bread"}'

# List all todos
curl http://localhost:3000/api/todos

# Get a user
curl http://localhost:3000/api/users/1

# Generate a note card image for todo ID 1
curl http://localhost:3000/api/note-card/1 --output card.png
```

## Architecture

```
Client -> api-gateway:3000 -> [Service Discovery] -> todo-service:3001 (PostgreSQL)
                                                   -> user-service:3002
                                                   -> note-card-service:3004/3005 (2 instances)

todo-service -> [Service Discovery] -> notification-service:3003 (on todo creation)
note-card-service -> [Service Discovery] -> todo-service (fetches todo to render as PNG)
```

### Services

| Service | Port | Description |
|---------|------|-------------|
| api-gateway | 3000 | Routes requests to downstream services |
| todo-service | 3001 | CRUD for todos, backed by PostgreSQL |
| user-service | 3002 | Serves hardcoded user data |
| notification-service | 3003 | Receives and logs notifications |
| note-card-service | 3004, 3005 | Generates PNG note card images (2 instances) |
| saga-orchestrator | 3010 | Orchestration saga coordinator |

### Infrastructure

| Component | Port | Purpose |
|-----------|------|---------|
| PostgreSQL | 5432 | Persistent storage for todos |
| Consul | 8500 | Service discovery (default backend) |
| etcd | 2379 | Service discovery (alternative backend) |
| RabbitMQ | 5672, 15672 | Message broker (AMQP + Management UI) |

## Saga Pattern

This project implements both saga patterns side-by-side for educational comparison.

### Orchestration: "Create Full Todo"

A centralized `saga-orchestrator` service coordinates the entire workflow by sending commands and waiting for replies.

```
saga-orchestrator --cmd.todo.create--> todo-service
                  <--reply--
                  --cmd.user.validate--> user-service
                  <--reply--
                  --cmd.notification.send--> notification-service
                  <--reply--
                  --cmd.notecard.generate--> note-card-service
                  <--reply--
                  --> COMPLETED

On failure (e.g., user not found):
                  --cmd.todo.delete--> todo-service (compensation)
                  --> FAILED
```

**Try it:**
```bash
# Start the saga (returns sagaId)
curl -X POST http://localhost:3000/api/saga/create-full-todo \
  -H "Content-Type: application/json" \
  -d '{"title": "Learn sagas", "userId": 1}'

# Check status
curl http://localhost:3000/api/saga/status/<sagaId>

# Test compensation (invalid user)
curl -X POST http://localhost:3000/api/saga/create-full-todo \
  -H "Content-Type: application/json" \
  -d '{"title": "Will be rolled back", "userId": 999}'
```

### Choreography: "Assign & Notify"

No central coordinator. Each service reacts to events and emits the next event in the chain.

```
todo-service --TodoAssignmentRequested--> user-service
user-service --UserValidated--> todo-service
todo-service --TodoAssignmentConfirmed--> notification-service
notification-service --NotificationSent--> (done)

On failure (user not found):
user-service --UserValidationFailed--> todo-service
todo-service --TodoAssignmentRolledBack--> (done)
```

**Try it:**
```bash
# Create a todo first
curl -X POST http://localhost:3000/api/todos \
  -H "Content-Type: application/json" \
  -d '{"title": "Assign me"}'

# Assign to user (returns 202, status = "assigning")
curl -X PUT http://localhost:3000/api/todos/1/assign \
  -H "Content-Type: application/json" \
  -d '{"userId": 1}'

# Check assignment status (should show status = "assigned")
curl http://localhost:3000/api/todos/1

# Test compensation (assign to non-existent user)
curl -X PUT http://localhost:3000/api/todos/1/assign \
  -H "Content-Type: application/json" \
  -d '{"userId": 999}'
```

### Key Differences

| Aspect | Orchestration | Choreography |
|--------|--------------|--------------|
| Exchange type | `direct` (point-to-point) | `topic` (broadcast events) |
| Message naming | `cmd.*` (imperative) | Past-tense events (declarative) |
| Workflow knowledge | Centralized in orchestrator | Distributed across services |
| State tracking | Explicit state machine | Implicit in DB `status` column |
| Compensation | Orchestrator decides and triggers | Each service handles own rollback |
| New service needed | Yes (`saga-orchestrator`) | No |

### RabbitMQ Management UI

Visit http://localhost:15672 (guest/guest) to inspect exchanges, queues, and message rates.

### Observing the Flow

Use `docker compose logs -f` and watch for log prefixes:
- `[ORCHESTRATOR]` — saga state transitions
- `[SAGA-CMD]` — command handling by downstream services
- `[CHOREOGRAPHY]` — event-driven flow between services

## Local Development (without Docker)

Each service is an independent Node.js project. You need Consul (or etcd) and PostgreSQL running locally.

```bash
# Install dependencies for a service
cd todo-service && npm install

# Run in development mode (uses tsx for live TypeScript execution)
npm run dev

# Build TypeScript to JavaScript
npm run build

# Run the compiled build
npm start
```

Repeat for each service you want to run.

### Environment Variables

| Variable | Used by | Default | Purpose |
|----------|---------|---------|---------|
| `DISCOVERY_BACKEND` | All services | `consul` | `consul` or `etcd` |
| `CONSUL_HOST` | All services | `localhost` | Consul API hostname |
| `ETCD_HOST` | All services | `localhost` | etcd API hostname |
| `ETCD_PORT` | All services | `2379` | etcd API port |
| `SERVICE_ADDRESS` | All services | service name | Address other services use to reach this one |
| `DATABASE_URL` | todo-service | — | PostgreSQL connection string |
| `PORT` | note-card-service | `3004` | HTTP port |
| `INSTANCE_ID` | note-card-service | — | Instance identifier shown on generated cards |
| `RABBITMQ_URL` | All services | `amqp://guest:guest@localhost:5672` | RabbitMQ connection string |

## Rebuilding a Single Service

```bash
docker compose build api-gateway && docker compose up
```

## Stopping

```bash
docker compose down
```
