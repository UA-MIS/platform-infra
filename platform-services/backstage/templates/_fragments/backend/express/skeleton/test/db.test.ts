// db.test.ts — regression coverage for DATABASE_URL engine detection (FIX-16/D-092).
//
// The platform hands DATABASE_URL to this fragment as a bare `mysql://` or
// `postgresql://` URI (see .devops/chart/overlays/*/database.externalsecret.yaml) and
// never rewrites the scheme (D-070, fragment-side only). src/db.ts is the ONE place
// that branches on it — these tests prove that branching, and only that branching, so
// they run with no live database (mysql2/pg pools are constructed lazily and never
// touched by getEngine()/isConfigured()).
'use strict'

import test from 'node:test'
import assert from 'node:assert'
import { isConfigured, getEngine } from '../src/db'

function withEnv(url: string | undefined, run: () => void) {
  const prev = process.env.DATABASE_URL
  if (url === undefined) delete process.env.DATABASE_URL
  else process.env.DATABASE_URL = url
  try {
    run()
  } finally {
    if (prev === undefined) delete process.env.DATABASE_URL
    else process.env.DATABASE_URL = prev
  }
}

test('isConfigured() is false when DATABASE_URL is unset', () => {
  withEnv(undefined, () => {
    assert.strictEqual(isConfigured(), false)
  })
})

test('isConfigured() is true when DATABASE_URL is set', () => {
  withEnv('mysql://u:p@host:3306/db', () => {
    assert.strictEqual(isConfigured(), true)
  })
})

test('getEngine() is null when DATABASE_URL is unset', () => {
  withEnv(undefined, () => {
    assert.strictEqual(getEngine(), null)
  })
})

test('getEngine() resolves bare mysql:// to mysql', () => {
  withEnv('mysql://u:p@host:3306/db', () => {
    assert.strictEqual(getEngine(), 'mysql')
  })
})

test('getEngine() resolves bare postgresql:// to postgres', () => {
  // The platform's DSN template emits exactly this scheme (dbScheme='postgresql').
  withEnv('postgresql://u:p@host:5432/db', () => {
    assert.strictEqual(getEngine(), 'postgres')
  })
})

test('getEngine() resolves the short postgres:// form to postgres', () => {
  // A bring-your-own DATABASE_URL might use the shorter conventional form.
  withEnv('postgres://u:p@host:5432/db', () => {
    assert.strictEqual(getEngine(), 'postgres')
  })
})
