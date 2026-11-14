/**
 * Truncated text carries its full text (UI invariant I3): an ellipsis or a line clamp that cuts a
 * name must still let the person read the whole of it. A `title` on a non-interactive element is
 * the lightest way, but one that is always there repeats what is already on screen in a tooltip
 * every time the pointer rests on it; so the title is set only while the text is really cut, and
 * measured again whenever the box changes size or the text changes.
 */
import { useCallback, useEffect, useLayoutEffect, useRef } from 'react';

interface Box {
  scrollWidth: number;
  clientWidth: number;
  scrollHeight: number;
  clientHeight: number;
  /** The laid-out width of its content and of its inner box, unrounded, when the browser can tell them */
  contentWidth?: number;
  innerWidth?: number;
}

/** Less than this past its box is the rounding of layout, not a cut a person could see */
const SUBPIXEL = 0.01;

/**
 * Whether the box hides part of its content: wider than it (an ellipsis) or taller (a clamp). The
 * scroll and client sizes are whole pixels, so a box a fifth of a pixel short of its text reads as
 * fitting while the browser already draws the ellipsis: the unrounded widths decide when they are known.
 */
export function isCut(box: Box): boolean {
  if (box.scrollWidth > box.clientWidth || box.scrollHeight > box.clientHeight) return true;
  return box.contentWidth !== undefined && box.innerWidth !== undefined && box.contentWidth > box.innerWidth + SUBPIXEL;
}

/** The element's sizes, with its content's unrounded width taken from a range over it */
function measure(el: HTMLElement): Box {
  const box: Box = { scrollWidth: el.scrollWidth, clientWidth: el.clientWidth, scrollHeight: el.scrollHeight, clientHeight: el.clientHeight };
  if (typeof document === 'undefined' || typeof document.createRange !== 'function' || typeof getComputedStyle !== 'function') return box;
  const range = document.createRange();
  range.selectNodeContents(el);
  // A range's rectangle covers the text as laid out, the part past the ellipsis included
  if (typeof range.getBoundingClientRect !== 'function') return box;
  const style = getComputedStyle(el);
  const edges = ['paddingLeft', 'paddingRight', 'borderLeftWidth', 'borderRightWidth'] as const;
  const inset = edges.reduce((sum, edge) => sum + (Number.parseFloat(style[edge]) || 0), 0);
  return { ...box, contentWidth: range.getBoundingClientRect().width, innerWidth: el.getBoundingClientRect().width - inset };
}

// What the caller says the full text is, for a label made of parts its textContent runs together
const given = new WeakMap<HTMLElement, string>();

function sync(el: HTMLElement): void {
  const text = given.get(el) ?? (el.textContent ?? '').replace(/\s+/g, ' ').trim();
  if (text && isCut(measure(el))) {
    if (el.title !== text) el.title = text;
  } else if (el.hasAttribute('title')) {
    el.removeAttribute('title');
  }
}

// One observer for every truncated label: a list of chats would otherwise create hundreds
let observer: ResizeObserver | null = null;

function shared(): ResizeObserver | null {
  if (observer || typeof ResizeObserver === 'undefined') return observer;
  observer = new ResizeObserver((entries) => {
    for (const entry of entries) {
      if (entry.target instanceof HTMLElement) sync(entry.target);
    }
  });
  return observer;
}

/**
 * A ref for an element that may truncate its text. It is measured after every render (its text may
 * have changed while its box kept its width), whenever its box changes size, and once the web
 * fonts are in. `full` is the text to show when the element's own text would not read well (parts
 * set side by side); by default it is the element's text. The element's `title` belongs to this
 * hook: do not pass one of your own.
 */
export function useFullTextTitle<T extends HTMLElement>(full?: string): (el: T | null) => void {
  const node = useRef<T | null>(null);
  const ref = useCallback((el: T | null) => {
    const ro = shared();
    if (node.current && node.current !== el) ro?.unobserve(node.current);
    node.current = el;
    if (el) ro?.observe(el);
  }, []);
  useLayoutEffect(() => {
    const el = node.current;
    if (!el) return;
    if (full) given.set(el, full);
    else given.delete(el);
    sync(el);
  });
  useEffect(() => {
    // A web font arriving widens the text without resizing its box, which the observer misses
    let live = true;
    void document.fonts?.ready.then(() => {
      if (live && node.current) sync(node.current);
    });
    return () => {
      live = false;
    };
  }, []);
  return ref;
}
