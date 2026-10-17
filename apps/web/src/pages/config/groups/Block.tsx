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
