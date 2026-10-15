import * as RadixPopover from '@radix-ui/react-popover';
import type { ReactNode } from 'react';
import { LAYER_ATTR } from '@agentry/ui/components/controls/layer';
import { Sheet } from '@agentry/ui/components/controls/Sheet';
import { NARROW, useMediaQuery } from '@agentry/ui/lib/media';

/** A popover by the line on a wide screen, a sheet from the bottom on a phone. */
export function OptionsPanel({ trigger, title, open, onOpenChange, children }: { trigger: ReactNode; title: string; open: boolean; onOpenChange: (open: boolean) => void; children: ReactNode }) {
  const narrow = useMediaQuery(NARROW);
  if (narrow) {
    return (
      <>
        {trigger}
        <Sheet open={open} onOpenChange={onOpenChange} title={title}>
          <div className="composer-options">{children}</div>
        </Sheet>
      </>
    );
  }
  return (
    <RadixPopover.Root open={open} onOpenChange={onOpenChange}>
      <RadixPopover.Trigger asChild>{trigger}</RadixPopover.Trigger>
      <RadixPopover.Portal>
        <RadixPopover.Content className="popover composer-options" side="top" align="start" sideOffset={6} collisionPadding={8} aria-label={title} {...LAYER_ATTR}>
          {children}
        </RadixPopover.Content>
      </RadixPopover.Portal>
    </RadixPopover.Root>
  );
}
