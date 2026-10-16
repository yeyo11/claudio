// node serve.mjs [preset] [relayUrl...]  — binds, prints tickets, answers ping and blob requests, logs paths.
import { bindEndpoint, tickets, pathSummary } from './endpoint.mjs';
import { encodeFrame, readFrame, toArray } from './frames.mjs';

const preset = process.argv[2] ?? 'n0';
const relayUrls = process.argv.slice(3);
const t0 = performance.now();
const ep = await bindEndpoint({ preset, relayUrls });
console.log(JSON.stringify({ event: 'bound', ms: Math.round(performance.now() - t0), id: ep.id().toString(), sockets: ep.boundSockets(), preset, relayUrls }));

if (preset !== 'minimal' && preset !== 'n0-no-relay') {
  const t1 = performance.now();
  await Promise.race([ep.online(), new Promise((r) => setTimeout(r, 15000))]);
  console.log(JSON.stringify({ event: 'online', ms: Math.round(performance.now() - t1), relay: ep.addr().relayUrl() }));
}
// watch* aborts the process in @number0/iroh 1.1.0 (iroh-js/src/watch.rs panics outside a Tokio runtime): poll instead
let lastAddr = '';
setInterval(() => { const a = ep.addr(); const s = JSON.stringify({ relay: a.relayUrl(), direct: a.directAddresses() }); if (s !== lastAddr) { lastAddr = s; console.log(JSON.stringify({ event: 'addr', ...JSON.parse(s) })); } }, 1000).unref();
console.log(JSON.stringify({ event: 'tickets', ...tickets(ep) }));
console.log('\nTICKETS (copy the one the test needs):');
const t = tickets(ep);
console.log(`  full:        ${t.full}`);
console.log(`  relay-only:  ${t.relayOnly}`);
console.log(`  direct-only: ${t.directOnly}`);
console.log(`  id-only:     ${t.idOnly}`);

const blob = toArray(new Uint8Array(1024 * 1024).fill(7)); // 1 MiB, pre-marshalled once

for (;;) {
  const incoming = await ep.acceptNext();
  if (!incoming) break;
  handle(incoming).catch((e) => console.log(JSON.stringify({ event: 'conn-error', error: String(e) })));
}

async function handle(incoming) {
  const from = await incoming.remoteAddr();
  const accepting = await incoming.accept();
  const alpn = Buffer.from(await accepting.alpn()).toString();
  const conn = await accepting.connect();
  const remote = conn.remoteId().toString();
  console.log(JSON.stringify({ event: 'accepted', remote, alpn, from, paths: pathSummary(conn) }));
  let lastPaths = '';
  const poll = setInterval(() => { const p = JSON.stringify(pathSummary(conn)); if (p !== lastPaths) { lastPaths = p; console.log(JSON.stringify({ event: 'paths', remote: remote.slice(0, 8), paths: JSON.parse(p) })); } }, 500);
  try {
    for (;;) {
      const bi = await conn.acceptBi();
      serveStream(conn, bi).catch((e) => console.log(JSON.stringify({ event: 'stream-error', error: String(e) })));
    }
  } catch (e) {
    console.log(JSON.stringify({ event: 'closed', remote: remote.slice(0, 8), reason: conn.closeReason() }));
  } finally {
    clearInterval(poll);
  }
}

async function serveStream(conn, bi) {
  const req = await readFrame(bi.recv);
  if (req.type === 'ping') {
    await bi.send.writeAll(toArray(encodeFrame({ type: 'pong', t: req.t, paths: pathSummary(conn) })));
  } else if (req.type === 'blob') {
    const mib = req.mib ?? 1;
    await bi.send.writeAll(toArray(encodeFrame({ type: 'blob', bytes: mib * blob.length })));
    for (let i = 0; i < mib; i++) await bi.send.writeAll(blob);
  } else {
    await bi.send.writeAll(toArray(encodeFrame({ type: 'error', error: `unknown ${req.type}` })));
  }
  await bi.send.finish();
}
