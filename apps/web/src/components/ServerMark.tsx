import type { ClaudioServer } from '@claudio/shared';
import { useTranslation } from 'react-i18next';
import { Monogram } from '@claudio/ui/components/icons';
import { Spinner } from '@claudio/ui/components/Spinner';
import { serverHue, serverLetters, serverStatus, type ServerTone } from '../lib/servers-model';

/** A server's monogram in its colour token's hue (docs/plans/claudio-servers.md §12.1) */
export function ServerMark({ server, size = 20 }: { server: Pick<ClaudioServer, 'name' | 'color' | 'monogram'>; size?: number }) {
  return <Monogram name={server.name} size={size} letters={serverLetters(server)} hue={serverHue(server)} />;
}

const TONE_CLASS: Record<ServerTone, string | undefined> = { ok: 'text-ok', warn: 'text-warn', bad: 'text-bad', idle: undefined };

/**
 * A server's status as a word, coloured by what it means and never by colour alone. Reconnecting is
 * the one that moves: a braille spinner beside the verb, which stops under the motion levels. A
 * server nobody has read yet shows nothing.
 */
export function ServerStatusWord({ server }: { server: Pick<ClaudioServer, 'health'> }) {
  const { t } = useTranslation('shell');
  const status = serverStatus(server);
  if (!status) return null;
  return (
    <span className={`server-status ${TONE_CLASS[status.tone] ?? ''}`.trim()}>
      {status.key === 'reconnecting' && <Spinner />}
      {t(`servers.status.${status.key}`)}
    </span>
  );
}
