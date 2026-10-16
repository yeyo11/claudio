import { bindEndpoint } from './endpoint.mjs';
const ep = await bindEndpoint({ preset: 'minimal' });
const h = ep.watchNetworkChange(() => {});
await new Promise(r => setTimeout(r, 300));
await h.stop();
await ep.close();
console.log('watchNetworkChange ok');
