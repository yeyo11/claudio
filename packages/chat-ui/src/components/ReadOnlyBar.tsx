import { Lock } from 'lucide-react';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { ICON } from '@claudio/ui/components/icons';

/**
 * Where a composer would be, on a conversation the person can read and never continue: a
 * teammate's chat copied from their machine. Neutral, not a status: nothing is wrong, the chat is
 * simply someone else's. `children` replaces the sentence for a reader of another kind (a document
 * from a teammate's working copy).
 */
export function ReadOnlyBar({ from, children }: { from: string; children?: ReactNode }) {
  const { t } = useTranslation('chat');
  return (
    <div className="alert chat-banner read-only-bar" role="note">
      <Lock {...ICON} className="alert-icon" />
      <div className="alert-body">{children ?? t('readOnlyBar.from', { name: from })}</div>
    </div>
  );
}
