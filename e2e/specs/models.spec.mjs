// The models a person may pick. Claudio keeps no list of its own: the only list is the one the CLI
// answers `initialize` with (no turn, no tokens), read per account at boot and when the CLI changes,
// already filtered by what the account's subscription allows, in the order and with the names of
// `/model`.
import { writeFileSync } from 'node:fs';

// The fake Claude is the one agent, so a New chat starts on Claude and its models
export const fakeCli = true;

const LISTED = [
  { value: 'default', resolvedModel: 'claude-e2e-5', displayName: 'Default (recommended)', description: 'E2E 5 · the one this account may run' },
  { value: 'claude-e2e-5[1m]', resolvedModel: 'claude-e2e-5[1m]', displayName: 'E2E (1M)', description: 'E2E 5 with a million tokens' },
  // Resolves to the same model as `default`: `/model` lists both, and so does the picker
  { value: 'e2e', resolvedModel: 'claude-e2e-5', displayName: 'E2E', description: 'E2E 5' },
];

export default async ({ page, api, check, fakeCli: fake }) => {
  // The fake answers `initialize` with the scripts file's `@models`; asking again reads it now
  writeFileSync(fake.scripts, JSON.stringify({ '@models': LISTED }));
  try {
    await listed({ page, api, check });
  } finally {
    // The list is stored per account: the specs after this one read the fake's own again
    writeFileSync(fake.scripts, '{}');
    await api.get('/accounts/default/models?refresh=1');
  }
};

async function listed({ page, api, check }) {
  const read = await api.get('/accounts/default/models?refresh=1');
  check(read.status === 200, `the list is read from the CLI (${read.status})`);

  const values = (models) => (models ?? []).map((m) => m.value).join(',');
  check(values(read.body) === 'default,claude-e2e-5[1m],e2e', `the CLI's order, each value once, \`default\` beside the model it resolves to (got ${values(read.body)})`);
  const overview = (await api.get('/overview')).body?.system?.models ?? [];
  check(values(overview) === values(read.body), 'the overview carries the default account\'s list as it is');
  check(!overview.some((m) => ['fable', 'opus', 'sonnet', 'haiku'].includes(m.value)), 'nothing Claudio made up stands beside it');

  await page.goto('/chats/new', 1500);
  await page.click('.composer-status', undefined, 500);
  await page.eval(`const i=[...document.querySelectorAll('input')].find(i=>/model/i.test(i.getAttribute('aria-label')||''));if(!i)return false;i.focus();i.click();return true;`);
  await page.waitFor(`return document.querySelectorAll('[role=listbox] [role=option]').length > 0`, { label: 'the model suggestions' });
  const shown = await page.eval(`return [...document.querySelectorAll('[role=option]')].map(o=>o.innerText.replace(/\\s+/g,' ').trim())`);
  check(shown.length === 3, `one row per value the CLI lists (got ${shown.join(' | ')})`);
  check(shown[0]?.startsWith('Default (recommended)') && shown.some((o) => o.startsWith('E2E E2E 5')), "the picker shows the CLI's names and lines, `default` and `e2e` both");
}
