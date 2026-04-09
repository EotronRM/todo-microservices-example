import amqplib from 'amqplib';
import {
  ORCHESTRATION_EXCHANGE,
  CHOREOGRAPHY_EXCHANGE,
  ORK,
  CRK,
} from './saga-types.js';

const RABBITMQ_URL = process.env.RABBITMQ_URL || 'amqp://guest:guest@localhost:5672';

// --- Connection with retry (same pattern as initDb in todo-service) ---

export async function connectRabbit(retries = 10): Promise<amqplib.ChannelModel> {
  for (let i = 0; i < retries; i++) {
    try {
      const connection = await amqplib.connect(RABBITMQ_URL);
      console.log('[rabbitmq] Connected');
      return connection;
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
  connection: amqplib.ChannelModel
): Promise<amqplib.Channel> {
  const channel = await connection.createChannel();
  await channel.prefetch(1);
  return channel;
}

// --- Exchange & Queue setup (idempotent — safe for every service to call) ---

export async function setupExchanges(channel: amqplib.Channel): Promise<void> {
  // Orchestration: direct exchange (point-to-point commands)
  await channel.assertExchange(ORCHESTRATION_EXCHANGE, 'direct', {
    durable: true,
  });

  // Choreography: topic exchange (broadcast events)
  await channel.assertExchange(CHOREOGRAPHY_EXCHANGE, 'topic', {
    durable: true,
  });

  // Assert and bind orchestration queues
  for (const routingKey of Object.values(ORK)) {
    const queue = `saga.${routingKey}`;
    await channel.assertQueue(queue, { durable: true });
    await channel.bindQueue(queue, ORCHESTRATION_EXCHANGE, routingKey);
  }

  // Assert and bind choreography queues
  for (const routingKey of Object.values(CRK)) {
    const queue = `choreography.${routingKey}`;
    await channel.assertQueue(queue, { durable: true });
    await channel.bindQueue(queue, CHOREOGRAPHY_EXCHANGE, routingKey);
  }

  console.log('[rabbitmq] Exchanges and queues ready');
}

// --- Publish ---

export function publishMessage(
  channel: amqplib.Channel,
  exchange: string,
  routingKey: string,
  payload: object
): void {
  const buffer = Buffer.from(JSON.stringify(payload));
  channel.publish(exchange, routingKey, buffer, { persistent: true });
}

// --- Consume ---

export async function consumeQueue(
  channel: amqplib.Channel,
  queue: string,
  handler: (msg: any) => Promise<void>
): Promise<void> {
  await channel.consume(queue, async (msg) => {
    if (!msg) return;
    try {
      const payload = JSON.parse(msg.content.toString());
      await handler(payload);
      channel.ack(msg);
    } catch (err) {
      console.error(`[rabbitmq] Error processing message from ${queue}:`, err);
      // Reject and don't requeue to avoid infinite loops
      channel.nack(msg, false, false);
    }
  });
}
