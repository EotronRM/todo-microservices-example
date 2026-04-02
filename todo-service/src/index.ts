import express from 'express';
import pg from 'pg';
import {
  registerService,
  discoverService,
  setupGracefulShutdown,
} from '../../shared/consul.js';
import { healthRoute } from '../../shared/healthcheck.js';

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
          completed BOOLEAN NOT NULL DEFAULT false
        )
      `);
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

app.listen(PORT, async () => {
  console.log(`${SERVICE_NAME} running on port ${PORT}`);
  await initDb();
  await registerService(SERVICE_NAME, SERVICE_ADDRESS, PORT);
  setupGracefulShutdown(SERVICE_NAME, PORT);
});
