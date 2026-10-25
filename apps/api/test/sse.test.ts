import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { openStream } from '../src/sse.ts';

// A stream keeps its own word on whether it may still write: a turn's last items can arrive after
// the client hung up or after `end()`, and those writes must be dropped, not thrown or sent.

class FakeResponse extends EventEmitter {
  writes: string[] = [];
  ends = 0;
  trailers: Array<Record<string, string>> = [];
  writableEnded = false;
  destroyed = false;
  writeHead(): void {}
  write(text: string): boolean {
    if (this.writableEnded) throw new Error('write after end');
    this.writes.push(text);
    return true;
  }
  addTrailers(trailers: Record<string, string>): void {
    this.trailers.push(trailers);
  }
  end(): void {
    if (this.writableEnded) throw new Error('end after end');
    this.ends++;
    this.writableEnded = true;
  }
}

function rig() {
  const raw = new FakeResponse();
  const reqRaw = new EventEmitter();
  const req = { headers: {}, raw: reqRaw } as unknown as FastifyRequest;
  const reply = { raw, hijack: () => {} } as unknown as FastifyReply;
  const stream = openStream(req, reply, { trailers: ['x-claudio-cost-usd'] });
  return { raw, reqRaw, stream };
}

test('a second end() and a write after end() do nothing', () => {
  const { raw, stream } = rig();
  stream.send({ a: 1 });
  stream.end({ 'x-claudio-cost-usd': '0.01' });
  assert.equal(stream.closed, true);
  const written = raw.writes.length;
  stream.send({ late: true });
  stream.sendData('[DONE]');
  stream.end({ 'x-claudio-cost-usd': '0.02' });
  assert.equal(raw.writes.length, written, 'nothing was written after the end');
  assert.equal(raw.ends, 1);
  assert.deepEqual(raw.trailers, [{ 'x-claudio-cost-usd': '0.01' }]);
});

test('once the connection closes, writes and end() are no-ops', () => {
  const { raw, reqRaw, stream } = rig();
  let cleaned = 0;
  stream.onClose(() => cleaned++);
  raw.destroyed = true;
  raw.emit('close');
  reqRaw.emit('close');
  assert.equal(stream.closed, true);
  const written = raw.writes.length;
  stream.send({ late: true });
  stream.sendData('[DONE]');
  stream.end();
  assert.equal(raw.writes.length, written);
  assert.equal(raw.ends, 0, 'a closed connection is not ended again');
  assert.equal(cleaned, 1);
});
