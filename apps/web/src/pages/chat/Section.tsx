import { useId, type ReactNode } from 'react';

/**
 * One part of the inspector: a heading and what it says, with a rule above instead of a card
 * around it. The heading names the section for a screen reader too.
 */
export function Section({ title, actions, children, className = '' }: { title: ReactNode; actions?: ReactNode; children: ReactNode; className?: string }) {
  const id = useId();
  return (
    <section className={`insp-section ${className}`.trim()} aria-labelledby={id}>
      <header className="insp-head">
        <h2 id={id}>{title}</h2>
        {actions}
      </header>
      {children}
    </section>
  );
}
