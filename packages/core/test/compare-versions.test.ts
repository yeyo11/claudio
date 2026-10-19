import assert from 'node:assert/strict';
import { test } from 'node:test';
import { compareVersions } from '../src/launcher/protocol.ts';

const sign = (n: number) => (n > 0 ? 1 : n < 0 ? -1 : 0);

// [a, b, expected sign of compareVersions(a, b)]
const CASES: [string, string, -1 | 0 | 1][] = [
  // Plain versions keep their numeric order
  ['2.1.10', '2.1.9', 1],
  ['2.2.0', '2.1.99', 1],
  ['1.0.0', '1.0.0', 0],
  ['0.6.1', '0.7.0', -1],
  ['2.1', '2.1.0', 0],
  // A pre-release sorts below its release, and above the previous release
  ['1.2.3-rc.1', '1.2.3', -1],
  ['1.2.3', '1.2.3-smoke.9', 1],
  ['1.2.3-alpha', '1.2.2', 1],
  // Two pre-releases of the same version (SemVer 2.0 §11.4)
  ['1.2.3-smoke.1', '1.2.3-smoke.2', -1],
  ['1.2.3-beta.2', '1.2.3-beta.10', -1],
  ['1.2.3-beta.10', '1.2.3-beta.9', 1],
  ['1.2.3-beta', '1.2.3-rc', -1],
  ['1.2.3-beta.11', '1.2.3-rc.1', -1],
  ['1.2.3-rc.1', '1.2.3-rc.1', 0],
  // Numeric identifiers sort below alphanumeric ones
  ['1.2.3-1', '1.2.3-alpha', -1],
  ['1.2.3-alpha.1', '1.2.3-alpha.beta', -1],
  // Fewer identifiers first when the rest are equal
  ['1.2.3-alpha', '1.2.3-alpha.1', -1],
  ['1.2.3-alpha.1.1', '1.2.3-alpha.1', 1],
  // The SemVer spec's own chain, pairwise
  ['1.0.0-alpha.1', '1.0.0-alpha.beta', -1],
  ['1.0.0-alpha.beta', '1.0.0-beta', -1],
  ['1.0.0-beta', '1.0.0-beta.2', -1],
  ['1.0.0-beta.2', '1.0.0-beta.11', -1],
  ['1.0.0-beta.11', '1.0.0-rc.1', -1],
  ['1.0.0-rc.1', '1.0.0', -1],
  // Alphanumeric identifiers in ASCII order; hyphens belong to the identifier
  ['1.0.0-Beta', '1.0.0-beta', -1],
  ['1.0.0-x-y', '1.0.0-x.y', 1],
  // Numbers past 2^53 still compare as numbers
  ['1.0.0-9007199254740993', '1.0.0-9007199254740992', 1],
  // Build metadata never counts
  ['1.2.3+build.5', '1.2.3+build.9', 0],
  ['1.2.3-rc.1+abc', '1.2.3-rc.1', 0],
  ['1.2.3+abc', '1.2.3-rc.1', 1],
  ['1.2.4+abc', '1.2.3', 1],
];

test('versions are ordered by SemVer 2.0 precedence, pre-releases of one version included', () => {
  for (const [a, b, expected] of CASES) {
    assert.equal(sign(compareVersions(a, b)), expected, `${a} vs ${b}`);
    assert.equal(sign(compareVersions(b, a)), -expected || 0, `${b} vs ${a}`);
  }
});

test('a list of releases and pre-releases sorts into publishing order', () => {
  const ordered = ['0.9.0', '1.0.0-alpha', '1.0.0-alpha.1', '1.0.0-beta.2', '1.0.0-beta.10', '1.0.0-rc.1', '1.0.0', '1.0.1-smoke.1', '1.0.1-smoke.2', '1.0.1'];
  const shuffled = [...ordered].reverse();
  assert.deepEqual(shuffled.sort(compareVersions), ordered);
});
