import express from 'express';
import { registerService, setupGracefulShutdown } from '../../shared/discovery.js';
import { healthRoute } from '../../shared/healthcheck.js';
import {
  connectRabbit,
  createChannel,
  setupExchanges,
  publishMessage,
  consumeQueue,
} from '../../shared/rabbitmq.js';
import {
  ORCHESTRATION_EXCHANGE,
  CHOREOGRAPHY_EXCHANGE,
  ORK,
  CRK,
  type SendNotificationCmd,
  type TodoAssignmentConfirmed,
} from '../../shared/saga-types.js';

const app = express();
const PORT = 3003;
const SERVICE_NAME = 'notification-service';
const SERVICE_ADDRESS = process.env.SERVICE_ADDRESS || 'notification-service';

app.use(express.json());
app.use(healthRoute(SERVICE_NAME));

app.post('/notify', (req, res) => {
  const { message } = req.body;
  console.log(`[Notification] 📨 ${message || 'No message provided'}`);
  res.json({ status: 'sent', message });
});

// --- Orchestration Saga: RabbitMQ command handlers ---

async function setupRabbitMQ() {
  const connection = await connectRabbit();
  const channel = await createChannel(connection);
  await setupExchanges(channel);

  // Handle: send notification (orchestration command)
  await consumeQueue(
    channel,
    `saga.${ORK.CMD_NOTIFICATION_SEND}`,
    async (cmd: SendNotificationCmd) => {
      console.log(`[SAGA-CMD] Sending notification for saga ${cmd.sagaId}: ${cmd.message}`);
      publishMessage(channel, ORCHESTRATION_EXCHANGE, ORK.CMD_NOTIFICATION_SEND_REPLY, {
        sagaId: cmd.sagaId,
        success: true,
        timestamp: new Date().toISOString(),
      });
    }
  );

  // --- Choreography Saga: event consumers ---

  // Handle: TodoAssignmentConfirmed → log notification, publish NotificationSent
  await consumeQueue(
    channel,
    `choreography.${CRK.TODO_ASSIGNMENT_CONFIRMED}`,
    async (event: TodoAssignmentConfirmed) => {
      console.log(
        `[CHOREOGRAPHY] Todo #${event.todoId} assigned to user ${event.userId} (${event.userEmail}). Todo: "${event.todoTitle}"`
      );
      publishMessage(channel, CHOREOGRAPHY_EXCHANGE, CRK.NOTIFICATION_SENT, {
        correlationId: event.correlationId,
        todoId: event.todoId,
        userId: event.userId,
        timestamp: new Date().toISOString(),
      });
      console.log(`[CHOREOGRAPHY] NotificationSent: todo=${event.todoId}`);
    }
  );

  console.log('[notification-service] RabbitMQ consumers ready');
  return channel;
}

app.listen(PORT, async () => {
  console.log(`${SERVICE_NAME} running on port ${PORT}`);
  await setupRabbitMQ();
  await registerService(SERVICE_NAME, SERVICE_ADDRESS, PORT);
  setupGracefulShutdown(SERVICE_NAME, PORT);
});
