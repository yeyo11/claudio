import { AppSettingsCards } from '../AppSettingsCards';
import type { GroupScreenProps } from './Section';

/** Settings → Runs & spend (§6.7). A placeholder over today's run settings cards, until w4 builds the screen. */
export function Runs(_: GroupScreenProps<'runs'>) {
  return (
    <div className="settings-group" id="runs">
      <AppSettingsCards />
    </div>
  );
}
