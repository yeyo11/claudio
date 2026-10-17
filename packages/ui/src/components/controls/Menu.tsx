import * as RadixMenu from '@radix-ui/react-dropdown-menu';
import { Check, ChevronRight, Ellipsis, type LucideIcon } from 'lucide-react';
import { useId, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { ICON_SM } from '../icons';
import { LAYER_ATTR, layerCollisionPadding } from './layer';

export interface MenuItem {
  id: string;
  label: ReactNode;
  icon?: LucideIcon;
  onSelect?: () => void;
  /** Reads as a destructive action and is coloured as one */
  destructive?: boolean;
  /**
   * Not available now. The item stays focusable so its reason can be read: an action that has
   * disappeared is harder to understand than one that says why it cannot be used.
   */
  disabled?: boolean;
  disabledReason?: string;
  /** Turns the item into a checkbox item */
  checked?: boolean;
  /** The keyboard shortcut that does the same thing, shown in mono on the right */
  shortcut?: string;
  /** Makes the item a real link, e.g. a download the server answers with Content-Disposition */
  href?: string;
  download?: boolean;
  /**
   * A second, quieter line under the label: what the item is now, or why it is off. Read as the
   * item's description, so a screen reader hears it after the name.
   */
  meta?: ReactNode;
  /** What typing jumps to and what a sheet titles the step with, when the label is richer than text */
  text?: string;
  /**
   * Opens a submenu instead of acting. A phone's sheet shows it as a second step in the same sheet,
   * never as a second layer.
   */
  submenu?: MenuEntry[];
  /**
   * What a phone's sheet shows as a step of its own when this item is chosen, for content a menu
   * cannot hold (live switches, a searchable list). A menu ignores it: there the caller opens its
   * own panel from `onSelect`.
   */
  detail?: (step: { close: () => void }) => ReactNode;
  /** Told when the submenu or the detail step opens and closes, so what it shows is fetched only then */
  onOpenChange?: (open: boolean) => void;
}

export interface MenuGroup {
  id: string;
  label?: string;
  items: MenuItem[];
  /**
   * Makes the group a radio group: every item is an option, `value` is the id of the chosen one and
   * `onChange` hears the id of the one picked. A disabled item is never reported.
   */
  radio?: { value: string; onChange: (id: string) => void };
}

export type MenuEntry = MenuItem | MenuGroup | { id: string; separator: true };

export const isSeparator = (entry: MenuEntry): entry is { id: string; separator: true } => 'separator' in entry;
export const isGroup = (entry: MenuEntry): entry is MenuGroup => 'items' in entry;

/** The id a radio group reports, or null when the option cannot be chosen. */
export function radioChoice(group: MenuGroup, id: string): string | null {
  const item = group.items.find((candidate) => candidate.id === id);
  return item && !item.disabled ? id : null;
}

/**
 * The menu behind a `⋯`: where everything a page used to spell out in a row of buttons goes. Built
 * on Radix's dropdown menu, so it is one tab stop, the arrows move inside it, typing jumps to an
 * item and Escape closes it back onto its trigger.
 */
export function Menu({
  entries,
  label,
  trigger,
  align = 'end',
  side = 'bottom',
  className = '',
  disabled,
  onOpenChange,
}: {
  entries: MenuEntry[];
  /** Names the trigger when it is the default `⋯` button, and the menu itself always */
  label?: string;
  /** Replaces the default `⋯` button; it is rendered as the trigger itself */
  trigger?: ReactNode;
  align?: 'start' | 'center' | 'end';
  side?: 'top' | 'right' | 'bottom' | 'left';
  className?: string;
  /** Disables the default trigger */
  disabled?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  const { t } = useTranslation('primitives');
  const name = label ?? t('menu.more');
  return (
    <RadixMenu.Root onOpenChange={onOpenChange}>
      <RadixMenu.Trigger asChild>
        {trigger ?? (
          <button type="button" className={`icon-btn ${className}`.trim()} aria-label={name} disabled={disabled}>
            <Ellipsis {...ICON_SM} />
          </button>
        )}
      </RadixMenu.Trigger>
      <RadixMenu.Portal>
        <RadixMenu.Content className="menu menu-dropdown" side={side} align={align} sideOffset={6} collisionPadding={layerCollisionPadding()} aria-label={name} {...LAYER_ATTR}>
          <Entries entries={entries} />
        </RadixMenu.Content>
      </RadixMenu.Portal>
    </RadixMenu.Root>
  );
}

function Entries({ entries }: { entries: MenuEntry[] }) {
  return (
    <>
      {entries.map((entry) => {
        if (isSeparator(entry)) return <RadixMenu.Separator key={entry.id} className="menu-sep" />;
        if (!isGroup(entry)) return <Item key={entry.id} item={entry} />;
        const items = entry.items.map((item) => <Item key={item.id} item={item} radio={Boolean(entry.radio)} />);
        const { radio } = entry;
        return radio ? (
          <RadixMenu.RadioGroup
            key={entry.id}
            className="menu-group"
            aria-label={entry.label}
            value={radio.value}
            // Radix reports a radio item even when its select was prevented, so the guard is here
            onValueChange={(id) => {
              const chosen = radioChoice(entry, id);
              if (chosen !== null) radio.onChange(chosen);
            }}
          >
            {entry.label && <RadixMenu.Label className="menu-group-label">{entry.label}</RadixMenu.Label>}
            {items}
          </RadixMenu.RadioGroup>
        ) : (
          <RadixMenu.Group key={entry.id} className="menu-group">
            {entry.label && <RadixMenu.Label className="menu-group-label">{entry.label}</RadixMenu.Label>}
            {items}
          </RadixMenu.Group>
        );
      })}
    </>
  );
}

function Item({ item, radio = false }: { item: MenuItem; radio?: boolean }) {
  const Icon = item.icon;
  const whyId = useId();
  // A reason and a meta line are the same second line: one says why it is off, the other what it is
  const why = item.disabled && item.disabledReason ? item.disabledReason : item.meta;
  const classes = `menu-item ${item.destructive ? 'is-destructive' : ''} ${item.disabled ? 'is-disabled' : ''}`.trim();
  const body = (
    <>
      {Icon && <Icon {...ICON_SM} className="menu-item-icon" />}
      <span className="menu-item-text">
        <span>{item.label}</span>
        {why && (
          <span id={whyId} className="menu-item-why menu-item-meta">
            {why}
          </span>
        )}
      </span>
      {item.checked && !radio && <Check {...ICON_SM} className="menu-item-check" aria-hidden />}
      {item.shortcut && (
        <span className="menu-item-key" aria-hidden>
          {item.shortcut}
        </span>
      )}
    </>
  );
  if (item.submenu && !item.disabled)
    return (
      <RadixMenu.Sub onOpenChange={item.onOpenChange}>
        <RadixMenu.SubTrigger className={classes} textValue={item.text} aria-describedby={why ? whyId : undefined}>
          {body}
          <ChevronRight {...ICON_SM} className="menu-item-more" aria-hidden />
        </RadixMenu.SubTrigger>
        <RadixMenu.Portal>
          <RadixMenu.SubContent className="menu menu-dropdown" sideOffset={4} collisionPadding={layerCollisionPadding()} aria-label={item.text} {...LAYER_ATTR}>
            <Entries entries={item.submenu} />
          </RadixMenu.SubContent>
        </RadixMenu.Portal>
      </RadixMenu.Sub>
    );
  // Radix skips a `disabled` item entirely; keeping it selectable-but-inert is what lets someone
  // reach it and hear why it is off.
  if (item.disabled)
    return (
      <ItemKind radio={radio} id={item.id} className={classes} text={item.text} aria-disabled aria-describedby={why ? whyId : undefined} onSelect={(event) => event.preventDefault()}>
        {body}
        {radio && <Indicator />}
      </ItemKind>
    );
  if (item.href)
    return (
      <RadixMenu.Item className={classes} asChild onSelect={() => item.onSelect?.()}>
        <a href={item.href} download={item.download || undefined}>
          {body}
        </a>
      </RadixMenu.Item>
    );
  if (item.checked !== undefined)
    return (
      <RadixMenu.CheckboxItem className={classes} checked={item.checked} onCheckedChange={() => item.onSelect?.()}>
        {body}
      </RadixMenu.CheckboxItem>
    );
  return (
    <ItemKind radio={radio} id={item.id} className={classes} text={item.text} aria-describedby={why ? whyId : undefined} onSelect={() => item.onSelect?.()}>
      {body}
      {radio && <Indicator />}
    </ItemKind>
  );
}

/** The check that marks the chosen option of a radio group, on the right like every other check. */
function Indicator() {
  return (
    <RadixMenu.ItemIndicator className="menu-item-check">
      <Check {...ICON_SM} aria-hidden />
    </RadixMenu.ItemIndicator>
  );
}

function ItemKind({
  radio,
  id,
  text,
  children,
  ...props
}: {
  radio: boolean;
  id: string;
  text?: string;
  className: string;
  children: ReactNode;
  'aria-disabled'?: boolean;
  'aria-describedby'?: string;
  onSelect: (event: Event) => void;
}) {
  return radio ? (
    <RadixMenu.RadioItem value={id} textValue={text} {...props}>
      {children}
    </RadixMenu.RadioItem>
  ) : (
    <RadixMenu.Item textValue={text} {...props}>
      {children}
    </RadixMenu.Item>
  );
}
