import express from 'express';
import {
  registerService,
  discoverService,
  setupGracefulShutdown,
} from '../../shared/discovery.js';
import { healthRoute } from '../../shared/healthcheck.js';

const app = express();
const PORT = 3000;
const SERVICE_NAME = 'api-gateway';
const SERVICE_ADDRESS = process.env.SERVICE_ADDRESS || 'api-gateway';

app.use(express.json());
app.use(healthRoute(SERVICE_NAME));

// Helper: discover a service and proxy a request to it
async function proxy(
  serviceName: string,
  path: string,
  options: RequestInit = {}
): Promise<{ status: number; body: any }> {
  const instance = await discoverService(serviceName);
  const url = `http://${instance.address}:${instance.port}${path}`;
  console.log(`[Gateway] Routing to ${serviceName} → ${url}`);

  const res = await fetch(url, options);
  const body = await res.json();
  return { status: res.status, body };
}

// --- TODO routes ---

app.get('/api/todos', async (_req, res) => {
  try {
    const result = await proxy('todo-service', '/todos');
    res.status(result.status).json(result.body);
  } catch (err) {
    console.error('[Gateway]', (err as Error).message);
    res.status(503).json({ error: 'todo-service unavailable' });
  }
});

app.get('/api/todos/:id', async (req, res) => {
  try {
    const result = await proxy('todo-service', `/todos/${req.params.id}`);
    res.status(result.status).json(result.body);
  } catch (err) {
    console.error('[Gateway]', (err as Error).message);
    res.status(503).json({ error: 'todo-service unavailable' });
  }
});

app.post('/api/todos', async (req, res) => {
  try {
    const result = await proxy('todo-service', '/todos', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req.body),
    });
    res.status(result.status).json(result.body);
  } catch (err) {
    console.error('[Gateway]', (err as Error).message);
    res.status(503).json({ error: 'todo-service unavailable' });
  }
});

app.put('/api/todos/:id/assign', async (req, res) => {
  try {
    const result = await proxy('todo-service', `/todos/${req.params.id}/assign`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req.body),
    });
    res.status(result.status).json(result.body);
  } catch (err) {
    console.error('[Gateway]', (err as Error).message);
    res.status(503).json({ error: 'todo-service unavailable' });
  }
});

app.delete('/api/todos/:id', async (req, res) => {
  try {
    const result = await proxy('todo-service', `/todos/${req.params.id}`, {
      method: 'DELETE',
    });
    res.status(result.status).json(result.body);
  } catch (err) {
    console.error('[Gateway]', (err as Error).message);
    res.status(503).json({ error: 'todo-service unavailable' });
  }
});

// --- Saga orchestration routes ---

app.post('/api/saga/create-full-todo', async (req, res) => {
  try {
    const result = await proxy('saga-orchestrator', '/saga/create-full-todo', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req.body),
    });
    res.status(result.status).json(result.body);
  } catch (err) {
    console.error('[Gateway]', (err as Error).message);
    res.status(503).json({ error: 'saga-orchestrator unavailable' });
  }
});

app.get('/api/saga/status/:sagaId', async (req, res) => {
  try {
    const result = await proxy(
      'saga-orchestrator',
      `/saga/status/${req.params.sagaId}`
    );
    res.status(result.status).json(result.body);
  } catch (err) {
    console.error('[Gateway]', (err as Error).message);
    res.status(503).json({ error: 'saga-orchestrator unavailable' });
  }
});

// --- Note card routes ---

// Helper: proxy binary responses (images, files) instead of JSON
async function proxyBinary(
  serviceName: string,
  path: string
): Promise<{ status: number; contentType: string; body: Buffer }> {
  const instance = await discoverService(serviceName);
  const url = `http://${instance.address}:${instance.port}${path}`;
  console.log(`[Gateway] Routing to ${serviceName} → ${url}`);

  const res = await fetch(url);
  const body = Buffer.from(await res.arrayBuffer());
  return {
    status: res.status,
    contentType: res.headers.get('content-type') || 'application/octet-stream',
    body,
  };
}

app.get('/api/note-card/:todoId', async (req, res) => {
  try {
    const result = await proxyBinary(
      'note-card-service',
      `/note-card/${req.params.todoId}`
    );
    res.setHeader('Content-Type', result.contentType);
    res.status(result.status).send(result.body);
  } catch (err) {
    console.error('[Gateway]', (err as Error).message);
    res.status(503).json({ error: 'note-card-service unavailable' });
  }
});

// --- User routes ---

app.get('/api/users/:id', async (req, res) => {
  try {
    const result = await proxy('user-service', `/users/${req.params.id}`);
    res.status(result.status).json(result.body);
  } catch (err) {
    console.error('[Gateway]', (err as Error).message);
    res.status(503).json({ error: 'user-service unavailable' });
  }
});

app.listen(PORT, async () => {
  console.log(`${SERVICE_NAME} running on port ${PORT}`);
  await registerService(SERVICE_NAME, SERVICE_ADDRESS, PORT);
  setupGracefulShutdown(SERVICE_NAME, PORT);
});
