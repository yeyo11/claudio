// Collaborators (docs/plans/collaborators.md, C4): three installs on one machine, each a wrapper of
// its own with its iroh endpoint on the minimal preset, bound to loopback (no relay, no discovery,
// no network). Ana is the main wrapper, Ben and Cleo are peers the harness starts for this spec.
//
// Ana turns Collaborators on, creates a group and invites Ben, who joins from his own page. Ana
// shares a project both have cloned (the same remote, so the same share key); a chat the fake CLI
// keeps working on Ana's machine shows live in Ben's Shared tab, read only, and stops moving under
// the motion levels. A project with no remote is linked by hand on Ben's side. Then Ana goes offline
// and Cleo joins through Ben (a relayed join); Ana accepts when she is back, and removes Cleo.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const fakeCli = true;
export const peers = ['ben', 'cleo'];
// Three wrappers, a join that waits out an unreachable owner, and every sync in between
export const timeout = 300_000;

const REMOTE = 'https://github.com/acme/api.git';
const PROMPT = 'e2e-collab: fix the build';
const RELEASE = '.e2e-collab-release';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function until(probe, what, ms = 30_000) {
  const end = Date.now() + ms;
  for (;;) {
    const value = await probe();
    if (value) return value;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(250);
  }
}

/** A clone of the team's repository: the remote is what makes two installs' projects the same one */
function clone(dir) {
  mkdirSync(dir, { recursive: true });
  execFileSync('git', ['init', '-q', dir]);
  execFileSync('git', ['-C', dir, 'remote', 'add', 'origin', REMOTE]);
  writeFileSync(join(dir, 'README.md'), '# api\n');
}

/** Every loop under `root` still running: an element or its ::before/::after, shown, repeating */
const loops = (root) => `
  const found = [];
  for (const el of [...document.querySelectorAll('${root}'), ...document.querySelectorAll('${root} *')]) {
    if (el.getClientRects().length === 0) continue;
    for (const pseudo of [null, '::before', '::after']) {
      const s = getComputedStyle(el, pseudo);
      if (s.animationName === 'none') continue;
      const repeats = s.animationIterationCount.split(',').some((c) => c.trim() === 'infinite');
      const running = s.animationPlayState.split(',').some((p) => p.trim() === 'running');
      if (repeats && running) found.push(((el.className && el.className.toString()) || el.tagName).slice(0, 60) + (pseudo ?? ''));
    }
  }
  return found;`;

const text = (selector) => `return [...document.querySelectorAll(${JSON.stringify(selector)})].map((e) => e.innerText).join('\\n')`;

export default async ({ page, api, check, dirs, fakeCli: fake, peers: { ben, cleo } }) => {
  const anaDir = join(dirs.workspaceDir, 'e2e-collab-api');
  const benDir = join(ben.dirs.workspaceDir, 'api');
  const savedScripts = existsSync(fake.scripts) ? readFileSync(fake.scripts, 'utf8') : null;
  const projects = [];
  let chatId = null;
  let groupId = null;

  /** Bound: an invite needs the endpoint's ticket, and a join needs the host up */
  const ready = (client, who) =>
    until(async () => {
      const { body } = await client.get('/collaborators');
      return body && !['off', 'starting'].includes(body.connection) ? body : null;
    }, `${who}'s endpoint to bind`);
  const groupOf = async (client) => (await client.get('/collaborators/groups')).body?.groups?.find((g) => g.id === groupId);
  const memberNames = async (client) => ((await groupOf(client))?.members ?? []).map((m) => m.name).sort();

  try {
    // ---------- two clones of one repository, one on each machine ----------
    clone(anaDir);
    clone(benDir);
    const anaProject = await api.post('/projects/import', { path: anaDir, name: 'e2e-collab-api' });
    check(anaProject.status === 201, `Ana's project (${anaProject.status} ${JSON.stringify(anaProject.body)})`);
    projects.push(anaProject.body.id);
    const benProject = await ben.api.post('/projects/import', { path: benDir, name: 'api' });
    check(benProject.status === 201, `Ben's project (${benProject.status} ${JSON.stringify(benProject.body)})`);

    // ---------- Ana turns Collaborators on and creates a group ----------
    check((await api.put('/collaborators', { displayName: 'Ana' })).status === 200, 'Ana names herself');
    await page.goto('/collaborators', 1200);
    await page.click('[data-testid=collab-turn-on]', undefined, 800);
    await page.waitFor(`return !!document.querySelector('[data-testid=collab-turn-off]')`, { label: "Ana's You card" });
    await ready(api, 'Ana');
    await page.click('[data-testid=collab-create]', undefined, 600);
    await page.fill('[data-testid=collab-group-name]', 'Backend');
    await page.click('[data-testid=collab-create-submit]', undefined, 800);
    await page.waitFor(`return [...document.querySelectorAll('.collab-group')].some((g) => g.innerText.includes('Backend'))`, { label: 'the Backend group' });
    groupId = (await api.get('/collaborators/groups')).body.groups.find((g) => g.name === 'Backend')?.id;
    check(groupId, 'the group was created');

    // ---------- the invite, made as its dialog opens (Ana owns one group) ----------
    await page.click('button[data-testid=collab-invite]', undefined, 800);
    await page.waitFor(`return !!document.querySelector('div[data-testid=collab-invite] textarea')?.value`, { label: 'the invite text' });
    const invite = await page.eval(`return document.querySelector('div[data-testid=collab-invite] textarea').value`);
    check(invite.startsWith('claudio-invite:'), `an invite (${invite.slice(0, 24)}…)`);
    check(await page.eval(`return !!document.querySelector('[role=dialog] .collab-invite-code svg, [role=dialog] .collab-invite-code canvas, [role=dialog] .collab-invite-code img')`), 'the invite has its QR code');
    await page.key('Escape');

    // ---------- Ben joins from his own page ----------
    check((await ben.api.put('/collaborators', { enabled: true, displayName: 'Ben' })).status === 200, 'Ben turns Collaborators on');
    await ready(ben.api, 'Ben');
    await ben.page.goto('/collaborators', 1200);
    await ben.page.click('[data-testid=collab-join]', undefined, 600);
    await ben.page.fill('[data-testid=collab-join-invite]', invite);
    await ben.page.click('[data-testid=collab-join-submit]', undefined, 800);
    await ben.page.waitFor(`return document.querySelectorAll('.collab-group [data-testid=collab-member]').length === 2`, { label: "Ben's group lists Ana and Ben", timeout: 60_000 });
    check(JSON.stringify(await memberNames(api)) === '["Ana","Ben"]', `Ana's roster has Ben (${await memberNames(api)})`);

    // ---------- Ana shares the project from its Settings ----------
    await page.goto(`/?project=${anaProject.body.id}&view=settings`, 1200);
    await page.waitFor(`return [...document.querySelectorAll('.project-sharing label')].some((l) => l.innerText.includes('Share with Backend'))`, { label: 'the Sharing section' });
    check((await page.eval(text('.project-sharing'))).includes('github.com/acme/api'), 'the share key comes from the remote');
    await page.eval(`[...document.querySelectorAll('.project-sharing label')].find((l) => l.innerText.includes('Share with Backend')).querySelector('[role=switch]').click(); return true`);
    await until(async () => (await api.get(`/projects/${anaProject.body.id}/sharing`)).body?.groups?.includes(groupId), 'the project to be shared');

    // ---------- a chat at work on Ana's machine ----------
    writeFileSync(fake.scripts, JSON.stringify({ [PROMPT]: `say: Looking at the build\nhold: ${RELEASE}\nsay: The build is green`, '@transcript': true }));
    const chat = await api.post('/chats', { prompt: PROMPT, cwd: anaDir });
    check(chat.status === 201, `Ana's chat started (${chat.status} ${JSON.stringify(chat.body)})`);
    chatId = chat.body.id;

    // ---------- Ben reads it live, in his project's Shared tab ----------
    const shared = `/?project=${benProject.body.id}&view=shared`;
    const liveRow = `.shared-chats .crow.live-rail[data-id="${chatId}"]`;
    await ben.page.goto(shared, 1200);
    await ben.page.waitFor(`return !!document.querySelector(${JSON.stringify(liveRow)})`, { label: "Ana's chat, live, in Ben's Shared tab", timeout: 60_000 });
    check(await ben.page.eval(`return !!document.querySelector(${JSON.stringify(`${liveRow} .crow-spinner`)})`), 'the live row has the braille spinner');
    const rowText = await ben.page.eval(text(liveRow));
    check(rowText.includes('fix the build'), `the row is titled by its first prompt (${rowText})`);
    check((await ben.page.eval(`return document.querySelectorAll('.live-energy').length`)) === 0, 'a teammate’s chat never carries the energy border');
    // Only live things move, and they stop under every motion level
    check((await ben.page.eval(loops('.shared-chats'))).length > 0, 'the live row moves at full');
    for (const level of ['subtle', 'off']) {
      await ben.page.eval(`localStorage.setItem('claudio-motion', '${level}'); return true`);
      await ben.page.goto(shared, 1200);
      await ben.page.waitFor(`return !!document.querySelector(${JSON.stringify(liveRow)})`, { label: `the live row at ${level}` });
      const still = await ben.page.eval(loops('body'));
      check(still.length === 0, `the Shared tab: nothing repeats at ${level} (${still.join(', ')})`);
    }
    await ben.page.eval(`localStorage.removeItem('claudio-motion'); return true`);

    // Open: the transcript, read only, with no composer
    await ben.page.goto(`${shared}&chat=${chatId}`, 1200);
    await ben.page.waitFor(`return (document.querySelector('.shared-chat')?.innerText ?? '').includes('Looking at the build')`, { label: 'the copied transcript', timeout: 60_000 });
    check((await ben.page.eval(text('.shared-chat .read-only-bar'))).includes('Read only · from Ana'), 'the read-only bar names Ana');
    check(!(await ben.page.eval(`return !!document.querySelector('.composer, [data-composer-input]')`)), 'no composer on a teammate’s chat');
    // The turn ends on Ana's machine; what it said last reaches Ben's page
    writeFileSync(join(anaDir, RELEASE), '');
    await ben.page.waitFor(`return (document.querySelector('.shared-chat')?.innerText ?? '').includes('The build is green')`, { label: 'the end of the turn on Ben’s page', timeout: 60_000 });
    // Never mixed with Ben's own chats
    const benChats = (await ben.api.get('/chats')).body;
    check(!JSON.stringify(benChats ?? null).includes(chatId), "Ana's chat is not in Ben's own list");

    // ---------- a project with no remote, linked by hand ----------
    const notes = await api.post('/projects', { name: 'e2e-collab-notes' });
    check(notes.status === 201, `Ana's notes project (${notes.status})`);
    projects.push(notes.body.id);
    check((await api.put(`/projects/${notes.body.id}/sharing`, { groups: [groupId] })).status === 200, 'the notes are shared');
    const scratch = await ben.api.post('/projects', { name: 'scratch' });
    check(scratch.status === 201, `Ben's scratch project (${scratch.status})`);
    const notesRow = `[...document.querySelectorAll('[data-testid=collab-shared-project]')].find((r) => r.innerText.includes('e2e-collab-notes'))`;
    await ben.page.goto('/collaborators', 1200);
    await ben.page.waitFor(`return (${notesRow})?.innerText.includes('Not cloned here')`, { label: 'the notes, not cloned on Ben’s machine', timeout: 60_000 });
    await ben.page.eval(`[...${notesRow}.querySelectorAll('button')].find((b) => b.innerText.includes('Link to a local project')).click(); return true`);
    await ben.page.select('[role=dialog] [aria-label="Local project"]', 'scratch');
    await ben.page.click('[role=dialog] .btn', 'Link', 800);
    await ben.page.waitFor(`return !!(${notesRow})?.querySelector('a[aria-label="Open in scratch"]')`, { label: 'the notes, linked to scratch' });
    await ben.page.goto(`/?project=${scratch.body.id}&view=shared`, 1200);
    await ben.page.waitFor(`return (document.querySelector('.shared-view')?.innerText ?? '').includes('Ana')`, { label: "Ana's notes in scratch's Shared tab" });

    // ---------- a relayed join: Ana's invite names Ben, then Ana goes offline ----------
    const benId = (await ben.api.get('/collaborators')).body.endpointId;
    await until(async () => (await groupOf(api))?.members.find((m) => m.endpointId === benId)?.presence?.online, 'Ana to see Ben online');
    const relayed = await api.post(`/collaborators/groups/${groupId}/invites`);
    check(relayed.status === 201, `a second invite (${relayed.status})`);
    await page.goto('/collaborators', 1200);
    await page.click('[data-testid=collab-turn-off]', undefined, 800);
    await until(async () => (await api.get('/collaborators')).body?.connection === 'off', 'Ana to go offline');

    check((await cleo.api.put('/collaborators', { enabled: true, displayName: 'Cleo' })).status === 200, 'Cleo turns Collaborators on');
    await ready(cleo.api, 'Cleo');
    await cleo.page.goto('/collaborators', 1200);
    await cleo.page.click('[data-testid=collab-join]', undefined, 600);
    await cleo.page.fill('[data-testid=collab-join-invite]', relayed.body.text);
    await cleo.page.click('[data-testid=collab-join-submit]', undefined, 800);
    // Ana cannot be reached, so the request is left with Ben. The invite carries his id and ticket but
    // not his name, so Cleo's install can only say which member holds it by what the roster later says
    await cleo.page.waitFor(`return (document.querySelector('.collab-join-waiting')?.innerText ?? '').includes('Ana is offline. Your request has been left with')`, {
      label: 'Cleo told her request waits with a member',
      timeout: 90_000,
    });
    const held = (await cleo.api.get('/collaborators/groups')).body?.pendingJoins?.find((p) => p.groupId === groupId);
    check(held?.relayedBy?.endpointId === benId, `Ben holds Cleo's request (${JSON.stringify(held?.relayedBy)})`);
    await cleo.page.key('Escape');
    await cleo.page.waitFor(`return (document.querySelector('[data-testid=collab-pending-join]')?.innerText ?? '').includes('Backend')`, { label: "Cleo's pending join" });

    // Ana comes back: Ben hands her the request, and she accepts it
    await page.goto('/collaborators', 1200);
    await page.click('[data-testid=collab-turn-on]', undefined, 800);
    await page.waitFor(`return (document.querySelector('[data-testid=collab-join-request]')?.innerText ?? '').includes('relayed by Ben')`, { label: "Cleo's request, relayed by Ben", timeout: 90_000 });
    await page.click('[data-testid=collab-join-request] button', 'Accept', 800);
    await until(async () => JSON.stringify(await memberNames(cleo.api)) === '["Ana","Ben","Cleo"]', 'Cleo to hold the roster with herself in it', 60_000);
    await cleo.page.goto('/collaborators', 1200);
    await cleo.page.waitFor(`return document.querySelectorAll('.collab-group [data-testid=collab-member]').length === 3 && !document.querySelector('[data-testid=collab-pending-join]')`, { label: "Cleo's page: in the group, nothing pending" });

    // ---------- Ana removes Cleo ----------
    // One tab for three machines: back to Ana's
    await page.goto('/collaborators', 1200);
    await page.waitFor(`return document.querySelectorAll('.collab-group [data-testid=collab-member]').length === 3`, { label: "Ana's page lists three members" });
    // Opened the way a keyboard does: Radix opens a menu on pointerdown, never on a synthetic click
    await page.focus('button[aria-label="Actions for Cleo"]');
    await page.press('Enter');
    await page.click('[role=menuitem]', 'Remove', 600);
    await page.waitFor(`return (document.querySelector('[role=dialog]')?.innerText ?? '').includes('Remove Cleo from Backend?')`, { label: 'the removal confirmation' });
    await page.click('[role=dialog] button', 'Remove', 800);
    await page.waitFor(`return document.querySelectorAll('.collab-group [data-testid=collab-member]').length === 2`, { label: "Ana's page without Cleo" });
    await until(async () => JSON.stringify(await memberNames(ben.api)) === '["Ana","Ben"]', 'Ben to learn of the removal', 60_000);
  } finally {
    if (chatId) {
      writeFileSync(join(anaDir, RELEASE), '');
      await api.post(`/chats/${chatId}/stop`).catch(() => {});
      for (let i = 0; i < 40; i++) {
        if ((await api.del(`/chats/${chatId}`).catch(() => ({ status: 0 }))).status === 200) break;
        await sleep(250);
      }
    }
    // The main wrapper outlives this spec: what it shared goes, and Collaborators is off again
    for (const id of projects) await api.put(`/projects/${id}/sharing`, { groups: [] }).catch(() => {});
    await api.put('/collaborators', { enabled: false }).catch(() => {});
    for (const id of projects) await api.del(`/projects/${id}`).catch(() => {});
    if (savedScripts === null) writeFileSync(fake.scripts, '{}');
    else writeFileSync(fake.scripts, savedScripts);
  }
};
