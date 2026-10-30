import type { BoardColumn, WorkItem, WorkItemStatus } from '@claudio/shared';
import { FullText } from '@claudio/ui/components/FullText';
import { WORK_ITEM_STATUSES } from '@claudio/shared';
import { ChevronDown, Plus, TriangleAlert } from 'lucide-react';
import { Fragment, useEffect, useLayoutEffect, useRef, useState, type DragEvent, type FocusEvent, type KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { ICON_SM } from '@claudio/ui/components/icons';
import { COARSE, useMediaQuery } from '@claudio/ui/lib/media';
import { WorkItemStatusIcon } from '../../../components/work-item-icons';
import { columnMeta } from '../../../lib/work-items';
import type { LiveSources } from './LiveLine';
import { dropSlot, foldColumn, isSamePlace, keyboardDrop, placeInGroup, type Drop, type NotSelectable } from './model';
import { useMoveMenu } from './moveMenu';
import { ColumnRole } from './team';
import { useMoveWorkItem } from './useMoveWorkItem';
import { WorkItemCard } from './WorkItemCard';

/** What the board needs to know about selection mode, which the page owns. */
export interface BoardSelection {
  selected: ReadonlySet<string>;
  blockedReason: (item: WorkItem) => NotSelectable | null;
  toggle: (item: WorkItem) => void;
}

interface Grab {
  id: string;
  key: string;
  origin: Drop;
  at: Drop;
}

const ARROWS = new Set(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight']);
const DRAG_TYPE = 'application/x-claudio-work-item';

/**
 * The five columns of a board, side by side. A card moves by pointer (drag it between or inside
 * columns), by keyboard (Space picks it up, the arrows carry it, Space drops it, Escape or leaving
 * the card puts it back) or, under a finger, through its "⋯"; either way the API is told which card
 * of its own project it now follows, so on the All projects board a card lands inside its project's
 * group. A column over its limit says so in words and in the warn colour, and still takes the card.
 */
export function BoardColumns({
  columns,
  projectNames,
  epics,
  live,
  selection,
  doneShown,
  doneLoading = false,
  onMoreDone,
  onOpen,
  onNewTask,
}: {
  columns: BoardColumn[];
  /** Set on the All projects board: each card names its project, and no column has a limit or a "+" */
  projectNames?: ReadonlyMap<string, string> | undefined;
  epics: ReadonlyMap<string, { done: number; total: number }>;
  live: LiveSources;
  selection: BoardSelection | null;
  /** How many Done cards are drawn; "and N more" asks for the next page of them */
  doneShown: number;
  /** The next page of Done is on its way: two skeleton cards hold its place */
  doneLoading?: boolean;
  onMoreDone: () => void;
  onOpen: (item: WorkItem) => void;
  onNewTask?: ((status: WorkItemStatus) => void) | undefined;
}) {
  const { t } = useTranslation('tasks');
  const move = useMoveWorkItem();
  const moveEntries = useMoveMenu(columns);
  // A finger gets the card's "⋯": the browser's drag and drop is a mouse's
  const coarse = useMediaQuery(COARSE);
  const [dragId, setDragId] = useState<string | null>(null);
  const [target, setTarget] = useState<Drop | null>(null);
  const [grab, setGrab] = useState<Grab | null>(null);
  const [said, setSaid] = useState('');
  const refocus = useRef<string | null>(null);
  const boardRef = useRef<HTMLDivElement>(null);
  const grabRef = useRef(grab);
  grabRef.current = grab;

  const byStatus = new Map(columns.map((column) => [column.status, column]));
  const label = (status: WorkItemStatus) => t(columnMeta(status).label);
  const itemById = (id: string) => columns.flatMap((column) => column.items).find((item) => item.id === id);

  // A card carried by keyboard is drawn where it is going; the others close up behind it
  const drawn = (column: BoardColumn): WorkItem[] => {
    if (!grab) return column.items;
    const others = column.items.filter((item) => item.id !== grab.id);
    if (column.status !== grab.at.status) return others;
    const card = itemById(grab.id);
    if (!card) return others;
    return [...others.slice(0, grab.at.index), card, ...others.slice(grab.at.index)];
  };

  // The card keeps the focus as it moves from one column to another, which re-mounts it
  useLayoutEffect(() => {
    const id = refocus.current;
    if (!id) return;
    refocus.current = null;
    boardRef.current?.querySelector<HTMLElement>(`[data-item-id="${CSS.escape(id)}"]`)?.focus();
  });

  // A card that leaves the board (moved elsewhere, removed, filtered out) ends what was carrying it
  const held = (id: string | null) => id !== null && columns.some((column) => column.items.some((item) => item.id === id));
  useEffect(() => {
    if (grab && !held(grab.id)) setGrab(null);
    if (dragId && !held(dragId)) {
      setDragId(null);
      setTarget(null);
    }
  });

  // A drag ends wherever it ends: on another part of the page, or after its card was drawn again
  useEffect(() => {
    if (!dragId) return;
    const end = () => {
      setDragId(null);
      setTarget(null);
    };
    document.addEventListener('dragend', end);
    document.addEventListener('drop', end);
    return () => {
      document.removeEventListener('dragend', end);
      document.removeEventListener('drop', end);
    };
  }, [dragId]);

  const counts = (without: string): Record<WorkItemStatus, number> =>
    Object.fromEntries(WORK_ITEM_STATUSES.map((status) => [status, (byStatus.get(status)?.items ?? []).filter((item) => item.id !== without).length])) as Record<
      WorkItemStatus,
      number
    >;

  const columnItems = (status: WorkItemStatus) => byStatus.get(status)?.items ?? [];
  // Inside the card's own project: the drop line is drawn, and the neighbour named, within its group
  const placed = (item: Pick<WorkItem, 'id' | 'projectId'>, drop: Drop): Drop =>
    drop.status === 'done' ? { status: 'done', index: 0 } : { status: drop.status, index: placeInGroup(columnItems(drop.status), item, drop.index) };

  const commit = (item: Pick<WorkItem, 'id' | 'key' | 'projectId'>, drop: Drop) => {
    if (isSamePlace({ columns }, item.id, drop)) return;
    move.mutate({ item, status: drop.status, place: { index: drop.index, column: columnItems(drop.status) } });
  };

  const cancelGrab = (item: Pick<WorkItem, 'key'>, origin: Drop) => {
    setGrab(null);
    say(t('drag.cancelled', { key: item.key, column: label(origin.status) }));
  };

  // Leaving a picked-up card puts it back. Carried into another column the card is drawn again and
  // takes the focus back right after, so the check waits for that
  const cardBlur = (item: WorkItem) => (event: FocusEvent<HTMLElement>) => {
    if (event.target !== event.currentTarget || grabRef.current?.id !== item.id) return;
    window.setTimeout(() => {
      const current = grabRef.current;
      if (current?.id !== item.id) return;
      const focused = document.activeElement instanceof HTMLElement ? document.activeElement.closest<HTMLElement>('[data-item-id]') : null;
      if (focused?.dataset.itemId !== item.id) cancelGrab(item, current.origin);
    }, 0);
  };

  const say = (text: string) => setSaid(text);
  const where = (drop: Drop, total: number) => t('drag.moved', { column: label(drop.status), position: drop.index + 1, total });

  const cardKeys = (item: WorkItem) => (event: KeyboardEvent<HTMLElement>) => {
    if (event.target !== event.currentTarget) return;
    if (selection) {
      if (event.key === ' ' || event.key === 'Enter') {
        event.preventDefault();
        if (!selection.blockedReason(item)) selection.toggle(item);
      } else if (ARROWS.has(event.key)) {
        event.preventDefault();
        focusNeighbour(event.currentTarget, event.key);
      }
      return;
    }
    if (grab && grab.id === item.id) {
      if (ARROWS.has(event.key)) {
        event.preventDefault();
        const step = keyboardDrop(grab.at, event.key as 'ArrowUp', counts(item.id));
        const next = step && placed(item, step);
        // The edge of the card's project group is an edge too
        if (!next || (next.status === grab.at.status && next.index === grab.at.index)) return;
        refocus.current = item.id;
        setGrab({ ...grab, at: next });
        say(where(next, counts(item.id)[next.status] + 1));
      } else if (event.key === ' ' || event.key === 'Enter') {
        event.preventDefault();
        refocus.current = item.id;
        setGrab(null);
        commit(item, grab.at);
        say(t('drag.dropped', { key: item.key, column: label(grab.at.status), position: grab.at.index + 1 }));
      } else if (event.key === 'Escape' || event.key === 'Tab') {
        if (event.key === 'Escape') event.preventDefault();
        refocus.current = event.key === 'Escape' ? item.id : null;
        cancelGrab(item, grab.origin);
      }
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      onOpen(item);
    } else if (event.key === ' ') {
      event.preventDefault();
      const column = byStatus.get(item.status)?.items ?? [];
      const origin = { status: item.status, index: column.findIndex((entry) => entry.id === item.id) };
      setGrab({ id: item.id, key: item.key, origin, at: origin });
      say(t('drag.picked', { key: item.key, column: label(item.status), position: origin.index + 1, total: column.length }));
    } else if (ARROWS.has(event.key)) {
      event.preventDefault();
      focusNeighbour(event.currentTarget, event.key);
    }
  };

  // ---- a pointer drag, with the browser's own drag and drop ----
  const dropAt = (event: DragEvent<HTMLElement>, status: WorkItemStatus, item: WorkItem): Drop => {
    const cards = [...event.currentTarget.querySelectorAll<HTMLElement>('[data-item-id]')].filter((el) => el.dataset.itemId !== item.id);
    return placed(item, { status, index: dropSlot(cards.map((el) => el.getBoundingClientRect()), event.clientY) });
  };

  const columnDrag = (status: WorkItemStatus) => ({
    onDragOver: (event: DragEvent<HTMLElement>) => {
      const item = dragId ? itemById(dragId) : undefined;
      if (!item) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = 'move';
      const at = dropAt(event, status, item);
      if (target?.status !== at.status || target.index !== at.index) setTarget(at);
    },
    onDrop: (event: DragEvent<HTMLElement>) => {
      const item = dragId ? itemById(dragId) : undefined;
      if (!item) return;
      event.preventDefault();
      const drop = dropAt(event, status, item);
      setDragId(null);
      setTarget(null);
      commit(item, drop);
    },
  });

  return (
    <div className={`workitem-board ${dragId ? 'is-dragging' : ''}`.trim()} ref={boardRef}>
      {WORK_ITEM_STATUSES.map((status) => {
        const column = byStatus.get(status) ?? { status, limit: null, count: 0, overLimit: false, items: [] };
        const all = drawn(column);
        // A card carried down Done by keyboard stays drawn wherever it goes
        const { shown, hidden } = foldColumn({ ...column, items: all }, Math.max(doneShown, grab?.at.status === 'done' ? grab.at.index + 1 : 0));
        const limit = projectNames ? null : column.limit;
        const over = !projectNames && column.overLimit;
        const others = dragId ? shown.filter((item) => item.id !== dragId) : shown;
        const indicatorAt = dragId && target?.status === status && !isSamePlace({ columns }, dragId, target) ? target.index : -1;
        const indicator = <div className="workitem-drop" aria-hidden />;
        return (
          <section key={status} className={`workitem-col ${over ? 'is-over' : ''}`.trim()} aria-label={label(status)} data-status={status} {...columnDrag(status)}>
            <div className="workitem-col-head">
              <WorkItemStatusIcon status={status} decorative />
              <FullText className="workitem-col-name">{label(status)}</FullText>
              <span className="workitem-col-count">
                <span aria-hidden>
                  <b>{column.count}</b>
                  {limit !== null && `/${limit}`}
                </span>
                <span className="sr-only">{limit !== null ? t('column.countLimit', { count: column.count, limit }) : t('column.count', { count: column.count })}</span>
              </span>
              <span className="grow" />
              {!projectNames && <ColumnRole status={status} />}
              {onNewTask && (
                <button type="button" className="icon-btn workitem-col-add" aria-label={t('actions.newTaskIn', { column: label(status) })} onClick={() => onNewTask(status)}>
                  <Plus {...ICON_SM} />
                </button>
              )}
            </div>
            {over && limit !== null && (
              <div className="workitem-col-limit" role="status">
                <TriangleAlert size={13} strokeWidth={1.75} aria-hidden />
                {t('column.over', { count: column.count, limit })}
              </div>
            )}
            <div className="workitem-col-body">
              {shown.map((item) => (
                <Fragment key={item.id}>
                  {indicatorAt >= 0 && others[indicatorAt]?.id === item.id && indicator}
                  <WorkItemCard
                    item={item}
                    project={projectNames?.get(item.projectId)}
                    epic={epics.get(item.id)}
                    live={live}
                    selection={
                      selection
                        ? { selected: selection.selected.has(item.id), blocked: selection.blockedReason(item), onToggle: () => selection.toggle(item) }
                        : undefined
                    }
                    grabbed={grab?.id === item.id}
                    dragging={dragId === item.id}
                    draggable={!selection}
                    more={coarse && !selection ? moveEntries(item) : undefined}
                    onOpen={() => onOpen(item)}
                    onKeyDown={cardKeys(item)}
                    onBlur={cardBlur(item)}
                    onDragStart={(event) => {
                      // A pointer takes over from a keyboard grab left on another card
                      if (grab) setGrab(null);
                      event.dataTransfer.effectAllowed = 'move';
                      event.dataTransfer.setData(DRAG_TYPE, item.id);
                      event.dataTransfer.setData('text/plain', item.key);
                      setDragId(item.id);
                    }}
                    onDragEnd={() => {
                      setDragId(null);
                      setTarget(null);
                    }}
                  />
                </Fragment>
              ))}
              {indicatorAt >= 0 && indicatorAt >= others.length && indicator}
              {shown.length === 0 && indicatorAt < 0 && <div className="workitem-col-slot">{dragId ? t('column.drop') : t('column.empty')}</div>}
              {status === 'done' && doneLoading && hidden > 0 ? (
                <DonePageSkeleton />
              ) : (
                hidden > 0 && <MoreButton count={hidden} onClick={onMoreDone} />
              )}
            </div>
          </section>
        );
      })}
      <div className="sr-only workitem-announce" role="status" aria-live="assertive">
        {said}
      </div>
    </div>
  );
}

/** "Mostrar 9 más": the next page of Done, drawn in place. */
export function MoreButton({ count, onClick, className = 'workitem-col-more' }: { count: number; onClick: () => void; className?: string }) {
  const { t } = useTranslation('tasks');
  return (
    <button type="button" className={className} onClick={onClick}>
      {t('column.more', { count })}
      <ChevronDown size={13} strokeWidth={1.75} aria-hidden />
    </button>
  );
}

/** Two skeleton cards where the next page of Done lands, so the column does not jump when it arrives. */
export function DonePageSkeleton() {
  const { t } = useTranslation('tasks');
  return (
    <div className="workitem-col-loading" role="status" aria-busy="true">
      <span className="sr-only">{t('column.loadingMore')}</span>
      <div className="workitem-card is-skeleton" aria-hidden>
        <span className="skeleton" style={{ width: '40%' }} />
        <span className="skeleton" style={{ width: '85%' }} />
      </div>
      <div className="workitem-card is-skeleton" aria-hidden>
        <span className="skeleton" style={{ width: '35%' }} />
        <span className="skeleton" style={{ width: '70%' }} />
      </div>
    </div>
  );
}

/** Arrow keys walk the board: up and down a column, left and right to the neighbouring column's card. */
function focusNeighbour(card: HTMLElement, key: string) {
  const column = card.closest<HTMLElement>('.workitem-col');
  const board = card.closest<HTMLElement>('.workitem-board');
  if (!column || !board) return;
  const cards = [...column.querySelectorAll<HTMLElement>('[data-item-id]')];
  const at = cards.indexOf(card);
  if (key === 'ArrowUp' || key === 'ArrowDown') {
    cards[at + (key === 'ArrowDown' ? 1 : -1)]?.focus();
    return;
  }
  const cols = [...board.querySelectorAll<HTMLElement>('.workitem-col')];
  const step = key === 'ArrowRight' ? 1 : -1;
  for (let i = cols.indexOf(column) + step; i >= 0 && i < cols.length; i += step) {
    const next = [...(cols[i]?.querySelectorAll<HTMLElement>('[data-item-id]') ?? [])];
    if (next.length) {
      (next[Math.min(at, next.length - 1)] ?? next[0])?.focus();
      return;
    }
  }
}
