import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import test from 'node:test';
import { createInvite, decodeInvite, encodeInvite, INVITE_PREFIX, InviteFormatError } from '../src/collab/invite.ts';
import { describeMember, nameOf, rosterChangeTitle, shortEndpoint } from '../src/collab/names.ts';
import { addMember, createGenesis, endpointIdFromSeed, removeMember, transferOwnership } from '../src/collab/roster.ts';

// A member is shown and announced by the display name the roster gives it; the endpoint id is only
// a short secondary detail (R12: a joiner saw "left with ff5a9c9b" instead of the member's name).

function install(name: string) {
  const seed = randomBytes(32);
  return { seed, id: endpointIdFromSeed(seed), name };
}

const ana = install('Ana');
const ben = install('Ben');
const cleo = install('Cleo');
const dan = install('Dan');
const at = (minute: number) => `2026-10-16T10:${String(minute).padStart(2, '0')}:00.000Z`;

const genesis = createGenesis({ seed: ana.seed, name: 'Platform', owner: { name: 'Ana' }, now: at(0) });
const v2 = addMember(genesis, ana.seed, ben.id, { name: 'Ben' }, at(1));

test('a member is named by the newest roster version that lists it, across groups', () => {
  const other = createGenesis({ seed: ben.seed, name: 'Mobile', owner: { name: 'Benjamin' }, now: at(5) });
  assert.equal(nameOf([[genesis, v2]], ben.id), 'Ben');
  // Ben renamed himself in a group signed later: that name wins, whichever order the groups come in
  assert.equal(nameOf([[genesis, v2], [other]], ben.id), 'Benjamin');
  assert.equal(nameOf([[other], [genesis, v2]], ben.id), 'Benjamin');
  assert.equal(nameOf([[genesis, v2]], cleo.id), null);
});

test("before a roster lists a member, an invite's names stand in; the roster's win once it does", () => {
  assert.equal(nameOf([], ben.id, { [ben.id]: 'Ben' }), 'Ben');
  assert.equal(nameOf([[genesis, v2]], ben.id, { [ben.id]: 'Someone else' }), 'Ben');
  assert.equal(nameOf([], ben.id, { [ben.id]: '   ' }), null);
  assert.equal(nameOf([], '__proto__', {}), null);
});

test('a log line names the member and keeps the start of its id; an unknown one is its short id', () => {
  assert.equal(shortEndpoint(ben.id), ben.id.slice(0, 8));
  assert.equal(describeMember('Ben', ben.id), `Ben (${ben.id.slice(0, 8)})`);
  assert.equal(describeMember(null, ben.id), ben.id.slice(0, 8));
});

test('a roster change is announced by who joined, left or became the owner', () => {
  const v3 = addMember(v2, ana.seed, cleo.id, { name: 'Cleo' }, at(2));
  assert.equal(rosterChangeTitle(null, genesis), null);
  assert.equal(rosterChangeTitle(genesis, v2), 'Ben joined Platform');
  assert.equal(rosterChangeTitle(v3, removeMember(v3, ana.seed, ben.id, at(3))), 'Ben left Platform');
  assert.equal(rosterChangeTitle(v3, transferOwnership(v3, ana.seed, cleo.id, at(3))), 'Cleo is now the owner of Platform');
  // Versions this install missed while offline arrive together, and are told together
  const v4 = addMember(v3, ana.seed, dan.id, { name: 'Dan' }, at(3));
  assert.equal(rosterChangeTitle(v2, v4), 'Cleo and Dan joined Platform');
  assert.equal(rosterChangeTitle(genesis, v4), 'Ben, Cleo and Dan joined Platform');
  const v5 = removeMember(v4, ana.seed, ben.id, at(4));
  assert.equal(rosterChangeTitle(v3, v5), 'Dan joined Platform; Ben left Platform');
  assert.ok(!rosterChangeTitle(genesis, v4)?.includes(ben.id.slice(0, 8)));
});

test("an invite names the members it lists as relays, so a joiner names the one holding its request", () => {
  const head = addMember(v2, ana.seed, cleo.id, { name: 'Cleo' }, at(2));
  const invite = createInvite({ seed: ana.seed, head, ticket: 'endpointaticket', relays: [`${ben.id}:benticket`, cleo.id, dan.id] });
  // Dan is not in the roster: his entry relays, but nothing names him
  assert.deepEqual(invite.relayNames, { [ben.id]: 'Ben', [cleo.id]: 'Cleo' });
  assert.deepEqual(decodeInvite(encodeInvite(invite)), invite);
  // An invite made before relay names existed still reads, without them
  const { relayNames: _names, ...older } = invite;
  const olderText = INVITE_PREFIX + Buffer.from(JSON.stringify(older)).toString('base64url');
  assert.equal(decodeInvite(olderText).relayNames, undefined);
  // A name for an id the relays do not list, or an empty one, is refused
  const tamper = (relayNames: unknown) => INVITE_PREFIX + Buffer.from(JSON.stringify({ ...invite, relayNames })).toString('base64url');
  assert.throws(() => decodeInvite(tamper({ ['f'.repeat(64)]: 'Eve' })), InviteFormatError);
  assert.throws(() => decodeInvite(tamper({ [ben.id]: '' })), InviteFormatError);
  assert.throws(() => decodeInvite(tamper(['Ben'])), InviteFormatError);
  assert.throws(() => decodeInvite(tamper({ [ben.id]: 'x'.repeat(201) })), InviteFormatError);
});
