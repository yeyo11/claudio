import { execFileSync } from 'node:child_process';
import { createHash, generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { BundleManifest } from '../src/launcher/protocol.ts';

const sha256 = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');

export interface SigningKey {
  privateKey: KeyObject;
  publicPem: string;
}

export function signingKey(): SigningKey {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return { privateKey, publicPem: publicKey.export({ type: 'spki', format: 'pem' }).toString() };
}

/** Writes `files` under `dir` */
export function writeTree(dir: string, files: Record<string, string>): void {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), content);
  }
}

export interface SignedManifest {
  manifest: BundleManifest;
  bytes: Buffer;
  signature: string;
}

/** A manifest over `files`, signed with `key`, the way server-bundle.mjs makes one */
export function signedManifest(
  version: string,
  files: Record<string, string>,
  key: SigningKey,
  extra: Partial<BundleManifest> = {},
): SignedManifest {
  const manifest: BundleManifest = {
    schema: 1,
    version,
    platform: 'linux-x64',
    nodeAbi: process.versions.modules,
    minImage: '0.1.0',
    imageInputs: 'test',
    minShell: '0.1.0',
    shellInputs: 'test',
    commit: 'test',
    builtAt: '2026-10-18T00:00:00.000Z',
    tarball: { name: `claudio-server-${version}-linux-x64.tar.gz`, sha256: '', size: 0 },
    files: Object.fromEntries(Object.entries(files).map(([path, content]) => [path, sha256(content)])),
    ...extra,
  };
  const bytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
  return { manifest, bytes, signature: sign(null, bytes, key.privateKey).toString('base64') };
}

/** An unpacked overlay as the server leaves one in /data/app/<version> */
export function writeOverlay(dir: string, version: string, files: Record<string, string>, key: SigningKey, extra: Partial<BundleManifest> = {}): void {
  writeTree(dir, files);
  const { bytes, signature } = signedManifest(version, files, key, extra);
  writeFileSync(join(dir, 'manifest.json'), bytes);
  writeFileSync(join(dir, 'manifest.json.sig'), signature);
}

/** The three release assets of a bundle: the tarball, and the manifest that names it, signed */
export function releaseAssets(work: string, version: string, files: Record<string, string>, key: SigningKey, extra: Partial<BundleManifest> = {}) {
  const tree = join(work, `tree-${version}`);
  writeTree(tree, files);
  const tarball = join(work, `claudio-server-${version}-linux-x64.tar.gz`);
  execFileSync('tar', ['-czf', tarball, '-C', tree, '.']);
  const bytes = readFileSync(tarball);
  const signed = signedManifest(version, files, key, { tarball: { name: `claudio-server-${version}-linux-x64.tar.gz`, sha256: sha256(bytes), size: bytes.length }, ...extra });
  return { tarball: bytes, ...signed };
}
