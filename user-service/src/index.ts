import express from 'express';
import { registerService, setupGracefulShutdown } from '../../shared/discovery.js';
import { healthRoute } from '../../shared/healthcheck.js';

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

app.listen(PORT, async () => {
  console.log(`${SERVICE_NAME} running on port ${PORT}`);
  await registerService(SERVICE_NAME, SERVICE_ADDRESS, PORT);
  setupGracefulShutdown(SERVICE_NAME, PORT);
});
