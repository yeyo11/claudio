import { useEffect } from 'react';
// Types only: the splash itself is written into index.html by the build (scripts/splash.ts), and
// none of it belongs in the bundle
import type {} from '@claudio/ui/splash';

/**
 * Tells the splash the app's first screen is on the page. Rendered once at the root: its effect runs
 * after React's first commit, so what the splash fades into is the UI, not an empty #root. The
 * splash still finishes its intro first (docs/plans/splash-eat-the-code.md); a page served without
 * it (the unit tests, the desktop window) has no `claudioSplash` and nothing happens.
 */
export function SplashHandOff(): null {
  useEffect(() => {
    void window.claudioSplash?.handOff();
  }, []);
  return null;
}
