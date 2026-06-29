import Link from 'next/link';
import { prisma } from '@/lib/prisma';

// force-dynamic so the page is rendered per-request (it reads the DB) and is NOT
// statically generated at build time (when DATABASE_URL does not exist yet).
export const dynamic = 'force-dynamic';

type Note = {
  id: number;
  title: string;
  body: string | null;
  createdAt: Date;
};

async function loadNotes(): Promise<{ notes: Note[]; error: string | null }> {
  try {
    const notes = await prisma.note.findMany({
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
    return { notes, error: null };
  } catch (err) {
    return { notes: [], error: err instanceof Error ? err.message : String(err) };
  }
}

export default async function NotesPage() {
  const { notes, error } = await loadNotes();

  return (
    <main className="mx-auto max-w-2xl p-8">
      <h1 className="text-2xl font-bold">Notes</h1>
      <p className="mt-2 text-sm text-gray-600">
        Read from MySQL through Prisma. Create one with{' '}
        <code className="rounded bg-gray-100 px-1">POST /api/notes</code>.
      </p>

      {error ? (
        <div className="mt-6 rounded border border-amber-300 bg-amber-50 p-4 text-sm text-amber-800">
          The database is not reachable yet. Set <code>DATABASE_URL</code> in the
          Secrets tab and run <code>npx prisma migrate deploy</code>.
        </div>
      ) : notes.length === 0 ? (
        <p className="mt-6 text-gray-600">No notes yet.</p>
      ) : (
        <ul className="mt-6 space-y-3">
          {notes.map((note) => (
            <li key={note.id} className="rounded border border-gray-200 p-4">
              <h2 className="font-semibold">{note.title}</h2>
              {note.body ? (
                <p className="mt-1 text-sm text-gray-700">{note.body}</p>
              ) : null}
            </li>
          ))}
        </ul>
      )}

      <p className="mt-8">
        <Link href="/" className="text-blue-600 underline">
          ← Home
        </Link>
      </p>
    </main>
  );
}
