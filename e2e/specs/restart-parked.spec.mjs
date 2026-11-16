// Layer 2 of docs/plans/survive-restarts.md (t3 to t5), end to end on the fake CLI: with parked
// processes on, a server that goes away mid-turn leaves the chat's CLI running and the next server
// adopts it. On a wrapper of its own (a peer) whose server this spec restarts twice:
//   1. a turn held mid-way survives the restart on the same process (one start, one pid), finishes
//      without a resume, and the chat's token, which only the old server knew in memory, still works
//      from inside the CLI;
//   2. a permission prompt that waits across the second restart is asked again in the page, and
//      answering it finishes the turn on that same process;
//   3. each turn is in the spend ledger once.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { chatStarts, fakeLog, transcriptText, until } from './restart-shared.mjs';

export const fakeCli = true;
export const timeout = 240_000;
export const peers = ['parked'];
// Scopes off: the same detached process the headless image uses, whatever the machine's user manager
export const peerEnv = { parked: { CLAUDIO_PARKED_PROCESSES: 'on', CLAUDIO_PARKED_SCOPES: 'off', CLAUDIO_FAKE_CLI_TURN_COST_USD: '0.25' } };

const HOLD = 'restart-parked.hold';
// The chat's own token against a route a chat's token is refused on: 403 says the server knew whose it was,
// 200 or 400 says it read it as the owner's (open mode never refuses a token it does not know)
const PROBE = (file) => `curl -s -o /dev/null -w %{http_code} -X POST -H "Authorization: Bearer $CLAUDIO_API_TOKEN" -H "content-type: application/json" -d '{}' "$CLAUDIO_API_URL/guards/check" > ${file}`;

export default async ({ check, peers: { parked: peer } }) => {
  const work = peer.dirs.workspaceDir;
  writeFileSync(
    peer.fakeCli.scripts,
    JSON.stringify({
      'PARKED-ONE': ['say: Working before the restart.', `hold: ${HOLD}`, `run: ${PROBE('restart-parked-token-1.txt')}`, 'say: First turn done.'].join('\n'),
      'PARKED-TWO': ['ask: echo adopted', `run: ${PROBE('restart-parked-token-2.txt')}`, 'say: Second turn done.'].join('\n'),
    }),
  );
  const page = peer.page;
  // The tab leaves the server before it goes: a lazy chunk fetched while it is down is a console error
  const away = () => page.eval(`location.assign('about:blank'); return true`);
  const events = () => fakeLog(peer.fakeCli.log);
  const token = (name) => (existsSync(join(work, name)) ? readFileSync(join(work, name), 'utf8').trim() : null);

  const created = await peer.api.post('/chats', { prompt: 'PARKED-ONE', cwd: work, permissionPrompts: 'host' });
  check(created.status === 201, `the chat starts (${created.status})`);
  const id = created.body.id;

  await page.goto(`/chats/${id}`, 800);
  await page.waitFor(`return document.querySelector('.transcript')?.innerText.includes('Working before the restart.')`, { label: 'the turn under way' });
  const first = await until(() => events().find((e) => e.event === 'stdin' && String(e.text).includes('PARKED-ONE')), 'the fake CLI to read the prompt');
  const pid = first.pid;
  check(chatStarts(events()).length === 1, 'one CLI process so far');

  // ---- 1. A restart in the middle of the turn ----
  await away();
  await peer.restart();
  await page.goto(`/chats/${id}`, 800);
  // The process is still there, holding the turn: the page reads it as working, with nothing started to replace it
  await page.waitFor(`return !!document.querySelector('.transcript') && document.querySelector('.transcript').innerText.includes('Working before the restart.')`, { label: 'the held turn read back after the restart' });
  check(chatStarts(events()).length === 1, 'the restart started no second CLI');
  check(token('restart-parked-token-1.txt') === null, 'the turn is still held');
  writeFileSync(join(work, HOLD), '');
  await page.waitFor(`return document.querySelector('.transcript')?.innerText.includes('First turn done.')`, { label: 'the turn finishing after the restart' });
  await until(() => events().some((e) => e.event === 'result' && e.pid === pid), 'the held process to log the end of its turn');
  check(token('restart-parked-token-1.txt') === '403', `the chat's token still works from the adopted CLI (${token('restart-parked-token-1.txt')})`);
  check(chatStarts(events()).length === 1, 'and still no second CLI, no resume');

  // ---- 2. A permission prompt held across the next restart ----
  const sent = await peer.api.post(`/chats/${id}/messages`, { text: 'PARKED-TWO' });
  check(sent.status === 200 || sent.status === 201, `the second turn is sent (${sent.status})`);
  const prompt = `return !!document.querySelector('.permission .permission-actions .btn-primary')`;
  await page.waitFor(prompt, { label: 'the permission prompt' });
  await away();
  await peer.restart();
  await page.goto(`/chats/${id}`, 800);
  await page.waitFor(prompt, { label: 'the permission prompt asked again after the restart' });
  check(chatStarts(events()).length === 1, 'still the one CLI');
  await page.click('.permission .permission-actions .btn-primary');
  await page.waitFor(`return document.querySelector('.transcript')?.innerText.includes('Second turn done.')`, { label: 'the turn finishing once answered' });
  const answered = events().filter((e) => e.event === 'answered' && e.pid === pid);
  check(answered.length === 1 && answered[0].allowed === true, 'the answer reached the CLI that asked');
  check(token('restart-parked-token-2.txt') === '403', `the token works after a second adoption (${token('restart-parked-token-2.txt')})`);
  check(!(await transcriptText(page)).includes('Claudio restarted while'), 'no restart notice: nothing was cut');

  // ---- 3. Spend, once per turn ----
  const db = new DatabaseSync(join(peer.dirs.dataDir, 'wrapper.db'), { readOnly: true });
  try {
    // The ledger row follows the result by a moment: wait for the second turn's, then count
    await until(() => db.prepare('SELECT COUNT(*) AS n FROM spend_ledger WHERE chat_id = ?').get(id).n >= 2, 'the second turn in the ledger', 10_000).catch(() => {});
    const rows = db.prepare('SELECT usd FROM spend_ledger WHERE chat_id = ?').all(id);
    check(rows.length === 2, `each turn is in the ledger once (${rows.length} rows)`);
    const total = rows.reduce((sum, row) => sum + Number(row.usd), 0);
    check(Math.abs(total - 0.5) < 0.001, `and costs what it cost, not twice (${total})`);
  } finally {
    db.close();
  }
};
