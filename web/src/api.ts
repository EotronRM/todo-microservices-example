// Every call goes through the api-gateway (proxied on this origin as /api).

export type Todo = { id: number; title: string; completed: boolean };

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  // todo-service needs this header on POST, or the gateway answers 503
  const res = await fetch(path, { ...init, headers: { 'Content-Type': 'application/json' } });
  // Gateway errors are JSON { error }, except Express's HTML 404 for unknown routes
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new Error(body?.error ?? `HTTP ${res.status}`);
  return body as T;
}

export const listTodos = () => request<Todo[]>('/api/todos');

export const createTodo = (title: string) =>
  request<Todo>('/api/todos', { method: 'POST', body: JSON.stringify({ title }) });

export const deleteTodo = (id: number) => request<Todo>(`/api/todos/${id}`, { method: 'DELETE' });

// `n` busts the browser cache, so each load is a fresh request the gateway can
// send to either note-card instance. The gateway ignores the query string.
export const noteCardUrl = (id: number, n: number) => `/api/note-card/${id}?n=${n}`;
