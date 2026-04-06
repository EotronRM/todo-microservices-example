import express from 'express';
import { registerService, setupGracefulShutdown } from '../../shared/discovery.js';
import { healthRoute } from '../../shared/healthcheck.js';

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

app.listen(PORT, async () => {
  console.log(`${SERVICE_NAME} running on port ${PORT}`);
  await registerService(SERVICE_NAME, SERVICE_ADDRESS, PORT);
  setupGracefulShutdown(SERVICE_NAME, PORT);
});
