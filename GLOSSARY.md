# Message Broker Glossary

## Core Concepts

| Term | Definition |
|------|-----------|
| **Message** | A unit of data sent between services. Contains a body (payload) and metadata (headers, properties) |
| **Producer / Publisher** | The service that sends messages |
| **Consumer / Subscriber** | The service that receives and processes messages |
| **Broker** | The middleware that accepts, routes, and delivers messages (e.g., RabbitMQ, Kafka, ActiveMQ) |

## Routing & Topology

| Term | Definition |
|------|-----------|
| **Exchange** | Entry point for messages in AMQP 0-9-1. Routes messages to queues based on type and rules |
| **Queue** | A buffer that stores messages until a consumer processes them |
| **Binding** | A rule that connects an exchange to a queue, optionally filtered by a routing key or pattern |
| **Routing Key** | A string attached to a message that exchanges use to decide which queues receive it |
| **Direct Exchange** | Routes to queues whose binding key exactly matches the routing key. One-to-one delivery |
| **Topic Exchange** | Routes based on wildcard pattern matching (`*.user.#`). One-to-many delivery |
| **Fanout Exchange** | Broadcasts to all bound queues, ignoring routing keys |
| **Headers Exchange** | Routes based on message header values instead of routing keys |
| **Dead Letter Exchange (DLX)** | An exchange that receives messages that couldn't be delivered or were rejected/expired |

## Delivery & Reliability

| Term | Definition |
|------|-----------|
| **Ack (Acknowledge)** | Consumer tells the broker it successfully processed a message. Broker removes it from the queue |
| **Nack (Negative Acknowledge)** | Consumer tells the broker it failed to process. Broker can requeue or discard the message |
| **Requeue** | Return a nacked message to the queue for another attempt |
| **Prefetch** | Limits how many unacknowledged messages a consumer can hold at once. Prevents one fast consumer from hoarding all messages |
| **Persistent / Durable Message** | Message is written to disk so it survives broker restarts (`deliveryMode: 2`) |
| **Durable Queue** | Queue definition survives broker restarts (but messages only survive if also persistent) |
| **Transient** | Opposite of durable -- lost on broker restart |
| **At-most-once** | Message delivered 0 or 1 times. No retries. Risk: message loss |
| **At-least-once** | Message delivered 1 or more times. Retries on failure. Risk: duplicates |
| **Exactly-once** | Message delivered exactly 1 time. Hard to achieve; usually requires idempotent consumers + deduplication |

## Patterns

| Term | Definition |
|------|-----------|
| **Pub/Sub (Publish-Subscribe)** | Publisher sends to a topic/exchange; multiple consumers each get a copy |
| **Work Queue (Competing Consumers)** | Multiple consumers share a single queue. Each message goes to only one consumer. Distributes load |
| **Request-Reply (RPC)** | Producer sends a message and waits for a response on a reply queue |
| **Dead Letter Queue (DLQ)** | A queue attached to a DLX that collects failed/expired messages for inspection or reprocessing |
| **Saga** | A sequence of local transactions across services, with compensation steps to undo on failure |
| **Orchestration** | A central coordinator tells each service what to do via commands |
| **Choreography** | Services react to events and emit new events. No central coordinator |
| **Compensation** | The undo action for a saga step (e.g., delete the todo if user validation fails) |
| **Idempotency** | Processing the same message multiple times produces the same result. Essential for at-least-once delivery |

## Connection & Channels

| Term | Definition |
|------|-----------|
| **Connection** | A TCP link between a client and the broker. Expensive to create |
| **Channel** | A lightweight virtual connection multiplexed over a single TCP connection. Cheap to create. One per thread/consumer is typical |
| **Virtual Host (vhost)** | A logical namespace within a broker. Isolates exchanges, queues, and permissions (like a database schema) |
| **Heartbeat** | Periodic ping between client and broker to detect dead connections |

## Advanced

| Term | Definition |
|------|-----------|
| **TTL (Time-to-Live)** | Maximum time a message can sit in a queue before being discarded or dead-lettered |
| **Backpressure** | Flow control when a consumer can't keep up. The broker or producer slows down to avoid overwhelming the system |
| **Consumer Tag** | An identifier for a consumer subscription. Used to cancel a specific consumer |
| **Correlation ID** | An ID attached to messages to link requests with replies or track messages across a saga |
| **Message Priority** | Queues can optionally order messages by priority level (0-255) |
| **Shovel / Federation** | RabbitMQ features for moving messages between brokers across networks or data centers |
| **Quorum Queue** | A replicated queue type in RabbitMQ for high availability. Replaces classic mirrored queues |
| **Stream** | An append-only log in RabbitMQ (since 3.9). Similar to Kafka topics -- consumers can replay from any offset |
