import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import type { RunEvent } from '@claudio/shared';
import { ChatManager, type GuardSubject } from '../src/chats.ts';
import { Db } from '../src/db.ts';
import { writeGuardFiles } from '../src/guards/files.ts';
import { DEFAULT_LIMITS, type GuardRulesFile } from '../src/guards/input.ts';
import type { ChatGuardPlan } from '../src/live-chat.ts';
import { tempConfig } from './helpers.ts';

// A guarded chat against the fake CLI, which runs the real guard program from the `--settings` file
// the way the CLI does: SessionStart before any message, PreToolUse around every tool call.

const FAKE_CLAUDE = fileURLToPath(new URL('./fixtures/fake-claude.mjs', import.meta.url));
const GUARD_ENTRY = fileURLToPath(new URL('../src/guards/main.ts', import.meta.url));

async function until<T>(read: () => T | undefined | null | false, what: string, ms = 15000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = read();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

const ENV = ['FAKE_CLAUDE_NO_ARM', 'FAKE_CLAUDE_INTERRUPTS', 'FAKE_CLAUDE_PROMPTS', 'FAKE_CLAUDE_ARM_DELAY_MS', 'FAKE_CLAUDE_TIMELINE', 'CLAUDIO_GUARD_ARM_MS'];

describe('guarded chats', () => {
  let chats: ChatManager;
  let db: Db;
  let dir: string;
  let plan: ChatGuardPlan;

  beforeEach(() => {
    const config = { ...tempConfig(), claudeBin: FAKE_CLAUDE };
    dir = config.dataDir;
    db = new Db(config);
    chats = new ChatManager(config, db);
    const rules: GuardRulesFile = {
      version: 1,
      mode: 'enforce',
      rules: ['integrity', 'push'],
      roots: [config.workspaceDir],
      mainCheckout: null,
      hooksPathDir: null,
      dataDir: config.dataDir,
      guardDir: join(GUARD_ENTRY, '..'),
      claudeConfigDirs: [],
      protectConfigs: [],
      knownSecretSha256: [],
      limits: { ...DEFAULT_LIMITS },
    };
    const files = writeGuardFiles(config.dataDir, rules, { execPath: process.execPath, entry: GUARD_ENTRY, electron: false, nodeVersion: process.versions.node });
    plan = { rules: rules.rules, mode: 'enforce', settingsPath: files.settingsPath, rulesSha256: files.rulesSha256 };
    process.env.FAKE_CLAUDE_INTERRUPTS = join(dir, 'interrupts');
    process.env.FAKE_CLAUDE_PROMPTS = join(dir, 'prompts');
    process.env.FAKE_CLAUDE_TIMELINE = join(dir, 'timeline');
  });

  afterEach(() => {
    chats.stopAll();
    db.close();
    for (const name of ENV) delete process.env[name];
  });

  const guardEvents = (id: string): NonNullable<RunEvent['guard']>[] => chats.events(id).flatMap((e) => (e.kind === 'guard' && e.guard ? [e.guard] : []));

  it('arms, lets a call through and records the block of another', async () => {
    const heard: unknown[] = [];
    chats.on('chat-guard', (_id: string, guard: unknown) => heard.push(guard));
    const prompt = ['FAKE-TOOL Bash {"command":"ls"}', 'FAKE-TOOL Bash {"command":"git push origin main"}'].join('\n');
    const chat = chats.start({ prompt, name: 'guarded', keepAlive: false, guards: plan });
    await chats.exited(chat.id);
    const events = guardEvents(chat.id);
    assert.equal(events.length, 1, 'a pass says nothing');
    assert.equal(events[0]?.outcome, 'blocked');
    assert.equal(events[0]?.rule, 'push');
    assert.equal(events[0]?.toolName, 'Bash');
    assert.equal(events[0]?.excerpt, 'git push origin main');
    assert.deepEqual(heard, events);
    assert.equal(chats.events(chat.id).find((e) => e.kind === 'result')?.text, 'tools: 2');
    assert.equal(chats.get(chat.id)?.error, null);
  });

  it('holds the first message until the guard has armed', async () => {
    process.env.FAKE_CLAUDE_ARM_DELAY_MS = '600';
    const chat = chats.start({ prompt: 'hello', name: 'guarded', keepAlive: false, guards: plan });
    assert.equal(chats.get(chat.id)?.guards?.state, 'arming');
    await new Promise((r) => setTimeout(r, 300));
    assert.ok(!existsSync(process.env.FAKE_CLAUDE_PROMPTS ?? ''), 'nothing was written to the process yet');
    await until(() => chats.get(chat.id)?.guards?.state === 'armed', 'the guard to arm');
    await chats.exited(chat.id);
    const timeline = readFileSync(process.env.FAKE_CLAUDE_TIMELINE ?? '', 'utf8').trim().split('\n');
    assert.deepEqual(timeline, ['armed', 'message']);
    assert.ok(chats.events(chat.id).some((e) => e.kind === 'message' && e.entry?.role === 'user'), 'the message is in the transcript');
  });

  it('fails the run with guard-unarmed when the guard never arms, before the agent read anything', async () => {
    process.env.FAKE_CLAUDE_NO_ARM = '1';
    process.env.CLAUDIO_GUARD_ARM_MS = '1500';
    const chat = chats.start({ prompt: 'hello', name: 'guarded', keepAlive: false, guards: plan });
    await chats.exited(chat.id);
    const view = chats.get(chat.id);
    assert.equal(view?.status, 'failed');
    assert.match(view?.error ?? '', /^guard-unarmed/);
    assert.ok(!existsSync(process.env.FAKE_CLAUDE_PROMPTS ?? ''), 'the message was never written');
    assert.deepEqual(guardEvents(chat.id).map((g) => g.outcome), ['unarmed']);
    assert.equal(guardEvents(chat.id)[0]?.toolUseId, null);
  });

  it('fails the run when the process ends before it arms', async () => {
    const chat = chats.start({ prompt: 'hello', name: 'guarded', keepAlive: false, guards: plan, model: 'fake-refused' });
    await chats.exited(chat.id);
    assert.match(chats.get(chat.id)?.error ?? '', /^guard-unarmed/);
  });

  it('interrupts a run whose tool call has no guard marker, and ends it failed with guard-missing', async () => {
    const prompt = ['FAKE-TOOL-UNGUARDED Bash {"command":"ls"}', 'FAKE-HANG'].join('\n');
    const chat = chats.start({ prompt, name: 'guarded', keepAlive: true, guards: plan });
    await chats.exited(chat.id);
    const view = chats.get(chat.id);
    assert.equal(view?.status, 'failed');
    assert.match(view?.error ?? '', /^guard-missing/);
    assert.deepEqual(guardEvents(chat.id).map((g) => g.outcome), ['missing']);
    assert.equal(guardEvents(chat.id)[0]?.toolName, 'Bash');
    assert.ok(readFileSync(process.env.FAKE_CLAUDE_INTERRUPTS ?? '', 'utf8').includes('"interrupt"'), 'the interrupt request was sent');
  });

  it("stops a person's chat on a missing marker without an error, and shows it until the next message", async () => {
    const prompt = ['FAKE-TOOL-UNGUARDED Bash {"command":"ls"}', 'FAKE-HANG'].join('\n');
    const chat = chats.start({ prompt, name: 'guarded', keepAlive: true, guards: { ...plan, interactive: true } });
    await chats.exited(chat.id);
    const view = chats.get(chat.id);
    assert.equal(view?.status, 'stopped');
    assert.equal(view?.guards?.state, 'missing');
    assert.ok(chats.events(chat.id).some((e) => e.kind === 'notice' && /Guards not running/.test(e.text ?? '')));
    // Nothing was sent again by itself: one process, one prompt
    assert.equal(readFileSync(process.env.FAKE_CLAUDE_PROMPTS ?? '', 'utf8').trim().split('\n').length, 1);
  });

  it("shows nothing of the hooks that are the person's own", async () => {
    const chat = chats.start({ prompt: 'FAKE-FOREIGN-HOOK', name: 'guarded', keepAlive: false, guards: plan });
    await chats.exited(chat.id);
    assert.deepEqual(guardEvents(chat.id), []);
    assert.ok(!chats.events(chat.id).some((e) => e.kind === 'other' || e.kind === 'stderr' || e.kind === 'notice'));
  });

  it('derives the plan again at a spawn nobody handed one to: a switch turned off reaches the next process (D6)', async () => {
    const asked: GuardSubject[] = [];
    let next: ChatGuardPlan | null = null;
    chats.guardPlanner = (subject) => {
      asked.push(subject);
      return next;
    };
    const chat = chats.start({ prompt: 'hello', name: 'guarded', keepAlive: false, guards: plan });
    assert.equal(chats.get(chat.id)?.guards?.state, 'arming');
    await chats.exited(chat.id);
    assert.equal(asked.length, 0, 'the plan its starter derived stands for the first process');

    // Every rule went off meanwhile: the process the next message starts runs with no guard
    chats.send(chat.id, 'again');
    assert.equal(asked.length, 1);
    assert.equal(asked[0]?.plan?.settingsPath, plan.settingsPath, 'asked with the plan the last process had');
    assert.equal(asked[0]?.person, true);
    assert.equal(chats.get(chat.id)?.guards, undefined);
    await chats.exited(chat.id);
    assert.equal(chats.get(chat.id)?.status, 'completed');

    // And on again: the next process arms before it reads a word
    next = plan;
    chats.send(chat.id, 'once more');
    assert.equal(chats.get(chat.id)?.guards?.state, 'arming');
    await chats.exited(chat.id);
    assert.equal(asked.length, 2);
  });

  it("a plan the caller hands over stands, null included, and is not derived again", async () => {
    let asked = 0;
    chats.guardPlanner = () => {
      asked += 1;
      return plan;
    };
    const chat = chats.start({ prompt: 'hello', name: 'plain', keepAlive: false });
    await chats.exited(chat.id);
    chats.resume(chat.id, { prompt: 'again', guards: null });
    assert.equal(asked, 0);
    assert.equal(chats.get(chat.id)?.guards, undefined);
    await chats.exited(chat.id);
  });

  it('housekeeping is never guarded, whatever it is handed', async () => {
    chats.guardPlanner = () => plan;
    const chat = chats.start({ prompt: 'hello', name: 'supervisor', keepAlive: false, internal: true, guards: plan });
    assert.equal(chats.get(chat.id)?.guards, undefined);
    await chats.exited(chat.id);
    assert.equal(chats.get(chat.id)?.status, 'completed');
  });

  it('names the files of every plan it holds, for the sweep of the guard folder', () => {
    const chat = chats.start({ prompt: 'hello', name: 'guarded', keepAlive: false, guards: plan });
    const files = chats.liveGuardFiles();
    assert.ok(files.includes(plan.settingsPath));
    assert.ok(files.some((file) => file.endsWith(`${plan.rulesSha256.slice(0, 16)}.rules.json`) && existsSync(file)), files.join(' '));
    assert.ok(chats.get(chat.id));
  });

  it('does not wait for a guard on a chat that has none', async () => {
    const chat = chats.start({ prompt: 'hello', name: 'plain', keepAlive: false });
    assert.equal(chats.get(chat.id)?.guards, undefined);
    await chats.exited(chat.id);
    assert.equal(chats.get(chat.id)?.status, 'completed');
  });
});
