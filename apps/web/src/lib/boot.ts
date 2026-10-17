// Tells the boot guard (boot-guard.js, inlined in index.html) that the module graph loaded. It is
// main.tsx's first import and imports nothing itself, so it evaluates before every other module and
// before any top-level await could hold the rest back past DOMContentLoaded.
declare global {
  interface Window {
    /** Set by the boot guard; absent under the unit tests and in a page served without it. */
    __claudioBooted?: () => void;
  }
}

if (typeof window !== 'undefined') window.__claudioBooted?.();

export {};
