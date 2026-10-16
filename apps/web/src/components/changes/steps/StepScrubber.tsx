import type { EditStep } from '@claudio/shared';
import type { CSSProperties } from 'react';
import { useTranslation } from 'react-i18next';
import { splitPath } from '../review-model';
import { riskySteps, scrubDots } from './steps-model';

/** One dot per step, under the header */
export function StepScrubber({ steps, currentId, onPick, className = '' }: { steps: EditStep[]; currentId: string | null; onPick: (id: string) => void; className?: string }) {
  const { t } = useTranslation('changes');
  const dots = scrubDots(steps, currentId);
  const at = steps.findIndex((s) => s.id === currentId);
  const risky = riskySteps(steps);
  // Dots are too small to be targets of their own: the list and the arrows are how the keyboard
  // and a screen reader move, and a pointer picks the dot it lands on
  return (
    <div
      className={`edit-scrub ${className}`.trim()}
      role="img"
      aria-label={`${t('steps.stepOf', { n: at + 1, total: steps.length })}${risky > 0 ? `, ${t('steps.risk.highCount', { count: risky })}` : ''}`}
      style={{ '--n': steps.length } as CSSProperties}
      onClick={(e) => {
        const id = (e.target as HTMLElement).closest<HTMLElement>('[data-step]')?.dataset.step;
        if (id) onPick(id);
      }}
    >
      {steps.map((s, i) => (
        <i
          key={s.id}
          data-step={s.id}
          className={`is-${dots[i] ?? 'ahead'}`}
          title={`${s.index} · ${splitPath(s.path).name}${s.risk?.level === 'high' ? ` · ${t('steps.risk.level.high')}` : ''}`}
          // The ring is not the only thing that says it: a high-risk dot says so in words too
          {...(s.risk?.level === 'high' ? { 'data-risk': 'high', 'aria-label': `${s.index} · ${splitPath(s.path).name} · ${t('steps.risk.level.high')}` } : {})}
        />
      ))}
    </div>
  );
}
