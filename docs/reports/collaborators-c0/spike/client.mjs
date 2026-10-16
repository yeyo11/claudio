// node client.mjs <ticket> [preset] [relayUrl...] — connects, measures handshake, pings, blob throughput, watches path migration.
import { bindEndpoint, pathSummary, EndpointTicket, ALPN } from './endpoint.mjs';
import { encodeFrame, readFrame, readBytes, toArray } from './frames.mjs';

const ticket = process.argv[2];
if (!ticket) { console.error('usage: node client.mjs <ticket> [n0|minimal|n0-no-relay] [relayUrl...]'); process.exit(2); }
const preset = process.argv[3] ?? 'n0';
const relayUrls = process.argv.slice(4);
const out = { preset, relayUrls, ticket: { relay: null, direct: [] } };

const addr = EndpointTicket.fromString(ticket).endpointAddr();
out.ticket = { relay: addr.relayUrl(), direct: addr.directAddresses(), id: addr.id().toString() };

let t = performance.now();
const ep = await bindEndpoint({ preset, relayUrls });
out.bindMs = Math.round(performance.now() - t);
if (preset === 'n0') { t = performance.now(); await Promise.race([ep.online(), new Promise((r) => setTimeout(r, 15000))]); out.onlineMs = Math.round(performance.now() - t); }

t = performance.now();
const conn = await ep.connect(addr, ALPN);
out.handshakeMs = Math.round(performance.now() - t);
out.pathsAtConnect = pathSummary(conn);
// watch* aborts the process in 1.1.0: poll paths every 250 ms and record changes
const events = [];
let lastPaths = JSON.stringify(out.pathsAtConnect);
const poll = setInterval(() => { const p = JSON.stringify(pathSummary(conn)); if (p !== lastPaths) { lastPaths = p; events.push({ atMs: Math.round(performance.now() - t), paths: JSON.parse(p) }); } }, 250);

// 20 pings, one stream each, as Collaborators opens one stream per request
const pings = [];
for (let i = 0; i < 20; i++) {
  const bi = await conn.openBi();
  const t1 = performance.now();
  await bi.send.writeAll(toArray(encodeFrame({ type: 'ping', t: t1 })));
  await bi.send.finish();
  const res = await readFrame(bi.recv);
  pings.push(performance.now() - t1);
  if (i === 19) out.pathsSeenByServer = res.paths;
}
pings.sort((a, b) => a - b);
out.pingMs = { min: r(pings[0]), median: r(pings[10]), max: r(pings[19]) };
out.rttMs = conn.rtt();

// 8 MiB blob
const mib = Number(process.env.BLOB_MIB ?? 8);
const bi = await conn.openBi();
t = performance.now();
await bi.send.writeAll(toArray(encodeFrame({ type: 'blob', mib })));
await bi.send.finish();
const head = await readFrame(bi.recv);
const got = await readBytes(bi.recv, head.bytes);
const secs = (performance.now() - t) / 1000;
out.blob = { mib, bytes: got, secs: r(secs), mbps: r((got * 8) / secs / 1e6) };

// wait for a possible migration relay -> direct
await new Promise((res) => setTimeout(res, Number(process.env.WATCH_MS ?? 8000)));
out.pathsAfterWait = pathSummary(conn);
out.pathEvents = events;
out.stats = conn.stats();
clearInterval(poll);
conn.close(0n, toArray(new TextEncoder().encode('done')));
await ep.close();
console.log(JSON.stringify(out, null, 2));

function r(x) { return Math.round(x * 100) / 100; }
