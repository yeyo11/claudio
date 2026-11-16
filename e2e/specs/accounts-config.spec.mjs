// The account configuration and project rule screens (T10 of
// docs/plans/account-configuration-and-project-rules.md), against the sandbox's own config dir:
// an account card reads its configuration's state, a conflict is settled with "Use shared" (the
// account's own copy kept aside), the mode switch says what it copies before it does, and a
// project's settings set its account rule (allowed accounts, preferred account, reserve), which
// the Accounts page then names on the reserved account's card, and a new account added with
// "Allow it on the projects with a rule" joins the rule (D7).
//
// The spec writes only into the sandbox (`dirs.configDir`, `dirs.dataDir`), and removes the
// accounts, the project and the rule it made.
import { existsSync, lstatSync, mkdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

export const fakeCli = true;
export const timeout = 120_000;

/** The text of the account card whose name is `name`, or '' */
const cardText = (name) => `return [...document.querySelectorAll('.account-card')].find((c) => c.querySelector('.account-email')?.textContent === ${JSON.stringify(name)})?.innerText ?? ''`;

export default async ({ page, api, check, dirs }) => {
  const added = [];
  const made = [];
  let projectId = null;
  try {
    // The shared side: a settings file and an agent-memory dir in the default config dir
    // A shard may run this spec first, before anything made the sandbox's config dir
    mkdirSync(dirs.configDir, { recursive: true });
    const settingsFile = join(dirs.configDir, 'settings.json');
    if (!existsSync(settingsFile)) {
      writeFileSync(settingsFile, '{}\n');
      made.push(settingsFile);
    }
    const memory = join(dirs.configDir, 'agent-memory');
    if (!existsSync(memory)) {
      mkdirSync(memory, { recursive: true });
      made.push(memory);
    }

    const a = await api.post('/accounts/token', { kind: 'token', alias: 'e2e-config-a', secret: 'fake-room-config-a' });
    const b = await api.post('/accounts/token', { kind: 'token', alias: 'e2e-config-b', secret: 'fake-room-config-b' });
    check(a.status === 201 && b.status === 201, `two token accounts are added (${a.status}, ${b.status})`);
    added.push(a.body.id, b.body.id);

    // ---------- a conflict, settled with "Use shared" ----------
    // Account B's agent memory becomes a real dir with a note in it: something a link should be, which Claudio will not decide alone
    const own = join(dirs.dataDir, 'accounts', b.body.id, 'agent-memory');
    if (existsSync(own) && lstatSync(own).isSymbolicLink()) unlinkSync(own);
    mkdirSync(own, { recursive: true });
    writeFileSync(join(own, 'note.md'), 'what this account remembers\n');
    const listed = (await api.get('/accounts')).body;
    const bConfig = listed.find((x) => x.id === b.body.id)?.config;
    check(bConfig?.state === 'conflict', `the account with its own agent memory reads a conflict (${JSON.stringify(bConfig?.items?.find((i) => i.name === 'agent-memory'))})`);

    await page.goto('/accounts', 1500);
    await page.waitFor(`const t=(()=>{${cardText('e2e-config-a')}})();return t.includes('Configuration') && t.includes('Shared') && t.includes('In sync')`, { label: 'the shared account in sync', timeout: 30_000 });
    await page.waitFor(`const t=(()=>{${cardText('e2e-config-b')}})();return t.includes('Conflict') && t.includes('agent-memory') && t.includes('This account: its own folder') && t.includes('Shared: the history every account uses')`, {
      label: 'the conflict read in words on its card',
    });
    await page.click('button[aria-label="Use shared agent-memory on e2e-config-b"]', undefined, 800);
    await page.waitFor(`return [...document.querySelectorAll('.dialog')].some((d) => d.innerText.includes('.claudio-own/') && d.innerText.includes('Nothing is deleted'))`, { label: 'the question says where the own copy is kept' });
    await page.click('.dialog .btn-primary', 'Use shared', 800);
    await page.waitFor(`const t=(()=>{${cardText('e2e-config-b')}})();return t.includes('In sync') && !t.includes('Conflict')`, { label: 'the account in sync after Use shared' });
    const settled = (await api.get('/accounts')).body.find((x) => x.id === b.body.id)?.config;
    check(settled?.state === 'ok' && settled.keptAside.length === 1, `the own copy is kept aside, never deleted (${JSON.stringify(settled?.keptAside)})`);
    check(lstatSync(own).isSymbolicLink(), 'agent-memory is linked to the shared one');

    // ---------- the mode switch ----------
    // A Radix menu opens from the keyboard; a synthetic click does not open it
    await page.focus('button[aria-label="More actions for e2e-config-a"]');
    await page.press('Enter');
    await page.waitFor(`return !!document.querySelector('[role=menu]')`, { label: "the account's menu" });
    await page.click('[role=menuitem]', 'Use its own configuration…', 800);
    await page.waitFor(`return [...document.querySelectorAll('.dialog')].some((d) => d.innerText.includes('Copied into the account') && d.innerText.includes('settings.json') && d.innerText.includes('A copy of the shared one'))`, {
      label: 'the dialog says what is copied before the switch',
    });
    await page.click('.dialog .btn-primary', 'Use own configuration', 1000);
    await page.waitFor(`const t=(()=>{${cardText('e2e-config-a')}})();return t.includes('Own') && t.includes('In sync')`, { label: 'the account reads Own after the switch' });
    const switched = (await api.get('/accounts')).body.find((x) => x.id === a.body.id)?.config;
    check(switched?.mode === 'independent', `the account is independent (${switched?.mode})`);
    check(!lstatSync(join(dirs.dataDir, 'accounts', a.body.id, 'settings.json')).isSymbolicLink(), 'its settings.json is its own copy, no longer a link');

    // ---------- a project's account rule ----------
    const project = await api.post('/projects', { name: 'e2e-config-rule' });
    check(project.status === 201 || project.status === 200, `a project is created (${project.status})`);
    projectId = project.body.id;
    await page.goto(`/?project=${projectId}&view=settings`, 1500);
    await page.click('.project-rule-card button', 'Add a rule', 1000);
    await page.waitFor(`return document.querySelector('.project-rule-card')?.innerText.includes('Accounts allowed')`, { label: 'the rule rows after Add a rule' });
    const ruleOf = async () => (await api.get('/accounts/policies')).body.find((p) => p.projects.includes(projectId)) ?? null;
    check((await ruleOf()) !== null, 'Add a rule creates a policy for the project');

    // B may not work here: its switch off
    await page.eval(`[...document.querySelectorAll('.project-rule-accounts label')].find((l) => l.textContent.includes('e2e-config-b'))?.querySelector('button')?.click(); return true;`);
    let rule = null;
    for (let i = 0; i < 20; i++) {
      rule = await ruleOf();
      if (rule?.order && !rule.order.includes(b.body.id)) break;
      await sleep(250);
    }
    check(Array.isArray(rule?.order) && rule.order.includes(a.body.id) && !rule.order.includes(b.body.id), `the rule allows every account but the one turned off (${JSON.stringify(rule?.order)})`);

    await page.select('.project-rule-card button[aria-label="Preferred account"]', 'e2e-config-a');
    for (let i = 0; i < 20 && rule?.preferred !== a.body.id; i++) {
      await sleep(250);
      rule = await ruleOf();
    }
    check(rule?.preferred === a.body.id, `the preferred account is saved (${rule?.preferred})`);

    await page.eval(`[...document.querySelectorAll('.project-rule-card label')].find((l) => l.textContent.includes('Keep headroom'))?.querySelector('button')?.click(); return true;`);
    for (let i = 0; i < 20 && !rule?.reserve; i++) {
      await sleep(250);
      rule = await ruleOf();
    }
    check(rule?.reserve?.percent === 10, `the reserve starts at 10 points (${JSON.stringify(rule?.reserve)})`);
    await page.waitFor(`return document.querySelector('.project-rule-card')?.innerText.includes('other projects leave e2e-config-a at')`, { label: 'the reserve says what it does to other projects' });

    await page.goto('/accounts', 1500);
    await page.waitFor(`const t=(()=>{${cardText('e2e-config-a')}})();return t.includes('Keeps headroom for e2e-config-rule while it has work')`, { label: 'the reserved account names the project on its card' });

    // ---------- D7: a new account is asked whether it joins the rules ----------
    await page.click('.accounts-page button', 'Add an account', 800);
    await page.waitFor(`return [...document.querySelectorAll('.dialog')].some((d) => d.innerText.includes('Allow it on the projects with a rule') && d.innerText.includes('does not work there'))`, {
      label: 'the Add-account dialog asks about the project rules',
    });
    await page.click('.dialog [role=radio]', 'API key', 300);
    await page.fill('.dialog input[placeholder="work"]', 'e2e-config-c');
    await page.fill('.dialog input[type=password]', 'fake-room-config-c');
    await page.eval(`[...document.querySelectorAll('.dialog label')].find((l) => l.textContent.includes('Allow it on the projects with a rule'))?.querySelector('button')?.click(); return true;`);
    await page.click('.dialog .btn-primary', 'Add account', 800);
    let c = null;
    for (let i = 0; i < 20 && !c; i++) {
      c = (await api.get('/accounts')).body.find((x) => x.alias === 'e2e-config-c') ?? null;
      if (!c) await sleep(250);
    }
    check(c !== null, 'the account is added from the dialog');
    if (c) added.push(c.id);
    for (let i = 0; i < 20 && !rule?.order?.includes(c?.id); i++) {
      await sleep(250);
      rule = await ruleOf();
    }
    check(rule?.order?.includes(c?.id) && !rule.order.includes(b.body.id) && rule.preferred === a.body.id && rule.reserve?.percent === 10, `the new account joins the rule, which keeps the rest (${JSON.stringify(rule)})`);
  } finally {
    if (projectId) {
      const rule = (await api.get('/accounts/policies').catch(() => ({ body: [] }))).body?.find?.((p) => p.projects.includes(projectId));
      if (rule) await api.del(`/accounts/policies/${rule.id}`).catch(() => {});
      await api.del(`/projects/${projectId}`).catch(() => {});
    }
    for (const id of added) await api.del(`/accounts/${id}`).catch(() => {});
    for (const path of made.reverse()) rmSync(path, { recursive: true, force: true });
  }
};
