// End-to-end smoke test against a running stack.
//
//   docker compose up -d --build     (or docker compose -f docker-compose.etcd.yml up -d --build)
//   bun scripts/smoke.mts
//
// Env: GATEWAY_URL (default http://localhost:3000)
//      WEB_URL: the web UI container (default http://localhost:8080)
//      SMOKE_TIMEOUT_MS: how long to wait for services to register (default 180000)
// Exits with status 1 if any check fails.

const GW = process.env.GATEWAY_URL ?? 'http://localhost:3000';
const WEB = process.env.WEB_URL ?? 'http://localhost:8080';
const READY_TIMEOUT_MS = Number(process.env.SMOKE_TIMEOUT_MS ?? 180_000);
// Per-request limit: on some setups (e.g. WSL) a connection to a closed localhost
// port hangs instead of being refused, so never wait on a single request for long.
const REQUEST_TIMEOUT_MS = 10_000;

let failures = 0;

function check(name: string, ok: boolean, detail = ''): void {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
}

async function json(path: string, init?: RequestInit): Promise<{ status: number; body: any }> {
  try {
    const res = await fetch(GW + path, {
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      ...init,
      headers: { 'Content-Type': 'application/json', ...init?.headers },
    });
    const body = await res.json().catch(() => null);
    return { status: res.status, body };
  } catch {
    return { status: 0, body: null }; // refused or timed out: stack not up yet
  }
}

async function poll<T>(fn: () => Promise<T>, done: (v: T) => boolean, timeoutMs: number): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last = await fn();
  while (!done(last) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 1000));
    last = await fn();
  }
  return last;
}

// --- 1. Wait until every service behind the gateway is discoverable ---
// The gateway answers 503 while a service isn't registered or passing its health
// check yet. Any other status means the request reached the service (note-card
// answers 404 for an unknown todo, saga-orchestrator for an unknown saga).

const routes = ['/api/todos', '/api/users/1', '/api/note-card/0', '/api/saga/status/none'];
for (const route of routes) {
  const r = await poll(() => json(route), (r) => r.status !== 0 && r.status !== 503, READY_TIMEOUT_MS);
  const ok = r.status !== 0 && r.status !== 503;
  check(`gateway reaches ${route}`, ok, `status ${r.status}`);
  if (!ok) {
    console.log(`\n${route} wasn't reachable within ${READY_TIMEOUT_MS / 1000}s. Is the stack running?`);
    process.exit(1);
  }
}

// --- 2. Todos ---

const created = await json('/api/todos', { method: 'POST', body: JSON.stringify({ title: 'Smoke test todo' }) });
check('POST /api/todos creates a todo', created.status === 201 && Boolean(created.body?.id), `status ${created.status}`);
const id = created.body?.id;

const got = await json(`/api/todos/${id}`);
check('GET /api/todos/:id returns it', got.status === 200 && got.body?.title === 'Smoke test todo', `status ${got.status}`);

// --- 3. Users ---

check('GET /api/users/1 returns a user', (await json('/api/users/1')).status === 200);
check('GET /api/users/999 is 404', (await json('/api/users/999')).status === 404);

// --- 4. Note cards ---

let pngs = 0;
for (let i = 0; i < 10; i++) {
  const res = await fetch(`${GW}/api/note-card/${id}`, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  const buf = new Uint8Array(await res.arrayBuffer());
  const isPng = buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47;
  if (res.status === 200 && res.headers.get('content-type') === 'image/png' && isPng) pngs++;
}
check('GET /api/note-card/:id returns a PNG (10 requests)', pngs === 10, `${pngs}/10`);

// Both instances, called directly (the gateway doesn't forward X-Served-By)
for (const port of [3004, 3005]) {
  const res = await fetch(`http://localhost:${port}/note-card/${id}`, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) }).catch(() => null);
  check(`note-card instance on :${port} responds`, res?.status === 200, `X-Served-By ${res?.headers.get('x-served-by')}`);
}

// --- 5. Orchestration saga ---

const isDone = (r: { body: any }) => ['COMPLETED', 'FAILED'].includes(r.body?.step);

const ok = await json('/api/saga/create-full-todo', { method: 'POST', body: JSON.stringify({ title: 'Saga smoke test', userId: 1 }) });
check('POST /api/saga/create-full-todo is accepted', ok.status === 202 && Boolean(ok.body?.sagaId), `status ${ok.status}`);
const okState = await poll(() => json(`/api/saga/status/${ok.body?.sagaId}`), isDone, 30_000);
check('saga for user 1 reaches COMPLETED', okState.body?.step === 'COMPLETED', `step ${okState.body?.step}`);
const sagaTodo = await json(`/api/todos/${okState.body?.todoId}`);
check('saga-created todo exists', sagaTodo.status === 200);
check('saga-created todo is assigned to user 1', sagaTodo.body?.user_id === 1 && sagaTodo.body?.status === 'assigned', `user_id ${sagaTodo.body?.user_id}, status ${sagaTodo.body?.status}`);
await json(`/api/todos/${okState.body?.todoId}`, { method: 'DELETE' });

const bad = await json('/api/saga/create-full-todo', { method: 'POST', body: JSON.stringify({ title: 'Saga compensation', userId: 999 }) });
const badState = await poll(() => json(`/api/saga/status/${bad.body?.sagaId}`), isDone, 30_000);
check('saga for unknown user 999 reaches FAILED', badState.body?.step === 'FAILED', `step ${badState.body?.step}`);
const deleted = await poll(() => json(`/api/todos/${badState.body?.todoId}`), (r) => r.status === 404, 10_000);
check('compensation deletes the todo', deleted.status === 404, `status ${deleted.status}`);

// --- 6. Choreography saga ---

const notAssigning = (r: { body: any }) => r.body?.status !== 'assigning';

const assign = await json(`/api/todos/${id}/assign`, { method: 'PUT', body: JSON.stringify({ userId: 1 }) });
check('PUT /api/todos/:id/assign is accepted', assign.status === 202, `status ${assign.status}`);
const assigned = await poll(() => json(`/api/todos/${id}`), notAssigning, 15_000);
check('assigning to user 1 ends assigned', assigned.body?.status === 'assigned', `status ${assigned.body?.status}`);

await json(`/api/todos/${id}/assign`, { method: 'PUT', body: JSON.stringify({ userId: 999 }) });
const rolledBack = await poll(() => json(`/api/todos/${id}`), notAssigning, 15_000);
check('assigning to unknown user 999 is rolled back', rolledBack.body?.status === 'assignment_failed' && rolledBack.body?.user_id === null, `status ${rolledBack.body?.status}, user_id ${rolledBack.body?.user_id}`);

// --- 7. Web UI ---
// nginx serves the React bundle and proxies /api to the gateway on the same origin.

const page = await fetch(WEB, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) }).catch(() => null);
const html = (await page?.text()) ?? '';
check('web UI serves index.html', page?.status === 200 && html.includes('id="root"'), `status ${page?.status}`);

const proxied = await fetch(`${WEB}/api/todos`, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) }).catch(() => null);
check('web UI proxies /api to the gateway', proxied?.status === 200, `status ${proxied?.status}`);

// --- 8. Cleanup ---

check('DELETE /api/todos/:id', (await json(`/api/todos/${id}`, { method: 'DELETE' })).status === 200);
check('deleted todo is 404', (await json(`/api/todos/${id}`)).status === 404);

console.log(failures ? `\n${failures} check(s) failed` : '\nAll checks passed');
process.exit(failures ? 1 : 0);
