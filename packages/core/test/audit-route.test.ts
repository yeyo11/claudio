import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { AUDIT_REFUSALS_SCHEMA_VERSION, AUDIT_ROUTE_SCHEMA_VERSION, Db, MAX_AUDIT_PATH, migrate } from '../src/db.ts';
import { tempConfig } from './helpers.ts';

test('the audit route migration upgrades a database, and the rows it finds read no route', () => {
  const config = tempConfig();
  mkdirSync(config.dataDir, { recursive: true });
  const raw = new DatabaseSync(join(config.dataDir, 'wrapper.db'));
  migrate(raw, AUDIT_ROUTE_SCHEMA_VERSION - 1);
  const columns = (raw.prepare('PRAGMA table_info(audit)').all() as Array<{ name: string }>).map((c) => c.name);
  assert.equal(columns.includes('route'), false);
  raw
    .prepare('INSERT INTO audit (at, actor, method, path, status, summary) VALUES (?, ?, ?, ?, ?, ?)')
    .run('2026-10-01T10:00:00.000Z', 'local', 'POST', '/api/chats/c1/stop', 200, 'Stop what is working on the chat');
  raw.close();

  const db = new Db(config);
  try {
    const [old] = db.auditPage().entries;
    assert.equal(old?.summary, 'Stop what is working on the chat', 'the existing row survived');
    assert.equal(old?.route, null);

    const written = db.appendAudit({
      at: '2026-10-20T10:00:00.000Z',
      actor: 'desktop',
      method: 'PUT',
      path: '/api/chats/c1/claudio-mcp',
      status: 200,
      summary: "Switch Claudio's own MCP server on or off in a live chat",
      route: 'PUT /chats/:id/claudio-mcp',
    });
    assert.equal(written.route, 'PUT /chats/:id/claudio-mcp');
    // What the wrapper records on its own names no route: its summary is a sentence of its own
    db.appendAudit({ at: '2026-10-20T11:00:00.000Z', actor: 'claudio', method: 'POST', path: '/api/tunnel/stop', status: 200, summary: 'Stop the tunnel: authentication was turned off' });
    assert.deepEqual(
      db.auditPage().entries.map((e) => e.route),
      [null, 'PUT /chats/:id/claudio-mcp', null],
    );
  } finally {
    db.close();
  }
});

test('the refusals migration moves the anonymous rows out of the log, and the ring keeps its newest thousand', () => {
  const config = tempConfig();
  mkdirSync(config.dataDir, { recursive: true });
  const raw = new DatabaseSync(join(config.dataDir, 'wrapper.db'));
  migrate(raw, AUDIT_REFUSALS_SCHEMA_VERSION - 1);
  const insert = raw.prepare('INSERT INTO audit (at, actor, method, path, status, summary, route) VALUES (?, ?, ?, ?, ?, ?, ?)');
  insert.run('2026-10-01T10:00:00.000Z', 'token:abcd1234', 'POST', '/api/chats/c1/stop', 200, 'Stop what is working on the chat', 'POST /chats/:id/stop');
  // A flood of refusals that had been filling the log, one of them with a very long path
  for (let i = 0; i < 1_200; i += 1) insert.run('2026-10-01T10:00:01.000Z', 'anonymous', 'POST', `/api/x${String(i)}`, 401, 'POST /api/x', null);
  insert.run('2026-10-01T10:00:02.000Z', 'anonymous', 'POST', `/api/${'y'.repeat(2_000)}`, 401, 'POST /api/y', null);
  raw.close();

  const db = new Db(config);
  try {
    const log = db.auditPage();
    assert.equal(log.total, 1, 'only what an identified caller did is left in the log');
    assert.equal(log.entries[0]?.actor, 'token:abcd1234');
    const ring = db.auditRefusalsPage({ limit: 2 });
    assert.equal(ring.total, 1_000, 'the newest refusals moved over');
    assert.equal(ring.entries[0]?.path.length, MAX_AUDIT_PATH);
    assert.equal(ring.entries[1]?.path, '/api/x1199');

    // From here on each refusal trims the ring to its newest thousand
    for (let i = 0; i < 1_500; i += 1) db.appendAuditRefusal({ at: '2026-10-29T10:00:00.000Z', actor: 'anonymous', method: 'POST', path: `/api/z${String(i)}`, status: 401, summary: 'POST /api/z' });
    assert.equal(db.auditRefusalsPage().total, 1_000);
    assert.equal(db.auditRefusalsPage({ limit: 1 }).entries[0]?.path, '/api/z1499');
    // And a long path is cut in the log too
    const written = db.appendAudit({ at: '2026-10-29T10:00:00.000Z', actor: 'local', method: 'POST', path: `/api/${'w'.repeat(1_000)}`, status: 404, summary: 'POST /api/w' });
    assert.equal(written.path.length, MAX_AUDIT_PATH);
    assert.equal(db.auditPage().total, 2);
  } finally {
    db.close();
  }
});
