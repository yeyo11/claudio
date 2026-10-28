import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

// The headless image's contract with the bundle script and the release workflow
// (docs/plans/headless-image.md, "The image" and "Release"): each is useless if one of the others moves.
const here = dirname(fileURLToPath(import.meta.url));
const read = (path: string) => readFileSync(resolve(here, '../../..', path), 'utf8');
const dockerfile = read('docker/Dockerfile');

/** The text of one stage, from its FROM to the next */
function stage(name: string): string {
  const start = dockerfile.search(new RegExp(`^FROM \\S+ AS ${name}$`, 'm'));
  assert.ok(start >= 0, `stage ${name} exists`);
  const next = dockerfile.slice(start + 1).search(/^FROM /m);
  return next < 0 ? dockerfile.slice(start) : dockerfile.slice(start, start + 1 + next);
}

test('`runtime` stays the last stage: a plain build and the server bundle\'s image inputs both read the last one', () => {
  const last = dockerfile.slice(dockerfile.lastIndexOf('\nFROM ') + 1);
  assert.match(last, /^FROM node:26-bookworm-slim AS runtime$/m);
  assert.ok(dockerfile.indexOf(' AS headless') < dockerfile.indexOf(' AS runtime'));
});

test('the headless stage carries the server, the stub, the guard, the launcher and `claudio`, and nothing a person\'s Claudio adds', () => {
  const headless = stage('headless');
  assert.match(headless, /^FROM node:26-bookworm-slim AS headless$/m);
  for (const file of ['api.mjs', 'mcp.mjs', 'guard.mjs', 'launcher.mjs']) {
    assert.match(headless, new RegExp(`^COPY --from=build --chown=root:root --chmod=0444 /app/apps/api/dist/${file.replace('.', '\\.')} /app/${file.replace('.', '\\.')}$`, 'm'), file);
  }
  assert.match(headless, /^COPY --from=build --chown=root:root --chmod=0444 \/image\.json \/app\/image\.json$/m);
  assert.match(headless, /^COPY --from=build --chown=root:root --chmod=0555 \/app\/apps\/api\/dist\/cli\.mjs \/app\/cli\.mjs$/m);
  assert.match(headless, /ln -s \/app\/cli\.mjs \/usr\/local\/bin\/claudio/);
  // Claude Code, pinned and checksummed like in `runtime`
  assert.match(headless, /^ARG CLAUDE_CODE_VERSION$/m);
  assert.match(headless, /sha256sum -c - \\\n && bash \/tmp\/claude-install\.sh \$\{CLAUDE_CODE_VERSION\}/);
  assert.match(headless, /apt-get install -y --no-install-recommends ca-certificates curl git procps ripgrep \\$/m);

  for (const absent of [/web\/dist|\/app\/web|CLAUDIO_WEB_DIST/, /\bgh\b|glab/i, /tailscale/i, /youtrack/i, /pnpm/, /python3/, /node-pty|terminal-host/, /@number0|collab-host|iroh/, /docker\/keys/, /\/data\/cli/]) {
    assert.doesNotMatch(headless.replace(/^#.*$/gm, ''), absent, `the headless stage carries no ${absent.source}`);
  }
});

test('the headless stage starts the headless profile, in dontAsk, with no tunnel and no in-app update', () => {
  const headless = stage('headless');
  for (const env of ['CLAUDIO_PROFILE=headless', 'CLAUDIO_TUNNEL=off', 'CLAUDIO_DEFAULT_PERMISSION_MODE=dontAsk', 'CLAUDIO_SERVER_UPDATE=off', 'CLAUDIO_WORKSPACE_DIR=/workspace', 'CLAUDIO_WORKSPACES_DIR=/workspaces', 'CLAUDIO_DATA_DIR=/data', 'CLAUDIO_GUARD_ENTRY=/app/guard.mjs', 'CLAUDIO_DISTRIBUTION=docker']) {
    assert.match(headless, new RegExp(`^\\s+${env}( \\\\)?$`, 'm'), env);
  }
  assert.match(headless, /mkdir -p \/app \/workspace \/workspaces \/data \/home\/node\/\.claude/);
  assert.match(headless, /^VOLUME \["\/home\/node\/\.claude", "\/data"\]$/m);
  assert.match(headless, /^USER node$/m);
  assert.ok(headless.lastIndexOf('USER node') > headless.lastIndexOf('USER root'), 'the server does not run as root');
  assert.match(headless, /^HEALTHCHECK [\s\S]*CMD \["\/app\/healthcheck\.sh"\]$/m);
  assert.match(headless, /^ENTRYPOINT \["\/app\/entrypoint\.sh"\]$/m);
  assert.match(headless, /^CMD \["node", "\/app\/launcher\.mjs"\]$/m);
});

test('the bundle builds `claudio` as cli.mjs, from an entry that runs as a program', () => {
  assert.match(read('apps/api/scripts/bundle.mjs'), /^\s+cli: `\$\{root\}src\/cli\/main\.ts`,$/m);
  assert.match(read('apps/api/src/cli/main.ts'), /^#!\/usr\/bin\/env node\n/);
});

test('the image workflow builds and tags the headless target too', () => {
  const workflow = read('.github/workflows/image.yml');
  assert.match(workflow, /^\s+target: headless$/m);
  assert.match(workflow, /suffix=-headless,onlatest=true/);
  assert.match(workflow, /sed 's\/:latest-headless\$\/:headless\/'/);
  assert.match(workflow, /subject-digest: \$\{\{ steps\.build-headless\.outputs\.digest \}\}/);
});
