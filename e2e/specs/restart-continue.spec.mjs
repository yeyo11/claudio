// Layer 3 of docs/plans/survive-restarts.md (t1), end to end on the fake CLI, with parking off (the
// default): a turn a restart cut is continued by itself when the cut is younger than an hour, and
// offered with a warn notice and a Resume button when it is older. On a wrapper of its own (a peer)
// that this spec stops and starts, ageing one chat's cut in its database while the server is down.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { chatStarts, fakeLog, killWrapper, until } from './restart-shared.mjs';

export const fakeCli = true;
export const timeout = 240_000;
export const peers = ['cut'];

const HOURS = 3 * 3_600_000;

export default async ({ check, peers: { cut: peer } }) => {
  const work = peer.dirs.workspaceDir;
  writeFileSync(
    peer.fakeCli.scripts,
    JSON.stringify({
      'CUT-RECENT': 'say: Recent work under way.\nhold: restart-continue-never.hold\nsay: never reached',
      'CUT-OLD': 'say: Old work under way.\nhold: restart-continue-never.hold\nsay: never reached',
    }),
  );
  const page = peer.page;
  const events = () => fakeLog(peer.fakeCli.log);

  const start = async (prompt) => {
    const res = await peer.api.post('/chats', { prompt, cwd: work });
    check(res.status === 201, `${prompt} starts (${res.status})`);
    await until(() => events().some((e) => e.event === 'stdin' && String(e.text).includes(prompt)), `${prompt} under way`);
    return res.body.id;
  };
  const recent = await start('CUT-RECENT');
  const old = await start('CUT-OLD');
  check(chatStarts(events()).length === 2, 'two CLI processes, one per chat');

  // Both turns are written down as open before the server goes: the row a restart reads
  const turnsOpen = () => {
    const db = new DatabaseSync(join(peer.dirs.dataDir, 'wrapper.db'), { readOnly: true });
    try {
      return db.prepare('SELECT json FROM executions').all().filter((row) => JSON.parse(String(row.json)).turnOpen === true).length;
    } finally {
      db.close();
    }
  };
  await until(() => turnsOpen() === 2, 'both turns recorded as open');
  // The server dies mid-turn, as in a crash (a graceful stop ends its chats as stopped: see the plan's t8 outcome);
  // while it is down, the second cut becomes three hours old
  check(killWrapper(peer.dirs.dataDir) > 0, 'the wrapper was found and killed');
  peer.stop();
  const db = new DatabaseSync(join(peer.dirs.dataDir, 'wrapper.db'));
  try {
    const then = new Date(Date.now() - HOURS).toISOString();
    const age = (json) => {
      const doc = JSON.parse(json);
      for (const key of ['startedAt', 'endedAt', 'updatedAt']) if (typeof doc[key] === 'string') doc[key] = then;
      return JSON.stringify(doc);
    };
    for (const row of db.prepare('SELECT id, json FROM chats WHERE id = ?').all(old)) db.prepare('UPDATE chats SET json = ? WHERE id = ?').run(age(String(row.json)), row.id);
    for (const row of db.prepare('SELECT id, json FROM executions WHERE chat_id = ?').all(old)) db.prepare('UPDATE executions SET json = ?, started_at = ? WHERE id = ?').run(age(String(row.json)), then, row.id);
  } finally {
    db.close();
  }
  const before = chatStarts(events()).length;
  await peer.start();

  // ---- Cut a minute ago: it goes on by itself, on its own session, with nothing typed ----
  await until(() => chatStarts(events()).length > before && chatStarts(events()).some((e, i) => i >= before && e.argv.includes('--resume') && e.argv.includes(recent)), 'the recent chat to be resumed').catch((error) => {
    throw new Error(`${error.message} DIAG ${JSON.stringify(events().filter((e) => e.event === 'started').map((e) => [e.pid, e.argv.join(' ').slice(0, 300)]))} ${recent}`);
  });
  await page.goto(`/chats/${recent}`, 800);
  await page.waitFor(`return document.querySelector('.transcript')?.innerText.includes('Heard:')`, { label: 'the continued turn answering' });
  check((await page.eval(`return !!document.querySelector('.restart-cut')`)) === false, 'the continued chat shows no restart notice');

  // ---- Cut three hours ago: a warn notice, and nothing started ----
  await page.goto(`/chats/${old}`, 800);
  await page.waitFor(`return !!document.querySelector('.restart-cut')`, { label: 'the restart notice on the old chat' });
  const notice = await page.eval(`const el = document.querySelector('.restart-cut'); return { text: el.innerText.replace(/\\s+/g, ' '), warn: el.classList.contains('alert-warn'), button: el.querySelector('button')?.innerText.trim() }`);
  check(/Claudio restarted while this chat was working/.test(notice.text) && notice.warn && notice.button === 'Resume', `the old cut is offered, as a warn (${JSON.stringify(notice)})`);
  check(!chatStarts(events()).some((e, i) => i >= before && e.argv.includes(old)), 'no process was started for the old cut');

  // Resume works: a process on the same session, and the notice goes
  await page.click('.restart-cut button');
  await until(() => chatStarts(events()).some((e, i) => i >= before && e.argv.includes('--resume') && e.argv.includes(old)), 'the old chat to be resumed');
  await page.waitFor(`return !document.querySelector('.restart-cut') && document.querySelector('.transcript')?.innerText.includes('Heard:')`, { label: 'the resumed turn answering and the notice gone' });
};
