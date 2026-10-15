import { Circle, CircleAlert, CircleCheck, TriangleAlert, type LucideIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { Terminal } from '@claudio/shared';
import { ICON_SM } from '@claudio/ui/components/icons';
import { statusOf, type LinkState, type TerminalTone } from './terminal-model';

const TONE_ICON: Record<TerminalTone, LucideIcon> = { ok: CircleCheck, warn: TriangleAlert, bad: CircleAlert, neutral: Circle };

/** The status of a terminal: always an icon and a word, in the tone of what it says. */
export function TerminalStatus({ terminal, link }: { terminal: Pick<Terminal, 'state' | 'endReason' | 'exitCode'>; link: LinkState }) {
  const { t } = useTranslation('terminal');
  const word = statusOf(terminal, link);
  const Icon = TONE_ICON[word.tone];
  return (
    <span className={`term-status ${word.tone}`}>
      <Icon {...ICON_SM} aria-hidden />
      {t(`status.${word.key}`, { code: word.params?.code ?? 0 })}
    </span>
  );
}
