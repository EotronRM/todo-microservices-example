import { useState } from 'react';
import { noteCardUrl } from './api';

export default function NoteCard({ todoId }: { todoId: number | null }) {
  const [n, setN] = useState(0);
  const [failedSrc, setFailedSrc] = useState<string | null>(null);

  if (todoId === null) {
    return (
      <section className="rounded border border-dashed border-slate-300 p-6 text-center text-sm text-slate-500">
        Select a todo to see its note card.
      </section>
    );
  }

  const src = noteCardUrl(todoId, n);

  return (
    <section>
      <div className="mb-2 flex items-center justify-between">
        <h2 className="font-semibold">Note card for #{todoId}</h2>
        <button
          onClick={() => setN(n + 1)}
          className="rounded border border-slate-300 bg-white px-3 py-1 text-sm hover:bg-slate-100"
        >
          Regenerate
        </button>
      </div>
      {failedSrc === src ? (
        <p className="text-sm text-red-700">Couldn’t render card.</p>
      ) : (
        <img src={src} alt={`Note card for todo #${todoId}`} onError={() => setFailedSrc(src)} className="max-w-full" />
      )}
      <p className="mt-2 text-xs text-slate-500">
        The gateway sends each request to one of the two note-card-service instances at random. The card names the
        instance that drew it.
      </p>
    </section>
  );
}
