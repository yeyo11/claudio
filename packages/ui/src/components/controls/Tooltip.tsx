import * as RadixTooltip from '@radix-ui/react-tooltip';
import { useEffect, useState, type ReactElement, type ReactNode } from 'react';

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
  const empty = content === undefined || content === null || content === false || content === '';
  // Content that goes away closes the tooltip, so it does not reopen when the content comes back
  useEffect(() => {
    if (empty) setOpen(false);
  }, [empty]);
  return (
    <RadixTooltip.Root open={open && !empty} onOpenChange={(next) => setOpen(nextTooltipOpen(next, empty))}>
      <RadixTooltip.Trigger asChild>{children}</RadixTooltip.Trigger>
      <RadixTooltip.Portal>
        <RadixTooltip.Content className="tooltip" side={side} sideOffset={6} collisionPadding={8}>
          {content}
        </RadixTooltip.Content>
      </RadixTooltip.Portal>
    </RadixTooltip.Root>
  );
}
