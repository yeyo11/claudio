// Command palette: keyboard open, fuzzy search, Enter to navigate, theme commands, recents, Esc.
export default async ({ page, check }) => {
  await page.goto('/', 1500);
  await page.key('k', 2);
  await page.waitFor(`return !!document.querySelector('[role=dialog][aria-label="Command palette"]')`, { label: 'palette open' });
  await page.type('mcp');
  await page.sleep(300);
  check((await page.eval(`return document.querySelector('.palette-option-title')?.textContent`)) === 'MCP servers', 'best match first');
  await page.key('Enter');
  // The palette reads the settings registry: "MCP servers" is the section of Settings → Connections
  // and the row opening its editor, both titled the same, and either lands on the servers
  await page.waitFor(`const at = location.pathname + location.hash; return at === '/settings/connections#mcp' || at === '/settings/connections/mcp'`, { label: 'navigated to MCP servers' });
  check((await page.eval(`return location.search`)) === '', 'the address is a path, with no ?tab=');
  await page.waitFor(`return !document.querySelector('.palette')`, { label: 'palette closes after running a command (exit animation)' });

  await page.key('k', 2);
  await page.type('light theme');
  await page.sleep(300);
  await page.key('Enter');
  await page.waitFor(`return document.documentElement.dataset.theme === 'light'`, { label: 'theme command applied' });
  await page.waitFor(`return !document.querySelector('.palette')`, { label: 'palette closed' });

  await page.key('k', 2);
  await page.sleep(300);
  check((await page.eval(`return document.querySelector('.palette-group')?.textContent`)) === 'Recent', 'recent commands listed first');
  await page.key('Escape');
  await page.waitFor(`return !document.querySelector('.palette')`, { label: 'Esc closes the palette' });
  await page.eval(`localStorage.removeItem('claudio-theme'); localStorage.removeItem('claudio-palette-recent'); return true`);
};
