// The status bar and the account view (docs/plans/regression-fixes-2026-10-29.md, C4, report §2.11):
// the account chip names the account the overview's view says is in use, and a reading another
// account sent never shows on it. Two token accounts of the fake CLI, one preferred.
// The spec removes the accounts it added and puts the settings back.

export const fakeCli = true;
export const timeout = 60_000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export default async ({ page, api, check }) => {
  const settings = (await api.get('/accounts/settings')).body;
  const added = [];
  try {
    for (const alias of ['e2e-bar-one', 'e2e-bar-two']) {
      const made = await api.post('/accounts/token', { kind: 'token', alias, secret: `fake-room-${alias}` });
      check(made.status === 201, `${alias} is added (${made.status})`);
      added.push(made.body.id);
    }
    const preferred = added[1];
    const put = await api.put('/accounts/settings', { preferred });
    check(put.status === 200 && put.body.preferred === preferred, `the second account is preferred (${put.status})`);

    let view = null;
    for (let i = 0; i < 20; i++) {
      view = (await api.get('/overview')).body?.accounts ?? null;
      if (view?.inUse?.id === preferred) break;
      await sleep(250);
    }
    check(view?.inUse?.id === preferred, `the overview's account in use is the preferred one (${view?.inUse?.id})`);
    const auth = (await api.get('/auth')).body;
    check(auth?.inUse?.id === view?.inUse?.id, 'GET /auth names the same account in use as the overview');

    await page.goto('/', 1500);
    await page.waitFor(`return !!document.querySelector('.statusbar')`, { label: 'the status bar' });
    const label = view?.inUse?.label ?? '';
    await page.waitFor(`return [...document.querySelectorAll('.statusbar a[href="/accounts"]')].some((a) => a.innerText.includes(${JSON.stringify(label)}))`, {
      label: 'the account chip names the account in use',
    });
    check(await page.eval(`return (document.querySelector('.statusbar-conn')?.innerText ?? '').includes(${JSON.stringify(label)})`), 'the connection item names the same account');
    check(!(await page.eval(`return document.querySelector('.statusbar')?.innerText.toLowerCase().includes('limit reached')`)), 'no account at its limit, so the bar says none is');
  } finally {
    for (const id of added) await api.del(`/accounts/${id}`).catch(() => {});
    await api.put('/accounts/settings', settings).catch(() => {});
  }
};
