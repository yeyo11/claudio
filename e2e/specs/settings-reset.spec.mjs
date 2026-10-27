// "Changed · Reset" on a settings row and "Overridden in N projects" (docs/plans/settings-reset-and-polish.md,
// D6 and D7). A value moved from its default shows the slot; Reset puts the default back through
// `DELETE /settings/state/:setting`, hides the slot, moves focus to the row's control and survives a
// reload. A decision point that a project overrides says so on the global row, with a link to that
// project's settings. Written with the task and not run by it: CI runs the suite on the merged branch.
export const timeout = 120_000;

const ROW = '[data-setting="runs.concurrent"]';

export default async ({ page, api, check }) => {
  let projectId = null;
  const shown = () => page.eval(`return document.querySelector('${ROW} .pref-row-change')?.dataset.shown ?? null`);
  try {
    const defaults = (await api.get('/settings/state')).body.settings['runs.concurrent'];
    check(defaults && typeof defaults.default === 'number', 'the server serves the default of the concurrent runs');

    // A value other than the default: the slot shows
    const moved = defaults.default === 9 ? 10 : 9;
    check((await api.put('/settings/app', { maxConcurrentRuns: moved })).status === 200, 'the setting was moved from its default');
    await page.goto('/settings/runs', 1500);
    await page.waitFor(`return document.querySelector('${ROW} .pref-row-change')?.dataset.shown === 'true'`, { label: 'the Changed slot', timeout: 60_000 });
    const label = await page.eval(`return document.querySelector('${ROW} .pref-row-change-reset')?.getAttribute('aria-label') ?? ''`);
    check(label.includes('to its default') && label.includes(String(defaults.default)), `Reset names the default (${label})`);

    // Reset: the control shows the default, the slot hides (keeping its room), focus is in the row
    await page.click(`${ROW} .pref-row-change-reset`, 'Reset', 800);
    await page.waitFor(`return document.querySelector('${ROW} .pref-row-change')?.dataset.shown === 'false'`, { label: 'the slot hides after Reset', timeout: 30_000 });
    check((await api.get('/settings/app')).body.maxConcurrentRuns === defaults.default, 'the stored value is gone: the default applies');
    check(
      await page.eval(`const row = document.querySelector('${ROW}'); return !!row && row.contains(document.activeElement) && !document.activeElement.closest('.pref-row-change')`),
      'focus moved to the row control',
    );
    check(
      await page.eval(`const line = document.querySelector('${ROW} .pref-row-change-line'); return !!line && getComputedStyle(line).visibility === 'hidden'`),
      'the hidden slot keeps its room',
    );

    // Gone after a reload
    await page.goto('/settings/runs', 1500);
    await page.waitFor(`return !!document.querySelector('${ROW} .pref-row-change')`, { label: 'the Runs row after a reload', timeout: 60_000 });
    check((await shown()) === 'false', 'after a reload the row is not changed');

    // A value the environment sets has no Reset
    const state = (await api.get('/settings/state')).body.settings;
    for (const [id, one] of Object.entries(state)) {
      if (one.source !== 'env') continue;
      check(one.changed === false, `${id} is set by the environment, so it is never offered a Reset`);
    }

    // One override line: a project that sets a point's mode
    const project = await api.post('/projects', { name: 'e2e-settings-overridden' });
    projectId = project.body.id;
    const point = 'flow.bounce';
    const current = (await api.get(`/projects/${projectId}/settings`)).body;
    const saved = await api.put(`/projects/${projectId}/settings`, { ...current, decisions: { points: { [point]: { mode: 'shadow' } } } });
    check(saved.status === 200, 'the project overrides a point');
    const overrides = (await api.get('/settings/overrides')).body;
    check(overrides['point-flow-bounce']?.includes(projectId), 'the server counts the override');
    await page.goto('/settings/decisions#point-flow-bounce', 1500);
    await page.waitFor(`return !!document.querySelector('[data-setting="point-flow-bounce"]')`, { label: 'the point row', timeout: 60_000 });
    await page.waitFor(`return !!document.querySelector('[data-setting="point-flow-bounce"] .pref-row-overridden')`, { label: 'the overridden line', timeout: 30_000 });
    const href = await page.eval(`return document.querySelector('[data-setting="point-flow-bounce"] .pref-row-overridden').getAttribute('href')`);
    check(href === `/?project=${projectId}&view=settings`, `the line links to the project's settings (${href})`);
  } finally {
    await api.del('/settings/state/runs.concurrent').catch(() => {});
    if (projectId) await api.del(`/projects/${projectId}`).catch(() => {});
  }
};
