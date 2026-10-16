import { bindEndpoint, ALPN, tickets } from './endpoint.mjs';
import { EndpointTicket } from '@number0/iroh';
const a = await bindEndpoint({ preset: 'minimal' });
const b = await bindEndpoint({ preset: 'minimal' });
const srv = (async () => { const inc = await a.acceptNext(); const acc = await inc.accept(); return acc.connect(); })();
const conn = await b.connect(EndpointTicket.fromString(tickets(a).directOnly).endpointAddr(), ALPN);
const sconn = await srv;
for (const [name, make] of [['Buffer', (n) => Buffer.alloc(n, 1)], ['Uint8Array', (n) => new Uint8Array(n).fill(1)]]) {
  try {
    const bi = await conn.openBi();
    const t0 = performance.now();
    const MIB = 4;
    const reader = (async () => { const s = await sconn.acceptBi(); const all = await s.recv.readToEnd(MIB * 1024 * 1024 + 10); return { len: all.length, type: Array.isArray(all) ? 'Array' : all.constructor.name }; })();
    for (let i = 0; i < MIB; i++) await bi.send.writeAll(make(1024 * 1024));
    await bi.send.finish();
    const r = await reader;
    const ms = performance.now() - t0;
    console.log(JSON.stringify({ input: name, accepted: true, received: r, ms: Math.round(ms), mbps: Math.round((r.len * 8) / (ms / 1000) / 1e6) }));
  } catch (e) { console.log(JSON.stringify({ input: name, accepted: false, error: String(e.message).split('\n')[0] })); }
}
// signature API: does SecretKey.sign accept Buffer?
import { SecretKey } from '@number0/iroh';
const k = SecretKey.generate();
try { const s = k.sign(Buffer.from('hi')); console.log(JSON.stringify({ signBuffer: true, sig: s.toString().slice(0, 16) })); } catch (e) { console.log(JSON.stringify({ signBuffer: false, error: String(e.message).split('\n')[0] })); }
try { const s = k.sign(Array.from(Buffer.from('hi'))); k.public().verify(Array.from(Buffer.from('hi')), s); console.log(JSON.stringify({ signArray: true, verify: true })); } catch (e) { console.log(JSON.stringify({ signArray: false, error: String(e.message).split('\n')[0] })); }
await a.close(); await b.close();
