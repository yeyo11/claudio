// Settings search (docs/plans/settings-ia.md §5): `/` focuses the field, a query lists results in
// place of the groups, ↑ ↓ move, Enter opens the row on its group's screen with its control focused
// and a fill that fades (none under reduced motion), Escape clears; on a phone the results replace
// the group cells and a tap opens the row the same way.
// Written with the task and not run by it: verification runs the suite on GitHub.
export const timeout = 120_000;

const FIELD = '.settings-search input[type=search]';
const ROW = '[data-setting="runs.concurrent"]';

export default async ({ page, check }) => {
  const path = () => page.eval('return location.pathname + location.hash');
  const query = () => page.eval(`return document.querySelector(${JSON.stringify(FIELD)})?.value ?? null`);
  const labels = () => page.eval(`return [...document.querySelectorAll('.settings-results .settings-result-label')].map((l) => l.textContent)`);
  const focusInRow = () => page.eval(`const row = document.querySelector(${JSON.stringify(ROW)}); return !!row && row.contains(document.activeElement) && document.activeElement !== row`);
  // The control itself: a field, a select or a switch, never a helper such as a number field's Decrease
  const focusOnControl = () => page.eval(`const a = document.activeElement; return !!a && a.tabIndex >= 0 && a.matches('input, select, textarea, [role=switch], [role=slider], [role=combobox], [role=radio]') && !!a.closest(${JSON.stringify(ROW)})`);
  // The fill is a CSS animation on the row: running at the full motion level, none at all under reduced motion
  const fill = () =>
    page.eval(`
      const row = document.querySelector(${JSON.stringify(ROW)});
      if (!row) return null;
      return { found: row.classList.contains('is-found'), animation: getComputedStyle(row).animationName, running: row.getAnimations().some((a) => a.animationName === 'setting-found') };
    `);
  const typeQuery = async (text) => {
    await page.focus(FIELD);
    await page.type(text);
  };

  try {
    await page.reduceMotion(false);
    await page.viewport(1440, 900);

    // ---- Desktop: the field heads the settings nav, and `/` reaches it from the page ----
    await page.goto('/settings/general', 1200);
    await page.waitFor(`return !!document.querySelector('.settings-nav ${FIELD}') && document.querySelectorAll('.settings-nav [role=tab]').length === 8`, { label: 'the search above the eight groups' });
    check(
      await page.eval(`const i = document.querySelector(${JSON.stringify(FIELD)}); return i.getAttribute('aria-label') === 'Search settings' && i.placeholder === 'Search settings'`),
      'the field is named and says what it searches',
    );
    await page.eval('document.activeElement?.blur(); return true');
    await page.key('/');
    check(await page.eval(`return document.activeElement === document.querySelector(${JSON.stringify(FIELD)})`), '`/` focuses the search');

    // ---- A query lists results in the groups' place, the group above each label ----
    await page.type('concurrent');
    await page.waitFor(`return !!document.querySelector('.settings-results [role=option]')`, { label: 'results for "concurrent"' });
    check(await page.eval(`return document.querySelector('.settings-nav [role=tablist]')?.hidden === true`), 'the groups are hidden while searching');
    check((await labels())[0] === 'Concurrent runs', `the setting's own label comes first (${(await labels()).join(', ')})`);
    check(
      await page.eval(`return document.querySelector('.settings-results [role=option] .settings-result-group')?.textContent === 'Runs & spend'`),
      'each result names its group',
    );
    check(
      await page.eval(`const i = document.querySelector(${JSON.stringify(FIELD)}); return i.getAttribute('aria-expanded') === 'true' && i.getAttribute('aria-activedescendant') === document.querySelector('.settings-results [role=option][aria-selected=true]')?.id`),
      'the field points at the active result',
    );

    // ---- Escape clears and keeps the focus; the groups come back ----
    await page.key('Escape');
    await page.waitFor(`return !document.querySelector('.settings-results') && document.querySelector('.settings-nav [role=tablist]')?.hidden === false`, { label: 'Escape gives the groups back' });
    check((await query()) === '', 'Escape clears the query');
    check(await page.eval(`return document.activeElement === document.querySelector(${JSON.stringify(FIELD)})`), 'the field keeps the focus after Escape');

    // ---- No match says so, in words, and to a screen reader ----
    await page.type('zzqxv');
    await page.waitFor(`return (document.querySelector('.settings-results-none')?.textContent ?? '').includes('No setting matches')`, { label: 'the no-match line' });
    check(
      await page.eval(`return (document.querySelector('.settings-search [role=status]')?.textContent ?? '').includes('zzqxv')`),
      'the empty result is announced',
    );
    await page.key('Escape');

    // ---- ↑ ↓ move across results; Enter opens the active one ----
    await page.type('run');
    await page.waitFor(`return document.querySelectorAll('.settings-results [role=option]').length > 1`, { label: 'several results for "run"' });
    const first = await page.eval(`return document.querySelector('.settings-results [role=option][aria-selected=true]')?.id ?? null`);
    await page.key('ArrowDown');
    const second = await page.eval(`return document.querySelector('.settings-results [role=option][aria-selected=true]')?.id ?? null`);
    check(first !== null && second !== null && first !== second, '↓ moves to the next result');
    await page.key('ArrowUp');
    check((await page.eval(`return document.querySelector('.settings-results [role=option][aria-selected=true]')?.id ?? null`)) === first, '↑ moves back');
    await page.key('Escape');

    await page.type('concurrent runs');
    await page.waitFor(`return document.querySelector('.settings-results [role=option][aria-selected=true] .settings-result-label')?.textContent === 'Concurrent runs'`, { label: 'Concurrent runs is the active result' });
    await page.key('Enter');
    await page.waitFor(`return location.pathname === '/settings/runs'`, { label: 'Enter opens Runs & spend' });
    await page.waitFor(`return !!document.querySelector(${JSON.stringify(`${ROW}.is-found`)})`, { label: 'the row is marked as found' });
    check((await path()) === '/settings/runs#runs', `the address names the section (${await path()})`);
    check(await focusInRow(), "the row's control has the focus");
    check(await focusOnControl(), 'the focus is on the number field itself, not on its Decrease button');
    check((await query()) === '', 'opening a result clears the query');
    const full = await fill();
    check(full?.animation === 'setting-found' && full.running, `the row is filled and the fill fades (${JSON.stringify(full)})`);
    check(
      await page.eval(`const r = document.querySelector(${JSON.stringify(ROW)}).getBoundingClientRect(); return r.top >= 0 && r.bottom <= innerHeight`),
      'the row is scrolled into view',
    );

    // ---- Under reduced motion the row is still marked, and nothing moves ----
    await page.reduceMotion(true);
    await page.goto('/settings/general', 1200);
    await typeQuery('concurrent');
    await page.waitFor(`return !!document.querySelector('.settings-results [role=option]')`, { label: 'results again' });
    await page.key('Enter');
    await page.waitFor(`return !!document.querySelector(${JSON.stringify(`${ROW}.is-found`)})`, { label: 'the row found under reduced motion' });
    const still = await fill();
    check(still?.animation === 'none' && !still.running, `no fill animation under reduced motion (${JSON.stringify(still)})`);
    check(await focusInRow(), 'the control still takes the focus under reduced motion');
    await page.reduceMotion(false);

    // ---- Phone: the field heads the group list; results replace the cells; a tap opens the row ----
    await page.viewport(390, 844);
    await page.emulateTouch(true);
    await page.goto('/settings', 1200);
    await page.waitFor(`return !!document.querySelector('.settings-phone ${FIELD}') && document.querySelectorAll('.settings-cells .settings-cell').length === 8`, { label: 'the phone list: search, then eight cells' });
    check(
      await page.eval(`return parseFloat(getComputedStyle(document.querySelector(${JSON.stringify(FIELD)})).fontSize) >= 16`),
      'the field is 16 px on a phone, so the browser does not zoom',
    );
    await typeQuery('concurrent');
    await page.waitFor(`return !!document.querySelector('.settings-phone .settings-results [role=option]') && !document.querySelector('.settings-cells')`, { label: 'results in place of the cells' });
    check(
      await page.eval(`return [...document.querySelectorAll('.settings-results [role=option]')].every((o) => o.getBoundingClientRect().height >= 44)`),
      'each result is a 44 px target',
    );
    await page.click('.settings-results [role=option]', 'Concurrent runs', 800);
    await page.waitFor(`return location.pathname === '/settings/runs'`, { label: 'a tap opens Runs & spend' });
    await page.waitFor(`return !!document.querySelector(${JSON.stringify(`${ROW}.is-found`)})`, { label: 'the row found on a phone' });
    check(await focusInRow(), "the row's control has the focus on a phone");
    check((await page.text('.phone-head, .settings-phone-title')).includes('Runs & spend'), 'the group is the screen on a phone');

    // Escape clears on a phone as well
    await page.goto('/settings', 1200);
    await typeQuery('theme');
    await page.waitFor(`return !!document.querySelector('.settings-phone .settings-results')`, { label: 'phone results for "theme"' });
    await page.key('Escape');
    await page.waitFor(`return !document.querySelector('.settings-results') && document.querySelectorAll('.settings-cells .settings-cell').length === 8`, { label: 'Escape gives the cells back on a phone' });
  } finally {
    await page.emulateTouch(false).catch(() => {});
    await page.reduceMotion(false).catch(() => {});
    await page.viewport(1440, 900).catch(() => {});
  }
};
