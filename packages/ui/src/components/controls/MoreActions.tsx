import { Check, ChevronDown, ChevronLeft, ChevronRight, Ellipsis, type LucideIcon } from 'lucide-react';
import { Fragment, useEffect, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { NARROW, useMediaQuery } from '../../lib/media';
import { ICON_SM } from '../icons';
import { isGroup, isSeparator, Menu, radioChoice, type MenuEntry, type MenuGroup, type MenuItem } from './Menu';
import { Sheet } from './Sheet';

/**
 * What a sheet shows for a list of entries: the groups keep their heading (a sheet has the room a
 * dropdown lacks) and the separators lose their line.
 */
export function sheetSections(entries: MenuEntry[]): Array<{ id: string; label?: string; group?: MenuGroup; items: MenuItem[] }> {
  const sections: Array<{ id: string; label?: string; group?: MenuGroup; items: MenuItem[] }> = [];
  let loose: MenuItem[] = [];
  const flush = () => {
    if (loose.length > 0) sections.push({ id: `loose-${loose[0]?.id}`, items: loose });
    loose = [];
  };
  for (const entry of entries) {
    if (isSeparator(entry)) continue;
    if (isGroup(entry)) {
      flush();
      sections.push({ id: entry.id, label: entry.label, group: entry, items: entry.items });
    } else loose.push(entry);
  }
  flush();
  return sections;
}

/**
 * The `⋯` of a card or a page: a menu by the button on a desktop, a sheet of big buttons from the
 * bottom on a phone, where a dropdown's rows are too small for a finger. Both open from the same
 * button, named by `label`.
 *
 * An item with a `submenu` or a `detail` is a step: on a phone the sheet swaps its list for the
 * step's and shows a back button, so a second level never stacks a sheet on a sheet.
 */
export function MoreActions({
  entries,
  label,
  title,
  align = 'end',
  side = 'bottom',
  className = '',
  text,
  icon: Icon = Ellipsis,
  disabled,
  backLabel,
  onOpenChange,
}: {
  entries: MenuEntry[];
  label?: string;
  /** The sheet's heading; defaults to `label` */
  title?: string;
  align?: 'start' | 'center' | 'end';
  /** Where the dropdown opens; a sheet is always from the bottom */
  side?: 'top' | 'right' | 'bottom' | 'left';
  /** On the trigger, in both forms */
  className?: string;
  /** Turns the `⋯` into a labelled button, for a menu that says what it does ("Set all to…") */
  text?: string;
  /** Replaces the `⋯` on an icon trigger */
  icon?: LucideIcon;
  disabled?: boolean;
  /** Names the button that leaves a step; defaults to the title of the list it returns to */
  backLabel?: string;
  onOpenChange?: (open: boolean) => void;
}) {
  const { t } = useTranslation('primitives');
  const narrow = useMediaQuery(NARROW);
  const [open, setOpen] = useState(false);
  const [steps, setSteps] = useState<MenuItem[]>([]);
  const reasonId = useId();
  const list = useRef<HTMLDivElement>(null);
  const comingBack = useRef<string | null>(null);
  const name = label ?? t('menu.more');
  const labelled = text !== undefined;
  const step = steps.at(-1);

  // Back in the list, the focus is on the item that opened the step, not on the top of the sheet
  useEffect(() => {
    const id = comingBack.current;
    if (id === null) return;
    comingBack.current = null;
    list.current?.querySelector<HTMLElement>(`[data-item="${CSS.escape(id)}"]`)?.focus();
  }, [steps]);

  if (!narrow && !labelled)
    return (
      <Menu
        entries={entries}
        label={name}
        align={align}
        side={side}
        className={className}
        disabled={disabled}
        onOpenChange={onOpenChange}
        trigger={
          <button type="button" className={`icon-btn ${className}`.trim()} aria-label={name} disabled={disabled}>
            <Icon {...ICON_SM} />
          </button>
        }
      />
    );
  if (!narrow)
    return (
      <Menu
        entries={entries}
        label={name}
        align={align}
        side={side}
        onOpenChange={onOpenChange}
        trigger={
          <button type="button" className={`btn btn-small ${className}`.trim()} disabled={disabled}>
            {text} <ChevronDown {...ICON_SM} />
          </button>
        }
      />
    );

  const change = (next: boolean) => {
    if (!next) {
      for (const s of steps) s.onOpenChange?.(false);
      setSteps([]);
    }
    setOpen(next);
    onOpenChange?.(next);
  };
  const enter = (item: MenuItem) => {
    comingBack.current = null;
    item.onOpenChange?.(true);
    setSteps((s) => [...s, item]);
  };
  const leave = () => {
    const left = steps.at(-1);
    left?.onOpenChange?.(false);
    comingBack.current = left?.id ?? null;
    setSteps((s) => s.slice(0, -1));
  };
  const shown = step ? (step.submenu ?? []) : entries;
  const previous = steps.length > 1 ? steps.at(-2) : undefined;

  return (
    <>
      {labelled ? (
        <button type="button" className={`btn btn-small ${className}`.trim()} aria-haspopup="dialog" disabled={disabled} onClick={() => change(true)}>
          {text} <ChevronDown {...ICON_SM} />
        </button>
      ) : (
        <button type="button" className={`icon-btn ${className}`.trim()} aria-label={name} aria-haspopup="dialog" disabled={disabled} onClick={() => change(true)}>
          <Icon {...ICON_SM} />
        </button>
      )}
      <Sheet open={open} onOpenChange={change} title={step ? (step.text ?? title ?? name) : (title ?? name)} side="bottom">
        <div ref={list} className="sheet-actions">
          {step && (
            <button type="button" className="btn btn-small sheet-back" autoFocus aria-label={backLabel} onClick={leave}>
              <ChevronLeft {...ICON_SM} aria-hidden /> {previous?.text ?? title ?? name}
            </button>
          )}
          {step?.detail
            ? step.detail({ close: () => change(false) })
            : sheetSections(shown).map((section) => {
                const { group } = section;
                const rows = section.items.map((item) => (
                  <SheetItem
                    key={item.id}
                    item={item}
                    reasonId={reasonId}
                    radio={group?.radio ? { checked: group.radio.value === item.id } : undefined}
                    onStep={() => enter(item)}
                    onPick={() => {
                      // The sheet closes before the action runs, so a confirmation is not stacked over it
                      change(false);
                      if (group?.radio) {
                        const chosen = radioChoice(group, item.id);
                        if (chosen !== null && chosen !== group.radio.value) group.radio.onChange(chosen);
                      } else item.onSelect?.();
                    }}
                    onLink={() => change(false)}
                  />
                ));
                if (!section.label && !group) return <Fragment key={section.id}>{rows}</Fragment>;
                const headingId = `${reasonId}-h-${section.id}`;
                return (
                  <div key={section.id} className="sheet-group" role={group?.radio ? 'radiogroup' : 'group'} aria-labelledby={section.label ? headingId : undefined}>
                    {section.label && (
                      <h3 id={headingId} className="sheet-group-label">
                        {section.label}
                      </h3>
                    )}
                    {rows}
                  </div>
                );
              })}
        </div>
      </Sheet>
    </>
  );
}

function SheetItem({
  item,
  reasonId,
  radio,
  onStep,
  onPick,
  onLink,
}: {
  item: MenuItem;
  reasonId: string;
  radio?: { checked: boolean };
  onStep: () => void;
  onPick: () => void;
  onLink: () => void;
}) {
  const Icon = item.icon;
  const className = `btn btn-block ${item.destructive ? 'btn-danger' : ''} ${item.disabled ? 'is-disabled' : ''}`.trim();
  const reason = item.disabled ? item.disabledReason : undefined;
  const isStep = Boolean(item.submenu || item.detail) && !item.disabled;
  const checked = radio ? radio.checked : item.checked;
  const content = (
    <>
      {Icon && <Icon {...ICON_SM} />}
      <span className="sheet-action-label">
        <span>{item.label}</span>
        {item.meta && !reason && <span className="sheet-action-meta">{item.meta}</span>}
      </span>
      {checked && <Check {...ICON_SM} className="sheet-action-check" aria-hidden />}
      {isStep && <ChevronRight {...ICON_SM} className="sheet-action-check" aria-hidden />}
    </>
  );
  // A download stays a real link, as in the menu: the server answers with Content-Disposition
  if (item.href && !item.disabled)
    return (
      <a className={className} href={item.href} download={item.download} onClick={onLink}>
        {content}
      </a>
    );
  return (
    <div className="sheet-action">
      <button
        type="button"
        data-item={item.id}
        className={className}
        role={radio ? 'radio' : undefined}
        aria-checked={radio ? radio.checked : undefined}
        // Not `disabled`: a disabled button leaves the tab order, and its reason (written out under
        // it, since a finger has no hover) would be the one thing nobody could reach
        aria-disabled={item.disabled || undefined}
        aria-describedby={reason ? `${reasonId}-${item.id}` : undefined}
        aria-pressed={radio ? undefined : item.checked}
        onClick={() => {
          if (item.disabled) return;
          if (isStep) onStep();
          else onPick();
        }}
      >
        {content}
      </button>
      {reason && (
        <p id={`${reasonId}-${item.id}`} className="sheet-action-reason">
          {reason}
        </p>
      )}
    </div>
  );
}
