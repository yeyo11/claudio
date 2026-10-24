import { ChevronRight } from 'lucide-react';
import { createContext, useContext, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { ICON_SM } from '@claudio/ui/components/icons';
import type { DetailOf, SettingsGroupId } from '../settingsGroups';

/** What the shell hands a group's screen: the detail the address names, already checked, or none. */
export interface GroupScreenProps<G extends SettingsGroupId> {
  detail?: DetailOf<G> | undefined;
}

/**
 * The heading level a section takes: under the group's title on a desktop (h2, so h3), under the
 * phone header's title on a phone (h1, so h2). The shell says which.
 */
export const SectionLevel = createContext<2 | 3>(3);

/**
 * One section of a group's screen (docs/plans/settings-ia.md §6.0): its heading carries the anchor
 * `#<id>` scrolls to, and takes the focus when it does. Space separates sections, never a border.
 */
export function SettingsSection({ id, title, aside, children }: { id: string; title: string; aside?: ReactNode; children: ReactNode }) {
  const level = useContext(SectionLevel);
  const Heading = level === 2 ? 'h2' : 'h3';
  const heading = (
    <Heading id={`${id}-title`} className="settings-section-title" tabIndex={-1} data-section-heading>
      {title}
    </Heading>
  );
  return (
    // Not a named region: a tab moved in whole may be one already, and two of one name confuse a reader
    <section id={id} className="settings-section">
      {/* `aside`: a fact about the whole section, on its head line (the Provider's "Overridden in N projects") */}
      {aside === undefined ? (
        heading
      ) : (
        <div className="settings-section-head">
          {heading}
          {aside}
        </div>
      )}
      {children}
    </section>
  );
}

/**
 * A row that opens a detail screen: its name, a count and where the items come from, and a chevron
 * ("Skills · 12 · 3 from plugins"). The whole row is the link, 44 px high on a phone.
 */
export function SettingsDetailRow({
  to,
  label,
  description,
  note,
  setting,
}: {
  to: string;
  label: string;
  /** One line under the name: what the items are, when the row stands for a whole section */
  description?: string | undefined;
  note?: ReactNode;
  setting?: string;
}) {
  return (
    <Link className="settings-detail-row" to={to} {...(setting ? { 'data-setting': setting } : {})}>
      {description ? (
        <span className="settings-detail-text">
          <span className="settings-detail-name">{label}</span>
          <span className="settings-detail-desc">{description}</span>
        </span>
      ) : (
        <span className="settings-detail-name">{label}</span>
      )}
      {note !== undefined && <span className="settings-detail-note tnum">{note}</span>}
      <ChevronRight {...ICON_SM} className="settings-detail-chevron" aria-hidden />
    </Link>
  );
}

/**
 * A section that is one detail row: the row names it, so it takes no heading of its own, and `#<id>`
 * lands on the row (docs/plans/settings-ia.md §6.0). Consecutive ones sit in a `RowSections` list.
 */
export function SettingsRowSection({ id, ...row }: { id: string } & Parameters<typeof SettingsDetailRow>[0]) {
  return (
    <section id={id} className="settings-row-section" aria-label={row.label}>
      <SettingsDetailRow {...row} />
    </section>
  );
}

/** One-row sections side by side with a row's gap, not a section's. */
export function RowSections({ children }: { children: ReactNode }) {
  return <div className="settings-row-sections">{children}</div>;
}
