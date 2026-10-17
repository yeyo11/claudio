// The Supervisor as its decision point, `supervisor.intervene` (docs/plans/settings-ia.md §7.2): the
// old `?tab=supervisor` link lands on its row in Settings → Decisions, its three modes say what the
// Supervisor does, Active works on the CLI for this point only, and the deprecated
// `/settings/supervisor` routes read and write the point. A proposal only exists once a live worker
// turns bad and a model answers, so Send, Edit and Dismiss on the health card are covered by the unit
// tests of core and the API, not here: this spec never starts a model.
const POINT = 'supervisor.intervene';
const ROW = `[data-point="${POINT}"]`;

const settingsOf = async (api) => (await api.get('/decisions/settings')).body;
const modeOf = async (api) => (await settingsOf(api)).points?.[POINT]?.mode ?? 'off';

/** Puts the point back to `mode` without consent, through the API */
async function reset(api, mode = 'off') {
  const info = (await api.get('/decisions/points')).body.find((p) => p.id === POINT);
  await api.put(`/decisions/points/${POINT}/consent`, { granted: false, stateVersion: info.stateVersion, providers: [] });
  const { jev, ...now } = await settingsOf(api);
  await api.put('/decisions/settings', { ...now, points: { ...now.points, [POINT]: { mode, threshold: info.defaultThreshold, consent: null } } });
}

const line = (page) => page.eval(`return document.querySelector('${ROW} .dp-point-line')?.textContent ?? ''`);

async function save(page) {
  await page.click('.dp-foot button.dp-save', undefined, 800);
  await page.waitFor(`return !document.querySelector('.dp-foot')`, { label: 'the settings are saved and the bar goes' });
}

export default async ({ page, api, check }) => {
  const before = await settingsOf(api);
  check(before.provider === 'cli', `the sandbox starts on the cli provider (${before.provider})`);
  const read = await api.get('/settings/supervisor');
  check(read.status === 200, `the deprecated supervisor view is read (${read.status})`);
  try {
    await reset(api);

    // ---- the old address lands on the point's row, its area open ----
    await page.goto('/settings?tab=supervisor', 1500);
    await page.waitFor(`return location.pathname === '/settings/decisions' && location.hash === '#point-supervisor-intervene'`, {
      label: 'the old Supervisor link redirects to its point',
    });
    await page.waitFor(`return !!document.querySelector('${ROW} [role=radio]')`, { label: 'the Supervisor row, its area unfolded' });
    check((await line(page)) === 'Does not watch for stuck workers', `Off says what it does (${await line(page)})`);
    check(!(await page.eval(`return !!document.querySelector('${ROW} .dp-thr')`)), 'no threshold on the CLI');

    // ---- Shadow, through the consent dialog: proposes hints for a person to send ----
    await page.click(`${ROW} [role=radio]`, 'Shadow', 600);
    await page.waitFor(`return !!document.querySelector('[role=dialog] .dp-preview')`, { label: 'the consent dialog' });
    await page.click('[role=dialog] button', 'Consent and move to', 600);
    await page.waitFor(`return !document.querySelector('[role=dialog] .dp-preview')`, { label: 'the dialog closes' });
    check((await line(page)) === 'Proposes hints for you to send', `Shadow says what it does (${await line(page)})`);
    await save(page);
    check((await modeOf(api)) === 'shadow', 'the point is stored as shadow');
    const shadow = (await api.get('/settings/supervisor')).body;
    const engine = (await settingsOf(api)).cli;
    check(
      shadow.enabled === true && shadow.autoSend === false && shadow.model === engine.model && shadow.maxCostUsd === engine.maxCostUsd,
      `the deprecated view is derived from the point and the engine (${JSON.stringify(shadow)})`,
    );

    // ---- Active works on the CLI for this point, unlike every other act point ----
    check(
      (await page.eval(`return [...document.querySelectorAll('${ROW} [role=radio]')][2]?.getAttribute('aria-disabled')`)) !== 'true',
      'Active is available for the Supervisor on the cli',
    );
    await page.click(`${ROW} [role=radio]`, 'Active', 600);
    check((await line(page)) === 'Sends each hint on its own', `Active on the CLI says what it does (${await line(page)})`);
    await save(page);
    check((await modeOf(api)) === 'active', 'the point is stored as active');
    check((await api.get('/settings/supervisor')).body.autoSend === true, 'the deprecated view says it sends on its own');

    const violations = await page.axe({ include: ROW });
    check(violations.length === 0, `the Supervisor row has accessibility violations: ${JSON.stringify(violations)}`);

    // ---- the deprecated write maps onto the point; the model and the cap are ignored ----
    const off = await api.put('/settings/supervisor', { enabled: false, model: 'opus', maxCostUsd: 9 });
    check(off.status === 200 && off.body.enabled === false && off.body.maxCostUsd === engine.maxCostUsd, `enabled: false turns the point off (${JSON.stringify(off.body)})`);
    check((await modeOf(api)) === 'off', 'the point is off');
    const refused = await api.put('/settings/supervisor', { enabled: 'yes' });
    check(refused.status === 400, `the server refuses an enabled that is not a boolean (${refused.status})`);
  } finally {
    await reset(api, before.points?.[POINT]?.mode ?? 'off').catch(() => {});
  }
};
