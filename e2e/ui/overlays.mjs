// The markup Dialog and Sheet render, with the content that broke them on a phone: a title that is
// one long name, ids, paths and URLs with no break in them, a body that needs scrolling, an error,
// and a footer of three actions with long labels. It is inserted into the real app, so the real
// stylesheet lays it out; `overlayFit` (invariants.mjs) says whether it fits. The classes are the
// ones of packages/ui/src/components/Dialog.tsx and controls/Sheet.tsx: change one, change both.

const UNBROKEN = 'sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJ';
const PATH = '/Users/someone/workspace/claudio/packages/frontend/src/screens/settings/decisions/DecisionsScreen.tsx';
const URL_ = `https://example.com/a/very/long/path/that/never/breaks/${UNBROKEN}?utm_source=x&utm_medium=y`;
const CLOSE = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6 6 18M6 6l12 12"/></svg>';

export const OVERLAY_KINDS = ['modal', 'drawer', 'bottom', 'right'];

const rows = (count) =>
  Array.from({ length: count }, (_, i) => `<div style="display:flex;gap:8px;padding:8px 0"><span style="min-width:0">Row ${i} ${i % 4 === 0 ? PATH : 'short text'}</span><button class="btn">Open</button></div>`).join('');

const body = () =>
  `<p>${UNBROKEN}</p><p>${URL_}</p><p role="alert">Error: ${PATH} could not be read, ${UNBROKEN}</p>${rows(60)}`;

const foot = `<button class="btn">Cancel</button><button class="btn">Discard the draft and go back</button><button class="btn btn-primary">Save everything now</button>`;

/** One dialog (`modal`, `drawer`) or sheet (`bottom`, `right`) with a long title, a long body and three actions */
export function overlayMarkup(kind, { title = `A project whose name is long enough to need its ellipsis everywhere ${UNBROKEN}` } = {}) {
  if (kind === 'modal' || kind === 'drawer') {
    return (
      `<div class="overlay overlay-${kind}"><div class="dialog dialog-${kind}" role="dialog" aria-modal="true" aria-label="Stress" tabindex="-1" style="--dialog-w:${kind === 'drawer' ? 760 : 560}px">` +
      `<div class="dialog-head"><h2>${title}</h2><button class="icon-btn" aria-label="Close">${CLOSE}</button></div>` +
      `<div class="dialog-body">${body()}</div><div class="dialog-foot">${foot}</div></div></div>`
    );
  }
  return (
    `<div class="sheet-scrim"></div><div role="dialog" aria-label="Stress" class="sheet sheet-${kind}" tabindex="-1"><div class="sheet-grab" aria-hidden="true"></div>` +
    `<div class="sheet-head"><div class="sheet-head-text"><h2 class="sheet-title">${title}</h2><p class="sheet-description">${PATH} ${UNBROKEN}</p></div><button class="icon-btn" aria-label="Close">${CLOSE}</button></div>` +
    `<div class="sheet-body">${body()}</div><div class="sheet-foot">${foot}</div></div>`
  );
}
