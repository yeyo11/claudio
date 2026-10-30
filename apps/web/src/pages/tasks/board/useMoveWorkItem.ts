import type { Board, MoveWorkItemResult, WorkItem, WorkItemPage } from '@claudio/shared';
import { useMutation, useQueryClient, type InfiniteData, type MutationOptions, type QueryClient, type QueryKey } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { api, keys } from '../../../api';
import { useToast } from '@claudio/ui/components/Toast';
import { columnMeta } from '../../../lib/work-items';
import { moveOnBoard, moveTarget, placeOnBoard, type MovePlace, type MoveTarget } from './model';

/** A move, and the item's key for the toast that says a refused one went back. */
export type MoveRequest = MovePlace & { item: Pick<WorkItem, 'id' | 'key'> };

/** What a refused move puts back: the item as every cache held it before. */
interface Undo {
  previous: WorkItem | null;
}

/** Every move of every board runs one after another, so each one's neighbour is named on the board the last one left. */
const MOVE_SCOPE = { id: 'work-item-move' };

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;
const isBoard = (value: unknown): value is Board => isObject(value) && Array.isArray(value.columns);
const isPages = (value: unknown): value is InfiniteData<WorkItemPage> => isObject(value) && Array.isArray(value.pages);
const isItem = (value: unknown): value is WorkItem => isObject(value) && typeof value.id === 'string' && typeof value.status === 'string';
const isList = (value: unknown): value is WorkItem[] => Array.isArray(value) && value.every(isItem);

interface Patch {
  board: (board: Board) => Board;
  item: (item: WorkItem) => WorkItem;
}

/**
 * Applies a patch to every cached read that holds the item: the boards, the flat lists, the list's
 * pages, the item by key and the item's own page. A read that does not hold it is left alone.
 */
function patchCaches(queryClient: QueryClient, itemId: string, patch: Patch): void {
  const one = <T extends WorkItem>(entry: T): T => (entry.id === itemId ? { ...entry, ...patch.item(entry) } : entry);
  const update = (value: unknown): unknown => {
    if (isBoard(value)) return patch.board(value);
    if (isPages(value)) {
      if (!value.pages.some((page) => page.items.some((entry) => entry.id === itemId))) return value;
      return { ...value, pages: value.pages.map((page) => ({ ...page, items: page.items.map(one) })) };
    }
    if (isList(value)) return value.some((entry) => entry.id === itemId) ? value.map(one) : value;
    if (isItem(value)) return value.id === itemId ? one(value) : value;
    return value;
  };
  for (const prefix of [keys.workItems, keys.workItem(itemId)]) {
    for (const [key, value] of queryClient.getQueriesData({ queryKey: prefix })) {
      const next = update(value);
      if (next !== value) queryClient.setQueryData(key, next);
    }
  }
}

/** The item as the caches hold it now: a board's card, a list's row, or else its own page. */
function cachedItem(queryClient: QueryClient, itemId: string): WorkItem | null {
  for (const [, value] of queryClient.getQueriesData({ queryKey: keys.workItems })) {
    const found = isBoard(value)
      ? value.columns.flatMap((column) => column.items).find((entry) => entry.id === itemId)
      : isPages(value)
        ? value.pages.flatMap((page) => page.items).find((entry) => entry.id === itemId)
        : isList(value)
          ? value.find((entry) => entry.id === itemId)
          : isItem(value) && value.id === itemId
            ? value
            : undefined;
    if (found) return found;
  }
  // Last, the item's own page: the card a board draws is the one a refused move puts back
  const detail = queryClient.getQueryData<unknown>(keys.workItem(itemId));
  return isItem(detail) ? detail : null;
}

/**
 * Cancels the reads of the item that are in flight, which may have left the server before the move
 * was written, and hands back their keys so they can be asked again once the answer is in the cache.
 */
async function cancelInFlight(queryClient: QueryClient, itemId: string): Promise<QueryKey[]> {
  const cache = queryClient.getQueryCache();
  const fetching = [...cache.findAll({ queryKey: keys.workItems, fetchStatus: 'fetching' }), ...cache.findAll({ queryKey: keys.workItem(itemId), fetchStatus: 'fetching' })];
  await Promise.all(fetching.map((query) => queryClient.cancelQueries({ queryKey: query.queryKey, exact: true })));
  return fetching.map((query) => query.queryKey);
}

/**
 * Moves a card. Every cached board, list, list page and item page that holds it shows it in its new
 * place at once; the API is told which card of its project it goes after, so the order survives a
 * reload and a second person's move. Moves run one after another (one scope for them all). The
 * answer is written into the caches where the server placed the card, so a read that left before
 * the move cannot draw it back; a refused move puts back only this card, as it was, and says why.
 * The server's `workitem.moved` refreshes the rest, here and in any other tab.
 */
export function moveOptions(
  queryClient: QueryClient,
  { send, failed }: { send: (itemId: string, target: MoveTarget) => Promise<MoveWorkItemResult>; failed: (request: MoveRequest, error: unknown) => void },
): MutationOptions<MoveWorkItemResult, unknown, MoveRequest, Undo> {
  return {
    scope: MOVE_SCOPE,
    mutationFn: (request) => send(request.item.id, moveTarget(request)),
    onMutate: async (request) => {
      const { item } = request;
      await queryClient.cancelQueries({ queryKey: keys.workItems });
      await queryClient.cancelQueries({ queryKey: keys.workItem(item.id) });
      const previous = cachedItem(queryClient, item.id);
      const target = moveTarget(request);
      const closing = target.status === 'done' && previous?.status !== 'done';
      patchCaches(queryClient, item.id, {
        board: (board) => moveOnBoard(board, item.id, target),
        item: (entry) => ({ ...entry, status: target.status, ...(closing ? { closedAt: new Date().toISOString() } : {}) }),
      });
      return { previous };
    },
    onSuccess: async ({ item, column }) => {
      const asked = await cancelInFlight(queryClient, item.id);
      patchCaches(queryClient, item.id, { board: (board) => placeOnBoard(board, item, column), item: () => item });
      for (const queryKey of asked) void queryClient.invalidateQueries({ queryKey, exact: true });
    },
    onError: (error, request, undo) => {
      const previous = undo?.previous;
      if (previous) patchCaches(queryClient, request.item.id, { board: (board) => placeOnBoard(board, previous), item: () => previous });
      else void queryClient.invalidateQueries({ queryKey: keys.workItems });
      failed(request, error);
    },
  };
}

/** {@link moveOptions} through the API, with a toast for a refused move. */
export function useMoveWorkItem() {
  const queryClient = useQueryClient();
  const toast = useToast();
  const { t } = useTranslation('tasks');
  return useMutation(
    moveOptions(queryClient, {
      send: (itemId, target) => api.moveWorkItem(itemId, target),
      failed: ({ item, status }, error) => toast.error(t('move.failed', { key: item.key, column: t(columnMeta(status).label) }), error),
    }),
  );
}
