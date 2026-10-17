import type { ReactNode } from 'react';
import { useFullTextTitle } from '../lib/full-text';

interface Props {
  /** The element to render; the class keeps whatever truncation the stylesheet gives it */
  as?: 'span' | 'h1' | 'h2' | 'h3' | 'div' | 'p';
  className?: string;
  children: ReactNode;
  /** The full text, when the children's own text would run their parts together */
  full?: string;
}

/**
 * A label that may be cut by an ellipsis or a clamp, and then carries its whole text as a `title`.
 * Non-interactive only: on a link or a button, wrap the label inside it, never the control.
 */
export function FullText({ as: Tag = 'span', className, children, full }: Props) {
  const ref = useFullTextTitle<HTMLElement>(full);
  return (
    <Tag ref={ref} className={className}>
      {children}
    </Tag>
  );
}
