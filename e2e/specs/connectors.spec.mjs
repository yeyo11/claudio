// Settings → Connections → Connectors (docs/plans/settings-ia.md §6.3). The sandbox has no claude.ai
// login, so the CLI lists no connectors (or fails to answer): what has to hold either way is that the
// section says which of the two it is instead of showing a blank, says what a person must do to
// authorise one, and says plainly what is out of reach. It was a page of its own: /connectors lands here.
export default async ({ page, api, check }) => {
  // The shell draws every navigation group at once: once it has links, it has all of them
  await page.goto('/', 0);
  const nav = await page.waitFor(`const links = [...document.querySelectorAll('#sidebar nav a')]; return links.length > 0 && links.map((a) => a.getAttribute('href'))`, { label: 'the navigation', timeout: 60_000 });
  check(!nav.includes('/connectors'), 'Connectors left the navigation for Settings → Connections');

  await page.goto('/connectors', 1500);
  await page.waitFor(`return location.pathname + location.hash === '/settings/connections#connectors'`, { label: '/connectors lands on the Connectors section' });
  await page.waitFor(`return !!document.querySelector('#connectors .connectors-footnote')`, { label: 'the connectors overview', timeout: 60_000 });
  const text = await page.text('#connectors');

  // What the CLI has no command for is said in the section, in words, not left as a gap
  const unavailable = (await api.get('/connectors')).body.unavailable;
  check(unavailable.length === 2, 'the two things out of reach come from the server');
  const footnote = await page.text('#connectors .connectors-footnote');
  check(footnote.includes('out of Claudio’s reach'), `the section says what is out of reach (${footnote})`);
  for (const item of unavailable) check(footnote.includes(item.name), `the footnote names "${item.name}" (${footnote})`);

  // An empty list is never a silent one
  const failed = text.includes('The CLI could not list its connectors');
  const none = text.includes('No claude.ai connectors listed');
  const cards = await page.eval(`return document.querySelectorAll('#connectors .lrows .connector-row').length`);
  check(failed || none || cards > 0, 'the section shows connectors, says there are none, or says the CLI failed');
  if (none) {
    check(text.includes('How to authorise a connector'), 'with nothing connected the section says how to authorise one');
    check(text.includes('Not listed by the CLI'), 'it names the connectors the CLI did not list');
    const links = await page.eval(`return [...document.querySelectorAll('#connectors a[target=_blank]')].map((a) => a.rel)`);
    check(links.length >= 1 && links.every((rel) => rel.includes('noreferrer')), 'the instructions link out safely');
  }
  // A connector that is not authorised offers its instructions and no prepared prompt
  const offering = await page.eval(`return [...document.querySelectorAll('#connectors .lrows .connector-row')].filter((c) => /needs authorisation/i.test(c.innerText) && c.querySelector('.task-actions button:not([aria-label^="Authorise"])')).length`);
  check(offering === 0, 'a connector that needs authorisation offers no prepared prompt');

  // Asking the CLI again is a button, and the section survives it
  await page.click('#connectors button', 'Ask the CLI again', 300);
  await page.waitFor(`return [...document.querySelectorAll('#connectors button')].some((b) => b.textContent.includes('Ask the CLI again') && !b.disabled)`, { label: 'the refresh finished', timeout: 60_000 });
  check((await page.text('#connectors')).includes('out of Claudio’s reach'), 'the section is intact after asking again');
};
