import assert from 'node:assert/strict';
import test from 'node:test';
import type { Board, MoveWorkItemResult, WorkItem, WorkItemDetail, WorkItemPage, WorkItemStatus } from '@claudio/shared';
import { MutationObserver, QueryClient, type InfiniteData } from '@tanstack/react-query';
import { keys } from '../src/api.ts';
import type { MoveTarget } from '../src/pages/tasks/board/model.ts';
import { moveOptions, type MoveRequest } from '../src/pages/tasks/board/useMoveWorkItem.ts';

// The board's move against a real query cache: what every cached read shows while a move is in
// flight, once the server answered, and after it refused; and that moves run one after another.

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
    { status: 'backlog', limit: null, count: 0, overLimit: false, items: [] },
    { status: 'todo', limit: null, count: 2, overLimit: false, items: [item('a1', 'todo', { rank: 'a' }), item('a2', 'todo', { rank: 'b' })] },
    { status: 'in_progress', limit: 1, count: 1, overLimit: false, items: [item('c1', 'in_progress', { rank: 'a' })] },
    { status: 'in_review', limit: null, count: 0, overLimit: false, items: [] },
    { status: 'done', limit: null, count: 0, overLimit: false, items: [] },
  ],
});

const ids = (value: Board | undefined, status: WorkItemStatus) => value?.columns.find((c) => c.status === status)?.items.map((i) => i.id);

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function setup() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity }, mutations: { retry: false } } });
  const boardKey = keys.workItemBoard('p1');
  const pagesKey = keys.workItemPages('p1');
  client.setQueryData(boardKey, board());
  client.setQueryData<InfiniteData<WorkItemPage>>(pagesKey, {
    pages: [{ items: [item('a1', 'todo', { rank: 'a' }), item('a2', 'todo', { rank: 'b' }), item('c1', 'in_progress', { rank: 'a' })], total: 3, nextCursor: null }],
    pageParams: [''],
  });
  client.setQueryData<WorkItemDetail>(keys.workItem('a1'), { ...item('a1', 'todo', { rank: 'a' }), children: [], links: [], comments: [], history: [] } as unknown as WorkItemDetail);
  const sent: Array<{ itemId: string; target: MoveTarget; answer: ReturnType<typeof deferred<MoveWorkItemResult>> }> = [];
  const failures: string[] = [];
  const options = moveOptions(client, {
    send: (itemId, target) => {
      const answer = deferred<MoveWorkItemResult>();
      sent.push({ itemId, target, answer });
      return answer.promise;
    },
    failed: (request) => failures.push(request.item.id),
  });
  const move = (request: MoveRequest) => new MutationObserver(client, options).mutate(request).catch(() => undefined);
  return { client, boardKey, pagesKey, sent, failures, move };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

test('a move shows at once on the board, the list pages and the item page, then where the server placed it', async () => {
  const { client, boardKey, pagesKey, sent, move } = setup();
  const a1 = item('a1', 'todo', { rank: 'a' });
  const done = move({ item: a1, status: 'in_progress', place: { index: 1, column: board().columns[2]?.items ?? [] } });
  await tick();
  assert.deepEqual(sent[0]?.target, { status: 'in_progress', afterId: 'c1' });
  const drawn = client.getQueryData<Board>(boardKey);
  assert.deepEqual(ids(drawn, 'in_progress'), ['c1', 'a1']);
  assert.equal(drawn?.columns[2]?.count, 2);
  assert.equal(drawn?.columns[2]?.overLimit, true);
  assert.equal(client.getQueryData<InfiniteData<WorkItemPage>>(pagesKey)?.pages[0]?.items[0]?.status, 'in_progress', 'the list pages move it too');
  assert.equal(client.getQueryData<WorkItemDetail>(keys.workItem('a1'))?.status, 'in_progress');
  // The server ranked it first in the column: the answer, not the drop, is where it stays
  sent[0]?.answer.resolve({ item: { ...a1, status: 'in_progress', rank: '0' }, column: { status: 'in_progress', limit: 1, count: 2, overLimit: true } });
  await done;
  assert.deepEqual(ids(client.getQueryData<Board>(boardKey), 'in_progress'), ['a1', 'c1']);
  assert.equal(client.getQueryData<WorkItemDetail>(keys.workItem('a1'))?.rank, '0');
  assert.equal(client.getQueryState(boardKey)?.isInvalidated, false, 'the answer is the data: the event refreshes the rest, not a second read');
});

test('moves run one after another, and a refused one puts back its own card only', async () => {
  const { client, boardKey, sent, failures, move } = setup();
  const first = move({ item: item('a1', 'todo', { rank: 'a' }), status: 'in_review' });
  const second = move({ item: item('a2', 'todo', { rank: 'b' }), status: 'backlog' });
  await tick();
  assert.equal(sent.length, 1, 'the second move waits for the first');
  assert.deepEqual(ids(client.getQueryData<Board>(boardKey), 'in_review'), ['a1']);
  assert.deepEqual(ids(client.getQueryData<Board>(boardKey), 'backlog'), ['a2'], 'both are drawn at once');
  sent[0]?.answer.reject(new Error('refused'));
  await first;
  await tick();
  assert.deepEqual(failures, ['a1']);
  const after = client.getQueryData<Board>(boardKey);
  assert.deepEqual(ids(after, 'todo'), ['a1'], 'the refused card is back where it was');
  assert.deepEqual(ids(after, 'backlog'), ['a2'], 'the move still in flight is kept');
  assert.equal(after?.columns[1]?.count, 1);
  assert.equal(client.getQueryData<WorkItemDetail>(keys.workItem('a1'))?.status, 'todo');
  assert.equal(sent.length, 2, 'the second move goes once the first is settled');
  sent[1]?.answer.resolve({ item: item('a2', 'backlog', { rank: 'a' }), column: { status: 'backlog', limit: null, count: 1, overLimit: false } });
  await second;
  assert.deepEqual(ids(client.getQueryData<Board>(boardKey), 'backlog'), ['a2']);
});

test('a read that left before the move landed does not draw the card back', async () => {
  const { client, boardKey, sent, move } = setup();
  const reads: Array<ReturnType<typeof deferred<Board>>> = [];
  const observe = () =>
    client.fetchQuery({
      queryKey: boardKey,
      staleTime: 0,
      queryFn: () => {
        const read = deferred<Board>();
        reads.push(read);
        return read.promise;
      },
    });
  const a1 = item('a1', 'todo', { rank: 'a' });
  const done = move({ item: a1, status: 'in_review' });
  await tick();
  // A refresh starts while the move is in flight: the server has not written it yet
  void observe().catch(() => undefined);
  await tick();
  assert.equal(reads.length, 1);
  sent[0]?.answer.resolve({ item: { ...a1, status: 'in_review' }, column: { status: 'in_review', limit: null, count: 1, overLimit: false } });
  await done;
  // The old read lands late: it was cancelled, so it does not overwrite the answer
  reads[0]?.resolve(board());
  await tick();
  assert.deepEqual(ids(client.getQueryData<Board>(boardKey), 'in_review'), ['a1']);
  assert.equal(reads.length, 1, 'no observer, so nothing re-reads; the answer stands');
});
