// What the two restart specs share (docs/plans/survive-restarts.md, t8). Each runs on a wrapper of its
// own (a `peer`: its data directory, its port and its fake CLI), because a spec cannot restart the
// suite's server, which every other spec in its shard is using.
import { readdirSync, readFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';

/** Polls until `condition` answers something truthy; the spec's own wait, so a failure says what it waited for */
export async function until(condition, label, ms = 30_000) {
  const end = Date.now() + ms;
  for (;;) {
    const value = await condition();
    if (value) return value;
    if (Date.now() > end) throw new Error(`timed out waiting for: ${label}`);
    await sleep(150);
  }
}

/** The fake CLI's log, one parsed event per line; nothing before the first process starts */
export function fakeLog(path) {
  try {
    return readFileSync(path, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

/** The chat processes the fake started: the ones on a session, not `auth status` or the canary a server runs when it starts */
export const chatStarts = (events) => events.filter((e) => e.event === 'started' && Array.isArray(e.argv) && (e.argv.includes('--session-id') || e.argv.includes('--resume')));

/** What the page's transcript says now */
export const transcriptText = (page) => page.eval(`return document.querySelector('.transcript')?.innerText ?? ''`);

/**
 * Kills, without a signal it can handle, every process of one wrapper: those whose environment names
 * its data directory, which is the server (and `pnpm` and `tsx` above it) and the CLIs it started. A
 * crash, an out-of-memory kill or a power cut, which is the cut layer 3 answers: a server told to stop
 * ends its chats as stopped on its way out, so there is nothing left to continue.
 * Found by what each process was given, never by a name (another run's wrapper has its own directory).
 */
export function killWrapper(dataDir) {
  const mark = `CLAUDIO_DATA_DIR=${dataDir}`;
  let killed = 0;
  for (const entry of readdirSync('/proc')) {
    if (!/^\d+$/.test(entry) || Number(entry) === process.pid) continue;
    try {
      if (!readFileSync(`/proc/${entry}/environ`, 'utf8').split('\0').includes(mark)) continue;
      process.kill(Number(entry), 'SIGKILL');
      killed++;
    } catch {
      // it exited while we looked, or is not ours to read
    }
  }
  return killed;
}
