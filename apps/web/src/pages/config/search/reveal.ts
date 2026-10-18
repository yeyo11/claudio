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
const FOCUSABLE = 'input:not([type=hidden]), select, textarea, button, [role=switch], [role=slider], [role=combobox], [role=radio], a[href], [tabindex]';
// The row's own control comes before its helpers (a number field's Decrease and Increase, a Reset)
const PRIMARY = 'input:not([type=hidden]), select, textarea, [role=switch], [role=slider], [role=combobox], [role=radio]';

const isReachable = (el: HTMLElement) => el.tabIndex >= 0 && !el.hasAttribute('disabled') && el.getAttribute('aria-hidden') !== 'true';

/** The control a row is about: its input, select or switch, never a `tabindex="-1"` helper button. */
export function primaryControl(row: HTMLElement): HTMLElement | null {
  if (row.matches(FOCUSABLE) && isReachable(row)) return row;
  const inside = (selector: string) => [...row.querySelectorAll<HTMLElement>(selector)].find(isReachable) ?? null;
  return inside(PRIMARY) ?? inside(FOCUSABLE);
}

function focusInside(row: HTMLElement) {
  const control = primaryControl(row);
  if (control) control.focus({ preventScroll: true });
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
    // the focus stays where they put it, and only the scroll and the fill still happen. A dialog is
    // never theirs to lose, even when the screen mounted after it opened; `<main>` is where the shell
    // parks the focus on a route change, after this effect ran, so it is not a choice of theirs
    const before = document.activeElement;
    const mayFocus = () => {
      const active = document.activeElement;
      if (!active || active === document.body || !active.isConnected) return true;
      if (active.closest('[role=dialog], [role=alertdialog]')) return false;
      return active === before || active.matches('main');
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
