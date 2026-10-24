import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { AUDIT_ROUTE_SCHEMA_VERSION, Db, migrate } from '../src/db.ts';
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
