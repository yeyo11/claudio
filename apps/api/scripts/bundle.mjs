// Compiles the API into self-contained ESM files under dist/, one per entrypoint:
//   server.mjs  the child process the desktop app spawns (src/standalone.ts)
//   api.mjs     the long-lived service the container starts (src/index.ts)
//   mcp.mjs     the MCP server a chat's CLI starts (packages/mcp/src/main.ts)
//   guard.mjs  the guard program, the hook the CLI runs before each tool call (packages/core/src/guards/main.ts)
//   launcher.mjs  what the container starts: it runs api.mjs from /app or a verified update (packages/core/src/launcher/main.ts)
//   terminal-host.mjs  the process the server forks for the person's terminals (packages/core/src/terminals/host/main.ts)
//   collab-host.mjs  the process the server forks for the Collaborators iroh endpoint (packages/core/src/collab/host/main.ts)
//   cli.mjs     `claudio login` and `claudio status`, the operator's command over the API (src/cli/main.ts)
// Only node: builtins stay external (node:sqlite among them), so no file needs node_modules, a source
// tree or a transpiler beside it. The exceptions are the two native modules Claudio ships, staged beside
// the bundles below: node-pty, which only terminal-host.mjs loads, and @number0/iroh, which only
// collab-host.mjs loads, lazily, so a machine where it cannot load runs everything else as before.
import { build } from 'esbuild';
import { cpSync, mkdirSync, realpathSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));

await build({
  // Both outputs repeat the code they share on purpose: splitting would emit a chunk beside them,
  // and each one ships alone (electron-builder copies server.mjs, the image copies api.mjs).
  // mcp.mjs is Claudio's own MCP server (packages/mcp): the CLI starts it as a child of a chat, so it is a
  // file of its own and not part of the API.
  entryPoints: {
    server: `${root}src/standalone.ts`,
    api: `${root}src/index.ts`,
    mcp: `${root}../../packages/mcp/src/main.ts`,
    'terminal-host': `${root}../../packages/core/src/terminals/host/main.ts`,
    'collab-host': `${root}../../packages/core/src/collab/host/main.ts`,
    // The PreToolUse hook the CLI runs per tool call (packages/core/src/guards/main.ts): it ships alone and read-only
    guard: `${root}../../packages/core/src/guards/main.ts`,
    // The container's launcher (packages/core/src/launcher/main.ts): root-owned in the image like the guard, never part of an update
    launcher: `${root}../../packages/core/src/launcher/main.ts`,
    // `claudio`, the operator's command (src/cli/main.ts): the headless image links it as /usr/local/bin/claudio
    cli: `${root}src/cli/main.ts`,
  },
  external: ['node-pty', '@number0/iroh'],
  outdir: `${root}dist`,
  outExtension: { '.js': '.mjs' },
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  // Some CJS dependencies call require(); ESM output has none, so provide one
  banner: { js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);" },
  logLevel: 'info',
});

// What ships of node-pty is package.json, lib/ and the Linux x64 prebuild (172 KiB), copied with pnpm's
// symlinks dereferenced. Node's resolution from terminal-host.mjs finds it in dist/node_modules, and
// the Docker image and electron-builder both copy that folder as it is. The pinned beta carries the
// binary, so nothing compiles (docs/plans/terminal.md, "Facts from t0").
const ptyRoot = dirname(createRequire(`${root}../../packages/core/package.json`).resolve('node-pty/package.json'));
const staged = join(root, 'dist', 'node_modules', 'node-pty');
rmSync(staged, { recursive: true, force: true });
mkdirSync(join(staged, 'prebuilds'), { recursive: true });
for (const entry of ['package.json', 'lib']) cpSync(realpathSync(join(ptyRoot, entry)), join(staged, entry), { recursive: true, dereference: true });
cpSync(realpathSync(join(ptyRoot, 'prebuilds', 'linux-x64')), join(staged, 'prebuilds', 'linux-x64'), { recursive: true, dereference: true });

// @number0/iroh is its JS (package.json and index.js, 168 KiB) plus one platform package with the
// prebuilt binding (20 MiB for Linux x64 glibc), both copied with pnpm's symlinks dereferenced into
// dist/node_modules/@number0/, where Node's resolution from collab-host.mjs finds them; the binding's
// loader requires `@number0/iroh-<platform>` by name. The staged platform is the build machine's, the
// one the Docker image and the Linux packages ship (docs/plans/collaborators.md §3.2, §7.2).
const irohRoot = dirname(createRequire(`${root}../../packages/core/package.json`).resolve('@number0/iroh/package.json'));
const irohPlatform = `@number0/iroh-${process.platform}-${process.arch}${process.platform === 'linux' ? (process.report.getReport().header.glibcVersionRuntime ? '-gnu' : '-musl') : ''}`;
const irohStaged = join(root, 'dist', 'node_modules', '@number0');
rmSync(irohStaged, { recursive: true, force: true });
mkdirSync(join(irohStaged, 'iroh'), { recursive: true });
for (const entry of ['package.json', 'index.js']) cpSync(realpathSync(join(irohRoot, entry)), join(irohStaged, 'iroh', entry), { dereference: true });
let irohBinding = null;
try {
  irohBinding = dirname(createRequire(join(irohRoot, 'package.json')).resolve(`${irohPlatform}/package.json`));
} catch {
  // No prebuild for this machine (macOS Intel): the bundle still runs, with Collaborators unavailable
  console.warn(`bundle: ${irohPlatform} is not installed; Collaborators will be unavailable in this build`);
}
if (irohBinding) cpSync(realpathSync(irohBinding), join(irohStaged, irohPlatform.slice('@number0/'.length)), { recursive: true, dereference: true });
