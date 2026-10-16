import type { ChatGuards } from '@claudio/shared';
import { ShieldAlert, ShieldCheck } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
// Direct import: the header is in the shell bundle, and the barrel would pull the lazy form controls into it
import { Sheet } from '@claudio/ui/components/controls/Sheet';
import { ICON_SM } from '@claudio/ui/components/icons';
import { guardTag } from '../../lib/guards';

/**
 * What the guard on this chat's process is doing: "Guards" when armed, "Observe" in observe mode,
 * "Guards not running" when a tool call went by unguarded. Nothing when the chat is not guarded. A
 * press opens the rules it runs with and a link to where they are set; nothing here moves.
 */
export function GuardTag({ guards }: { guards: ChatGuards | null | undefined }) {
  const { t } = useTranslation('components');
  const [open, setOpen] = useState(false);
  const tag = guardTag(guards);
  if (!tag || !guards) return null;
  const Icon = tag.word === 'armed' ? ShieldCheck : ShieldAlert;
  return (
    <>
      <button type="button" className={`guard-tag badge badge-${tag.tone}`} aria-haspopup="dialog" onClick={() => setOpen(true)}>
        <Icon size={12} strokeWidth={2} aria-hidden />
        <span className="badge-text">{t(`guards.tag.${tag.word}`)}</span>
      </button>
      <Sheet open={open} onOpenChange={setOpen} title={t('guards.popover.title')} description={t(`guards.popover.${tag.word}`)} side="auto">
        <ul className="guard-rules-list">
          {guards.rules.map((id) => (
            <li key={id}>
              <ShieldCheck {...ICON_SM} aria-hidden />
              <span className="mono">{id}</span>
              {id === 'integrity' && <span className="guard-always">{t('guards.alwaysOn')}</span>}
            </li>
          ))}
        </ul>
        <Link to="/settings?tab=security#guards" className="team-link" onClick={() => setOpen(false)}>
          {t('guards.popover.settings')}
        </Link>
      </Sheet>
    </>
  );
}
