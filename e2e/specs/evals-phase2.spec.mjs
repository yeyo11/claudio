// Instruction evals, Phase 2 (docs/plans/instruction-evals.md, "Phase 2 design"): pressure levels,
// a judged expectation answered by a scripted `json:` judge, the metrics with n and the interval,
// and the promotion gate card. Phase 2 stays behind `evalsPhase2`, so the spec turns the switch on
// and puts it back. The run is started through the API: the start dialog is covered by evals.spec.mjs.
//
// The fake CLI ignores the agent file, so current and proposed behave alike: the gate is checked for
// what it shows (a verdict as a word, "Nothing is applied", the means), not for a regression. The
// judge is the fake CLI too, keyed on the statement, which only the judge's prompt contains.
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const fakeCli = true;
export const timeout = 300_000;

const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=e2e', '-c', 'user.email=e2e@example.com', '-c', 'commit.gpgsign=false', ...args], { cwd, stdio: 'pipe' }).toString().trim();

const NEUTRAL = 'EVAL2-NEUTRAL-TASK';
const COMPETING = 'EVAL2-COMPETING-TASK';
const STATEMENT = 'EVAL2-JUDGE-STATEMENT: it reads before it answers';

const definition = (pin) => ({
  version: 2,
  title: 'Reads under pressure',
  target: { kind: 'agent', scope: 'project', name: 'developer' },
  pin,
  samples: 3,
  k: 2,
  limits: { maxCostUsdPerSample: 1, timeoutMinutes: 5, maxCostUsd: 20 },
  cases: [
    {
      id: 'reads',
      title: 'Reads the code first',
      mustHold: true,
      prompts: { neutral: NEUTRAL, competing: COMPETING },
      expect: [{ kind: 'called', call: { tool: 'Read' } }, { kind: 'judged', statement: STATEMENT }],
    },
  ],
});

export default async ({ page, api, check, dirs, fakeCli }) => {
  let projectId = null;
  let switchWas = false;
  const base = () => `/?project=${projectId}&view=team&section=evals`;
  try {
    switchWas = (await api.get('/settings/app')).body?.evalsPhase2 === true;
    const on = await api.put('/settings/app', { evalsPhase2: true });
    check(on.status === 200, `the Phase 2 switch is on (${on.status})`);

    const dir = join(dirs.workspaceDir, 'e2e-evals-2');
    mkdirSync(join(dir, 'src'), { recursive: true });
    git(dir, 'init', '-q', '-b', 'main');
    writeFileSync(join(dir, 'src', 'a.txt'), 'alpha\n');
    git(dir, 'add', '.');
    git(dir, 'commit', '-q', '-m', 'initial commit');
    const head = git(dir, 'rev-parse', 'HEAD');

    const imported = await api.post('/projects/import', { path: dir, name: 'e2e-evals-2', template: 'software' });
    check(imported.status === 201, `a software project (${imported.status})`);
    projectId = imported.body.id;
    const team = await api.post(`/projects/${projectId}/team/from-template`, {});
    check(team.status === 200 || team.status === 201, `the template's team (${team.status})`);
    writeFileSync(
      fakeCli.scripts,
      JSON.stringify({
        [NEUTRAL]: 'read: src/a.txt\nsay: Read it first.',
        [COMPETING]: 'read: src/a.txt\nsay: Read it, quickly.',
        [STATEMENT]: 'json: {"pass":true,"reason":"It read src/a.txt before it answered.","evidence":[1]}',
      }),
    );

    const saved = await api.put(`/projects/${projectId}/evals/reads-2`, { definition: definition(head), ifMatch: null });
    check(saved.status === 200 || saved.status === 201, `the version 2 file was written (${saved.status})`);

    // ---- a run at two pressure levels, current against proposed ----
    // An estimate is an `EvalRunRequest` too: the ceiling is not confirmed yet, so it carries 0, as the dialog does
    const request = {
      variants: ['current', 'proposed'],
      confirmMaxCostUsd: 0,
      proposed: '# Developer\n\nRead the code before you answer.\n',
      pressures: ['neutral', 'competing'],
    };
    const estimate = await api.post(`/projects/${projectId}/evals/reads-2/estimate`, request);
    check(estimate.status === 200, `the estimate (${estimate.status})`);
    check(estimate.body.samples === 12, `variants x levels x n are multiplied out (${estimate.body.samples})`);
    check(!!estimate.body.perLevel?.competing, 'the estimate breaks the cost down per level');
    if (estimate.body.consentNeeded) {
      const file = await api.get(`/projects/${projectId}/evals/reads-2`);
      const consent = await api.post(`/projects/${projectId}/evals/reads-2/consent`, { sha: file.body.sha });
      check(consent.status === 200 || consent.status === 204, `the person's consent (${consent.status})`);
    }
    const started = await api.post(`/projects/${projectId}/evals/reads-2/runs`, { ...request, confirmMaxCostUsd: estimate.body.ceilingUsd });
    check(started.status === 201, `the run started (${started.status})`);
    const runId = started.body.id ?? started.body.runId;

    await page.viewport(1440, 900);
    await page.goto(`${base()}&run=${runId}`, 1200);
    await page.waitFor(`return !!document.querySelector('.evals-run')`, { label: 'the run view' });
    await page.waitFor(`return !document.querySelector('.evals-run-card.live-energy') && !!document.querySelector('.evals-matrix')`, { label: 'the run to end', timeout: 180_000 });
    check(!(await page.eval(`return !!document.querySelector('.evals-run .live-energy, .evals-run .ring-spinner')`)), 'an ended run does not move');

    // ---- pressure tabs, and the metrics always with n and the interval ----
    check(await page.eval(`return /Neutral/.test(document.querySelector('.evals-run').innerText) && /Competing/.test(document.querySelector('.evals-run').innerText)`), 'the run offers a tab per pressure level');
    await page.waitFor(`return !!document.querySelector('.evals-metrics .evals-metric')`, { label: 'the metrics' });
    const metrics = await page.eval(`return document.querySelector('.evals-metrics').innerText`);
    check(/\d+\/\d+/.test(metrics), `a rate carries c/n (${metrics.slice(0, 80)})`);
    check(/95/.test(metrics) && /pass@2/.test(metrics) && /pass\^2/.test(metrics), 'the interval, pass@k and pass^k are beside the rate');
    check(await page.eval(`return !!document.querySelector('.evals-rate')`), 'a bar draws the interval');
    await page.click('button', 'Competing');
    await page.waitFor(`return /Competing/.test(document.querySelector('.evals-matrix-wrap, .evals-matrix')?.closest('section')?.innerText ?? '')`, { label: 'the competing tab' });

    // ---- one judged sample: the reason, the model and the evidence ----
    await page.click('.evals-attempt');
    await page.waitFor(`return !!document.querySelector('.evals-sample')`, { label: 'the sample' });
    const sample = await page.eval(`return document.querySelector('.evals-sample').innerText`);
    check(/It read src\/a\.txt before it answered/.test(sample), 'the judge\'s reason is shown with the check');
    await page.key('Escape');
    await page.waitFor(`return !document.querySelector('.evals-sample')`, { label: 'the sample to close' });

    // ---- the promotion gate: a verdict as a word, and nothing applied ----
    const gate = await api.get(`/eval-runs/${runId}/gate`);
    check(gate.status === 200, `the gate (${gate.status})`);
    check(['promotable', 'regressed', 'incomplete'].includes(gate.body.verdict), `a verdict (${gate.body.verdict})`);
    await page.waitFor(`return !!document.querySelector('.evals-gate')`, { label: 'the gate card' });
    const card = await page.text('.evals-gate');
    check(/May be promoted|Regressed|Incomplete/.test(card), 'the verdict is a word, not only a colour');
    check(/Nothing is applied/.test(card), 'the card says nothing is applied');
    check((await page.eval(`return document.querySelectorAll('.live-energy').length`)) === 0, 'the gate adds no moving surface');

    // ---- the phone: no sideways scroll, and a card per case ----
    await page.viewport(390, 844);
    await page.goto(`${base()}&run=${runId}`, 1200);
    await page.waitFor(`return !!document.querySelector('.evals-gate')`, { label: 'the gate on a phone' });
    check(await page.eval(`return document.documentElement.scrollWidth <= window.innerWidth + 1`), 'the run view does not scroll sideways on a phone');

    // ---- the switch off: the gate and the Phase 2 routes are refused ----
    await api.put('/settings/app', { evalsPhase2: false });
    const off = await api.get(`/eval-runs/${runId}/gate`);
    check(off.status === 409, `the gate is refused while Phase 2 is off (${off.status})`);
  } finally {
    await page.viewport(1440, 900).catch(() => {});
    await api.put('/settings/app', { evalsPhase2: switchWas }).catch(() => {});
    await page.eval(`localStorage.removeItem('claudio:project'); return true`).catch(() => {});
    if (projectId) {
      const runs = await api.get(`/projects/${projectId}/eval-runs`).catch(() => null);
      for (const run of runs?.body?.runs ?? []) {
        await api.post(`/eval-runs/${run.id}/cancel`, {}).catch(() => {});
        await api.del(`/eval-runs/${run.id}`).catch(() => {});
      }
      await api.del(`/projects/${projectId}`).catch(() => {});
    }
    rmSync(join(dirs.workspaceDir, 'e2e-evals-2'), { recursive: true, force: true });
  }
};
