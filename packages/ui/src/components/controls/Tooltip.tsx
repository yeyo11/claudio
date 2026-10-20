import * as RadixTooltip from '@radix-ui/react-tooltip';
import { useEffect, useState, type ReactElement, type ReactNode } from 'react';
import { layerCollisionPadding } from './layer';

export function TooltipProvider({ children }: { children: ReactNode }) {
  return (
    <RadixTooltip.Provider delayDuration={350} skipDelayDuration={200}>
      {children}
    </RadixTooltip.Provider>
  );
}

/**
 * The open state after Radix asks for `next`. A tooltip with nothing to show never opens: Radix asks
 * to open on hover even then, and it never asks to close a tooltip whose `open` prop is already
 * false, so an `open` accepted while empty stayed true. The collapsed sidebar's rail then showed
 * every tooltip hovered while it was expanded (their content is empty there) the moment it folded.
 */
export function nextTooltipOpen(next: boolean, empty: boolean): boolean {
  return next && !empty;
}

/**
 * Keys that move focus on their own: Tab, and the arrows and Home/End of a roving group. A focus that
 * follows one of them within a moment is the person moving focus with the keyboard; any other focus is
 * the app placing it: a dialog that autofocuses its first control, or gives focus back to the button
 * that opened it after Escape, Enter or a click. Radix opens a tooltip on every focus, and a tooltip
 * opened by the app stayed open with nobody looking at it, until focus or the pointer happened to
 * leave its trigger (the context breakdown dialog showed one that way).
 */
const NAVIGATION_KEYS = new Set(['Tab', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown']);
const KEYBOARD_FOCUS_WINDOW_MS = 1000;
let navigatedAt = Number.NEGATIVE_INFINITY;
let listening = false;

function listenForNavigation() {
  if (listening || typeof document === 'undefined') return;
  listening = true;
  // Capture, so a handler that stops the key (a dialog's focus trap) does not hide it from here
  document.addEventListener('keydown', (e) => (navigatedAt = NAVIGATION_KEYS.has(e.key) ? performance.now() : Number.NEGATIVE_INFINITY), true);
  document.addEventListener('pointerdown', () => (navigatedAt = Number.NEGATIVE_INFINITY), true);
}

/** Whether a focus `sinceNavigation` ms after the last navigation key, on a trigger that does or does not match :focus-visible, opens its tooltip */
export function focusOpensTooltip(sinceNavigation: number, focusVisible: boolean): boolean {
  return focusVisible && sinceNavigation >= 0 && sinceNavigation <= KEYBOARD_FOCUS_WINDOW_MS;
}

/**
 * Themed tooltip for interactive elements. The child must accept a ref (native elements do).
 * Empty content keeps it closed without changing the tree, so a conditional hint never remounts
 * the child (an input would lose focus mid-typing).
 */
export function Tooltip({
  content,
  children,
  side = 'top',
}: {
  content: ReactNode;
  children: ReactElement;
  side?: 'top' | 'right' | 'bottom' | 'left';
}) {
  const [open, setOpen] = useState(false);
  useEffect(listenForNavigation, []);
  const empty = content === undefined || content === null || content === false || content === '';
  // Content that goes away closes the tooltip, so it does not reopen when the content comes back
  useEffect(() => {
    if (empty) setOpen(false);
  }, [empty]);
  return (
    <RadixTooltip.Root open={open && !empty} onOpenChange={(next) => setOpen(nextTooltipOpen(next, empty))}>
      <RadixTooltip.Trigger
        asChild
        // Radix skips its own focus handler (which opens) when this one prevents the default
        onFocus={(e) => {
          if (!focusOpensTooltip(performance.now() - navigatedAt, e.currentTarget.matches(':focus-visible'))) e.preventDefault();
        }}
      >
        {children}
      </RadixTooltip.Trigger>
      <RadixTooltip.Portal>
        <RadixTooltip.Content className="tooltip" side={side} sideOffset={6} collisionPadding={layerCollisionPadding()}>
          {content}
        </RadixTooltip.Content>
      </RadixTooltip.Portal>
    </RadixTooltip.Root>
  );
}
