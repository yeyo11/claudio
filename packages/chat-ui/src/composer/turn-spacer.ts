import { useLayoutEffect, useRef, type RefObject } from 'react';

/** The gap kept between the top of the view and the question it is scrolled to. */
export const TOP_GAP = 16;

/**
 * The height of the spacer that lets the end of the scroller be the place where the question sits
 * at the top: what the viewport has left once the question and everything after it are drawn.
 * `rowTop` and `contentEnd` are in scroll coordinates, `contentEnd` without the spacer itself.
 */
export function turnSpacerHeight({ clientHeight, rowTop, contentEnd, paddingBottom }: { clientHeight: number; rowTop: number; contentEnd: number; paddingBottom: number }): number {
  return Math.max(0, Math.round(clientHeight - TOP_GAP - (contentEnd - rowTop) - paddingBottom));
}

/**
 * Keeps a spacer at the end of `scroller` sized so the row `data-entry-id=anchor` can sit near the
 * top once the view is at its end, so the stick-to-bottom logic needs no change: while the answer
 * is shorter than the view the spacer fills the rest, and once it is taller the spacer is zero.
 * The height is written to the element directly: it changes with every streamed token.
 */
export function useTurnSpacer(scroller: RefObject<HTMLElement | null>, anchor: string | null): RefObject<HTMLDivElement | null> {
  const spacer = useRef<HTMLDivElement>(null);

  const measure = () => {
    const el = scroller.current;
    const tail = spacer.current;
    if (!el || !tail) return;
    const row = anchor ? el.querySelector(`[data-entry-id="${CSS.escape(anchor)}"]`) : null;
    let height = 0;
    if (row) {
      const rowTop = row.getBoundingClientRect().top - el.getBoundingClientRect().top + el.scrollTop;
      const contentEnd = el.scrollHeight - tail.offsetHeight;
      height = turnSpacerHeight({ clientHeight: el.clientHeight, rowTop, contentEnd, paddingBottom: parseFloat(getComputedStyle(el).paddingBottom) || 0 });
    }
    const next = `${height}px`;
    if (tail.style.height !== next) tail.style.height = next;
  };

  // After every render: rows appear and change height with them
  useLayoutEffect(measure);

  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const sizes = new ResizeObserver(measure);
    const watch = (node: Element) => {
      if (node !== spacer.current) sizes.observe(node);
    };
    sizes.observe(el);
    for (const child of el.children) watch(child);
    const children = new MutationObserver((records) => {
      for (const record of records) {
        for (const node of record.addedNodes) if (node instanceof Element) watch(node);
        for (const node of record.removedNodes) if (node instanceof Element) sizes.unobserve(node);
      }
      measure();
    });
    children.observe(el, { childList: true });
    return () => {
      sizes.disconnect();
      children.disconnect();
    };
    // `measure` closes over the anchor of the render that last ran, so the observers are rebuilt with it
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scroller, anchor]);

  return spacer;
}
