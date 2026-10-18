// The setup assistant (docs/plans/in-app-setup.md, docs/setup.md) end to end: its four steps, Claude Code
// read as ready on the Agents step, the summary, and Start.
//
// Claude is the fake CLI of e2e/fake-cli, which answers `claude auth status` as signed in, so the
// Agents step has nothing to sign in; the sign-in panel's device flow is covered by the core tests.
//
// The spec leaves the sandbox as it found it: setupSeen recorded.
export const fakeCli = true;
export const timeout = 120_000;

// Parenthesised: it is spliced into `a && ${rowState(id)} === 'ready'`, and `??` may not sit unparenthesised
// beside `&&` (a SyntaxError) nor before `===`, which would bind first and compare `null` instead
const rowState = (id) => `(document.querySelector('.prov-row[data-provider="${id}"], .prov-cell[data-provider="${id}"]')?.getAttribute('data-state') ?? null)`;
const onStep = (step) => `return !!document.querySelector('.setup-page[data-setup-step="${step}"]')`;

export default async ({ page, api, check }) => {
  const theme = (name) => page.eval(`localStorage.setItem('claudio-theme', ${JSON.stringify(name)}); return true`);

  try {
    await api.post('/providers/refresh');
    await api.put('/settings/app', { setupSeen: false });
    check((await api.get('/setup')).body.seen === false, 'GET /setup says the assistant is not seen');

    await page.viewport(1440, 900);
    await page.goto('/', 300);
    await theme('dark');
    await page.goto('/', 300);

    // ---- Access: the step bar, the mode, and Continue as the one primary ----
    await page.waitFor(onStep('access'), { label: 'the assistant, on Access' });
    const marks = await page.eval(`return [...document.querySelectorAll('.setup-step')].map((s) => s.className.replace('setup-step ', ''))`);
    check(JSON.stringify(marks) === JSON.stringify(['is-current', 'is-pending', 'is-pending', 'is-pending']), `four steps, the first current (${marks.join(', ')})`);
    check((await page.eval(`return document.querySelector('.setup-step.is-current')?.getAttribute('aria-current')`)) === 'step', 'the current step is named for screen readers');
    check((await page.eval(`return document.querySelectorAll('.btn-primary').length`)) === 1, 'Continue is the one primary of the page');
    check(!(await page.eval(`return !!document.querySelector('[data-action="back"]')`)), 'the first step has no Back');

    // ---- Agents: Claude Code is ready ----
    await page.click('[data-action="continue"]', undefined, 600);
    await page.waitFor(onStep('agents'), { label: 'the Agents step' });
    await page.waitFor(`return ${rowState('claude-code')} === 'ready'`, { label: 'claude-code ready on the Agents step' });
    check((await api.get('/providers/claude-code')).body.state === 'ready', 'the server reads claude-code as signed in');
    check((await page.text('.setup-foot')).includes('ready'), 'the foot counts what is ready');

    // The frame fills the viewport: the foot is pinned to its bottom, and Continue is never below the fold
    await page.viewport(1280, 720);
    const frame = await page.eval(`
      const foot = document.querySelector('.setup-foot-bar').getBoundingClientRect();
      const go = document.querySelector('[data-action="continue"]').getBoundingClientRect();
      return { footBottom: Math.round(foot.bottom), height: window.innerHeight, continueVisible: go.top >= 0 && go.bottom <= window.innerHeight, scrolls: document.documentElement.scrollHeight > window.innerHeight };
    `);
    check(frame.footBottom === frame.height && frame.continueVisible, `the foot sits at the bottom of a 1280x720 screen with Continue in view (${JSON.stringify(frame)})`);
    check(frame.scrolls === false, 'the page itself does not scroll: only the body does');
    check((await page.eval(`return document.querySelectorAll('.setup-grid > .setup-aside').length`)) === 1, 'the wide screen has the title column on the left');
    await page.viewport(1440, 900);

    // ---- Code and work items: skipped ----
    await page.click('[data-action="continue"]', undefined, 600);
    await page.waitFor(onStep('code'), { label: 'the Code and work items step' });
    check((await page.eval(`return document.querySelectorAll('.prov-row[data-host]').length`)) === 2, 'GitHub and GitLab are listed');
    await page.click('[data-action="skip"]', undefined, 600);

    // ---- Done: the summary, with the skipped step marked plainly ----
    await page.waitFor(onStep('done'), { label: 'the Done step' });
    check((await page.eval(`return !!document.querySelector('.setup-step.is-skipped[data-step="code"]')`)) === true, 'the skipped step is marked skipped');
    check((await page.eval(`return !!document.querySelector('.setup-sum-row[data-tool="claude-code"] .badge-ok')`)) === true, 'Claude Code reads Ready in the summary');
    check((await page.eval(`return document.querySelectorAll('svg.il').length`)) === 1, 'Done is the one screen with an illustration');
    await page.shot('setup-done-dark');
    await theme('light');
    await page.goto('/', 300);
    await page.waitFor(onStep('access'), { label: 'the assistant again, light: a reload starts it over' });
    await page.click('[data-action="skip"]', undefined, 400);
    await page.click('[data-action="skip"]', undefined, 400);
    await page.click('[data-action="skip"]', undefined, 600);
    await page.waitFor(onStep('done'), { label: 'Done, light' });
    await page.shot('setup-done-light');

    // ---- Start: the app, and the assistant never again ----
    await page.click('[data-action="start"]', undefined, 600);
    await page.waitFor(`return !document.querySelector('.setup-page') && !!document.querySelector('.statusbar')`, { label: 'the app after Start' });
    check((await api.get('/setup')).body.seen === true, 'Start records the assistant as seen');
    await page.goto('/', 300);
    await page.waitFor(`return !!document.querySelector('.statusbar')`, { label: 'the app on the next start' });
    check(!(await page.eval(`return !!document.querySelector('.setup-page')`)), 'the assistant does not come back');
  } finally {
    await api.post('/setup/seen').catch(() => {});
  }
};
