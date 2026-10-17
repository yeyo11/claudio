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
export function SettingsReveal({ open, children }: { open: boolean; children: ReactNode }) {
  return (
    <div className={open ? 'settings-reveal is-open' : 'settings-reveal'} inert={!open}>
      <div className="settings-reveal-body">{children}</div>
    </div>
  );
}
