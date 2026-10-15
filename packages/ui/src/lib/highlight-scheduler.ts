export const FIRST_MS = 60;
export const STREAMING_MS = 250;
/** Past this a block is coloured only once it stops changing: tokenising it on every pass costs more than it shows. */
export const STREAMING_MAX_CHARS = 20_000;
/** The quiet a huge block waits for after its last change. */
export const SETTLE_MS = 120;

/**
 * When the next highlight of a growing code block runs. A throttle while the block is small, so it
 * colours as it grows; a debounce once it is huge, so it is tokenised after it stops changing.
 */
export class HighlightScheduler {
  /** The wait before the next pass, and whether a change in the meantime pushes it back. */
  next({ hasResult, length }: { hasResult: boolean; length: number }): { delay: number; restartOnChange: boolean } {
    if (length > STREAMING_MAX_CHARS) return { delay: SETTLE_MS, restartOnChange: true };
    return { delay: hasResult ? STREAMING_MS : FIRST_MS, restartOnChange: false };
  }
}
