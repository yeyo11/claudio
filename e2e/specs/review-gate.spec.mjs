// The review gate in the browser (docs/plans/review-gate.md, Tests, e2e): a two-task worktree graph
// with verification on and the review on, answered by the fake CLI's `json:` lines.
//   1. The reviewers find nothing: the card says passed and the pull request is offered.
//   2. The correctness reviewer reports a high finding and the verifier confirms it: the card says
//      blocked with the finding, the integration diff draws the card under its line, the pull
//      request is held, and Accept anyway with a reason passes it and offers the pull request.
//   3. A reviewer answers with no `json:` (invalid): the card says incomplete, and Retry starts a
//      new round that passes.
//   4. Phone width, the light theme and motion off, on the blocked state of 2.
//
// The scripts are keyed by text the prompts contain: a worker's prompt holds its task's words, a
// reviewer's head holds "Your dimension is `<dimension>`" and the verifier's holds its claims' ids.
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const fakeCli = true;

const FINISHED = new Set(['completed', 'failed', 'stopped']);
const NO_FINDINGS = { findings: [], coverage: { complete: true } };
const HIGH = {
  findings: [
    {
      title: 'A half-written settings file aborts the load',
      severity: 'high',
      file: 'alpha.txt',
      line: 1,
      side: 'new',
      evidence: 'alpha line one',
      failureScenario: 'The file is cut at 3 bytes and the parse throws, so nothing falls back to the defaults',
      confidence: 0.9,
    },
  ],
  coverage: { complete: true },
};
const CONFIRMED = { verdicts: [{ id: 'f1', status: 'confirmed', reason: 'Reproduced with a file cut at 3 bytes' }] };

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' });

export default async ({ page, api, check, dirs, fakeCli }) => {
  const made = [];
  const orchestration = async (id) => (await api.get(`/orchestrations/${id}`)).body;
  const until = async (id, done, label) => {
    for (let i = 0; i < 150; i++) {
      const state = await orchestration(id);
      if (state && done(state)) return state;
      await page.sleep(400);
    }
    throw new Error(`timed out waiting for ${label}`);
  };
  const scripts = (reviewer) =>
    writeFileSync(
      fakeCli.scripts,
      JSON.stringify({
        'Write the alpha file': 'run: echo "alpha line one" > alpha.txt && git add alpha.txt && git commit -qm "feat: alpha"\nsay: done',
        'Write the beta file': 'run: echo "beta line one" > beta.txt && git add beta.txt && git commit -qm "feat: beta"\nsay: done',
        'Your dimension is `correctness`': reviewer,
        'Your dimension is `tests`': `json: ${JSON.stringify(NO_FINDINGS)}`,
        'Your dimension is `security`': `json: ${JSON.stringify(NO_FINDINGS)}`,
        'Your dimension is `conventions`': `json: ${JSON.stringify(NO_FINDINGS)}`,
        'f1': `json: ${JSON.stringify(CONFIRMED)}`,
      }),
    );
  const launch = async (name) => {
    const workspace = join(dirs.workspaceDir, name);
    mkdirSync(workspace, { recursive: true });
    git(workspace, 'init', '-q', '-b', 'main');
    git(workspace, 'config', 'user.email', 'e2e@example.com');
    git(workspace, 'config', 'user.name', 'e2e');
    writeFileSync(join(workspace, 'README.md'), '# e2e\n');
    git(workspace, 'add', '.');
    git(workspace, 'commit', '-qm', 'init');
    const created = await api.post('/orchestrations', {
      name,
      objective: 'two files that a review reads',
      cwd: workspace,
      maxAttempts: 1,
      worktree: true,
      synthesize: false,
      tasks: [
        { id: 'alpha', name: 'Alpha', prompt: 'Write the alpha file' },
        { id: 'beta', name: 'Beta', prompt: 'Write the beta file' },
      ],
      verification: { commands: [], fixer: false, maxAttempts: 1, review: { fixer: false, maxFixRounds: 0 } },
    });
    check(created.status === 201, `${name}: the graph was created (${created.status})`);
    made.push(created.body.id);
    return created.body.id;
  };
  const gateOf = (state) => state.verification?.review?.status;
  const cardStatus = `return document.querySelector('.rg')?.getAttribute('data-review-status') ?? ''`;
  const wordsOf = (selector) => page.eval(`return (document.querySelector('${selector}')?.textContent ?? '').replace(/\\s+/g, ' ')`);

  try {
    // ---------- 1. nothing to report: passed, and the pull request is offered ----------
    scripts(`json: ${JSON.stringify(NO_FINDINGS)}`);
    const clean = await launch('e2e-review-clean');
    await until(clean, (s) => gateOf(s) === 'passed' || FINISHED.has(s.status) && !gateOf(s), 'the review to pass');
    check(gateOf(await orchestration(clean)) === 'passed', 'the review of a clean diff passed');
    await page.goto(`/orchestration/${clean}?step=verification`, 1500);
    await page.waitFor(`return !!document.querySelector('.rg')`, { label: 'the review section' });
    check((await page.eval(cardStatus)) === 'passed', 'the card says passed');
    check(/passed/i.test(await wordsOf('.rg-head')), 'the badge carries the word');
    check(/no findings/i.test(await wordsOf('.rg')), 'a clean review says "No findings"');
    const offered = (await orchestration(clean)).integration?.status === 'merged';
    check(offered, 'the integration is merged, so the pull request is offered');

    // ---------- 2. a confirmed high finding blocks; accepting it passes ----------
    scripts(`json: ${JSON.stringify(HIGH)}`);
    const blocked = await launch('e2e-review-blocked');
    await until(blocked, (s) => gateOf(s) === 'blocked', 'the review to block');
    await page.goto(`/orchestration/${blocked}?step=verification`, 1500);
    await page.waitFor(`return !!document.querySelector('.rg .rt.finding')`, { label: 'the finding card' });
    check((await page.eval(cardStatus)) === 'blocked', 'the card says blocked');
    check(/half-written settings file/i.test(await wordsOf('.rg .rt.finding')), 'the card shows the finding as written');
    check(/alpha\.txt:1/.test(await wordsOf('.rg .rt.finding')), 'the finding names path:line');
    check(!(await page.eval(`return !!document.querySelector('.rg button.btn-primary')`)), 'a blocked review offers no primary retry');
    await page.goto(`/orchestration/${blocked}`, 1200);
    check(!(await page.eval(`return [...document.querySelectorAll('main button')].some((b) => /pull request/i.test(b.textContent ?? '') && /push|open|create/i.test(b.textContent ?? ''))`)), 'the pull request is held while the review is blocked');

    // The finding under its line in the integration diff
    await page.goto(`/orchestration/${blocked}/changes?file=alpha.txt`, 1500);
    await page.waitFor(`return !!document.querySelector('.rt.finding')`, { label: 'the finding card in the diff' });
    check(true, 'the integration diff draws the finding card under its line');
    check(!(await page.eval(`return !!document.querySelector('.rt.finding form, .rt.finding input')`)), 'a finding has no reply field');

    // ---------- 4. phone, light theme, motion off ----------
    await page.goto(`/orchestration/${blocked}?step=verification`, 1200);
    await page.eval(`document.documentElement.dataset.theme = 'light'; document.documentElement.dataset.motion = 'off'; return true`);
    await page.viewport(390, 800);
    await page.waitFor(`return !!document.querySelector('.rg .rt.finding')`, { label: 'the finding card on a phone' });
    check((await page.eval(`return document.documentElement.scrollWidth <= window.innerWidth`)), 'the review section fits a phone');
    check(
      await page.eval(`return [...document.querySelectorAll('.rg-foot .btn')].every((b) => b.getBoundingClientRect().height >= 44)`),
      'the actions are 44 px tall on a phone',
    );
    check(!(await page.eval(`return !!document.querySelector('.rg.live-energy')`)), 'nothing turns when it is not running');
    await page.viewport(1280, 800);
    await page.eval(`document.documentElement.dataset.theme = 'dark'; delete document.documentElement.dataset.motion; return true`);

    // Accept anyway, with a reason
    await page.goto(`/orchestration/${blocked}?step=verification`, 1200);
    await page.waitFor(`return !!document.querySelector('.rg-foot')`, { label: 'the actions' });
    await page.click('.rg-foot button', 'Accept anyway', 600);
    await page.waitFor(`return !!document.querySelector('[role=dialog] textarea')`, { label: 'the accept dialog' });
    await page.click('[role=dialog] button', 'Accept without the review', 600);
    check(await page.eval(`return !!document.querySelector('[role=dialog] [role=alert]')`), 'an empty reason is refused');
    await page.fill('[role=dialog] textarea', 'Checked by hand: the file is never cut in practice');
    await page.click('[role=dialog] button', 'Accept without the review', 800);
    const accepted = await until(blocked, (s) => gateOf(s) === 'accepted', 'the acceptance');
    check(accepted.verification.review.accepted?.reason.includes('Checked by hand'), 'the reason is recorded');
    await page.goto(`/orchestration/${blocked}?step=verification`, 1500);
    check((await page.eval(cardStatus)) === 'accepted', 'the card says accepted');
    check(/Checked by hand/.test(await wordsOf('.rg-reason')), 'the person\'s reason is quoted');

    // ---------- 3. an invalid answer is incomplete; a retry passes ----------
    scripts('say: no structured output here');
    const incomplete = await launch('e2e-review-incomplete');
    await until(incomplete, (s) => gateOf(s) === 'incomplete', 'the review to be incomplete');
    await page.goto(`/orchestration/${incomplete}?step=verification`, 1500);
    await page.waitFor(`return !!document.querySelector('.rg')`, { label: 'the review section' });
    check((await page.eval(cardStatus)) === 'incomplete', 'the card says incomplete');
    check(await page.eval(`return !!document.querySelector('.rg-reason.warn')`), 'incomplete is said in warn');
    scripts(`json: ${JSON.stringify(NO_FINDINGS)}`);
    await page.click('.rg-foot button.btn-primary', 'Retry the review', 800);
    await until(incomplete, (s) => gateOf(s) === 'passed', 'the retry to pass');
    check(gateOf(await orchestration(incomplete)) === 'passed', 'the retry started a new round that passed');
  } finally {
    for (const id of made) {
      await api.post(`/orchestrations/${id}/stop`).catch(() => {});
      await api.del(`/orchestrations/${id}`).catch(() => {});
    }
  }
};
