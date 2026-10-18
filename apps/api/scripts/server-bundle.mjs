// Builds the server bundle an in-app update downloads (docs/plans/container-polish.md, D4, "Release
// assets"; docs/plans/unified-updates.md, D1, D2, D7), from apps/api/dist and apps/web/dist after
// `pnpm build`:
//   claudio-server-<v>-linux-x64.tar.gz   dist without guard.mjs and launcher.mjs (the base's own), plus web/
//   claudio-server-<v>-linux-x64.json     the manifest, every file with its sha256
//   claudio-server-<v>-linux-x64.json.sig the Ed25519 signature over the manifest's exact bytes (--sign-with)
//
//   node apps/api/scripts/server-bundle.mjs [--out <dir>] [--version <v>] [--previous <manifest url or file>]
//       [--sign-with <private pem>]... [--verify-with <public pem>]... [--image-json <file>]
//       [--shell-json <file>] [--desktop-manifest <dir>] [--claude-code <version>] [--commit <sha>]
//
// --previous gives minImage and minShell: each is inherited when its inputs (`imageInputs`, what only
// a new image can change; `shellInputs`, what only a new desktop shell can change) are the previous
// release's, else it is this version. --image-json writes /app/image.json's content and nothing else;
// --shell-json writes the desktop shell's `<resources>/shell.json` (`{ version, shellInputs }`) and
// nothing else. Run on linux-x64: the native modules staged in dist are the build machine's.
// --claude-code is the pin the image installs (its CLAUDE_CODE_VERSION build arg), which can differ
// from the Dockerfile's default; --commit is the commit the bundle was built from, because a Docker
// build has no .git to ask (.dockerignore leaves it out).
//
// --desktop-manifest <dir> writes the desktop manifest instead of a bundle: claudio-desktop-<v>-linux-x64.json
// (and .sig with --sign-with), listing Claudio-<v>-x86_64.AppImage and Claudio-<v>-amd64.deb found in
// <dir> with their size, sha256 and sha512, beside `shellInputs` and `minShell`. It goes to --out
// when given, else into <dir>. It needs no build of the server.
//
// Signatures: one --sign-with writes one bare base64 line (phase 1's format); several write one line
// per key, `<keyId> <base64>`, keyId being the first 16 hex characters of the sha256 of the public
// key's DER, so a key rotation overlaps. --verify-with, given once or more, checks the written
// signature the way the launcher does: some line must verify with some given key.
import { execFileSync } from 'node:child_process';
import { createHash, createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const apiDist = join(root, 'apps/api/dist');
const webDist = join(root, 'apps/web/dist');
/** Never in a bundle: the base (the image, the desktop shell) is their only source */
const IMAGE_ONLY = new Set(['guard.mjs', 'launcher.mjs']);

const { values: args } = parseArgs({
  options: {
    out: { type: 'string' },
    version: { type: 'string' },
    previous: { type: 'string' },
    'sign-with': { type: 'string', multiple: true },
    'verify-with': { type: 'string', multiple: true },
    'image-json': { type: 'string' },
    'shell-json': { type: 'string' },
    'desktop-manifest': { type: 'string' },
    'claude-code': { type: 'string' },
    commit: { type: 'string' },
  },
});

const version = args.version ?? JSON.parse(readFileSync(join(root, 'apps/api/package.json'), 'utf8')).version;
const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
if (!VERSION.test(version)) throw new Error(`not a version: ${version}`);
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

/** Every regular file under `dir`, `/`-separated and sorted, so the same tree always hashes the same */
function walk(dir, rel = '') {
  return readdirSync(join(dir, rel), { withFileTypes: true })
    .sort((a, b) => (a.name < b.name ? -1 : 1))
    .flatMap((entry) => {
      const path = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) return walk(dir, path);
      if (entry.isSymbolicLink()) throw new Error(`${path} is a symlink; the bundle carries files only`);
      return [path];
    });
}

const packageVersion = (name) => JSON.parse(readFileSync(join(apiDist, 'node_modules', name, 'package.json'), 'utf8')).version;

/** Each part goes in with its label and length, so moving bytes from one part to the next changes the hash */
function hasher() {
  const hash = createHash('sha256');
  const add = (label, bytes) => hash.update(`${label}\0${String(bytes.length)}\0`).update(bytes);
  return { add, digest: () => hash.digest('hex') };
}

/**
 * A sha256 over what only a new image can change: the runtime stage of the Dockerfile, the
 * entrypoint and the healthcheck, the launcher and the guard the image ships, its public keys, the
 * Node major and ABI, and the native modules' versions. A bundle whose inputs differ from the
 * previous release's needs this release's image.
 */
function imageInputs() {
  const { add, digest } = hasher();
  const dockerfile = readFileSync(join(root, 'docker/Dockerfile'), 'utf8');
  const runtime = dockerfile.slice(dockerfile.search(/^FROM .*$(?![\s\S]*^FROM )/m));
  add('Dockerfile runtime stage', Buffer.from(runtime));
  for (const file of ['docker/entrypoint.sh', 'docker/healthcheck.sh']) add(file, readFileSync(join(root, file)));
  for (const file of ['launcher.mjs', 'guard.mjs']) add(file, readFileSync(join(apiDist, file)));
  const keys = join(root, 'docker/keys');
  for (const file of existsSync(keys) ? walk(keys) : []) add(`docker/keys/${file}`, readFileSync(join(keys, file)));
  add('node', Buffer.from(`${process.versions.node.split('.')[0]} ${process.versions.modules}`));
  add('node-pty', Buffer.from(packageVersion('node-pty')));
  add('@number0/iroh', Buffer.from(packageVersion('@number0/iroh')));
  return digest();
}

/**
 * The Electron the desktop shell is built with, as the lockfile resolved it: the same answer in the
 * Docker build (which never installs Electron) and in the desktop job.
 */
function electronVersion() {
  const lock = readFileSync(join(root, 'pnpm-lock.yaml'), 'utf8');
  const start = lock.search(/^ {2}apps\/desktop:$/m);
  if (start === -1) throw new Error('pnpm-lock.yaml has no apps/desktop importer');
  const section = lock.slice(start + 1, start + 1 + lock.slice(start + 1).search(/^ {2}\S|$(?![\s\S])/m));
  const found = /^ {6}electron:\n {8}specifier: .*\n {8}version: ([^\s(]+)/m.exec(section);
  if (!found?.[1]) throw new Error('pnpm-lock.yaml resolves no electron for apps/desktop');
  return found[1];
}

/**
 * A native module's version: what the core package pins exactly, so the server bundle (built in the
 * image's build stage) and the desktop shell (built in the desktop job) hash the same.
 */
function pinnedVersion(name) {
  const spec = JSON.parse(readFileSync(join(root, 'packages/core/package.json'), 'utf8')).dependencies?.[name];
  if (typeof spec !== 'string' || !VERSION.test(spec)) throw new Error(`packages/core does not pin ${name} to one version`);
  return spec;
}

/**
 * A sha256 over what only a new desktop shell can change (D2): Electron (and with it its Node, ABI
 * and N-API level), the native modules' versions, the launcher's state machine and verification, the
 * guard and its rules format, the public keys, the IPC the payload's web speaks to the shell, and
 * the shell's host of the machine. A bundle whose inputs differ from the previous release's needs
 * this release's shell.
 */
function shellInputs() {
  const { add, digest } = hasher();
  add('electron', Buffer.from(electronVersion()));
  add('node-pty', Buffer.from(pinnedVersion('node-pty')));
  add('@number0/iroh', Buffer.from(pinnedVersion('@number0/iroh')));
  for (const dir of ['packages/core/src/launcher', 'packages/core/src/guards']) {
    for (const file of walk(join(root, dir))) add(`${dir}/${file}`, readFileSync(join(root, dir, file)));
  }
  const keys = join(root, 'docker/keys');
  for (const file of existsSync(keys) ? walk(keys).filter((name) => name.endsWith('.pub')) : []) add(`docker/keys/${file}`, readFileSync(join(keys, file)));
  for (const file of ['apps/desktop/src/ipc.ts', 'apps/desktop/src/preload.ts', 'apps/desktop/src/payload.ts']) {
    // Absent is a state of its own, apart from empty
    if (existsSync(join(root, file))) add(file, readFileSync(join(root, file)));
    else add(`${file} (absent)`, Buffer.alloc(0));
  }
  return digest();
}

/** The `.sig` content for `bytes`: a bare base64 line for one key, `<keyId> <base64>` lines for several */
function signatureOf(bytes, keyFiles) {
  const keys = keyFiles.map((file) => createPrivateKey(readFileSync(file)));
  if (keys.length === 1) return `${sign(null, bytes, keys[0]).toString('base64')}\n`;
  return keys.map((key) => `${keyIdOf(createPublicKey(key))} ${sign(null, bytes, key).toString('base64')}\n`).join('');
}

const keyIdOf = (publicKey) => sha256(publicKey.export({ type: 'spki', format: 'der' })).slice(0, 16);

/** The launcher's rule (packages/core/src/launcher/protocol.ts, verifyManifest): some line verifies with some key */
function verifies(bytes, signature, keyFiles) {
  const keys = keyFiles.map((file) => createPublicKey(readFileSync(file)));
  const lines = signature.split('\n').map((line) => line.trim()).filter(Boolean);
  if (lines.length === 0 || lines.length > 8) return false;
  return lines.some((line) => {
    const fields = line.split(/\s+/);
    if (fields.length > 2) return false;
    const id = fields.length === 2 ? fields[0] : null;
    const sig = Buffer.from(fields.at(-1), 'base64');
    if (sig.length !== 64) return false;
    return keys.some((key) => (id === null || keyIdOf(key) === id) && verify(null, bytes, key, sig));
  });
}

/** Signs `file` into `file.sig` with every --sign-with key, then checks it against every --verify-with key */
function signAndVerify(file) {
  const signature = `${file}.sig`;
  if (args['sign-with']?.length) {
    writeFileSync(signature, signatureOf(readFileSync(file), args['sign-with']));
    console.log(`signed ${file} with ${String(args['sign-with'].length)} key(s)`);
  }
  if (args['verify-with']?.length) {
    const ok = existsSync(signature) && verifies(readFileSync(file), readFileSync(signature, 'utf8'), args['verify-with']);
    if (!ok) throw new Error(`${signature} does not verify with ${args['verify-with'].join(', ')}`);
    console.log(`verified with ${args['verify-with'].join(', ')}`);
  }
}

const commitOf = () =>
  args.commit ||
  (() => {
    try {
      return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
    } catch {
      return '';
    }
  })();

if (args['image-json']) {
  const pin = args['claude-code'] || (/^ARG CLAUDE_CODE_VERSION=(\S+)$/m.exec(readFileSync(join(root, 'docker/Dockerfile'), 'utf8'))?.[1] ?? null);
  const image = { version, imageInputs: imageInputs(), nodeAbi: process.versions.modules, claudeCode: pin && /^\d+\.\d+\.\d+/.test(pin) ? pin : null };
  writeFileSync(args['image-json'], `${JSON.stringify(image, null, 2)}\n`);
  console.log(`wrote ${args['image-json']}`);
  process.exit(0);
}

if (args['shell-json']) {
  writeFileSync(args['shell-json'], `${JSON.stringify({ version, shellInputs: shellInputs() }, null, 2)}\n`);
  console.log(`wrote ${args['shell-json']}`);
  process.exit(0);
}

async function previousManifest(source) {
  if (!source) return null;
  if (/^https?:\/\//.test(source)) {
    const res = await fetch(source, { headers: { 'user-agent': 'claudio-server-bundle' } });
    // The first release with a bundle has no previous one
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`${source} answered ${String(res.status)}`);
    return res.json();
  }
  return existsSync(source) ? JSON.parse(readFileSync(source, 'utf8')) : null;
}

const previous = await previousManifest(args.previous);
/** Inherited while the inputs stay the previous release's, else this version */
const inherit = (field, inputsField, inputs) =>
  previous && previous[inputsField] === inputs && typeof previous[field] === 'string' && VERSION.test(previous[field]) ? previous[field] : version;

if (args['desktop-manifest']) {
  const dir = args['desktop-manifest'];
  const shell = shellInputs();
  const names = [`Claudio-${version}-x86_64.AppImage`, `Claudio-${version}-amd64.deb`].filter((name) => existsSync(join(dir, name)));
  if (names.length === 0) throw new Error(`${dir} holds neither Claudio-${version}-x86_64.AppImage nor Claudio-${version}-amd64.deb`);
  const files = Object.fromEntries(
    names.map((name) => {
      const bytes = readFileSync(join(dir, name));
      return [name, { size: bytes.length, sha256: sha256(bytes), sha512: createHash('sha512').update(bytes).digest('hex') }];
    }),
  );
  const manifest = { schema: 1, version, shellInputs: shell, minShell: inherit('minShell', 'shellInputs', shell), commit: commitOf(), builtAt: new Date().toISOString(), files };
  const out = args.out ?? dir;
  mkdirSync(out, { recursive: true });
  const manifestFile = join(out, `claudio-desktop-${version}-linux-x64.json`);
  writeFileSync(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`wrote ${manifestFile} (${names.join(', ')}), minShell ${manifest.minShell}`);
  signAndVerify(manifestFile);
  process.exit(0);
}

const inputs = imageInputs();
const shell = shellInputs();
const minImage = inherit('minImage', 'imageInputs', inputs);
const minShell = inherit('minShell', 'shellInputs', shell);
const out = args.out ?? join(root, 'dist/server-bundle');

// The tree the tarball holds, laid out as <dataDir>/app/<version>/ will be
const stage = mkdtempSync(join(tmpdir(), 'claudio-server-bundle-'));
try {
  for (const entry of readdirSync(apiDist)) {
    if (!IMAGE_ONLY.has(entry)) cpSync(join(apiDist, entry), join(stage, entry), { recursive: true, dereference: true });
  }
  if (!existsSync(join(webDist, 'index.html'))) throw new Error('apps/web/dist has no build; run pnpm build first');
  cpSync(webDist, join(stage, 'web'), { recursive: true, dereference: true });
  const files = Object.fromEntries(walk(stage).map((path) => [path, sha256(readFileSync(join(stage, path)))]));

  const base = `claudio-server-${version}-linux-x64`;
  mkdirSync(out, { recursive: true });
  const tarball = join(out, `${base}.tar.gz`);
  // Owner and times are normalised: the server unpacks it as its own user, whatever built it
  execFileSync('tar', ['--sort=name', '--owner=0', '--group=0', '--numeric-owner', '--mtime=@0', '-czf', tarball, '-C', stage, '.']);
  const bytes = readFileSync(tarball);
  const manifest = {
    schema: 1,
    version,
    platform: 'linux-x64',
    nodeAbi: process.versions.modules,
    minImage,
    imageInputs: inputs,
    minShell,
    shellInputs: shell,
    commit: commitOf(),
    builtAt: new Date().toISOString(),
    tarball: { name: `${base}.tar.gz`, sha256: sha256(bytes), size: statSync(tarball).size },
    files,
  };
  const manifestFile = join(out, `${base}.json`);
  writeFileSync(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`wrote ${tarball} (${String(manifest.tarball.size)} bytes, ${String(Object.keys(files).length)} files), minImage ${minImage}, minShell ${minShell}`);
  signAndVerify(manifestFile);
  if (args['verify-with']?.length && sha256(readFileSync(tarball)) !== JSON.parse(readFileSync(manifestFile, 'utf8')).tarball.sha256) throw new Error('the tarball does not match its manifest');
} finally {
  rmSync(stage, { recursive: true, force: true });
}
