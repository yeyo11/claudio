// The long data overflow.spec.mjs walks the app with (docs/plans/agent-messages.md, "Overflow across
// the app"): a chat whose transcript has a long Spanish prompt, prose with an unbroken token, a write
// outside its directory and outside /tmp (the risk tag that ran out of its step card) whose lines are
// far wider than any pane, an edit inside it and a long Bash command, all in a worktree of a repository
// so the Changes page has its Result lens too, and two models with figures of nine digits for the side
// panel's cost table; a project and a task with long names; and an
// orchestration whose name, objective and task names are long. Everything goes through the API, git
// or the CLI's own files, and `cleanup` removes it again, because other specs count what the sandbox
// holds.
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export const SESSION = 'e2e-overflow-0000-0000-000000000000';

/** A token with no break in it: what a path, an id or a key looks like to the line breaker */
export const UNBROKEN = 'acc-a6b913cd-projects-home-yeyo-Escritorio-claudio-memory-project-message-subagents-via-mod-0123456789';
const PROMPT =
  'Necesitamos mejorar la interfaz para los mensajes enviados desde el agente principal a sus subagentes y viceversa. Además actualmente no se puede enviar mensajes desde la vista de subagentes (es solo lectura): ' +
  UNBROKEN;
const SENTENCE =
  'Confirmado: el subagente lo leyó y lo citó en su informe. Miro cómo queda registrado en el fichero del subagente, que es lo que Claudio tendría que pintar.';
const LONG_LINE =
  'description: "Writing to one subagent from Claudio is viable through a Claude Code mod\'s documented $.session.send({to:{agentId}}); spike passed 2026-11-10 with the installed CLI, haiku, and a bridge that polls the API for what to deliver next"';

export const SCREEN = 'packages/frontend/src/screens/settings/decisions/DecisionsScreenWithAVeryLongName.tsx';
export const LONG_FILE = 'packages/frontend/src/screens/settings/decisions/long-generated-table.ts';
const BRANCH = 'feature/mensajes-entre-agentes-y-desbordamientos-en-toda-la-aplicacion';
const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=e2e', '-c', 'user.email=e2e@example.com', '-c', 'commit.gpgsign=false', ...args], { cwd, stdio: 'pipe' }).toString();
const put = (root, file, text) => {
  mkdirSync(dirname(join(root, file)), { recursive: true });
  writeFileSync(join(root, file), text);
};

/**
 * A repository and a worktree of it on a long branch name, so the Changes page has its Result lens:
 * the screen's long line, and a new file of more lines than DiffView draws without virtual rows.
 */
function seedRepo(main, tree) {
  mkdirSync(main, { recursive: true });
  git(main, 'init', '-q', '-b', 'main');
  put(main, SCREEN, ['export function DecisionsScreen() {', `  return render('${UNBROKEN}');`, '}', ''].join('\n'));
  git(main, 'add', '.');
  git(main, 'commit', '-q', '-m', 'initial commit');
  git(main, 'worktree', 'add', '-q', '-b', BRANCH, tree);
  put(tree, SCREEN, ['export function DecisionsScreen() {', `  return render('${UNBROKEN}', { summary: '${LONG_LINE.replace(/'/g, '')}' });`, '}', ''].join('\n'));
  const rows = Array.from({ length: 450 }, (_, i) => `export const row${i} = '${i % 7 === 0 ? LONG_LINE.replace(/'/g, '') : `row ${i}`}';`);
  put(tree, LONG_FILE, `${rows.join('\n')}\n`);
  git(tree, 'add', '.');
  git(tree, 'commit', '-q', '-m', 'a long line and a long file');
}

function transcript(cwd, outside, main) {
  const base = { cwd, version: '2.1.319', sessionId: SESSION };
  const at = (s) => new Date(Date.now() - 900_000 + s * 1000).toISOString();
  let n = 0;
  const entry = (type, message, extra = {}, s = n) => JSON.stringify({ ...base, ...extra, uuid: `ovf-${++n}`, timestamp: at(s), type, message });
  const assistant = (content, model = 'claude-sonnet-5', usage = { input_tokens: 10, output_tokens: 10 }) => entry('assistant', { role: 'assistant', id: `msg-ovf-${n}`, model, content, usage });
  const result = (id, toolUseResult, content = 'ok') => entry('user', { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content }] }, { toolUseResult });
  const memory = ['---', 'name: project-message-subagents-via-mod', LONG_LINE, 'metadata:', '  node_type: memory', '---', '', `**How to apply:** Claudio would ship a small mod loaded with \`--plugin-dir\`, fed by Claudio's API (\`$.http.fetch\` polling or \`$.process.spawn\` streaming), and ${UNBROKEN}`, ''].join('\n');
  const inside = join(cwd, SCREEN);
  return [
    JSON.stringify({ type: 'worktree-state', worktreeSession: { worktreePath: cwd, originalCwd: main, worktreeName: 'mensajes-entre-agentes', worktreeBranch: BRANCH } }),
    entry('user', { role: 'user', content: PROMPT }),
    assistant([{ type: 'text', text: `${SENTENCE} La ruta es ${outside} y el token ${UNBROKEN}.` }]),
    assistant([{ type: 'tool_use', id: 'ovf-write', name: 'Write', input: { file_path: outside, content: memory } }]),
    result('ovf-write', { type: 'create', filePath: outside, content: memory, structuredPatch: [] }),
    assistant([{ type: 'text', text: 'Ahora la pantalla de decisiones, con una línea que no cabe en ningún panel.' }]),
    assistant([{ type: 'tool_use', id: 'ovf-edit', name: 'Edit', input: { file_path: inside, old_string: 'a', new_string: 'b' } }]),
    result('ovf-edit', {
      filePath: inside,
      structuredPatch: [{ oldStart: 1, oldLines: 2, newStart: 1, newLines: 2, lines: [' export function DecisionsScreen() {', `-  return render('${UNBROKEN}');`, `+  return render('${UNBROKEN}', { summary: '${LONG_LINE.replace(/'/g, '')}' });`, ' }'] }],
    }),
    assistant([{ type: 'tool_use', id: 'ovf-bash', name: 'Bash', input: { command: `grep -rn "${UNBROKEN}" ${outside} packages/frontend/src/screens/settings/decisions --include='*.tsx' | head -n 200`, description: 'Busca el token en todos los ficheros de la pantalla de decisiones y en la memoria del proyecto' } }]),
    result('ovf-bash', { stdout: `${outside}:7:${UNBROKEN}`, stderr: '', interrupted: false }, `${outside}:7:${UNBROKEN}`),
    assistant([{ type: 'text', text: `Listo. ${SENTENCE}` }]),
    // A long session's totals, as a chat that ran for days reports them: the side panel's cost table
    // gets figures of nine digits for two models, whose ids are long as well (the owner's report)
    assistant([{ type: 'text', text: 'Sigo con el resto de la auditoría.' }], 'claude-opus-5-5', { input_tokens: 5_300, output_tokens: 1_500_000, cache_read_input_tokens: 1_281_000_000, cache_creation_input_tokens: 2_000_000 }),
    assistant([{ type: 'text', text: 'Y lo que queda por revisar.' }], 'claude-sonnet-5-5', { input_tokens: 174, output_tokens: 48_700, cache_read_input_tokens: 10_000_000 }),
  ].join('\n');
}

/**
 * Seeds the chat, the project, its task and an orchestration. `workspaceDir` is where the chat and
 * the project live; the write's path lies outside the chat's directory, as in the report.
 */
export async function seedOverflow({ api, configDir, workspaceDir }) {
  const main = join(workspaceDir, 'e2e-overflow-un-proyecto-con-un-nombre-bastante-largo');
  // The chat works in a worktree of the project's repository
  const cwd = `${main}-arbol`;
  seedRepo(main, cwd);
  // Never written: the step comes from the transcript. Outside /tmp, which counts as scratch space
  const outside = '/srv/e2e-overflow/.config/Claudio/data/accounts/acc-a6b913cd/projects/-home-yeyo-Escritorio-claudio/memory/project-message-subagents-via-mod.md';
  const dir = join(configDir, 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${SESSION}.jsonl`), `${transcript(cwd, outside, main)}\n`);

  const seeded = { main, cwd, dir, projectId: null, taskId: null, orchestrationId: null, orchestrationChats: [] };
  const project = await api.post('/projects/import', { path: main, name: 'Un proyecto cuyo nombre es lo bastante largo como para necesitar su elipsis en todas partes', template: 'software' });
  seeded.projectId = project.body?.id ?? null;
  if (seeded.projectId) {
    const task = await api.post(`/projects/${seeded.projectId}/work-items`, { title: `Una tarea cuyo título es lo bastante largo como para partirse en una tarjeta estrecha ${UNBROKEN}` });
    seeded.taskId = task.body?.id ?? null;
  }
  // Nothing is signed in inside the sandbox: the first task fails and the graph waits, which is a
  // board, a detail and a drawer with real rows to draw
  const orchestration = await api.post('/orchestrations', {
    name: `Mensajes entre agentes, compositor de subagentes y mensajes del sistema ${UNBROKEN}`,
    objective: `${PROMPT} ${SENTENCE}`,
    cwd: main,
    maxAttempts: 1,
    tasks: [
      { id: 'contract', name: 'Contrato: origen, líneas del coordinador y mensajes del sistema con un nombre largo', prompt: PROMPT },
      { id: 'overflow', name: `Desbordamientos en toda la aplicación ${UNBROKEN}`, prompt: SENTENCE, dependsOn: ['contract'] },
    ],
  });
  seeded.orchestrationId = orchestration.body?.id ?? null;
  return seeded;
}

/** Waits (bounded) until the orchestration leaves `running`, collecting its chats for the cleanup */
export async function settleOrchestration({ api, seeded, sleep, tries = 60 }) {
  if (!seeded.orchestrationId) return;
  for (let i = 0; i < tries; i++) {
    const state = (await api.get(`/orchestrations/${seeded.orchestrationId}`)).body;
    for (const task of state?.tasks ?? []) if (task.sessionId && !seeded.orchestrationChats.includes(task.sessionId)) seeded.orchestrationChats.push(task.sessionId);
    if (state && state.status !== 'running') return;
    await sleep(500);
  }
}

export async function cleanupOverflow({ api, seeded }) {
  if (!seeded) return;
  if (seeded.orchestrationId) {
    // A graph that waits for a decision is not deleted until it is stopped
    await api.post(`/orchestrations/${seeded.orchestrationId}/stop`).catch(() => {});
    await api.del(`/orchestrations/${seeded.orchestrationId}`).catch(() => {});
  }
  for (const id of seeded.orchestrationChats) await api.del(`/chats/${id}`).catch(() => {});
  if (seeded.taskId) await api.del(`/work-items/${seeded.taskId}`).catch(() => {});
  if (seeded.projectId) await api.del(`/projects/${seeded.projectId}`).catch(() => {});
  rmSync(seeded.dir, { recursive: true, force: true });
  rmSync(seeded.cwd, { recursive: true, force: true });
  rmSync(seeded.main, { recursive: true, force: true });
}
