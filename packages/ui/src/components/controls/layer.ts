/**
 * Floating layers (select menus, combobox lists) are portalled to <body> and mark themselves with
 * this attribute. The Dialog checks for it so that Escape closes the open layer, not the dialog.
 */
export const LAYER_ATTR = { 'data-escape-layer': '' } as const;

/**
 * Where focus goes back when a dialog closes whose opener has left the page: a menu item that opened
 * it (Edit, Remove in a row's "⋯") is gone by then, so the menu names its trigger here, keyed by the
 * dialog's panel, and the dialog returns focus to it instead of to nothing.
 */
export const focusReturn = new WeakMap<HTMLElement, HTMLElement>();

export function hasOpenLayer(): boolean {
  return document.querySelector('[data-escape-layer]') !== null;
}

/**
 * The distance a popover, menu, select or tooltip keeps from the window. The desktop app paints its
 * window controls over the top band of the page, so there the top edge is that band (the same
 * 52 px the shell reserves with --chrome-top) and a menu opened near the top flips instead of
 * sliding under the controls. Read when rendered: the shell marks the root before the first paint.
 */
const EDGE = 8;
const DESKTOP_TOP = 56;

export function layerCollisionPadding(): { top: number; right: number; bottom: number; left: number } {
  const desktop = typeof document !== 'undefined' && document.documentElement.classList.contains('is-desktop');
  return { top: desktop ? DESKTOP_TOP : EDGE, right: EDGE, bottom: EDGE, left: EDGE };
}
