import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { isValidTitle, normalizeTitle } from '@/lib/notes';

// force-dynamic so this route is never statically evaluated at build time (which would
// try to reach the database before DATABASE_URL exists).
export const dynamic = 'force-dynamic';

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// GET /api/notes — list the most recent notes. If the DB is not configured yet, return
// an empty list + a hint (200) rather than a 500, so a fresh scaffold stays green.
export async function GET() {
  try {
    const notes = await prisma.note.findMany({
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
    return NextResponse.json({ notes });
  } catch (err) {
    return NextResponse.json({
      notes: [],
      error: 'database not reachable — is DATABASE_URL set and migrated?',
      detail: errorMessage(err),
    });
  }
}

// POST /api/notes — create a note. Body: { "title": string, "body"?: string }.
export async function POST(request: Request) {
  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return NextResponse.json({ error: 'request body must be valid JSON' }, { status: 400 });
  }

  const fields = (payload ?? {}) as { title?: unknown; body?: unknown };
  const title = typeof fields.title === 'string' ? fields.title : '';
  if (!isValidTitle(title)) {
    return NextResponse.json(
      { error: 'title is required and must be 1-200 characters' },
      { status: 400 },
    );
  }
  const body = typeof fields.body === 'string' ? fields.body : null;

  try {
    const note = await prisma.note.create({
      data: { title: normalizeTitle(title), body },
    });
    return NextResponse.json({ note }, { status: 201 });
  } catch (err) {
    return NextResponse.json(
      { error: 'could not save note — is DATABASE_URL set and migrated?', detail: errorMessage(err) },
      { status: 503 },
    );
  }
}
