// Guards end to end (docs/plans/guards.md, "e2e"), against the fake CLI: the fake reads `--settings`,
// runs the PreToolUse command for each `run:` step and turns exit 2 into the CLI's error tool_result
// (e2e/fake-cli/README.md), so the real bundled guard.mjs decides here. Seven scenarios: a guarded chat
// that is blocked, one that passes, an orchestration task blocked by `no-verify`, Settings → Guards,
// a chat token refused on PUT /settings/guards, the guard made unavailable, and the phone.
//
// guard.spec.mjs is the unsaved-changes guard; this file is about the guards of agents.
import { chmodSync, statSync } from 'node:fs';

export const fakeCli = true;
export const timeout = 300_000;


export default async ({ page, api, check, dirs }) => {
  /** The bundle run.mjs arms the server's guards with; scenario 6 makes it untrustworthy for a while */
  const GUARD_BUNDLE = dirs.guardEntry;
  const settled = (state) => state !== 'running' && state !== 'starting';
  const untilChat = async (id, label) => {
    for (let i = 0; i < 120; i++) {
      const { body } = await api.get(`/chats/${id}`);
      const calls = (body?.entries ?? []).flatMap((e) => e.blocks ?? []).filter((b) => b.type === 'tool_result' || b.type === 'tool_use');
      if (calls.some((b) => b.type === 'tool_result') && body?.chat?.state !== 'starting') return body;
      await page.sleep(500);
    }
    check(false, `${label}: the chat answered its call`);
    return null;
  };
  const saved = (await api.get('/settings/guards')).body.settings;
  const original = { mode: saved.mode, automated: saved.automated, rules: saved.rules };
  const chats = [];
  const startChat = async (prompt, cwd) => {
    const res = await api.post('/chats', { prompt, cwd });
    check(res.status === 201, `the chat "${prompt}" started (${res.status} ${JSON.stringify(res.body).slice(0, 160)})`);
    chats.push(res.body.id);
    return res.body.id;
  };
  const theme = (name) => page.eval(`localStorage.setItem('claudio-theme', '${name}'); return true`);
  let bundleMode = null;
  let projectId = null;

  try {
    // Guards on for automated runs and every rule of a fresh install, so the scenarios do not depend on what an earlier spec left
    const base = await api.put('/settings/guards', { mode: 'enforce', automated: true, rules: { 'no-verify': true, push: true, destructive: true, secrets: true, 'protect-configs': false } });
    check(base.status === 200, `the guard settings were set (${base.status})`);
    await page.viewport(1440, 900);
    // localStorage belongs to the app's origin: a spec that runs first starts on about:blank, which has none
    await page.goto('/', 800);
    await theme('dark');

    // ===== a project that opted in to guards in its chats =====
    const project = (await api.post('/projects', { name: 'e2e-guard-hooks' })).body;
    projectId = project.id;
    const settings = (await api.get(`/projects/${projectId}/settings`)).body;
    const optIn = await api.put(`/projects/${projectId}/settings`, { ...settings, guards: { chats: true } });
    check(optIn.status === 200, `the project opted in to guards (${optIn.status})`);

    // ===== 1. a guarded chat runs `git push`: the strip, the header tag and Settings' recent blocks =====
    const blockedChat = await startChat('run: git push origin main', project.path);
    await untilChat(blockedChat, 'scenario 1');
    await page.goto(`/chats/${blockedChat}`, 1500);
    await page.waitFor(`return !!document.querySelector('.transcript .notice.is-guard')`, { label: 'the guard strip', timeout: 30_000 });
    const strip = await page.eval(`const n = document.querySelector('.transcript .notice.is-guard'); return { label: n.querySelector('.notice-label')?.textContent.trim() ?? '', rule: n.querySelector('.notice-rule')?.textContent.trim() ?? '', failedRow: !!document.querySelector('.transcript .call-row.is-error') }`);
    check(strip.label === 'Guard blocked' && strip.rule === 'push', `the transcript shows the "Guard blocked" strip for push (${JSON.stringify(strip)})`);
    check(!strip.failedRow, 'a blocked call is the strip, not a failed call row');
    await page.waitFor(`return [...document.querySelectorAll('.chat-head .guard-tag')].some((t) => t.textContent.trim() === 'Guards')`, { label: 'the Guards tag in the header', timeout: 30_000 });
    check(true, 'the header shows the Guards tag');
    await page.goto('/settings?tab=security', 1500);
    await page.waitFor(`return [...document.querySelectorAll('#guards .guard-event')].some((e) => e.textContent.includes('push'))`, { label: 'the block in Recent blocks', timeout: 30_000 });
    const recent = await page.eval(`const e = [...document.querySelectorAll('#guards .guard-event')].find((x) => x.textContent.includes('push')); return e.querySelector('a')?.getAttribute('href') ?? ''`);
    check(recent === `/chats/${blockedChat}`, `Recent blocks links to the chat (${recent})`);

    // ===== 2. the same chat runs `ls`: no strip =====
    const passChat = await startChat('run: ls', project.path);
    await untilChat(passChat, 'scenario 2');
    await page.goto(`/chats/${passChat}`, 1500);
    await page.waitFor(`return !!document.querySelector('.transcript .call-row')`, { label: 'the ls call row', timeout: 30_000 });
    check(!(await page.eval(`return !!document.querySelector('.transcript .notice.is-guard')`)), 'a passing command draws no guard strip');

    // ===== 3. an orchestration task blocked by no-verify: "1 blocked" on its card, which opens the chat at the notice =====
    const created = await api.post('/orchestrations', {
      name: 'e2e-guard-hooks',
      objective: 'a task the guard blocks',
      cwd: dirs.workspaceDir,
      maxAttempts: 1,
      tasks: [{ id: 'commit', name: 'Commit', prompt: 'Commit the work\nrun: git commit --no-verify -m x' }],
    });
    check(created.status === 201, `the orchestration was created (${created.status} ${JSON.stringify(created.body).slice(0, 160)})`);
    const orchestrationId = created.body.id;
    let state = null;
    for (let i = 0; i < 120; i++) {
      state = (await api.get(`/orchestrations/${orchestrationId}`)).body;
      for (const task of state?.tasks ?? []) if (task.sessionId && !chats.includes(task.sessionId)) chats.push(task.sessionId);
      if (state && state.status !== 'running' && state.status !== 'pending') break;
      await page.sleep(500);
    }
    await page.goto(`/orchestration/${orchestrationId}`, 1500);
    await page.waitFor(`return [...document.querySelectorAll('.chip.guard')].some((c) => c.textContent.includes('1 blocked'))`, { label: 'the "1 blocked" chip on the task card', timeout: 30_000 });
    await page.click('a.chip.guard', '1 blocked', 1500);
    await page.waitFor(`return location.pathname.startsWith('/chats/') && location.search.includes('guard=1')`, { label: 'the chat opened from the chip' });
    await page.waitFor(`return !!document.querySelector('.transcript .notice.is-guard')`, { label: 'the notice at the end of the chip', timeout: 30_000 });
    check(true, 'the chip opens the chat at the guard notice');

    // ===== 4. Settings → Guards: a rule toggled survives a reload; "Try a command" names the rule =====
    await page.goto('/settings?tab=security', 1500);
    const rule = (id) => page.eval(`return document.querySelector('#guards [data-rule="${id}"] [role=switch]')?.getAttribute('aria-checked') ?? null`);
    await page.waitFor(`return !!document.querySelector('#guards [data-rule="secrets"] [role=switch]')`, { label: 'the secrets switch' });
    const before = await rule('secrets');
    await page.click('#guards [data-rule="secrets"] [role=switch]', undefined, 1200);
    check((await rule('secrets')) !== before, 'the secrets switch flipped');
    await page.goto('/settings?tab=security', 1500);
    await page.waitFor(`return !!document.querySelector('#guards [data-rule="secrets"] [role=switch]')`, { label: 'the secrets switch after a reload' });
    check((await rule('secrets')) !== before, 'the switch kept its state after a reload');
    check((await api.get('/settings/guards')).body.settings.rules.secrets === (before !== 'true'), 'the server holds the new state');
    await page.fill('#guards .guard-try-row input', 'git commit -n -m x');
    await page.click('#guards .guard-try .btn-primary', undefined, 800);
    await page.waitFor(`const r = document.querySelector('[data-testid=guard-result]')?.textContent ?? ''; return r.includes('Would be blocked') && r.includes('no-verify')`, { label: 'the "Try a command" verdict' });
    check(true, '"Try a command" reads blocked by no-verify');

    // ===== 5. a chat's token may not change the guards (an API call from the spec) =====
    // The chat makes the call itself with the CLAUDIO_API_TOKEN the wrapper minted for its process; it is
    // outside the opted-in project, so its own Bash call is not the guard's to judge
    const caller = await startChat(
      `run: curl -s -o /dev/null -w "%{http_code}" -X PUT -H "Authorization: Bearer $CLAUDIO_API_TOKEN" -H "content-type: application/json" -d '{"automated":false}' "$CLAUDIO_API_URL/settings/guards"`,
      dirs.workspaceDir,
    );
    const answered = await untilChat(caller, 'scenario 5');
    const results = (answered?.entries ?? []).flatMap((e) => e.blocks ?? []).filter((b) => b.type === 'tool_result');
    const code = JSON.stringify(results.map((r) => r.content ?? r.text ?? ''));
    check(code.includes('403'), `a chat token gets 403 on PUT /settings/guards (${code.slice(0, 200)})`);
    check((await api.get('/settings/guards')).body.settings.automated === true, 'guards for automated runs are still on');

    // ===== 6. the guard made unavailable: a launched task fails, Settings shows bad =====
    // run.mjs cannot restart the server with another CLAUDIO_GUARD_ENTRY for one spec, so the bundle the
    // server uses is made writable by everyone for a while, which preflight refuses as well as a missing file
    {
      bundleMode = statSync(GUARD_BUNDLE).mode & 0o777;
      chmodSync(GUARD_BUNDLE, 0o666);
      await page.goto('/settings?tab=security', 1500);
      await page.waitFor(`return !!document.querySelector('#guards .guard-status.is-bad')`, { label: 'the bad status', timeout: 30_000 });
      const unavailable = await api.post('/chats', { prompt: 'run: ls', cwd: project.path });
      if (unavailable.status === 201) chats.push(unavailable.body.id);
      const failed = unavailable.status !== 201 ? JSON.stringify(unavailable.body) : JSON.stringify((await api.get(`/chats/${unavailable.body.id}`)).body?.chat ?? {});
      check(/guard/i.test(failed), `a launch with guards unavailable says so (${failed.slice(0, 200)})`);
      chmodSync(GUARD_BUNDLE, bundleMode);
      bundleMode = null;
    }

    // ===== 7. the phone: the card and the rules Sheet, 44 px targets, both themes =====
    await page.viewport(390, 844);
    for (const name of ['dark', 'light']) {
      await theme(name);
      await page.goto('/settings?tab=security', 1500);
      await page.waitFor(`return !!document.querySelector('#guards [data-rule]')`, { label: `[${name}] the card` });
      const card = await page.eval(`
        const small = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && Math.min(r.width, r.height) < 44 && r.height < 44; };
        const targets = [...document.querySelectorAll('#guards button, #guards [role=switch], #guards a')].filter((el) => el.getBoundingClientRect().width > 0);
        return {
          small: targets.filter(small).map((el) => el.textContent.trim().slice(0, 20) || el.getAttribute('aria-label') || el.tagName),
          fields: [...document.querySelectorAll('#guards input, #guards textarea')].filter((el) => parseFloat(getComputedStyle(el).fontSize) < 16).length,
          overflow: document.documentElement.scrollWidth > window.innerWidth,
        };`);
      check(card.small.length === 0 && card.fields === 0 && !card.overflow, `[${name}] the card has 44 px targets, 16 px fields and no sideways scroll (${JSON.stringify(card)})`);
    }
    await page.goto('/orchestration', 1500);
    const hasRow = await page
      .waitFor(`return [...document.querySelectorAll('.guard-row .btn')].some((b) => b.textContent.trim() === 'Rules')`, { label: 'the Rules button of the launch form', timeout: 10_000 })
      .then(() => true, () => false);
    if (hasRow) {
      await page.click('.guard-row .btn', 'Rules', 700);
      await page.waitFor(`return !!document.querySelector('[role=dialog] .guard-rule.is-locked')`, { label: 'the rules Sheet' });
      const sheet = await page.eval(`const d = document.querySelector('[role=dialog]'); const sw = [...d.querySelectorAll('[role=switch]')]; return { locked: d.querySelector('.guard-rule.is-locked')?.textContent.includes('Always on') ?? false, switches: sw.length, small: sw.filter((s) => s.getBoundingClientRect().height < 44 && s.parentElement.getBoundingClientRect().height < 44).length }`);
      check(sheet.locked && sheet.switches >= 5 && sheet.small === 0, `the rules Sheet lists integrity as always on and the switches (${JSON.stringify(sheet)})`);
      await page.key('Escape');
    } else check(false, 'the launch form has no Guards row');
  } finally {
    if (bundleMode !== null) chmodSync(GUARD_BUNDLE, bundleMode);
    await page.viewport(1440, 900).catch(() => {});
    await theme('dark').catch(() => {});
    await api.put('/settings/guards', original).catch(() => {});
    for (const id of chats) await api.post(`/chats/${id}/stop`).catch(() => {});
    if (projectId) await api.del(`/projects/${projectId}`).catch(() => {});
  }
};
