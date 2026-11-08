import { createPrivateKey, createPublicKey, KeyObject, webcrypto, X509Certificate } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { isIPv4 } from 'node:net';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { createSecureContext, type SecureContext } from 'node:tls';
import type { X509CertificateGenerator } from '@peculiar/x509';
import { writeAtomic } from './config/files.ts';
import { dataDirFrom } from './paths.ts';

/*
 * The LAN listener's certificate (docs/plans/claudio-servers.md, D5 and D6). Self-signed, made once
 * and kept under `<data dir>/lan-tls/`, so its SHA-256 fingerprint is what a hub pins at pairing and
 * what a person compares on the LAN card: no CA vouches for it, the fingerprint does. It names the
 * machine's LAN addresses and `<hostname>.local`, and is made again only when the listener serves an
 * address it does not name (or it is close to expiring), never on a plain restart: a new certificate
 * is a new fingerprint, which every hub that paired with this server takes for a changed identity.
 */

/**
 * What `GET /meta` lists while this server's LAN listener speaks TLS (plan §9.1). The list lives in
 * remote-side's `ServerIdentity` (`meta.ts`), built in parallel with this module: once both are in one
 * tree, `Core` declares it with `this.identity.declare(LAN_TLS_CAPABILITY)` right after the identity is made
 */
export const LAN_TLS_CAPABILITY = 'lan-tls';

const DIR = 'lan-tls';
const KEY_FILE = 'key.pem';
const CERT_FILE = 'cert.pem';
const DAY_MS = 24 * 60 * 60 * 1000;
/** Long: a pinned certificate is trusted by its fingerprint, and each renewal breaks every pairing */
const VALID_DAYS = 3650;
/** Renewed this close to its end, so it never expires under a listener that is open */
const RENEW_BEFORE_DAYS = 30;
/** Backdated a day: a device whose clock runs behind would otherwise see a certificate from the future */
const BACKDATE_MS = DAY_MS;
/** ECDSA P-256 with SHA-256: what every browser and Node's TLS accept, and fast to make */
const KEY_ALGORITHM = { name: 'ECDSA', namedCurve: 'P-256' } as const;
const SIGNING_ALGORITHM = { name: 'ECDSA', namedCurve: 'P-256', hash: 'SHA-256' } as const;

type X509Keys = Parameters<typeof X509CertificateGenerator.createSelfSigned>[0]['keys'];

/** The names a certificate covers: IPv4 addresses and DNS names, lower case */
export interface LanCertificateNames {
  ips: string[];
  dns: string[];
}

export interface LanCertificate {
  /** PEM, PKCS#8 */
  key: string;
  /** PEM */
  cert: string;
  /** SHA-256 of the certificate's DER, upper-case hex pairs joined by colons */
  fingerprint: string;
  names: LanCertificateNames;
  notAfter: Date;
}

export const lanTlsDir = (dataDir: string): string => join(dataDir, DIR);

/** `<hostname>.local` when the machine's name is a valid DNS label, as mDNS answers for it */
export function localDnsName(name: string = hostname()): string | null {
  const label = name.trim().toLowerCase().split('.')[0] ?? '';
  return /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label) ? `${label}.local` : null;
}

/** The names in Node's `subjectAltName` text (`DNS:a.local, IP Address:192.168.1.2`) */
function namesOf(x509: X509Certificate): LanCertificateNames {
  const ips: string[] = [];
  const dns: string[] = [];
  for (const entry of (x509.subjectAltName ?? '').split(', ')) {
    if (entry.startsWith('DNS:')) dns.push(entry.slice(4).toLowerCase());
    else if (entry.startsWith('IP Address:')) ips.push(entry.slice(11));
  }
  return { ips, dns };
}

/** The kept certificate when its key is there and matches it; null when there is none or it is damaged */
export function readLanCertificate(dataDir: string): LanCertificate | null {
  const dir = lanTlsDir(dataDir);
  const keyFile = join(dir, KEY_FILE);
  const certFile = join(dir, CERT_FILE);
  if (!existsSync(keyFile) || !existsSync(certFile)) return null;
  try {
    const key = readFileSync(keyFile, 'utf8');
    const cert = readFileSync(certFile, 'utf8');
    const x509 = new X509Certificate(cert);
    // A crash between writing a new key and its certificate leaves a pair that cannot serve
    if (!x509.checkPrivateKey(createPrivateKey(key))) return null;
    return { key, cert, fingerprint: x509.fingerprint256, names: namesOf(x509), notAfter: new Date(x509.validTo) };
  } catch {
    return null;
  }
}

/**
 * The fingerprint of this server's LAN certificate, for the pairing grant (`ServerLinkGrant.tlsFingerprint`)
 * and the LAN card; null until the listener has made one. Read from the files, so it is the one the
 * listener serves whichever object asks. Pass the core's data dir; the default is the environment's.
 */
export function lanCertificateFingerprint(dataDir: string = dataDirFrom()): string | null {
  return readLanCertificate(dataDir)?.fingerprint ?? null;
}

/** Whether `certificate` names everything in `wanted` and is not about to expire */
export function lanCertificateCovers(certificate: LanCertificate, wanted: LanCertificateNames, now: Date = new Date()): boolean {
  if (certificate.notAfter.getTime() - now.getTime() < RENEW_BEFORE_DAYS * DAY_MS) return false;
  const ips = new Set(certificate.names.ips);
  const dns = new Set(certificate.names.dns);
  return wanted.ips.every((ip) => ips.has(ip)) && wanted.dns.every((name) => dns.has(name.toLowerCase()));
}

/** Only what a certificate can name: IPv4 literals and DNS names, each once */
function clean(wanted: LanCertificateNames): LanCertificateNames {
  return {
    ips: [...new Set(wanted.ips.filter((ip) => isIPv4(ip)))],
    dns: [...new Set(wanted.dns.map((name) => name.toLowerCase()).filter((name) => /^[a-z0-9.-]{1,253}$/.test(name)))],
  };
}

/** The kept key when it is the kind this module makes; a renewal keeps it, so the public key outlives an address change */
function reusableKey(pem: string | null): KeyObject | null {
  if (!pem) return null;
  try {
    const key = createPrivateKey(pem);
    return key.asymmetricKeyType === 'ec' && key.asymmetricKeyDetails?.namedCurve === 'prime256v1' ? key : null;
  } catch {
    return null;
  }
}

async function generate(names: LanCertificateNames, kept: KeyObject | null, now: Date): Promise<{ key: string; cert: string }> {
  // Loaded only when a certificate is made, which is once per data dir in practice: tsyringe, under
  // @peculiar/x509, needs the Reflect metadata polyfill before the library is evaluated
  await import('reflect-metadata');
  const x509 = await import('@peculiar/x509');
  const { subtle } = webcrypto;
  let pair: webcrypto.CryptoKeyPair;
  let keyPem: string;
  if (kept) {
    keyPem = kept.export({ type: 'pkcs8', format: 'pem' }).toString();
    pair = {
      privateKey: await subtle.importKey('pkcs8', kept.export({ type: 'pkcs8', format: 'der' }), KEY_ALGORITHM, false, ['sign']),
      publicKey: await subtle.importKey('spki', createPublicKey(kept).export({ type: 'spki', format: 'der' }), KEY_ALGORITHM, true, ['verify']),
    };
  } else {
    pair = await subtle.generateKey(KEY_ALGORITHM, true, ['sign', 'verify']);
    keyPem = KeyObject.from(pair.privateKey).export({ type: 'pkcs8', format: 'pem' }).toString();
  }
  // The same objects: the library's declarations name the global WebCrypto types, whose `KeyUsage`
  // lags Node's by a member or two in some of the workspace's compilations
  const keys = pair as unknown as X509Keys;
  const subject = names.dns[0] ?? 'claudio';
  const general = [...names.dns.map((value) => ({ type: 'dns' as const, value })), ...names.ips.map((value) => ({ type: 'ip' as const, value }))];
  const cert = await x509.X509CertificateGenerator.createSelfSigned({
    name: `CN=${subject}`,
    keys,
    signingAlgorithm: SIGNING_ALGORITHM,
    notBefore: new Date(now.getTime() - BACKDATE_MS),
    notAfter: new Date(now.getTime() + VALID_DAYS * DAY_MS),
    extensions: [
      new x509.BasicConstraintsExtension(false, undefined, true),
      new x509.KeyUsagesExtension(x509.KeyUsageFlags.digitalSignature, true),
      new x509.ExtendedKeyUsageExtension([x509.ExtendedKeyUsage.serverAuth]),
      // A certificate with an empty SAN extension is malformed; without names, the fingerprint is all there is
      ...(general.length ? [new x509.SubjectAlternativeNameExtension(general)] : []),
      await x509.SubjectKeyIdentifierExtension.create(keys.publicKey),
    ],
  });
  return { key: keyPem, cert: cert.toString('pem') };
}

/**
 * The kept certificate when it names `wanted`, else a new one for exactly `wanted`, kept for the next
 * start. The key is written first with mode 0600 in a 0700 directory; a crash before the certificate
 * follows leaves a pair `readLanCertificate` rejects, so the next call makes it again.
 */
export async function ensureLanCertificate(dataDir: string, wanted: LanCertificateNames, now: Date = new Date()): Promise<{ certificate: LanCertificate; generated: boolean }> {
  const names = clean(wanted);
  const current = readLanCertificate(dataDir);
  if (current && lanCertificateCovers(current, names, now)) return { certificate: current, generated: false };
  const dir = lanTlsDir(dataDir);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  let keptPem: string | null = null;
  try {
    keptPem = readFileSync(join(dir, KEY_FILE), 'utf8');
  } catch {
    // No key yet: one is made
  }
  const kept = reusableKey(keptPem);
  const made = await generate(names, kept, now);
  if (!kept) await writeAtomic(join(dir, KEY_FILE), made.key, 0o600);
  await writeAtomic(join(dir, CERT_FILE), made.cert, 0o644);
  const certificate = readLanCertificate(dataDir);
  if (!certificate) throw new Error('the LAN certificate just made cannot be read back');
  return { certificate, generated: true };
}

/** What a TLS socket of the listener is made with: TLS 1.2 at least, as every client this serves speaks it */
export function lanSecureContext(certificate: LanCertificate): SecureContext {
  return createSecureContext({ key: certificate.key, cert: certificate.cert, minVersion: 'TLSv1.2' });
}
