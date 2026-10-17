// The daily spend cap (docs/plans/agent-run-improvements.md, idea 13): a cap set in Settings shows
// in the status bar and on the Usage page, in both themes, and turning it off takes it away again.
// The suite shares one wrapper, so the cap is cleared at the end even when an assertion fails.
// Written with the task and not run by it: the integrator runs the suite once, on the merged branch.
export const timeout = 120_000;

export default async ({ page, api, check }) => {
  const panelText = () => page.text('[role=tabpanel]');
  const statusBar = () => page.eval(`return document.querySelector('.statusbar .spend')?.innerText ?? null`);
  const themeIs = (theme) => page.waitFor(`return document.documentElement.dataset.theme === ${JSON.stringify(theme)}`, { label: `the ${theme} theme` });

  try {
    // No cap: nothing in the status bar, and the card says it is off
    await api.put('/settings/app', { dailySpendCapUsd: null });
    await page.goto('/settings?tab=security', 1500);
    await page.waitFor(`return (document.querySelector('[role=tabpanel]')?.innerText ?? '').includes('Daily spend cap')`, { label: 'the cap card', timeout: 60_000 });
    check((await statusBar()) === null, 'with no cap the status bar draws no cap item');
    const off = await panelText();
    check(off.includes('Limit daily spend'), 'the card offers the switch');
    check(off.includes('On subscription accounts it is what it would cost on the API, not what you pay.'), 'the card says what the figure is on a subscription');

    // Turn it on, give it an amount, save. By its words: the tab's first switch is Read-only mode's,
    // and flipping that one would refuse every write after this spec
    check(await page.eval(`const l=[...document.querySelectorAll('[role=tabpanel] label')].find(l=>l.textContent.includes('Limit daily spend'));const s=l?.querySelector('[role=switch]');if(!s)return false;s.click();return true`), 'the cap switch is found by its words');
    await page.waitFor(`return !!document.querySelector('[role=tabpanel] input[type=number][aria-label="Cap per day, in USD"]')`, { label: 'the amount field' });
    await page.eval(`
      const input = document.querySelector('[role=tabpanel] input[type=number][aria-label="Cap per day, in USD"]');
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      set.call(input, '20');
      input.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    `);
    // The cap's own Save: every settings card on the tab has one
    await page.click('[role=tabpanel] form:has(input[aria-label="Cap per day, in USD"]) button[type=submit]', 'Save', 800);
    await page.waitFor(`return !!document.querySelector('.statusbar .spend')`, { label: 'the cap in the status bar', timeout: 30_000 });
    check((await api.get('/settings/app')).body.dailySpendCapUsd === 20, 'the cap was saved');
    const bar = await statusBar();
    check(/daily cap/i.test(bar ?? '') && /0\s?%/.test(bar ?? ''), `the status bar says the cap and its share in words (${bar})`);

    // Both themes: the item is there, readable and not painted with a status colour below 60 %
    for (const theme of ['dark', 'light']) {
      await page.eval(`localStorage.setItem('claudio-theme', ${JSON.stringify(theme)}); return true`);
      await page.goto('/usage', 1200);
      await themeIs(theme);
      await page.waitFor(`return !!document.querySelector('.statusbar .spend')`, { label: `the cap in the status bar (${theme})` });
      const tone = await page.eval(`
        const item = document.querySelector('.statusbar .spend');
        return { classes: item.className, color: getComputedStyle(item).color, background: getComputedStyle(item.closest('.statusbar')).backgroundColor };
      `);
      check(!/statusbar-(warn|bad)/.test(tone.classes), `a cap far from reached is neutral in ${theme}`);
      check(tone.color !== tone.background, `the item is readable against the bar in ${theme}`);
      await page.waitFor(`return (document.querySelector('.usage-cap')?.innerText ?? '').includes('Daily cap')`, { label: `the Usage line (${theme})` });
      check((await page.text('.usage-cap')).includes('of'), `the Usage page shows today against the cap in ${theme}`);
    }

    // The cap is the person's, so the same endpoint refuses a value it cannot keep
    check((await api.put('/settings/app', { dailySpendCapUsd: 0 })).status === 400, 'a cap of zero is refused');
  } finally {
    await api.put('/settings/app', { dailySpendCapUsd: null }).catch(() => {});
    await page.eval(`localStorage.removeItem('claudio-theme'); return true`).catch(() => {});
  }
};
