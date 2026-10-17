// Collaborators, what a copy carries beyond the transcript (docs/requests.md R12): Ana (the main
// wrapper) shares a project Ben has not cloned, so he reads it in its read-only view. A chat of hers
// attaches a file and delegates to a subagent, on the fake CLI: Ben opens the subagent's transcript
// from the delegation, in the side panel a local chat opens it in, and finds the file among the
// artifacts, which he can download. Last, Ben's own group is frozen: he owned it, his install
// restarts having lost the key it held (the vault gone), and nobody can sign its next version, so
// the card says so and offers a new group instead.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { dropGroups } from './collab-shared.mjs';

export const fakeCli = true;
export const peers = ['ben'];
// Two wrappers, a chat, every pull between them, and one of them restarted
export const timeout = 240_000;

const REMOTE = 'https://github.com/acme/web.git';
const PROMPT = 'e2e-collab-copies: look at the notes';
const AGENT = 'Explore the notes';
const UPLOAD = 'e2e-collab-brief.txt';
const UPLOAD_TEXT = 'The brief the chat was given.\n';

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

export default async ({ page, api, check, dirs, fakeCli: fake, peers: { ben } }) => {
  const anaDir = join(dirs.workspaceDir, 'e2e-collab-web');
  const savedScripts = existsSync(fake.scripts) ? readFileSync(fake.scripts, 'utf8') : null;
  let projectId = null;
  let chatId = null;
  let groupId = null;

  /** Bound: an invite needs the endpoint's ticket, and a join needs the host up */
  const ready = (client, who) =>
    until(async () => {
      const { body } = await client.get('/collaborators');
      return body && !['off', 'starting'].includes(body.connection) ? body : null;
    }, `${who}'s endpoint to bind`, 60_000);
  const groupsOf = async (client) => (await client.get('/collaborators/groups')).body?.groups ?? [];

  try {
    // ---------- a project only Ana has cloned, shared with a group Ben joined ----------
    mkdirSync(anaDir, { recursive: true });
    execFileSync('git', ['init', '-q', anaDir]);
    execFileSync('git', ['-C', anaDir, 'remote', 'add', 'origin', REMOTE]);
    writeFileSync(join(anaDir, 'README.md'), '# web\n\nWhat the subagent reads.\n');
    const project = await api.post('/projects/import', { path: anaDir, name: 'e2e-collab-web' });
    check(project.status === 201, `Ana's project (${project.status} ${JSON.stringify(project.body)})`);
    projectId = project.body.id;

    check((await api.put('/collaborators', { enabled: true, displayName: 'Ana' })).status === 200, 'Ana turns Collaborators on');
    const ana = await ready(api, 'Ana');
    const group = await api.post('/collaborators/groups', { name: 'Frontend' });
    check(group.status === 201, `the group (${group.status} ${JSON.stringify(group.body)})`);
    groupId = group.body.id;
    const invite = await api.post(`/collaborators/groups/${groupId}/invites`);
    check(invite.status === 201, `an invite (${invite.status})`);

    check((await ben.api.put('/collaborators', { enabled: true, displayName: 'Ben' })).status === 200, 'Ben turns Collaborators on');
    await ready(ben.api, 'Ben');
    const joined = await ben.api.post('/collaborators/join', { invite: invite.body.text });
    check(joined.status === 200, `Ben joins (${joined.status} ${JSON.stringify(joined.body)})`);
    await until(async () => (await groupsOf(ben.api)).find((g) => g.id === groupId)?.members.length === 2, 'Ben to hold the roster', 60_000);
    check((await api.put(`/projects/${projectId}/sharing`, { groups: [groupId] })).status === 200, 'the project is shared');

    // ---------- a chat that attaches a file and delegates to a subagent ----------
    const upload = await fetch(`${api.baseUrl}/api/uploads?name=${encodeURIComponent(UPLOAD)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream' },
      body: UPLOAD_TEXT,
    });
    const attachment = await upload.json();
    check(upload.status === 201 && attachment?.id, `the upload (${upload.status} ${JSON.stringify(attachment)})`);
    writeFileSync(fake.scripts, JSON.stringify({ '@transcript': true, [PROMPT]: `agent: ${AGENT} | read: README.md\nsay: The notes are explored` }));
    const chat = await api.post('/chats', { prompt: PROMPT, cwd: anaDir, attachments: [attachment.id] });
    check(chat.status === 201, `Ana's chat started (${chat.status} ${JSON.stringify(chat.body)})`);
    chatId = chat.body.id;

    // ---------- Ben's copy: the chat with its subagent, and the file among the artifacts ----------
    const shared = await until(async () => (await ben.api.get('/collaborators/shared')).body?.find((p) => p.name === 'e2e-collab-web'), "Ana's project on Ben's side", 60_000);
    check(shared.owner === ana.endpointId && !shared.linkedProjectId && (shared.matches ?? []).length === 0, `not cloned on Ben's machine (${JSON.stringify({ owner: shared.owner, matches: shared.matches })})`);
    const base = `/collaborators/shared/${encodeURIComponent(shared.owner)}/${encodeURIComponent(shared.shareId)}`;
    const copied = await until(
      async () => (await ben.api.get(`${base}/chats?refresh=1`)).body?.find?.((c) => c.id === chatId && !c.live && (c.subagents ?? []).length > 0),
      'the chat, ended, with its subagent, in the copy',
      90_000,
    );
    const agent = copied.subagents.find((a) => a.workflowRunId === null);
    check(agent && agent.description === AGENT, `the subagent is listed by what it was asked (${JSON.stringify(copied.subagents)})`);
    const agentPage = await until(async () => {
      const { status, body } = await ben.api.get(`${base}/chats/${chatId}/subagents/${encodeURIComponent(agent.agentId)}`);
      return status === 200 && (body?.entries ?? []).length > 0 ? body : null;
    }, "the subagent's transcript, copied", 60_000);
    check(agentPage.agentId === agent.agentId && agentPage.workflowRunId === null, `the subagent's own transcript (${JSON.stringify({ agentId: agentPage.agentId, total: agentPage.total })})`);
    const copiedUpload = await until(
      async () => (await ben.api.get(`${base}/artifacts?refresh=1`)).body?.find?.((a) => a.kind === 'upload' && a.id === attachment.id),
      'the upload among the artifacts',
      60_000,
    );
    check(copiedUpload.chatId === chatId && copiedUpload.name === UPLOAD && copiedUpload.sizeBytes === Buffer.byteLength(UPLOAD_TEXT), `the upload belongs to the chat (${JSON.stringify(copiedUpload)})`);

    // The transcript, read only, from the read-only view of a project not cloned here
    await ben.page.goto(`${base}?section=chats&chat=${chatId}`, 1200);
    await ben.page.waitFor(`return (document.querySelector('.shared-chat')?.innerText ?? '').includes('The notes are explored')`, { label: 'the copied transcript', timeout: 60_000 });
    check(!(await ben.page.eval(`return !!document.querySelector('.composer, [data-composer-input]')`)), 'no composer on a teammate’s chat');
    // The delegation is in a settled step, folded: opened, its call offers the subagent
    await ben.page.eval(`for (const t of document.querySelectorAll('.shared-chat .tool-step > .collapsible-trigger[aria-expanded=false]')) t.click(); return true`);
    await ben.page.waitFor(`return !!document.querySelector('.shared-chat .call-open')`, { label: "the delegation's way to its subagent" });
    check((await ben.page.eval(`return document.querySelector('.shared-chat .call-open').getAttribute('aria-label')`)) === "Open the subagent's transcript", 'the button says what it opens');
    await ben.page.eval(`document.querySelector('.shared-chat .call-open').click(); return true`);
    await ben.page.waitFor(`return (document.querySelector('[role=dialog]')?.innerText ?? '').includes(${JSON.stringify(AGENT)}) && !!document.querySelector('[role=dialog] .detail-transcript')`, {
      label: "the subagent's transcript in the side panel",
      timeout: 30_000,
    });
    const panel = await ben.page.eval(`return document.querySelector('[role=dialog]').innerText`);
    check(panel.includes('Subagent') && panel.includes('Explore'), `the panel says what it was (${panel.slice(0, 200)})`);
    check(new URL(await ben.page.eval('return location.href')).searchParams.get('agent') === agent.agentId, 'the open subagent is in the address');
    check(!(await ben.page.eval(`return !!document.querySelector('[role=dialog] .composer, [role=dialog] [data-composer-input]')`)), 'nothing to write with in the panel');
    await ben.page.key('Escape');
    await ben.page.waitFor(`return !document.querySelector('[role=dialog]') && !new URL(location.href).searchParams.has('agent')`, { label: 'the panel closed' });

    // The file, among the artifacts: what it is, how big, from which chat, and a way to save it
    await ben.page.goto(`${base}?section=artifacts&file=${encodeURIComponent(`upload:${attachment.id}`)}`, 1200);
    await ben.page.waitFor(`return (document.querySelector('.shared-artifacts')?.innerText ?? '').includes(${JSON.stringify(UPLOAD)})`, { label: 'the upload in the artifacts', timeout: 30_000 });
    // textContent: the kind is a Tag, drawn in capitals by CSS, so innerText would read it in capitals
    const item = await ben.page.eval(`return document.querySelector('.shared-artifacts .master-item-on')?.textContent ?? ''`);
    check(item.includes(UPLOAD) && item.includes('Attachment'), `the upload is the open artifact, marked as an attachment (${item})`);
    const detail = await ben.page.eval(`return document.querySelector('.shared-artifacts .detail')?.innerText ?? ''`);
    check(detail.includes('text/plain') && detail.includes(chatId.slice(0, 8)), `the detail says its type and its chat (${detail})`);
    check(await ben.page.eval(`return [...document.querySelectorAll('.shared-artifacts .detail button')].some((b) => b.innerText.includes('Download') && !b.disabled)`), 'a Download button');
    // What Download fetches: the file's bytes, from the owner, through Ben's install
    const blob = await fetch(`${ben.baseUrl}/api${base}/blobs/${copiedUpload.sha256}`);
    check(blob.status === 200 && (await blob.text()) === UPLOAD_TEXT, `the file's bytes reach Ben (${blob.status})`);

    // ---------- frozen: Ben owned a group, and restarts without the key he owned it as ----------
    const solo = await ben.api.post('/collaborators/groups', { name: 'Solo' });
    check(solo.status === 201 && solo.body.frozen === false, `Ben's own group (${solo.status} ${JSON.stringify(solo.body)})`);
    // The tab leaves Ben's origin first: a server going away under a page is console noise, not the test
    await page.goto('/collaborators', 800);
    for (const file of ['secrets.json', 'secret.key']) rmSync(join(ben.dirs.dataDir, file), { force: true });
    await ben.restart();
    const rebound = await ready(ben.api, 'Ben, restarted');
    check(rebound.endpointId && rebound.endpointId !== solo.body.owner, `a new key, so a new endpoint id (${rebound.endpointId})`);
    const after = await groupsOf(ben.api);
    check(after.find((g) => g.id === solo.body.id)?.frozen === true, `the group Ben owned is frozen (${JSON.stringify(after.map((g) => ({ name: g.name, frozen: g.frozen })))})`);
    check(after.find((g) => g.id === groupId)?.frozen === false, "Ana's group is not: only its owner's install can tell");

    const soloCard = `[...document.querySelectorAll('.collab-group')].find((g) => g.innerText.includes('Solo'))`;
    await ben.page.goto('/collaborators', 1200);
    await ben.page.waitFor(`return !!(${soloCard})?.querySelector('.alert-warn')`, { label: 'the frozen line on the Solo card', timeout: 30_000 });
    const line = await ben.page.eval(`return (${soloCard}).querySelector('.alert-warn').innerText`);
    check(line.includes("The owner's install is gone: the group can no longer change.") && line.includes('Create a new group'), `the warn line, in words, with its way out (${line})`);
    check(await ben.page.eval(`return !!(${soloCard}).querySelector('.alert-warn .alert-icon')`), 'the warn colour comes with an icon');
    // Scoped to the member rows: the card's own menu, Leave the group, shares the "Actions for" label
    check(!(await ben.page.eval(`return !!(${soloCard}).querySelector('[data-testid=collab-member] [aria-label^="Actions for"]')`)), 'a frozen group offers no member actions');
    const frontendCard = `[...document.querySelectorAll('.collab-group')].find((g) => g.innerText.includes('Frontend'))`;
    check(!(await ben.page.eval(`return !!(${frontendCard})?.querySelector('.alert-warn')`)), "Ana's group carries no frozen line");
    await ben.page.eval(`[...(${soloCard}).querySelectorAll('.alert-warn button')].find((b) => b.innerText.includes('Create a new group')).click(); return true`);
    await ben.page.waitFor(`return !!document.querySelector('[role=dialog] [data-testid=collab-group-name]')`, { label: 'Create a new group opens the create dialog' });
    await ben.page.key('Escape');
    // The tab goes home before Ben's server is stopped after the spec
    await page.goto('/collaborators', 800);
  } finally {
    if (chatId) {
      await api.post(`/chats/${chatId}/stop`).catch(() => {});
      for (let i = 0; i < 40; i++) {
        if ((await api.del(`/chats/${chatId}`).catch(() => ({ status: 0 }))).status === 200) break;
        await sleep(250);
      }
    }
    // The main wrapper outlives this spec: what it shared goes, and Collaborators is off again
    if (projectId) await api.put(`/projects/${projectId}/sharing`, { groups: [] }).catch(() => {});
    // A group left on Ana makes the next Collaborators spec's Invite dialog ask which one
    await dropGroups(api, [groupId]);
    await api.put('/collaborators', { enabled: false }).catch(() => {});
    if (projectId) await api.del(`/projects/${projectId}`).catch(() => {});
    if (savedScripts === null) writeFileSync(fake.scripts, '{}');
    else writeFileSync(fake.scripts, savedScripts);
  }
};
