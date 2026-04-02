import express from 'express';
import {
  registerService,
  discoverService,
  setupGracefulShutdown,
} from '../../shared/consul';
import { healthRoute } from '../../shared/healthcheck';

const app = express();
const PORT = 3001;
const SERVICE_NAME = 'todo-service';
const SERVICE_ADDRESS = process.env.SERVICE_ADDRESS || 'todo-service';

interface Todo {
  id: number;
  title: string;
  completed: boolean;
}

let nextId = 1;
const todos: Todo[] = [];

app.use(express.json());
app.use(healthRoute(SERVICE_NAME));

app.get('/todos', (_req, res) => {
  res.json(todos);
});

app.post('/todos', async (req, res) => {
  const { title } = req.body;
  if (!title) {
    res.status(400).json({ error: 'title is required' });
    return;
  }

  const todo: Todo = { id: nextId++, title, completed: false };
  todos.push(todo);

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

app.delete('/todos/:id', (req, res) => {
  const id = parseInt(req.params.id);
  const index = todos.findIndex((t) => t.id === id);
  if (index === -1) {
    res.status(404).json({ error: 'Todo not found' });
    return;
  }
  const [deleted] = todos.splice(index, 1);
  res.json(deleted);
});

app.listen(PORT, async () => {
  console.log(`${SERVICE_NAME} running on port ${PORT}`);
  await registerService(SERVICE_NAME, SERVICE_ADDRESS, PORT);
  setupGracefulShutdown(SERVICE_NAME, PORT);
});
