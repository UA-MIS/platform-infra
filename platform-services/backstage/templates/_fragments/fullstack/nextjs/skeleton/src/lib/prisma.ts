import { PrismaClient } from '@prisma/client';

// A single shared PrismaClient. In dev, Next.js hot-reload re-imports modules, which
// would otherwise create a new client (and a new connection pool) on every reload and
// exhaust the database connections — so cache it on globalThis. The constructor does
// NOT open a connection; the first query does, so importing this is safe even when
// DATABASE_URL is unset (a fresh scaffold with nothing in Vault).
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const prisma = globalForPrisma.prisma ?? new PrismaClient();

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.prisma = prisma;
}
