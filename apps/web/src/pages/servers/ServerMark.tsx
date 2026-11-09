import type { ClaudioServer, ServerStatus } from '@claudio/shared';
import { ArrowUpCircle, CircleCheck, CircleDashed, KeyRound, ShieldAlert, WifiOff, type LucideIcon } from 'lucide-react';
import type { CSSProperties } from 'react';
import { useTranslation } from 'react-i18next';
import { ICON_SM } from '@claudio/ui/components/icons';
import { Spinner } from '@claudio/ui/components/Spinner';
import { defaultMonogram, SERVER_TONE, serverHue } from '../../lib/servers-model';

/** The server's tile: its monogram in its colour's tint, the project's `.monogram` fed an hue (never a hex) */
export function ServerMark({ server, size = 36 }: { server: Pick<ClaudioServer, 'name' | 'color' | 'monogram'>; size?: number }) {
  const letters = server.monogram?.trim() || defaultMonogram(server.name);
  return (
    <span className="monogram server-mark" style={{ '--hue': serverHue(server), '--monogram-size': `${size}px`, width: size, height: size } as CSSProperties} aria-hidden>
      {letters || '?'}
    </span>
  );
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
 * A status in its word, its tone and an icon, so colour never says it alone. Reconnecting is the one
 * that moves: the braille spinner beside the verb. A server with no reading yet is "Not checked", neutral.
 */
export function ServerStatusWord({ status }: { status: ServerStatus | null }) {
  const { t } = useTranslation('serversPage');
  if (status === null) {
    return (
      <span className="server-status" data-status="unchecked">
        <CircleDashed {...ICON_SM} />
        <span>{t('status.unchecked')}</span>
      </span>
    );
  }
  const Icon = ICONS[status];
  return (
    <span className={`server-status tone-${SERVER_TONE[status]}`} data-status={status}>
      {status === 'reconnecting' ? <Spinner /> : <Icon {...ICON_SM} />}
      <span>{t(`status.${status}`)}</span>
    </span>
  );
}
