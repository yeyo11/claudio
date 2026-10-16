// Proves the lazy, soft load the plan requires (§2, §3.2): a missing or broken native file must not take Claudio down.
const t = performance.now();
try {
  const iroh = await import('@number0/iroh');
  const key = iroh.SecretKey.generate();
  console.log(JSON.stringify({ loaded: true, ms: Math.round(performance.now() - t), node: process.versions.node, electron: process.versions.electron ?? null, platform: `${process.platform}-${process.arch}`, sampleId: key.public().toString().slice(0, 12) }));
} catch (e) {
  console.log(JSON.stringify({ loaded: false, ms: Math.round(performance.now() - t), node: process.versions.node, platform: `${process.platform}-${process.arch}`, reason: String(e?.message ?? e).split('\n')[0] }));
}
