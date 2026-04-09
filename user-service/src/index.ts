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
  type ValidateUserCmd,
  type TodoAssignmentRequested,
} from '../../shared/saga-types.js';

const app = express();
const PORT = 3002;
const SERVICE_NAME = 'user-service';
const SERVICE_ADDRESS = process.env.SERVICE_ADDRESS || 'user-service';

const users = [
  { id: 1, name: 'Alice Johnson', email: 'alice@example.com' },
  { id: 2, name: 'Bob Smith', email: 'bob@example.com' },
  { id: 3, name: 'Charlie Brown', email: 'charlie@example.com' },
];

app.use(express.json());
app.use(healthRoute(SERVICE_NAME));

app.get('/users/:id', (req, res) => {
  const user = users.find((u) => u.id === parseInt(req.params.id));
  if (!user) {
    res.status(404).json({ error: 'User not found' });
    return;
  }
  res.json(user);
});

// --- Orchestration Saga: RabbitMQ command handlers ---

async function setupRabbitMQ() {
  const connection = await connectRabbit();
  const channel = await createChannel(connection);
  await setupExchanges(channel);

  // Handle: validate user (orchestration command)
  await consumeQueue(
    channel,
    `saga.${ORK.CMD_USER_VALIDATE}`,
    async (cmd: ValidateUserCmd) => {
      console.log(`[SAGA-CMD] Validating user ${cmd.userId} for saga ${cmd.sagaId}`);
      const user = users.find((u) => u.id === cmd.userId);
      if (user) {
        publishMessage(channel, ORCHESTRATION_EXCHANGE, ORK.CMD_USER_VALIDATE_REPLY, {
          sagaId: cmd.sagaId,
          success: true,
          user,
          timestamp: new Date().toISOString(),
        });
      } else {
        publishMessage(channel, ORCHESTRATION_EXCHANGE, ORK.CMD_USER_VALIDATE_REPLY, {
          sagaId: cmd.sagaId,
          success: false,
          error: `User ${cmd.userId} not found`,
          timestamp: new Date().toISOString(),
        });
      }
    }
  );

  // --- Choreography Saga: event consumers ---

  // Handle: TodoAssignmentRequested → validate user, publish result event
  await consumeQueue(
    channel,
    `choreography.${CRK.TODO_ASSIGNMENT_REQUESTED}`,
    async (event: TodoAssignmentRequested) => {
      console.log(`[CHOREOGRAPHY] TodoAssignmentRequested: todo=${event.todoId}, user=${event.userId}`);
      const user = users.find((u) => u.id === event.userId);
      if (user) {
        publishMessage(channel, CHOREOGRAPHY_EXCHANGE, CRK.USER_VALIDATED, {
          correlationId: event.correlationId,
          todoId: event.todoId,
          userId: event.userId,
          user,
          timestamp: new Date().toISOString(),
        });
        console.log(`[CHOREOGRAPHY] UserValidated: user=${event.userId}`);
      } else {
        publishMessage(channel, CHOREOGRAPHY_EXCHANGE, CRK.USER_VALIDATION_FAILED, {
          correlationId: event.correlationId,
          todoId: event.todoId,
          userId: event.userId,
          reason: `User ${event.userId} not found`,
          timestamp: new Date().toISOString(),
        });
        console.log(`[CHOREOGRAPHY] UserValidationFailed: user=${event.userId}`);
      }
    }
  );

  console.log('[user-service] RabbitMQ consumers ready');
  return channel;
}

app.listen(PORT, async () => {
  console.log(`${SERVICE_NAME} running on port ${PORT}`);
  await setupRabbitMQ();
  await registerService(SERVICE_NAME, SERVICE_ADDRESS, PORT);
  setupGracefulShutdown(SERVICE_NAME, PORT);
});
