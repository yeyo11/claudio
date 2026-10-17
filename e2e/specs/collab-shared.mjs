// What the Collaborators specs share (this file is not a spec: the runner only picks `*.spec.mjs`).
//
// The peers are fresh for every spec, but the main wrapper outlives each one: a group a spec leaves
// behind on it is still owned there when the next Collaborators spec of the shard runs, and the
// Invite dialog asks which group instead of making the invite as it opens. So each spec takes its
// groups away again, and a failure says what the page, the API and the servers saw before the
// spec's own cleanup changes them.

const settle = (promise, ms = 5_000) =>
  Promise.race([promise, new Promise((resolve) => setTimeout(() => resolve('(no answer within 5s)'), ms))]).catch((error) => `(${error.message})`);

/**
 * Takes the groups `ids` off the install `client` talks to. The owner cannot leave a group that still
 * has members, so it removes them first (they are this spec's peers, gone or about to go). Collaborators
 * is turned on for it, as the spec may have left it off; turning it off again is the caller's business.
 */
export async function dropGroups(client, ids) {
  const wanted = ids.filter(Boolean);
  if (wanted.length === 0) return;
  await client.put('/collaborators', { enabled: true }).catch(() => {});
  const groups = (await client.get('/collaborators/groups').catch(() => ({ body: null }))).body?.groups ?? [];
  for (const group of groups.filter((g) => wanted.includes(g.id))) {
    if (group.isOwner) {
      for (const member of group.members) {
        if (member.endpointId === group.owner) continue;
        await client.del(`/collaborators/groups/${encodeURIComponent(group.id)}/members/${encodeURIComponent(member.endpointId)}`).catch(() => {});
      }
    }
    await client.del(`/collaborators/groups/${encodeURIComponent(group.id)}`).catch(() => {});
  }
}

/**
 * Records, in the page, what every invite request answered: the Invite dialog makes its invite as it
 * opens, so the answer is otherwise nowhere a failed spec can read it. Lasts until the page navigates.
 */
export const recordInvites = `
  window.__e2eInvites = [];
  const fetch0 = window.fetch;
  window.fetch = async (...args) => {
    const url = String(args[0]?.url ?? args[0]);
    const response = await fetch0(...args);
    if (url.includes('/invites')) response.clone().text().then((body) => window.__e2eInvites.push({ url, status: response.status, body: body.slice(0, 400) }));
    return response;
  };
  return true`;

/**
 * Why a Collaborators spec failed, read before its cleanup: the open dialog's text, the invite
 * answers `recordInvites` kept, the groups the main install holds, and what the servers logged about
 * collab during the spec.
 */
export async function diagnosis({ page, api, serverLog }) {
  const dialog = await settle(page.eval(`return [...document.querySelectorAll('[role=dialog]')].map((d) => d.innerText).join('\\n---\\n') || '(no dialog open)'`));
  const invites = await settle(page.eval(`return JSON.stringify(window.__e2eInvites ?? '(not recorded on this page)')`));
  const groups = await settle(
    api.get('/collaborators/groups').then(({ status, body }) =>
      `${status} ${JSON.stringify((body?.groups ?? []).map((g) => ({ name: g.name, isOwner: g.isOwner, members: g.members.map((m) => m.name), frozen: g.frozen })))}`,
    ),
  );
  const status = await settle(api.get('/collaborators').then(({ status, body }) => `${status} ${JSON.stringify({ enabled: body?.enabled, connection: body?.connection })}`));
  const log = serverLog(/collab/i).slice(-40);
  return [
    `the page's dialog: ${String(dialog).replaceAll('\n', ' | ')}`,
    `the invite answers on the page: ${invites}`,
    `the main install's groups: ${groups}`,
    `the main install's Collaborators: ${status}`,
    `what the servers logged about collab (${log.length} lines):`,
    ...log.map((line) => `  ${line}`),
  ].join('\n');
}
