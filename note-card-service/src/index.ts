import express from 'express';
import sharp from 'sharp';
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
  ORK,
  type GenerateNoteCardCmd,
} from '../../shared/saga-types.js';

const app = express();
const PORT = parseInt(process.env.PORT || '3004');
const SERVICE_NAME = 'note-card-service';
const SERVICE_ADDRESS = process.env.SERVICE_ADDRESS || 'note-card-service';
const INSTANCE_ID = process.env.INSTANCE_ID || '1';

app.use(express.json());
app.use(healthRoute(SERVICE_NAME));

function buildSvg(title: string, completed: boolean, todoId: number): string {
  const bgColor = completed ? '#e8f5e9' : '#fff8e1';
  const borderColor = completed ? '#4caf50' : '#ff9800';
  const statusText = completed ? 'Done' : 'Pending';
  const statusColor = completed ? '#2e7d32' : '#e65100';

  // Escape XML special characters
  const safeTitle = title
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

  // Word-wrap long titles into multiple lines
  const maxCharsPerLine = 28;
  const words = safeTitle.split(' ');
  const lines: string[] = [];
  let currentLine = '';
  for (const word of words) {
    if ((currentLine + ' ' + word).trim().length > maxCharsPerLine) {
      lines.push(currentLine.trim());
      currentLine = word;
    } else {
      currentLine = (currentLine + ' ' + word).trim();
    }
  }
  if (currentLine) lines.push(currentLine.trim());

  const titleLines = lines
    .map(
      (line, i) =>
        `<text x="20" y="${95 + i * 28}" font-size="18" font-family="sans-serif" fill="#333">${line}</text>`
    )
    .join('\n    ');

  const cardHeight = 150 + (lines.length - 1) * 28;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="360" height="${cardHeight}">
    <rect x="2" y="2" width="356" height="${cardHeight - 4}" rx="12" ry="12"
          fill="${bgColor}" stroke="${borderColor}" stroke-width="2"/>
    <rect x="2" y="2" width="356" height="50" rx="12" ry="12"
          fill="${borderColor}"/>
    <rect x="2" y="30" width="356" height="22" fill="${borderColor}"/>
    <text x="20" y="35" font-size="16" font-weight="bold" fill="white"
          font-family="sans-serif">Todo #${todoId}</text>
    <text x="340" y="35" font-size="14" fill="${statusColor}" text-anchor="end"
          font-family="sans-serif">[${statusText}]</text>
    ${titleLines}
    <text x="20" y="${cardHeight - 15}" font-size="11" fill="#999"
          font-family="sans-serif">Served by instance ${INSTANCE_ID}</text>
  </svg>`;
}

app.get('/note-card/:todoId', async (req, res) => {
  const todoId = parseInt(req.params.todoId);

  // Discover todo-service via Consul and fetch the todo
  let todo: { id: number; title: string; completed: boolean };
  try {
    const todoInstance = await discoverService('todo-service');
    const todoRes = await fetch(
      `http://${todoInstance.address}:${todoInstance.port}/todos/${todoId}`
    );
    if (!todoRes.ok) {
      res.status(todoRes.status).json({ error: 'Todo not found' });
      return;
    }
    todo = (await todoRes.json()) as typeof todo;
  } catch (err) {
    console.error(
      `[note-card-service] Failed to fetch todo:`,
      (err as Error).message
    );
    res.status(503).json({ error: 'todo-service unavailable' });
    return;
  }

  // Generate the SVG and convert to PNG
  console.log(
    `[note-card-service][instance=${INSTANCE_ID}] Generating card for TODO #${todoId}`
  );

  try {
    const svg = buildSvg(todo.title, todo.completed, todo.id);
    const pngBuffer = await sharp(Buffer.from(svg)).png().toBuffer();
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('X-Served-By', `note-card-service-${INSTANCE_ID}`);
    res.send(pngBuffer);
  } catch (err) {
    console.error(
      `[note-card-service] Failed to render PNG:`,
      (err as Error).message
    );
    res.status(500).json({ error: 'Failed to generate note card' });
  }
});

// --- Orchestration Saga: RabbitMQ command handlers ---

async function setupRabbitMQ() {
  const connection = await connectRabbit();
  const channel = await createChannel(connection);
  await setupExchanges(channel);

  // Handle: generate note card (orchestration command)
  await consumeQueue(
    channel,
    `saga.${ORK.CMD_NOTECARD_GENERATE}`,
    async (cmd: GenerateNoteCardCmd) => {
      console.log(`[SAGA-CMD][instance=${INSTANCE_ID}] Generating card for todo ${cmd.todoId}, saga ${cmd.sagaId}`);
      try {
        // Fetch the todo via service discovery (reusing existing pattern)
        const todoInstance = await discoverService('todo-service');
        const todoRes = await fetch(
          `http://${todoInstance.address}:${todoInstance.port}/todos/${cmd.todoId}`
        );
        if (!todoRes.ok) {
          throw new Error(`Todo ${cmd.todoId} not found`);
        }
        const todo = (await todoRes.json()) as { id: number; title: string; completed: boolean };

        // Generate the PNG (same as the HTTP endpoint)
        const svg = buildSvg(todo.title, todo.completed, todo.id);
        await sharp(Buffer.from(svg)).png().toBuffer();

        publishMessage(channel, ORCHESTRATION_EXCHANGE, ORK.CMD_NOTECARD_GENERATE_REPLY, {
          sagaId: cmd.sagaId,
          success: true,
          timestamp: new Date().toISOString(),
        });
      } catch (err) {
        publishMessage(channel, ORCHESTRATION_EXCHANGE, ORK.CMD_NOTECARD_GENERATE_REPLY, {
          sagaId: cmd.sagaId,
          success: false,
          error: (err as Error).message,
          timestamp: new Date().toISOString(),
        });
      }
    }
  );

  console.log(`[note-card-service][instance=${INSTANCE_ID}] RabbitMQ consumers ready`);
}

app.listen(PORT, async () => {
  console.log(`${SERVICE_NAME} (instance ${INSTANCE_ID}) running on port ${PORT}`);
  await setupRabbitMQ();
  await registerService(SERVICE_NAME, SERVICE_ADDRESS, PORT);
  setupGracefulShutdown(SERVICE_NAME, PORT);
});
