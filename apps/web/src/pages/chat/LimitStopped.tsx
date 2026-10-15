import type { Chat } from '@claudio/shared';
import { Hourglass } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { ICON_SM } from '@claudio/ui/components/icons';
import { formatHour } from '@claudio/ui/lib/format';
import { useProviderLabel } from '../../lib/provider-status';

/** Where the chat's transcript ends: the turn stopped at the limit. */
export function LimitStopped({ chat, at, waiting = false }: { chat: Chat; at: string | null; waiting?: boolean }) {
  const { t } = useTranslation('chats');
  const nameOf = useProviderLabel();
  return (
    <div className="lim-stop">
      <Hourglass {...ICON_SM} className="lim-icon" />
      <span>{t('limit.stopped', { name: nameOf(chat.provider) })}</span>
      {at && !waiting && <span className="when">{formatHour(at)}</span>}
    </div>
  );
}
