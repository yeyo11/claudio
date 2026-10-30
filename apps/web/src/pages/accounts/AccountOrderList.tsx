import type { Account } from '@claudio/shared';
import { ArrowDown, ArrowUp, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { ICON_SM } from '@claudio/ui/components/icons';
import { accountName } from '../../lib/accounts';

const nameOf = (accounts: readonly Account[], id: string) => {
  const found = accounts.find((a) => a.id === id);
  return found ? accountName(found) : id;
};

/** `order` with the entry at `index` swapped with its neighbour `by` away; the same list when there is none. */
export function moveInOrder(order: readonly string[], index: number, by: -1 | 1): string[] {
  const next = [...order];
  const a = next[index];
  const b = next[index + by];
  if (a === undefined || b === undefined) return next;
  next[index] = b;
  next[index + by] = a;
  return next;
}

/**
 * Accounts in an order a person sets with up and down buttons: a rotation policy's, and the global
 * one of the Rotation card. Removing an entry is offered only where the list is an allow-list (a
 * policy); the global order holds every enabled account once.
 */
export function AccountOrderList({
  order,
  accounts,
  labelledBy,
  disabled = false,
  onChange,
  onRemove,
}: {
  order: readonly string[];
  accounts: readonly Account[];
  labelledBy: string;
  disabled?: boolean;
  onChange: (next: string[]) => void;
  onRemove?: (id: string) => void;
}) {
  const { t } = useTranslation('accountsConfig');
  return (
    <ol className="list" aria-labelledby={labelledBy}>
      {order.map((id, i) => (
        <li key={id} className="list-row list-row-flow small">
          <span className="count">{i + 1}</span>
          <span className="break">{nameOf(accounts, id)}</span>
          <span className="row-actions">
            <button type="button" className="icon-btn" disabled={disabled || i === 0} aria-label={t('policies.moveEarlier', { name: nameOf(accounts, id) })} onClick={() => onChange(moveInOrder(order, i, -1))}>
              <ArrowUp {...ICON_SM} />
            </button>
            <button type="button" className="icon-btn" disabled={disabled || i === order.length - 1} aria-label={t('policies.moveLater', { name: nameOf(accounts, id) })} onClick={() => onChange(moveInOrder(order, i, 1))}>
              <ArrowDown {...ICON_SM} />
            </button>
            {onRemove && (
              <button type="button" className="icon-btn" disabled={disabled} aria-label={t('policies.removeAccount', { name: nameOf(accounts, id) })} onClick={() => onRemove(id)}>
                <X {...ICON_SM} />
              </button>
            )}
          </span>
        </li>
      ))}
    </ol>
  );
}
