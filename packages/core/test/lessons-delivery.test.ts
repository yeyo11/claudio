import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { Core } from '../src/index.ts';
import { LessonStore } from '../src/lessons/store.ts';
import { tempConfig } from './helpers.ts';

// Lessons reach a chat per spawn, through the real core and the fake CLI.

const FAKE_CLAUDE = fileURLToPath(new URL('./fixtures/fake-claude.mjs', import.meta.url));
process.env.FAKE_CLAUDE_LOGGED_IN = '1';

function setup() {
  const config = { ...tempConfig(), claudeBin: FAKE_CLAUDE };
  mkdirSync(config.dataDir, { recursive: true });
  const spawns = join(config.dataDir, 'spawns.log');
  process.env.FAKE_CLAUDE_SPAWNS = spawns;
  return { config, spawns };
}

const spawnsOf = (file: string): string[] =>
  existsSync(file) ? readFileSync(file, 'utf8').split(/\n(?=\d+ )/).filter((l) => l.trim() && !/^\d+ (agents|--version|auth)/.test(l)) : [];

async function spawned(file: string, id: string): Promise<string> {
  for (let i = 0; i < 400; i++) {
    const found = spawnsOf(file).filter((l) => l.includes(id)).at(-1);
    if (found) return found;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error('timed out waiting for the spawn');
}

type Held = { chats: Map<string, { opts: Record<string, unknown>; record(): unknown }> };
const optsOf = (core: Core, id: string): Record<string, unknown> | undefined => (core.runtime as unknown as Held).chats.get(id)?.opts;

async function world(modules: ('board' | 'memory')[]) {
  const { config, spawns } = setup();
  const core = new Core(config);
  const dir = mkdtempSync(join(tmpdir(), 'claudio-lessons-delivery-'));
  const project = await core.importProject({ path: dir, name: 'pagos-api', template: 'software', modules });
  const store = new LessonStore({ db: core.db });
  const lesson = (projectId: string | null, action: string) =>
    store.approve(
      store.insert({
        projectId,
        trigger: 'When adding a dependency',
        action,
        confidence: 0.9,
        proposedBy: { kind: 'system', role: null },
        evidence: [{ signal: 'correction', quote: 'no', context: 'x', chatId: null, entryUuid: null, at: new Date().toISOString() }],
      }).id,
    );
  const done = (): void => {
    delete process.env.FAKE_CLAUDE_SPAWNS;
    core.shutdown();
    rmSync(dir, { recursive: true, force: true });
  };
  return { core, config, dir, project, spawns, lesson, done };
}

test('an interactive chat in the project gets the section on every spawn, and never stores it', async () => {
  const { core, dir, spawns, lesson, done } = await world(['memory']);
  try {
    lesson(null, 'prefer pnpm everywhere.');
    const first = await core.chats.create({ prompt: 'hello', cwd: dir, appendSystemPrompt: 'THE PERSONS OWN TEXT' });
    const argv = await spawned(spawns, first.id);
    assert.match(argv, /THE PERSONS OWN TEXT\n\n## Lessons/);
    assert.match(argv, /L-\d+ · global · 0\.90 · When adding a dependency: prefer pnpm everywhere\./);
    // What the chat keeps is the person's text alone
    assert.equal(optsOf(core, first.id)?.appendSystemPrompt, 'THE PERSONS OWN TEXT');
    assert.equal(JSON.stringify((core.runtime as unknown as Held).chats.get(first.id)?.record()).includes('Lessons'), false);
  } finally {
    done();
  }
});

test('a flow run carries its lessons once, in the handoff', async () => {
  const { core, dir, spawns, lesson, done } = await world(['memory']);
  try {
    lesson(null, 'prefer pnpm everywhere.');
    const handoff = `HANDOFF\n${core.lessons.section(null).text}`;
    const run = core.runtime.start({ prompt: 'work', cwd: dir, appendSystemPrompt: handoff, lessons: 'handoff' });
    const argv = await spawned(spawns, run.id);
    assert.equal(argv.split('## Lessons').length - 1, 1);
  } finally {
    done();
  }
});

test('internal, confined and assistant chats get none', async () => {
  const { core, dir, spawns, lesson, done } = await world(['memory']);
  try {
    lesson(null, 'prefer pnpm everywhere.');
    const internal = core.runtime.start({ prompt: 'title', cwd: dir, internal: true });
    const confined = core.runtime.start({ prompt: 'read', cwd: dir, confine: { tools: [], settingSources: [] } });
    for (const id of [internal.id, confined.id]) assert.ok(!(await spawned(spawns, id)).includes('## Lessons'), id);
    core.runtime.apiUrl = 'http://127.0.0.1:34331/api';
    const assistant = await core.startClaudioAssistantChat({ prompt: 'hi' });
    assert.ok(!(await spawned(spawns, assistant.id)).includes('## Lessons'));
  } finally {
    done();
  }
});

test('a project without the Memory module gets none', async () => {
  const { core, dir, spawns, lesson, done } = await world(['board']);
  try {
    lesson(null, 'prefer pnpm everywhere.');
    const chat = await core.chats.create({ prompt: 'hello', cwd: dir });
    assert.ok(!(await spawned(spawns, chat.id)).includes('## Lessons'));
  } finally {
    done();
  }
});

test('a chat outside any project gets global lessons only, and a worker the same section as a chat', async () => {
  const { core, config, spawns, lesson, project, done } = await world(['memory']);
  try {
    lesson(null, 'global rule.');
    lesson(project.id, 'project rule.');
    const loose = await core.chats.create({ prompt: 'hello', cwd: config.workspaceDir });
    const argv = await spawned(spawns, loose.id);
    assert.match(argv, /global rule\./);
    assert.ok(!argv.includes('project rule.'));
    const hook = core.runtime.lessonsFor;
    assert.equal(hook?.(project.id, true), hook?.(project.id, false));
    assert.match(hook?.(project.id, true) ?? '', /project rule\./);
    assert.match(hook?.(project.id, true) ?? '', /global rule\./);
  } finally {
    done();
  }
});

test('the section is cached for a project and dropped when lessons change', async () => {
  const { core, project, lesson, done } = await world(['memory']);
  try {
    const before = core.lessons.section(project.id);
    assert.equal(before.text, '');
    lesson(project.id, 'project rule.');
    assert.equal(core.lessons.section(project.id), before);
    core.lessons.invalidate();
    assert.match(core.lessons.section(project.id).text, /project rule\./);
  } finally {
    done();
  }
});
