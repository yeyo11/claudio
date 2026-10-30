import assert from 'node:assert/strict';
import test from 'node:test';

Object.defineProperty(globalThis, 'navigator', { value: { languages: ['en-US'] }, configurable: true });
// The helper reads the global i18next, which the app's instance sets up
const { default: i18n } = await import('i18next');
await import('../src/i18n/index.ts');
const { describeWrite } = await import('@claudio/chat-ui/lib/write-prompts');

const P = 'mcp__claudio__';
// packages/mcp/src/write-tools.ts
const WRITE_TOOLS = [
  'create_work_item',
  'update_work_item',
  'check_criterion',
  'move_work_item',
  'comment_work_item',
  'retry_flow_run',
  'plan_orchestration',
  'launch_orchestration',
  'stop_orchestration',
  'resume_orchestration',
  'retry_orchestration_task',
  'start_chat',
  'send_chat_message',
  'hint_chat',
  'interrupt_chat',
  'stop_chat',
  'resume_chat',
  'fork_chat',
  'accept_assistant_proposal',
  'discard_assistant_proposal',
];

test('every write tool has a title in the person’s words', async () => {
  for (const language of ['en', 'es']) {
    await i18n.changeLanguage(language);
    for (const name of WRITE_TOOLS) {
      const prompt = describeWrite(`${P}${name}`, {});
      assert.ok(prompt, name);
      assert.doesNotMatch(prompt.title, /_|mcp__|\{\{/, `${language} ${name}`);
    }
  }
  await i18n.changeLanguage('en');
});

test('titles and details come from the input', async () => {
  await i18n.changeLanguage('en');
  assert.equal(describeWrite(`${P}move_work_item`, { item: 'cw-12', status: 'in_review' })?.title, 'Move CW-12 to In review');
  const create = describeWrite(`${P}create_work_item`, { projectId: 'p1', title: 'Fix login', priority: 'high', description: 'Why it fails' });
  assert.equal(create?.title, 'Create task: Fix login');
  assert.equal(create?.detail, 'Why it fails\nPriority: high');
  assert.equal(describeWrite(`${P}comment_work_item`, { item: 'CW-3', body: 'Looks done' })?.detail, 'Looks done');
  assert.equal(describeWrite(`${P}update_work_item`, { item: 'abc123', title: 'New' })?.title, 'Change a work item');
});

test('the orchestration and chat tools say what they start or stop, and carry the text they send', async () => {
  await i18n.changeLanguage('en');
  const launch = describeWrite(`${P}launch_orchestration`, { name: 'Checkout split', objective: 'Split it', tasks: [{ id: 'a', name: 'Totals', prompt: 'p' }, { id: 'b', name: 'Taxes', prompt: 'p' }] });
  assert.equal(launch?.title, 'Launch the orchestration Checkout split');
  assert.equal(launch?.detail, 'Split it\nTasks: Totals · Taxes');
  assert.equal(describeWrite(`${P}launch_orchestration`, { fromPlan: 'chat-1' })?.title, 'Launch the planned orchestration');
  assert.equal(describeWrite(`${P}check_criterion`, { item: 'cw-4', criterionId: 'x', checked: false })?.title, 'Uncheck an acceptance criterion of CW-4');
  assert.equal(describeWrite(`${P}hint_chat`, { chatId: 'c1', text: 'Look at the logs' })?.detail, 'Look at the logs');
  await i18n.changeLanguage('es');
  try {
    assert.equal(describeWrite(`${P}fork_chat`, { chatId: 'c1', prompt: 'otra vía' })?.title, 'Crear un fork de un chat');
    assert.equal(describeWrite(`${P}stop_orchestration`, { orchestrationId: 'o1' })?.title, 'Detener una orquestación');
  } finally {
    await i18n.changeLanguage('en');
  }
});

test('Spanish says the same in Spanish, with no wire names', async () => {
  await i18n.changeLanguage('es');
  try {
    assert.equal(describeWrite(`${P}move_work_item`, { item: 'CW-12', status: 'in_review' })?.title, 'Mover CW-12 a En revisión');
    assert.equal(describeWrite(`${P}create_work_item`, { title: 'Arreglar', type: 'bug' })?.title, 'Crear bug: Arreglar');
    const shown = JSON.stringify(describeWrite(`${P}create_work_item`, { title: 'x', status: 'in_progress', priority: 'urgent' }));
    assert.doesNotMatch(shown, /in_progress|urgent\b|projectId/);
  } finally {
    await i18n.changeLanguage('en');
  }
});

test('other tools keep their prompt', () => {
  assert.equal(describeWrite('Bash', { command: 'ls' }), null);
  assert.equal(describeWrite(`${P}list_projects`, {}), null);
});
