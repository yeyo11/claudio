import { bindEndpoint, ALPN } from './endpoint.mjs';
import { tickets } from './endpoint.mjs';
import { EndpointTicket } from '@number0/iroh';
const a = await bindEndpoint({ preset: 'minimal' });
const b = await bindEndpoint({ preset: 'minimal' });
const t = tickets(a);
const srv = (async () => { const inc = await a.acceptNext(); const acc = await inc.accept(); const c = await acc.connect(); return c; })();
const conn = await b.connect(EndpointTicket.fromString(t.directOnly).endpointAddr(), ALPN);
const sconn = await srv;
const which = process.argv[2];
if (which === 'watchPaths') { const h = conn.watchPaths(() => {}); await new Promise(r => setTimeout(r, 300)); await h.stop(); }
if (which === 'watchPathEvents') { const h = conn.watchPathEvents(() => {}); await new Promise(r => setTimeout(r, 300)); await h.stop(); }
if (which === 'paths') { console.log(JSON.stringify(conn.paths())); }
console.log(which, 'ok');
await a.close(); await b.close();
