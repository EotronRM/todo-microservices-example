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

export type { AMQPChannel };

// --- Connection lifecycle with automatic reconnect ---

const RECONNECT_BASE_DELAY_MS = 2000;
const RECONNECT_MAX_DELAY_MS = 30000;

/**
 * Connects (with connectRabbit's startup retries), declares the exchanges and
 * queues, then calls `attach` with a fresh channel so the service can register
 * its consumers. If the connection or channel is lost later, it reconnects with
 * backoff and calls `attach` again on the new channel. The client library
 * doesn't reconnect on its own, so without this a broker restart silently
 * leaves a service running with no consumers.
 */
export async function startRabbit(
  attach: (channel: AMQPChannel) => Promise<void>
): Promise<void> {
  let reconnecting = false;

  async function open(connection: AMQPClient): Promise<void> {
    const channel = await createChannel(connection);
    await setupExchanges(channel);
    await attach(channel);

    const lost = (reason: string) => {
      if (reconnecting) return;
      reconnecting = true;
      console.error(`[rabbitmq] Connection lost (${reason}), reconnecting...`);
      // Ignore further events from the old connection and make sure it's closed
      connection.onerror = () => {};
      channel.onerror = () => {};
      connection.close().catch(() => {});
      void reconnect();
    };
    connection.onerror = (err) => lost(err.message);
    channel.onerror = (reason) => lost(`channel closed: ${reason}`);
  }

  async function reconnect(): Promise<void> {
    for (let attempt = 1; ; attempt++) {
      const delay = Math.min(RECONNECT_BASE_DELAY_MS * attempt, RECONNECT_MAX_DELAY_MS);
      await new Promise((r) => setTimeout(r, delay));
      const connection = new AMQPClient(RABBITMQ_URL);
      try {
        await connection.connect();
        await open(connection);
        reconnecting = false;
        console.log(`[rabbitmq] Reconnected (attempt ${attempt})`);
        return;
      } catch (err) {
        connection.close().catch(() => {});
        console.log(
          `[rabbitmq] Reconnect attempt ${attempt} failed: ${(err as Error).message}`
        );
      }
    }
  }

  await open(await connectRabbit());
}

// --- Publish ---

export function publishMessage(
  channel: AMQPChannel,
  exchange: string,
  routingKey: string,
  payload: object
): void {
  // basicPublish rejects when the channel is closed (e.g. while reconnecting).
  // Log it instead of leaving an unhandled rejection that would crash the process.
  channel
    .basicPublish(exchange, routingKey, JSON.stringify(payload), {
      deliveryMode: 2,
    })
    .catch((err) =>
      console.error(
        `[rabbitmq] Publish to ${exchange} (${routingKey}) failed: ${(err as Error).message}`
      )
    );
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
