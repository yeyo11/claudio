// The machine's figures: the Machine widget on the Home overview, and the history page under
// Settings → Runs & spend → Machine. The server stores a reading as it starts and then once a
// minute, so the page has at least one point to draw; the figures themselves are the host's own
// (the specs never assert a number, only that each one is a figure or a dash and has its word).

const textOf = (selector) => `return document.querySelector(${JSON.stringify(selector)})?.textContent ?? ''`;

export default async ({ page, api, check }) => {
  // The API: a reading now, the chats' usage and the stored history, in the shapes the page reads
  const load = await api.get('/system/load');
  check(load.status === 200 && typeof load.body.limits?.memoryPressure === 'number', 'the load reading repeats the admission limits it judged by');
  const history = await api.get('/system/history');
  check(history.status === 200 && Array.isArray(history.body), 'the history route answers a list');
  check((await api.get('/system/history?since=not-a-date')).status === 400, 'a range that is not a date is refused');

  // The widget is part of both default layouts and says whether the machine admits a chat
  await page.goto('/?project=all', 1200);
  await page.waitFor(`return !!document.querySelector('main [data-widget=machine] .machine-card')`, { label: 'the Machine widget' });
  await page.waitFor(`return !!document.querySelector('main [data-widget=machine] .machine-figures, main [data-widget=machine] .kpi-sub')`, { label: 'its figures or its note' });
  const widget = await page.text('main [data-widget=machine]');
  check(widget.includes('Machine'), 'the widget names itself');
  if (load.body.memory) {
    check(/Admits chats|No new chats/.test(widget), `the admission is a word, not a colour alone (${widget.slice(0, 120)})`);
    check(await page.eval(`return !!document.querySelector('main [data-widget=machine] .meter-track')`), 'the memory has its bar');
    check(/Low|Rising|High/.test(widget), 'the pressure has its word');
  } else {
    check(widget.includes('does not expose its figures'), 'a machine without /proc says so');
  }

  // The history page: reached from the Runs & spend group's row, drawn from the stored readings
  await page.goto('/settings/runs', 1200);
  await page.waitFor(`return !!document.querySelector('#machine a')`, { label: 'the Machine row' });
  await page.click('#machine a', undefined, 800);
  await page.waitFor(`return location.pathname === '/settings/runs/machine'`, { label: 'the Machine page' });
  if (load.body.memory) {
    await page.waitFor(`return document.querySelectorAll('.machine-chart').length === 3 || !!document.querySelector('.empty')`, { label: 'the charts or their empty state' });
    const sampled = (await api.get('/system/history')).body.length > 0;
    if (sampled) check(await page.eval(`return document.querySelectorAll('.machine-chart').length === 3`), 'memory, pressure and load each have a chart');
    check(await page.eval(`return document.querySelectorAll('main [role=radio]').length === 4`), 'four ranges to choose from');
    check(await page.eval(`return !!document.querySelector('.machine-chart svg[role=img] desc')`), 'a chart has a description a screen reader reads');
  }
  check((await page.eval(textOf('main h2'))).includes('Machine'), 'the page is titled Machine');
  check(await page.eval(`return document.documentElement.scrollWidth <= window.innerWidth`), 'nothing scrolls sideways');
};
