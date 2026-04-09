# Saga Pattern

This project implements both saga patterns side-by-side for educational comparison. See also the [Message Broker Glossary](GLOSSARY.md) for terminology.

## Orchestration: "Create Full Todo"

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

## Choreography: "Assign & Notify"

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

## Key Differences

| Aspect | Orchestration | Choreography |
|--------|--------------|--------------|
| Exchange type | `direct` (point-to-point) | `topic` (broadcast events) |
| Message naming | `cmd.*` (imperative) | Past-tense events (declarative) |
| Workflow knowledge | Centralized in orchestrator | Distributed across services |
| State tracking | Explicit state machine | Implicit in DB `status` column |
| Compensation | Orchestrator decides and triggers | Each service handles own rollback |
| New service needed | Yes (`saga-orchestrator`) | No |

## RabbitMQ Management UI

Visit http://localhost:15672 (guest/guest) to inspect exchanges, queues, and message rates.

## Observing the Flow

Use `docker compose logs -f` and watch for log prefixes:
- `[ORCHESTRATOR]` — saga state transitions
- `[SAGA-CMD]` — command handling by downstream services
- `[CHOREOGRAPHY]` — event-driven flow between services
