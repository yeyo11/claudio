import type { ClaudioServer, ServerStatus } from '@claudio/shared';
import { ArrowUpCircle, CircleCheck, CircleDashed, KeyRound, ShieldAlert, WifiOff, type LucideIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { ICON_SM, Monogram } from '@claudio/ui/components/icons';
import { Spinner } from '@claudio/ui/components/Spinner';
import { SERVER_TONE, serverHue, serverLetters } from '../lib/servers-model';

/*
 * A server as every surface draws it (docs/plans/claudio-servers.md §12.1): the selector, the status
 * bar, the phone's More sheet, the Servers page and its dialogs. One mark and one status word, so a
 * server looks and reads the same wherever it shows.
 */

/** A server's monogram in its colour token's hue: the project's `.monogram`, fed an hue, never a hex */
export function ServerMark({ server, size = 20, className }: { server: Pick<ClaudioServer, 'name' | 'color' | 'monogram'>; size?: number; className?: string }) {
  return <Monogram name={server.name} size={size} letters={serverLetters(server)} hue={serverHue(server)} className={className} />;
}

const ICONS: Record<ServerStatus, LucideIcon> = {
  connected: CircleCheck,
  reconnecting: CircleDashed,
  offline: WifiOff,
  'needs-update': ArrowUpCircle,
  'needs-pairing': KeyRound,
  'identity-changed': ShieldAlert,
};

/**
 * A status in its word, its tone and an icon, so colour never says it alone (the Collaborators
 * page's `.collab-tone`). Reconnecting is the one that moves: the braille spinner beside the verb.
 * A server nobody has read yet (the hub keeps health in memory only) says nothing in the shell, and
 * "Not checked", neutral, where the page lists it (`unchecked`).
 */
export function ServerStatusWord({ status, unchecked = false }: { status: ServerStatus | null; unchecked?: boolean }) {
  const { t } = useTranslation('shell');
  if (status === null) {
    if (!unchecked) return null;
    return (
      <span className="collab-tone server-status" data-status="unchecked">
        <CircleDashed {...ICON_SM} />
        <span>{t('servers.status.unchecked')}</span>
      </span>
    );
  }
  const Icon = ICONS[status];
  return (
    <span className={`collab-tone server-status tone-${SERVER_TONE[status]}`} data-status={status}>
      {status === 'reconnecting' ? <Spinner /> : <Icon {...ICON_SM} />}
      <span>{t(`servers.status.${status}`)}</span>
    </span>
  );
}
