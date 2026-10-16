// Where does the time go? Two endpoints in one process, loopback, minimal preset.
import { bindEndpoint, ALPN, tickets } from './endpoint.mjs';
import { EndpointTicket } from '@number0/iroh';
const MIB = Number(process.env.MIB ?? 4);
const total = MIB * 1024 * 1024;

// 1. pure conversion cost
let t = performance.now();
const u8 = new Uint8Array(total).fill(7);
const arr = Array.from(u8);
const toArrMs = performance.now() - t;
t = performance.now();
const back = Uint8Array.from(arr);
const fromArrMs = performance.now() - t;
console.log(JSON.stringify({ step: 'convert', mib: MIB, toArrayMs: Math.round(toArrMs), fromArrayMs: Math.round(fromArrMs), ok: back.length === total }));

const a = await bindEndpoint({ preset: 'minimal' });
const b = await bindEndpoint({ preset: 'minimal' });
const srvConn = (async () => { const inc = await a.acceptNext(); const acc = await inc.accept(); return acc.connect(); })();
const conn = await b.connect(EndpointTicket.fromString(tickets(a).directOnly).endpointAddr(), ALPN);
const sconn = await srvConn;

for (const [writeKiB, readKiB] of [[64, 64], [256, 256], [1024, 1024], [1024, 64], [16, 16], [4096, 4096]]) {
  const w = writeKiB * 1024, r = readKiB * 1024;
  const chunk = Array.from(new Uint8Array(w).fill(1));
  const sender = (async () => {
    const bi = await sconn.openBi();
    const t0 = performance.now();
    let sent = 0, writes = 0;
    while (sent < total) { await bi.send.writeAll(chunk); sent += w; writes++; }
    await bi.send.finish();
    return { writes, ms: performance.now() - t0 };
  })();
  const bi = await conn.acceptBi();
  const t0 = performance.now();
  let got = 0, reads = 0, sizes = 0;
  while (got < total) { const part = await bi.recv.read(Math.min(r, total - got)); if (!part || !part.length) break; got += part.length; reads++; sizes += part.length; }
  const recvMs = performance.now() - t0;
  const s = await sender;
  console.log(JSON.stringify({ step: 'stream', writeKiB, readKiB, writes: s.writes, reads, avgReadKiB: Math.round(sizes / reads / 1024), sendMs: Math.round(s.ms), recvMs: Math.round(recvMs), mbps: Math.round((got * 8) / (recvMs / 1000) / 1e6) }));
}
// readToEnd in one call
{
  const sender = (async () => { const bi = await sconn.openBi(); const chunk = Array.from(new Uint8Array(1024 * 1024).fill(1)); for (let i = 0; i < MIB; i++) await bi.send.writeAll(chunk); await bi.send.finish(); })();
  const bi = await conn.acceptBi();
  const t0 = performance.now();
  const all = await bi.recv.readToEnd(total + 1024);
  const ms = performance.now() - t0;
  await sender;
  console.log(JSON.stringify({ step: 'readToEnd', bytes: all.length, ms: Math.round(ms), mbps: Math.round((all.length * 8) / (ms / 1000) / 1e6) }));
}
// datagram-free baseline: how fast is a plain TCP loopback copy of the same size, for scale
{
  const net = await import('node:net');
  const srv = net.createServer((s) => { s.write(Buffer.alloc(total, 1)); s.end(); });
  await new Promise((res) => srv.listen(0, '127.0.0.1', res));
  const t0 = performance.now();
  await new Promise((res) => { const c = net.connect(srv.address().port, '127.0.0.1'); let n = 0; c.on('data', (d) => (n += d.length)); c.on('end', res); });
  const ms = performance.now() - t0;
  srv.close();
  console.log(JSON.stringify({ step: 'tcp-loopback-baseline', ms: Math.round(ms), mbps: Math.round((total * 8) / (ms / 1000) / 1e6) }));
}
await a.close(); await b.close();
