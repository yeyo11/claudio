import { useEffect } from 'react';
import { useLocation } from 'react-router-dom';
import { settingsAddress } from '../settingsGroups';
import type { SettingEntry } from '../settingsIndex';

/** What a link to a setting carries in the history state, so the screen knows which row to show. */
export interface RevealState {
  setting: string;
}

/** Where an entry lives: its detail screen, or its anchor on the group's screen. */
export const entryHref = (entry: SettingEntry): string =>
  entry.detail ? settingsAddress(entry.group, undefined, entry.detail) : settingsAddress(entry.group, entry.section);

export const revealState = (entry: SettingEntry): RevealState => ({ setting: entry.id });

const isRevealState = (state: unknown): state is RevealState =>
  typeof state === 'object' && state !== null && typeof (state as { setting?: unknown }).setting === 'string';

// A screen draws its rows once its data is there: look for the row a while before giving up
const WAIT_MS = 4000;
const FOCUSABLE = 'input:not([type=hidden]), select, textarea, button, [role=switch], [role=slider], [role=combobox], [role=radio], a[href], [tabindex]:not([tabindex="-1"])';

function focusInside(row: HTMLElement) {
  const control = row.matches(FOCUSABLE) ? row : row.querySelector<HTMLElement>(FOCUSABLE);
  if (control && !control.hasAttribute('disabled')) control.focus({ preventScroll: true });
  else {
    if (!row.hasAttribute('tabindex')) row.setAttribute('tabindex', '-1');
    row.focus({ preventScroll: true });
  }
}

/**
 * Brings what the address names into view: the row a search result or a palette command opened
 * (`data-setting`, then its control takes the focus and the row a fill that fades), or the section
 * of `#<section>` (its heading takes the focus). The fill is CSS, so the motion levels stop it.
 */
export function useRevealSetting(): void {
  const location = useLocation();
  const setting = isRevealState(location.state) ? location.state.setting : null;
  const anchor = decodeURIComponent(location.hash.replace(/^#/, ''));

  useEffect(() => {
    if (!setting && !anchor) return;
    const started = performance.now();
    let frame = 0;
    let row: HTMLElement | null = null;
    // While it waits for the row, the person may open something else (the palette, a dialog):
    // the focus stays where they put it, and only the scroll and the fill still happen
    const before = document.activeElement;
    const mayFocus = () => {
      const active = document.activeElement;
      return !active || active === document.body || active === before || !active.isConnected;
    };

    const find = (): HTMLElement | null => {
      if (setting) {
        const found = document.querySelector<HTMLElement>(`[data-setting="${CSS.escape(setting)}"]`);
        if (found) return found;
      }
      // An entry whose row a screen has not marked yet still lands on its section
      return anchor ? document.getElementById(anchor) : null;
    };

    const tick = () => {
      const target = find();
      if (!target) {
        if (performance.now() - started < WAIT_MS) frame = requestAnimationFrame(tick);
        // Nothing on this screen carries the anchor yet: the screen's title takes the focus instead of the search
        else if (mayFocus()) document.querySelector<HTMLElement>('[data-settings-title]')?.focus({ preventScroll: true });
        return;
      }
      target.scrollIntoView?.({ block: setting ? 'center' : 'start' });
      if (setting && target.dataset.setting === setting) {
        if (mayFocus()) focusInside(target);
        row = target;
        target.classList.remove('is-found');
        // Restarts the fade when the same row is opened twice in a row
        void target.offsetWidth;
        target.classList.add('is-found');
      } else {
        const heading = target.querySelector<HTMLElement>('[data-section-heading]') ?? target;
        if (!heading.hasAttribute('tabindex')) heading.setAttribute('tabindex', '-1');
        if (mayFocus()) heading.focus({ preventScroll: true });
      }
    };
    frame = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(frame);
      row?.classList.remove('is-found');
    };
    // location.key: opening the same result again is a new visit and shows the row again
  }, [setting, anchor, location.key]);
}
