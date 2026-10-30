import assert from 'node:assert/strict';
import test from 'node:test';
import type { Board, WorkItem, WorkItemStatus } from '@claudio/shared';
import { newestDone } from '../../../packages/core/src/work-item-pages.ts';
import type { ItemRow } from '../../../packages/core/src/work-item-rows.ts';
import {
  afterIdFor,
  blocksWithin,
  boardOrder,
  dropSlot,
  epicProgress,
  isSamePlace,
  keyboardDrop,
  labelsInUse,
  moveOnBoard,
  moveTarget,
  neighbourStatus,
  newestDoneFirst,
  notSelectable,
  openBlockers,
  placeInGroup,
  placeOnBoard,
  projectSpan,
} from '../src/pages/tasks/board/model.ts';

// The board's own rules: where a card lands and which neighbour the API is told, the board drawn
// before the server answers, the keyboard's moves, and what "Orchestrate" may take.

const item = (id: string, status: WorkItemStatus, extra: Partial<WorkItem> = {}): WorkItem => ({
  id,
  projectId: 'p1',
  number: Number(id.replace(/\D/g, '')) || 1,
  key: `AGN-${id.replace(/\D/g, '') || 1}`,
  type: 'task',
  title: `item ${id}`,
  description: '',
  status,
  priority: 'medium',
  labels: [],
  assignee: null,
  epicId: null,
  milestoneId: null,
  acceptanceCriteria: [],
  relations: [],
  rank: id,
  worktree: null,
  branch: null,
  createdAt: '2026-09-27T10:00:00Z',
  updatedAt: '2026-09-27T10:00:00Z',
  closedAt: null,
  ...extra,
});

const board = (): Board => ({
  projectId: 'p1',
  columns: [
    { status: 'backlog', limit: null, count: 2, overLimit: false, items: [item('a1', 'backlog'), item('a2', 'backlog')] },
    { status: 'todo', limit: null, count: 1, overLimit: false, items: [item('b1', 'todo')] },
    { status: 'in_progress', limit: 2, count: 2, overLimit: false, items: [item('c1', 'in_progress'), item('c2', 'in_progress')] },
    { status: 'in_review', limit: null, count: 0, overLimit: false, items: [] },
    { status: 'done', limit: null, count: 0, overLimit: false, items: [] },
  ],
});

const card = (id: string, projectId = 'p1') => ({ id, projectId });

test('a drop names the card drawn above it, or null at the top', () => {
  const column = [card('x'), card('y'), card('z')];
  assert.equal(afterIdFor(column, card('new'), 0), null);
  assert.equal(afterIdFor(column, card('new'), 1), 'x');
  assert.equal(afterIdFor(column, card('new'), 3), 'z');
  // The card itself is left out: moving y below z names z
  assert.equal(afterIdFor(column, card('y'), 2), 'z');
  assert.equal(afterIdFor(column, card('y'), 0), null);
  // An index past the end is the end
  assert.equal(afterIdFor(column, card('new'), 9), 'z');
  // An empty column: the top, whatever the index
  assert.equal(afterIdFor([], card('new'), 3), null);
});

test('on the All projects board a card lands inside its own project, and names a neighbour of it', () => {
  // The server's order: project, then rank. p2's cards are one group between p1's and p3's
  const column = [card('a1', 'p1'), card('a2', 'p1'), card('b1', 'p2'), card('b2', 'p2'), card('c1', 'p3')];
  assert.deepEqual(projectSpan(column, 'p2'), { start: 2, end: 4 });
  assert.deepEqual(projectSpan(column, 'p0'), { start: 0, end: 0 }, 'a project with no cards here has the empty span where its group goes');
  assert.deepEqual(projectSpan(column, 'p25'), { start: 4, end: 4 });
  const moving = card('m', 'p2');
  // Over p1's cards: the top of p2's group, which the API takes as null
  assert.equal(placeInGroup(column, moving, 0), 2);
  assert.equal(afterIdFor(column, moving, 0), null);
  assert.equal(afterIdFor(column, moving, 1), null);
  // Between p2's cards and at the end of the group
  assert.equal(afterIdFor(column, moving, 3), 'b1');
  assert.equal(afterIdFor(column, moving, 4), 'b2');
  // Past p3's card, the end of the column: still the end of p2's group, never p3's card
  assert.equal(placeInGroup(column, moving, 5), 4);
  assert.equal(afterIdFor(column, moving, 5), 'b2');
  // A card of a project with no cards in the column goes to the top of its (empty) group
  assert.equal(afterIdFor(column, card('n', 'p25'), 1), null);
  // A card moved inside its group is counted without itself
  assert.equal(afterIdFor(column, card('b1', 'p2'), 3), 'b2', 'b1 dropped below b2');
  assert.equal(afterIdFor(column, card('b2', 'p2'), 2), null, 'b2 dropped above b1');
});

test('the pointer, the keyboard and the API count a column the same way', () => {
  // Four cards 40px tall, 8px apart; the dragged one is left out of the boxes
  const column = [card('a'), card('b'), card('c'), card('d')];
  const boxes = (without: string) =>
    column
      .filter((entry) => entry.id !== without)
      .map((_, i) => ({ top: 100 + i * 48, height: 40 }));
  // Each card's middle is where its slot changes
  assert.equal(dropSlot(boxes('a'), 100), 0);
  assert.equal(dropSlot(boxes('a'), 121), 1);
  assert.equal(dropSlot(boxes('a'), 999), 3, 'below every card: the end');
  assert.equal(dropSlot([], 5), 0, 'an empty column: the top');
  // A downward drag of a, just below b's middle, lands after b: the keyboard's ArrowDown from the top
  const pointer = dropSlot(boxes('a'), 100 + 21);
  const keyboard = keyboardDrop({ status: 'todo', index: 0 }, 'ArrowDown', { backlog: 0, todo: 3, in_progress: 0, in_review: 0, done: 0 });
  assert.equal(keyboard?.index, pointer);
  assert.equal(afterIdFor(column, card('a'), pointer), 'b');
  // Every slot the pointer can find names the card drawn above it, and the last slot the last card
  for (const moving of column) {
    const others = column.filter((entry) => entry.id !== moving.id);
    for (let slot = 0; slot <= others.length; slot += 1) {
      const y = slot === others.length ? 999 : 100 + slot * 48 + 1;
      assert.equal(dropSlot(boxes(moving.id), y), slot);
      assert.equal(afterIdFor(column, moving, slot), slot === 0 ? null : (others[slot - 1]?.id ?? null));
    }
  }
});

test('a card dropped where it is asks the server for nothing', () => {
  assert.equal(isSamePlace(board(), 'a2', { status: 'backlog', index: 1 }), true);
  assert.equal(isSamePlace(board(), 'a2', { status: 'backlog', index: 0 }), false);
  assert.equal(isSamePlace(board(), 'a2', { status: 'todo', index: 1 }), false);
});

test('the board is redrawn with the card in its new place, counts and limits following it', () => {
  const moved = moveOnBoard(board(), 'b1', { status: 'in_progress', afterId: 'c1' });
  const byStatus = new Map(moved.columns.map((c) => [c.status, c]));
  assert.deepEqual(
    byStatus.get('in_progress')?.items.map((i) => i.id),
    ['c1', 'b1', 'c2'],
  );
  assert.equal(byStatus.get('in_progress')?.items[1]?.status, 'in_progress');
  assert.equal(byStatus.get('in_progress')?.count, 3);
  assert.equal(byStatus.get('in_progress')?.overLimit, true, 'going over the limit shows, it does not refuse');
  assert.equal(byStatus.get('todo')?.count, 0);
  assert.deepEqual(byStatus.get('todo')?.items, []);

  const within = moveOnBoard(board(), 'a1', { status: 'backlog', afterId: 'a2' });
  assert.deepEqual(
    within.columns[0]?.items.map((i) => i.id),
    ['a2', 'a1'],
  );
  assert.equal(within.columns[0]?.count, 2, 'a move inside a column keeps its count');

  const untouched = board();
  assert.equal(moveOnBoard(untouched, 'missing', { status: 'done' }), untouched, 'a board without the card is left alone');

  // Null is the top, absent the end; a neighbour this board does not draw (a filter) is the end too
  assert.deepEqual(moveOnBoard(board(), 'b1', { status: 'in_progress', afterId: null }).columns[2]?.items.map((i) => i.id), ['b1', 'c1', 'c2']);
  assert.deepEqual(moveOnBoard(board(), 'b1', { status: 'in_progress' }).columns[2]?.items.map((i) => i.id), ['c1', 'c2', 'b1']);
  assert.deepEqual(moveOnBoard(board(), 'b1', { status: 'in_progress', afterId: 'hidden' }).columns[2]?.items.map((i) => i.id), ['c1', 'c2', 'b1']);
  // Into an empty column
  const review = moveOnBoard(board(), 'b1', { status: 'in_review', afterId: null }).columns[3];
  assert.deepEqual(review?.items.map((i) => i.id), ['b1']);
  assert.equal(review?.count, 1);
});

const allProjects = (): Board => ({
  projectId: null,
  columns: [
    { status: 'backlog', limit: null, count: 0, overLimit: false, items: [] },
    {
      status: 'todo',
      limit: null,
      count: 4,
      overLimit: false,
      items: [item('a1', 'todo', { rank: 'a' }), item('a2', 'todo', { rank: 'b' }), item('b1', 'todo', { projectId: 'p2', rank: 'a' }), item('b2', 'todo', { projectId: 'p2', rank: 'c' })],
    },
    { status: 'in_progress', limit: null, count: 2, overLimit: false, items: [item('x1', 'in_progress', { rank: 'a' }), item('y1', 'in_progress', { projectId: 'p3', rank: 'a' })] },
    { status: 'in_review', limit: null, count: 0, overLimit: false, items: [] },
    { status: 'done', limit: null, count: 0, overLimit: false, items: [] },
  ],
});

test('on the All projects board the card is drawn inside its project at once, and where the server put it after', () => {
  const ids = (b: Board, status: WorkItemStatus) => b.columns.find((c) => c.status === status)?.items.map((i) => i.id);
  // p1's card dropped at the end of To do, below p2's cards: after a2, the last of its own group
  const request = { item: { id: 'x1', key: 'AGN-1', projectId: 'p1' }, status: 'todo' as const, place: { index: 4, column: allProjects().columns[1]?.items ?? [] } };
  assert.deepEqual(moveTarget(request), { status: 'todo', afterId: 'a2' }, "p1's card names the last of p1's cards, not p2's");
  assert.deepEqual(ids(moveOnBoard(allProjects(), 'x1', moveTarget(request)), 'todo'), ['a1', 'a2', 'x1', 'b1', 'b2']);
  // Null on the All projects board is the top of the card's own group
  assert.deepEqual(ids(moveOnBoard(allProjects(), 'y1', { status: 'todo', afterId: null }), 'todo'), ['a1', 'a2', 'b1', 'b2', 'y1']);
  // The answer places it by its rank in its project, whatever was drawn before
  const optimistic = moveOnBoard(allProjects(), 'b2', { status: 'todo', afterId: null });
  assert.deepEqual(ids(optimistic, 'todo'), ['a1', 'a2', 'b2', 'b1']);
  const answered = placeOnBoard(optimistic, item('b2', 'todo', { projectId: 'p2', rank: 'Z' }));
  assert.deepEqual(ids(answered, 'todo'), ['a1', 'a2', 'b2', 'b1'], "rank 'Z' sorts before 'a'");
  const later = placeOnBoard(optimistic, item('b2', 'todo', { projectId: 'p2', rank: 'd' }));
  assert.deepEqual(ids(later, 'todo'), ['a1', 'a2', 'b1', 'b2']);
  // Done takes no neighbour
  assert.deepEqual(moveTarget({ ...request, status: 'done' }), { status: 'done' });
  assert.deepEqual(moveTarget({ item: request.item, status: 'todo' }), { status: 'todo' }, 'no place: the end of the group');
});

test("a refused move puts back that card alone, as it was, and the server's answer brings the count", () => {
  const start = board();
  const previous = start.columns[1]?.items[0];
  if (!previous) throw new Error('no card');
  // Two moves in flight: b1 to In progress, then a1 within Backlog
  const first = moveOnBoard(start, 'b1', { status: 'in_progress', afterId: null });
  const second = moveOnBoard(first, 'a1', { status: 'backlog' });
  // The first is refused: b1 goes back to To do, a1 stays where the second move drew it
  const undone = placeOnBoard(second, previous);
  const byStatus = new Map(undone.columns.map((c) => [c.status, c]));
  assert.deepEqual(byStatus.get('todo')?.items.map((i) => i.id), ['b1']);
  assert.equal(byStatus.get('todo')?.count, 1);
  assert.deepEqual(byStatus.get('in_progress')?.items.map((i) => i.id), ['c1', 'c2']);
  assert.equal(byStatus.get('in_progress')?.count, 2);
  assert.equal(byStatus.get('in_progress')?.overLimit, false);
  assert.deepEqual(byStatus.get('backlog')?.items.map((i) => i.id), ['a2', 'a1'], 'the second move is kept');
  // The answer's column summary is the server's figure on the item's own board, not on another project's
  const answered = placeOnBoard(first, item('b1', 'in_progress', { rank: '0' }), { status: 'in_progress', limit: 2, count: 3, overLimit: true });
  assert.equal(answered.columns[2]?.count, 3);
  const elsewhere = placeOnBoard({ ...first, projectId: 'p9' }, item('b1', 'in_progress', { rank: '0' }), { status: 'in_progress', limit: 9, count: 9, overLimit: false });
  assert.equal(elsewhere.columns[2]?.limit, 2);
  // A board that does not draw the card is left alone
  const without = { ...start, columns: start.columns.map((c) => ({ ...c, items: c.items.filter((i) => i.id !== 'b1') })) };
  assert.equal(placeOnBoard(without, previous), without);
});

test('Done is ordered the same on the board and on the server', () => {
  const done = [
    item('d1', 'done', { closedAt: '2026-09-27T11:00:00Z' }),
    item('d2', 'done', { closedAt: '2026-09-27T12:00:00Z' }),
    item('d3', 'done', { closedAt: null, updatedAt: '2026-09-27T11:30:00Z' }),
    item('d4', 'done', { closedAt: '2026-09-27T12:00:00Z' }),
  ];
  const row = (entry: WorkItem): ItemRow => ({
    id: entry.id,
    project_id: entry.projectId,
    number: entry.number,
    type: entry.type,
    title: entry.title,
    description: '',
    status: entry.status,
    priority: entry.priority,
    assignee_kind: null,
    assignee_role: null,
    epic_id: null,
    milestone_id: null,
    rank: entry.rank,
    worktree: null,
    branch: null,
    bounces: 0,
    waiting: null,
    created_at: entry.createdAt,
    updated_at: entry.updatedAt,
    closed_at: entry.closedAt,
  });
  assert.deepEqual(
    newestDoneFirst(done).map((entry) => entry.id),
    newestDone(done.map(row), done.length).map((entry) => entry.id),
  );
  // And an open column in the server's order: project, then rank, then id
  const open = [item('z', 'todo', { projectId: 'p2', rank: 'a' }), item('y', 'todo', { rank: 'b' }), item('x', 'todo', { rank: 'b' }), item('w', 'todo', { rank: 'a' })];
  assert.deepEqual([...open].sort(boardOrder).map((entry) => entry.id), ['w', 'x', 'y', 'z']);
});

test("an epic moved on the board takes no place in either column's count, nor pushes one over its limit", () => {
  const start = board();
  const backlog = start.columns[0];
  if (!backlog) throw new Error('no backlog');
  // The server counts backlog as 2: the epic beside the two tasks is not one of them
  backlog.items = [...backlog.items, item('e9', 'backlog', { type: 'epic' })];
  const moved = moveOnBoard(start, 'e9', { status: 'in_progress', afterId: null });
  const byStatus = new Map(moved.columns.map((c) => [c.status, c]));
  assert.deepEqual(byStatus.get('in_progress')?.items.map((i) => i.id), ['e9', 'c1', 'c2'], 'the epic stays on the board');
  assert.equal(byStatus.get('in_progress')?.count, 2);
  assert.equal(byStatus.get('in_progress')?.overLimit, false, '2 of 2 with an epic inside is not over');
  assert.equal(byStatus.get('backlog')?.count, 2);
});

test('the arrows carry a picked-up card along its column and across the board', () => {
  const counts = { backlog: 1, todo: 1, in_progress: 2, in_review: 0, done: 0 };
  assert.deepEqual(keyboardDrop({ status: 'backlog', index: 0 }, 'ArrowDown', counts), { status: 'backlog', index: 1 });
  assert.equal(keyboardDrop({ status: 'backlog', index: 1 }, 'ArrowDown', counts), null, 'the bottom of a column is an edge');
  assert.equal(keyboardDrop({ status: 'backlog', index: 0 }, 'ArrowUp', counts), null);
  assert.equal(keyboardDrop({ status: 'backlog', index: 0 }, 'ArrowLeft', counts), null, 'Backlog is the first column');
  assert.deepEqual(keyboardDrop({ status: 'todo', index: 1 }, 'ArrowRight', counts), { status: 'in_progress', index: 1 }, 'the same height');
  assert.deepEqual(keyboardDrop({ status: 'in_progress', index: 2 }, 'ArrowRight', counts), { status: 'in_review', index: 0 }, 'or the end of a shorter column');
  assert.equal(keyboardDrop({ status: 'done', index: 0 }, 'ArrowRight', counts), null);
  assert.equal(neighbourStatus('todo', 1), 'in_progress');
  assert.equal(neighbourStatus('backlog', -1), null);
});

test('an epic, a done item and another project cannot be orchestrated, and say which', () => {
  assert.equal(notSelectable(item('e1', 'todo', { type: 'epic' }), null), 'epic');
  assert.equal(notSelectable(item('d1', 'done'), null), 'done');
  assert.equal(notSelectable(item('t1', 'todo', { projectId: 'p2' }), 'p1'), 'project');
  assert.equal(notSelectable(item('t1', 'todo'), 'p1'), null);
  assert.equal(notSelectable(item('t1', 'todo', { projectId: 'p2' }), null), null, 'the first pick sets the project');
});

test('the blocks among the picked items are said in the order they were picked', () => {
  const ref = (id: string, status: WorkItemStatus = 'todo') => ({ id, key: `AGN-${id.replace(/\D/g, '')}`, title: id, type: 'task' as const, status });
  const a = item('i36', 'todo', { relations: [{ type: 'blocks', item: ref('i33') }] });
  const b = item('i33', 'todo', { relations: [{ type: 'blocked_by', item: ref('i36') }, { type: 'blocked_by', item: ref('i40', 'done') }] });
  const c = item('i50', 'todo', { relations: [{ type: 'blocks', item: ref('i99') }] });
  assert.deepEqual(blocksWithin([b, a, c]), [{ blocker: 'AGN-36', blocked: 'AGN-33' }]);
  assert.deepEqual(
    openBlockers(b).map((r) => r.key),
    ['AGN-36'],
    'a blocker already done no longer blocks',
  );
});

test('an epic counts the items it groups, itself and other epics left out', () => {
  const progress = epicProgress([
    item('e1', 'todo', { type: 'epic' }),
    item('t1', 'done', { epicId: 'e1' }),
    item('t2', 'in_progress', { epicId: 'e1' }),
    item('t3', 'todo', { epicId: 'e2' }),
    item('t4', 'todo'),
  ]);
  assert.deepEqual(progress.get('e1'), { done: 1, total: 2 });
  assert.deepEqual(progress.get('e2'), { done: 0, total: 1 });
  assert.equal(progress.size, 2);
});

test('labels are offered once whatever their case', () => {
  assert.deepEqual(labelsInUse([item('a', 'todo', { labels: ['web', 'Core'] }), item('b', 'todo', { labels: ['WEB', 'api'] })]), ['api', 'Core', 'web']);
});

test('Done is in closing order: a card moved there heads it, and nothing moves inside it', () => {
  const start = board();
  const done = start.columns[4];
  if (!done) throw new Error('no done');
  done.items = [item('d2', 'done', { closedAt: '2026-09-27T12:00:00Z' }), item('d1', 'done', { closedAt: '2026-09-27T11:00:00Z' })];
  done.count = 2;
  // Dropped below both, it still heads the column, closed now
  const moved = moveOnBoard(start, 'b1', { status: 'done', afterId: 'd1' });
  const column = moved.columns.find((c) => c.status === 'done');
  assert.deepEqual(
    column?.items.map((i) => i.id),
    ['b1', 'd2', 'd1'],
  );
  assert.ok((column?.items[0]?.closedAt ?? '') > '2026-09-27T12:00:00Z');
  // Inside Done there is no place to move to: the board is left as it was, and the server not asked
  assert.equal(moveOnBoard(start, 'd1', { status: 'done' }), start);
  assert.equal(isSamePlace(start, 'd1', { status: 'done', index: 0 }), true);
  // The keyboard carries a card into Done at its head, and not up or down inside it
  const counts = { backlog: 2, todo: 1, in_progress: 2, in_review: 3, done: 2 };
  assert.deepEqual(keyboardDrop({ status: 'in_review', index: 2 }, 'ArrowRight', counts), { status: 'done', index: 0 });
  assert.equal(keyboardDrop({ status: 'done', index: 0 }, 'ArrowDown', counts), null);
  assert.equal(keyboardDrop({ status: 'done', index: 1 }, 'ArrowUp', counts), null);
});
