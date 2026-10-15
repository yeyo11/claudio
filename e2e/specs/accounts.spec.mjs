// Several Claude accounts (docs/accounts.md) end to end, against the fake CLI of e2e/fake-cli: two
// token accounts, a chat started on the one at its limit (`FAKE-LIMIT-ACCOUNT`), and the replay of its
// turn on another account, with the switch recorded.
//
// The fake CLI answers every account as signed in; only a token starting with `fake-limited` is out.
// The spec removes the accounts it added and puts the settings back.
export const fakeCli = true;
export const timeout = 120_000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export default async ({ api, check }) => {
  const settings = (await api.get('/accounts/settings')).body;
  const added = [];
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
  } finally {
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
