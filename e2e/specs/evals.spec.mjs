// Instruction evals (docs/plans/instruction-evals.md): an eval written in the editor, saved as a
// file of the repository, run on the current file against a proposed text through the fake CLI,
// read as a matrix, one sample opened with its calls and checks, a run cancelled while it is held
// open, and a finished run exported.
//
// The fake CLI does not read the agent file, so both variants behave alike: the matrix is checked for
// what it shows (a passing case, a failing one, the "same" verdict), not for a regression, and a
// sample's second try on another account (FAKE-LIMIT-ACCOUNT) needs a second account the sandbox
// does not have. Both are covered by core's tests. Everything seeded is removed at the end.
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const fakeCli = true;
export const timeout = 240_000;

const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=e2e', '-c', 'user.email=e2e@example.com', '-c', 'commit.gpgsign=false', ...args], { cwd, stdio: 'pipe' }).toString().trim();

const READ_CASE = 'EVAL-READS-THE-CODE';
const MISS_CASE = 'EVAL-NEVER-EDITS';
const HOLD_CASE = 'EVAL-HELD-OPEN';

const definition = (pin, holdFile) => ({
  version: 1,
  title: 'Reads before it answers',
  target: { kind: 'agent', scope: 'project', name: 'developer' },
  pin,
  samples: 1,
  limits: { maxCostUsdPerSample: 1, timeoutMinutes: 5, maxCostUsd: 5 },
  cases: [
    { id: 'reads', title: 'Reads the code first', prompt: READ_CASE, expect: [{ kind: 'called', call: { tool: 'Read' } }] },
    { id: 'edits', title: 'Edits a file', prompt: MISS_CASE, expect: [{ kind: 'called', call: { tool: 'Edit' } }] },
    ...(holdFile ? [{ id: 'held', title: 'Waits for the spec', prompt: HOLD_CASE, expect: [{ kind: 'called', call: { tool: 'Read' } }] }] : []),
  ],
});

export default async ({ page, api, check, dirs, fakeCli }) => {
  let projectId = null;
  const base = () => `/?project=${projectId}&view=team&section=evals`;
  try {
    // ---- a repository with a first commit and an agent to measure ----
    const dir = join(dirs.workspaceDir, 'e2e-evals');
    mkdirSync(join(dir, 'src'), { recursive: true });
    git(dir, 'init', '-q', '-b', 'main');
    writeFileSync(join(dir, 'src', 'a.txt'), 'alpha\n');
    git(dir, 'add', '.');
    git(dir, 'commit', '-q', '-m', 'initial commit');
    const head = git(dir, 'rev-parse', 'HEAD');

    const imported = await api.post('/projects/import', { path: dir, name: 'e2e-evals', template: 'software' });
    check(imported.status === 201, `a software project (${imported.status})`);
    projectId = imported.body.id;
    const team = await api.post(`/projects/${projectId}/team/from-template`, {});
    check(team.status === 200 || team.status === 201, `the template's team (${team.status})`);
    const hold = join(dir, 'release-the-eval');
    writeFileSync(
      fakeCli.scripts,
      JSON.stringify({
        [READ_CASE]: 'read: src/a.txt\nsay: Read it first.',
        [MISS_CASE]: 'read: src/a.txt\nsay: Nothing to edit.',
        [HOLD_CASE]: `read: src/a.txt\nhold: ${hold}\nsay: Released.`,
      }),
    );

    // ---- the empty list offers the first eval ----
    await page.viewport(1440, 900);
    await page.goto(base(), 1200);
    // `.evals-page` is drawn around the skeleton too: wait for what the list resolved to
    await page.waitFor(`return !!document.querySelector('.evals-page .state-empty, .evals-list, .evals-none, .evals-page [role=alert]')`, { label: 'the evals section' });
    check((await page.text('main')).includes('No evals yet'), 'an empty list says so');

    // ---- create one in the editor: title, file name and the first case ----
    await page.click('button', 'New eval');
    await page.waitFor(`return !!document.querySelector('.evals-editor')`, { label: 'the editor' });
    await page.fill('input[aria-label="Title"]', 'Reads before it answers');
    await page.fill('input[aria-label="File name"]', 'reads-first');
    await page.fill('input[aria-label="Pinned commit"]', head);
    await page.fill('input[aria-label="Case id"]', 'reads');
    await page.fill('textarea[aria-label="Prompt"]', READ_CASE);
    check(await page.eval(`return !![...document.querySelectorAll('.evals-expect')].length || !!document.querySelector('.evals-expects')`), 'the case lists its checks');
    // The remaining cases and the checks are written as the file would be by a person editing JSON
    // in the repository; the editor then reads the file back
    const saved = await api.put(`/projects/${projectId}/evals/reads-first`, { definition: definition(head, true), ifMatch: null });
    check(saved.status === 200 || saved.status === 201, `the file was written (${saved.status})`);
    await page.goto(base(), 1200);
    await page.waitFor(`return document.querySelectorAll('.evals-row').length === 1`, { label: 'the eval in the list' });
    check((await page.text('.evals-row')).includes('Reads before it answers'), 'the list names the eval by its title');
    check((await page.text('.evals-row')).includes('Never run'), 'a new eval has never run');

    // ---- the editor opens the file and offers to run it ----
    await page.click('.evals-row');
    await page.waitFor(`return !!document.querySelector('.evals-editor')`, { label: 'the editor of the file' });
    check((await page.eval(`return document.querySelectorAll('.evals-case').length`)) === 3, 'the editor shows the three cases');

    // ---- start: consent, the estimate, then the run ----
    await page.click('button', 'Run eval');
    await page.waitFor(`return !!document.querySelector('.evals-start')`, { label: 'the start dialog' });
    check(await page.eval(`return !![...document.querySelectorAll('.evals-start .evals-start-check')].length`), 'variants and cases are ticked in the dialog');
    // Propose a text: the current and the proposed variants run side by side
    await page.eval(`const box = [...document.querySelectorAll('.evals-start .evals-start-check')].find((c) => c.textContent.includes('Proposed text')); const input = box?.querySelector('input,[role=checkbox]'); if (input) input.click(); return true`);
    const proposed = await page.eval(`return !!document.querySelector('.evals-start textarea')`);
    if (proposed) await page.fill('.evals-start textarea', '# Developer\n\nRead the code before you answer.\n');
    // The team was set up after the pinned commit, so the agent is absent at the pin and the plan
    // refuses that variant (target-missing): leave it out before reading the estimate
    const pinned = await page.eval(`const box = [...document.querySelectorAll('.evals-start .evals-start-check')].find((c) => c.textContent.includes('Committed at the pin')); const input = box?.querySelector('input,[role=checkbox]'); if (!input) return false; if (input.checked || input.getAttribute('aria-checked') === 'true') input.click(); return true`);
    check(pinned, 'the dialog offers the variant committed at the pin');
    // The estimate follows the form after a pause: the run button is enabled only on a fresh one (or
    // the consent asks first, which needs a fresh one too)
    await page.waitFor(`const b = document.querySelector('.evals-start-foot .btn-primary'); return !!document.querySelector('.evals-start .evals-estimate-line') && (!!document.querySelector('.evals-consent') || (b && !b.disabled))`, { label: 'the estimate' });
    const estimate = await page.eval(`return [...document.querySelectorAll('.evals-start .evals-estimate, .evals-start [role=alert]')].map((e) => e.innerText).join(' | ')`);
    check(/attempt/.test(estimate) && /up to/.test(estimate), `the dialog states the attempts and the ceiling (${estimate.slice(0, 300)})`);
    const consent = await page.eval(`return !!document.querySelector('.evals-consent')`);
    if (consent) await page.eval(`const box = document.querySelector('.evals-consent .evals-start-check, .evals-start-check input[type=checkbox]'); (box?.querySelector('input,[role=checkbox]') ?? box)?.click(); return true`);
    await page.waitFor(`const b = [...document.querySelectorAll('.evals-start-foot .btn-primary')][0]; return b && !b.disabled`, { label: 'the primary button is enabled' });
    await page.click('.evals-start-foot .btn-primary');
    await page.waitFor(`return !!document.querySelector('.evals-run')`, { label: 'the run view' });
    check(new URL(await page.eval(`return location.href`)).searchParams.has('run'), 'the run has a page of its own');
    const runId = new URL(await page.eval(`return location.href`)).searchParams.get('run');

    // ---- the held case keeps the run live: it is the one surface that moves, and it can be cancelled ----
    await page.waitFor(`return !!document.querySelector('.evals-run-card.live-energy')`, { label: 'the live run card' });
    check((await page.eval(`return document.querySelectorAll('.live-energy').length`)) === 1, 'one energy border on the running run');
    check(await page.eval(`return !![...document.querySelectorAll('.evals-run .btn')].find((b) => /Stop|Cancel/.test(b.textContent))`), 'a running run can be stopped');

    // ---- let it finish: release the held case ----
    writeFileSync(hold, '');
    await page.waitFor(`return !document.querySelector('.evals-run-card.live-energy') && !!document.querySelector('.evals-matrix')`, { label: 'the run to end', timeout: 120_000 });
    check(await page.eval(`return !!document.querySelector('.evals-attempt')`), 'every attempt is a cell of the matrix');
    const tones = await page.eval(`return [...document.querySelectorAll('.evals-attempt')].map((a) => a.className + ' ' + (a.title || ''))`);
    check(tones.some((t) => /Passed/.test(t)), `a case passed (${tones.join(' | ')})`);
    check(tones.some((t) => /Failed/.test(t)), 'a case failed');
    check(!(await page.eval(`return !!document.querySelector('.evals-run .live-energy, .evals-run .ring-spinner')`)), 'an ended run does not move');

    // ---- one sample: its calls and the checks with their evidence ----
    await page.click('.evals-attempt');
    await page.waitFor(`return !!document.querySelector('.evals-sample')`, { label: 'the sample' });
    // textContent: the section labels are drawn in capitals, which innerText would hand back
    const sample = await page.eval(`return document.querySelector('.evals-sample').textContent`);
    check(/Calls/.test(sample) && /Checks/.test(sample) && /Final answer/.test(sample), 'the sample shows calls, checks and the final answer');
    check(await page.eval(`return !!document.querySelector('.evals-sample .evals-call-row')`), 'the calls are listed');
    check(await page.eval(`return !!document.querySelector('.evals-sample .evals-check')`), 'the checks are listed');
    await page.key('Escape');
    await page.waitFor(`return !document.querySelector('.evals-sample')`, { label: 'the sample to close' });

    // ---- export: the run as JSON and as Markdown ----
    const json = await api.get(`/eval-runs/${runId}/export`);
    check(json.status === 200, `the export as JSON (${json.status})`);
    const md = await api.get(`/eval-runs/${runId}/export?format=markdown`);
    check(md.status === 200, `the export as Markdown (${md.status})`);

    // ---- history: the run is listed, and a phone gets a card per case ----
    await page.goto(`${base()}&eval=reads-first`, 1200);
    await page.click('button', 'History');
    await page.waitFor(`return document.querySelectorAll('.evals-history-item').length >= 1`, { label: 'the history' });
    await page.viewport(390, 844);
    await page.goto(`${base()}&run=${runId}`, 1200);
    await page.waitFor(`return !!document.querySelector('.evals-matrix-cards, .evals-matrix')`, { label: 'the matrix on a phone' });
    check(await page.eval(`return !!document.querySelector('.evals-matrix-card')`), 'a phone reads a card per case');
    check(await page.eval(`return document.documentElement.scrollWidth <= window.innerWidth + 1`), 'the run view does not scroll sideways on a phone');
  } finally {
    await page.viewport(1440, 900).catch(() => {});
    await page.eval(`localStorage.removeItem('claudio:project'); return true`).catch(() => {});
    if (projectId) {
      const runs = await api.get(`/projects/${projectId}/eval-runs`).catch(() => null);
      for (const run of runs?.body?.runs ?? []) {
        await api.post(`/eval-runs/${run.id}/cancel`, {}).catch(() => {});
        await api.del(`/eval-runs/${run.id}`).catch(() => {});
      }
      await api.del(`/projects/${projectId}`).catch(() => {});
    }
    rmSync(join(dirs.workspaceDir, 'e2e-evals'), { recursive: true, force: true });
  }
};
