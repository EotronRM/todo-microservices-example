import express from 'express';
import { randomUUID } from 'crypto';
import {
  registerService,
  setupGracefulShutdown,
} from '../../shared/discovery.js';
import { healthRoute } from '../../shared/healthcheck.js';
import {
  connectRabbit,
  createChannel,
  setupExchanges,
  publishMessage,
  consumeQueue,
} from '../../shared/rabbitmq.js';
import {
  SagaStep,
  ORCHESTRATION_EXCHANGE,
  ORK,
  type CreateTodoReply,
  type ValidateUserReply,
  type SendNotificationReply,
  type GenerateNoteCardReply,
} from '../../shared/saga-types.js';
import { SagaStore } from './saga-state.js';
import {
  handleCreateTodoReply,
  handleValidateUserReply,
  handleSendNotificationReply,
  handleGenerateNoteCardReply,
} from './orchestrator.js';

const app = express();
const PORT = 3010;
const SERVICE_NAME = 'saga-orchestrator';
const SERVICE_ADDRESS = process.env.SERVICE_ADDRESS || 'saga-orchestrator';

const store = new SagaStore();

app.use(express.json());
app.use(healthRoute(SERVICE_NAME));

// --- HTTP Endpoints ---

app.post('/saga/create-full-todo', async (req, res) => {
  const { title, userId } = req.body;
  if (!title || userId === undefined) {
    res.status(400).json({ error: 'title and userId are required' });
    return;
  }

  const sagaId = randomUUID();
  const state = store.create(sagaId, { title, userId: Number(userId) });

  // Publish the first command: create the todo
  publishMessage(channel!, ORCHESTRATION_EXCHANGE, ORK.CMD_TODO_CREATE, {
    sagaId,
    title,
    userId: Number(userId),
    timestamp: new Date().toISOString(),
  });

  res.status(202).json({ sagaId, status: state.step });
});

app.get('/saga/status/:sagaId', (req, res) => {
  const state = store.get(req.params.sagaId);
  if (!state) {
    res.status(404).json({ error: 'Saga not found' });
    return;
  }
  res.json(state);
});

// --- RabbitMQ Setup & Reply Handlers ---

let channel: Awaited<ReturnType<typeof createChannel>> | null = null;

function applyTransition(
  sagaId: string,
  transition: ReturnType<typeof handleCreateTodoReply>
) {
  const updated = store.update(sagaId, transition.updates);
  if (transition.publish) {
    publishMessage(
      channel!,
      transition.publish.exchange,
      transition.publish.routingKey,
      transition.publish.payload
    );
  }
  return updated;
}

async function setupRabbitMQ() {
  const connection = await connectRabbit();
  channel = await createChannel(connection);
  await setupExchanges(channel);

  // Listen for replies from downstream services
  await consumeQueue(
    channel,
    `saga.${ORK.CMD_TODO_CREATE_REPLY}`,
    async (reply: CreateTodoReply) => {
      const state = store.get(reply.sagaId);
      if (!state || state.step !== SagaStep.CREATING_TODO) return;
      applyTransition(reply.sagaId, handleCreateTodoReply(state, reply));
    }
  );

  await consumeQueue(
    channel,
    `saga.${ORK.CMD_USER_VALIDATE_REPLY}`,
    async (reply: ValidateUserReply) => {
      const state = store.get(reply.sagaId);
      if (!state || state.step !== SagaStep.VALIDATING_USER) return;
      applyTransition(reply.sagaId, handleValidateUserReply(state, reply));
    }
  );

  await consumeQueue(
    channel,
    `saga.${ORK.CMD_NOTIFICATION_SEND_REPLY}`,
    async (reply: SendNotificationReply) => {
      const state = store.get(reply.sagaId);
      if (!state || state.step !== SagaStep.SENDING_NOTIFICATION) return;
      applyTransition(reply.sagaId, handleSendNotificationReply(state, reply));
    }
  );

  await consumeQueue(
    channel,
    `saga.${ORK.CMD_NOTECARD_GENERATE_REPLY}`,
    async (reply: GenerateNoteCardReply) => {
      const state = store.get(reply.sagaId);
      if (!state || state.step !== SagaStep.GENERATING_NOTECARD) return;
      applyTransition(reply.sagaId, handleGenerateNoteCardReply(state, reply));
    }
  );

  console.log('[ORCHESTRATOR] Listening for saga replies');
}

// --- Start ---

app.listen(PORT, async () => {
  console.log(`${SERVICE_NAME} running on port ${PORT}`);
  await setupRabbitMQ();
  await registerService(SERVICE_NAME, SERVICE_ADDRESS, PORT);
  setupGracefulShutdown(SERVICE_NAME, PORT);
});
