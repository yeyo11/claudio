import type { ServerAddressKind } from '@claudio/shared';
import { Check, ChevronDown, ChevronUp, Plus, X } from 'lucide-react';
import type { CSSProperties } from 'react';
import { useTranslation } from 'react-i18next';
import { Select } from '@claudio/ui/components/controls/Select';
import { ICON_SM } from '@claudio/ui/components/icons';
import { ADDRESS_KINDS, guessAddressKind, MAX_ADDRESSES, moveItem, newDraft, normalizeAddress, SERVER_COLOR_NAMES, SERVER_COLORS, type AddressDraft, type ServerColor } from '../../lib/servers-model';

/**
 * The addresses of a server, in the order they are tried: each a host or origin with its kind, and
 * up, down and remove. Reordering is buttons, not a drag, so it works with a keyboard and a finger.
 * A row typed but not an address says so under itself (`invalid` holds its key).
 */
export function AddressesEditor({ drafts, onChange, invalid = [] }: { drafts: readonly AddressDraft[]; onChange: (next: AddressDraft[]) => void; invalid?: readonly number[] }) {
  const { t } = useTranslation('serversPage');
  const patch = (key: number, change: Partial<AddressDraft>) => onChange(drafts.map((draft) => (draft.key === key ? { ...draft, ...change } : draft)));
  return (
    <div className="server-addresses" data-testid="server-addresses">
      <ul className="server-address-list">
        {drafts.map((draft, index) => {
          const n = String(index + 1);
          const shownKind: ServerAddressKind = draft.kind ?? (normalizeAddress(draft.url) ? guessAddressKind(draft.url) : 'lan');
          return (
            <li key={draft.key} className="server-address-row" data-testid="server-address-row">
              <input
                className="mono server-address-input"
                value={draft.url}
                onChange={(e) => patch(draft.key, { url: e.target.value })}
                placeholder={t('add.addressPlaceholder')}
                aria-label={`${t('add.address')} ${n}`}
                aria-invalid={invalid.includes(draft.key) || undefined}
                inputMode="url"
                autoComplete="off"
                spellCheck={false}
              />
              <Select<ServerAddressKind>
                value={shownKind}
                onChange={(kind) => patch(draft.key, { kind })}
                options={ADDRESS_KINDS.map((kind) => ({ value: kind, label: t(`row.kind.${kind}`) }))}
                aria-label={t('addresses.kind', { n })}
                className="server-address-kind"
              />
              <span className="server-address-moves">
                <button type="button" className="icon-btn" disabled={index === 0} aria-label={t('addresses.up', { n })} onClick={() => onChange(moveItem(drafts, index, index - 1))}>
                  <ChevronUp {...ICON_SM} />
                </button>
                <button type="button" className="icon-btn" disabled={index === drafts.length - 1} aria-label={t('addresses.down', { n })} onClick={() => onChange(moveItem(drafts, index, index + 1))}>
                  <ChevronDown {...ICON_SM} />
                </button>
                <button type="button" className="icon-btn" disabled={drafts.length === 1} aria-label={t('addresses.remove', { n })} onClick={() => onChange(drafts.filter((d) => d.key !== draft.key))}>
                  <X {...ICON_SM} />
                </button>
              </span>
              {invalid.includes(draft.key) && (
                <span className="field-hint server-address-invalid" role="alert">
                  {t('addresses.invalid')}
                </span>
              )}
            </li>
          );
        })}
      </ul>
      <div className="server-address-add">
        <button type="button" className="btn btn-small" disabled={drafts.length >= MAX_ADDRESSES} onClick={() => onChange([...drafts, newDraft()])} data-testid="server-address-add">
          <Plus {...ICON_SM} /> {t('addresses.add')}
        </button>
        {drafts.length >= MAX_ADDRESSES && <span className="small muted">{t('addresses.max', { count: MAX_ADDRESSES })}</span>}
      </div>
    </div>
  );
}

/** The colours a server can wear, as a radio group of tinted tiles: the chosen one carries a check, not only a ring */
export function ColourPicker({ value, onChange }: { value: string | null; onChange: (color: ServerColor) => void }) {
  const { t } = useTranslation('serversPage');
  return (
    <div className="server-colours" role="radiogroup" aria-label={t('colours.label')}>
      {SERVER_COLOR_NAMES.map((name) => (
        <button
          key={name}
          type="button"
          role="radio"
          aria-checked={value === name}
          aria-label={t(`colours.${name}`)}
          className={`server-colour ${value === name ? 'is-on' : ''}`}
          onClick={() => onChange(name)}
        >
          <span className="monogram server-colour-tile" style={{ '--hue': SERVER_COLORS[name], '--monogram-size': '28px' } as CSSProperties} aria-hidden>
            {value === name && <Check {...ICON_SM} />}
          </span>
        </button>
      ))}
    </div>
  );
}
