// Compiles the Electron main and preload processes, and the daemon, into dist/. Both are CommonJS: a sandboxed preload
// cannot be ESM, and Electron's main works the same with either. `electron` is provided by the runtime;
// everything else, electron-updater included, is bundled in, because only dist/ ships (electron-builder.yml).
import { build } from 'esbuild';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
// The daemon reports the version its own code is (src/version.ts), which apt may have moved past on disk
const { version } = JSON.parse(readFileSync(`${root}package.json`, 'utf8'));

await build({
  // daemon: the server's supervisor, run on the desktop binary as Node (src/daemon-entry.ts)
  entryPoints: { main: `${root}src/main.ts`, preload: `${root}src/preload.ts`, daemon: `${root}src/daemon-entry.ts` },
  outdir: `${root}dist`,
  outExtension: { '.js': '.cjs' },
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node24',
  external: ['electron'],
  define: { __CLAUDIO_DESKTOP_VERSION__: JSON.stringify(version) },
  sourcemap: true,
  logLevel: 'info',
});
