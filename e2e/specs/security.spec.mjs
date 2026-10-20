// Settings → Access & safety: the token is shown once, read-only refuses writes, the access mode guards the API
// and a 401 is a sign-in screen. The suite shares one wrapper, so whatever this turns on it turns
// back off, even when an assertion fails half way. The audit log's filters live on its detail,
// /settings/access/audit; the group's screen shows its latest rows only.
import { request as httpRequest } from 'node:http';

const TOKEN_KEY = 'claudio.token';

export default async ({ page, api, check }) => {
  const authed = (token) => async (method, path, body) => {
    const res = await fetch(`${api.baseUrl}/api${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: await res.json().catch(() => null) };
  };
  const panelText = () => page.text('[role=tabpanel]');
  const buttonDisabled = (label) =>
    // A section's save holds its "Saving…" too, hidden: the label is its idle word
    page.eval(`const b=[...document.querySelectorAll('[role=tabpanel] button')].find(b=>(b.querySelector('.btn-state-idle')??b).textContent.trim()===${JSON.stringify(label)});return b?b.disabled:null`);

  await page.goto('/settings', 800);
  await page.eval(`localStorage.removeItem(${JSON.stringify(TOKEN_KEY)}); return true`);
  // The audit log loads on its own and the other cards wait for /security/auth, so both are waited
  // for: a fixed pause read a blank or half-drawn screen on a loaded machine
  const securityTab = `const t=document.querySelector('[role=tabpanel]')?.innerText??'';return t.includes('Audit log')&&t.includes('Read-only mode')`;
  await page.goto('/settings/access', 0);
  await page.waitFor(securityTab, { label: 'Access & safety', timeout: 60_000 });
  const initial = await panelText();
  for (const heading of ['Read-only mode', 'Authentication mode', 'Token', 'Audit log']) check(initial.toLowerCase().includes(heading.toLowerCase()), `Access & safety has a "${heading}" part`);
  check(initial.toLowerCase().includes('open'), 'the unguarded mode is said in words, not only shown');
  check(initial.includes('CLAUDIO_AUTH_TOKEN_RESET'), 'the token card names the recovery path for a lost token');

  // A mode that would lock everyone out is named before the click, not after it
  await page.click('[data-setting="access.mode"] [role=radio]', 'Token');
  check((await panelText()).includes('Set a token below before turning token authentication on'), 'token mode explains it needs a token first');
  check((await buttonDisabled('Save access')) === true, 'token mode cannot be saved without a token');

  // The token is generated, shown once, and never comes back from the API
  await page.click('button', 'Generate token', 800);
  await page.waitFor(`return !!document.querySelector('[data-testid=new-token]')`, { label: 'the generated token' });
  const token = await page.eval(`return document.querySelector('[data-testid=new-token]').textContent.trim()`);
  check(token.length >= 32, 'a generated token is long enough to be a secret');
  check((await panelText()).includes('Copy this token now'), 'the panel says the token is shown only once');
  const config = await api.get('/security/auth');
  check(config.body.tokenSet === true, 'the API reports that a token is set');
  check(!JSON.stringify(config.body).includes(token), 'the configuration never carries the token');
  await page.click('button', 'I have copied it', 500);
  check(!(await page.eval(`return !!document.querySelector('[data-testid=new-token]')`)), 'the token is gone once it is acknowledged');
  await page.goto('/settings/access', 0);
  await page.waitFor(securityTab, { label: 'Access & safety after a reload', timeout: 60_000 });
  check(!(await page.text('body')).includes(token), 'after a reload the token is nowhere on the page');

  // Read-only: the switch flips it, a write is refused with 405, the switch flips it back
  await page.click('[data-setting="access.read-only"] [role=switch]', undefined, 900);
  try {
    check((await api.get('/security/auth')).body.readOnly === true, 'the switch turned read-only on');
    check((await panelText()).toLowerCase().includes('read-only'), 'read-only is said in words');
    const refused = await api.post('/projects', { name: 'e2e-read-only' });
    check(refused.status === 405, `a write is refused in read-only mode (got ${refused.status})`);
    await page.click('[data-setting="access.read-only"] [role=switch]', undefined, 900);
    check((await api.get('/security/auth')).body.readOnly === false, 'the same switch turned it off again');
  } finally {
    // The switch itself is exempt from read-only, so this always gets through
    await api.put('/security/auth', { readOnly: false });
  }
  const allowed = await api.post('/projects', { name: 'e2e-read-only' });
  check(allowed.status < 300, `writes work again once it is off (got ${allowed.status})`);
  if (allowed.body?.id) await api.del(`/projects/${encodeURIComponent(allowed.body.id)}`);

  try {
    // Token mode: asks before it locks the door, and this browser keeps working because it holds the token
    await page.goto('/settings/access', 0);
    await page.waitFor(securityTab, { label: 'Access & safety before token mode', timeout: 60_000 });
    await page.click('[data-setting="access.mode"] [role=radio]', 'Token');
    await page.click('button', 'Save access', 600);
    await page.waitFor(`return !!document.querySelector('[role=dialog],[role=alertdialog]')`, { label: 'the lock-out confirmation' });
    await page.click('[role=dialog] button, [role=alertdialog] button', 'Turn it on', 1500);
    check((await api.get('/overview')).status === 401, 'a request without the credential is refused');
    check((await authed(token)('GET', '/overview')).status === 200, 'the token is accepted');
    // Everything the tab did so far ran while the wrapper was open, so the log has no row made by a
    // credential yet: this is the write whose actor is the token
    check((await authed(token)('PUT', '/security/auth', { readOnly: false })).status === 200, 'a write goes through with the token');
    await page.goto('/settings/access', 0);
    await page.waitFor(`return document.querySelector('[role=tabpanel]')?.innerText.includes('Audit log')`, { label: 'this browser is still signed in after turning the guard on' });

    // The group's screen shows the latest rows and a row to the whole log, which owns the filters
    await page.click('[role=tabpanel] .settings-detail-row', 'See the whole log', 800);
    await page.waitFor(`return location.pathname === '/settings/access/audit' && !!document.querySelector('[role=tabpanel] .filter-bar')`, { label: 'the audit log detail' });

    // The audit log lists the writes, filterable by path, and records who made them. Its table is
    // named: the screen may have others once a spec has run a terminal (Terminal history). The
    // settings search in the nav is a search field too, so the log's is reached inside the panel
    const auditTable = `[role=tabpanel] .table-wrap[aria-label="Audit log"] table`;
    const pathFilter = '[role=tabpanel] .filter-bar input[type=search]';
    await page.fill(pathFilter, '/security');
    await page.waitFor(`const t=document.querySelector('${auditTable}');return !!t&&t.textContent.includes('/api/security/auth')&&t.textContent.includes('token:')`, { label: 'the audit rows for /security' });
    // Badges are uppercase by CSS: the words are read from the DOM
    const rows = await page.eval(`return document.querySelector('${auditTable}')?.textContent ?? ''`);
    check(rows.includes('PUT') && rows.includes('token:'), 'the audit log names the method and the token that made the write');
    check(/done/.test(rows), 'a result is said in words as well as a status code');

    // Method and status narrow the same list; every row left is what was asked for
    const auditRows = `[...document.querySelectorAll('${auditTable} tbody tr')]`;
    await page.select('[role=tabpanel] .filter-bar .select-trigger', 'PUT');
    await page.waitFor(`const r=${auditRows};return r.length>0&&r.every(tr=>tr.querySelector('.audit-method')?.textContent==='PUT')`, { label: 'only PUT rows' });
    await page.fill(pathFilter, '');
    await page.select('[role=tabpanel] .filter-bar .select-trigger', 'POST');
    await page.fill('[role=tabpanel] input[role=combobox]', '4xx');
    // The write refused while read-only was on is a POST that ended in a 405
    await page.waitFor(
      `const r=${auditRows};return r.length>0&&r.every(tr=>tr.querySelector('.audit-method')?.textContent==='POST'&&/^4\\d\\d/.test(tr.querySelector('.badge')?.textContent??''))&&r.some(tr=>tr.textContent.includes('/api/projects'))`,
      { label: 'only POST rows that ended in a 4xx' },
    );
    await page.fill('[role=tabpanel] input[role=combobox]', '405');
    await page.waitFor(`const r=${auditRows};return r.length>0&&r.every(tr=>/^405/.test(tr.querySelector('.badge')?.textContent??''))`, { label: 'only 405 rows' });
    // A status the server would refuse is named in the form and never sent
    await page.fill('[role=tabpanel] input[role=combobox]', '4x');
    await page.waitFor(`return document.querySelector('[role=tabpanel]').textContent.includes('a code such as 404 or a class such as 4xx')`, { label: 'the invalid status message' });
    check(!(await page.eval(`return !!document.querySelector('[role=tabpanel] .alert-bad')`)), 'an invalid status does not reach the server as a failed request');
    await page.click('[role=tabpanel] button', 'Clear filters', 600);
    check((await page.eval(`return document.querySelector('[role=tabpanel] input[role=combobox]').value`)) === '', 'clearing the filters empties the status too');

    await page.fill(pathFilter, 'zz-no-such-path');
    await page.waitFor(`return document.querySelector('[role=tabpanel]').textContent.includes('No entry matches these filters')`, { label: 'an empty filter result' });

    // In Spanish, what each row did is its route's own line and who made it is a word; on a phone the
    // same rows wrap instead of scrolling sideways (docs/plans/settings-reset-and-polish.md, D5)
    await page.click('[role=tabpanel] button', 'Clear filters', 600);
    try {
      await page.eval(`localStorage.setItem('claudio-language', 'es'); return true`);
      // The table's accessible name is translated too, so the Spanish page is found by its class
      const auditTableEs = `[role=tabpanel] .audit-log > .table-wrap table.audit-table`;
      await page.goto('/settings/access/audit', 0);
      await page.waitFor(
        `const t=document.querySelector('${auditTableEs}');return !!t&&t.textContent.includes('Cambiar el modo de autenticación o el modo de solo lectura')`,
        { label: 'the audit log in Spanish', timeout: 60_000 },
      );
      const spanish = await page.eval(`return document.querySelector('${auditTableEs}').textContent`);
      check(!spanish.includes('Change the auth mode or read-only'), 'a row with a route is not left in English');
      check(spanish.includes('Acceso local'), 'the open install writes as a word, in Spanish');

      await page.viewport(390, 844);
      await page.waitFor(`const r=document.querySelector('[role=tabpanel] .audit-rows');return !!r&&r.offsetParent!==null&&document.querySelectorAll('[role=tabpanel] .audit-row').length>0`, { label: 'the audit rows at 390' });
      check(!(await page.eval(`return document.querySelector('[role=tabpanel] .audit-log > .table-wrap').offsetParent !== null`)), 'at 390 the table is not displayed, so only the rows are read');
      const sideways = await page.eval(
        `const el=document.scrollingElement;const rows=[...document.querySelectorAll('[role=tabpanel] .audit-row')];return el.scrollWidth>el.clientWidth+1||rows.some(r=>r.scrollWidth>r.clientWidth+1)`,
      );
      check(!sideways, 'the audit rows at 390 never scroll sideways');
      check((await page.text('[role=tabpanel] .audit-rows')).includes('Cambiar el modo de autenticación'), 'the rows say what each write did, in Spanish');
      const fold = '[role=tabpanel] .audit-row-path';
      if (await page.eval(`return !!document.querySelector('${fold}')`)) {
        await page.click(fold, undefined, 300);
        check((await page.eval(`return document.querySelector('${fold}').getAttribute('aria-expanded')`)) === 'true', 'a tap on a folded path shows all of it');
      }
    } finally {
      await page.viewport(1440, 900).catch(() => {});
      await page.eval(`localStorage.removeItem('claudio-language'); return true`).catch(() => {});
    }

    // A 401 is a screen that says what to do; a wrong token fails in the form, the right one returns the app
    await page.eval(`localStorage.removeItem(${JSON.stringify(TOKEN_KEY)}); return true`);
    await page.goto('/', 1500);
    await page.waitFor(`return !!document.querySelector('.signin')`, { label: 'the sign-in screen' });
    check((await page.text('.signin')).includes('This wrapper asks for a credential'), 'a 401 shows the sign-in screen, not a blank page');
    await page.fill('.signin input[type=password]', 'not-the-token-not-the-token');
    await page.click('.signin button[type=submit]', undefined, 1200);
    check((await page.text('.signin')).includes('That credential was not accepted'), 'a wrong token is refused in the form');
    await page.fill('.signin input[type=password]', token);
    await page.click('.signin button[type=submit]', undefined, 1500);
    await page.waitFor(`return !document.querySelector('.signin')`, { label: 'the app after signing in' });

    // ---- A name the wrapper does not answer to: a 421 that says what to do, and the owner's token adds it ----
    // The browser cannot dial another name here, so the request is made by hand with the Host it would send
    const port = new URL(api.baseUrl).port;
    const host = 'claudio-lan.test';
    const dialled = (method, path, headers = {}) =>
      new Promise((resolve, reject) => {
        const req = httpRequest({ host: '127.0.0.1', port, method, path, headers: { host: `${host}:${port}`, ...headers } }, (res) => {
          let text = '';
          res.on('data', (chunk) => (text += chunk));
          res.on('end', () => resolve({ status: res.statusCode, type: String(res.headers['content-type'] ?? ''), text }));
        });
        req.on('error', reject);
        req.end();
      });
    const refused = await dialled('GET', '/api/security/auth', { accept: 'application/json' });
    const body = JSON.parse(refused.text);
    check(refused.status === 421 && body.code === 'host-not-allowed' && body.host === host && body.canClaim === true, `an unlisted host is refused with the screen's data: ${refused.text}`);
    const page421 = await dialled('GET', '/api/security/auth', { accept: 'text/html' });
    check(page421.status === 421 && page421.type.includes('text/html') && page421.text.includes(host), 'a person typing the address gets a page, not JSON');
    const wrong = await dialled('POST', '/api/security/allowed-hosts/claim', { authorization: 'Bearer not-the-token-not-the-token' });
    check(wrong.status === 401, `a wrong token does not claim the host (${wrong.status})`);
    const claimed = await dialled('POST', '/api/security/allowed-hosts/claim', { authorization: `Bearer ${token}` });
    check(claimed.status === 200 && JSON.parse(claimed.text).allowedHosts.includes(host), `the owner's token adds the host: ${claimed.text}`);
    const answered = await dialled('GET', '/api/security/auth', { authorization: `Bearer ${token}` });
    check(answered.status === 200, `the wrapper answers to the host once it is claimed (${answered.status})`);
    // The allowlist is left as it was found, for the specs after this one
    const reset = await authed(token)('PUT', '/settings/app', { allowedHosts: [] });
    check(reset.status === 200, `the claimed host was taken off the list again (${reset.status})`);
  } finally {
    // The rest of the suite runs against this wrapper with no credential
    const guarded = authed(token);
    await guarded('PUT', '/security/auth', { mode: 'none', readOnly: false });
    await guarded('DELETE', '/security/token');
    await page.eval(`localStorage.removeItem(${JSON.stringify(TOKEN_KEY)}); return true`).catch(() => {});
  }
  const restored = await api.get('/security/auth');
  check(restored.status === 200 && restored.body.mode === 'none' && !restored.body.tokenSet, 'the wrapper is left open and without a token');
};
