import { useEffect, useState, type FormEvent } from 'react';
import { createTodo, deleteTodo, listTodos, type Todo } from './api';
import NoteCard from './NoteCard';

export default function App() {
  const [todos, setTodos] = useState<Todo[] | null>(null); // null until the first load
  const [title, setTitle] = useState('');
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Runs an API call and shows its error in the banner. Right after
  // `docker compose up`, the gateway answers 503 until services register.
  async function attempt(action: () => Promise<void>) {
    try {
      await action();
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  const load = () => attempt(async () => setTodos(await listTodos()));

  useEffect(() => {
    load();
  }, []);

  const handleAdd = (e: FormEvent) => {
    e.preventDefault();
    attempt(async () => {
      const todo = await createTodo(title.trim());
      setTodos((prev) => [...(prev ?? []), todo]);
      // Keep anything typed while the request was in flight
      setTitle((current) => (current === title ? '' : current));
      setSelectedId(todo.id);
    });
  };

  const handleDelete = (id: number) =>
    attempt(async () => {
      await deleteTodo(id);
      setTodos((prev) => prev?.filter((t) => t.id !== id) ?? null);
      if (selectedId === id) setSelectedId(null);
    });

  return (
    <main className="mx-auto max-w-4xl p-4 sm:p-8">
      <header className="mb-6">
        <h1 className="text-2xl font-bold">Todo Microservices</h1>
        <p className="text-sm text-slate-500">Every request goes through the api-gateway on :3000.</p>
      </header>

      {error && (
        <div className="mb-4 flex items-center justify-between gap-4 rounded border border-red-300 bg-red-50 p-3 text-sm text-red-800">
          <span>{error}</span>
          <button onClick={load} className="font-medium underline">
            Retry
          </button>
        </div>
      )}

      <div className="grid gap-6 md:grid-cols-2">
        <section>
          <form onSubmit={handleAdd} className="mb-4 flex gap-2">
            <input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="What needs doing?"
              className="min-w-0 flex-1 rounded border border-slate-300 bg-white px-3 py-2"
            />
            {/* The service accepts whitespace-only titles, so block them here */}
            <button
              disabled={!title.trim()}
              className="rounded bg-slate-900 px-4 py-2 text-white disabled:opacity-40"
            >
              Add
            </button>
          </form>

          {todos === null ? (
            <p className="text-sm text-slate-500">{error ? 'Couldn’t load todos.' : 'Loading…'}</p>
          ) : todos.length === 0 ? (
            <p className="text-sm text-slate-500">No todos yet.</p>
          ) : (
            <ul className="divide-y divide-slate-200 rounded border border-slate-200 bg-white">
              {todos.map((todo) => (
                <li
                  key={todo.id}
                  className={`flex items-center gap-3 px-3 py-2 ${todo.id === selectedId ? 'bg-slate-100' : ''}`}
                >
                  <button onClick={() => setSelectedId(todo.id)} className="flex flex-1 gap-3 text-left">
                    <span className="text-xs leading-6 text-slate-400">#{todo.id}</span>
                    <span className="break-all">{todo.title}</span>
                  </button>
                  <button onClick={() => handleDelete(todo.id)} className="text-sm text-red-600 hover:underline">
                    Delete
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>

        <NoteCard todoId={selectedId} />
      </div>
    </main>
  );
}
