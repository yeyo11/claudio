import type { BoardColumn, WorkItem, WorkItemStatus } from '@claudio/shared';
import { WORK_ITEM_STATUSES } from '@claudio/shared';
import type { MenuEntry } from '@claudio/ui/components/controls/Menu';
import { ArrowDown, ArrowUp, CornerDownRight } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { columnMeta } from '../../../lib/work-items';
import { neighbourStatus, projectSpan } from './model';
import { useMoveWorkItem } from './useMoveWorkItem';

/**
 * A card's "⋯" where a finger cannot drag: the phone's rows and the board's cards under a coarse
 * pointer. A step up or down inside the card's own project, and every other column; the move goes
 * through the board's one hook, so its neighbour is named the way a drag names it.
 */
export function useMoveMenu(columns: readonly BoardColumn[]): (item: WorkItem) => MenuEntry[] {
  const { t } = useTranslation('tasks');
  const move = useMoveWorkItem();
  const byStatus = new Map(columns.map((column) => [column.status, column]));
  const label = (status: WorkItemStatus) => t(columnMeta(status).label);

  const entries = (item: WorkItem): MenuEntry[] => {
    const items = byStatus.get(item.status)?.items ?? [];
    const at = items.findIndex((entry) => entry.id === item.id);
    const to = (status: WorkItemStatus, index: number, column: readonly WorkItem[]) => move.mutate({ item, status, place: { index, column } });
    const list: MenuEntry[] = [];
    // Done is in closing order: no place in it to move a card to. A step never crosses into another project's cards
    if (item.status !== 'done' && at >= 0) {
      const { start, end } = projectSpan(items, item.projectId);
      if (at > start) list.push({ id: 'up', label: t('move.up'), icon: ArrowUp, onSelect: () => to(item.status, at - 1, items) });
      if (at < end - 1) list.push({ id: 'down', label: t('move.down'), icon: ArrowDown, onSelect: () => to(item.status, at + 1, items) });
    }
    for (const status of WORK_ITEM_STATUSES) {
      if (status === item.status) continue;
      const column = byStatus.get(status)?.items ?? [];
      // Into the neighbouring columns at the top, where a card goes next; elsewhere at the end
      const index = status === 'done' || status === neighbourStatus(item.status, 1) || status === neighbourStatus(item.status, -1) ? 0 : column.length;
      list.push({ id: status, label: t('move.to', { column: label(status) }), icon: CornerDownRight, onSelect: () => to(status, index, column) });
    }
    return list;
  };

  return entries;
}
