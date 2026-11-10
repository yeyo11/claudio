import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * The `claudio-bridge` mod (docs/agent-messages.md, D1 of docs/plans/agent-messages.md): the only way
 * Claude Code documents for a program to write to one subagent is a mod calling
 * `$.session.send({ to: { agentId }, text })`. Claudio writes this mod under its data dir and loads
 * it with `--plugin-dir` into every run that holds a chat token. The mod only carries: it polls the
 * chat's own `bridge/next`, sends each message, and reports what the CLI answered. Claudio keeps the
 * queue (`agent-messages.ts`).
 *
 * The name is what the CLI records as `origin.plugin` on the line the subagent receives, so it is
 * part of the transcript contract and never changes.
 */
export const BRIDGE_MOD_NAME = 'claudio-bridge';
/** Bumped with any change of the files below, so a reader of `plugin.json` knows which one it has */
export const BRIDGE_MOD_VERSION = '1.1.0';
/**
 * How long one poll asks the server to hold it: never. The CLI waits for a mod's `$.http.fetch` in
 * flight before its process exits, and `$.http.fetch` takes no abort signal, so a long poll held
 * every run's exit for up to its wait, long enough for a re-run to find the old process still up.
 */
export const BRIDGE_POLL_WAIT_S = 0;
/** The pause between two polls that found nothing: what a message waits at most before it is carried */
export const BRIDGE_POLL_IDLE_MS = 1000;

const PLUGIN_JSON = `${JSON.stringify(
  {
    name: BRIDGE_MOD_NAME,
    version: BRIDGE_MOD_VERSION,
    description: "Claudio's bridge: delivers the messages a person or Claudio writes to one subagent of this chat",
  },
  null,
  2,
)}\n`;

const HOOKS_JSON = `${JSON.stringify({ modules: ['./register.js'] }, null, 2)}\n`;

/*
 * Plain ES module for the mods runtime: no Node API and no timer globals, only `$`. It never logs
 * the token or a message's text. The loop never overlaps itself: the next poll is scheduled only
 * once the previous one and its sends are done, and the timers stop when the module unloads.
 */
const REGISTER_JS = `// ${BRIDGE_MOD_NAME} ${BRIDGE_MOD_VERSION}, written by Claudio (docs/agent-messages.md). Do not edit: Claudio rewrites it.
const WAIT_S = ${BRIDGE_POLL_WAIT_S}
const IDLE_MS = ${BRIDGE_POLL_IDLE_MS}
const BACKOFF_MS = [1000, 2000, 5000, 10000]
let started = false

export function register(on) {
  on('session.start', async ($, e, next) => {
    if (!started) {
      const url = await $.env.get('CLAUDIO_API_URL')
      const chat = await $.env.get('CLAUDIO_CHAT_ID')
      const token = await $.env.get('CLAUDIO_API_TOKEN')
      if (url && chat && token) {
        started = true
        carry($, String(url).replace(/\\/+$/, ''), String(chat), String(token))
      }
    }
    return next(e)
  })
}

function carry($, url, chat, token) {
  const base = url + '/chats/' + encodeURIComponent(chat) + '/bridge'
  const headers = { authorization: 'Bearer ' + token, accept: 'application/json', 'content-type': 'application/json' }
  let failures = 0
  const again = (ms) => { $.clock.after(ms, tick) }
  async function tick() {
    let messages
    try {
      const res = await $.http.fetch(base + '/next?wait=' + WAIT_S, { method: 'GET', headers })
      if (!res.ok) throw new Error('bridge/next answered ' + res.status)
      messages = JSON.parse(res.text).messages
      if (!Array.isArray(messages)) throw new Error('bridge/next answered no list')
    } catch {
      again(BACKOFF_MS[Math.min(failures, BACKOFF_MS.length - 1)])
      failures++
      return
    }
    failures = 0
    if (messages.length === 0) {
      again(IDLE_MS)
      return
    }
    for (const m of messages) {
      let sent
      try {
        sent = await $.session.send({ to: { agentId: String(m.agentId) }, text: String(m.text) })
      } catch (err) {
        sent = { isDelivered: false, reason: err && err.message ? String(err.message) : 'the send was refused' }
      }
      const report = sent && sent.isDelivered === true ? { isDelivered: true } : { isDelivered: false, reason: String((sent && sent.reason) || 'not delivered') }
      try {
        await $.http.fetch(base + '/' + encodeURIComponent(String(m.id)), { method: 'POST', headers, body: JSON.stringify(report) })
      } catch {
        // Claudio settles a message it never hears about when the chat's process ends
      }
    }
    again(0)
  }
  again(0)
}
`;

/** The files of the mod, by path relative to its directory */
export const BRIDGE_MOD_FILES: Readonly<Record<string, string>> = {
  '.claude-plugin/plugin.json': PLUGIN_JSON,
  'hooks/hooks.json': HOOKS_JSON,
  'hooks/register.js': REGISTER_JS,
};

/** Where the mod lives under a data dir: the directory `--plugin-dir` names */
export function bridgeModDir(dataDir: string): string {
  return join(dataDir, 'claude-plugins', BRIDGE_MOD_NAME);
}

/**
 * Writes the mod's files where they differ from what is on disk, and answers its directory. Called
 * at every spawn that loads it, so an upgrade of Claudio rewrites an older copy, and a person who
 * edited it gets it back; a file already right is left untouched, so a CLI reading it is not raced.
 */
export function writeBridgeMod(dataDir: string): string {
  const dir = bridgeModDir(dataDir);
  for (const [path, body] of Object.entries(BRIDGE_MOD_FILES)) {
    const file = join(dir, path);
    let current: string | null = null;
    try {
      current = readFileSync(file, 'utf8');
    } catch {
      current = null;
    }
    if (current === body) continue;
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    writeFileSync(file, body, { mode: 0o600 });
  }
  return dir;
}
