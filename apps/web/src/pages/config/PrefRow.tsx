import type { ReactNode } from 'react';

/**
 * One setting as `settings-patterns.md` draws it: the label with its consequence under it, the
 * control beside them, stacked under the label when the container is narrow. `setting` is the id
 * the search registry (`settingsIndex.ts`) names, so a result lands on this row. A row whose control
 * is a whole block (a list, a form) is `stacked`: the label over it at every width. `change` is the
 * `[● Changed · Reset]` slot (`SettingChange`).
 */
export function PrefRow({
  id,
  setting,
  title,
  hint,
  stacked = false,
  change,
  children,
}: {
  id: string;
  setting: string;
  title: ReactNode;
  hint?: ReactNode;
  stacked?: boolean;
  /** The row's `SettingChange` slot, under the control; it keeps its room while nothing is changed */
  change?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className={`pref-row${stacked ? ' is-stacked' : ''}`} role="group" aria-labelledby={`${id}-title`} data-setting={setting}>
      <div className="pref-row-text">
        <span id={`${id}-title`} className="pref-row-title">
          {title}
        </span>
        {hint !== undefined && <div className="pref-row-hint">{hint}</div>}
      </div>
      <div className="pref-row-control">
        {children}
        {change}
      </div>
    </div>
  );
}

/**
 * A button's label that keeps the width of its longest state (AP10): every state sits in one grid
 * cell and only the current one is visible, so "Check" → "Checking…" moves nothing.
 */
export function ReservedLabel({ states, shown }: { states: readonly string[]; shown: number }) {
  return (
    <span className="reserved-label">
      {states.map((label, at) => (
        <span key={label} className={at === shown ? undefined : 'is-off'} aria-hidden={at === shown ? undefined : true}>
          {label}
        </span>
      ))}
    </span>
  );
}

/** The rows of one section: space between them, and the container their stacking measures. */
export function PrefRows({ children }: { children: ReactNode }) {
  return <div className="pref-rows">{children}</div>;
}
