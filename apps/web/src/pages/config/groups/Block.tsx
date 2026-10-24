import { useContext, type ReactNode } from 'react';
import { SectionLevel } from './Section';

/**
 * One named part of a section that holds several (Access: the mode, the token, read-only): its name
 * a level under the section's heading, its state beside it in words, and the search's `data-setting`
 * on the whole of it, so a result focuses its first control. Space separates it, never a border.
 */
export function SettingsBlock({ title, status, setting, children }: { title: string; status?: ReactNode; setting: string; children: ReactNode }) {
  const level = useContext(SectionLevel);
  const Heading = level === 2 ? 'h3' : 'h4';
  return (
    <div className="settings-block" data-setting={setting}>
      <div className="settings-block-head">
        <Heading className="settings-block-title">{title}</Heading>
        {status}
      </div>
      {children}
    </div>
  );
}

/** A control and the consequence line attached under it, close enough to read as one row. */
export function SettingsRow({ children }: { children: ReactNode }) {
  return <div className="settings-row">{children}</div>;
}

/**
 * What shows only while it applies (the cap's amount, the OIDC fields, what is missing): always
 * mounted, opened with `grid-template-rows: 0fr → 1fr` so the rows below glide instead of jumping,
 * and `inert` while closed so nobody tabs into what cannot be seen.
 */
export function SettingsReveal({ open, hold = false, children }: { open: boolean; hold?: boolean; children: ReactNode }) {
  // `hold`: closed by something other than the person's hand (a Reset), it keeps its room, hidden and
  // inert, until their next change: a collapse they did not start would move everything under it
  return (
    <div className={`settings-reveal${open ? ' is-open' : hold ? ' is-held' : ''}`} inert={!open}>
      <div className="settings-reveal-body">{children}</div>
    </div>
  );
}

/**
 * A section's save: both its words stacked in one cell, so it keeps the width of the longer and
 * nothing beside it moves while it saves (AP10, invariant I5). It takes the gradient only while the
 * section has changes, so a screen of quiet sections shows none.
 */
export function SaveButton({
  label,
  savingLabel,
  dirty,
  pending,
  disabled = false,
  type = 'submit',
  onClick,
}: {
  label: string;
  savingLabel: string;
  dirty: boolean;
  pending: boolean;
  disabled?: boolean;
  type?: 'submit' | 'button';
  onClick?: () => void;
}) {
  return (
    <button
      type={type}
      // A save nobody can press is not the zone's next step: the gradient goes to what is
      className={dirty && !disabled ? 'btn btn-primary' : 'btn'}
      disabled={disabled || !dirty || pending}
      data-states="idle|loading"
      data-state={pending ? 'loading' : 'idle'}
      onClick={onClick}
    >
      <span className="btn-states">
        <span className="btn-state-idle">{label}</span>
        <span className="btn-state-loading">{savingLabel}</span>
      </span>
    </button>
  );
}
