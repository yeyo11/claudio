// The queued card's alternatives to a blind interrupt (docs/chat-delivery.md, "The page";
// docs/plans/regression-fixes-2026-10-29.md, D4 and C2), in the browser against the fake CLI:
// a message held behind a foreground command is delivered by sending the command to the
// background, which keeps running, with nothing interrupted; and a waiting message is taken back
// into the box, withdrawn from the CLI's queue, and stays away after a reload.
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

export const fakeCli = true;
export const timeout = 180_000;

const logOf = (file) => (existsSync(file) ? readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);

async function until(condition, label, ms = 20_000) {
  const end = Date.now() + ms;
  for (;;) {
    const value = await condition();
    if (value) return value;
    if (Date.now() > end) throw new Error(`timed out waiting for: ${label}`);
    await sleep(150);
  }
}

const SCRIPTS = {
  'DELIVERY-BG': 'run: sleep 30\nsay: Built.',
  'DELIVERY-W': 'run: true\nhold: delivery-w.hold\nsay: Done.',
};
const HOLDS = ['delivery-w.hold'];

/** What the page shows of the queued card. */
const CARD = `
  const card = document.querySelector('.chat-queued');
  return {
    rows: [...document.querySelectorAll('.chat-queued-item')].map((li) => ({ text: li.querySelector('.chat-queued-text')?.textContent ?? '', lost: li.classList.contains('is-lost'), notice: li.classList.contains('is-notice') })),
    foot: card?.querySelector('.chat-queued-foot .small')?.textContent ?? '',
    actions: [...(card?.querySelectorAll('.chat-queued-foot .btn') ?? [])].map((b) => b.textContent),
    box: (e=>e&&[...e.querySelectorAll('p')].map(p=>p.textContent).join('\\n'))(document.querySelector('.composer [data-composer-input]')) ?? null,
    said: [...document.querySelectorAll('.transcript .msg-user')].map((m) => m.innerText),
  };`;

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

export default async ({ page, api, check, dirs, fakeCli: fake }) => {
  const savedScripts = existsSync(fake.scripts) ? readFileSync(fake.scripts, 'utf8') : null;
  writeFileSync(fake.scripts, JSON.stringify({ ...SCRIPTS, '@transcript': true }));
  const started = [];
  const hold = (name) => writeFileSync(join(dirs.workspaceDir, name), '');
  const log = () => logOf(fake.log);
  const pidOf = (id) => log().find((e) => e.event === 'started' && e.argv.includes(id))?.pid;
  const startChat = async (prompt) => {
    const res = await api.post('/chats', { prompt, cwd: dirs.workspaceDir });
    check(res.status === 201, `the chat "${prompt}" started: ${JSON.stringify(res.body)}`);
    started.push(res.body.id);
    return res.body.id;
  };
  const card = () => page.eval(CARD);
  const open = async (id) => {
    await page.goto(`/chats/${id}`, 1200);
    await page.waitFor(`return !!document.querySelector('.composer [data-composer-input]')`, { label: 'the composer' });
  };
  const send = async (text) => {
    await page.waitFor(`return !!document.querySelector('.composer.is-working')`, { label: 'the page to show the chat working' });
    await page.fill('.composer [data-composer-input]', text);
    await page.click('.composer-send');
  };

  try {
    await page.goto('/', 800);

    // ---------- held behind a foreground command: send it to the background and deliver ----------
    {
      const MSG = 'read this while it builds';
      const id = await startChat('DELIVERY-BG build the preview');
      await open(id);
      const command = await until(() => log().find((e) => e.event === 'command' && e.command === 'sleep 30' && e.pid === pidOf(id)), 'the command to start');
      await sleep(400);
      await send(MSG);
      await until(async () => (await card()).rows.some((r) => r.text === MSG), 'the queued card');
      // The server names the call the message waits behind; the page reads it with the chat
      const blocked = await until(async () => {
        const now = await card();
        return now.actions.length === 2 ? now : null;
      }, 'the card to offer the background');
      check(blocked.foot.includes('sleep 30'), `the foot names the command an interrupt would end: "${blocked.foot}"`);
      check(blocked.actions[0] === 'Send to background and deliver' && blocked.actions[1] === 'Interrupt the turn', `the two ways out, background first: ${JSON.stringify(blocked.actions)}`);
      const listed = ((await api.get(`/chats/${id}`)).body?.chat?.pending ?? []).find((m) => m.text === MSG);
      check(listed?.blockedBy?.toolUseId === command.toolUseId, `the chat lists what holds the message: ${JSON.stringify(listed)}`);

      await page.click('.chat-queued-foot .btn');
      await until(() => log().some((e) => e.event === 'backgrounded' && e.toolUseId === command.toolUseId), 'the CLI to send the command to the background');
      await until(async () => !(await card()).rows.some((r) => r.text === MSG), 'the card to clear once the message is read');
      await until(async () => (await card()).said.some((t) => t.includes(MSG)), 'the message in the conversation');
      check(!log().some((e) => e.event === 'control' && e.subtype === 'interrupt' && e.pid === pidOf(id)), 'nothing was interrupted');
      check(alive(command.commandPid), 'the command goes on in the background');
    }

    // ---------- a waiting message taken back to the box ----------
    {
      const MSG = 'never mind, take this back';
      const id = await startChat('DELIVERY-W hold here');
      await open(id);
      await until(() => log().some((e) => e.event === 'command-ended' && e.command === 'true' && e.pid === pidOf(id)), 'the turn to reach its hold');
      await sleep(400);
      await send(MSG);
      await until(async () => (await card()).rows.some((r) => r.text === MSG && !r.lost), 'the queued card');
      await page.click('.chat-queued-item .icon-btn');
      await until(() => log().some((e) => e.event === 'cancelled' && e.pid === pidOf(id)), 'the CLI to drop it from its queue');
      const after = await until(async () => {
        const now = await card();
        return now.rows.some((r) => r.text === MSG) ? null : now;
      }, 'the card to go');
      check((after.box ?? '').includes(MSG), `the words are back in the box: ${JSON.stringify(after.box)}`);
      await open(id);
      await sleep(800);
      check(!(await card()).rows.some((r) => r.text === MSG), 'a reload does not bring the card back');
      hold('delivery-w.hold');
      await until(async () => (await api.get(`/chats/${id}`)).body?.chat?.state === 'idle', 'the turn to end');
      check(!log().some((e) => e.event === 'turn' && String(e.text ?? '').startsWith(MSG)), 'the withdrawn message never ran');
    }
  } finally {
    for (const name of HOLDS) hold(name);
    for (const id of started) await api.post(`/chats/${id}/stop`).catch(() => {});
    if (savedScripts === null) rmSync(fake.scripts, { force: true });
    else writeFileSync(fake.scripts, savedScripts);
    for (const name of HOLDS) rmSync(join(dirs.workspaceDir, name), { force: true });
    // Specs after this one read the projects directory: the transcripts the fake wrote go with it
    const dir = join(dirs.configDir, 'projects', dirs.workspaceDir.replace(/[^a-zA-Z0-9]/g, '-'));
    for (const id of started) rmSync(join(dir, `${id}.jsonl`), { force: true });
    if (existsSync(dir) && readdirSync(dir).length === 0) rmSync(dir, { recursive: true, force: true });
  }
};
