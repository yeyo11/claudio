import { Endpoint, presetN0, RelayMode } from '@number0/iroh';
const ALPN = Array.from(new TextEncoder().encode('claudio/collab/1'));
async function trial(label, configure) {
  const b = Endpoint.builder(); presetN0(b); b.alpns([ALPN]); configure(b);
  const t = performance.now();
  const ep = await b.bind();
  const online = await Promise.race([ep.online().then(() => true), new Promise((r) => setTimeout(() => r(false), 12000))]);
  console.log(JSON.stringify({ label, online, ms: Math.round(performance.now() - t), homeRelay: ep.addr().relayUrl(), direct: ep.addr().directAddresses().length }));
  await ep.close();
}
await trial('n0 default', () => {});
await trial('custom: n0 US relay only', (b) => b.relayMode(RelayMode.customFromUrls(['https://use1-1.relay.n0.iroh.link./'])));
await trial('custom: unreachable relay', (b) => b.relayMode(RelayMode.customFromUrls(['https://relay.invalid.example./'])));
await trial('relay disabled', (b) => b.relayMode(RelayMode.disabled()));
console.log(JSON.stringify({ staging: RelayMode.staging().relayMap().urls(), defaultMap: RelayMode.defaultMode().relayMap().urls() }));
