// Messages between agents, and a composer that writes to one subagent (docs/plans/agent-messages.md),
// in the browser against the fake CLI. The lead launches a background subagent and writes to it
// (`message:`), the subagent writes to the lead and hands its report back (`send:`, `report:`): the
// transcript shows each as an agent message card, not as the person's bubble with XML in it. The
// person writes to the subagent from its drawer: the words go through the chat's `claudio-bridge`
// mod (which the fake emulates when it is given `--plugin-dir`, e2e/fake-cli/README.md), the card
// turns delivered, the subagent's transcript shows the person's bubble, and the lead's shows a system
// row. Then every state of the drawer's box: finished, stopped, the bridge down (a card that offers
// the lead as a way round), a refusal, and the chat gone.
//
// Hold files keep the subagent running for as long as a state is read, and the lead's turn waits too,
// so the process stays and the chat is live while the spec reads it.
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

export const fakeCli = true;
export const timeout = 240_000;

const KEY = 'AGENT-MESSAGES';
const READ = 'e2e-agent-messages-notes.md';
const HOLDS = { agent: 'e2e-agent-messages-agent.hold', turn: 'e2e-agent-messages-turn.hold' };
const WORKER = 'Shipcast seeder';
const STOPPED = 'Stopped helper';
const LEAD_WORDS = 'Please also check the retry path.';
const SUB_WORDS = 'Two launches are seeded, checking the rest.';
const REPORT = '7 launches seeded; running it twice gives identical row counts.';

const logOf = (file) => (existsSync(file) ? readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);

async function until(condition, label, ms = 20_000) {
  const end = Date.now() + ms;
  for (;;) {
    const value = await condition();
    if (value) return value;
    if (Date.now() > end) throw new Error(`timed out waiting for: ${label}`);
    await sleep(200);
  }
}

/** The agent message cards of a scope, as a reader sees them */
const CARDS = (scope) => `
  return [...document.querySelectorAll(${JSON.stringify(`${scope} .agent-msg`)})].map((c) => ({
    head: c.querySelector('.agent-msg-head')?.innerText.replace(/\\s+/g, ' ').trim() ?? '',
    body: c.querySelector('.agent-msg-body')?.innerText.trim() ?? '',
    names: [...c.querySelectorAll('.agent-msg-name')].map((n) => ({ text: n.textContent.trim(), button: n.tagName === 'BUTTON' })),
    tag: c.querySelector('.agent-msg-head .badge')?.textContent.trim() ?? '',
  }))`;

/** The system rows of the lead's transcript */
const ROWS = `
  return [...document.querySelectorAll('.transcript .sys-msg')].map((r) => ({
    label: r.querySelector('.sys-msg-label')?.textContent.replace(/\\s+/g, ' ').trim() ?? '',
    words: r.querySelector('.sys-msg-words')?.textContent.trim() ?? '',
  }))`;

/** The drawer's box: what it says and whether it takes words */
const COMPOSER = `
  const box = document.querySelector('[role=dialog] .agent-composer');
  const input = box?.querySelector('[data-composer-input]');
  return {
    there: !!box,
    note: box?.querySelector('.agent-composer-note')?.textContent.trim() ?? '',
    enabled: !!input && input.getAttribute('contenteditable') !== 'false',
    queued: [...(box?.querySelectorAll('.chat-queued-item') ?? [])].map((li) => ({ text: li.querySelector('.chat-queued-text')?.textContent ?? '', lost: li.classList.contains('is-lost') })),
    actions: [...(box?.querySelectorAll('.chat-queued-actions .btn') ?? [])].map((b) => b.textContent.trim()),
  }`;

export default async ({ page, api, check, dirs, fakeCli: fake }) => {
  const savedScripts = existsSync(fake.scripts) ? readFileSync(fake.scripts, 'utf8') : null;
  const work = dirs.workspaceDir;
  const files = [READ, ...Object.values(HOLDS)].map((name) => join(work, name));
  for (const file of files) rmSync(file, { force: true });
  writeFileSync(join(work, READ), '# Notes\n\nWhat the subagent reads.\n');
  const scripts = {
    '@transcript': true,
    [KEY]: [
      `agent: background: ${WORKER} | read: ${READ}; hold: ${HOLDS.agent}; send: ${SUB_WORDS}; report: ${REPORT}`,
      `agent: background: ${STOPPED} | end: stopped`,
      `message: ${WORKER} | ${LEAD_WORDS}`,
      `hold: ${HOLDS.turn}`,
      'say: All delivered.',
    ].join('\n'),
  };
  const writeScripts = (extra = {}) => writeFileSync(fake.scripts, JSON.stringify({ ...scripts, ...extra }));
  writeScripts();
  let chatId = null;
  const agentIdOf = (description) => logOf(fake.log).find((e) => e.event === 'agent' && e.description === description && e.pid === pidOfChat())?.agentId;
  const pidOfChat = () => logOf(fake.log).find((e) => e.event === 'started' && chatId && e.argv.includes(chatId))?.pid;
  const pending = async () => ((await api.get(`/chats/${chatId}`)).body?.chat?.pending ?? []).filter((m) => m.to);
  const drawer = () => page.waitFor(`return !!document.querySelector('[role=dialog] .agent-composer')`, { label: "the subagent's drawer with its box" });
  const write = async (text) => {
    await page.fill('[role=dialog] .agent-composer [data-composer-input]', text);
    await page.click('[role=dialog] .agent-composer .composer-send');
  };

  try {
    await page.viewport(1440, 900);
    await page.goto('/', 800);
    const res = await api.post('/chats', { prompt: `${KEY}: seed the launches and keep me posted`, cwd: work });
    check(res.status === 201, `the chat started (${res.status} ${JSON.stringify(res.body)})`);
    chatId = res.body.id;
    await page.goto(`/chats/${chatId}`, 1200);
    await page.waitFor(`return !!document.querySelector('.composer [data-composer-input]')`, { label: 'the chat page' });

    // ---- the lead's SendMessage: a card under its step, not a bubble, and a lens on the step row ----
    await page.waitFor(`return document.querySelectorAll('.transcript .agent-msg').length >= 1`, { label: "the lead's message to the subagent as a card", timeout: 30_000 });
    let cards = await page.eval(CARDS('.transcript'));
    const toWorker = cards.find((c) => c.body.includes(LEAD_WORDS));
    check(Boolean(toWorker), `the lead's words are in a card (${JSON.stringify(cards)})`);
    check(/Lead\s*→?\s*.*Shipcast seeder|Lead.*Shipcast seeder/.test(toWorker?.head ?? ''), `the head reads sender then receiver (${toWorker?.head})`);
    check(toWorker?.names.some((n) => n.text === WORKER && n.button), 'the subagent\'s name is a button that opens it');
    check(!(await page.eval(`return [...document.querySelectorAll('.transcript .msg-user')].some((m) => m.innerText.includes('agent-message'))`)), 'no bubble carries the <agent-message> frame');

    // ---- the drawer: a box, a note, the lead's card in the subagent's own transcript ----
    const agentId = await until(() => agentIdOf(WORKER), 'the fake to start the subagent');
    await page.click('.transcript .chat-launch-open', undefined, 800);
    await drawer();
    await page.waitFor(`return document.querySelectorAll('[role=dialog] .agent-msg').length >= 1`, { label: "the lead's message in the subagent's transcript", timeout: 20_000 });
    const inDrawer = await page.eval(CARDS('[role=dialog]'));
    check(inDrawer.some((c) => c.body.includes(LEAD_WORDS) && /^Lead/.test(c.head)), `the subagent reads the lead's message as a card from the lead (${JSON.stringify(inDrawer)})`);
    let box = await page.eval(COMPOSER);
    check(box.enabled && box.note === 'Goes straight to this subagent; the lead does not see it.', `a running subagent takes words and says where they go (${JSON.stringify(box)})`);
    check((await page.eval(`return document.querySelector('[role=dialog] .agent-composer [data-composer-input]')?.getAttribute('aria-label') ?? ''`)) === `Message ${WORKER}…`, 'the box is addressed to the subagent by name');

    // ---- the person writes to the subagent: through the bridge, delivered, and a bubble ----
    const PERSON = 'Skip the staging launches, they are not real.';
    await write(PERSON);
    await until(() => logOf(fake.log).some((e) => e.event === 'bridge-send' && e.agentId === agentId && e.text.includes(PERSON) && e.isDelivered === true), 'the bridge to carry the message to the subagent');
    await page.waitFor(`return document.querySelector('[role=dialog] .agent-composer .chat-queued-item') === null`, { label: 'the receipt to leave the queue once delivered' });
    await until(async () => (await pending()).length === 0, 'the message to leave the pending list');
    await page.waitFor(
      `return [...document.querySelectorAll('[role=dialog] .msg-user')].some((m) => m.innerText.includes(${JSON.stringify(PERSON)}))`,
      { label: "the person's bubble in the subagent's transcript", timeout: 20_000 },
    );
    const said = await page.eval(`return [...document.querySelectorAll('[role=dialog] .msg-user')].map((m) => m.innerText).find((t) => t.includes(${JSON.stringify(PERSON)}))`);
    check(!/A message from the person/.test(said), `the bubble has no English prefix (${JSON.stringify(said)})`);
    check(/You/.test(said) && !said.includes('<'), `the bubble says who it is from, with no XML (${JSON.stringify(said)})`);
    const sent = logOf(fake.log).find((e) => e.event === 'bridge-send' && e.text.includes(PERSON));
    check(sent.text.startsWith('A message from the person following this chat, written to you directly'), 'the subagent was told it came from the person and that the lead does not see it');
    await page.shot('agent-messages-drawer');

    // ---- the lead's transcript records it as a system row that names the subagent ----
    await page.key('Escape');
    await page.waitFor(`return document.querySelector('[role=dialog]') === null`, { label: 'Escape closes the drawer' });
    await page.waitFor(`return [...document.querySelectorAll('.transcript .sys-msg')].some((r) => r.textContent.includes(${JSON.stringify(PERSON)}))`, { label: 'the relay row in the lead', timeout: 20_000 });
    const rows = await page.eval(ROWS);
    const relay = rows.find((r) => r.words.includes(PERSON));
    check(relay?.label.startsWith('You') && relay.label.includes(WORKER), `the row reads "You → ${WORKER}" (${JSON.stringify(relay)})`);
    check(await page.eval(`return !![...document.querySelectorAll('.transcript .sys-msg')].find((r) => r.textContent.includes(${JSON.stringify(PERSON)}))?.querySelector('button.agent-msg-name')`), 'the name in the row opens the subagent');
    check(!(await page.eval(`return [...document.querySelectorAll('.transcript .msg-user')].some((m) => m.innerText.includes(${JSON.stringify(PERSON)}))`)), 'the lead has no bubble for it: it never saw the words');

    // ---- the subagent writes to the lead, then hands its report back: peer cards ----
    writeFileSync(join(work, HOLDS.agent), '');
    await page.waitFor(`return [...document.querySelectorAll('.transcript .agent-msg')].some((c) => c.textContent.includes(${JSON.stringify(SUB_WORDS)}))`, { label: "the subagent's message to the lead as a card", timeout: 30_000 });
    await page.waitFor(`return [...document.querySelectorAll('.transcript .agent-msg')].some((c) => c.textContent.includes('7 launches seeded'))`, { label: "the subagent's report as a card", timeout: 30_000 });
    cards = await page.eval(CARDS('.transcript'));
    const fromWorker = cards.find((c) => c.body.includes(SUB_WORDS));
    check(fromWorker?.head.startsWith(WORKER) && !fromWorker.tag, `the message from the subagent: sender first, no tag (${JSON.stringify(fromWorker)})`);
    const report = cards.find((c) => c.body.includes('7 launches seeded'));
    check(report?.tag === 'Final report', `a hand-back carries the "Final report" tag (${JSON.stringify(report)})`);
    check(!report?.body.includes('Subagent hand-back') && !report?.body.includes('agent-message'), `the card holds the report, not the harness frame (${JSON.stringify(report?.body)})`);
    check(!(await page.eval(`return [...document.querySelectorAll('.transcript .msg-user')].some((m) => m.innerText.includes('Another Claude session'))`)), 'no bubble carries the harness frame of a peer message');

    // ---- a finished subagent still takes a message, and says so ----
    await page.click('.transcript .chat-launch-open', undefined, 800);
    await drawer();
    await page.waitFor(`return /resumes it/.test(document.querySelector('[role=dialog] .agent-composer-note')?.textContent ?? '')`, { label: 'the note of a finished subagent', timeout: 20_000 });
    box = await page.eval(COMPOSER);
    check(box.enabled && box.note === 'It has finished: your message resumes it.', `a finished subagent is written to as well (${JSON.stringify(box)})`);
    const AFTER = 'One more thing: log the seed count.';
    await write(AFTER);
    await until(() => logOf(fake.log).some((e) => e.event === 'bridge-send' && e.text.includes(AFTER) && e.isDelivered === true), 'the finished subagent to take the message');
    await page.key('Escape');
    await page.waitFor(`return document.querySelector('[role=dialog]') === null`, { label: 'the drawer to close' });

    // ---- a stopped subagent cannot be written to ----
    const stoppedId = await until(() => agentIdOf(STOPPED), 'the second subagent');
    await page.eval(`const cards = [...document.querySelectorAll('.transcript .chat-launch')]; const card = cards.find((c) => c.textContent.includes(${JSON.stringify(STOPPED)})); card?.querySelector('.chat-launch-open')?.click(); return !!card`);
    await drawer();
    await page.waitFor(`return /cannot be resumed/.test(document.querySelector('[role=dialog] .agent-composer-note')?.textContent ?? '')`, { label: 'the note of a stopped subagent', timeout: 20_000 });
    box = await page.eval(COMPOSER);
    check(!box.enabled && box.note === 'You stopped it, so it cannot be resumed.', `a stopped subagent's box is off, with the reason (${JSON.stringify(box)})`);
    const refused = await api.post(`/chats/${chatId}/subagents/${stoppedId}/messages`, { text: 'hello?' });
    check(refused.status === 409 && /stopped/i.test(JSON.stringify(refused.body)), `the route refuses a stopped subagent with a 409 (${refused.status} ${JSON.stringify(refused.body)})`);
    await page.key('Escape');
    await page.waitFor(`return document.querySelector('[role=dialog]') === null`, { label: 'the drawer to close' });

    // ---- the CLI refuses a send: the message is undelivered with the CLI's reason ----
    writeScripts({ '@bridge-refuse': 'The CLI would not deliver it.' });
    const NOT_READ = 'This one is refused by the CLI.';
    const refusedSend = await api.post(`/chats/${chatId}/subagents/${agentId}/messages`, { text: NOT_READ });
    check(refusedSend.status === 200 || refusedSend.status === 201, `the route took the message (${refusedSend.status} ${JSON.stringify(refusedSend.body)})`);
    const lost = await until(async () => (await pending()).find((m) => m.text === NOT_READ && m.state === 'undelivered'), 'the refused message to turn undelivered');
    check(lost.reasonCode === 'not-read' && (lost.reason ?? '').includes('The CLI would not deliver it.'), `undelivered as not-read, with the CLI's sentence (${JSON.stringify(lost)})`);
    await api.del(`/chats/${chatId}/subagents/${agentId}/messages/${lost.id}`);
    await until(async () => (await pending()).length === 0, 'the refused message to be dismissed');
    writeScripts();

    // ---- the bridge down: a card that offers the lead, and the lead reads the relay ----
    writeScripts({ '@bridge': false });
    // A poll held open still counts as present, so the loop has to go quiet before the 15 s start
    await sleep(500);
    const LOST = 'Is anybody there?';
    const queued = await api.post(`/chats/${chatId}/subagents/${agentId}/messages`, { text: LOST });
    check(queued.status === 200 || queued.status === 201, `the route took it with the bridge down (${queued.status})`);
    await page.click('.transcript .chat-launch-open', undefined, 800);
    await drawer();
    const down = await page.waitFor(
      `const box = document.querySelector('[role=dialog] .agent-composer'); const item = box?.querySelector('.chat-queued-item.is-lost'); return !!item && item.querySelectorAll('.chat-queued-actions .btn').length === 2`,
      { label: 'the card of a message the bridge never took', timeout: 70_000 },
    );
    check(Boolean(down), 'the lost message turns into a card with two actions');
    box = await page.eval(COMPOSER);
    check(box.enabled, 'the box stays enabled so the person can try again');
    check(box.actions.join('|') === 'Send through the lead|Discard', `the card offers the lead and discarding (${JSON.stringify(box.actions)})`);
    const lead = (await pending()).find((m) => m.text === LOST);
    check(lead?.reasonCode === 'bridge-unavailable', `undelivered as bridge-unavailable (${JSON.stringify(lead)})`);
    await page.shot('agent-messages-bridge-down');
    const before = logOf(fake.log).filter((e) => e.event === 'stdin').length;
    await page.click('[role=dialog] .agent-composer .chat-queued-actions .btn', 'Send through the lead', 400);
    await until(() => logOf(fake.log).filter((e) => e.event === 'stdin').slice(before).some((e) => e.text.includes('Relay this to your background agent') && e.text.includes(LOST)), 'the lead to receive the relay hint');
    await page.waitFor(`return document.querySelector('[role=dialog] .agent-composer .chat-queued-item') === null`, { label: 'the card to go once the lead has it' });
    writeScripts();
    await page.key('Escape');
    await page.waitFor(`return document.querySelector('[role=dialog]') === null`, { label: 'the drawer to close' });

    // ---- the person's hint to the lead keeps the person's bubble, tagged, with no prefix ----
    const HINT = 'Mind the rate limit on the staging API.';
    const hint = await api.post(`/chats/${chatId}/hint`, { text: HINT });
    check(hint.status === 200 || hint.status === 201, `the hint was taken (${hint.status})`);
    await page.waitFor(`return [...document.querySelectorAll('.transcript .msg-user')].some((m) => m.innerText.includes(${JSON.stringify(HINT)}))`, { label: 'the hint in the transcript', timeout: 20_000 });
    const bubble = await page.eval(`
      const m = [...document.querySelectorAll('.transcript .msg-user')].find((x) => x.innerText.includes(${JSON.stringify(HINT)}));
      return { text: m.innerText, tag: m.querySelector('.msg-head .badge')?.textContent.trim() ?? '' };`);
    check(bubble.tag === 'Hint', `the person's hint carries the "Hint" tag (${JSON.stringify(bubble)})`);
    check(!bubble.text.includes('A hint from the person following this chat'), `and none of the English prefix (${JSON.stringify(bubble.text)})`);

    // ---- a reload draws the same cards and rows ----
    writeFileSync(join(work, HOLDS.turn), '');
    await page.goto(`/chats/${chatId}`, 1500);
    await page.waitFor(`return document.querySelectorAll('.transcript .agent-msg').length >= 3 && document.querySelectorAll('.transcript .sys-msg').length >= 1`, { label: 'the cards and rows after a reload', timeout: 30_000 });
    cards = await page.eval(CARDS('.transcript'));
    check(cards.some((c) => c.tag === 'Final report') && cards.some((c) => c.body.includes(LEAD_WORDS)), 'after a reload the cards are the same');

    // ---- the chat gone: the box is off and says why ----
    await api.post(`/chats/${chatId}/stop`);
    await until(async () => (await api.get(`/chats/${chatId}`)).body?.chat?.execution === null, 'the chat to stop', 15_000);
    await page.goto(`/chats/${chatId}`, 1500);
    await page.waitFor(`return document.querySelectorAll('.transcript .chat-launch-open').length >= 1`, { label: 'the launch cards of the stopped chat' });
    await page.click('.transcript .chat-launch-open', undefined, 800);
    await drawer();
    await page.waitFor(`return /not running/.test(document.querySelector('[role=dialog] .agent-composer-note')?.textContent ?? '')`, { label: 'the note of a chat that is gone', timeout: 20_000 });
    box = await page.eval(COMPOSER);
    check(!box.enabled && box.note === 'The chat is not running.', `a stopped chat's box is off (${JSON.stringify(box)})`);
  } finally {
    if (chatId) {
      for (const file of Object.values(HOLDS)) writeFileSync(join(work, file), '');
      await api.post(`/chats/${chatId}/stop`).catch(() => {});
      for (let i = 0; i < 40; i++) {
        if ((await api.del(`/chats/${chatId}`).catch(() => ({ status: 0 }))).status === 200) break;
        await sleep(250);
      }
    }
    for (const file of files) rmSync(file, { force: true });
    if (savedScripts === null) rmSync(fake.scripts, { force: true });
    else writeFileSync(fake.scripts, savedScripts);
    // Specs after this one read the projects directory: the transcripts the fake wrote go with the chat
    if (chatId) rmSync(join(dirs.configDir, 'projects', work.replace(/[^a-zA-Z0-9]/g, '-'), chatId), { recursive: true, force: true });
    if (chatId) rmSync(join(dirs.configDir, 'projects', work.replace(/[^a-zA-Z0-9]/g, '-'), `${chatId}.jsonl`), { force: true });
  }
};
