// tsx compiles test files with the classic runtime; this one renders JSX like the app does
/** @jsxRuntime automatic */
import assert from 'node:assert/strict';
import test from 'node:test';
import type { CollaboratorsStatus, Group, GroupInvite, GroupList, GroupMember, JoinRequest, PendingJoin, Project, SharedProject } from '@claudio/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { TooltipProvider } from '@claudio/ui/components/controls/Tooltip';
import { ConfirmProvider } from '@claudio/ui/components/Dialog';
import { ToastProvider } from '@claudio/ui/components/Toast';
import { timeAgo } from '@claudio/ui/lib/format';
import i18n from '../src/i18n';
import { collaboratorsKeys } from '../src/lib/api/collaborators';
import { CollaboratorsView } from '../src/pages/Collaborators';
import { InviteView } from '../src/pages/collaborators/dialogs';
import { byPerson, connectionWord, followJoin, kindCounts, localProjectOf, ownedGroups, presenceWord, shortId, syncWord, worstSync } from '../src/pages/collaborators/model';
import { PendingJoinRow } from '../src/pages/collaborators/SharedWithYou';

// The Collaborators page (docs/plans/collaborators.md §5.1, task w1): off, unavailable and on; the
// You card's connection in words; groups with presence, the owner's actions and join requests; what
// is shared with this install by person; the invite with its QR code. Nothing on it is live, and the
// page has one gradient action.

const SELF = 'a'.repeat(64);
const ANA = 'b'.repeat(64);
const LUIS = 'c'.repeat(64);
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();

const status = (extra: Partial<CollaboratorsStatus> = {}): CollaboratorsStatus => ({
  unavailable: null,
  settings: { enabled: true, displayName: 'Jose', label: 'desktop', relayUrl: null, assistantReads: true },
  endpointId: SELF,
  connection: 'online',
  connectionError: null,
  homeRelay: 'https://euc1-1.relay.n0.iroh.link./',
  ...extra,
});

const member = (endpointId: string, name: string, extra: Partial<GroupMember> = {}): GroupMember => ({
  endpointId,
  name,
  role: 'member',
  addedAt: ago(86_400_000),
  self: false,
  presence: { online: false, path: null, lastSeenAt: ago(2 * 3_600_000) },
  ...extra,
});

const group = (extra: Partial<Group> = {}): Group => ({
  id: 'g'.repeat(64),
  name: 'Backend team',
  head: { version: 3, hash: 'h'.repeat(64) },
  owner: SELF,
  isOwner: true,
  members: [
    member(SELF, 'Jose', { role: 'owner', self: true, presence: null, label: 'desktop' }),
    member(ANA, 'Ana', { label: 'laptop', presence: { online: true, path: 'relay', lastSeenAt: ago(0) } }),
    member(LUIS, 'Luis'),
  ],
  frozen: false,
  conflict: null,
  joinRequestCount: 0,
  ...extra,
});

const shared = (extra: Partial<SharedProject> = {}): SharedProject => ({
  owner: ANA,
  ownerName: 'Ana',
  ownerLabel: 'laptop',
  groupIds: ['g'.repeat(64)],
  shareKey: 'github.com/acme/api',
  shareId: '0123456789abcdef0123456789abcdef',
  name: 'api',
  remote: 'git@github.com:acme/api.git',
  subpath: null,
  kinds: ['chats', 'memory', 'journal', 'documents', 'artifacts', 'board'],
  counts: { chats: 12, memory: 3, board: 0 },
  sync: { state: 'live', lastSyncedAt: ago(60_000), path: 'relay', error: null },
  matches: ['p1'],
  linkedProjectId: null,
  agentsMayRead: true,
  ...extra,
});

const PROJECTS = [{ id: 'p1', name: 'api', path: '/work/api' } as Project, { id: 'p2', name: 'web', path: '/work/web' } as Project];

function wrap(children: ReactNode, client = new QueryClient()) {
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <TooltipProvider>
          <ToastProvider>
            <ConfirmProvider>{children}</ConfirmProvider>
          </ToastProvider>
        </TooltipProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const page = (s: CollaboratorsStatus, groups?: GroupList, list: SharedProject[] = [], client?: QueryClient) =>
  wrap(<CollaboratorsView status={s} groups={groups} shared={list} projects={PROJECTS} busy={false} onTurnOn={() => {}} onUpdate={async () => true} />, client);
const text = (html: string) =>
  html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ');
/** Gradient surfaces: the primary buttons, the gradient borders and the gradient text */
const gradients = (html: string) => (html.match(/btn-primary|grad-border|grad-text/g) ?? []).length;

test.before(async () => {
  await i18n.changeLanguage('en');
});

// ---------- model ----------

test("the You card's connection: ok connected, neutral through a relay, warn without a relay, bad without network", () => {
  const relayed = [group()];
  assert.deepEqual(connectionWord(status(), relayed), { key: 'connection.relay', tone: 'muted' });
  const direct = [group({ members: [member(ANA, 'Ana', { presence: { online: true, path: 'direct', lastSeenAt: ago(0) } })] })];
  assert.deepEqual(connectionWord(status(), direct), { key: 'connection.online', tone: 'ok' });
  // Nobody to reach yet is not "through a relay"
  assert.deepEqual(connectionWord(status(), []), { key: 'connection.online', tone: 'ok' });
  assert.deepEqual(connectionWord(status({ connection: 'no-relay' }), []), { key: 'connection.noRelay', tone: 'warn' });
  assert.deepEqual(connectionWord(status({ connection: 'offline' }), []), { key: 'connection.offline', tone: 'bad' });
  assert.equal(connectionWord(status({ connection: 'starting' }), []).tone, 'muted');
  assert.deepEqual(connectionWord(status({ connection: 'error' }), []), { key: 'connection.error', tone: 'bad' });
});

test('an endpoint that did not bind says why and when it is tried again, instead of "Connecting…" for ever', () => {
  const html = page(status({ connection: 'error', connectionError: { message: 'Failed to bind sockets', retryAt: new Date(Date.now() + 30_000).toISOString() }, homeRelay: null }));
  assert.match(html, /data-testid="collab-connection-error"/);
  assert.ok(text(html).includes('Did not start'));
  assert.ok(text(html).includes('Failed to bind sockets'));
  assert.ok(text(html).includes('Trying again at'));
  assert.ok(!text(html).includes('Connecting…'));
});

test('presence and sync are ok while connected and idle while waiting, never live', () => {
  assert.deepEqual(presenceWord({ online: true, path: 'direct', lastSeenAt: null }), { key: 'presence.direct', tone: 'ok', ago: null });
  assert.equal(presenceWord({ online: true, path: 'relay', lastSeenAt: null })?.key, 'presence.relay');
  assert.equal(presenceWord({ online: false, path: null, lastSeenAt: ago(1000) })?.tone, 'idle');
  assert.equal(presenceWord({ online: false, path: null, lastSeenAt: null })?.key, 'presence.never');
  assert.equal(presenceWord(null), null);
  assert.deepEqual(syncWord({ state: 'live', lastSyncedAt: null, path: null, error: null }), { key: 'sync.live', tone: 'ok', ago: null });
  assert.equal(syncWord({ state: 'synced', lastSyncedAt: ago(1000), path: null, error: null }).tone, 'muted');
  assert.equal(syncWord({ state: 'offline', lastSyncedAt: ago(1000), path: null, error: null }).key, 'sync.offline');
  assert.equal(syncWord({ state: 'offline', lastSyncedAt: null, path: null, error: null }).key, 'sync.offlineNever');
  assert.equal(syncWord({ state: 'pending', lastSyncedAt: null, path: null, error: null }).key, 'sync.pending');
  assert.deepEqual(syncWord({ state: 'paused', lastSyncedAt: ago(1000), path: null, error: null }), { key: 'sync.paused', tone: 'warn', ago: null });
});

test('the Shared tab icon shows the worst state among the copies', () => {
  const sync = (state: 'live' | 'synced' | 'offline' | 'pending' | 'paused', error = false) => ({ state, lastSyncedAt: null, path: null, error: error ? { code: 'x', text: 'x' } : null });
  assert.equal(worstSync([]), null);
  assert.equal(worstSync([sync('live'), sync('synced')])?.kind, 'synced');
  assert.equal(worstSync([sync('live'), sync('pending')])?.kind, 'pending');
  assert.equal(worstSync([sync('pending'), sync('offline')])?.kind, 'offline');
  assert.equal(worstSync([sync('offline'), sync('paused')])?.kind, 'paused');
  assert.equal(worstSync([sync('paused'), sync('live', true)])?.kind, 'error');
});

test('shared projects group by person, then by install, and two installs of one person stay apart', () => {
  const people = byPerson([
    shared({ name: 'web', shareId: '1'.repeat(32) }),
    shared({ owner: LUIS, ownerName: 'Luis', ownerLabel: null, shareId: '2'.repeat(32) }),
    shared({ owner: 'd'.repeat(64), ownerLabel: 'desktop', shareId: '3'.repeat(32) }),
    shared({ shareId: '4'.repeat(32) }),
  ]);
  assert.deepEqual(
    people.map((p) => [p.name, p.installs.map((i) => [i.label, i.projects.map((x) => x.name)])]),
    [
      ['Ana', [['desktop', ['api']], ['laptop', ['api', 'web']]]],
      ['Luis', [[null, ['api']]]],
    ],
  );
});

test('counts skip the empty kinds and keep the Shared tab order; the local project is the link, else the first match', () => {
  assert.deepEqual(kindCounts(shared()), [
    { kind: 'chats', count: 12 },
    { kind: 'memory', count: 3 },
  ]);
  assert.equal(localProjectOf(shared()), 'p1');
  assert.equal(localProjectOf(shared({ linkedProjectId: 'p2' })), 'p2');
  assert.equal(localProjectOf(shared({ matches: [] })), null);
  assert.equal(shortId(SELF), 'aaaaaaaa…aaaa');
  // A frozen group signs nothing, so Invite does not offer it
  assert.deepEqual(ownedGroups([group(), group({ id: 'x', frozen: true }), group({ id: 'y', isOwner: false })]).map((g) => g.id), ['g'.repeat(64)]);
});

// ---------- off and unavailable ----------

test('off: the illustration, what it is in a sentence, and Turn on as the one gradient', () => {
  const html = page(status({ settings: { enabled: false, displayName: '', label: '', relayUrl: null, assistantReads: true }, endpointId: null, connection: 'off' }));
  assert.equal((html.match(/state-illustrated/g) ?? []).length, 1);
  assert.match(html, /data-illustration="collaborators"/);
  assert.match(html, /class="il il-lg"/);
  assert.ok(text(html).includes('Work with your team'));
  assert.ok(text(html).includes("nobody spends anyone else's quota"));
  assert.match(html, /class="btn btn-primary"[^>]*data-testid="collab-turn-on"/);
  assert.equal(gradients(html), 1);
});

test('unavailable: the warn illustration and the reason, with no action', () => {
  const html = page(status({ unavailable: { code: 'platform', reason: { code: 'collaborators.platform', text: 'No prebuild for darwin-x64' } }, settings: { enabled: true, displayName: 'Jose', label: '', relayUrl: null, assistantReads: true } }));
  assert.match(html, /class="il il-warn"/);
  assert.ok(text(html).includes('Not available on this platform'));
  assert.ok(text(html).includes('No prebuild for darwin-x64'));
  assert.doesNotMatch(html, /<button/);
  assert.equal(gradients(html), 0);
});

// ---------- on ----------

test('on: Invite is the one gradient, and is off until this install owns a group', () => {
  const owner = page(status(), { groups: [group()], pendingJoins: [] }, [shared()]);
  assert.equal(gradients(owner), 1);
  assert.match(owner, /class="btn btn-primary"[^>]*data-testid="collab-invite"/);
  assert.doesNotMatch(owner.match(/<button[^>]*data-testid="collab-invite"[^>]*>/)?.[0] ?? '', /disabled/);
  const memberOnly = page(status(), { groups: [group({ isOwner: false, owner: ANA })], pendingJoins: [] });
  assert.match(memberOnly.match(/<button[^>]*data-testid="collab-invite"[^>]*>/)?.[0] ?? '', /disabled/);
  // Join and Create are default buttons
  assert.match(owner, /class="btn btn-small" data-testid="collab-join"/);
  assert.match(owner, /class="btn btn-small" data-testid="collab-create"/);
});

test('the You card: name, label, the shortened endpoint id with copy, and the connection with who runs relays', () => {
  const html = page(status(), { groups: [group()], pendingJoins: [] });
  const words = text(html);
  assert.ok(words.includes('Jose'));
  assert.ok(words.includes('desktop'));
  assert.match(html, new RegExp(`title="${SELF}"[^>]*>aaaaaaaa…aaaa<`));
  assert.match(html, /aria-label="Copy the endpoint id"/);
  // Ana is reached through a relay: said in words, with no status colour
  assert.match(html, /class="collab-tone tone-muted"[^>]*>.*?<span>Connected through a relay<\/span>/);
  assert.ok(words.includes('Discovery and relays are run by n0'));
  const own = page(status({ settings: { enabled: true, displayName: 'Jose', label: '', relayUrl: 'https://relay.acme.dev', assistantReads: true } }), { groups: [], pendingJoins: [] });
  assert.ok(text(own).includes('Discovery is run by n0 · relay https://relay.acme.dev'));
});

test('a group lists its members with the owner chip and presence in words, and the owner a menu on the others', () => {
  const html = page(status(), { groups: [group()], pendingJoins: [] });
  const words = text(html);
  assert.ok(words.includes('Backend team'));
  assert.ok(words.includes('3 members'));
  assert.equal((html.match(/data-testid="collab-member"/g) ?? []).length, 3);
  assert.ok(words.includes('Owner'));
  // Each member by name, with the short endpoint id in mono as the secondary line
  assert.ok(words.includes(`Ana laptop · ${shortId(ANA)}`));
  assert.match(html, new RegExp(`class="small muted mono ellipsis" title="${LUIS}">${shortId(LUIS)}<`));
  assert.ok(words.includes('Online · relay'));
  // Luis was last seen two hours ago, in the words the app's formatter uses
  assert.ok(words.includes(`Last seen ${timeAgo(ago(2 * 3_600_000))}`));
  assert.match(html, /status-dot tone-ok/);
  assert.match(html, /status-dot tone-idle/);
  // One "⋯" per other member, none on the owner's own row
  assert.equal((html.match(/aria-label="Actions for (Ana|Luis)"/g) ?? []).length, 2);
  assert.doesNotMatch(html, /aria-label="Actions for Jose"/);
  assert.doesNotMatch(html, /Actions for Backend team/);
});

test("a member's group offers Leave and no member actions; a frozen group says so and offers a new group", () => {
  const asMember = page(status(), { groups: [group({ isOwner: false, owner: ANA })], pendingJoins: [] });
  assert.match(asMember, /aria-label="Actions for Backend team"/);
  assert.doesNotMatch(asMember, /aria-label="Actions for (Ana|Luis)"/);
  const frozen = page(status(), { groups: [group({ frozen: true })], pendingJoins: [] });
  assert.match(frozen, /class="alert alert-warn collab-line"/);
  assert.ok(text(frozen).includes("The owner's install is gone: the group can no longer change."));
  assert.ok(text(frozen).includes('Create a new group'));
  assert.doesNotMatch(frozen, /aria-label="Actions for (Ana|Luis)"/);
  const forked = page(status(), { groups: [group({ conflict: { version: 4, hashes: ['x', 'y'] } })], pendingJoins: [] });
  assert.match(forked, /class="alert alert-bad collab-line"/);
});

test("the owner's join requests show who relayed them, with Accept and Deny as default buttons", () => {
  const g = group({ joinRequestCount: 1 });
  const request: JoinRequest = { groupId: g.id, from: 'e'.repeat(64), name: 'Marta', label: 'laptop', relayedBy: { endpointId: ANA, name: 'Ana' }, receivedAt: ago(600_000), expiresAt: ago(-86_400_000) };
  const client = new QueryClient();
  client.setQueryData(collaboratorsKeys.joinRequests(g.id), [request]);
  const html = page(status(), { groups: [g], pendingJoins: [] }, [], client);
  assert.equal((html.match(/data-testid="collab-join-request"/g) ?? []).length, 1);
  const words = text(html);
  assert.ok(words.includes('Join requests'));
  assert.ok(words.includes(`laptop · relayed by Ana · ${shortId('e'.repeat(64))}`));
  assert.ok(words.includes('Accept') && words.includes('Deny'));
  assert.equal(gradients(html), 1);
});

test('a join waiting for the owner says who holds it, with a way to cancel', () => {
  const pending: PendingJoin = { groupId: 'g2', groupName: 'Mobile', owner: { endpointId: LUIS, name: 'Luis' }, relayedBy: { endpointId: ANA, name: 'Ana' }, sentAt: ago(0), expiresAt: ago(-86_400_000), state: 'waiting', endedAt: null };
  const html = wrap(<PendingJoinRow pending={pending} busy={false} onCancel={() => {}} />);
  assert.ok(text(html).includes(`Luis is offline. Your request has been left with Ana ( ${shortId(ANA)} ) and will be accepted when Luis is back.`));
  assert.match(html, new RegExp(`<span class="mono" title="${ANA}">${shortId(ANA)}</span>`));
  assert.ok(text(html).includes('Cancel request'));
  const sent = wrap(<PendingJoinRow pending={{ ...pending, relayedBy: null }} busy={false} onCancel={() => {}} />);
  assert.ok(text(sent).includes('Connecting to Luis…'));
  // Shown on the page too, so a reload keeps it
  assert.match(page(status(), { groups: [], pendingJoins: [pending] }), /data-testid="collab-pending-join"/);
});

const ended = (state: 'denied' | 'expired'): PendingJoin => ({
  groupId: 'g3',
  groupName: 'UDD',
  owner: { endpointId: LUIS, name: 'Luis' },
  relayedBy: { endpointId: ANA, name: 'Ana' },
  sentAt: ago(3_600_000),
  expiresAt: state === 'expired' ? ago(60_000) : ago(-86_400_000),
  state,
  endedAt: ago(0),
});

test('a join the owner denied says who denied it, in the bad tone with a word and an icon, and can be dismissed', () => {
  const html = wrap(<PendingJoinRow pending={ended('denied')} busy={false} onCancel={() => {}} />);
  const words = text(html);
  assert.ok(words.includes('Luis denied your request to join UDD.'), words);
  assert.match(html, /data-testid="collab-ended-join" data-state="denied"/);
  assert.match(html, /<span class="collab-tone tone-bad"><svg[^>]*lucide-circle-x[^>]*>.*?<span>Denied<\/span>/);
  assert.ok(words.includes('Dismiss'));
  // Nothing left to wait for: no holder, no expiry, no cancel
  assert.ok(!words.includes('Cancel request') && !words.includes('The invite expires') && !words.includes('is offline'));
  // On the page beside the joins still waiting, so a reload keeps it until dismissed
  const page2 = page(status(), { groups: [], pendingJoins: [ended('denied')] });
  assert.match(page2, /data-testid="collab-ended-join"/);
  assert.doesNotMatch(page2, /data-testid="collab-pending-join"/);
});

test('a join whose invite expired before the owner answered says so, in the warn tone, and can be dismissed', () => {
  const html = wrap(<PendingJoinRow pending={ended('expired')} busy={false} onCancel={() => {}} />);
  const words = text(html);
  assert.ok(words.includes('The invite expired before Luis answered.'), words);
  assert.match(html, /data-state="expired"/);
  assert.match(html, /<span class="collab-tone tone-warn"><svg[^>]*lucide-clock[^>]*>.*?<span>Expired<\/span>/);
  assert.ok(words.includes('Dismiss') && !words.includes('Cancel request'));
});

test('a join that ended reads the same in Spanish', async () => {
  await i18n.changeLanguage('es');
  try {
    const words = text(wrap(<PendingJoinRow pending={ended('denied')} busy={false} onCancel={() => {}} />));
    assert.ok(words.includes('Luis ha rechazado tu solicitud para unirte a UDD.'), words);
    assert.ok(words.includes('Rechazada') && words.includes('Descartar'));
    assert.ok(text(wrap(<PendingJoinRow pending={ended('expired')} busy={false} onCancel={() => {}} />)).includes('La invitación caducó antes de que Luis respondiera.'));
  } finally {
    await i18n.changeLanguage('en');
  }
});

test('shared with you: by person and install, the key in mono, counts, the sync state in words, and where it opens', () => {
  const list = [shared(), shared({ name: 'billing', shareKey: 'local/0123', shareId: '9'.repeat(32), matches: [], sync: { state: 'offline', lastSyncedAt: ago(2 * 3_600_000), path: null, error: null } })];
  const html = page(status(), { groups: [group()], pendingJoins: [] }, list);
  const words = text(html);
  assert.ok(words.includes('Shared with you'));
  assert.ok(words.includes('Install: laptop'));
  assert.match(html, /class="mono small muted collab-share-key">github\.com\/acme\/api</);
  assert.ok(words.includes('12 chats · 3 memory files'));
  assert.match(html, /class="collab-tone tone-ok"[^>]*>.*?<span>Up to date · syncing<\/span>/);
  assert.match(html, /class="collab-tone tone-idle"[^>]*>.*?<span>Owner offline · last synced [^<]+<\/span>/);
  // Cloned here: opens in the project's Shared tab; not cloned: says so and offers a link
  assert.match(html, /href="\/\?project=p1&amp;view=shared"/);
  assert.ok(words.includes('Not cloned here'));
  assert.ok(words.includes('Link to a local project'));
  // Syncing is not an agent working
  assert.doesNotMatch(html, /live-rail|live-energy|is-live|tone-active/);
});

test('an empty page says how to start, without a second illustration', () => {
  const html = page(status(), { groups: [], pendingJoins: [] }, []);
  const words = text(html);
  assert.ok(words.includes('You are in no group yet'));
  assert.ok(words.includes('Nothing shared with you yet'));
  assert.doesNotMatch(html, /state-illustrated/);
});

test('the invite: its text with copy, a QR code even for a long ticket, the expiry and the standing warning', () => {
  const invite: GroupInvite = { groupId: 'g', groupName: 'Backend team', text: `claudio-invite:${'x1y2z3'.repeat(120)}`, expiresAt: new Date(Date.now() + 7 * 86_400_000).toISOString() };
  const html = wrap(<InviteView invite={invite} />);
  assert.match(html, /<svg class="qr"[^>]*role="img"[^>]*aria-label="QR code of the invite to Backend team"/);
  assert.match(html, /aria-label="Copy the invite"/);
  const words = text(html);
  assert.ok(words.includes('Valid once, until'));
  assert.ok(words.includes('If you are offline when they join, they wait until you are back.'));
  assert.match(html, /class="alert alert-warn collab-invite-warn"/);
  assert.ok(words.includes('transfer ownership before changing machines'));
});

test('the Spanish copy follows the glossary', async () => {
  await i18n.changeLanguage('es');
  try {
    const html = page(status(), { groups: [group()], pendingJoins: [] }, [shared({ matches: [] })]);
    const words = text(html);
    assert.ok(words.includes('Colaboradores'));
    assert.ok(words.includes('Invitar'));
    assert.ok(words.includes('Unirse a un grupo'));
    assert.ok(words.includes('Crear un grupo'));
    assert.ok(words.includes('Propietario'));
    assert.ok(words.includes('Conectado por relay'));
    assert.ok(words.includes('Al día · sincronizando'));
    assert.ok(words.includes('Vincular con un proyecto local'));
    assert.doesNotMatch(words, /en vivo/i);
  } finally {
    await i18n.changeLanguage('en');
  }
});

test('the join dialog follows the live pending entry: the member who took the request, the roster that lists this install, or the end of it', () => {
  const groupId = 'j'.repeat(64);
  const sent: PendingJoin = { groupId, groupName: 'Backend', owner: { endpointId: ANA, name: 'Ana' }, relayedBy: null, sentAt: ago(8_000), expiresAt: ago(-3_600_000), state: 'waiting', endedAt: null };
  // Before the list answers, the snapshot: still being delivered
  assert.deepEqual(followJoin(sent, undefined), { pending: sent, joined: null, ended: false });
  // The list caught up: Ben took the request while Ana was offline, so the words name him
  const held: PendingJoin = { ...sent, relayedBy: { endpointId: LUIS, name: 'Ben' } };
  assert.deepEqual(followJoin(sent, { groups: [], pendingJoins: [held] }), { pending: held, joined: null, ended: false });
  // Ana signed it: the entry is gone and the group lists this install, so the dialog says joined
  assert.deepEqual(followJoin(sent, { groups: [group({ id: groupId, name: 'Backend' })], pendingJoins: [] }), { pending: sent, joined: 'Backend', ended: false });
  // Denied, or the invite expired: the page tells it, the dialog only closes
  const denied: PendingJoin = { ...held, state: 'denied', endedAt: ago(0) };
  assert.deepEqual(followJoin(sent, { groups: [], pendingJoins: [denied] }), { pending: denied, joined: null, ended: true });
  // Cancelled elsewhere with no group to show: the snapshot stays, nothing is claimed
  assert.deepEqual(followJoin(sent, { groups: [], pendingJoins: [] }), { pending: sent, joined: null, ended: false });
  assert.deepEqual(followJoin(null, { groups: [], pendingJoins: [held] }), { pending: null, joined: null, ended: false });
});
