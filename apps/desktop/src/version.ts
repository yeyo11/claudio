// The desktop version this bundle was built as, set by scripts/build.mjs. The daemon is no Electron app
// to ask (`app.getVersion()`), and after apt replaced the package under it, its own code is still the
// version it started as: this constant says so, a file on disk would say the new one.
declare const __CLAUDIO_DESKTOP_VERSION__: string | undefined;

export const DESKTOP_VERSION: string = typeof __CLAUDIO_DESKTOP_VERSION__ === 'string' ? __CLAUDIO_DESKTOP_VERSION__ : '0.0.0';
