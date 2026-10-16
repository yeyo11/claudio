// Several Claude accounts (docs/accounts.md) end to end, against the fake CLI of e2e/fake-cli: two
// token accounts, a chat started on the one at its limit (`FAKE-LIMIT-ACCOUNT`), and the replay of its
// turn on another account, with the switch recorded. A token starting with `fake-expired` fails to
// authenticate (`FAKE-AUTH-EXPIRED-ACCOUNT`): a chat on it moves to the account with room, the
// account reads "Sign-in expired" on the Accounts page, and an orchestration task started on it runs
// on the other one.
//
// The fake CLI answers every account as signed in; only a token starting with `fake-limited` is out
// of room, and one starting with `fake-expired` is out of sign-in.
// The spec removes the accounts it added and puts the settings back.
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

export const fakeCli = true;
export const timeout = 120_000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export default async ({ page, api, check, dirs }) => {
  const settings = (await api.get('/accounts/settings')).body;
  const added = [];
  const chats = [];
  const orchestrations = [];
  let chatId = null;
  try {
    const list = await api.get('/accounts');
    check(list.status === 200 && list.body[0]?.id === 'default', `GET /accounts lists the default account first (${list.status})`);

    const limited = await api.post('/accounts/token', { kind: 'token', alias: 'e2e-limited', secret: 'fake-limited-e2e' });
    check(limited.status === 201 && limited.body.alias === 'e2e-limited', `a token account is added (${limited.status})`);
    added.push(limited.body.id);
    const room = await api.post('/accounts/token', { kind: 'token', alias: 'e2e-room', secret: 'fake-room-e2e' });
    check(room.status === 201, `a second token account is added (${room.status})`);
    added.push(room.body.id);
    check(!JSON.stringify([limited.body, room.body]).includes('fake-'), 'no answer carries a secret');

    check((await api.post('/accounts/token', { kind: 'token', secret: 'fake-no-alias' })).status >= 400, 'a token account needs an alias');
    check((await api.del('/accounts/default')).status >= 400, 'the default account cannot be removed');

    const saved = await api.put('/accounts/settings', { ...settings, rotateOnLimit: true });
    check(saved.status === 200 && saved.body.rotateOnLimit === true, 'rotation on a limit is on');

    const created = await api.post('/chats', { prompt: 'FAKE-LIMIT-ACCOUNT', account: limited.body.id });
    check(created.status === 201, `the chat starts on the limited account (${created.status})`);
    chatId = created.body.id;

    let chat = null;
    for (let i = 0; i < 80; i++) {
      chat = (await api.get(`/chats/${chatId}`)).body?.chat ?? null;
      if ((chat.executions ?? []).some((e) => e.account && e.account !== limited.body.id)) break;
      await sleep(250);
    }
    const accounts = (chat.executions ?? []).map((e) => e.account);
    check(accounts[0] === limited.body.id, `the first process ran on the limited account (${accounts.join(', ')})`);
    check(accounts.some((a) => a && a !== limited.body.id), `the turn was replayed on another account, in the same chat (${accounts.join(', ')})`);

    const events = await api.get('/accounts/events');
    check(events.status === 200 && events.body.some((e) => e.event === 'switch' && e.from === limited.body.id), 'the switch is recorded in the rotation events');

    // ---------- an expired sign-in ----------
    const expired = await api.post('/accounts/token', { kind: 'token', alias: 'e2e-expired', secret: 'fake-expired-e2e' });
    check(expired.status === 201, `a token account that cannot sign in is added (${expired.status})`);
    added.push(expired.body.id);
    const signedChat = await api.post('/chats', { prompt: 'FAKE-AUTH-EXPIRED-ACCOUNT', account: expired.body.id });
    check(signedChat.status === 201, `the chat starts on the expired account (${signedChat.status})`);
    chats.push(signedChat.body.id);
    let moved = null;
    for (let i = 0; i < 80; i++) {
      moved = (await api.get(`/chats/${signedChat.body.id}`)).body?.chat ?? null;
      if ((moved?.executions ?? []).some((e) => e.account && e.account !== expired.body.id)) break;
      await sleep(250);
    }
    const movedTo = (moved?.executions ?? []).map((e) => e.account);
    check(movedTo[0] === expired.body.id, `the first process ran on the expired account (${movedTo.join(', ')})`);
    check(movedTo.some((a) => a && a !== expired.body.id), `a sign-in failure moved the turn to another account, in the same chat (${movedTo.join(', ')})`);
    const after = (await api.get('/accounts')).body.find((a) => a.id === expired.body.id);
    check(after?.signInState === 'expired' && after.signedIn === false, `the expired account reads signed out (${after?.signInState})`);
    const authEvents = (await api.get('/accounts/events')).body;
    check(authEvents.some((e) => e.event === 'switch' && e.from === expired.body.id && e.reason === 'auth'), 'the switch is recorded with the reason auth');

    await page.goto('/accounts', 1500);
    await page.waitFor(`return document.body.innerText.toLowerCase().includes('sign-in expired')`, { label: 'the expired sign-in on the Accounts page' });
    check(await page.eval(`return [...document.querySelectorAll('button')].some((b) => b.textContent.includes('Sign in again')) || document.body.innerText.toLowerCase().includes('sign in again')`), 'the page offers to sign in again');

    // ---------- an orchestration task after it ----------
    // The expired mark keeps the account out of the choice, so the task's chat runs on another one.
    // The retry after an account ran out is guarded in core (orchestration-retry-account.test.ts):
    // a task cannot be made to fail on one account here
    const workspace = join(dirs.workspaceDir, 'e2e-accounts');
    mkdirSync(workspace, { recursive: true });
    const orch = await api.post('/orchestrations', {
      name: 'e2e-accounts-expired',
      objective: 'a task whose account cannot sign in',
      cwd: workspace,
      maxAttempts: 1,
      worktree: false,
      synthesize: false,
      tasks: [{ id: 'work', name: 'Work', prompt: 'FAKE-AUTH-EXPIRED-ACCOUNT\nsay: done' }],
    });
    check(orch.status === 201, `the orchestration is created (${orch.status})`);
    orchestrations.push(orch.body.id);
    let task = null;
    for (let i = 0; i < 80; i++) {
      task = (await api.get(`/orchestrations/${orch.body.id}`)).body?.tasks?.find((t) => t.id === 'work') ?? null;
      if (task?.status === 'done' || task?.status === 'completed' || task?.status === 'failed') break;
      await sleep(400);
    }
    check(task && task.status !== 'failed', `the task did not fail on the expired account (${task?.status})`);
  } finally {
    for (const id of chats) {
      await api.post(`/chats/${id}/stop`).catch(() => {});
      for (let i = 0; i < 40; i++) {
        if ((await api.del(`/chats/${id}`).catch(() => ({ status: 0 }))).status === 200) break;
        await sleep(250);
      }
    }
    for (const id of orchestrations) {
      await api.post(`/orchestrations/${id}/stop`).catch(() => {});
      await api.del(`/orchestrations/${id}`).catch(() => {});
    }
    if (chatId) {
      await api.post(`/chats/${chatId}/stop`).catch(() => {});
      for (let i = 0; i < 40; i++) {
        if ((await api.del(`/chats/${chatId}`).catch(() => ({ status: 0 }))).status === 200) break;
        await sleep(250);
      }
    }
    for (const id of added) await api.del(`/accounts/${id}`).catch(() => {});
    await api.put('/accounts/settings', settings).catch(() => {});
  }
};
