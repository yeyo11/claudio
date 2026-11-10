// The long data overflow.spec.mjs walks the app with (docs/plans/agent-messages.md, "Overflow across
// the app"): a chat whose transcript has a long Spanish prompt, prose with an unbroken token, a write
// outside its directory and outside /tmp (the risk tag that ran out of its step card) whose lines are far wider than
// any pane, an edit inside it and a long Bash command; a project and a task with long names; and an
// orchestration whose name, objective and task names are long. Everything goes through the API or
// the CLI's own files, and `cleanup` removes it again, because other specs count what the sandbox holds.
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

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

function transcript(cwd, outside) {
  const base = { cwd, version: '2.1.319', sessionId: SESSION };
  const at = (s) => new Date(Date.now() - 900_000 + s * 1000).toISOString();
  let n = 0;
  const entry = (type, message, extra = {}, s = n) => JSON.stringify({ ...base, ...extra, uuid: `ovf-${++n}`, timestamp: at(s), type, message });
  const assistant = (content) => entry('assistant', { role: 'assistant', id: `msg-ovf-${n}`, model: 'claude-sonnet-5', content, usage: { input_tokens: 10, output_tokens: 10 } });
  const result = (id, toolUseResult, content = 'ok') => entry('user', { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content }] }, { toolUseResult });
  const memory = ['---', 'name: project-message-subagents-via-mod', LONG_LINE, 'metadata:', '  node_type: memory', '---', '', `**How to apply:** Claudio would ship a small mod loaded with \`--plugin-dir\`, fed by Claudio's API (\`$.http.fetch\` polling or \`$.process.spawn\` streaming), and ${UNBROKEN}`, ''].join('\n');
  const inside = join(cwd, 'packages/frontend/src/screens/settings/decisions/DecisionsScreenWithAVeryLongName.tsx');
  return [
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
  ].join('\n');
}

/**
 * Seeds the chat, the project, its task and an orchestration. `workspaceDir` is where the chat and
 * the project live; the write's path lies outside the chat's directory, as in the report.
 */
export async function seedOverflow({ api, configDir, workspaceDir }) {
  const cwd = join(workspaceDir, 'e2e-overflow-un-proyecto-con-un-nombre-bastante-largo');
  mkdirSync(cwd, { recursive: true });
  // Never written: the step comes from the transcript. Outside /tmp, which counts as scratch space
  const outside = '/srv/e2e-overflow/.config/Claudio/data/accounts/acc-a6b913cd/projects/-home-yeyo-Escritorio-claudio/memory/project-message-subagents-via-mod.md';
  const dir = join(configDir, 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${SESSION}.jsonl`), `${transcript(cwd, outside)}\n`);

  const seeded = { cwd, dir, projectId: null, taskId: null, orchestrationId: null, orchestrationChats: [] };
  const project = await api.post('/projects/import', { path: cwd, name: 'Un proyecto cuyo nombre es lo bastante largo como para necesitar su elipsis en todas partes', template: 'software' });
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
    cwd,
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
}
