import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { Core, loadConfig } from '@claudio/core';
import { buildApp } from '../src/app.ts';
import { assetName, namesFile, requestPath } from '../src/web-assets.ts';

// Skew protection (docs/plans/remote-updates.md, D6): a page opened before an update asks for the
// hashed files of its own build. The kept builds answer for them; any other missing file is a 404
// that is not HTML, because a script answered with the shell is what Safari reports as
// "'text/html' is not a valid JavaScript MIME type".

const roots = new Set<string>();
after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

const SHELL = '<!doctype html><title>Claudio</title>';

async function wrapper(withOverlay = true) {
  const root = mkdtempSync(join(tmpdir(), 'claudio-stale-assets-'));
  roots.add(root);
  const web = join(root, 'web');
  mkdirSync(join(web, 'assets'), { recursive: true });
  writeFileSync(join(web, 'index.html'), SHELL);
  writeFileSync(join(web, 'assets', 'index-New111.js'), 'export const build = "new";');
  // The build the launcher kept: <dataDir>/app/<version>/web
  const kept = join(root, 'data', 'app', '0.14.1', 'web', 'assets');
  if (withOverlay) {
    mkdirSync(kept, { recursive: true });
    writeFileSync(join(kept, 'index-Old222.js'), 'export const build = "old";');
    writeFileSync(join(kept, 'Chats-Old333.css'), '.chats{color:red}');
    // Only a regular file inside the folder may be served
    writeFileSync(join(root, 'secret.txt'), 'outside');
    symlinkSync(join(root, 'secret.txt'), join(kept, 'link-Old444.js'));
    // Nor through a folder planted as a link: a "kept build" whose version folder, `web` or
    // `assets` points at some other folder of the person's, where a file is named like an asset
    const elsewhere = join(root, 'elsewhere');
    mkdirSync(join(elsewhere, 'web', 'assets'), { recursive: true });
    writeFileSync(join(elsewhere, 'web', 'assets', 'private-Old666.js'), 'outside');
    symlinkSync(elsewhere, join(root, 'data', 'app', '0.13.9'));
    mkdirSync(join(root, 'data', 'app', '0.13.8'), { recursive: true });
    symlinkSync(join(elsewhere, 'web'), join(root, 'data', 'app', '0.13.8', 'web'));
    mkdirSync(join(root, 'data', 'app', '0.13.7', 'web'), { recursive: true });
    symlinkSync(join(elsewhere, 'web', 'assets'), join(root, 'data', 'app', '0.13.7', 'web', 'assets'));
  }
  mkdirSync(join(root, 'data', 'app', '.staging-0.15.0', 'web', 'assets'), { recursive: true });
  writeFileSync(join(root, 'data', 'app', '.staging-0.15.0', 'web', 'assets', 'half-Old555.js'), 'half-written');
  const core = new Core(
    loadConfig({
      CLAUDE_BIN: '/nonexistent/claude',
      CLAUDE_CONFIG_DIR: join(root, 'claude'),
      CLAUDIO_WORKSPACE_DIR: join(root, 'workspace'),
      CLAUDIO_DATA_DIR: join(root, 'data'),
    }),
  );
  const app = await buildApp(core, { logLevel: 'silent', webDist: web });
  return { app, core, root };
}

test('a file of the running build is served as before', async (t) => {
  const { app, core } = await wrapper();
  t.after(async () => {
    await app.close();
    await core.shutdown();
  });
  const res = await app.inject('/assets/index-New111.js');
  assert.equal(res.statusCode, 200);
  assert.match(res.body, /"new"/);
});

test('an old hashed file is served from the build the launcher kept, with immutable caching', async (t) => {
  const { app, core } = await wrapper();
  t.after(async () => {
    await app.close();
    await core.shutdown();
  });
  const script = await app.inject('/assets/index-Old222.js');
  assert.equal(script.statusCode, 200);
  assert.match(script.body, /"old"/);
  assert.match(String(script.headers['content-type']), /javascript/);
  assert.match(String(script.headers['cache-control']), /immutable/);
  assert.match(String(script.headers['cache-control']), /max-age=31536000/);

  const style = await app.inject('/assets/Chats-Old333.css');
  assert.equal(style.statusCode, 200);
  assert.match(String(style.headers['content-type']), /css/);
});

test('a missing asset is a 404 that is not HTML, whatever the folder', async (t) => {
  const { app, core } = await wrapper(false);
  t.after(async () => {
    await app.close();
    await core.shutdown();
  });
  for (const url of ['/assets/gone-Zz99.js', '/assets/gone-Zz99.css', '/favicon.ico', '/sw-old.js', '/chats/old.js', '/assets/nested/gone.js']) {
    const res = await app.inject(url);
    assert.equal(res.statusCode, 404, url);
    assert.doesNotMatch(String(res.headers['content-type']), /html/, url);
    assert.doesNotMatch(res.body, /<title>/, url);
  }
});

test('nothing outside the kept assets folders is reachable through /assets', async (t) => {
  const { app, core } = await wrapper();
  t.after(async () => {
    await app.close();
    await core.shutdown();
  });
  for (const url of [
    '/assets/link-Old444.js', // a link planted in a kept build
    '/assets/private-Old666.js', // behind a version, web or assets folder planted as a link
    '/assets/..%2Fsecret.txt',
    '/assets/%2e%2e/secret.txt',
    '/assets/../../secret.txt',
    '/assets/..%5Csecret.txt',
    '/assets/half-Old555.js', // a download that is not finished is not a build
    '/assets/index-Old222.js%00.png',
  ]) {
    const res = await app.inject(url);
    // The static plugin itself refuses some spellings with a 403 before this code sees them
    assert.ok(res.statusCode === 404 || res.statusCode === 403, `${url} → ${res.statusCode}`);
    assert.doesNotMatch(res.body, /outside|half-written/, url);
  }
});

test('a navigation still gets the shell, and /api keeps its own 404', async (t) => {
  const { app, core } = await wrapper();
  t.after(async () => {
    await app.close();
    await core.shutdown();
  });
  for (const url of ['/', '/chats', '/chats/6f1c0c46-2f0b-4a64-9f43-3b4a1f0a9f10', '/settings/general']) {
    const res = await app.inject(url);
    assert.equal(res.statusCode, 200, url);
    assert.equal(res.body, SHELL, url);
  }
  const api = await app.inject('/api/never-registered');
  assert.equal(api.statusCode, 404);
  assert.deepEqual(api.json(), { error: 'route not found' });
});

test('what names a file, and which asset name is acceptable', () => {
  assert.equal(namesFile('/assets/index-Aa11.js'), true);
  assert.equal(namesFile('/favicon.ico'), true);
  assert.equal(namesFile('/chats/abc'), false);
  assert.equal(namesFile('/'), false);
  // A dot in a directory is not the file's extension
  assert.equal(namesFile('/v1.2/chats'), false);
  assert.equal(assetName('/assets/index-Aa11.js'), 'index-Aa11.js');
  assert.equal(assetName('/assets/a/b.js'), null);
  assert.equal(assetName('/assets/.hidden.js'), null);
  assert.equal(assetName('/other/index-Aa11.js'), null);
  assert.equal(requestPath('/assets/a.js?x=1'), '/assets/a.js');
  assert.equal(requestPath('/assets/%E0%A4%A'), null);
});
