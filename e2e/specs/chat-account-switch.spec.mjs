// Switching a chat's account on demand (docs/plans/chat-account-switch.md), against the fake CLI: the
// Account section of the composer's "+" menu, a switch while the chat is idle (the next message runs
// on the other account, read from the execution through the API), a switch while it works (queued,
// applied when the turn ends), and an exhausted account shown disabled with its reason.
//
// A chat started on the account at its limit (`FAKE-LIMIT-ACCOUNT`) leaves it for another one and
// leaves it exhausted, which is how the spec gets an exhausted row. `SW-WORK` holds a turn open until
// its file exists. The spec removes the accounts it added and puts the settings and scripts back.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const fakeCli = true;
export const timeout = 180_000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export default async ({ page, api, check, dirs, fakeCli: fake }) => {
  const savedScripts = existsSync(fake.scripts) ? readFileSync(fake.scripts, 'utf8') : null;
  writeFileSync(fake.scripts, JSON.stringify({ 'SW-WORK': 'run: true\nhold: sw-work.hold\nsay: Done.' }));
  const settings = (await api.get('/accounts/settings')).body;
  const added = [];
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
  const detail = async (id) => (await api.get(`/chats/${id}`)).body?.chat;
  const lastAccount = async (id) => ((await detail(id))?.executions ?? []).at(-1)?.account ?? null;
  const openMenu = async (id) => {
    await page.goto(`/chats/${id}`, 1200);
    await page.waitFor(`return !!document.querySelector('main .composer-plus')`, { label: 'the "+" button' });
    await page.click('main .composer-plus');
    await page.waitFor(`return document.querySelectorAll('.composer-account').length >= 3`, { label: 'the accounts in the menu' });
  };
  const rows = () =>
    page.eval(`return [...document.querySelectorAll('.composer-account')].map((r) => ({ text: r.innerText.replace(/\\s+/g, ' ').trim(), off: r.classList.contains('is-off'), current: r.classList.contains('is-current') }))`);
  const clickAt = (index) => page.eval(`document.querySelectorAll('.composer-account-btn')[${index}]?.click(); return true`);
  const clickRow = (name) =>
    page.eval(`const b = [...document.querySelectorAll('.composer-account-btn')].find((x) => x.innerText.includes(${JSON.stringify(name)})); b?.click(); return !!b`);

  try {
    const limited = await api.post('/accounts/token', { kind: 'token', alias: 'e2e-sw-limited', secret: 'fake-limited-sw' });
    added.push(limited.body.id);
    const room = await api.post('/accounts/token', { kind: 'token', alias: 'e2e-sw-room', secret: 'fake-room-sw' });
    added.push(room.body.id);
    check(limited.status === 201 && room.status === 201, 'two token accounts are added');
    await api.put('/accounts/settings', { ...settings, rotateOnLimit: true });

    // A chat that leaves the limited account: it ends on another one, and the limited one is out
    const first = await api.post('/chats', { prompt: 'FAKE-LIMIT-ACCOUNT', account: limited.body.id, cwd: dirs.workspaceDir });
    check(first.status === 201, `the chat starts on the limited account (${first.status})`);
    chats.push(first.body.id);
    await until(async () => {
      const chat = await detail(first.body.id);
      return chat?.state === 'idle' && chat.account && chat.account !== limited.body.id;
    }, 'the chat to leave the limited account');
    const start = (await detail(first.body.id)).account;
    await openMenu(first.body.id);
    const listed = await rows();
    check(listed.length >= 3, `the menu lists the accounts (${listed.length})`);
    const out = listed.find((r) => r.text.includes('e2e-sw-limited'));
    check(out?.off === true && /exhausted/i.test(out.text), `the exhausted account is disabled, with its reason (${out?.text})`);
    check(listed.filter((r) => r.current).length === 1 && /in use/i.test(listed.find((r) => r.current)?.text ?? ''), 'the chat\'s own account is marked "In use"');
    await page.shot('chat-account-switch-menu');
    await clickRow('e2e-sw-limited');
    await sleep(500);
    check((await detail(first.body.id)).account === start, 'choosing the exhausted account changes nothing');

    // Idle: it moves at once, and the next message runs on it
    const pick = listed.findIndex((r) => !r.off && !r.current);
    check(pick >= 0, 'an account can be chosen');
    await clickAt(pick);
    await until(async () => {
      const chat = await detail(first.body.id);
      return chat?.account && chat.account !== start && chat.account !== limited.body.id;
    }, 'the chat to move to the chosen account');
    const moved = (await detail(first.body.id)).account;
    const sent = await api.post(`/chats/${first.body.id}/messages`, { text: 'after the switch' });
    check(sent.status < 300, `the next message is sent (${sent.status})`);
    await until(async () => (await lastAccount(first.body.id)) === moved, 'the next execution to run on the chosen account');
    check(true, 'the next message ran on the chosen account');

    // Working: queued, applied when the turn ends
    const work = await api.post('/chats', { prompt: 'SW-WORK', cwd: dirs.workspaceDir, account: moved });
    check(work.status === 201, `a chat that works starts (${work.status})`);
    chats.push(work.body.id);
    await until(async () => (await detail(work.body.id))?.state === 'working', 'the chat to be working');
    await openMenu(work.body.id);
    const now = await rows();
    const next = now.findIndex((r) => !r.off && !r.current);
    check(next >= 0, 'another account can be chosen while the chat works');
    await clickAt(next);
    const pending = await until(async () => (await detail(work.body.id))?.pendingAccount, 'the switch to be pending');
    check((await detail(work.body.id)).account === moved, 'a working chat keeps its account until the turn ends');
    await page.waitFor(`return !!document.querySelector('.composer-account-pending')`, { label: 'the pending note' });
    check(true, 'the menu says the switch waits for the turn to end');
    writeFileSync(join(dirs.workspaceDir, 'sw-work.hold'), '');
    await until(async () => {
      const chat = await detail(work.body.id);
      return chat?.state === 'idle' && chat.account === pending && !chat.pendingAccount;
    }, 'the switch to apply after the turn');
    check(true, 'the switch was applied after the turn');

    const events = await api.get('/accounts/events');
    check(events.status === 200 && events.body.some((e) => e.event === 'switch' && e.reason === 'person'), 'the switch is recorded as the person\'s');
  } finally {
    writeFileSync(join(dirs.workspaceDir, 'sw-work.hold'), '');
    for (const id of chats) {
      await api.post(`/chats/${id}/stop`).catch(() => {});
      for (let i = 0; i < 40; i++) {
        if ((await api.del(`/chats/${id}`).catch(() => ({ status: 0 }))).status === 200) break;
        await sleep(250);
      }
    }
    for (const id of added) await api.del(`/accounts/${id}`).catch(() => {});
    await api.put('/accounts/settings', settings).catch(() => {});
    writeFileSync(fake.scripts, savedScripts ?? '{}');
  }
};
