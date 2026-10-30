/**
 * The board's own rules, pure so they are tested without a browser (test/tasks-board.test.ts):
 * where a dropped card lands and which neighbour the API is told it goes after, the board as it
 * looks the moment a card is moved (before the server answers), where a keyboard move takes a card,
 * and what may be picked for "Orchestrate". The shared vocabulary (columns, filters, live) is in
 * lib/work-items.ts.
 */
import type { Board, BoardColumn, BoardColumnSummary, WorkItem, WorkItemRef, WorkItemStatus } from '@claudio/shared';
import { BOARD_DONE_PAGE, WORK_ITEM_STATUSES } from '@claudio/shared';
import { countsInColumn } from '../../../lib/work-items';

/**
 * Done keeps growing, and what is finished matters least on a board: it shows its first few cards
 * and says how many more there are; "and N more" draws the next page of them in place.
 */
export const DONE_SHOWN = 3;

/**
 * The Done cards drawn after one more "and N more": up to the page the board already holds
 * (`BOARD_DONE_PAGE`), then a page more each time.
 */
export function nextDoneShown(shown: number): number {
  return (Math.floor(shown / BOARD_DONE_PAGE) + 1) * BOARD_DONE_PAGE;
}

/**
 * The `doneLimit` a board is asked with so its Done column holds `shown` cards. Undefined while the
 * default page holds them, so the board shares its answer with the sidebar's count.
 */
export function doneLimitFor(shown: number): number | undefined {
  return shown <= BOARD_DONE_PAGE ? undefined : Math.ceil(shown / BOARD_DONE_PAGE) * BOARD_DONE_PAGE;
}

/**
 * Done reads as a record of what was finished, newest first by when it was closed (its last update
 * for an item closed before that was recorded), as the server holds it. A card is never placed by
 * hand inside Done: one moved there is the newest and heads the column.
 */
export function newestDoneFirst<T extends DoneOrdered>(items: readonly T[]): T[] {
  return [...items].sort(doneOrder);
}

type DoneOrdered = Pick<WorkItem, 'closedAt' | 'updatedAt' | 'id'>;

/** Done's order, as the server's `newestDone` sorts it: newest closed first, the id breaking a tie. */
function doneOrder(a: DoneOrdered, b: DoneOrdered): number {
  const when = (item: DoneOrdered) => item.closedAt ?? item.updatedAt;
  return when(a) > when(b) ? -1 : when(a) < when(b) ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * What a column draws of what it holds, and what its "and N more" counts: the cards it holds but
 * folds, plus those the server left out (`more`). Only Done folds.
 */
export function foldColumn<T>(column: { status: WorkItemStatus; items: readonly T[]; more?: number }, shown: number): { shown: T[]; hidden: number } {
  const drawn = column.status === 'done' ? column.items.slice(0, shown) : [...column.items];
  return { shown: drawn, hidden: column.items.length - drawn.length + (column.more ?? 0) };
}

/** Every item a board counts, the ones its Done column leaves out included. */
export function boardTotal(board: Pick<Board, 'columns'> | undefined): number {
  return board ? board.columns.reduce((sum, column) => sum + column.items.length + (column.more ?? 0), 0) : 0;
}

/** Whether the board leaves some of its Done items out: then its cards alone cannot say how far an epic is. */
export function holdsPart(board: Pick<Board, 'columns'> | undefined): boolean {
  return Boolean(board?.columns.some((column) => (column.more ?? 0) > 0));
}

/** Where a card goes: a column and its index among the cards drawn there, the card itself left out. */
export interface Drop {
  status: WorkItemStatus;
  index: number;
}

// Ranks, ids and project ids are ASCII: code unit order is SQLite's BINARY order, which the server sorts by
const compareText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * The order of an open column as the server holds it (`ORDER BY project_id, rank, id`): on the All
 * projects board each project's cards are one group, in that project's own rank order.
 */
export function boardOrder(a: Pick<WorkItem, 'projectId' | 'rank' | 'id'>, b: Pick<WorkItem, 'projectId' | 'rank' | 'id'>): number {
  return compareText(a.projectId, b.projectId) || compareText(a.rank, b.rank) || compareText(a.id, b.id);
}

/**
 * Where one project's cards sit in a column, `[start, end)`. A rank only means something inside its
 * project, so a card is placed, and its neighbour named, within this span; on a project's own board
 * the span is the whole column. A column without the project's cards gives the empty span where its
 * group would be.
 */
export function projectSpan(column: readonly Pick<WorkItem, 'projectId'>[], projectId: string): { start: number; end: number } {
  const first = column.findIndex((item) => item.projectId === projectId);
  if (first < 0) {
    const at = column.filter((item) => compareText(item.projectId, projectId) < 0).length;
    return { start: at, end: at };
  }
  let end = first;
  while (end < column.length && column[end]?.projectId === projectId) end += 1;
  return { start: first, end };
}

type Placed = Pick<WorkItem, 'id' | 'projectId'>;

/**
 * Where a card dropped at `index` among the column's other cards may land: inside its own project's
 * group, at the nearest edge of it when the pointer is over another project's cards. The drop line
 * the board draws and the neighbour the API is told both come from this place.
 */
export function placeInGroup(column: readonly Placed[], item: Placed, index: number): number {
  const others = column.filter((entry) => entry.id !== item.id);
  const { start, end } = projectSpan(others, item.projectId);
  return Math.max(start, Math.min(index, end));
}

/**
 * The neighbour a card lands after, as `POST /work-items/:id/move` takes it: null for the top of its
 * project's group (the top of the column on a project's board), otherwise the card of its project
 * drawn just above the drop. Named by the cards on screen, so on a filtered board a card lands after
 * the one the person saw above it.
 */
export function afterIdFor(column: readonly Placed[], item: Placed, index: number): string | null {
  const others = column.filter((entry) => entry.id !== item.id);
  const { start } = projectSpan(others, item.projectId);
  const at = placeInGroup(column, item, index);
  return at === start ? null : (others[at - 1]?.id ?? null);
}

/**
 * Which slot of a column the pointer is over: before the first card whose middle is below it, or the
 * end. `boxes` are the column's other cards top to bottom, the dragged one left out, counted the way
 * {@link afterIdFor} and {@link keyboardDrop} count.
 */
export function dropSlot(boxes: readonly { top: number; height: number }[], y: number): number {
  const at = boxes.findIndex((box) => y < box.top + box.height / 2);
  return at < 0 ? boxes.length : at;
}

/** True when the drop leaves the card where it already is: nothing to ask the server. */
export function isSamePlace(board: Pick<Board, 'columns'>, itemId: string, drop: Drop): boolean {
  const column = board.columns.find((c) => c.items.some((item) => item.id === itemId));
  if (!column || column.status !== drop.status) return false;
  // Done is in closing order, so a card moved inside it stays where it is
  if (column.status === 'done') return true;
  return column.items.findIndex((item) => item.id === itemId) === drop.index;
}

const overLimit = (count: number, limit: number | null) => limit !== null && count > limit;

/**
 * Where a move asks the card to go, as the API takes it: a column, and the card of its project it
 * follows (null: the top of its group; absent: the end of it).
 */
export interface MoveTarget {
  status: WorkItemStatus;
  afterId?: string | null | undefined;
}

/**
 * A move as the board asks for it, before its neighbour is named. Dropped somewhere (`place`): the
 * index among the cards drawn in the target column, and those cards in order, which name the
 * neighbour within the item's project. Without a place (the item's page, an approval): the end of
 * its group.
 */
export type MovePlace =
  | { item: Pick<WorkItem, 'id' | 'projectId'>; status: WorkItemStatus; place: { index: number; column: readonly Pick<WorkItem, 'id' | 'projectId'>[] } }
  | { item: Pick<WorkItem, 'id'>; status: WorkItemStatus; place?: undefined };

/** The API's target for a move: the column, and the card of the item's own project it follows. */
export function moveTarget(move: MovePlace): MoveTarget {
  // Done is in closing order: a card moved there has no neighbour to name
  if (!move.place || move.status === 'done') return { status: move.status };
  return { status: move.status, afterId: afterIdFor(move.place.column, move.item, move.place.index) };
}

/**
 * The board with `next` in the column of its status at `place(items)`, wherever this board drew it
 * before. Counts and limits follow the card; a board that does not hold it is returned as it was,
 * since a filter may have left it out.
 */
function relocate<T extends Pick<Board, 'columns'>>(board: T, next: WorkItem, place: (items: readonly WorkItem[]) => number): T {
  const before = board.columns.find((column) => column.items.some((item) => item.id === next.id));
  const was = before?.items.find((item) => item.id === next.id);
  if (!before || !was) return board;
  const crosses = before.status !== next.status;
  const columns = board.columns.map((column): BoardColumn => {
    let items = column.items.filter((item) => item.id !== next.id);
    let count = column.count;
    if (column.status === before.status && crosses && countsInColumn(was)) count -= 1;
    if (column.status === next.status) {
      if (crosses && countsInColumn(next)) count += 1;
      const at = Math.max(0, Math.min(place(items), items.length));
      items = [...items.slice(0, at), next, ...items.slice(at)];
    }
    return { ...column, items, count, overLimit: overLimit(count, column.limit) };
  });
  return { ...board, columns };
}

/**
 * The board as it looks once the card has moved, drawn before the server answers so the card does
 * not jump back while the request is in flight. The card goes after the neighbour the API is told
 * when this board draws it, or else to the edge of its project's group the target names; into Done
 * it is the newest closed item and heads the column.
 */
export function moveOnBoard<T extends Pick<Board, 'columns'>>(board: T, itemId: string, target: MoveTarget): T {
  let moving: WorkItem | undefined;
  for (const column of board.columns) moving ??= column.items.find((item) => item.id === itemId);
  if (!moving) return board;
  const from = moving.status;
  if (from === 'done' && target.status === 'done') return board;
  const moved: WorkItem = target.status === 'done' && from !== 'done' ? { ...moving, status: 'done', closedAt: new Date().toISOString() } : { ...moving, status: target.status };
  return relocate(board, moved, (items) => {
    if (target.status === 'done') return 0;
    const { start, end } = projectSpan(items, moved.projectId);
    if (target.afterId === null) return start;
    const after = target.afterId === undefined ? -1 : items.findIndex((entry) => entry.id === target.afterId);
    return after >= start && after < end ? after + 1 : end;
  });
}

/**
 * The board with the item where the server holds it, by its own status and rank: what a move's
 * answer writes, and, given the item as it was, what puts a refused move back. Done is in closing
 * order, newest first; an open column in project, then rank order. With the answer's column summary,
 * that column of the item's own project board takes the server's count and limit.
 */
export function placeOnBoard<T extends Pick<Board, 'columns'> & { projectId?: string | null }>(board: T, item: WorkItem, summary?: BoardColumnSummary): T {
  const placed = relocate(board, item, (items) => {
    const after = items.findIndex((entry) => (item.status === 'done' ? doneOrder(entry, item) : boardOrder(entry, item)) > 0);
    return after < 0 ? items.length : after;
  });
  if (!summary || placed === board || board.projectId !== item.projectId) return placed;
  return { ...placed, columns: placed.columns.map((column) => (column.status === summary.status ? { ...column, ...summary } : column)) };
}

/**
 * Where an arrow key takes a card picked up with the keyboard: up and down within its column,
 * left and right into the neighbouring column at the same height (or its end). Null at an edge.
 * `counts` is how many other cards each column draws, the moving one left out.
 */
export function keyboardDrop(
  current: Drop,
  key: 'ArrowUp' | 'ArrowDown' | 'ArrowLeft' | 'ArrowRight',
  counts: Readonly<Record<WorkItemStatus, number>>,
): Drop | null {
  const col = WORK_ITEM_STATUSES.indexOf(current.status);
  // Done is in closing order: nothing to move up or down, and a card carried into it heads it
  if (current.status === 'done' && (key === 'ArrowUp' || key === 'ArrowDown')) return null;
  if (key === 'ArrowUp') return current.index > 0 ? { ...current, index: current.index - 1 } : null;
  if (key === 'ArrowDown') return current.index < counts[current.status] ? { ...current, index: current.index + 1 } : null;
  const next = WORK_ITEM_STATUSES[col + (key === 'ArrowRight' ? 1 : -1)];
  if (!next) return null;
  return { status: next, index: next === 'done' ? 0 : Math.min(current.index, counts[next]) };
}

/** A column one step up or down the board's order, for the phone's move menu. */
export function neighbourStatus(status: WorkItemStatus, step: -1 | 1): WorkItemStatus | null {
  return WORK_ITEM_STATUSES[WORK_ITEM_STATUSES.indexOf(status) + step] ?? null;
}

/**
 * Why an item cannot be picked for "Orchestrate", as the API refuses it: an epic groups work and is
 * not a node, a done item has nothing left to do, and a graph runs in one project. Null when it can.
 */
export type NotSelectable = 'epic' | 'done' | 'project';

export function notSelectable(item: Pick<WorkItem, 'type' | 'status' | 'projectId'>, projectOfSelection: string | null): NotSelectable | null {
  if (item.type === 'epic') return 'epic';
  if (item.status === 'done') return 'done';
  if (projectOfSelection !== null && item.projectId !== projectOfSelection) return 'project';
  return null;
}

/**
 * The `blocks` relations among the picked items, in the order they were picked: what the draft turns
 * into `dependsOn`, said on the selection bar ("AGN-36 blocks AGN-33").
 */
export function blocksWithin(selected: readonly Pick<WorkItem, 'id' | 'key' | 'relations'>[]): Array<{ blocker: string; blocked: string }> {
  const keyOf = new Map(selected.map((item) => [item.id, item.key]));
  const pairs: Array<{ blocker: string; blocked: string }> = [];
  for (const item of selected) {
    for (const relation of item.relations) {
      if (relation.type !== 'blocks') continue;
      const blocked = keyOf.get(relation.item.id);
      if (blocked) pairs.push({ blocker: item.key, blocked });
    }
  }
  return pairs;
}

/** The items this one waits for and that are not done: what the card's relation mark names. */
export function openBlockers(item: Pick<WorkItem, 'relations'>): WorkItemRef[] {
  return item.relations.filter((relation) => relation.type === 'blocked_by' && relation.item.status !== 'done').map((relation) => relation.item);
}

/**
 * How far an epic is, from the items it groups on the board: its card counts them instead of
 * carrying an epic label. Read from the unfiltered board, so a filter does not change the figure.
 */
export function epicProgress(items: readonly Pick<WorkItem, 'epicId' | 'status' | 'type'>[]): Map<string, { done: number; total: number }> {
  const progress = new Map<string, { done: number; total: number }>();
  for (const item of items) {
    if (!item.epicId || item.type === 'epic') continue;
    const entry = progress.get(item.epicId) ?? { done: 0, total: 0 };
    entry.total += 1;
    if (item.status === 'done') entry.done += 1;
    progress.set(item.epicId, entry);
  }
  return progress;
}

/**
 * An epic's progress from the items it groups, as its page reads them (`children`), for a board
 * whose Done column leaves some of them out.
 */
export function childProgress(children: readonly Pick<WorkItemRef, 'status' | 'type'>[]): { done: number; total: number } {
  const grouped = children.filter((child) => child.type !== 'epic');
  return { done: grouped.filter((child) => child.status === 'done').length, total: grouped.length };
}

/** Every item of a board, column after column, in board order. */
export function boardItems(board: Pick<Board, 'columns'> | undefined): WorkItem[] {
  return board ? board.columns.flatMap((column) => column.items) : [];
}

/** Every label in use, folded the way the API folds them, first spelling kept, sorted for a menu. */
export function labelsInUse(items: readonly Pick<WorkItem, 'labels'>[]): string[] {
  const seen = new Map<string, string>();
  for (const item of items) for (const label of item.labels) if (!seen.has(label.toLocaleLowerCase())) seen.set(label.toLocaleLowerCase(), label);
  return [...seen.values()].sort((a, b) => a.localeCompare(b));
}

/**
 * `?milestone=none` narrows to the items in no milestone. The API filters by one milestone id, so
 * "none" is applied here, after the answer.
 */
export const NO_MILESTONE = 'none';
