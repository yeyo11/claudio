// The one wait line (docs/plans/limit-resume-and-credits.md, t9), against the fake CLI: a chat whose
// only account is at its limit opens a wait by itself (rotation on, no account with room), the chat
// shows the wait line with its two ways out, and Home lists the open wait with a link to the chat.
// The account's own reading says it is spent too (`fake-held`), so nothing resumes the wait while the page is read. Stopping the wait takes both away. The spec removes the account and the chat it added.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';

export const fakeCli = true;
export const timeout = 180_000;

export default async ({ page, api, check, dirs, fakeCli: fake }) => {
  const savedScripts = existsSync(fake.scripts) ? readFileSync(fake.scripts, 'utf8') : null;
  const settings = (await api.get('/accounts/settings')).body;
  const added = [];
  // Accounts an earlier spec left on this server: any with room would take the chat instead of letting it wait
  const others = [];
  const chats = [];
  const until = async (condition, label, ms = 20_000) => {
    const end = Date.now() + ms;
    for (;;) {
      const value = await condition();
      if (value) return value;
      if (Date.now() > end) throw new Error(`timed out waiting for: ${label}`);
      await sleep(200);
    }
  };
  const openWaits = async () => (await api.get('/limits/waits?state=waiting')).body ?? [];

  try {
    const limited = await api.post('/accounts/token', { kind: 'token', alias: 'e2e-wait-limited', secret: 'fake-held-wait' });
    check(limited.status === 201, `the account at its limit is added (${limited.status})`);
    added.push(limited.body.id);
    for (const other of (await api.get('/accounts')).body ?? []) {
      if (other.id === limited.body.id || other.enabled === false) continue;
      const off = await api.request('PATCH', `/accounts/${other.id}`, { enabled: false });
      if (off.status === 200) others.push(other.id);
    }
    await api.put('/accounts/settings', { ...settings, rotateOnLimit: true });

    const created = await api.post('/chats', { prompt: 'FAKE-LIMIT-ACCOUNT', account: limited.body.id, cwd: dirs.workspaceDir });
    check(created.status === 201, `the chat starts on the limited account (${created.status})`);
    chats.push(created.body.id);
    const id = created.body.id;
    const wait = await until(async () => (await openWaits()).find((m) => m.fromChat === id), 'the wait to open', 40_000);
    check(wait.state === 'waiting', 'the wait is open');

    // The chat: one line, in words, with the two ways out and nothing moving
    await page.goto(`/chats/${id}`, 1200);
    await page.waitFor(`return !!document.querySelector('main .wait-line.is-banner')`, { label: 'the wait line in the chat' });
    const line = await page.eval(`const el = document.querySelector('main .wait-line.is-banner'); return { text: el.innerText.replace(/\\s+/g, ' '), buttons: [...el.querySelectorAll('button')].map((b) => b.innerText.trim()), moving: !!el.querySelector('.spinner, .shimmer, [class*=live]') }`);
    check(/Waiting for Claude Code/.test(line.text), `the chat says what it waits for (${line.text})`);
    check(line.buttons.includes('Stop waiting') && line.buttons.includes('Run now'), `it offers Stop waiting and Run now (${line.buttons})`);
    check(!line.moving, 'nothing in it moves');
    await page.shot('limit-wait-line-chat');

    // Home: the open wait, with a link to the chat (All projects, whatever an earlier spec selected)
    await page.eval(`localStorage.removeItem('claudio:project'); return true`);
    await page.goto('/', 1200);
    await page.waitFor(`return !!document.querySelector('.wait-list .inbox-row a[href="/chats/${id}"]')`, { label: 'the open wait on Home' });
    const row = await page.eval(`const el = [...document.querySelectorAll('.wait-list .inbox-row')].find((r) => r.querySelector('a')?.getAttribute('href') === ${JSON.stringify(`/chats/${id}`)}); return { text: el.innerText.replace(/\\s+/g, ' '), href: el.querySelector('a')?.getAttribute('href') }`);
    check(/Waiting for Claude Code/.test(row.text) && /since/.test(row.text), `Home says what waits and since when (${row.text})`);
    // One wait, one story: the chat and Home give the same hour (or both say it is not known)
    const when = (text) => /resumes at ([\d/: ]+\d)/.exec(text)?.[1]?.trim() ?? 'not known';
    check(when(line.text) === when(row.text), `the chat and Home say the same of the wait (${when(line.text)} / ${when(row.text)})`);
    check(row.href === `/chats/${id}`, `and links to the chat (${row.href})`);
    await page.shot('limit-wait-line-home');

    // Both themes, and a phone: nothing scrolls sideways, and on a phone the actions are touch targets
    for (const [theme, width, name] of [['light', 1280, 'light'], ['dark', 390, 'phone'], ['light', 390, 'phone-light']]) {
      await page.eval(`localStorage.setItem('claudio-theme', ${JSON.stringify(theme)}); return true`);
      await page.viewport(width, 900);
      for (const [path, sel] of [[`/chats/${id}`, 'main .wait-line.is-banner'], ['/', `.wait-list .inbox-row a[href="/chats/${id}"]`]]) {
        await page.goto(path, 1200);
        await page.waitFor(`return !!document.querySelector(${JSON.stringify(sel)})`, { label: `${sel} at ${width} ${theme}` });
        const over = await page.eval('return document.documentElement.scrollWidth - window.innerWidth');
        check(over <= 1, `[${theme} ${width} ${path}] the page does not scroll sideways (${over}px)`);
        if (width < 768 && path !== '/') {
          const heights = await page.eval(`return [...document.querySelectorAll('.wait-line button')].map((b) => Math.round(b.getBoundingClientRect().height))`);
          check(heights.length === 2 && heights.every((h) => h >= 44), `[${theme}] the wait line's actions are touch targets (${heights})`);
        }
        if (width < 768 && path === '/') {
          const open = await page.eval(`return Math.round(document.querySelector('.wait-list .inbox-row a[href="/chats/${id}"]').getBoundingClientRect().height)`);
          check(open >= 44, `[${theme}] Home's Open is a touch target (${open})`);
        }
        await page.shot(`limit-wait-line-${name}-${path === '/' ? 'home' : 'chat'}`);
      }
    }
    await page.eval(`localStorage.setItem('claudio-theme', 'dark'); return true`);
    await page.viewport(1280, 800);

    // Stopping the wait takes the line and the row away
    const stopped = await api.post(`/limits/waits/${wait.id}/cancel`);
    check(stopped.status === 200, `the wait is stopped (${stopped.status})`);
    await page.goto('/', 1200);
    await until(async () => (await page.eval(`return document.querySelectorAll('.wait-list .inbox-row a[href="/chats/${id}"]').length`)) === 0, 'the row to leave Home');
    check(true, 'Home lists no wait once it is stopped');
  } finally {
    for (const id of chats) {
      await api.post(`/chats/${id}/stop`).catch(() => {});
      for (let i = 0; i < 40; i++) {
        if ((await api.del(`/chats/${id}`).catch(() => ({ status: 0 }))).status === 200) break;
        await sleep(250);
      }
    }
    for (const id of added) await api.del(`/accounts/${id}`).catch(() => {});
    for (const id of others) await api.request('PATCH', `/accounts/${id}`, { enabled: true }).catch(() => {});
    await api.put('/accounts/settings', settings).catch(() => {});
    writeFileSync(fake.scripts, savedScripts ?? '{}');
  }
};
