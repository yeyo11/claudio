// Builds the server bundle an in-app update downloads (docs/plans/container-polish.md, D4, "Release
// assets"), from apps/api/dist and apps/web/dist after `pnpm build`:
//   claudio-server-<v>-linux-x64.tar.gz   dist without guard.mjs and launcher.mjs (the image's own), plus web/
//   claudio-server-<v>-linux-x64.json     the manifest, every file with its sha256
//   claudio-server-<v>-linux-x64.json.sig base64 Ed25519 over the manifest's exact bytes (--sign-with)
//
//   node apps/api/scripts/server-bundle.mjs [--out <dir>] [--version <v>] [--previous <manifest url or file>]
//       [--sign-with <private pem>] [--verify-with <public pem>] [--image-json <file>]
//
// --previous gives minImage: inherited when `imageInputs` (what only a new image can change) is the
// previous release's, else this version. --image-json writes /app/image.json's content and nothing
// else. Run on linux-x64: the native modules staged in dist are the build machine's.
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
/** Never in a bundle: the image is their only source */
const IMAGE_ONLY = new Set(['guard.mjs', 'launcher.mjs']);

const { values: args } = parseArgs({
  options: {
    out: { type: 'string', default: join(root, 'dist/server-bundle') },
    version: { type: 'string' },
    previous: { type: 'string' },
    'sign-with': { type: 'string' },
    'verify-with': { type: 'string' },
    'image-json': { type: 'string' },
  },
});

const version = args.version ?? JSON.parse(readFileSync(join(root, 'apps/api/package.json'), 'utf8')).version;
if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) throw new Error(`not a version: ${version}`);
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

/**
 * A sha256 over what only a new image can change: the runtime stage of the Dockerfile, the
 * entrypoint and the healthcheck, the launcher and the guard the image ships, its public keys, the
 * Node major and ABI, and the native modules' versions. A bundle whose inputs differ from the
 * previous release's needs this release's image.
 */
function imageInputs() {
  const hash = createHash('sha256');
  const add = (label, bytes) => hash.update(`${label}\0${String(bytes.length)}\0`).update(bytes);
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
  return hash.digest('hex');
}

const inputs = imageInputs();

if (args['image-json']) {
  const pin = /^ARG CLAUDE_CODE_VERSION=(\S+)$/m.exec(readFileSync(join(root, 'docker/Dockerfile'), 'utf8'))?.[1] ?? null;
  const image = { version, imageInputs: inputs, nodeAbi: process.versions.modules, claudeCode: pin && /^\d+\.\d+\.\d+/.test(pin) ? pin : null };
  writeFileSync(args['image-json'], `${JSON.stringify(image, null, 2)}\n`);
  console.log(`wrote ${args['image-json']}`);
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
const minImage = previous && previous.imageInputs === inputs && typeof previous.minImage === 'string' ? previous.minImage : version;

// The tree the tarball holds, laid out as /data/app/<version>/ will be
const stage = mkdtempSync(join(tmpdir(), 'claudio-server-bundle-'));
try {
  for (const entry of readdirSync(apiDist)) {
    if (!IMAGE_ONLY.has(entry)) cpSync(join(apiDist, entry), join(stage, entry), { recursive: true, dereference: true });
  }
  if (!existsSync(join(webDist, 'index.html'))) throw new Error('apps/web/dist has no build; run pnpm build first');
  cpSync(webDist, join(stage, 'web'), { recursive: true, dereference: true });
  const files = Object.fromEntries(walk(stage).map((path) => [path, sha256(readFileSync(join(stage, path)))]));

  const base = `claudio-server-${version}-linux-x64`;
  mkdirSync(args.out, { recursive: true });
  const tarball = join(args.out, `${base}.tar.gz`);
  // Owner and times are normalised: the server unpacks it as its own user, whatever built it
  execFileSync('tar', ['--sort=name', '--owner=0', '--group=0', '--numeric-owner', '--mtime=@0', '-czf', tarball, '-C', stage, '.']);
  const bytes = readFileSync(tarball);
  const commit = (() => {
    try {
      return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
    } catch {
      return '';
    }
  })();
  const manifest = {
    schema: 1,
    version,
    platform: 'linux-x64',
    nodeAbi: process.versions.modules,
    minImage,
    imageInputs: inputs,
    commit,
    builtAt: new Date().toISOString(),
    tarball: { name: `${base}.tar.gz`, sha256: sha256(bytes), size: statSync(tarball).size },
    files,
  };
  const manifestFile = join(args.out, `${base}.json`);
  writeFileSync(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`wrote ${tarball} (${String(manifest.tarball.size)} bytes, ${String(Object.keys(files).length)} files), minImage ${minImage}`);

  const signature = `${manifestFile}.sig`;
  if (args['sign-with']) {
    const key = createPrivateKey(readFileSync(args['sign-with']));
    writeFileSync(signature, `${sign(null, readFileSync(manifestFile), key).toString('base64')}\n`);
    console.log(`signed ${manifestFile}`);
  }
  if (args['verify-with']) {
    const key = createPublicKey(readFileSync(args['verify-with']));
    const signed = readFileSync(manifestFile);
    const ok = existsSync(signature) && verify(null, signed, key, Buffer.from(readFileSync(signature, 'utf8').trim(), 'base64'));
    if (!ok) throw new Error(`${signature} does not verify with ${args['verify-with']}`);
    if (sha256(readFileSync(tarball)) !== JSON.parse(signed.toString('utf8')).tarball.sha256) throw new Error('the tarball does not match its manifest');
    console.log(`verified with ${args['verify-with']}`);
  }
} finally {
  rmSync(stage, { recursive: true, force: true });
}
