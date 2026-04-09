import express from 'express';
import pg from 'pg';
import {
  registerService,
  discoverService,
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
  ORCHESTRATION_EXCHANGE,
  CHOREOGRAPHY_EXCHANGE,
  ORK,
  CRK,
  type CreateTodoCmd,
  type DeleteTodoCmd,
  type UserValidated,
  type UserValidationFailed,
} from '../../shared/saga-types.js';

const app = express();
const PORT = 3001;
const SERVICE_NAME = 'todo-service';
const SERVICE_ADDRESS = process.env.SERVICE_ADDRESS || 'todo-service';

interface Todo {
  id: number;
  title: string;
  completed: boolean;
}

const pool = new pg.Pool({
  connectionString:
    process.env.DATABASE_URL ||
    'postgresql://postgres:postgres@localhost:5432/todos',
});

async function initDb(retries = 5): Promise<void> {
  for (let i = 0; i < retries; i++) {
    try {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS todos (
          id SERIAL PRIMARY KEY,
          title TEXT NOT NULL,
          completed BOOLEAN NOT NULL DEFAULT false,
          user_id INTEGER,
          status TEXT NOT NULL DEFAULT 'unassigned'
        )
      `);
      // Add columns if table already exists (idempotent migration)
      await pool.query(`ALTER TABLE todos ADD COLUMN IF NOT EXISTS user_id INTEGER`);
      await pool.query(`ALTER TABLE todos ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'unassigned'`);
      console.log('[todo-service] Database initialized');
      return;
    } catch (err) {
      console.log(
        `[todo-service] DB not ready, retrying in 2s... (${i + 1}/${retries})`
      );
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
  throw new Error('[todo-service] Failed to connect to database');
}

app.use(express.json());
app.use(healthRoute(SERVICE_NAME));

app.get('/todos', async (_req, res) => {
  const result = await pool.query('SELECT * FROM todos ORDER BY id');
  res.json(result.rows);
});

app.get('/todos/:id', async (req, res) => {
  const id = parseInt(req.params.id);
  const result = await pool.query('SELECT * FROM todos WHERE id = $1', [id]);
  if (result.rows.length === 0) {
    res.status(404).json({ error: 'Todo not found' });
    return;
  }
  res.json(result.rows[0]);
});

app.post('/todos', async (req, res) => {
  const { title } = req.body;
  if (!title) {
    res.status(400).json({ error: 'title is required' });
    return;
  }

  const result = await pool.query(
    'INSERT INTO todos (title, completed) VALUES ($1, false) RETURNING *',
    [title]
  );
  const todo: Todo = result.rows[0];

  // Discover notification-service via Consul and send a notification
  try {
    const notifier = await discoverService('notification-service');
    await fetch(`http://${notifier.address}:${notifier.port}/notify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: `New TODO created: "${title}"` }),
    });
    console.log(`[todo-service] Notification sent for TODO #${todo.id}`);
  } catch (err) {
    console.error(`[todo-service] Failed to notify:`, (err as Error).message);
  }

  res.status(201).json(todo);
});

// --- Choreography Saga: Assign todo to user ---

let rabbitChannel: Awaited<ReturnType<typeof createChannel>> | null = null;

app.put('/todos/:id/assign', async (req, res) => {
  const id = parseInt(req.params.id);
  const { userId } = req.body;
  if (userId === undefined) {
    res.status(400).json({ error: 'userId is required' });
    return;
  }

  const result = await pool.query('SELECT * FROM todos WHERE id = $1', [id]);
  if (result.rows.length === 0) {
    res.status(404).json({ error: 'Todo not found' });
    return;
  }

  const correlationId = crypto.randomUUID();

  // Set status to 'assigning' and store the userId
  await pool.query(
    'UPDATE todos SET user_id = $1, status = $2 WHERE id = $3',
    [userId, 'assigning', id]
  );

  // Publish event: TodoAssignmentRequested
  if (rabbitChannel) {
    publishMessage(rabbitChannel, CHOREOGRAPHY_EXCHANGE, CRK.TODO_ASSIGNMENT_REQUESTED, {
      correlationId,
      todoId: id,
      userId: Number(userId),
      timestamp: new Date().toISOString(),
    });
    console.log(`[CHOREOGRAPHY] TodoAssignmentRequested: todo=${id}, user=${userId}, corr=${correlationId}`);
  }

  res.status(202).json({ todoId: id, status: 'assigning', correlationId });
});

app.delete('/todos/:id', async (req, res) => {
  const id = parseInt(req.params.id);
  const result = await pool.query(
    'DELETE FROM todos WHERE id = $1 RETURNING *',
    [id]
  );
  if (result.rows.length === 0) {
    res.status(404).json({ error: 'Todo not found' });
    return;
  }
  res.json(result.rows[0]);
});

// --- Orchestration Saga: RabbitMQ command handlers ---

async function setupRabbitMQ() {
  const connection = await connectRabbit();
  const channel = await createChannel(connection);
  await setupExchanges(channel);

  // Handle: create a todo (orchestration command)
  await consumeQueue(
    channel,
    `saga.${ORK.CMD_TODO_CREATE}`,
    async (cmd: CreateTodoCmd) => {
      console.log(`[SAGA-CMD] Creating todo for saga ${cmd.sagaId}`);
      try {
        const result = await pool.query(
          'INSERT INTO todos (title, completed) VALUES ($1, false) RETURNING *',
          [cmd.title]
        );
        const todo = result.rows[0];
        publishMessage(channel, ORCHESTRATION_EXCHANGE, ORK.CMD_TODO_CREATE_REPLY, {
          sagaId: cmd.sagaId,
          success: true,
          todoId: todo.id,
          todo,
          timestamp: new Date().toISOString(),
        });
      } catch (err) {
        publishMessage(channel, ORCHESTRATION_EXCHANGE, ORK.CMD_TODO_CREATE_REPLY, {
          sagaId: cmd.sagaId,
          success: false,
          error: (err as Error).message,
          timestamp: new Date().toISOString(),
        });
      }
    }
  );

  // Handle: delete a todo (orchestration compensation)
  await consumeQueue(
    channel,
    `saga.${ORK.CMD_TODO_DELETE}`,
    async (cmd: DeleteTodoCmd) => {
      console.log(`[SAGA-CMD] Compensating: deleting todo ${cmd.todoId} for saga ${cmd.sagaId}`);
      try {
        await pool.query('DELETE FROM todos WHERE id = $1', [cmd.todoId]);
      } catch (err) {
        console.error(`[SAGA-CMD] Failed to delete todo ${cmd.todoId}:`, (err as Error).message);
      }
    }
  );

  // --- Choreography Saga: event consumers ---

  // Handle: UserValidated → set status to 'assigned', publish TodoAssignmentConfirmed
  await consumeQueue(
    channel,
    `choreography.${CRK.USER_VALIDATED}`,
    async (event: UserValidated) => {
      console.log(`[CHOREOGRAPHY] UserValidated: todo=${event.todoId}, user=${event.userId}`);
      const result = await pool.query(
        'UPDATE todos SET status = $1 WHERE id = $2 RETURNING *',
        ['assigned', event.todoId]
      );
      const todo = result.rows[0];
      if (todo) {
        publishMessage(channel, CHOREOGRAPHY_EXCHANGE, CRK.TODO_ASSIGNMENT_CONFIRMED, {
          correlationId: event.correlationId,
          todoId: event.todoId,
          userId: event.userId,
          todoTitle: todo.title,
          userEmail: event.user.email,
          timestamp: new Date().toISOString(),
        });
        console.log(`[CHOREOGRAPHY] TodoAssignmentConfirmed: todo=${event.todoId}`);
      }
    }
  );

  // Handle: UserValidationFailed → rollback assignment
  await consumeQueue(
    channel,
    `choreography.${CRK.USER_VALIDATION_FAILED}`,
    async (event: UserValidationFailed) => {
      console.log(`[CHOREOGRAPHY] UserValidationFailed: todo=${event.todoId}, reason=${event.reason}`);
      await pool.query(
        'UPDATE todos SET user_id = NULL, status = $1 WHERE id = $2',
        ['assignment_failed', event.todoId]
      );
      publishMessage(channel, CHOREOGRAPHY_EXCHANGE, CRK.TODO_ASSIGNMENT_ROLLEDBACK, {
        correlationId: event.correlationId,
        todoId: event.todoId,
        userId: event.userId,
        reason: event.reason,
        timestamp: new Date().toISOString(),
      });
      console.log(`[CHOREOGRAPHY] TodoAssignmentRolledBack: todo=${event.todoId}`);
    }
  );

  rabbitChannel = channel;
  console.log('[todo-service] RabbitMQ consumers ready');
  return channel;
}

app.listen(PORT, async () => {
  console.log(`${SERVICE_NAME} running on port ${PORT}`);
  await initDb();
  await setupRabbitMQ();
  await registerService(SERVICE_NAME, SERVICE_ADDRESS, PORT);
  setupGracefulShutdown(SERVICE_NAME, PORT);
});
