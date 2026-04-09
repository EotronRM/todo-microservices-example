import { AMQPClient, AMQPChannel } from '@cloudamqp/amqp-client';
import {
  ORCHESTRATION_EXCHANGE,
  CHOREOGRAPHY_EXCHANGE,
  ORK,
  CRK,
} from './saga-types.js';

const RABBITMQ_URL = process.env.RABBITMQ_URL || 'amqp://guest:guest@localhost:5672';

// --- Connection with retry (same pattern as initDb in todo-service) ---

export async function connectRabbit(retries = 10): Promise<AMQPClient> {
  for (let i = 0; i < retries; i++) {
    try {
      const client = new AMQPClient(RABBITMQ_URL);
      await client.connect();
      console.log('[rabbitmq] Connected');
      return client;
    } catch (err) {
      console.log(
        `[rabbitmq] Not ready, retrying in 2s... (${i + 1}/${retries})`
      );
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
  throw new Error('[rabbitmq] Failed to connect after retries');
}

// --- Channel creation ---

export async function createChannel(
  connection: AMQPClient
): Promise<AMQPChannel> {
  const channel = await connection.channel();
  await channel.prefetch(1);
  return channel;
}

// --- Exchange & Queue setup (idempotent — safe for every service to call) ---

export async function setupExchanges(channel: AMQPChannel): Promise<void> {
  // Orchestration: direct exchange (point-to-point commands)
  await channel.exchangeDeclare(ORCHESTRATION_EXCHANGE, 'direct', {
    durable: true,
  });

  // Choreography: topic exchange (broadcast events)
  await channel.exchangeDeclare(CHOREOGRAPHY_EXCHANGE, 'topic', {
    durable: true,
  });

  // Assert and bind orchestration queues
  for (const routingKey of Object.values(ORK)) {
    const queue = `saga.${routingKey}`;
    await channel.queueDeclare(queue, { durable: true });
    await channel.queueBind(queue, ORCHESTRATION_EXCHANGE, routingKey);
  }

  // Assert and bind choreography queues
  for (const routingKey of Object.values(CRK)) {
    const queue = `choreography.${routingKey}`;
    await channel.queueDeclare(queue, { durable: true });
    await channel.queueBind(queue, CHOREOGRAPHY_EXCHANGE, routingKey);
  }

  console.log('[rabbitmq] Exchanges and queues ready');
}

// --- Publish ---

export function publishMessage(
  channel: AMQPChannel,
  exchange: string,
  routingKey: string,
  payload: object
): void {
  channel.basicPublish(exchange, routingKey, JSON.stringify(payload), {
    deliveryMode: 2,
  });
}

// --- Consume ---

export async function consumeQueue(
  channel: AMQPChannel,
  queue: string,
  handler: (msg: any) => Promise<void>
): Promise<void> {
  await channel.basicConsume(queue, { noAck: false }, async (msg) => {
    if (!msg) return;
    try {
      const payload = JSON.parse(msg.bodyToString() ?? '');
      await handler(payload);
      await msg.ack();
    } catch (err) {
      console.error(`[rabbitmq] Error processing message from ${queue}:`, err);
      // Reject and don't requeue to avoid infinite loops
      await msg.nack(false);
    }
  });
}
