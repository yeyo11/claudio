import { useEffect, useRef, useState } from 'react';

interface RevealOptions {
  /** How far behind the stream the display may trail, in ms */
  lagMs: number;
  /** The most characters the display may trail by; beyond it the display jumps forward */
  maxLagChars: number;
  /** Characters per ms at the slowest */
  minRate: number;
}

/**
 * A backlog shrinks in proportion to its size, so it only approaches zero: with this many time
 * constants in the lag, a burst is on screen within about the lag
 */
const DRAIN_TURNS = 4;

/** How long the rest of a block takes to show once it has been stored */
const FINISH_MS = 150;

/**
 * Reveals a growing text at a steady pace instead of in the bursts it arrives in. The pace follows
 * how fast text has been arriving (a moving average) and speeds up as the backlog grows, so the
 * display trails the stream by a fraction of a second and never stalls or jumps. Pure apart from the
 * clock, which is passed in, so it is tested without frames.
 */
export class SmoothReveal {
  private target = '';
  private shown = 0;
  /** Characters per millisecond, a moving average of arrivals */
  private rate = 0;
  private lastPushAt = 0;
  private finishing = false;
  /** Characters per ms that drain what was left when the block was stored in FINISH_MS */
  private finishRate = 0;

  constructor(private readonly opts: RevealOptions = { lagMs: 250, maxLagChars: 600, minRate: 0.02 }) {}

  /** The whole text so far. A text that does not continue the last one (a rewrite) starts over. */
  push(text: string, at: number): void {
    if (!text.startsWith(this.target.slice(0, this.shown))) this.shown = commonPrefix(text, this.target);
    const added = text.length - this.target.length;
    if (added > 0 && this.lastPushAt > 0) {
      const dt = Math.max(1, at - this.lastPushAt);
      this.rate = this.rate === 0 ? added / dt : (added / dt) * 0.1 + this.rate * 0.9;
    }
    this.lastPushAt = at;
    this.target = text;
  }

  /** The block was stored: show the rest quickly (within ~150 ms) instead of at the stream's pace. */
  finish(): void {
    this.finishing = true;
  }

  /** Advances by `dt` ms of display time; returns the text to show now. */
  step(dt: number): string {
    const backlog = this.target.length - this.shown;
    if (backlog <= 0) return this.target;
    if (backlog > this.opts.maxLagChars) this.shown = this.target.length - this.opts.maxLagChars;
    // Finishing drains in FINISH_MS whatever was left, at a fixed pace: one that shrinks with the
    // backlog would only approach the end
    if (this.finishing && this.finishRate === 0) this.finishRate = (this.target.length - this.shown) / FINISH_MS;
    const catchUp = this.finishing ? this.finishRate : (this.target.length - this.shown) / (this.opts.lagMs / DRAIN_TURNS);
    const speed = Math.max(this.rate, catchUp, this.opts.minRate);
    this.shown = Math.min(this.target.length, this.shown + Math.max(1, Math.round(speed * dt)));
    return this.target.slice(0, this.shown);
  }

  get done(): boolean {
    return this.shown >= this.target.length;
  }
}

function commonPrefix(a: string, b: string): number {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return i;
}

/**
 * `text` revealed smoothly, re-rendering at most once a frame. Off (the text as it arrives) when
 * motion is off or the tab is hidden: nobody is watching the pace then, and a hidden tab gets no
 * frames. One reveal per mounted component: the caller keys it by the block. `onRevealing` hears
 * whether the display is still behind the text.
 */
export function useSmoothText(text: string, enabled: boolean, ended: boolean, onRevealing?: (revealing: boolean) => void): string {
  const reveal = useRef<SmoothReveal | null>(null);
  reveal.current ??= new SmoothReveal();
  const [shown, setShown] = useState('');
  const [hidden, setHidden] = useState(() => typeof document !== 'undefined' && document.hidden);
  const frame = useRef(0);
  const last = useRef(0);
  const shownRef = useRef('');
  const revealing = useRef(false);
  const hear = useRef(onRevealing);
  hear.current = onRevealing;
  const active = enabled && !hidden;

  useEffect(() => {
    const onVisibility = () => setHidden(document.hidden);
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, []);

  const mark = (value: boolean) => {
    if (revealing.current === value) return;
    revealing.current = value;
    hear.current?.(value);
  };

  useEffect(() => {
    const current = reveal.current;
    if (!current) return;
    if (!active) {
      cancelAnimationFrame(frame.current);
      frame.current = 0;
      // Nothing is being paced, so the next time it is shown it picks up from here
      current.push(text, performance.now());
      current.step(Number.POSITIVE_INFINITY);
      mark(false);
      return;
    }
    current.push(text, performance.now());
    if (frame.current) return;
    last.current = performance.now();
    const tick = (at: number) => {
      const out = current.step(at - last.current);
      last.current = at;
      if (out !== shownRef.current) {
        shownRef.current = out;
        setShown(out);
      }
      if (current.done) {
        frame.current = 0;
        mark(false);
        return;
      }
      frame.current = requestAnimationFrame(tick);
    };
    mark(!current.done);
    frame.current = requestAnimationFrame(tick);
  }, [text, active]);

  useEffect(() => {
    if (ended) reveal.current?.finish();
  }, [ended]);

  useEffect(
    () => () => {
      cancelAnimationFrame(frame.current);
      frame.current = 0;
      mark(false);
    },
    [],
  );

  if (!active) return text;
  // A text that was rewritten shorter must not show what it no longer says
  return text.startsWith(shown) ? shown : text.slice(0, commonPrefix(text, shown));
}
